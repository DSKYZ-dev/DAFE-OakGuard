import type { BaseBar, VolumeBin, VolumeProfileMode } from '@dafe/types';
import type { BarType, PerBarVolume } from './data-generator';
import type { OakPlot } from './oakscript';
import type { VPComputed } from './volume-profile';

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
  return cBot - ((price - minP) / pRange) * cH + (view.offsetY || 0);
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
  const { width, height } = ctx.canvas;

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
export function drawTimeAxis(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState): void {
  const { width, height } = ctx.canvas;
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  const vLen = visible.length;
  if (vLen === 0) return;

  const chartBot = height * BOT_FRAC;

  // Aim for a label roughly every ~110px
  const targetLabels = Math.max(2, Math.floor(chartRight(width) / 110));
  const step = Math.max(1, Math.floor(vLen / targetLabels));

  ctx.font = '10px "Inter", monospace';
  for (let i = 0; i < vLen; i += step) {
    const bar = visible[i];
    const x = barX(i, vLen, width, view.barSpacing, view.scrollX);
    if (x < 0 || x > chartRight(width)) continue;
    const d = new Date(bar.timestamp);
    const label = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    ctx.fillStyle = 'rgba(180, 140, 255, 0.1)';
    ctx.fillRect(x, chartBot, 1, 6);
    ctx.fillStyle = 'rgba(180, 140, 255, 0.4)';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, chartBot + 16);
  }
  ctx.textAlign = 'left';
}

// ─── GLOWING GRID ───────────────────────────────────────────────────
// Pre-allocated price array to avoid per-frame allocations
const _gridPrices: number[] = [];
export function drawGrid(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, time: number): void {
  const { width, height } = ctx.canvas;
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

    // Price label on the right axis
    ctx.fillStyle = isMajor ? 'rgba(200, 180, 255, 0.55)' : 'rgba(180, 140, 255, 0.35)';
    ctx.font = '10px "Inter", monospace';
    ctx.fillText(price.toFixed(0), right + 6, y + 3);
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
export function drawBars(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, time: number, barType: BarType, perBarVol?: PerBarVolume[]): void {
  const { width, height } = ctx.canvas;
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

    // Per-bar volume profile (2D-Per-Bar mode VPI)
    if (perBarVol && perBarVol[i + start]) {
      const pv = perBarVol[i + start];
      if (pv.maxVol > 0) {
        const minVol = pv.maxVol * 0.05; // skip levels below 5% of max
        for (const level of pv.levels) {
          if (level.volume < minVol) continue;
          const lx = priceToY(level.price, minP, pRange, height, view);
          const volW = (level.volume / pv.maxVol) * hW * 0.8;
          if (volW < 0.5 || isNaN(volW)) continue;
          const ratio = level.buyVol / Math.max(level.volume, 0.001);
          ctx.fillStyle = ratio > 0.5
            ? `rgba(34, 204, 136, ${0.08 + (level.volume / pv.maxVol) * 0.15})`
            : `rgba(255, 68, 119, ${0.06 + (level.volume / pv.maxVol) * 0.12})`;
          ctx.fillRect(x - hW - volW, lx - 1, volW, 2);
          ctx.fillRect(x + hW, lx - 1, volW, 2);
        }
      }
    }

    switch (barType) {
      case 'line': drawLineBar(ctx, x, cy, visible, i, vLen, minP, pRange, height, view, bs, width); break;
      case 'area': drawAreaBar(ctx, x, cy, visible, i, vLen, minP, pRange, height, view, bs, width); break;
      case 'renko': drawRenkoBar(ctx, x, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity); break;
      case 'kagi': drawKagiBar(ctx, x, hy, ly, bar, isBull, visible, i, vLen, minP, pRange, height, view, bs, width); break;
      case 'footprint': drawFootprintBar(ctx, x, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity); break;
      default: drawStandardCandle(ctx, x, oy, cy, hy, ly, bTop, bBot, bH, cW, hW, bar, isBull, time, intensity); break;
    }
  }
  ctx.restore();
}

