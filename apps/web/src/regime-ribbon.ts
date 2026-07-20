// ─── Regime Ribbon — Adaptive Market-State Detection ──────────────────────
// Addon #3 of the "10 revolutionary additions" roadmap (see session notes).
// A persistent, advisory-only strip pinned to the TOP of the chart area that
// classifies the current market regime (trending / ranging / volatile) from
// ADX + ATR computed directly against the chart's own bar data — NOT from
// inside an OakScript indicator script. It never auto-applies anything: it
// only shows a confidence-scored classification plus a clickable "suggested
// preset" button the user must explicitly click.
//
// Scope deliberately matches the adversarial review verdict from the
// planning workflow:
//  - Advisory-only — no silent auto-swap of active indicators.
//  - Wall-clock hysteresis (not bar-count) — this app has sub-minute/live
//    tick data, so a bar-denominated dwell timer would do nothing to stop
//    tick-rate flicker.
//  - No "this improves your returns" language anywhere — there is no
//    backtest-validated evidence per regime, and this module must not
//    imply there is.
// See ANCHORED_SUMMARY-style session note: "Regime Ribbon" addon.

import { StdLib } from './oakscript';

export type RegimeType = 'trending' | 'ranging' | 'volatile';

export interface RegimeResult {
  regime: RegimeType;
  confidence: number; // 0..1 — a probabilistic read, not a validated signal
  adx: number;
  atrRatio: number; // current ATR% vs its own recent-baseline average
}

// ── Thresholds ──────────────────────────────────────────────────────────
// ADX_TREND_THRESHOLD: the classic Wilder trend-strength cutoff. The survey
// that scoped this feature found ADX is never numerically thresholded
// anywhere else in this codebase, so this is a textbook default, not a
// codebase precedent.
// VOL_RATIO_THRESHOLD: matches this codebase's OWN existing precedent —
// oakscript/indicators.ts's "Session Chronograph" flags a session notable
// at an ATR ratio of 1.6.
// TREND_MAX_VOL_RATIO: matches packages/core/.../adaptive-genesis-engine.ts's
// existing "trending" classification upper bound on volRatio (< 1.3).
const ADX_LEN = 14;
const ATR_LEN = 14;
const ATR_BASELINE_LEN = 50;
const ADX_TREND_THRESHOLD = 25;
const VOL_RATIO_THRESHOLD = 1.6;
const TREND_MAX_VOL_RATIO = 1.3;

// Recompute is already throttled to a wall-clock interval by the caller;
// this caps the WORK per recompute so it stays cheap even on a very long
// loaded history — 300 bars is far more than enough context for 14/50-period
// calculations.
const MAX_LOOKBACK_BARS = 300;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Pure classification over raw bar arrays — no OakScript interpreter/context
 * involved, callable directly from main.ts. Returns null when there isn't
 * enough history yet for a meaningful read (avoids a flickering false read
 * on a freshly-loaded symbol).
 */
export function classifyRegime(high: number[], low: number[], close: number[]): RegimeResult | null {
  const n = close.length;
  if (n < ADX_LEN + ATR_BASELINE_LEN + 5) return null;

  const start = Math.max(0, n - MAX_LOOKBACK_BARS);
  const h = high.slice(start), l = low.slice(start), c = close.slice(start);
  const last = c.length - 1;

  const adxSeries = StdLib.adx(h, l, c, ADX_LEN);
  const atrSeries = StdLib.atr(h, l, c, ATR_LEN);
  const adxVal = adxSeries[last] || 0;

  // Normalize ATR to %-of-price so the ratio is comparable across symbols
  // and price levels, then compare "now" against its own recent baseline —
  // raw ATR alone can't tell you whether TODAY is unusually volatile.
  const atrPct = atrSeries.map((v, i) => (c[i] > 0 ? (v / c[i]) * 100 : 0));
  const baselineStart = Math.max(0, atrPct.length - ATR_BASELINE_LEN);
  const baseline = atrPct.slice(baselineStart);
  const avgBaseline = baseline.reduce((a, b) => a + b, 0) / (baseline.length || 1);
  const curAtrPct = atrPct[last];
  const atrRatio = avgBaseline > 0 ? curAtrPct / avgBaseline : 1;

  let regime: RegimeType;
  let confidence: number;

  if (atrRatio >= VOL_RATIO_THRESHOLD) {
    // A volatility spike overrides trend/range classification regardless of
    // ADX — a whipsaw can look "trending" to ADX for a few bars.
    regime = 'volatile';
    confidence = clamp((atrRatio - VOL_RATIO_THRESHOLD) / 1.0, 0, 1);
  } else if (adxVal >= ADX_TREND_THRESHOLD && atrRatio < TREND_MAX_VOL_RATIO) {
    regime = 'trending';
    confidence = clamp((adxVal - ADX_TREND_THRESHOLD) / 30, 0, 1);
  } else {
    regime = 'ranging';
    const adxComponent = clamp((ADX_TREND_THRESHOLD - adxVal) / ADX_TREND_THRESHOLD, 0, 1);
    const volSpan = VOL_RATIO_THRESHOLD - TREND_MAX_VOL_RATIO;
    const volComponent = volSpan > 0 ? clamp((VOL_RATIO_THRESHOLD - atrRatio) / volSpan, 0, 1) : 0.5;
    confidence = (adxComponent + volComponent) / 2;
  }

  return { regime, confidence, adx: adxVal, atrRatio };
}

// ── Hysteresis ──────────────────────────────────────────────────────────
// Wall-clock dwell time, deliberately NOT bar-count — this app has live sub-
// minute ticking, so a bar-denominated timer wouldn't stop tick-rate thrash.
const MIN_DWELL_MS = 20_000;

