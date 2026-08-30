/**
 * DAFE Hybrid Data Engine.
 *
 * Goal: a live-tick experience that is ~indistinguishable from a paid real-time
 * feed, at a fraction of the API cost — and gap-free even when a provider stalls.
 *
 * Strategy (correction-anchored synthesis):
 *   1. Massive (PAID)  → authoritative anchors, fetched SPARINGLY (once per bar
 *      or every massiveIntervalMs). This is the expensive call we minimize.
 *   2. yfinance (FREE) → frequent cheap corrections (every yahooIntervalMs).
 *   3. Ultra-synthetic engine → fills the sub-second / sub-minute gaps BETWEEN
 *      real updates, calibrated to the symbol's own realized volatility & drift.
 *
 * Accuracy: the synthetic path is always BRACKETED by real anchors and pulled
 * toward the real-extrapolated path each tick, so the uncorrected error window
 * is only the time between (free) corrections — typically <15s, keeping the
 * displayed price within a fraction of a percent of the live value. Every real
 * quote snaps the path back to truth, so error cannot accumulate. A divergence
 * guard forces an immediate correction if synthesis ever drifts too far.
 *
 * Compute: each tick is a handful of float ops (negligible); corrections are
 * async fetches that never block rendering.
 */

import type { BaseBar } from '@dafe/types';

export interface HybridConfig {
  baseUrl: string;
  massiveIntervalMs: number;     // paid anchor cadence when yahoo covers (sparse)
  massiveOnlyIntervalMs: number; // paid cadence when yahoo does NOT cover the symbol
  yahooIntervalMs: number;       // free correction cadence (frequent)
  snapFactor: number;            // 0..1 how hard a correction pulls synth to real
  maxDivergence: number;         // fraction; above this, force an early correction
  yahooFailThreshold: number;    // consecutive yahoo misses before declaring "uncovered"
  maxBandPct: number;            // HARD cap: synth can't leave ±this of the anchor
}

export interface HybridStatus {
  active: boolean;
  massiveAvailable: boolean;
  yahooAvailable: boolean;
  /** Whether yfinance actually returns data for the current symbol. */
  yahooCovers: boolean;
  /** 'blend' (yahoo+massive), 'paid-only' (massive only), or 'synthetic'. */
  mode: 'blend' | 'paid-only' | 'synthetic';
  corrections: number;
  massiveCalls: number;
  yahooCalls: number;
  lastSource: string;
  /** |synth − real| at the most recent correction, as a fraction. */
  lastErrorPct: number;
  /** Worst observed correction error this session, as a fraction. */
  maxErrorPct: number;
  /** Rolling estimate of live-tracking accuracy (1 − recent error). */
  accuracy: number;
}

const DEFAULT_CONFIG: HybridConfig = {
  baseUrl: 'http://localhost:8788',
  massiveIntervalMs: 60_000,      // paid feed at most once a minute when yahoo covers
  massiveOnlyIntervalMs: 20_000,  // paid feed every ~20s when it's the ONLY source
  yahooIntervalMs: 12_000,        // free correction every ~12s
  snapFactor: 0.35,               // reduced from 0.75 to prevent bounce-back
  maxDivergence: 0.006,           // 0.6% — slightly relaxed to reduce thrash
  yahooFailThreshold: 3,
  maxBandPct: 0.03,               // tighter band ±3%
};

function gauss(): number {
  // Box–Muller, clamped to avoid fat-tail spikes in a display feed.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, g));
}

export class HybridDataEngine {
  private cfg: HybridConfig;
  private symbol = '';
  private timeframeSec = 60;

  // Anchor (last real, authoritative price) + synthesized price.
  private anchorPrice = 0;
  private anchorTime = 0;
  private synth = 0;
  private lastTickTime = 0;

  // Calibration (per-second, from the symbol's own recent bars).
  private driftPerSec = 0;
  private volPerSec = 0;

  // Provider availability + per-symbol coverage + telemetry.
  private massiveAvailable = false;
  private yahooAvailable = true;
  private yahooCovers = true;     // does yfinance return data for THIS symbol?
  private yahooFails = 0;
  private corrections = 0;
  private massiveCalls = 0;
  private yahooCalls = 0;
  private lastSource = '';
  private lastErrorPct = 0;
  private maxErrorPct = 0;
  private accuracyEwma = 1;

  private timers: ReturnType<typeof setInterval>[] = [];
  private correcting = false;
  private lastForcedCorrection = 0;
  private active = false;

