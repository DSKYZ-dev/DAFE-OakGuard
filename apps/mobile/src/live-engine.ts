/**
 * Live Market Engine — the unbreakable data stream for DAFE Mobile.
 *
 * Design goal: a stream that ALWAYS moves, on every security, every timeframe,
 * with or without a paid key. Three layers, each covering the gaps of the one
 * above it:
 *
 *   L1  PAID   (Massive)    — authoritative, second-resolution anchors.
 *                             Polled at an adaptive cadence that respects
 *                             plan limits (403/429 aware: back off, degrade
 *                             gracefully, never stall the stream).
 *   L2  FREE   (Yahoo)      — 1m-resolution corrections for every standard
 *                             timeframe, zero setup. Bridges the paid layer's
 *                             polling gaps with real prices.
 *   L3  LOCAL  (Synthesis)  — calibration-anchored micro-ticks BETWEEN real
 *                             updates so the last bar always breathes. Pulled
 *                             toward the last REAL price every step; error
 *                             can never accumulate because the next real
 *                             anchor snaps it back to truth.
 *
 * Every layer failure is contained: a dead key, a 403 plan limit, a timeout,
 * a closed market, or full offline simply drops the engine into the next
 * layer — the stream keeps running and says honestly which layer it's on.
 */

import type { BaseBar } from '@dafe/types';
import type { Timeframe } from '../../web/src/data-generator';
import { fetchMassiveBars } from './massive';
import { fetchYahooBars } from './yahoo';
import { state, DEMO_MODE } from './state';

export type StreamLayer = 'massive' | 'yahoo' | 'synthetic';
export type StreamEvent =
  | { type: 'bars'; bars: BaseBar[]; provider: string; partial?: boolean }
  | { type: 'tick'; price: number; ts: number }
  | { type: 'layer'; layer: StreamLayer; note?: string };

const TIMEFRAME_MS: Record<string, number> = {
  '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000,
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000,
};

// Sub-second/sub-30s timeframes need the paid second-resolution feed; Yahoo's
// chart API bottoms out at 1m. If the paid layer can't serve them, the engine
// degrades the REQUEST to the nearest servable one rather than freezing.
const SUB_MINUTE_TFS = new Set(['1s', '5s', '10s', '30s']);
const SUB_MINUTE_FALLBACK_TF: Timeframe = '1m';

// ── Adaptive cadence table (ms between real fetches) ────────────────────
// With a working paid key the engine polls fast enough for the chart to feel
// tick-driven (2.5s–15s depending on timeframe); on the free layer it polls
// as fast as the provider honestly allows (Yahoo chart data updates ~15–60s);
// on synthesis it stops fetching real data entirely (nothing to fetch) and
// runs purely on calibration.
function pollIntervalMs(tf: string, layer: StreamLayer): number {
  const tfMs = TIMEFRAME_MS[tf] || 60000;
  if (layer === 'massive') {
    // Sub-second TFs get the fastest sustainable cadence; longer TFs ease off.
    return Math.max(2500, Math.min(15000, tfMs / 4));
  }
  if (layer === 'yahoo') {
    // Yahoo 1m bars publish on a ~15–30s rhythm; shorter intervals just burn
    // quota for identical payloads.
    return Math.max(12000, Math.min(60000, tfMs / 2));
  }
  return 30000; // synthetic — occasionally try to recover a real layer
}

// ── Massive plan-tier probe (403-aware) ─────────────────────────────────
// One cheap request per session (per key) to learn what the key can actually
// serve, so 1s requests stop being made when the plan only covers 1m/1h. The
// result drives BOTH the polling layer choice and the Settings warning text.
export interface MassiveProbe {
  status: 'ok' | 'forbidden' | 'invalid' | 'unreachable';
  lowestTf?: string;
  detail?: string;
}

const probeCache = new Map<string, MassiveProbe>();
export const MASSIVE_PROBE_EVENT = 'dafe:massive-probe';

