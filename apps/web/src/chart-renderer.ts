import type { BaseBar, VolumeBin, VolumeProfileMode } from '@dafe/types';
import type { BarType, PerBarVolume } from './data-generator';
import type { OakPlot } from './oakscript';
import type { VPComputed, VPColorTheme } from './volume-profile';
import { resolveImage } from './image-cache';
import { signalColors } from './accessibility';
import { resolveTheme } from './theme-engine';

export type PerfMode = 'low' | 'medium' | 'high' | 'ultra';
let _perf: PerfMode = 'high';
export function setPerfMode(mode: PerfMode) { _perf = mode; }
export function perfLevel(): PerfMode { return _perf; }
/** Returns shadowBlur scaled by performance: ultra=1x, high=0.7x, medium=0.3x, low=0 */
export function perfShadow(base: number): number {
  return _perf === 'ultra' ? base * 1.3 : _perf === 'high' ? base : _perf === 'medium' ? base * 0.3 : 0;
}
/** Whether to use gradients (false for low/medium) */
export function perfGradient(): boolean { return _perf === 'high' || _perf === 'ultra'; }

function hexToRgb(hex: string): string | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : null;
}

function compactVol(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(0) + 'K';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toString();
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function hexToRgba(hex: string, a: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

function lighten(hex: string, factor: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgb(${Math.min(255, Math.round(c.r * factor))},${Math.min(255, Math.round(c.g * factor))},${Math.min(255, Math.round(c.b * factor))})`;
}

function darken(hex: string, factor: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgb(${Math.round(c.r * factor)},${Math.round(c.g * factor)},${Math.round(c.b * factor)})`;
}

// TradingView-style view model: fixed pixels-per-bar, right-anchored.
export interface ViewState {
  barSpacing: number;   // pixels per bar slot (zoom). Larger = more zoomed in.
  scrollX: number;      // bars scrolled back from the latest bar (0 = latest anchored at right)
  offsetY: number;      // vertical pixel pan
  scaleY: number;       // vertical zoom multiplier
}

// Layout constants
export const RIGHT_MARGIN = 64;   // reserved space on the right (price axis + breathing room)
export const TOP_FRAC = 0.06;     // top of price area as fraction of canvas height
export const BOT_FRAC = 0.88;     // bottom of price area as fraction of canvas height
export const MIN_BAR_SPACING = 1.5;
export const MAX_BAR_SPACING = 64;
export const DEFAULT_BAR_SPACING = 8;

/** Right edge of the plotting area (before the price axis margin). */
export function chartRight(width: number): number {
  return width - RIGHT_MARGIN;
}

/** Number of bar slots that fit in the plotting area (plus a small buffer). */
export function visibleBarCount(view: ViewState, width: number): number {
  return Math.max(1, Math.floor(chartRight(width) / Math.max(0.5, view.barSpacing)) + 2);
}

/**
 * CSS-pixel ("logical") size of a canvas — every layout/positioning
 * calculation in this file and its callers (iso3d.ts, drawings.ts) is
 * meant to operate in this space. Use this instead of reading the canvas's
 * width/height off ctx.canvas directly: once the backing store is scaled by
 * devicePixelRatio for sharpness (see main.ts's resize()), canvas.width
 * stops being the on-screen size, and layout math built on it would
 * silently double-count the DPR scale factor (bars rendered at a fraction
 * of their intended size, hit-testing offset from what's drawn, etc.).
 * clientWidth/clientHeight read the actual rendered CSS box instead, so
 * they stay correct regardless of backing-store resolution.
 */
export function logicalSize(ctx: CanvasRenderingContext2D): { width: number; height: number } {
  return { width: ctx.canvas.clientWidth, height: ctx.canvas.clientHeight };
}

export function getVisibleRange(view: ViewState, canvasWidth: number, totalBars: number): { start: number; end: number } {
  if (totalBars === 0) return { start: 0, end: -1 };
  const count = visibleBarCount(view, canvasWidth);
  const end = Math.min(totalBars - 1, Math.max(0, totalBars - 1 - Math.floor(Math.max(0, view.scrollX))));
  const start = Math.max(0, end - count + 1);
  return { start, end };
}

/** Map a visible-local index (0..vLen-1) to a pixel x-coordinate, right-anchored. */
export function barX(localIdx: number, visibleLen: number, width: number, barSpacing: number, scrollX: number = 0): number {
  const right = chartRight(width);
  const subBarOffset = scrollX >= 0 ? (scrollX - Math.floor(scrollX)) : -scrollX;
  return right - (visibleLen - 1 - localIdx + subBarOffset) * barSpacing;
}

/** Shared price → y mapping so bars, grid, and indicator overlays stay aligned. */
export function priceToY(price: number, minP: number, pRange: number, height: number, view: ViewState): number {
  const cTop = height * TOP_FRAC;
  const cBot = height * BOT_FRAC;
  const cH = (cBot - cTop) * (view.scaleY || 1);
  const pr = Math.max(pRange, 1e-9);
  return cBot - ((price - minP) / pr) * cH + (view.offsetY || 0);
}

/**
 * Shared rich-series renderer for OakScript plot() output.
 * Honors per-bar colors and PineScript-style render styles so users can
 * combine/layer/manipulate plots into expressive indicators.
 */
export interface RichPoint { x: number; y: number; value: number; color: string }
export function renderRichSeries(
  ctx: CanvasRenderingContext2D,
  pts: RichPoint[],
  opts: { style: string; linewidth: number; baselineY: number; barSpacing: number; glow?: boolean },
): void {
  if (pts.length === 0) return;
  const { style, linewidth: lw, baselineY, barSpacing } = opts;
  const glow = opts.glow !== false;
  const colorsUniform = pts.every(p => p.color === pts[0].color);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (style === 'histogram' || style === 'columns') {
    const bw = Math.max(1, barSpacing * 0.7);
    for (const p of pts) {
      ctx.fillStyle = p.color;
      const top = Math.min(p.y, baselineY), h = Math.abs(p.y - baselineY);
      ctx.fillRect(p.x - bw / 2, top, bw, Math.max(1, h));
    }
    return;
  }
  if (style === 'circles') {
    for (const p of pts) { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, lw + 1.5, 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  if (style === 'cross') {
    ctx.lineWidth = lw + 0.5;
    for (const p of pts) {
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y);
      ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + 4); ctx.stroke();
    }
    return;
  }
  if (pts.length < 2) return;
  const stepped = style === 'stepline';

  // Build the polyline once (stepped or straight).
  const line = (): void => {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) {
      if (stepped) ctx.lineTo(pts[k].x, pts[k - 1].y);
      ctx.lineTo(pts[k].x, pts[k].y);
    }
  };

  if (style === 'area') {
    // Fill to baseline using the latest color at low alpha, then stroke on top.
    ctx.beginPath();
    line();
    ctx.lineTo(pts[pts.length - 1].x, baselineY);
    ctx.lineTo(pts[0].x, baselineY);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(pts[pts.length - 1].color, 0.18);
    ctx.fill();
  }

  if (colorsUniform) {
    const col = pts[0].color;
    if (glow) {
      ctx.strokeStyle = col; ctx.lineWidth = lw + 2;
      ctx.shadowBlur = 8; ctx.shadowColor = hexToRgba(col, 0.25);
      ctx.beginPath(); line(); ctx.stroke(); ctx.shadowBlur = 0;
    }
    ctx.strokeStyle = col; ctx.lineWidth = lw;
    ctx.beginPath(); line(); ctx.stroke();
  } else {
    // Per-bar color: stroke each segment in the destination point's color.
    ctx.lineWidth = lw;
    ctx.shadowBlur = 0;
    for (let k = 1; k < pts.length; k++) {
      ctx.strokeStyle = pts[k].color;
      ctx.beginPath();
      ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
      if (stepped) ctx.lineTo(pts[k].x, pts[k - 1].y);
      ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
    }
  }
}

/** Inverse of priceToY — pixel y back to a price. */
export function yToPrice(y: number, minP: number, pRange: number, height: number, view: ViewState): number {
  const cTop = height * TOP_FRAC;
  const cBot = height * BOT_FRAC;
  const cH = (cBot - cTop) * (view.scaleY || 1);
  return minP + ((cBot - (y - (view.offsetY || 0))) / cH) * pRange;
}

/** Visible price range (min + span) for the current view — used by overlays/drawings. */
export function getPriceRange(bars: BaseBar[], view: ViewState, width: number): { minP: number; pRange: number; start: number; vLen: number } {
  const { start, end } = getVisibleRange(view, width, bars.length);
  const endIdx = Math.min(end + 1, bars.length);
  const vLen = Math.max(0, endIdx - start);
  if (vLen === 0) return { minP: 0, pRange: 1, start, vLen: 0 };
  // Single-pass min/max over the visible range instead of slicing the array,
  // flat-mapping into a new [high,low,...] array, and spreading it into
  // Math.min/max twice — this runs every frame via drawBars/xToBarIndex.
  let minP = Infinity, maxP = -Infinity;
  for (let i = start; i < endIdx; i++) {
    const b = bars[i];
    if (b.high > maxP) maxP = b.high;
    if (b.low < minP) minP = b.low;
  }
  return { minP, pRange: (maxP - minP) || 1, start, vLen };
}

/** Pixel x → absolute bar index (may be fractional / out of range). */
export function xToBarIndex(px: number, bars: BaseBar[], view: ViewState, width: number): number {
  const { start, vLen } = getPriceRange(bars, view, width);
  const right = chartRight(width);
  const subBarOffset = view.scrollX >= 0 ? (view.scrollX - Math.floor(view.scrollX)) : -view.scrollX;
  // invert barX: px = right - (vLen - 1 - localIdx + subBarOffset) * bs
  const localIdx = (vLen - 1 + subBarOffset) - (right - px) / view.barSpacing;
  return start + localIdx;
}

// ─── ANIMATED BACKGROUND ───────────────────────────────────────────
let bgPhase = 0;
export function drawBackground(ctx: CanvasRenderingContext2D, time: number): void {
  bgPhase += 0.003;
  const { width, height } = logicalSize(ctx);

  // Richer deep-space gradient
  const grad = ctx.createRadialGradient(width * 0.35, height * 0.25, 0, width * 0.5, height * 0.55, width * 0.9);
  grad.addColorStop(0, '#1d1840');
  grad.addColorStop(0.35, '#0f0b24');
  grad.addColorStop(0.75, '#070415');
  grad.addColorStop(1, '#020105');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle starfield — reduced stars for performance
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const starSeed = 54321;
  const pseudo = (n: number) => {
    const x = Math.sin(starSeed + n) * 10000;
    return x - Math.floor(x);
  };
  const starCount = _perf === 'low' ? 0 : _perf === 'medium' ? 40 : 100;
  for (let i = 0; i < starCount; i++) {
    const sx = pseudo(i * 2) * width;
    const sy = pseudo(i * 3) * height;
    const twinkle = 0.25 + 0.3 * Math.sin(time * 0.0012 + i * 0.9);
    ctx.fillStyle = `rgba(255,255,255,${twinkle})`;
    ctx.beginPath(); ctx.arc(sx, sy, 0.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // Floating dot lattice — skip in low/medium perf
  if (_perf === 'high' || _perf === 'ultra') {
    const spacing = 48;
    ctx.fillStyle = `rgba(180, 140, 255, ${0.03 + Math.sin(time * 0.001) * 0.012})`;
    for (let x = 0; x < width; x += spacing) {
      for (let y = 0; y < height; y += spacing) {
        const r = 0.5 + Math.sin(x * 0.08 + y * 0.08 + time * 0.0004) * 0.25;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // Soft top/bottom sheen
  const sg = ctx.createLinearGradient(0, 0, 0, height);
  sg.addColorStop(0, 'rgba(180,140,255,0.04)');
  sg.addColorStop(0.5, 'rgba(180,140,255,0)');
  sg.addColorStop(1, 'rgba(34,204,136,0.03)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, width, height);
}

// ─── TIME AXIS LABELS ──────────────────────────────────────────────
export function drawTimeAxis(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, timeframe?: string): void {
  const { width, height } = logicalSize(ctx);
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  const vLen = visible.length;
  if (vLen === 0) return;
  const chartBot = height * BOT_FRAC;
  const targetLabels = Math.max(3, Math.floor(chartRight(width) / 90));
  const step = Math.max(1, Math.floor(vLen / targetLabels));
  const isDaily = timeframe === '1d' || timeframe === '1w';
  const isHourly = timeframe === '1h' || timeframe === '4h';
  ctx.font = '10px "Inter", monospace';
  // Axis baseline
  ctx.strokeStyle = 'rgba(180,140,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, chartBot); ctx.lineTo(chartRight(width), chartBot); ctx.stroke();
  for (let i = 0; i < vLen; i += step) {
    const bar = visible[i];
    const x = barX(i, vLen, width, view.barSpacing, view.scrollX);
    if (x < 8 || x > chartRight(width) - 8) continue;
    const d = new Date(bar.timestamp);
    let label: string;
    if (isDaily) label = `${d.getMonth()+1}/${d.getDate()}`;
    else if (isHourly) label = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}h`;
    else label = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    ctx.fillStyle = 'rgba(180, 140, 255, 0.25)';
    ctx.fillRect(x, chartBot, 1, 8);
    ctx.fillStyle = 'rgba(200, 180, 255, 0.75)';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, chartBot + 18);
  }
  ctx.textAlign = 'left';
  // Y-axis right border
  ctx.strokeStyle = 'rgba(180,140,255,0.12)';
  ctx.beginPath(); ctx.moveTo(chartRight(width), height * TOP_FRAC); ctx.lineTo(chartRight(width), chartBot); ctx.stroke();
}

// ─── GLOWING GRID ───────────────────────────────────────────────────
// Pre-allocated price array to avoid per-frame allocations
const _gridPrices: number[] = [];
export function drawGrid(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, time: number): void {
  const { width, height } = logicalSize(ctx);
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  if (visible.length === 0) return;

  // Reuse pre-allocated array
  _gridPrices.length = 0;
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    _gridPrices.push(b.high, b.low);
  }
  const minP = _gridPrices.reduce((a, b) => a < b ? a : b, Infinity);
  const maxP = _gridPrices.reduce((a, b) => a > b ? a : b, -Infinity);
  const range = maxP - minP || 1;
  const lines = 8;
  const right = chartRight(width);

  ctx.lineWidth = 0.5;
  const glow = `rgba(180, 140, 255, ${0.07 + Math.sin(time * 0.0008) * 0.025})`;

  for (let i = 0; i <= lines; i++) {
    const price = minP + (range * i) / lines;
    const y = priceToY(price, minP, range, height, view);
    const isMajor = i % 2 === 0;

    // Base grid line
    ctx.strokeStyle = isMajor ? 'rgba(180, 140, 255, 0.10)' : 'rgba(180, 140, 255, 0.05)';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(right, y); ctx.stroke();

    // Glowing overlay on major lines
    if (isMajor) {
      ctx.strokeStyle = glow;
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(180,140,255,0.15)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Price label on the right axis — dynamic decimals for forex/crypto
    const dec = price >= 1000 ? 0 : price >= 10 ? 2 : price >= 1 ? 3 : 4;
    ctx.fillStyle = isMajor ? 'rgba(200, 180, 255, 0.85)' : 'rgba(180, 140, 255, 0.5)';
    ctx.font = '10px "Inter", monospace';
    // Label background for readability
    const txt = price.toFixed(dec);
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(10,10,24,0.85)';
    ctx.fillRect(right + 2, y - 8, tw + 8, 12);
    ctx.fillStyle = isMajor ? 'rgba(200, 180, 255, 0.95)' : 'rgba(180, 140, 255, 0.65)';
    ctx.fillText(txt, right + 6, y + 3);
  }

  // Vertical time-grid lines with subtle glow
  const vLen = visible.length;
  const bs = view.barSpacing;
  const targetLabels = Math.max(2, Math.floor(right / 140));
  const step = Math.max(1, Math.floor(vLen / targetLabels));
  ctx.strokeStyle = 'rgba(180,140,255,0.04)';
  ctx.shadowBlur = 4;
  ctx.shadowColor = 'rgba(180,140,255,0.08)';
  for (let i = 0; i < vLen; i += step) {
    const x = barX(i, vLen, width, bs, view.scrollX);
    ctx.beginPath(); ctx.moveTo(x, height * TOP_FRAC); ctx.lineTo(x, height * BOT_FRAC); ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

// ─── BAR RENDERER ──────────────────────────────────────────────────
// Pre-allocated arrays to reduce GC pressure per frame
const _barPrices: number[] = [];
export function drawBars(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, time: number, barType: BarType, perBarVol?: PerBarVolume[], barColorOverrides?: Map<number, string>): void {
  const { width, height } = logicalSize(ctx);
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  if (visible.length === 0) return;

  _barPrices.length = 0;
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    _barPrices.push(b.high, b.low);
  }
  let minP = Infinity, maxP = -Infinity;
  for (let i = 0; i < _barPrices.length; i++) {
    if (_barPrices[i] < minP) minP = _barPrices[i];
    if (_barPrices[i] > maxP) maxP = _barPrices[i];
  }
  const pRange = maxP - minP || 1;
  const bs = view.barSpacing;
  const cW = Math.max(1, bs * 0.7);
  const hW = cW / 2;
  const vLen = visible.length;
  const right = chartRight(width);

  ctx.save();

  for (let i = 0; i < vLen; i++) {
    const bar = visible[i];
    const x = barX(i, vLen, width, bs, view.scrollX);
    if (x < -bs || x > right + bs) continue; // cull off-screen
    const oy = priceToY(bar.open, minP, pRange, height, view);
    const cy = priceToY(bar.close, minP, pRange, height, view);
    const hy = priceToY(bar.high, minP, pRange, height, view);
    const ly = priceToY(bar.low, minP, pRange, height, view);
    const isBull = bar.close >= bar.open;
    const intensity = Math.min(1, bar.volume / 3000);
    const bTop = Math.min(oy, cy);
    const bBot = Math.max(oy, cy);
    const bH = Math.max(2.5, bBot - bTop);
    // barcolor() override for this bar, keyed by its absolute index into
    // `bars` (same indexing convention as perBarVol above). Additive only —
    // undefined/missing map leaves every existing up/down color path untouched.
    const overrideColor = barColorOverrides?.get(i + start);

    // Per-bar volume profile (2D-Per-Bar mode VPI)
    if (perBarVol && perBarVol[i + start]) {
      const pv = perBarVol[i + start];
      if (pv.maxVol > 0) {
        const theme = resolveTheme();
        const minVol = pv.maxVol * 0.05; // skip levels below 5% of max
        for (const level of pv.levels) {
          if (level.volume < minVol) continue;
          const lx = priceToY(level.price, minP, pRange, height, view);
          const volW = (level.volume / pv.maxVol) * hW * 0.8;
          if (volW < 0.5 || isNaN(volW)) continue;
          const ratio = level.buyVol / Math.max(level.volume, 0.001);
          ctx.fillStyle = ratio > 0.5
            ? `rgba(${theme.bullRgb}, ${0.08 + (level.volume / pv.maxVol) * 0.15})`
            : `rgba(${theme.bearRgb}, ${0.06 + (level.volume / pv.maxVol) * 0.12})`;
          ctx.fillRect(x - hW - volW, lx - 1, volW, 2);
          ctx.fillRect(x + hW, lx - 1, volW, 2);
        }
      }
    }

    switch (barType) {
      case 'line': drawLineBar(ctx, x, cy, visible, i, vLen, minP, pRange, height, view, bs, width); break;
      case 'area': drawAreaBar(ctx, x, cy, visible, i, vLen, minP, pRange, height, view, bs, width); break;
      case 'renko': drawRenkoBar(ctx, x, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity, overrideColor); break;
      case 'kagi': drawKagiBar(ctx, x, hy, ly, bar, isBull, visible, i, vLen, minP, pRange, height, view, bs, width, overrideColor); break;
      case 'footprint': drawFootprintBar(ctx, x, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity, perBarVol?.[i + start], overrideColor); break;
      case 'imbalance-bar': drawImbalanceBar(ctx, x, oy, cy, hy, ly, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity, perBarVol?.[i + start], overrideColor); break;
      case 'range-bar': case 'volume-bar': case 'tick-bar': case 'dollar-bar':
        drawOHLCBar(ctx, x, oy, cy, hy, ly, cW, hW, bar, isBull, time, intensity, overrideColor);
        break;
      default: drawStandardCandle(ctx, x, oy, cy, hy, ly, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity, overrideColor); break;
    }
  }
  ctx.restore();
}

// Classic OHLC bar: thin vertical line with open-tick (left) and close-tick
// (right), direction-colored. Distinct visual identity for range/volume/tick/
// dollar bar types so they no longer look like plain candles.
function drawOHLCBar(ctx: CanvasRenderingContext2D, x: number, oy: number, cy: number, hy: number, ly: number,
  cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number, overrideColor?: string): void {
  const theme = resolveTheme();
  const overrideRgb = overrideColor ? hexToRgb(overrideColor) : null;
  const rgb = overrideRgb || (isBull ? theme.bullRgb : theme.bearRgb);
  const col = `rgba(${rgb},0.95)`;
  const glowCol = isBull ? `rgba(${theme.bullRgb},0.35)` : `rgba(${theme.bearRgb},0.35)`;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = col;
  ctx.shadowBlur = 8 + intensity * 8;
  ctx.shadowColor = glowCol;

  // Stem
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();

  // Open tick (left), close tick (right)
  const tickW = Math.max(2.5, cW * 0.5);
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(x - hW, oy); ctx.lineTo(x - hW + tickW, oy);
  ctx.moveTo(x + hW - tickW, cy); ctx.lineTo(x + hW, cy);
  ctx.stroke();

  // High-volume flare
  if (intensity > 0.3) {
    ctx.globalAlpha = 0.2 + intensity * 0.25;
    ctx.lineWidth = 6;
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
  }
  ctx.restore();
}

function drawStandardCandle(ctx: CanvasRenderingContext2D, x: number, oy: number, cy: number, hy: number, ly: number,
  bTop: number, bBot: number, bH: number, cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number, overrideColor?: string): void {
  const theme = resolveTheme();
  const bullCol = theme.bull;
  const bearCol = theme.bear;
  const color = isBull ? bullCol : bearCol;
  // barcolor() override: same RGB triple used for both directions when present,
  // substituted into the existing isBull-branched literals below (structure unchanged).
  const overrideRgb = overrideColor ? hexToRgb(overrideColor) : null;
  const rgbBull = overrideRgb || theme.bullRgb;
  const rgbBear = overrideRgb || theme.bearRgb;

  // Wick — bold with rounded ends
  ctx.shadowBlur = 10;
  ctx.shadowColor = isBull ? `rgba(${rgbBull},0.45)` : `rgba(${rgbBear},0.45)`;
  ctx.strokeStyle = isBull ? `rgba(${rgbBull},0.95)` : `rgba(${rgbBear},0.95)`;
  ctx.lineWidth = 3.6;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
  ctx.lineCap = 'butt';

  // Body gradient fill
  ctx.shadowBlur = 10 + intensity * 12;
  ctx.shadowColor = isBull ? `rgba(${rgbBull},${0.25 + intensity * 0.35})` : `rgba(${rgbBear},${0.25 + intensity * 0.35})`;
  const g = ctx.createLinearGradient(0, bTop, 0, bBot);
  if (isBull) {
    g.addColorStop(0, `rgba(${rgbBull},${0.75 + intensity * 0.25})`);
    g.addColorStop(0.5, `rgba(${rgbBull},${0.45 + intensity * 0.25})`);
    g.addColorStop(1, `rgba(${rgbBull},${0.15 + intensity * 0.15})`);
  } else {
    g.addColorStop(0, `rgba(${rgbBear},${0.7 + intensity * 0.25})`);
    g.addColorStop(0.5, `rgba(${rgbBear},${0.4 + intensity * 0.25})`);
    g.addColorStop(1, `rgba(${rgbBear},${0.12 + intensity * 0.12})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(x - hW, bTop, cW, bH);

  // Thin right-edge black definition line
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 1.0;
  ctx.beginPath(); ctx.moveTo(x + hW, bTop); ctx.lineTo(x + hW, bBot); ctx.stroke();

  // Soft inner highlight on the left edge
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(x - hW + 0.5, bTop); ctx.lineTo(x - hW + 0.5, bBot); ctx.stroke();
}

function drawLineBar(ctx: CanvasRenderingContext2D, x: number, cy: number, visible: BaseBar[], i: number, vLen: number,
  minP: number, pRange: number, height: number, view: ViewState, bs: number, width: number): void {
  if (i > 0) {
    const prev = visible[i - 1];
    if (!prev) return;
    const px = barX(i - 1, vLen, width, bs, view.scrollX);
    const py = priceToY(prev.close, minP, pRange, height, view);
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 6;
    ctx.shadowColor = 'rgba(100, 200, 255, 0.2)';
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, cy); ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
  ctx.beginPath(); ctx.arc(x, cy, 2, 0, Math.PI * 2); ctx.fill();
}

function drawAreaBar(ctx: CanvasRenderingContext2D, x: number, cy: number, visible: BaseBar[], i: number, vLen: number,
  minP: number, pRange: number, height: number, view: ViewState, bs: number, width: number): void {
  const cBot = height * BOT_FRAC;
  drawLineBar(ctx, x, cy, visible, i, vLen, minP, pRange, height, view, bs, width);
  if (i > 0) {
    const px = barX(i - 1, vLen, width, bs, view.scrollX);
    const prevBar = visible[i - 1];
    if (!prevBar) return;
    const py = priceToY(prevBar.close, minP, pRange, height, view);
    ctx.fillStyle = 'rgba(100, 200, 255, 0.06)';
    ctx.beginPath();
    ctx.moveTo(px, cBot); ctx.lineTo(px, py);
    ctx.lineTo(x, cy); ctx.lineTo(x, cBot);
    ctx.closePath(); ctx.fill();
  }
}

function drawRenkoBar(ctx: CanvasRenderingContext2D, x: number, bTop: number, bBot: number, bH: number,
  cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number, overrideColor?: string): void {
  const theme = resolveTheme();
  const overrideRgb = overrideColor ? hexToRgb(overrideColor) : null;
  const bullRgb = theme.bullRgb;
  const bearRgb = theme.bearRgb;
  ctx.shadowBlur = 6;
  ctx.shadowColor = overrideRgb ? `rgba(${overrideRgb}, 0.3)` : (isBull ? `rgba(${bullRgb}, 0.3)` : `rgba(${bearRgb}, 0.3)`);
  ctx.fillStyle = overrideRgb
    ? `rgba(${overrideRgb}, ${(isBull ? 0.5 : 0.4) + intensity * 0.3})`
    : isBull
      ? `rgba(${bullRgb}, ${0.5 + intensity * 0.3})`
      : `rgba(${bearRgb}, ${0.4 + intensity * 0.3})`;
  ctx.fillRect(x - hW * 0.6, bTop, cW * 0.6, bH);
}

function drawKagiBar(ctx: CanvasRenderingContext2D, x: number, hy: number, ly: number, bar: BaseBar, isBull: boolean,
  visible: BaseBar[], i: number, vLen: number, minP: number, pRange: number, height: number, view: ViewState, bs: number, width: number, overrideColor?: string): void {
  const theme = resolveTheme();
  const lineW = isBull ? 3 : 1;
  const overrideRgb = overrideColor ? hexToRgb(overrideColor) : null;
  const bullRgb = theme.bullRgb;
  const bearRgb = theme.bearRgb;
  ctx.strokeStyle = overrideRgb ? `rgba(${overrideRgb}, ${isBull ? 0.7 : 0.5})` : (isBull ? `rgba(${bullRgb}, 0.7)` : `rgba(${bearRgb}, 0.5)`);
  ctx.lineWidth = lineW;
  ctx.shadowBlur = 4;
  ctx.shadowColor = overrideRgb ? `rgba(${overrideRgb}, ${isBull ? 0.2 : 0.15})` : (isBull ? `rgba(${bullRgb}, 0.2)` : `rgba(${bearRgb}, 0.15)`);
  ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
  ctx.shadowBlur = 0;
  if (i > 0) {
    const px = barX(i - 1, vLen, width, bs, view.scrollX);
    ctx.strokeStyle = 'rgba(180, 140, 255, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(px, hy); ctx.lineTo(x, hy); ctx.stroke();
  }
}

function drawFootprintBar(ctx: CanvasRenderingContext2D, x: number, bTop: number, bBot: number, bH: number,
  cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number, pv?: PerBarVolume, overrideColor?: string): void {
  if (!pv || pv.levels.length === 0 || pv.maxVol === 0) {
    drawStandardCandle(ctx, x, (bar.open + bar.high) / 2, (bar.close + bar.low) / 2,
      bar.high, bar.low, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity, overrideColor);
    return;
  }

  const theme = resolveTheme();
  const bullCol = theme.bull;
  const bearCol = theme.bear;
  const bullRgb = theme.bullRgb;
  const bearRgb = theme.bearRgb;
  const barW = cW * 2.8;
  const halfW = barW / 2;
  const levels = pv.levels;
  const levelH = bH / levels.length;

  // Skip levels if too small for text
  const minLevelH = 8;
  const step = levelH < minLevelH ? Math.ceil(minLevelH / levelH) : 1;

  // Bar border — barcolor() override takes precedence over the up/down pick.
  ctx.strokeStyle = overrideColor || (isBull ? bullCol : bearCol);
  ctx.lineWidth = 1;
  ctx.strokeRect(x - halfW, bTop, barW, bH);

  // Draw each price level
  ctx.font = '8px monospace';
  const textBaseline = 'middle';

  for (let j = 0; j < levels.length; j += step) {
    const level = levels[j];
    const ly = bTop + j * levelH;
    const ratio = level.buyVol / Math.max(level.volume, 0.001);
    const isBuyDom = ratio > 0.5;

    // Level background
    const alpha = 0.12 + (level.volume / pv.maxVol) * 0.3;
    ctx.fillStyle = isBuyDom
      ? `rgba(${bullRgb}, ${alpha})`
      : `rgba(${bearRgb}, ${alpha})`;
    ctx.fillRect(x - halfW + 1, ly, barW - 2, levelH - 1);

    // Volume text: sellVol | buyVol
    if (levelH >= 7) {
      const textY = ly + levelH / 2;
      const sellTxt = compactVol(level.sellVol);
      const buyTxt = compactVol(level.buyVol);

      ctx.textAlign = 'right';
      ctx.fillStyle = `rgba(${bearRgb}, ${0.6 + ratio * 0.4})`;
      ctx.fillText(sellTxt, x - 2, textY);

      ctx.textAlign = 'left';
      ctx.fillStyle = `rgba(${bullRgb}, ${0.6 + (1 - ratio) * 0.4})`;
      ctx.fillText(buyTxt, x + 2, textY);
    }
  }

  // Delta at bottom
  const delta = pv.levels.reduce((s, l) => s + l.buyVol - l.sellVol, 0);
  if (bH >= 18) {
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = delta >= 0 ? bullCol : bearCol;
    const dTxt = (delta >= 0 ? '+' : '') + compactVol(Math.abs(delta));
    ctx.fillText('Δ' + dTxt, x, bBot - 3);
  }
}

function drawImbalanceBar(ctx: CanvasRenderingContext2D, x: number, oy: number, cy: number, hy: number, ly: number,
  bTop: number, bBot: number, bH: number, cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number, pv?: PerBarVolume, overrideColor?: string): void {
  const theme = resolveTheme();
  const bullCol = theme.bull;
  const bearCol = theme.bear;
  const color = overrideColor || (isBull ? bullCol : bearCol);
  const overrideRgb = overrideColor ? hexToRgb(overrideColor) : null;
  const bullRgb = theme.bullRgb;
  const bearRgb = theme.bearRgb;

  // Wicks
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, hy);
  ctx.lineTo(x, bTop);
  ctx.moveTo(x, bBot);
  ctx.lineTo(x, ly);
  ctx.stroke();

  // Body — thicker when higher volume intensity
  const bodyW = cW * (1 + intensity * 0.5);
  const bodyGrad = ctx.createLinearGradient(x - bodyW, bTop, x + bodyW, bTop);
  const rgb = overrideRgb || (isBull ? bullRgb : bearRgb);
  bodyGrad.addColorStop(0, `rgba(${rgb}, 0.15)`);
  bodyGrad.addColorStop(0.5, `rgba(${rgb}, ${0.4 + intensity * 0.4})`);
  bodyGrad.addColorStop(1, `rgba(${rgb}, 0.15)`);
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(x - bodyW, bTop, bodyW * 2, bH);

  // Imbalance glow — stronger when more volume
  if (pv && pv.maxVol > 0) {
    const delta = pv.levels.reduce((s, l) => s + l.buyVol - l.sellVol, 0);
    const totalVol = pv.levels.reduce((s, l) => s + l.volume, 0);
    const imbRatio = totalVol > 0 ? Math.abs(delta) / totalVol : 0;
    if (imbRatio > 0.3) {
      ctx.shadowBlur = 8 + imbRatio * 12;
      ctx.shadowColor = delta > 0 ? `${bullCol}66` : `${bearCol}66`;
      ctx.fillStyle = delta > 0 ? `${bullCol}22` : `${bearCol}22`;
      ctx.fillRect(x - bodyW - 2, bTop - 1, bodyW * 2 + 4, bH + 2);
      ctx.shadowBlur = 0;
    }

    // Per-level volume overlay (compact, like footprint but subtler)
    const levels = pv.levels;
    const levelH = bH / levels.length;
    const minLevelH = 10;
    const step = levelH < minLevelH ? Math.ceil(minLevelH / levelH) : 1;
    ctx.font = '7px monospace';
    for (let j = 0; j < levels.length; j += step) {
      const level = levels[j];
      const lvlY = bTop + j * levelH;
      const ratio = level.buyVol / Math.max(level.volume, 0.001);
      const isBuyDom = ratio > 0.5;
      const alpha = 0.08 + (level.volume / pv.maxVol) * 0.18;
      ctx.fillStyle = isBuyDom ? `rgba(${bullRgb},${alpha})` : `rgba(${bearRgb},${alpha})`;
      ctx.fillRect(x - bodyW, lvlY, bodyW * 2, levelH - 1);
      if (levelH >= 9) {
        ctx.textAlign = 'right';
        ctx.fillStyle = `rgba(${bearRgb},0.5)`;
        ctx.fillText(compactVol(level.sellVol), x - 2, lvlY + levelH / 2);
        ctx.textAlign = 'left';
        ctx.fillStyle = `rgba(${bullRgb},0.5)`;
        ctx.fillText(compactVol(level.buyVol), x + 2, lvlY + levelH / 2);
      }
    }
  }

  // Body outline
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - bodyW, bTop, bodyW * 2, bH);
}

// ─── VOLUME PROFILE ────────────────────────────────────────────────
let volPulse = 0;
/** Optional live alignment: map bins through the chart's current price→Y transform
 *  so the profile tracks pan/zoom exactly like the candles instead of sitting in a
 *  fixed panel space. minP/pRange come from getPriceRange() over the visible slice. */
export interface VPAlign { minP: number; pRange: number; view: ViewState; }
export function drawVolumeProfile(ctx: CanvasRenderingContext2D, bins: VolumeBin[], mode: VolumeProfileMode, time: number, vp?: VPComputed, profileWidth = 86, align?: VPAlign): void {
  volPulse += 0.02;
  if (bins.length === 0) return;
  const { width, height } = logicalSize(ctx);
  const maxVol = Math.max(...bins.map(b => b.volume));
  if (maxVol === 0) return;
  const cTop = height * 0.05;
  const cArea = height * 0.83;

  if (mode === '2D-Side') {
    const pW = Math.max(50, Math.min(RIGHT_MARGIN - 10, profileWidth));
    const px = width - pW;
    const pulse = Math.sin(volPulse) * 0.06 + 0.06;
    const colors = vp?.colors;
    const bullCol = colors?.bull || 'rgba(34, 204, 136, 1)';
    const bearCol = colors?.bear || 'rgba(255, 68, 119, 1)';
    const pocCol = colors?.poc || '#ffffff';
    const vaFill = colors?.vaFill || 'rgba(65, 105, 225, 0.3)';
    const vaLine = colors?.vaLine || '#4169E1';
    const hvnCol = colors?.hvn || '#00FF88';
    const lvnCol = colors?.lvn || '#FF4444';

    // Aligned mode: bins land at their true price levels and move with pan/zoom.
    // Legacy mode: even division across a fixed panel (unchanged for callers that
    // don't pass align).
    const aligned = !!align && align.pRange > 0;
    const yFor = (p: number): number => priceToY(p, align!.minP, align!.pRange, height, align!.view);
    const binnedY = (bin: VolumeBin): { top: number; bot: number } => {
      if (aligned) {
        const top = yFor(bin.high ?? bin.price);
        const bot = yFor(bin.low ?? bin.price);
        return { top, bot };
      }
      const idx = bins.indexOf(bin);
      const bH = cArea / bins.length;
      const top = cTop + idx * bH;
      return { top, bot: top + bH };
    };

    const panelGrad = ctx.createLinearGradient(px, 0, width, 0);
    panelGrad.addColorStop(0, 'rgba(180, 140, 255, 0.03)');
    panelGrad.addColorStop(1, 'rgba(180, 140, 255, 0.06)');
    ctx.fillStyle = panelGrad;
    ctx.fillRect(px, 0, pW, height);

    // Value area background band
    if (vp?.showValueArea && vp.vah !== null && vp.val !== null) {
      const yTop = aligned ? yFor(vp.vah) : (() => {
        const minP = Math.min(...bins.map(b => b.price));
        const maxP = Math.max(...bins.map(b => b.price));
        const pRange = maxP - minP || 1;
        return cTop + ((maxP - vp.vah!) / pRange) * cArea;
      })();
      const yBot = aligned ? yFor(vp.val) : (() => {
        const minP = Math.min(...bins.map(b => b.price));
        const maxP = Math.max(...bins.map(b => b.price));
        const pRange = maxP - minP || 1;
        return cTop + ((maxP - vp.val!) / pRange) * cArea;
      })();
      ctx.fillStyle = vaFill;
      ctx.fillRect(px, Math.min(yTop, yBot), pW, Math.abs(yBot - yTop));
      ctx.strokeStyle = vaLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, yTop); ctx.lineTo(width, yTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, yBot); ctx.lineTo(width, yBot); ctx.stroke();
      ctx.setLineDash([]);
      // VAH / VAL labels
      ctx.fillStyle = vaLine;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`VAH ${vp.vah.toFixed(1)}`, width - 6, yTop - 3);
      ctx.fillText(`VAL ${vp.val.toFixed(1)}`, width - 6, yBot + 10);
      ctx.textAlign = 'left';
    }

    ctx.shadowBlur = 6;
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      const barW = (bin.volume / maxVol) * (pW - 28) + pulse * 3;
      const { top, bot } = binnedY(bin);
      const barH = Math.max(1, bot - top);
      const ratio = bin.buyVolume / Math.max(bin.volume, 0.001);
      const isDominant = ratio > 0.5;
      const intensity = Math.min(1, bin.volume / maxVol);

      ctx.shadowColor = isDominant ? `${bullCol}33` : `${bearCol}33`;
      const grad = ctx.createLinearGradient(px, 0, px + pW, 0);
      const base = isDominant ? bullCol : bearCol;
      const rgb = hexToRgb(base) || (isDominant ? '34,204,136' : '255,68,119');
      grad.addColorStop(0, `rgba(${rgb}, ${0.1 + intensity * 0.5})`);
      grad.addColorStop(1, `rgba(${rgb}, ${0.3 + intensity * 0.7})`);
      ctx.fillStyle = grad;
      ctx.fillRect(px + 4, top, barW, barH - 1);

      // High / low volume node markers
      if (vp?.showNodes) {
        if (vp.highNodes.includes(bin)) {
          ctx.fillStyle = hvnCol;
          ctx.beginPath(); ctx.arc(px + pW - 6, top + barH / 2, 2, 0, Math.PI * 2); ctx.fill();
        } else if (vp.lowNodes.includes(bin) && bin.volume > 0) {
          ctx.fillStyle = lvnCol;
          ctx.beginPath(); ctx.arc(px + pW - 6, top + barH / 2, 1.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.shadowBlur = 0;

    const poc = vp?.poc || bins.reduce((max, b) => b.volume > max.volume ? b : max, bins[0]);
    const pocY = aligned ? yFor(poc.price)
      : (() => {
          const pocIdx = bins.findIndex(b => b.price === poc.price);
          const bH = cArea / bins.length;
          return cTop + (pocIdx >= 0 ? pocIdx : 0) * bH + bH / 2;
        })();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `${pocCol}4d`;
    ctx.strokeStyle = pocCol;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 4, pocY); ctx.lineTo(width, pocY); ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = pocCol;
    ctx.font = '9px monospace';
    ctx.fillText(`POC $${poc.price.toFixed(0)}`, px + 6, pocY - 4);

    ctx.fillStyle = 'rgba(180, 140, 255, 0.15)';
    ctx.font = '7px monospace';
    ctx.fillText('VOL', px + 6, 14);

    // Delta readout
    if (vp?.showDelta) {
      const deltaK = vp.delta / 1000;
      const deltaCol = deltaK >= 0 ? bullCol : bearCol;
      ctx.fillStyle = deltaCol;
      ctx.font = '10px monospace';
      ctx.fillText(`Δ ${deltaK >= 0 ? '+' : ''}${deltaK.toFixed(1)}K`, px + 6, height - 12);
    }

  } else if (mode === '2D-Per-Bar') {
    const theme = resolveTheme();
    const bH = cArea / bins.length;
    const maxW = 28;
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      const barW = (bin.volume / maxVol) * maxW;
      const y = cTop + i * bH;
      const ratio = bin.buyVolume / Math.max(bin.volume, 0.001);
      ctx.fillStyle = ratio > 0.5 ? `rgba(${theme.bullRgb}, ${0.3 + ratio * 0.5})` : `rgba(${theme.bearRgb}, ${0.2 + (1 - ratio) * 0.5})`;
      ctx.fillRect(6, y, barW, bH - 1);
    }
  }
}

// ─── OHLC TOOLTIP ─────────────────────────────────────────────────
export function drawOHLCTooltip(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, mx: number, my: number, barType: BarType): void {
  const { start, end } = getVisibleRange(view, ctx.canvas.clientWidth, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  if (visible.length === 0) return;

  const vLen = visible.length;
  const right = chartRight(ctx.canvas.clientWidth);
  const barIdx = Math.max(0, Math.min(vLen - 1, Math.round(vLen - 1 - (right - mx) / view.barSpacing)));
  const bar = visible[barIdx];

  const lineH = 15;
  const w = 170;
  const h = 7 * lineH + 8;
  const tx = Math.min(mx + 16, ctx.canvas.clientWidth - w - 8);
  const ty = Math.min(my - h / 2, ctx.canvas.clientHeight - h - 8);

  ctx.shadowBlur = 12;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.fillStyle = 'rgba(8, 8, 20, 0.85)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, w, h, 4);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(180, 140, 255, 0.2)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.roundRect(tx, ty, w, h, 4);
  ctx.stroke();

  ctx.font = '10px monospace';
  const d = new Date(bar.timestamp);
  ctx.fillStyle = 'rgba(180, 140, 255, 0.5)';
  ctx.fillText(`${barType.toUpperCase()}  ${d.toLocaleDateString()} ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`, tx + 8, ty + 12);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.fillText(`O: $${bar.open.toFixed(2)}`, tx + 8, ty + 28);
  ctx.fillText(`H: $${bar.high.toFixed(2)}`, tx + 8, ty + 43);
  ctx.fillText(`L: $${bar.low.toFixed(2)}`, tx + 8, ty + 58);
  ctx.fillText(`C: $${bar.close.toFixed(2)}`, tx + 8, ty + 73);
  ctx.fillStyle = 'rgba(34, 204, 136, 0.6)';
  ctx.fillText(`Vol: ${bar.volume.toLocaleString()}`, tx + 8, ty + 88);
}

// ─── TRADE MARKERS (buy/sell fills) ─────────────────────────────────
export interface TradeMarker {
  timestamp: number;
  price: number;
  side: 'buy' | 'sell';
  qty: number;
}

export function drawTradeMarkers(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, markers: TradeMarker[], is3D = false): void {
  if (markers.length === 0) return;
  const { width, height } = logicalSize(ctx);
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  const vLen = visible.length;
  if (vLen === 0) return;

  const all = visible.flatMap(b => [b.high, b.low]);
  const minP = Math.min(...all);
  const maxP = Math.max(...all);
  const pRange = (maxP - minP) || 1;
  const size = Math.max(4, Math.min(9, view.barSpacing * 0.45));
  const right = chartRight(width);
  // In 3D/iso mode, barX() gives the extruded box's left edge (its front face
  // spans barX..barX+bw), not its center like the flat 2D candle — nudge the
  // marker right by half that width so it centers on the front face instead
  // of landing at the box's left edge / visual center of the whole extrusion.
  const isoFrontOffset = is3D ? Math.max(1.2, view.barSpacing * 0.72) / 2 : 0;

  for (const m of markers) {
    // Find the visible bar whose window contains this fill's timestamp.
    let idx = -1;
    for (let i = 0; i < vLen; i++) {
      if (visible[i].timestamp >= m.timestamp) { idx = i; break; }
    }
    if (idx === -1) idx = vLen - 1;
    const x = barX(idx, vLen, width, view.barSpacing, view.scrollX) + isoFrontOffset;
    if (x < -view.barSpacing || x > right + view.barSpacing) continue;
    const bar = visible[idx];
    const isBuy = m.side === 'buy';
    const y = isBuy
      ? priceToY(bar.low, minP, pRange, height, view) + size + 6
      : priceToY(bar.high, minP, pRange, height, view) - size - 6;
    const col = isBuy ? signalColors().bull : signalColors().bear;

    ctx.save();
    ctx.shadowBlur = 6;
    ctx.shadowColor = col;
    ctx.fillStyle = col;
    ctx.beginPath();
    if (isBuy) {
      // Apex up — points toward price, sitting below the bar.
      ctx.moveTo(x, y - size); ctx.lineTo(x - size, y + size); ctx.lineTo(x + size, y + size);
    } else {
      // Apex down — points toward price, sitting above the bar.
      ctx.moveTo(x, y + size); ctx.lineTo(x - size, y - size); ctx.lineTo(x + size, y - size);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (view.barSpacing > 4) {
      ctx.font = '9px monospace';
      ctx.fillStyle = col;
      ctx.textAlign = 'center';
      ctx.fillText(`${isBuy ? 'B' : 'S'} ${m.qty}`, x, isBuy ? y + size + 10 : y - size - 4);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }
}

// ─── CROSSHAIR ─────────────────────────────────────────────────────
export function drawCrosshair(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
  const { width, height } = logicalSize(ctx);
  ctx.save();
  ctx.shadowBlur = 8;
  ctx.shadowColor = 'rgba(180, 140, 255, 0.2)';
  ctx.strokeStyle = 'rgba(180, 140, 255, 0.2)';
  ctx.lineWidth = 0.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, height);
  ctx.moveTo(0, my); ctx.lineTo(width, my);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(180, 140, 255, 0.5)';
  ctx.font = '10px monospace';
  ctx.fillText(`X:${Math.round(mx)} Y:${Math.round(my)}`, mx + 8, my - 6);
  ctx.restore();
}

// ─── ANIMATED PARTICLES ────────────────────────────────────────────
interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number;
}
let particles: Particle[] = [];

export function updateParticles(time: number, width: number, height: number): void {
  if (particles.length < 15 && Math.random() < 0.03) {
    particles.push({
      x: Math.random() * width, y: height + 5,
      vx: (Math.random() - 0.5) * 0.3, vy: -(0.2 + Math.random() * 0.4),
      life: 0, maxLife: 300 + Math.random() * 400, size: 0.5 + Math.random() * 1,
    });
  }
  particles = particles.filter(p => {
    p.x += p.vx; p.y += p.vy; p.life++;
    return p.life < p.maxLife && p.y > -10 && p.x > -10 && p.x < width + 10;
  });
}

export function drawParticles(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  for (const p of particles) {
    const alpha = Math.min(1, (p.maxLife - p.life) / 100) * 0.3;
    ctx.fillStyle = `rgba(180, 140, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── STATUS BAR ────────────────────────────────────────────────────
export function drawStatusBar(ctx: CanvasRenderingContext2D, text: string): void {
  const { width, height } = logicalSize(ctx);
  const grad = ctx.createLinearGradient(0, height - 26, 0, height);
  grad.addColorStop(0, 'rgba(12, 12, 28, 0)');
  grad.addColorStop(0.3, 'rgba(12, 12, 28, 0.8)');
  grad.addColorStop(1, 'rgba(12, 12, 28, 0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, height - 26, width, 26);

  ctx.fillStyle = 'rgba(180, 140, 255, 0.4)';
  ctx.font = '10px monospace';
  ctx.fillText(text, 14, height - 9);
}

// ─── SECONDARY CHART (separate pane for oscillators) ──────────────
export function drawSecondaryChart(ctx: CanvasRenderingContext2D, plots: OakPlot[], bars: BaseBar[], view: ViewState): void {
  const { width, height } = logicalSize(ctx);
  if (height < 20 || plots.length === 0) return;

  // Background
  ctx.fillStyle = '#0a0a18';
  ctx.fillRect(0, 0, width, height);

  // Top border
  ctx.fillStyle = 'rgba(180,140,255,0.06)';
  ctx.fillRect(0, 0, width, 1);

  // Collect all values from separate-pane plots to compute y-range
  const allVals: number[] = [];
  const linePlots = plots.filter(p => (p.type === 'line' || p.type === 'hline') && p.pane === 'separate');
  const hlines = plots.filter(p => p.type === 'hline' && p.pane === 'separate');
  const shapes = plots.filter(p => p.type === 'shape' && p.pane === 'separate');

  for (const p of linePlots) {
    if (p.value !== undefined && p.value !== null && !isNaN(p.value)) allVals.push(p.value);
  }
  for (const p of hlines) {
    if (p.price !== undefined) allVals.push(p.price);
  }

  if (allVals.length < 2) {
    // Draw just a label
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '11px monospace';
    ctx.fillText('Secondary Chart', 10, 16);
    return;
  }

  let minV = Math.min(...allVals);
  let maxV = Math.max(...allVals);
  const vRange = maxV - minV || 1;
  const pad = vRange * 0.1;
  minV -= pad;
  maxV += pad;
  const adjRange = maxV - minV || 1;
  const cTop = 4;
  const cBot = height - 4;
  const cH = cBot - cTop;

  // Grid lines
  const { start, end } = getVisibleRange(view, width, bars.length);
  const vLen = Math.max(1, Math.min(end, bars.length - 1) - Math.max(0, start) + 1);

  // Horizontal grid
  ctx.strokeStyle = 'rgba(180,140,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = cTop + (cH / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    const val = maxV - (adjRange / 4) * i;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '9px monospace';
    ctx.fillText(val.toFixed(1), 4, y - 2);
  }

  // Line plots already have per-bar values in order — reconstruct series
  const lineData = new Map<string, Array<{ idx: number; value: number; color: string }>>();
  const lineStyles = new Map<string, { linewidth: number; style: string }>();

  for (const p of linePlots) {
    if (p.type === 'hline') continue;
    const key = p.name || 'plot';
    if (!lineData.has(key)) {
      lineData.set(key, []);
      lineStyles.set(key, { linewidth: p.linewidth || 1, style: (p as any).style || 'line' });
    }
    const idx = typeof p.barIdx === 'number' ? p.barIdx : lineData.get(key)!.length;
    const val = typeof p.value === 'number' ? p.value : NaN;
    lineData.get(key)!.push({ idx, value: val, color: p.color || '#b48cff' });
  }

  // Baseline for area/histogram in oscillator space (value 0 if visible, else floor).
  const oscBaseY = Math.min(cBot, Math.max(cTop, cBot - ((0 - minV) / adjRange) * cH));

  // Draw line series (per-bar color + render style)
  for (const [name, data] of lineData) {
    if (data.length < 1) continue;
    const st = lineStyles.get(name)!;
    const pts: { x: number; y: number; value: number; color: string }[] = [];
    for (const pt of data) {
      const bar = bars[pt.idx];
      if (!bar || isNaN(pt.value)) continue;
      const idxInView = pt.idx - start;
      if (idxInView < 0 || idxInView >= vLen) continue;
      const x = barX(idxInView, vLen, width, view.barSpacing, view.scrollX);
      const y = cBot - ((pt.value - minV) / adjRange) * cH;
      pts.push({ x, y, value: pt.value, color: pt.color });
    }
    if (pts.length < 1) continue;

    renderRichSeries(ctx, pts, { style: st.style, linewidth: st.linewidth, baselineY: oscBaseY, barSpacing: view.barSpacing });

    // Latest value label
    const last = pts[pts.length - 1];
    const col = last.color;
    const label = `${name} ${last.value.toFixed(1)}`;
    const pad = 4;
    ctx.font = '9px "Inter", monospace';
    const tw = ctx.measureText(label).width + pad * 2;
    const th = 14;
    ctx.fillStyle = 'rgba(8,8,20,0.85)';
    ctx.strokeStyle = hexToRgba(col, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(width - tw - 4, last.y - th / 2, tw, th, 3);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillText(label, width - tw - 4 + pad, last.y + 3);
  }

  // Draw horizontal lines
  for (const p of hlines) {
    if (p.price === undefined) continue;
    const y = cBot - ((p.price - minV) / adjRange) * cH;
    ctx.strokeStyle = p.color || 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.color || 'rgba(255,255,255,0.2)';
    ctx.font = '9px monospace';
    ctx.fillText(String(p.price), 4, y - 2);
  }

  // Draw shape markers
  for (const p of shapes) {
    const y = typeof p.price === 'number' ? cBot - ((p.price - minV) / adjRange) * cH : height / 2;
    const col = p.color || '#b48cff';
    ctx.fillStyle = col;
    ctx.shadowBlur = 6;
    ctx.shadowColor = col + '44';

    // Use barIdx to position the shape at the correct bar
    const idxInView = typeof p.barIdx === 'number' ? p.barIdx - start : -1;
    const x = idxInView >= 0 && idxInView < vLen ? barX(idxInView, vLen, width, view.barSpacing, view.scrollX) : -100;

    if (p.style === 'triangleup') {
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x - 5, y + 3); ctx.lineTo(x + 5, y + 3); ctx.closePath(); ctx.fill();
    } else if (p.style === 'triangledown') {
      ctx.beginPath(); ctx.moveTo(x, y + 8); ctx.lineTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3); ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // Draw label on the left
  if (lineData.size > 0) {
    const firstName = Array.from(lineData.keys())[0];
    const firstPts = lineData.get(firstName)!;
    ctx.fillStyle = firstPts[firstPts.length - 1]?.color || 'rgba(255,255,255,0.3)';
    ctx.font = '9px monospace';
    ctx.fillText(firstName, width - 80, 10);
  }
}

// ─── OAKSCRIPT PLOT RENDERER ──────────────────────────────────────
export function drawOakScriptPlots(ctx: CanvasRenderingContext2D, plots: OakPlot[], bars: BaseBar[], view: ViewState): void {
  const { width, height } = logicalSize(ctx);
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length || plots.length === 0) return;

  const endIdx = Math.min(end + 1, bars.length);
  const vLen = Math.max(0, endIdx - start);
  if (vLen === 0) return;
  // Single-pass min/max instead of slicing + flat-mapping into a new array
  // and spreading it into Math.min/max twice — this runs every frame
  // whenever any OakScript indicator has main-pane plots.
  let minP = Infinity, maxP = -Infinity;
  for (let i = start; i < endIdx; i++) {
    const b = bars[i];
    if (b.high > maxP) maxP = b.high;
    if (b.low < minP) minP = b.low;
  }
  const pRange = maxP - minP || 1;

  ctx.save();

  // Bucket by type in a single pass instead of 3 separate .filter() calls
  // over the same (potentially thousand-plus entry) array — plot()/hline()
  // push once per BAR, so this array is not small.
  const linePlots: OakPlot[] = [];
  const shapePlots: OakPlot[] = [];
  const bgColors: OakPlot[] = [];
  // New drawing-object buckets (barcolor is excluded — it recolors candles
  // in drawBars, not drawn here).
  const linefillPlots: OakPlot[] = [];
  const boxPlots: OakPlot[] = [];
  const circlePlots: OakPlot[] = [];
  const polylinePlots: OakPlot[] = [];
  const lineObjPlots: OakPlot[] = [];
  const arrowPlots: OakPlot[] = [];
  const imagePlots: OakPlot[] = [];
  const tablePlots: OakPlot[] = [];
  for (const p of plots) {
    if (p.type === 'line' || p.type === 'hline') linePlots.push(p);
    else if (p.type === 'shape') shapePlots.push(p);
    else if (p.type === 'bgcolor') bgColors.push(p);
    else if (p.type === 'linefill_obj') linefillPlots.push(p);
    else if (p.type === 'box_obj') boxPlots.push(p);
    else if (p.type === 'circle_obj') circlePlots.push(p);
    else if (p.type === 'polyline_obj') polylinePlots.push(p);
    else if (p.type === 'line_obj') lineObjPlots.push(p);
    else if (p.type === 'arrow_obj') arrowPlots.push(p);
    else if (p.type === 'image_obj') imagePlots.push(p);
    else if (p.type === 'table') tablePlots.push(p);
  }

  // For each line plot, we need to find the series values
  // Since plot() outputs individual values per bar, we reconstruct the series
  // This is a simplified approach — the interpreter already ran bar-by-bar
  // and we have one 'line' plot per bar per plot name.
  const seriesMap = new Map<string, { values: number[]; color: string; linewidth: number }>();

  // Draw background colors as vertical columns per bar
  for (const bp of bgColors) {
    if (bp.color) {
      const idxInView = typeof bp.barIdx === 'number' ? bp.barIdx - start : -1;
      if (idxInView >= 0 && idxInView < vLen) {
        const x = barX(idxInView, vLen, width, view.barSpacing, view.scrollX);
        ctx.fillStyle = bp.color;
        ctx.fillRect(x - view.barSpacing / 2, 0, view.barSpacing, height);
      }
    }
  }

  // Group line plots by name to draw continuous lines
  // Each plot() call in the script creates one entry per bar
  // We use a Map from plot name to array of {barIdx, value}
  const lineData = new Map<string, Array<{ idx: number; value: number; color: string }>>();
  const lineStyles = new Map<string, { linewidth: number; style: string }>();

  for (const p of linePlots) {
    if (p.type === 'hline') continue;
    const key = p.name || 'plot';
    if (!lineData.has(key)) {
      lineData.set(key, []);
      lineStyles.set(key, { linewidth: p.linewidth || 1, style: (p as any).style || 'line' });
    }
    // Preserve bar index so NaN gaps don't shift the series.
    const idx = typeof p.barIdx === 'number' ? p.barIdx : lineData.get(key)!.length;
    const val = typeof p.value === 'number' ? p.value : NaN;
    lineData.get(key)!.push({ idx, value: val, color: p.color || '#b48cff' });
  }

  // Baseline (price 0) clamped to the pane — anchor for area/histogram styles.
  const baselineY = Math.min(height, Math.max(0, priceToY(0, minP, pRange, height, view)));

  // Draw line series (per-bar color + render style)
  for (const [name, data] of lineData) {
    if (data.length < 1) continue;
    const st = lineStyles.get(name)!;

    // Build visible points with per-bar colors.
    const pts: RichPoint[] = [];
    for (const pt of data) {
      const bar = bars[pt.idx];
      if (!bar || isNaN(pt.value)) continue;
      const idxInView = pt.idx - start;
      if (idxInView < 0 || idxInView >= vLen) continue;
      const x = barX(idxInView, vLen, width, view.barSpacing, view.scrollX);
      const y = priceToY(pt.value, minP, pRange, height, view);
      pts.push({ x, y, value: pt.value, color: pt.color });
    }
    if (pts.length < 1) continue;

    renderRichSeries(ctx, pts, { style: st.style, linewidth: st.linewidth, baselineY, barSpacing: view.barSpacing });

    // Price label at the latest visible point
    const last = pts[pts.length - 1];
    const col = last.color;
    const right = chartRight(width);
    const label = `${name} ${last.value.toFixed(2)}`;
    const pad = 4;
    ctx.font = '9px "Inter", monospace';
    const tw = ctx.measureText(label).width + pad * 2;
    const th = 14;
    ctx.fillStyle = 'rgba(8,8,20,0.88)';
    ctx.strokeStyle = hexToRgba(col, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(right - tw - 4, last.y - th / 2, tw, th, 3);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillText(label, right - tw - 4 + pad, last.y + 3);
  }

  // Draw fills (ribbon between two values per bar)
  const fillPlots = plots.filter(p => p.type === 'fill');
  for (const fp of fillPlots) {
    if (typeof fp.fillTop !== 'number' || typeof fp.fillBot !== 'number') continue;
    const idxInView = typeof fp.barIdx === 'number' ? fp.barIdx - start : -1;
    if (idxInView < 0 || idxInView >= vLen) continue;
    const x = barX(idxInView, vLen, width, view.barSpacing, view.scrollX);
    const yTop = priceToY(fp.fillTop, minP, pRange, height, view);
    const yBot = priceToY(fp.fillBot, minP, pRange, height, view);
    const col = fp.color || 'rgba(180,140,255,0.1)';
    ctx.fillStyle = col;
    ctx.fillRect(x - view.barSpacing * 0.4, Math.min(yTop, yBot), view.barSpacing * 0.8, Math.abs(yBot - yTop));
  }

  // Draw horizontal lines
  for (const p of linePlots) {
    if (p.type !== 'hline' || p.price === undefined) continue;
    const y = priceToY(p.price, minP, pRange, height, view);
    const right = chartRight(width);
    ctx.strokeStyle = p.color || 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.color || 'rgba(255,255,255,0.3)';
    ctx.font = '10px monospace';
    ctx.fillText(String(p.price), right + 6, y - 4);
  }

  // ─── Drawing objects: line/box/circle/polyline/arrow/image/linefill ──
  // Shared bar_index+price → screen-pixel projection, reusing the exact
  // same coordinate helpers as every other pass in this function.
  const projPt = (barIdx: number, price: number): { x: number; y: number } => {
    const px = barX(barIdx - start, vLen, width, view.barSpacing, view.scrollX);
    const py = priceToY(price, minP, pRange, height, view);
    return { x: px, y: py };
  };

  // a. linefill_obj — fill the quad between two named line_obj segments.
  //    Unknown/missing ids are skipped silently, never thrown.
  if (linefillPlots.length > 0) {
    const lineObjById = new Map<string, OakPlot>();
    for (const lp of lineObjPlots) if (lp.id) lineObjById.set(lp.id, lp);
    for (const p of linefillPlots) {
      if (!p.id1 || !p.id2) continue;
      const l1 = lineObjById.get(p.id1);
      const l2 = lineObjById.get(p.id2);
      if (!l1 || !l2) continue;
      if (typeof l1.x !== 'number' || typeof l1.y !== 'number' || typeof l1.x2 !== 'number' || typeof l1.y2 !== 'number'
        || typeof l2.x !== 'number' || typeof l2.y !== 'number' || typeof l2.x2 !== 'number' || typeof l2.y2 !== 'number') continue;
      const a1 = projPt(l1.x, l1.y);
      const a2 = projPt(l1.x2, l1.y2);
      const b1 = projPt(l2.x, l2.y);
      const b2 = projPt(l2.x2, l2.y2);
      ctx.fillStyle = p.color || 'rgba(180,140,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(a1.x, a1.y);
      ctx.lineTo(a2.x, a2.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  // b. box_obj — bounding rect from (x,y) to (x2,y2).
  for (const p of boxPlots) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.x2 !== 'number' || typeof p.y2 !== 'number') continue;
    const c1 = projPt(p.x, p.y);
    const c2 = projPt(p.x2, p.y2);
    const rx = Math.min(c1.x, c2.x);
    const ry = Math.min(c1.y, c2.y);
    const rw = Math.abs(c2.x - c1.x);
    const rh = Math.abs(c2.y - c1.y);
    if (p.bgColor) { ctx.fillStyle = p.bgColor; ctx.fillRect(rx, ry, rw, rh); }
    ctx.strokeStyle = p.color || 'rgba(180,140,255,0.6)';
    ctx.lineWidth = p.linewidth || 1;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // c. circle_obj — same bounding box as box_obj, ellipse inscribed.
  for (const p of circlePlots) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.x2 !== 'number' || typeof p.y2 !== 'number') continue;
    const c1 = projPt(p.x, p.y);
    const c2 = projPt(p.x2, p.y2);
    const rx = Math.min(c1.x, c2.x);
    const ry = Math.min(c1.y, c2.y);
    const rw = Math.abs(c2.x - c1.x);
    const rh = Math.abs(c2.y - c1.y);
    ctx.beginPath();
    ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
    if (p.bgColor) { ctx.fillStyle = p.bgColor; ctx.fill(); }
    ctx.strokeStyle = p.color || 'rgba(180,140,255,0.6)';
    ctx.lineWidth = p.linewidth || 1;
    ctx.stroke();
  }

  // d. polyline_obj — path through mapped points.
  for (const p of polylinePlots) {
    if (!p.points || p.points.length < 2) continue;
    ctx.beginPath();
    const first = projPt(p.points[0].x, p.points[0].y);
    ctx.moveTo(first.x, first.y);
    for (let pi = 1; pi < p.points.length; pi++) {
      const pt = projPt(p.points[pi].x, p.points[pi].y);
      ctx.lineTo(pt.x, pt.y);
    }
    if (p.closed) {
      ctx.closePath();
      ctx.fillStyle = p.bgColor || (p.color ? hexToRgba(p.color, 0.15) : 'rgba(180,140,255,0.12)');
      ctx.fill();
    }
    ctx.strokeStyle = p.color || 'rgba(180,140,255,0.7)';
    ctx.lineWidth = p.linewidth || 1;
    ctx.stroke();
  }

  // e. line_obj — segment + extend ray(s) to the pane edge, honoring style.
  for (const p of lineObjPlots) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.x2 !== 'number' || typeof p.y2 !== 'number') continue;
    const a = projPt(p.x, p.y);
    const b = projPt(p.x2, p.y2);
    ctx.strokeStyle = p.color || 'rgba(180,140,255,0.8)';
    ctx.lineWidth = p.linewidth || 1;
    if (p.style === 'dashed') ctx.setLineDash([6, 4]);
    else if (p.style === 'dotted') ctx.setLineDash([2, 3]);
    else ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    if (p.extend && p.extend !== 'none') {
      const dx = b.x - a.x;
      if (Math.abs(dx) > 1e-6) {
        const slope = (b.y - a.y) / dx;
        const leftPt = a.x <= b.x ? a : b;
        const rightPt = a.x <= b.x ? b : a;
        ctx.beginPath();
        if (p.extend === 'left' || p.extend === 'both') {
          const edgeX = 0;
          const edgeY = leftPt.y - slope * (leftPt.x - edgeX);
          ctx.moveTo(leftPt.x, leftPt.y);
          ctx.lineTo(edgeX, edgeY);
        }
        if (p.extend === 'right' || p.extend === 'both') {
          const edgeX = chartRight(width);
          const edgeY = rightPt.y + slope * (edgeX - rightPt.x);
          ctx.moveTo(rightPt.x, rightPt.y);
          ctx.lineTo(edgeX, edgeY);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // f. arrow_obj — segment + arrowhead at (x2,y2) pointing away from (x,y).
  //    Arrowhead geometry adapted from the triangleup/arrowup shape-marker
  //    cases further below (moveTo/lineTo/lineTo/closePath/fill + dark outline).
  for (const p of arrowPlots) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.x2 !== 'number' || typeof p.y2 !== 'number') continue;
    const a = projPt(p.x, p.y);
    const b = projPt(p.x2, p.y2);
    const acol = p.color || 'rgba(180,140,255,0.85)';
    ctx.strokeStyle = acol;
    ctx.lineWidth = p.linewidth || 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const headLen = 10;
    const headAngle = Math.PI / 7;
    const lx = b.x - headLen * Math.cos(ang - headAngle);
    const ly2 = b.y - headLen * Math.sin(ang - headAngle);
    const rx2 = b.x - headLen * Math.cos(ang + headAngle);
    const ry2 = b.y - headLen * Math.sin(ang + headAngle);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(lx, ly2);
    ctx.lineTo(rx2, ry2);
    ctx.closePath();
    ctx.fillStyle = acol;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
  }

  // g. image_obj — resolveImage() + centered draw with opacity/rotation.
  for (const p of imagePlots) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !p.imageRef) continue;
    const img = resolveImage(p.imageRef);
    if (!img) continue; // still decoding — skip this frame, no error
    const pt = projPt(p.x, p.y);
    const iw = p.imgWidth || 48;
    const ih = p.imgHeight || 48;
    const opacity = typeof p.opacity === 'number' ? p.opacity : 1;
    const rot = ((p.rz || 0) * Math.PI) / 180;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(pt.x, pt.y);
    if (rot) ctx.rotate(rot);
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
  }

  // Draw shape markers
  for (const p of shapePlots) {
    const idxInView = typeof p.barIdx === 'number' ? p.barIdx - start : typeof p.x === 'number' ? Math.round(p.x) - start : -1;
    if (idxInView < 0 || idxInView >= vLen) continue;
    const x = barX(idxInView, vLen, width, view.barSpacing, view.scrollX);
    if (typeof p.price !== 'number' || isNaN(p.price)) continue;
    let y = priceToY(p.price, minP, pRange, height, view);
    const col = p.color || '#b48cff';
    const style = p.style || 'circle';

    const gap = Math.max(8, view.barSpacing * 1.5);
    if (style === 'triangleup' || style === 'arrowup') y += gap;
    if (style === 'triangledown' || style === 'arrowdown') y -= gap;

    ctx.fillStyle = col;
    ctx.shadowBlur = 16;
    ctx.shadowColor = hexToRgba(col, 0.6);

    switch (style) {
      case 'triangleup': {
        ctx.beginPath();
        ctx.moveTo(x, y - 10); ctx.lineTo(x - 8, y + 5); ctx.lineTo(x + 8, y + 5);
        ctx.closePath(); ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
        break;
      }
      case 'triangledown': {
        ctx.beginPath();
        ctx.moveTo(x, y + 10); ctx.lineTo(x - 8, y - 5); ctx.lineTo(x + 8, y - 5);
        ctx.closePath(); ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
        break;
      }
      case 'arrowup': {
        ctx.beginPath();
        ctx.moveTo(x, y - 12); ctx.lineTo(x - 6, y - 2); ctx.lineTo(x - 2.5, y - 2);
        ctx.lineTo(x - 2.5, y + 9); ctx.lineTo(x + 2.5, y + 9); ctx.lineTo(x + 2.5, y - 2);
        ctx.lineTo(x + 6, y - 2); ctx.closePath(); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        break;
      }
      case 'arrowdown': {
        ctx.beginPath();
        ctx.moveTo(x, y + 12); ctx.lineTo(x - 6, y + 2); ctx.lineTo(x - 2.5, y + 2);
        ctx.lineTo(x - 2.5, y - 9); ctx.lineTo(x + 2.5, y - 9); ctx.lineTo(x + 2.5, y + 2);
        ctx.lineTo(x + 6, y + 2); ctx.closePath(); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        break;
      }
      case 'circle': {
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'cross': {
        // PineScript 'cross' is a plus sign (+).
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y);
        ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
        break;
      }
      case 'xcross': {
        // 'xcross' is a diagonal X.
        ctx.strokeStyle = col; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
        ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
        break;
      }
      case 'square': {
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.strokeRect(x - 5, y - 5, 10, 10);
        break;
      }
      case 'diamond': {
        ctx.beginPath();
        ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y);
        ctx.closePath(); ctx.fill();
        ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        break;
      }
      case 'label': {
        if (p.text) {
          ctx.fillStyle = col;
          ctx.font = '10px monospace';
          ctx.fillText(p.text, x + 8, y);
        }
        break;
      }
      case 'image': {
        // plotimage(...) — same resolveImage+drawImage-with-opacity-and-rotation
        // as the image_obj pass above, using the shape plot's own fields.
        const img = resolveImage(p.imageRef || '');
        if (img) {
          const iw = p.imgWidth || 24;
          const ih = p.imgHeight || 24;
          const iOpacity = typeof p.opacity === 'number' ? p.opacity : 1;
          const iRot = ((p.rz || 0) * Math.PI) / 180;
          ctx.save();
          ctx.globalAlpha = iOpacity;
          ctx.translate(x, y);
          if (iRot) ctx.rotate(iRot);
          ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
          ctx.restore();
        }
        break;
      }
      default: {
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Draw text label alongside any shape that has a name
    if (p.text && p.text.length > 0 && style !== 'label') {
      const ly = style === 'triangledown' ? y - 8 : y + 18;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px "Inter", monospace';
      ctx.shadowBlur = 5;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.fillText(p.text, x - ctx.measureText(p.text).width / 2, ly);
      ctx.shadowBlur = 0;
    }
    ctx.shadowBlur = 0;
  }

  // Draw label plots
  for (const p of plots) {
    if (p.type !== 'label') continue;
    const idxInView = typeof p.barIdx === 'number' ? p.barIdx - start : typeof p.x === 'number' ? Math.round(p.x) - start : -1;
    const x = idxInView >= 0 && idxInView < vLen ? barX(idxInView, vLen, width, view.barSpacing, view.scrollX) : width / 2;
    const y = typeof p.y === 'number' ? priceToY(p.y, minP, pRange, height, view) : height / 2;
    const col = p.color || 'rgba(255,255,255,0.7)';
    const text = p.text || '';
    // .size/.align are new optional fields — absent means identical output
    // to the original bare behavior (10px monospace, left-aligned at x+8).
    const fontSize = p.size || 10;
    ctx.font = `${fontSize}px monospace`;
    const align: CanvasTextAlign = p.align === 'center' || p.align === 'right' ? p.align : 'left';
    const tx = align === 'left' ? x + 8 : x;

    if (p.boxed) {
      // Reuse the exact price-label-chip background pattern used earlier in
      // this function (rgba(8,8,20,0.88) roundRect + stroke + fillText).
      const textW = ctx.measureText(text).width;
      const pad = 4;
      const th = fontSize + 6;
      const rectLeft = align === 'center' ? tx - textW / 2 - pad
        : align === 'right' ? tx - textW - pad
        : tx - pad;
      const rectW = textW + pad * 2;
      ctx.fillStyle = 'rgba(8,8,20,0.88)';
      ctx.strokeStyle = hexToRgba(col, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(rectLeft, y - th / 2, rectW, th, 3);
      ctx.fill(); ctx.stroke();
    }

    ctx.textAlign = align;
    ctx.fillStyle = col;
    ctx.fillText(text, tx, y + 3);
    ctx.textAlign = 'left';
  }

  // Table plots — screen-space anchored dashboards (chrome UI, NOT
  // barX/priceToY chart-space; positioned against the canvas bounds).
  const TABLE_PAD = 12;
  const TABLE_CELL_W = 90;
  const TABLE_CELL_H = 22;
  for (const p of tablePlots) {
    const cols = p.cols || 0;
    const rows = p.rows || 0;
    if (cols <= 0 || rows <= 0 || !p.cells) continue;
    const cells = p.cells;
    const cw = Math.min(TABLE_CELL_W, Math.max(30, (ctx.canvas.clientWidth - TABLE_PAD * 2) / cols));
    const ch = Math.min(TABLE_CELL_H, Math.max(14, (ctx.canvas.clientHeight - TABLE_PAD * 2) / rows));
    const tblW = cw * cols;
    const tblH = ch * rows;
    const pos = p.position || 'top_right';

    let ox = (ctx.canvas.clientWidth - tblW) / 2;
    if (pos.includes('left')) ox = TABLE_PAD;
    else if (pos.includes('right')) ox = ctx.canvas.clientWidth - tblW - TABLE_PAD;

    let oy = (ctx.canvas.clientHeight - tblH) / 2;
    if (pos.includes('top')) oy = TABLE_PAD;
    else if (pos.includes('bottom')) oy = ctx.canvas.clientHeight - tblH - TABLE_PAD;

    ox = Math.max(0, Math.min(ox, Math.max(0, ctx.canvas.clientWidth - tblW)));
    oy = Math.max(0, Math.min(oy, Math.max(0, ctx.canvas.clientHeight - tblH)));

    ctx.fillStyle = p.bgColor || 'rgba(8,8,20,0.85)';
    ctx.fillRect(ox, oy, tblW, tblH);
    ctx.strokeStyle = 'rgba(180,140,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, tblW, tblH);

    ctx.font = '10px monospace';
    for (let r = 0; r < rows; r++) {
      const rowCells = cells[r];
      if (!rowCells) continue;
      for (let c = 0; c < cols; c++) {
        const cell = rowCells[c];
        if (!cell) continue;
        const cx = ox + c * cw;
        const cy = oy + r * ch;
        if (cell.bgColor) {
          ctx.fillStyle = cell.bgColor;
          ctx.fillRect(cx + 1, cy + 1, cw - 2, ch - 2);
        }
        if (cell.text) {
          ctx.fillStyle = cell.textColor || 'rgba(230,230,255,0.9)';
          // Adaptive metrics: mindfully round long decimals and truncate to fit cell width
          let txt = cell.text;
          // If text looks numeric with many decimals, round to adaptive precision
          if (/^-?\d+\.\d{5,}$/.test(txt)) {
            const num = parseFloat(txt);
            if (!isNaN(num)) {
              const abs = Math.abs(num);
              if (abs >= 1000) txt = num.toFixed(1);
              else if (abs >= 10) txt = num.toFixed(2);
              else if (abs >= 1) txt = num.toFixed(3);
              else txt = num.toFixed(4);
              // Trim trailing zeros
              txt = txt.replace(/\.?0+$/, '');
              if (txt === '-0') txt = '0';
            }
          }
          // Truncate with ellipsis if exceeds cell width
          const maxW = cw - 8;
          if (ctx.measureText(txt).width > maxW) {
            let short = txt;
            while (short.length > 1 && ctx.measureText(short + '…').width > maxW) short = short.slice(0, -1);
            txt = short + '…';
          }
          ctx.fillText(txt, cx + 4, cy + ch / 2 + 3);
        }
      }
    }
  }

  ctx.restore();
}
