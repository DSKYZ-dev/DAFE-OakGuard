// ─── Regime Ribbon — Adaptive Market-State Detection ──────────────────────
// A persistent, advisory-only strip pinned to the TOP of the chart area that
// classifies the current market regime (trending / ranging / volatile) from
// ADX + ATR computed directly against the chart's own bar data. It never
// applies anything: it shows a confidence-scored read, a suggested preset the
// user must click, and an optional chart visual (regime fog over the bars).
//
// Read rules:
//  - No read beats a wrong read. A flat tape, a NaN bar or too little history
//    returns null, and the ribbon hides instead of showing a made-up label.
//  - Strength (confidence) is 0.5 at a threshold and 1.0 well past it, so a
//    borderline regime still reads as a regime rather than 0%.
//  - Wall-clock hysteresis, not bar-count, because the feed can tick sub-minute.
//    A different label must hold for MIN_DWELL_MS, and the numbers on screen
//    always belong to the label on screen.
//  - Never claim improved returns: there is no backtest evidence per regime.

import { StdLib } from './oakscript/runtime';

export type RegimeType = 'trending' | 'ranging' | 'volatile';

export interface RegimeResult {
  regime: RegimeType;
  confidence: number; // 0.5..1 — strength of the read, not a validated signal
  adx: number;
  atrRatio: number; // current ATR% vs the average of the prior bars
}

// ── Thresholds ──────────────────────────────────────────────────────────
// ADX_TREND_THRESHOLD: the classic Wilder trend-strength cutoff (textbook
// default, not a codebase precedent).
// VOL_RATIO_THRESHOLD: matches oakscript/indicators.ts's "Session Chronograph"
// flag for a notable session (ATR ratio 1.6).
// TREND_MAX_VOL_RATIO: matches adaptive-genesis-engine.ts's trending bound (< 1.3).
const ADX_LEN = 14;
const ATR_LEN = 14;
const ATR_BASELINE_LEN = 50;
const ADX_TREND_THRESHOLD = 25;
const VOL_RATIO_THRESHOLD = 1.6;
const TREND_MAX_VOL_RATIO = 1.3;
const MIN_BARS = ADX_LEN + ATR_BASELINE_LEN + 5;

// Work per read stays bounded on a long loaded history: 300 bars is far more
// context than 14/50-period calculations need.
const MAX_LOOKBACK_BARS = 300;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Strength from the distances past each decisive threshold, each normalised to 0..1. */
function strengthFrom(margins: number[]): number {
  const weakest = Math.min(...margins.map((m) => clamp(m, 0, 1)));
  return 0.5 + 0.5 * weakest;
}

/** ADX and ATR-% series over one window. Each index depends only on bars up to it. */
function seriesFor(h: number[], l: number[], c: number[]): { adx: number[]; atrPct: number[] } {
  const adx = StdLib.adx(h, l, c, ADX_LEN);
  const atr = StdLib.atr(h, l, c, ATR_LEN);
  // ATR as a percentage of price, so the ratio compares across symbols.
  return { adx, atrPct: atr.map((v, i) => (c[i] > 0 ? (v / c[i]) * 100 : NaN)) };
}