export async function probeMassiveKey(key: string, symbol = 'SPY'): Promise<MassiveProbe> {
  const cached = probeCache.get(key);
  if (cached) return cached;
  const out: MassiveProbe = { status: 'unreachable' };
  try {
    const { nativeGet } = await import('./native-http');
    const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    // Probe the CHEAPEST tier first (1m) — a key that can't even serve 1m is
    // invalid or network-dead, not plan-limited. Only then try 1s to learn
    // whether the plan covers second data.
    const res1m = await nativeGet(
      `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${from}/${to}`,
      { adjusted: 'true', sort: 'asc', limit: '8', apiKey: key }, 12000,
    );
    if (!res1m) { out.status = 'unreachable'; out.detail = 'No response (network)'; }
    else if (res1m.status === 403 || res1m.status === 401) {
      out.status = 'invalid';
      out.detail = `HTTP ${res1m.status} on 1m — key rejected`;
    } else if (res1m.status === 429) {
      out.status = 'forbidden';
      out.detail = 'Rate limited (429) — try again shortly';
    } else if (res1m.status !== 200) {
      out.status = 'unreachable';
      out.detail = `HTTP ${res1m.status}`;
    } else if (!res1m.data?.results?.length) {
      out.status = 'invalid';
      out.detail = '200 but no results — key lacks permissions for this ticker';
    } else {
      out.status = 'ok';
      out.lowestTf = '1m';
      // Second-resolution probe — only extra request, only on a healthy key.
      // Uses the same 2-day window as the 1m probe; limit 8 keeps the payload
      // trivial either way (results are capped at the newest 8 second-bars).
      const res1s = await nativeGet(
        `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/second/${from}/${to}`,
        { adjusted: 'true', sort: 'desc', limit: '8', apiKey: key }, 12000,
      );
      if (res1s?.status === 200 && res1s.data?.results?.length) out.lowestTf = '1s';
      else if (res1s?.status === 403) out.detail = '403 on 1s — plan lacks second data';
    }
  } catch (e: any) {
    out.status = 'unreachable';
    out.detail = e?.message || String(e);
  }
  probeCache.set(key, out);
  try { window.dispatchEvent(new CustomEvent(MASSIVE_PROBE_EVENT, { detail: out })); } catch {}
  return out;
}

export function invalidateMassiveProbe(key: string): void { probeCache.delete(key); }

// ── Calibration-anchored synthesis (L3) ────────────────────────────────
// Realized volatility + drift from the symbol's own recent bars, hard-banded
// around the last REAL price so the synthesized path physically can't run
// away between anchors.
class Synthesizer {
  private anchor = 0;
  private synth = 0;
  private lastStep = 0;
  private driftPerSec = 0;
  private volPerSec = 0.0001;

  calibrate(bars: BaseBar[], tfSec: number): void {
    const closes = bars.slice(-120).map(b => b.close).filter(c => c > 0);
    if (closes.length < 3) { this.driftPerSec = 0; this.volPerSec = 0.0001; return; }
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    const clampedMean = Math.max(-0.003, Math.min(0.003, mean));
    const clampedSd = Math.min(Math.sqrt(variance), 0.008);
    this.driftPerSec = clampedMean / Math.max(1, tfSec);
    this.volPerSec = Math.max(0.00001, clampedSd / Math.sqrt(Math.max(1, tfSec)));
  }

  anchorTo(price: number, nowMs: number): void {
    if (price > 0) { this.anchor = price; this.synth = price; }
    this.lastStep = nowMs || Date.now();
  }

  get price(): number { return this.synth || this.anchor; }

