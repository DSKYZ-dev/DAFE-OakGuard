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

// Suggested built-in signal models per regime — a LIST, not one hardcoded
// name. Deliberately drawn from names that ALREADY EXIST in
// oakscript/indicators.ts (never invented): trend gets trend-followers,
// range gets mean-reversion, volatility gets ATR-adaptive models. The
// widget picks deterministically from the list using the live ADX/ATR
// read (so different trending days surface different models) and the ↻
// button cycles the rest without applying anything.
export const REGIME_SUGGESTION_LISTS: Record<RegimeType, string[]> = {
  trending: ['Aurora Momentum Rider', 'EMA Ribbon', 'MACD', 'Simple Moving Average Crossover'],
  ranging: ['Quantum Reversion Engine', 'Bollinger Bands', 'Session High/Low Divergence', 'RSI'],
  volatile: ['ATR Trailing Stops', 'Bollinger Bands', 'Adaptive Genesis Engine (AGE)', 'VWAP Bands'],
};

/** Back-compat: the first suggestion per regime. */
export const REGIME_SUGGESTIONS: Record<RegimeType, string> = {
  trending: REGIME_SUGGESTION_LISTS.trending[0],
  ranging: REGIME_SUGGESTION_LISTS.ranging[0],
  volatile: REGIME_SUGGESTION_LISTS.volatile[0],
};

export function pickSuggestion(
  result: RegimeResult,
  cycleIndex = 0,
  isApplied: (name: string) => boolean = () => false,
): string | null {
  const list = REGIME_SUGGESTION_LISTS[result.regime];
  // Deterministic bucket from the live metrics — ADX strength within the
  // regime meaningfully changes which model fits, and it stops the button
  // reading "EMA Ribbon" on every trending day forever.
  const metricBucket = result.regime === 'trending'
    ? Math.floor(result.adx / 15)
    : result.regime === 'volatile'
      ? Math.floor(result.atrRatio * 2)
      : Math.floor(result.confidence * 4);
  // Skip models already on the chart, so the button never offers a duplicate.
  const start = Math.abs(metricBucket + cycleIndex);
  for (let k = 0; k < list.length; k++) {
    const name = list[(start + k) % list.length];
    if (!isApplied(name)) return name;
  }
  return null;
}

export interface RegimeRibbonWidget {
  el: HTMLDivElement;
  /**
   * Renders (or hides, if result is null) the ribbon for the latest
   * classification. infoVisible controls ONLY the regime classification
   * display (dot/label/confidence/ADX/ATR + the "advisory" tag) — the
   * "Suggest: X" button is a separate, always-shown-when-data-exists
   * feature, not gated by it. When result is null there's no regime to
   * suggest FROM either way, so the whole ribbon hides regardless of
   * infoVisible. isApplied marks models already on the chart; they are never
   * suggested.
   */
  update(result: RegimeResult | null, onApply: (indicatorName: string) => void, infoVisible: boolean, isApplied?: (indicatorName: string) => boolean): void;
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

  // The regime CLASSIFICATION display — dot/label/confidence/ADX/ATR + the
  // "advisory" disclaimer tag. This whole group is what the toolbar's
  // Regime toggle controls; it's a separate flex item from suggestBtn so
  // hiding it doesn't touch the suggestion button at all.
  const infoGroup = document.createElement('span');
  Object.assign(infoGroup.style, { display: 'flex', alignItems: 'center', gap: '10px' });

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

  infoGroup.appendChild(dot);
  infoGroup.appendChild(label);
  infoGroup.appendChild(confidenceEl);
  infoGroup.appendChild(advisoryTag);

  const suggestBtn = document.createElement('button');
  Object.assign(suggestBtn.style, {
    marginLeft: 'auto', pointerEvents: 'auto', cursor: 'pointer',
    background: 'rgba(180,140,255,0.1)', border: '1px solid rgba(180,140,255,0.25)',
    borderRadius: '4px', color: 'rgba(255,255,255,0.75)', fontSize: '10px',
    padding: '2px 8px', fontFamily: 'monospace',
  });
  suggestBtn.addEventListener('mouseenter', () => { suggestBtn.style.background = 'rgba(180,140,255,0.2)'; });
  suggestBtn.addEventListener('mouseleave', () => { suggestBtn.style.background = 'rgba(180,140,255,0.1)'; });

  const cycleBtn = document.createElement('button');
  cycleBtn.textContent = '↻';
  cycleBtn.title = 'Next suggested model for this regime (does not apply anything)';
  Object.assign(cycleBtn.style, {
    pointerEvents: 'auto', cursor: 'pointer',
    background: 'rgba(180,140,255,0.1)', border: '1px solid rgba(180,140,255,0.25)',
    borderRadius: '4px', color: 'rgba(255,255,255,0.75)', fontSize: '10px',
    padding: '2px 6px', fontFamily: 'monospace',
  });

  el.appendChild(infoGroup);
  el.appendChild(suggestBtn);
  el.appendChild(cycleBtn);

  let currentOnApply: ((name: string) => void) | null = null;
  let currentIsApplied: (name: string) => boolean = () => false;
  let currentSuggestion = '';
  let lastResult: RegimeResult | null = null;
  let cycleIndex = 0;
  let lastRegime: RegimeType | null = null;
  suggestBtn.addEventListener('click', () => {
    if (currentOnApply && currentSuggestion) currentOnApply(currentSuggestion);
  });
  cycleBtn.addEventListener('click', () => {
    if (!lastResult) return;
    cycleIndex++;
    renderSuggestion();
  });

  // Picks the next suggestion that is not already on the chart. When every
  // model for this regime is applied, the button goes inert instead of
  // offering a duplicate.
  function renderSuggestion(): void {
    if (!lastResult) return;
    currentSuggestion = pickSuggestion(lastResult, cycleIndex, currentIsApplied) ?? '';
    const available = currentSuggestion !== '';
    suggestBtn.disabled = !available;
    suggestBtn.style.opacity = available ? '1' : '0.45';
    suggestBtn.style.cursor = available ? 'pointer' : 'default';
    suggestBtn.textContent = available ? `Suggest: ${currentSuggestion} →` : 'Suggest: all on chart ✓';
    suggestBtn.title = available
      ? `Advisory only — click to apply this preset signal model. ↻ cycles ${REGIME_SUGGESTION_LISTS[lastResult.regime].length} ${lastResult.regime} models. Never applied automatically.`
      : `Every suggested ${lastResult.regime} model is already on the chart. Remove one to suggest it again.`;
  }

  function update(result: RegimeResult | null, onApply: (name: string) => void, infoVisible: boolean, isApplied: (name: string) => boolean = () => false): void {
    currentOnApply = onApply;
    currentIsApplied = isApplied;
    if (!result) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    infoGroup.style.display = infoVisible ? 'flex' : 'none';
    const color = REGIME_COLORS[result.regime];
    dot.style.background = color;
    dot.style.boxShadow = `0 0 6px ${color}`;
    label.textContent = REGIME_LABELS[result.regime];
    label.style.color = color;
    confidenceEl.textContent = `${Math.round(result.confidence * 100)}% · ADX ${result.adx.toFixed(0)} · ATR×${result.atrRatio.toFixed(2)}`;
    if (result.regime !== lastRegime) { lastRegime = result.regime; cycleIndex = 0; }
    lastResult = result;
    renderSuggestion();
  }

  return { el, update };
}