function drawStandardCandle(ctx: CanvasRenderingContext2D, x: number, oy: number, cy: number, hy: number, ly: number,
  bTop: number, bBot: number, bH: number, cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number): void {
  const bullCol = '#1affa0';
  const bearCol = '#ff3b6b';
  const color = isBull ? bullCol : bearCol;

  // Wick — bold with rounded ends
  ctx.shadowBlur = 10;
  ctx.shadowColor = isBull ? 'rgba(26,255,160,0.45)' : 'rgba(255,59,107,0.45)';
  ctx.strokeStyle = isBull ? 'rgba(26,255,160,0.95)' : 'rgba(255,59,107,0.95)';
  ctx.lineWidth = 3.6;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, ly); ctx.stroke();
  ctx.lineCap = 'butt';

  // Body gradient fill
  ctx.shadowBlur = 10 + intensity * 12;
  ctx.shadowColor = isBull ? `rgba(26,255,160,${0.25 + intensity * 0.35})` : `rgba(255,59,107,${0.25 + intensity * 0.35})`;
  const g = ctx.createLinearGradient(0, bTop, 0, bBot);
  if (isBull) {
    g.addColorStop(0, `rgba(26,255,160,${0.75 + intensity * 0.25})`);
    g.addColorStop(0.5, `rgba(26,255,160,${0.45 + intensity * 0.25})`);
    g.addColorStop(1, `rgba(26,255,160,${0.15 + intensity * 0.15})`);
  } else {
    g.addColorStop(0, `rgba(255,59,107,${0.7 + intensity * 0.25})`);
    g.addColorStop(0.5, `rgba(255,59,107,${0.4 + intensity * 0.25})`);
    g.addColorStop(1, `rgba(255,59,107,${0.12 + intensity * 0.12})`);
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
  cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number): void {
  ctx.shadowBlur = 6;
  ctx.shadowColor = isBull ? 'rgba(34, 204, 136, 0.3)' : 'rgba(255, 68, 119, 0.3)';
  ctx.fillStyle = isBull
    ? `rgba(34, 204, 136, ${0.5 + intensity * 0.3})`
    : `rgba(255, 68, 119, ${0.4 + intensity * 0.3})`;
  ctx.fillRect(x - hW * 0.6, bTop, cW * 0.6, bH);
}

function drawKagiBar(ctx: CanvasRenderingContext2D, x: number, hy: number, ly: number, bar: BaseBar, isBull: boolean,
  visible: BaseBar[], i: number, vLen: number, minP: number, pRange: number, height: number, view: ViewState, bs: number, width: number): void {
  const lineW = isBull ? 3 : 1;
  ctx.strokeStyle = isBull ? 'rgba(34, 204, 136, 0.7)' : 'rgba(255, 68, 119, 0.5)';
  ctx.lineWidth = lineW;
  ctx.shadowBlur = 4;
  ctx.shadowColor = isBull ? 'rgba(34, 204, 136, 0.2)' : 'rgba(255, 68, 119, 0.15)';
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
  cW: number, hW: number, bar: BaseBar, isBull: boolean, time: number, intensity: number): void {
  ctx.shadowBlur = 4;
  ctx.shadowColor = 'rgba(180, 140, 255, 0.1)';
  ctx.fillStyle = `rgba(255, 68, 119, ${0.3 + intensity * 0.2})`;
  ctx.fillRect(x - hW, bTop, hW * 0.4, bH);
  ctx.fillStyle = `rgba(34, 204, 136, ${0.3 + intensity * 0.2})`;
  ctx.fillRect(x - hW * 0.15, bTop, hW * 0.4, bH);
}