export interface RegimeRibbonState {
  displayed: RegimeResult | null;
  lastChangeAt: number;
}

export function createInitialRegimeState(): RegimeRibbonState {
  return { displayed: null, lastChangeAt: 0 };
}

/**
 * Only lets the DISPLAYED regime label change after it's held for
 * MIN_DWELL_MS since the last actual change, so the ribbon can't flicker on
 * every live tick — but confidence/adx/atrRatio numbers always track the
 * latest computation for continuity.
 */
export function applyHysteresis(state: RegimeRibbonState, fresh: RegimeResult, now: number): RegimeResult {
  if (!state.displayed) {
    state.displayed = fresh;
    state.lastChangeAt = now;
    return fresh;
  }
  if (fresh.regime !== state.displayed.regime) {
    if (now - state.lastChangeAt >= MIN_DWELL_MS) {
      state.displayed = fresh;
      state.lastChangeAt = now;
      return fresh;
    }
    state.displayed = { ...state.displayed, confidence: fresh.confidence };
    return state.displayed;
  }
  state.displayed = fresh;
  return fresh;
}

// ── Presentation ────────────────────────────────────────────────────────
export const REGIME_LABELS: Record<RegimeType, string> = {
  trending: 'Trending',
  ranging: 'Ranging',
  volatile: 'Volatile',
};

export const REGIME_COLORS: Record<RegimeType, string> = {
  trending: '#22cc88',
  ranging: '#00ccff',
  volatile: '#ff4477',
};

// Suggested built-in indicator per regime. Deliberately drawn from names
// that ALREADY EXIST in oakscript/indicators.ts (never invented) — the
// classic idiom the original pitch named: trend gets a trend-follower,
// range gets mean-reversion bands, volatility gets an ATR-adaptive stop.
export const REGIME_SUGGESTIONS: Record<RegimeType, string> = {
  trending: 'EMA Ribbon',
  ranging: 'Bollinger Bands',
  volatile: 'ATR Trailing Stops',
};

export interface RegimeRibbonWidget {
  el: HTMLDivElement;
  /** Renders (or hides, if result is null) the ribbon for the latest classification. */
  update(result: RegimeResult | null, onApply: (indicatorName: string) => void): void;
}

export function createRegimeRibbon(): RegimeRibbonWidget {
  const el = document.createElement('div');
  el.id = 'regime-ribbon';
  Object.assign(el.style, {
    position: 'absolute', top: '0', left: '0', right: '0', height: '26px',
    display: 'none', alignItems: 'center', gap: '10px', padding: '0 12px',
    fontSize: '10px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.75)',
    background: 'linear-gradient(180deg, rgba(12,12,28,0.85), rgba(12,12,28,0.5) 75%, transparent)',
    borderBottom: '1px solid rgba(180,140,255,0.08)',
    zIndex: '5', pointerEvents: 'none',
  });

  const dot = document.createElement('span');
  Object.assign(dot.style, {
    width: '7px', height: '7px', borderRadius: '50%', flexShrink: '0',
    transition: 'background 0.6s ease, box-shadow 0.6s ease',
  });

  const label = document.createElement('span');
  label.style.fontWeight = '700';
  label.style.letterSpacing = '0.5px';
  label.style.transition = 'color 0.6s ease';

  const confidenceEl = document.createElement('span');
  confidenceEl.style.color = 'rgba(255,255,255,0.4)';

  const advisoryTag = document.createElement('span');
  advisoryTag.textContent = 'advisory';
  Object.assign(advisoryTag.style, {
    color: 'rgba(255,255,255,0.25)', fontSize: '9px', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '3px', padding: '0 4px',
  });
  advisoryTag.title = 'Regime Ribbon never applies anything automatically — it only suggests.';

  const suggestBtn = document.createElement('button');
  Object.assign(suggestBtn.style, {
    marginLeft: 'auto', pointerEvents: 'auto', cursor: 'pointer',
    background: 'rgba(180,140,255,0.1)', border: '1px solid rgba(180,140,255,0.25)',
    borderRadius: '4px', color: 'rgba(255,255,255,0.75)', fontSize: '10px',
    padding: '2px 8px', fontFamily: 'monospace',
  });
  suggestBtn.addEventListener('mouseenter', () => { suggestBtn.style.background = 'rgba(180,140,255,0.2)'; });
  suggestBtn.addEventListener('mouseleave', () => { suggestBtn.style.background = 'rgba(180,140,255,0.1)'; });

  el.appendChild(dot);
  el.appendChild(label);
  el.appendChild(confidenceEl);
  el.appendChild(advisoryTag);
  el.appendChild(suggestBtn);

  let currentOnApply: ((name: string) => void) | null = null;
  let currentSuggestion = '';
  suggestBtn.addEventListener('click', () => {
    if (currentOnApply && currentSuggestion) currentOnApply(currentSuggestion);
  });

  function update(result: RegimeResult | null, onApply: (name: string) => void): void {
    currentOnApply = onApply;
    if (!result) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    const color = REGIME_COLORS[result.regime];
    dot.style.background = color;
    dot.style.boxShadow = `0 0 6px ${color}`;
    label.textContent = REGIME_LABELS[result.regime];
    label.style.color = color;
    confidenceEl.textContent = `${Math.round(result.confidence * 100)}% · ADX ${result.adx.toFixed(0)} · ATR×${result.atrRatio.toFixed(2)}`;
    currentSuggestion = REGIME_SUGGESTIONS[result.regime];
    suggestBtn.textContent = `Suggest: ${currentSuggestion} →`;
    suggestBtn.title = 'Advisory only — click to apply this preset indicator. Never applied automatically.';
  }

  return { el, update };
}