  step(nowMs: number, maxBandPct = 0.004): number {
    if (this.anchor <= 0) return this.synth;
    const dt = Math.max(0, (nowMs - this.lastStep) / 1000);
    this.lastStep = nowMs;
    if (dt <= 0) return this.synth;
    const lo = this.anchor * (1 - maxBandPct);
    const hi = this.anchor * (1 + maxBandPct);
    const expected = Math.max(lo, Math.min(hi, this.anchor * Math.exp(this.driftPerSec * dt)));
    const shock = this.volPerSec * Math.sqrt(dt) * gauss();
    this.synth *= Math.exp(this.driftPerSec * dt + shock);
    this.synth += (expected - this.synth) * 0.05;
    this.synth = Math.max(lo, Math.min(hi, this.synth));
    return this.synth;
  }
}

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.max(-3, Math.min(3, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

// ── The engine ─────────────────────────────────────────────────────────
export interface LiveEngineOptions {
  symbol: string;
  timeframe: Timeframe;
  onEvent: (ev: StreamEvent) => void;
  /** Existing bars to seed calibration/anchoring from. */
  seedBars: BaseBar[];
}

export class LiveMarketEngine {
  private symbol = '';
  private tf: Timeframe = '1m';
  private onEvent: LiveEngineOptions['onEvent'] = () => {};
  private bars: BaseBar[] = [];
  private layer: StreamLayer = 'synthetic';
  private synth = new Synthesizer();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;
  private running = false;
  private massiveProbe: MassiveProbe | null = null;
  private lastRealPrice = 0;
  private lastRealAt = 0;
  private consecutiveFails = 0;
  private quietMarket = false; // closed market — real fetches come back unchanged

  start(opts: LiveEngineOptions): void {
    this.stop();
    this.symbol = opts.symbol;
    this.tf = opts.timeframe;
    this.onEvent = opts.onEvent;
    this.bars = opts.seedBars.length > 0 ? [...opts.seedBars] : [];
    this.running = true;
    const tfSec = (TIMEFRAME_MS[this.tf] || 60000) / 1000;
    this.synth.calibrate(this.bars, tfSec);
    this.synth.anchorTo(this.bars.length ? this.bars[this.bars.length - 1].close : 0, Date.now());
    this.lastRealPrice = this.bars.length ? this.bars[this.bars.length - 1].close : 0;
    this.lastRealAt = Date.now();
    this.consecutiveFails = 0;
    this.quietMarket = false;
    void this.determineLayer().then(() => {
      if (!this.running) return;
      this.emitBars(false);
      this.schedulePoll();
      this.startTicks();
    });
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  get activeLayer(): StreamLayer { return this.layer; }

  get providerLabel(): string {
    if (this.layer === 'massive') return 'massive';
    if (this.layer === 'yahoo') return 'yahoo';
    return 'synthetic';
  }

  /** Decide the top layer this key/session can actually serve. */
  private async determineLayer(): Promise<void> {
    // DEMO MODE: pure local synthesis. No keys, no probes, no network — the
    // public web demo runs entirely in the visitor's browser.
    if (DEMO_MODE) {
      this.layer = 'synthetic';
      this.onEvent({ type: 'layer', layer: 'synthetic', note: 'demo mode — synthetic only' });
      return;
    }
    const key = state.massiveApiKey?.trim();
    const wantedSubMinute = SUB_MINUTE_TFS.has(this.tf);
    if (key) {
      this.massiveProbe = await probeMassiveKey(key, this.symbol);
      if (this.massiveProbe.status === 'ok') {
        if (wantedSubMinute && this.massiveProbe.lowestTf !== '1s') {
          // Paid key works but the PLAN can't serve this timeframe's seconds.
          // Degrade the request to the nearest servable resolution while
          // STAYING on the paid layer for polling (it still serves 1m/1h) —
          // the stream keeps moving and the user learns why via Settings.
          this.layer = 'massive';
          this.setLayer('massive', `plan covers ${this.massiveProbe.lowestTf}+ — serving ${this.tf} via ${SUB_MINUTE_FALLBACK_TF} anchors`);
          return;
        }
        this.setLayer('massive');
        return;
      }
      // 403/invalid/unreachable — the paid layer is out; fall to free.
    }
    if (!wantedSubMinute) {
      this.setLayer('yahoo');
      return;
    }
    // Sub-minute request with no paid source: the requested timeframe keeps
    // its own bar structure; real 1m Yahoo closes become ANCHORS for the
    // synthesis so the path tracks truth without collapsing bar density.
    this.setLayer('synthetic', 'sub-minute timeframe without second-resolution source — anchored synthesis');
    try {
      const y = await fetchYahooBars(this.symbol, '1m');
      if (y && y.length > 0) {
        this.reanchorFrom(y);
      }
    } catch { /* pure synthesis */ }
  }

  private setLayer(layer: StreamLayer, note?: string): void {
    const changed = this.layer !== layer;
    this.layer = layer;
    if (changed) this.onEvent({ type: 'layer', layer, note });
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (!this.running) return;
    const interval = pollIntervalMs(this.effectiveTf, this.layer);
    this.pollTimer = setInterval(() => {
      if (document.hidden) return;
      void this.pollReal();
    }, interval);
  }

  // The timeframe actually fetchable on the current layer — sub-minute TFs
  // degrade to 1m when the plan/key can't serve seconds.
  private get effectiveTf(): Timeframe {
    if (SUB_MINUTE_TFS.has(this.tf)) {
      if (this.layer === 'massive' && this.massiveProbe?.lowestTf === '1s') return this.tf;
      return SUB_MINUTE_FALLBACK_TF;
    }
    return this.tf;
  }

  private startTicks(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (!this.running) return;
    this.tickTimer = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const price = this.synth.step(now);
      if (price > 0) this.onEvent({ type: 'tick', price, ts: now });
    }, 400);
  }

  private async pollReal(): Promise<void> {
    if (this.fetching || !this.running) return;
    this.fetching = true;
    try {
      let bars: BaseBar[] | null = null;
      let provider = '';
      let anchorOnly = false;
      // Sub-minute TF served through a coarser real resolution (plan limit or
      // free layer): real bars are ANCHORS, not replacements — swapping 1m
      // history into a 1s chart would collapse its bar density 60:1.
      const coarseAnchor = SUB_MINUTE_TFS.has(this.tf) && this.effectiveTf !== this.tf;
      if (this.layer === 'massive') {
        const tf = this.effectiveTf;
        bars = await fetchMassiveBars(this.symbol, tf);
        provider = 'massive';
        if (!bars && this.massiveProbe?.status === 'ok') {
          // Paid layer hiccup (rate limit, tier change) — bridge with the
          // free layer this cycle instead of freezing.
          bars = await fetchYahooBars(this.symbol, this.effectiveTf === this.tf ? this.tf : '1m');
          provider = 'yahoo';
        }
      } else if (this.layer === 'yahoo') {
        bars = await fetchYahooBars(this.symbol, this.effectiveTf);
        provider = 'yahoo';
      } else if (DEMO_MODE) {
        // Demo session — no re-anchor fetches; calibrated synthesis only.
        return;
      } else {
        // Synthetic layer — periodically re-anchor from free 1m data so even
        // "no key" sessions track real prices, and try to recover upward.
        bars = await fetchYahooBars(this.symbol, '1m');
        provider = 'yahoo-anchor';
      }
      if (bars && bars.length > 0) {
        this.consecutiveFails = 0;
        if (coarseAnchor) {
          // ANCHOR-ONLY: snap the synthesizer to the freshest real close and
          // true-up the live bar's range from the real bar covering "now".
          this.reanchorFrom(bars);
        } else {
          this.absorbRealBars(bars, provider);
          this.emitBars(true);
        }
      } else {
        this.consecutiveFails++;
        if (this.consecutiveFails >= 3 && this.layer === 'massive') {
          // Paid layer repeatedly failing — drop to free rather than stalling.
          this.setLayer('yahoo', 'paid feed unresponsive — free layer taking over');
        }
      }
    } finally {
      this.fetching = false;
    }
  }

  /** Anchor-only absorb: keep the chart's bar structure; snap synthesis to
   *  the newest real close and widen the live bar with the real bar's range. */
  private reanchorFrom(bars: BaseBar[]): void {
    const last = bars[bars.length - 1];
    if (!last || last.close <= 0) return;
    this.lastRealPrice = last.close;
    this.lastRealAt = Date.now();
    this.synth.anchorTo(last.close, Date.now());
    // True-up the LIVE bar in the engine's set (the chart applies the same
    // logic to its own set from the emitted tick): if the real bar covering
    // now has a wider high/low, adopt it so wicks stay honest.
    const live = this.bars[this.bars.length - 1];
    if (live) {
      const realTfMs = TIMEFRAME_MS[this.effectiveTf] || 60000;
      const sameBucket = Math.floor(live.timestamp / realTfMs) === Math.floor(last.timestamp / realTfMs);
      if (sameBucket) {
        live.high = Math.max(live.high, last.high);
        live.low = Math.min(live.low, last.low);
      }
    }
  }

  /** Merge real bars into the local set, re-anchor synthesis to the newest close. */
  private absorbRealBars(bars: BaseBar[], _provider: string): void {
    if (bars.length === 0) return;
    const tfMs = TIMEFRAME_MS[this.effectiveTf] || 60000;
    const bucketOf = (ts: number) => Math.floor(ts / tfMs) * tfMs;
    // Merge on rounded buckets so re-fetches replace (not duplicate) bars.
    const byBucket = new Map<number, BaseBar>();
    for (const b of this.bars) byBucket.set(bucketOf(b.timestamp), b);
    for (const b of bars) {
      const bucket = bucketOf(b.timestamp);
      const prev = byBucket.get(bucket);
      // Same-bucket update: keep the wider high/low, newest close/volume.
      if (prev && prev.timestamp !== b.timestamp) {
        byBucket.set(bucket, {
          timestamp: b.timestamp,
          open: prev.open,
          high: Math.max(prev.high, b.high),
          low: Math.min(prev.low, b.low),
          close: b.close,
          volume: Math.max(prev.volume, b.volume),
        });
      } else {
        byBucket.set(bucket, b);
      }
    }
    this.bars = Array.from(byBucket.values()).sort((a, b) => a.timestamp - b.timestamp);
    // Cap history at ~1200 bars for memory.
    if (this.bars.length > 1200) this.bars = this.bars.slice(-1200);
    const last = this.bars[this.bars.length - 1];
    if (last && last.close > 0) {
      const moved = this.lastRealAt > 0 && last.close !== this.lastRealPrice;
      this.lastRealPrice = last.close;
      this.lastRealAt = Date.now();
      this.quietMarket = !moved && Date.now() - this.lastRealAt > 120000;
      this.synth.anchorTo(last.close, Date.now());
    }
    // Recalibrate from real bars so synthesis matches realized volatility.
    this.synth.calibrate(this.bars, (TIMEFRAME_MS[this.effectiveTf] || 60000) / 1000);
  }

  /** Apply a synthesized tick to the live bar (L3 output) — used when the
   *  host chart wants the engine's own bar list kept in sync too. */
  applyTick(price: number): void {
    if (this.bars.length === 0) return;
    const tfMs = TIMEFRAME_MS[this.tf] || 60000;
    const now = Date.now();
    const live = this.bars[this.bars.length - 1];
    const nextTs = Math.floor(now / tfMs) * tfMs;
    if (nextTs > live.timestamp) {
      // Roll a fresh bar seeded from the previous close.
      this.bars.push({
        timestamp: nextTs,
        open: live.close, high: live.close, low: live.close, close: live.close, volume: 0,
      });
    }
    const cur = this.bars[this.bars.length - 1];
    const prev = cur.close;
    const maxMove = prev * 0.012;
    const clamped = Math.max(0.01, price);
    cur.close = Math.abs(clamped - prev) > maxMove ? prev + Math.sign(clamped - prev) * maxMove : clamped;
    if (cur.close > cur.high) cur.high = cur.close;
    if (cur.close < cur.low) cur.low = cur.close;
    cur.volume += Math.round(Math.abs(cur.close - prev) * 1000 + Math.random() * 10);
  }

  get liveBars(): BaseBar[] { return this.bars; }

  private emitBars(partial: boolean): void {
    this.onEvent({ type: 'bars', bars: this.bars, provider: this.providerLabel, partial });
  }
}