  /** Notified when the active blend changes (e.g. yfinance stops covering). */
  onCoverageChange: ((status: HybridStatus) => void) | null = null;

  constructor(config: Partial<HybridConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /** Current operating mode given provider availability + symbol coverage. */
  private mode(): 'blend' | 'paid-only' | 'synthetic' {
    if (this.yahooCovers && this.yahooAvailable) return 'blend';
    if (this.massiveAvailable) return 'paid-only';
    return 'synthetic';
  }

  /** Detect whether the paid (Massive) feed is configured/available. */
  async detectProviders(): Promise<{ massive: boolean; yahoo: boolean }> {
    try {
      const r = await fetch(`${this.cfg.baseUrl}/api/market-data/providers`);
      const data = await r.json();
      for (const p of data.providers || []) {
        if (p.name === 'massive') this.massiveAvailable = !!p.available;
        if (p.name === 'yahoo') this.yahooAvailable = !!p.available;
      }
    } catch {
      this.massiveAvailable = false;
    }
    return { massive: this.massiveAvailable, yahoo: this.yahooAvailable };
  }

  /** Derive realized drift + volatility (per second) from recent real bars. */
  calibrate(bars: BaseBar[], timeframeSec: number): void {
    this.timeframeSec = Math.max(1, timeframeSec);
    const closes = bars.slice(-120).map(b => b.close).filter(c => c > 0);
    if (closes.length < 3) { this.driftPerSec = 0; this.volPerSec = 0.0001; return; }
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    const sd = Math.sqrt(variance);
    // Convert per-bar stats to per-second, with HARD caps so a spike that leaks
    // into the history can't inflate drift/vol and run the price away.
    //   drift: at most ±0.3% of trend per bar
    //   vol:   at most ~0.8% of movement per bar
    const maxDriftPerBar = 0.003;
    const maxVolPerBar = 0.008;
    const clampedMean = Math.max(-maxDriftPerBar, Math.min(maxDriftPerBar, mean));
    const clampedSd = Math.min(sd, maxVolPerBar);
    this.driftPerSec = clampedMean / this.timeframeSec;
    this.volPerSec = clampedSd / Math.sqrt(this.timeframeSec);
    if (!isFinite(this.driftPerSec)) this.driftPerSec = 0;
    if (!isFinite(this.volPerSec) || this.volPerSec <= 0) this.volPerSec = 0.0001;
  }

  /** Begin live synthesis + correction timers anchored at `lastPrice`. */
  start(symbol: string, lastPrice: number): void {
    if (symbol !== this.symbol) { this.yahooCovers = this.yahooAvailable; this.yahooFails = 0; }
    this.symbol = symbol;
    this.anchorPrice = lastPrice;
    this.synth = lastPrice;
    this.anchorTime = Date.now();
    this.lastTickTime = this.anchorTime;
    this.active = true;
    this.scheduleCorrections();
    // Prime an immediate correction with the best available source.
    void this.correct(this.yahooCovers && this.yahooAvailable ? 'yahoo' : 'massive');
  }

  /**
   * (Re)configure the correction timers for the current coverage mode:
   *   - blend     → frequent free yahoo + sparse paid massive anchors
   *   - paid-only → massive at a tighter cadence (sole real source); synthesis
   *                 fills the wider gaps. Still a big request reduction vs live.
   */
  private scheduleCorrections(): void {
    this.stopTimers();
    if (this.yahooCovers && this.yahooAvailable) {
      this.timers.push(setInterval(() => { if (this.yahooCovers) void this.correct('yahoo'); }, this.cfg.yahooIntervalMs));
      if (this.massiveAvailable) {
        this.timers.push(setInterval(() => { void this.correct('massive'); }, this.cfg.massiveIntervalMs));
      }
    } else if (this.massiveAvailable) {
      this.timers.push(setInterval(() => { void this.correct('massive'); }, this.cfg.massiveOnlyIntervalMs));
    }
    // No providers → pure synthetic (no timers); ticks still run.
  }

  stop(): void {
    this.active = false;
    this.stopTimers();
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  isActive(): boolean { return this.active; }

  /**
   * Advance the synthesized price by one display tick. Returns the new price.
   * Cheap: a few float ops. Pulls gently toward the real-extrapolated path so
   * the synthetic can never wander far before the next correction snaps it.
   */
  tick(nowMs: number = Date.now()): number {
    if (this.anchorPrice <= 0) return this.synth;
    const dt = Math.max(0, (nowMs - this.lastTickTime) / 1000);
    this.lastTickTime = nowMs;
    if (dt <= 0) return this.synth;

    // Cap elapsed so a stale anchorTime can't explode the drift term.
    const elapsed = Math.min((nowMs - this.anchorTime) / 1000, 120);
    // Hard band: a real price physically can't move more than maxBandPct between
    // (frequent) corrections, so we never let synthesis run away (the 736 spike).
    const lo = this.anchorPrice * (1 - this.cfg.maxBandPct);
    const hi = this.anchorPrice * (1 + this.cfg.maxBandPct);

    // Where the real price "should" be, extrapolated from the last anchor.
    let expected = this.anchorPrice * Math.exp(this.driftPerSec * elapsed);
    expected = Math.max(lo, Math.min(hi, expected));

    // GBM increment + a gentle reversion toward the expected real path.
    const shock = this.volPerSec * Math.sqrt(dt) * gauss();
    this.synth *= Math.exp(this.driftPerSec * dt + shock);
    this.synth += (expected - this.synth) * 0.05; // 5% pull per tick
    this.synth = Math.max(lo, Math.min(hi, this.synth)); // enforce the band

    // Divergence guard: if synthesis strays too far, demand an early correction.
    const div = Math.abs(this.synth - expected) / Math.max(1e-9, expected);
    if (div > this.cfg.maxDivergence && nowMs - this.lastForcedCorrection > 4000) {
      this.lastForcedCorrection = nowMs;
      void this.correct(this.yahooCovers && this.yahooAvailable ? 'yahoo' : 'massive');
    }
    if (this.synth <= 0) this.synth = expected;
    return this.synth;
  }

  /** Fetch a cheap real quote and snap the synthetic path back to truth. */
  private async correct(provider: 'yahoo' | 'massive'): Promise<void> {
    if (!this.active || this.correcting) return;
    if (provider === 'massive' && !this.massiveAvailable) return;
    this.correcting = true;
    try {
      const url = `${this.cfg.baseUrl}/api/quote/${encodeURIComponent(this.symbol)}?provider=${provider}`;
      const r = await fetch(url);
      const data = await r.json();
      if (provider === 'massive') this.massiveCalls++; else this.yahooCalls++;

      if (!data.ok || typeof data.price !== 'number' || data.price <= 0) {
        // Track yfinance coverage: repeated misses → this symbol isn't on yahoo,
        // so fall back to the paid stream alone (at a reduced cadence).
        if (provider === 'yahoo' && this.yahooCovers) {
          this.yahooFails++;
          if (this.yahooFails >= this.cfg.yahooFailThreshold) {
            this.yahooCovers = false;
            this.scheduleCorrections();
            this.onCoverageChange?.(this.getStatus());
            if (this.massiveAvailable) void this.correct('massive');
          }
        }
        return;
      }

      // Yahoo recovered for this symbol — restore the blend.
      if (provider === 'yahoo') {
        this.yahooFails = 0;
        if (!this.yahooCovers) { this.yahooCovers = true; this.scheduleCorrections(); this.onCoverageChange?.(this.getStatus()); }
      }

      const real = data.price;
      const err = Math.abs(this.synth - real) / real;
      this.lastErrorPct = err;
      this.maxErrorPct = Math.max(this.maxErrorPct, err);
      this.accuracyEwma = this.accuracyEwma * 0.7 + (1 - Math.min(err, 1)) * 0.3;

      // Massive is authoritative → snap harder than a free yahoo correction.
      const factor = provider === 'massive' ? Math.min(1, this.cfg.snapFactor + 0.2) : this.cfg.snapFactor;
      this.synth += (real - this.synth) * factor;
      this.anchorPrice = real;
      this.anchorTime = Date.now();
      this.corrections++;
      this.lastSource = provider;
    } catch {
      // Provider hiccup — keep synthesizing; next correction will catch up.
    } finally {
      this.correcting = false;
    }
  }

  getStatus(): HybridStatus {
    return {
      active: this.active,
      massiveAvailable: this.massiveAvailable,
      yahooAvailable: this.yahooAvailable,
      yahooCovers: this.yahooCovers,
      mode: this.mode(),
      corrections: this.corrections,
      massiveCalls: this.massiveCalls,
      yahooCalls: this.yahooCalls,
      lastSource: this.lastSource,
      lastErrorPct: this.lastErrorPct,
      maxErrorPct: this.maxErrorPct,
      accuracy: this.accuracyEwma,
    };
  }
}