/** The read at bar i, using only bars up to i. Null when there is no honest read. */
function readAt(i: number, adx: number[], atrPct: number[]): RegimeResult | null {
  const adxVal = adx[i];
  const curAtrPct = atrPct[i];
  // The baseline is the PRIOR bars: the current bar must not dampen its own spike.
  const baseline = atrPct.slice(Math.max(0, i - ATR_BASELINE_LEN), i);
  const avgBaseline = baseline.length > 0 ? baseline.reduce((a, b) => a + b, 0) / baseline.length : NaN;
  if (!Number.isFinite(adxVal) || !Number.isFinite(curAtrPct) || !(avgBaseline > 0)) return null;
  const atrRatio = curAtrPct / avgBaseline;
  if (!Number.isFinite(atrRatio)) return null;

  if (atrRatio >= VOL_RATIO_THRESHOLD) {
    // A volatility spike overrides trend/range regardless of ADX: a whipsaw
    // can look "trending" to ADX for a few bars.
    return {
      regime: 'volatile',
      confidence: strengthFrom([(atrRatio - VOL_RATIO_THRESHOLD) / 1.0]),
      adx: adxVal,
      atrRatio,
    };
  }
  if (adxVal >= ADX_TREND_THRESHOLD && atrRatio < TREND_MAX_VOL_RATIO) {
    return {
      regime: 'trending',
      confidence: strengthFrom([(adxVal - ADX_TREND_THRESHOLD) / 30, (TREND_MAX_VOL_RATIO - atrRatio) / 0.3]),
      adx: adxVal,
      atrRatio,
    };
  }
  return {
    regime: 'ranging',
    confidence: strengthFrom([(ADX_TREND_THRESHOLD - adxVal) / ADX_TREND_THRESHOLD, (VOL_RATIO_THRESHOLD - atrRatio) / 0.3]),
    adx: adxVal,
    atrRatio,
  };
}

/**
 * Pure classification of the LATEST bar over raw bar arrays — no OakScript
 * interpreter, no DOM. Returns null when there is no honest read: too little
 * history, mismatched arrays, NaN in the decisive values, or a flat tape.
 */
export function classifyRegime(high: number[], low: number[], close: number[]): RegimeResult | null {
  const n = close.length;
  if (n < MIN_BARS || high.length !== n || low.length !== n) return null;
  const start = Math.max(0, n - MAX_LOOKBACK_BARS);
  const { adx, atrPct } = seriesFor(high.slice(start), low.slice(start), close.slice(start));
  return readAt(adx.length - 1, adx, atrPct);
}

// ── Regime history ──────────────────────────────────────────────────────
export interface RegimeSegment {
  start: number; // absolute index into the arrays passed to regimeSegments
  end: number; // inclusive
  regime: RegimeType;
  strength: number; // mean confidence across the run
}

interface Run { start: number; end: number; regime: RegimeType; sum: number; count: number }

/**
 * The regime at every bar of the lookback window, as runs of one regime. A run
 * shorter than minRun bars is flicker: it joins the run before it. Bars without
 * an honest read are left out, so they show as gaps rather than a guess.
 */
export function regimeSegments(high: number[], low: number[], close: number[], minRun = 5): RegimeSegment[] {
  const n = close.length;
  if (n < MIN_BARS || high.length !== n || low.length !== n) return [];
  const offset = Math.max(0, n - MAX_LOOKBACK_BARS);
  const { adx, atrPct } = seriesFor(high.slice(offset), low.slice(offset), close.slice(offset));

  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let i = MIN_BARS - 1; i < adx.length; i++) {
    const r = readAt(i, adx, atrPct);
    if (!r) { cur = null; continue; }
    if (cur && cur.regime === r.regime && cur.end === i - 1) {
      cur.end = i;
      cur.sum += r.confidence;
      cur.count++;
    } else {
      cur = { start: i, end: i, regime: r.regime, sum: r.confidence, count: 1 };
      runs.push(cur);
    }
  }

  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    const contiguous = !!prev && prev.end === run.start - 1;
    // The newest run is never absorbed: it is the live state, however short.
    const isFlicker = run.end - run.start + 1 < minRun && run !== runs[runs.length - 1];
    if (contiguous && (prev.regime === run.regime || isFlicker)) {
      prev.end = run.end;
      prev.sum += run.sum;
      prev.count += run.count;
    } else {
      merged.push({ ...run });
    }
  }
  return merged.map((r) => ({
    start: r.start + offset,
    end: r.end + offset,
    regime: r.regime,
    strength: r.sum / r.count,
  }));
}

// ── Hysteresis ──────────────────────────────────────────────────────────
const MIN_DWELL_MS = 20_000;

export interface RegimeRibbonState {
  displayed: RegimeResult | null;
  lastChangeAt: number;
  /** A regime that differs from the displayed one and is still serving its dwell. */
  pending: { regime: RegimeType; since: number } | null;
}