// ─── VOLUME PROFILE ────────────────────────────────────────────────
let volPulse = 0;
export function drawVolumeProfile(ctx: CanvasRenderingContext2D, bins: VolumeBin[], mode: VolumeProfileMode, time: number, vp?: VPComputed, profileWidth = 86): void {
  volPulse += 0.02;
  if (bins.length === 0) return;
  const { width, height } = ctx.canvas;
  const maxVol = Math.max(...bins.map(b => b.volume));
  if (maxVol === 0) return;
  const cTop = height * 0.05;
  const cArea = height * 0.83;

  if (mode === '2D-Side') {
    const pW = Math.max(50, Math.min(RIGHT_MARGIN - 10, profileWidth));
    const px = width - pW;
    const bH = cArea / bins.length;
    const pulse = Math.sin(volPulse) * 0.06 + 0.06;
    const colors = vp?.colors;
    const bullCol = colors?.bull || 'rgba(34, 204, 136, 1)';
    const bearCol = colors?.bear || 'rgba(255, 68, 119, 1)';
    const pocCol = colors?.poc || '#ffffff';
    const vaFill = colors?.vaFill || 'rgba(65, 105, 225, 0.3)';
    const vaLine = colors?.vaLine || '#4169E1';
    const hvnCol = colors?.hvn || '#00FF88';
    const lvnCol = colors?.lvn || '#FF4444';

    const panelGrad = ctx.createLinearGradient(px, 0, width, 0);
    panelGrad.addColorStop(0, 'rgba(180, 140, 255, 0.03)');
    panelGrad.addColorStop(1, 'rgba(180, 140, 255, 0.06)');
    ctx.fillStyle = panelGrad;
    ctx.fillRect(px, 0, pW, height);

    // Value area background band
    if (vp?.showValueArea && vp.vah !== null && vp.val !== null) {
      const minP = Math.min(...bins.map(b => b.price));
      const maxP = Math.max(...bins.map(b => b.price));
      const pRange = maxP - minP || 1;
      const priceToPanelY = (p: number) => cTop + ((maxP - p) / pRange) * cArea;
      const yTop = priceToPanelY(vp.vah);
      const yBot = priceToPanelY(vp.val);
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
      const y = cTop + i * bH;
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
      ctx.fillRect(px + 4, y, barW, bH - 1);

      // High / low volume node markers
      if (vp?.showNodes) {
        if (vp.highNodes.includes(bin)) {
          ctx.fillStyle = hvnCol;
          ctx.beginPath(); ctx.arc(px + pW - 6, y + bH / 2, 2, 0, Math.PI * 2); ctx.fill();
        } else if (vp.lowNodes.includes(bin) && bin.volume > 0) {
          ctx.fillStyle = lvnCol;
          ctx.beginPath(); ctx.arc(px + pW - 6, y + bH / 2, 1.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.shadowBlur = 0;

    const poc = vp?.poc || bins.reduce((max, b) => b.volume > max.volume ? b : max, bins[0]);
    const pocIdx = bins.findIndex(b => b.price === poc.price);
    const pocY = cTop + (pocIdx >= 0 ? pocIdx : 0) * bH + bH / 2;
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
    const bH = cArea / bins.length;
    const maxW = 28;
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      const barW = (bin.volume / maxVol) * maxW;
      const y = cTop + i * bH;
      const ratio = bin.buyVolume / Math.max(bin.volume, 0.001);
      ctx.fillStyle = ratio > 0.5 ? `rgba(34, 204, 136, ${0.3 + ratio * 0.5})` : `rgba(255, 68, 119, ${0.2 + (1 - ratio) * 0.5})`;
      ctx.fillRect(6, y, barW, bH - 1);
    }
  }
}

// ─── OHLC TOOLTIP ─────────────────────────────────────────────────
export function drawOHLCTooltip(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, mx: number, my: number, barType: BarType): void {
  const { start, end } = getVisibleRange(view, ctx.canvas.width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  if (visible.length === 0) return;

  const vLen = visible.length;
  const right = chartRight(ctx.canvas.width);
  const barIdx = Math.max(0, Math.min(vLen - 1, Math.round(vLen - 1 - (right - mx) / view.barSpacing)));
  const bar = visible[barIdx];

  const lineH = 15;
  const w = 170;
  const h = 7 * lineH + 8;
  const tx = Math.min(mx + 16, ctx.canvas.width - w - 8);
  const ty = Math.min(my - h / 2, ctx.canvas.height - h - 8);

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

// ─── CROSSHAIR ─────────────────────────────────────────────────────
export function drawCrosshair(ctx: CanvasRenderingContext2D, mx: number, my: number): void {
  const { width, height } = ctx.canvas;
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
  const { width, height } = ctx.canvas;
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
  const { width, height } = ctx.canvas;
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
  const { width, height } = ctx.canvas;
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
  for (const p of plots) {
    if (p.type === 'line' || p.type === 'hline') linePlots.push(p);
    else if (p.type === 'shape') shapePlots.push(p);
    else if (p.type === 'bgcolor') bgColors.push(p);
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
    ctx.fillStyle = p.color || 'rgba(255,255,255,0.7)';
    ctx.font = '10px monospace';
    ctx.fillText(p.text || '', x + 8, y + 3);
  }

  ctx.restore();
}