export function createInitialRegimeState(): RegimeRibbonState {
  return { displayed: null, lastChangeAt: 0, pending: null };
}

/**
 * Returns the snapshot to show. A different label replaces the shown one only
 * after it has held continuously for MIN_DWELL_MS. While it waits, the old
 * snapshot stays whole, so its label is never shown with the new read's numbers.
 */
export function applyHysteresis(state: RegimeRibbonState, fresh: RegimeResult, now: number): RegimeResult {
  if (!state.displayed) {
    state.displayed = fresh;
    state.lastChangeAt = now;
    state.pending = null;
    return fresh;
  }
  if (fresh.regime === state.displayed.regime) {
    state.displayed = fresh;
    state.pending = null;
    return fresh;
  }
  if (!state.pending || state.pending.regime !== fresh.regime) {
    state.pending = { regime: fresh.regime, since: now };
  }
  if (now - state.pending.since >= MIN_DWELL_MS) {
    state.displayed = fresh;
    state.lastChangeAt = now;
    state.pending = null;
    return fresh;
  }
  return state.displayed;
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
// name. Drawn only from names that already exist in oakscript/indicators.ts:
// trend gets trend-followers, range gets mean-reversion, volatility gets
// ATR-adaptive models. The picker chooses from the live read, and ↻ cycles the
// rest without applying anything.
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
  // A deterministic bucket from the live metrics, so the suggestion follows
  // the read. Non-finite inputs bucket to 0, so the picker always returns a name.
  const bucket = (x: number, step: number) => (Number.isFinite(x) ? Math.floor(x / step) : 0);
  const metricBucket = result.regime === 'trending'
    ? bucket(result.adx, 15)
    : result.regime === 'volatile'
      ? bucket(result.atrRatio, 0.5)
      : bucket(result.confidence, 0.25);
  // Skip models already on the chart, so the button never offers a duplicate.
  const start = Math.abs(metricBucket + cycleIndex);
  for (let k = 0; k < list.length; k++) {
    const name = list[(start + k) % list.length];
    if (!isApplied(name)) return name;
  }
  return null;
}

// ── Chart visual ────────────────────────────────────────────────────────
/** The displayed regime's colour and strength (used by the 3D window's scene fog). */
export interface RegimeVisual {
  color: string;
  rgb: string;
  strength: number;
}

export function regimeVisualFor(result: RegimeResult | null): RegimeVisual | null {
  if (!result) return null;
  const color = REGIME_COLORS[result.regime];
  const n = parseInt(color.slice(1), 16);
  return {
    color,
    rgb: `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`,
    strength: clamp(Number.isFinite(result.confidence) ? result.confidence : 0, 0, 1),
  };
}

/** rgba() for a #rrggbb colour. */
export function rgbaOf(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1).toFixed(3)})`;
}

/** A regime segment's pixel box: horizontal extent and the price envelope it covers. */
export interface RegimeBox {
  x0: number;
  x1: number;
  top: number; // pixels, top < bottom
  bottom: number;
  cy: number; // centre of the envelope, pixels
  color: string;
  strength: number;
}

/**
 * Pixel boxes for the visible part of each segment. `bars` is the full array
 * the segment indices refer to; xOf maps an absolute bar index to pixels and
 * yOf maps a price to pixels; halfBar is half a bar's pixel width.
 */
export function regimeBoxes(
  segs: RegimeSegment[],
  bars: Array<{ high: number; low: number }>,
  visStart: number,
  visEnd: number,
  xOf: (abs: number) => number,
  yOf: (price: number) => number,
  halfBar: number,
): RegimeBox[] {
  const out: RegimeBox[] = [];
  for (const seg of segs) {
    const s = Math.max(seg.start, visStart);
    const e = Math.min(seg.end, visEnd, bars.length - 1);
    if (e < s) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = s; i <= e; i++) {
      if (bars[i].high > hi) hi = bars[i].high;
      if (bars[i].low < lo) lo = bars[i].low;
    }
    const a = yOf(hi);
    const b = yOf(lo);
    out.push({
      x0: xOf(s) - halfBar,
      x1: xOf(e) + halfBar,
      top: Math.min(a, b),
      bottom: Math.max(a, b),
      cy: (a + b) / 2,
      color: REGIME_COLORS[seg.regime],
      strength: clamp(seg.strength, 0, 1),
    });
  }
  return out;
}

/** 2D: a band per regime segment across the full chart height, densest around its price envelope. */
export function paintRegimeBands(ctx: CanvasRenderingContext2D, boxes: RegimeBox[], height: number): void {
  if (height <= 0) return;
  ctx.save();
  for (const b of boxes) {
    const k = 0.55 + 0.45 * b.strength;
    const g = ctx.createLinearGradient(0, 0, 0, height);
    const lo = clamp((b.top - 12) / height, 0, 1);
    const hi = clamp((b.bottom + 12) / height, 0, 1);
    g.addColorStop(0, rgbaOf(b.color, 0.06 * k));
    g.addColorStop(lo, rgbaOf(b.color, 0.34 * k));
    g.addColorStop(hi, rgbaOf(b.color, 0.34 * k));
    g.addColorStop(1, rgbaOf(b.color, 0.06 * k));
    ctx.fillStyle = g;
    ctx.fillRect(b.x0, 0, b.x1 - b.x0, height);
  }
  ctx.restore();
}

/** Isometric: a soft ellipse per regime segment, hugging the bars it covers. */
export function paintRegimeGlow(ctx: CanvasRenderingContext2D, boxes: RegimeBox[], layer: 'back' | 'front'): void {
  ctx.save();
  for (const b of boxes) {
    const k = 0.55 + 0.45 * b.strength;
    const a0 = (layer === 'back' ? 0.7 : 0.16) * k;
    const hw = Math.max(10, (b.x1 - b.x0) / 2 + 8);
    const hh = Math.max(14, (b.bottom - b.top) / 2 + 8);
    ctx.save();
    ctx.translate((b.x0 + b.x1) / 2, b.cy);
    ctx.scale(hw / hh, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, hh);
    g.addColorStop(0, rgbaOf(b.color, a0));
    g.addColorStop(0.4, rgbaOf(b.color, a0 * 0.6));
    g.addColorStop(0.75, rgbaOf(b.color, a0 * 0.15));
    g.addColorStop(1, rgbaOf(b.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, hh, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// ── Widget ──────────────────────────────────────────────────────────────
export interface RegimeRibbonWidget {
  el: HTMLDivElement;
  /**
   * Renders (or hides, when result is null) the ribbon for the displayed read.
   * infoVisible controls only the numbers (confidence, ADX, ATR) and the
   * "advisory" tag. The dot and label stay, because they are the chart-visual
   * button. The "Suggest" button is gated by visibility, not by infoVisible.
   * isApplied marks models already on the chart; they are never suggested.
   */
  update(result: RegimeResult | null, onApply: (indicatorName: string) => void, infoVisible: boolean, isApplied?: (indicatorName: string) => boolean): void;
  /** Reflects whether the chart visual is on. */
  setVisualOn(on: boolean): void;
}

export function createRegimeRibbon(onToggleVisual: () => void = () => {}): RegimeRibbonWidget {
  const el = document.createElement('div');
  el.id = 'regime-ribbon';
  Object.assign(el.style, {
    position: 'absolute', top: '0', left: '0', right: '0', height: '26px',
    display: 'none', alignItems: 'center', gap: '10px', padding: '0 12px',
    fontSize: '10px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.75)',
    background: 'linear-gradient(180deg, rgba(12,12,28,0.85), rgba(12,12,28,0.5) 75%, transparent)',
    borderBottom: '1px solid rgba(180,140,255,0.08)',
    // Must stack ABOVE the unified 3D scene canvas (three-viz-canvas, z-index
    // 10) that fills #chart-area. At the old z-index 5 the 3D takeover covered
    // the header bar completely, making it look like 3D mode removed it.
    zIndex: '12', pointerEvents: 'none',
  });

  // The dot and label are the chart-visual button: a click turns the regime
  // fog on or off over the bars.
  const visualBtn = document.createElement('button');
  visualBtn.id = 'regime-visual-toggle';
  visualBtn.type = 'button';
  visualBtn.setAttribute('aria-pressed', 'false');
  Object.assign(visualBtn.style, {
    display: 'flex', alignItems: 'center', gap: '7px', padding: '2px 8px',
    border: '1px solid transparent', borderRadius: '5px', background: 'transparent',
    color: 'inherit', font: 'inherit', cursor: 'pointer', pointerEvents: 'auto',
    transition: 'background 0.3s ease, border-color 0.3s ease',
  });
  visualBtn.addEventListener('click', () => onToggleVisual());

  const dot = document.createElement('span');
  Object.assign(dot.style, {
    width: '7px', height: '7px', borderRadius: '50%', flexShrink: '0',
    transition: 'background 0.6s ease, box-shadow 0.6s ease',
  });

  const label = document.createElement('span');
  label.style.fontWeight = '700';
  label.style.letterSpacing = '0.5px';
  label.style.transition = 'color 0.6s ease';

  visualBtn.appendChild(dot);
  visualBtn.appendChild(label);

  // The numbers and the advisory tag. The Regime readout toggle hides these.
  const detailGroup = document.createElement('span');
  Object.assign(detailGroup.style, { display: 'flex', alignItems: 'center', gap: '10px' });

  const confidenceEl = document.createElement('span');
  confidenceEl.style.color = 'rgba(255,255,255,0.4)';

  const advisoryTag = document.createElement('span');
  advisoryTag.textContent = 'advisory';
  Object.assign(advisoryTag.style, {
    color: 'rgba(255,255,255,0.25)', fontSize: '9px', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '3px', padding: '0 4px',
  });
  advisoryTag.title = 'Regime Ribbon never applies anything automatically — it only suggests.';

  detailGroup.appendChild(confidenceEl);
  detailGroup.appendChild(advisoryTag);

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

  el.appendChild(visualBtn);
  el.appendChild(detailGroup);
  el.appendChild(suggestBtn);
  el.appendChild(cycleBtn);

  let currentOnApply: ((name: string) => void) | null = null;
  let currentIsApplied: (name: string) => boolean = () => false;
  let currentSuggestion = '';
  let lastResult: RegimeResult | null = null;
  let shown: RegimeResult | null = null;
  let visualOn = false;
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

  function paintVisual(): void {
    const color = shown ? REGIME_COLORS[shown.regime] : '';
    visualBtn.setAttribute('aria-pressed', String(visualOn));
    visualBtn.style.background = visualOn && shown ? `${color}26` : 'transparent';
    visualBtn.style.borderColor = visualOn && shown ? color : 'transparent';
    visualBtn.title = visualOn && shown
      ? `Regime visual on: each stretch of bars is fogged in its regime's colour. Click to turn it off.`
      : 'Regime visual: fogs each stretch of bars in its regime\'s colour, denser when the read is stronger. Click to turn it on.';
  }

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
    shown = result;
    if (!result) {
      el.style.display = 'none';
      paintVisual();
      return;
    }
    el.style.display = 'flex';
    detailGroup.style.display = infoVisible ? 'flex' : 'none';
    const color = REGIME_COLORS[result.regime];
    dot.style.background = color;
    dot.style.boxShadow = `0 0 6px ${color}`;
    label.textContent = REGIME_LABELS[result.regime];
    label.style.color = color;
    confidenceEl.textContent = `${Math.round(result.confidence * 100)}% · ADX ${result.adx.toFixed(0)} · ATR×${result.atrRatio.toFixed(2)}`;
    if (result.regime !== lastRegime) { lastRegime = result.regime; cycleIndex = 0; }
    lastResult = result;
    paintVisual();
    renderSuggestion();
  }

  function setVisualOn(on: boolean): void {
    visualOn = on;
    paintVisual();
  }

  return { el, update, setVisualOn };
}
