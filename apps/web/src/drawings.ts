import type { BaseBar } from '@dafe/types';
import {
  barX, priceToY, getPriceRange, xToBarIndex, yToPrice,
  chartRight, logicalSize, type ViewState,
} from './chart-renderer';

export type DrawTool = 'none' | 'trend' | 'ray' | 'hline' | 'rect' | 'fib' | 'channel' | 'text' | 'erase';
type ShapeType = Exclude<DrawTool, 'none' | 'erase'>;

// Anchors are timestamps, not bar indexes: auto-refresh rolls the bar window
// forward, and an index would slide off the bar it was placed on.
interface Point { t: number; price: number; }
interface Drawing { id: number; type: ShapeType; a: Point; b?: Point; color: string; text?: string; }

// Pixel mapping for one frame. In isometric mode each candle's front face starts
// at barX and is bodyOff wide, so the bar centre sits bodyOff to the right. The
// front plane (z = 0) projects to the identity, so drawings share the 2D price axis.
interface Frame {
  bars: BaseBar[];
  view: ViewState;
  width: number;
  height: number;
  minP: number;
  pRange: number;
  start: number;
  vLen: number;
  bodyOff: number;
}

const PALETTE = ['#b48cff', '#22cc88', '#ff4477', '#ffd166', '#4cc9f0'];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const CHANNEL_OFFSET = 36; // pixel offset of the parallel channel line
const HIT_PX = 6;          // click tolerance around a drawing, in pixels

// Manual drawings are user-driven and long-lived (never rebuilt fresh like
// an OakScript indicator's per-execution plots), so unlike that system
// nothing here self-cleans — a session of casual clicking could otherwise
// accumulate an unbounded array forever. Cap by RENDER COST, not raw count:
// a fib draws 7 levels + 7 labels every frame, a channel draws 2 lines + a
// fill, while a single hline/text is nearly free — so a handful of fibs
// should count for much more of the budget than the same number of hlines.
const DRAWING_WEIGHT: Record<ShapeType, number> = {
  hline: 1, text: 1, trend: 1, ray: 1, rect: 1, channel: 2, fib: 5,
};
const MAX_TOTAL_WEIGHT = 150;

let drawings: Drawing[] = [];
let tool: DrawTool = 'none';
let pending: Point | null = null;
let preview: Point | null = null;
let colorIdx = 0;
let nextId = 1;
let selectedId: number | null = null;

export function setTool(t: DrawTool): void {
  tool = t;
  pending = null;
  preview = null;
  if (t !== 'none') selectedId = null;
}
export function getTool(): DrawTool { return tool; }
export function isDrawing(): boolean { return tool !== 'none'; }
export function hasPending(): boolean { return pending !== null; }
export function hasSelection(): boolean { return selectedId !== null; }
export function clearSelection(): void { selectedId = null; }

export function clearDrawings(): void {
  drawings = [];
  pending = null;
  preview = null;
  selectedId = null;
}
export function undoDrawing(): void {
  if (pending) { pending = null; return; }
  const last = drawings.pop();
  if (last && last.id === selectedId) selectedId = null;
}
export function count(): number { return drawings.length; }

/** Delete the selected drawing. Returns false when nothing is selected. */
export function deleteSelected(): boolean {
  return selectedId !== null && removeById(selectedId);
}

function removeById(id: number): boolean {
  const before = drawings.length;
  drawings = drawings.filter(d => d.id !== id);
  if (selectedId === id) selectedId = null;
  return drawings.length < before;
}

/** Total render-cost weight currently on the chart (see DRAWING_WEIGHT). */
export function totalWeight(): number {
  let w = 0;
  for (const d of drawings) w += DRAWING_WEIGHT[d.type];
  return w;
}

/** Push a new drawing, then evict the OLDEST drawings (oldest-first, same
 * eviction order as every OakScript object cap) until back under budget —
 * so the toolbar never needs a manual "Clear All" just to stay performant. */
function pushDrawing(d: Omit<Drawing, 'id'>): void {
  drawings.push({ ...d, id: nextId++ });
  let w = totalWeight();
  let i = 0;
  while (w > MAX_TOTAL_WEIGHT && i < drawings.length) {
    w -= DRAWING_WEIGHT[drawings[i].type];
    i++;
  }
  if (i > 0) {
    const evicted = drawings.slice(0, i);
    drawings = drawings.slice(i);
    if (selectedId !== null && evicted.some(e => e.id === selectedId)) selectedId = null;
  }
}

/** Bar position (fractional) of a timestamp. Past the loaded bars it extrapolates at the nearest bar spacing. */
function timeToIndex(bars: BaseBar[], t: number): number {
  const n = bars.length;
  if (n === 1) return 0;
  const first = bars[0].timestamp, last = bars[n - 1].timestamp;
  if (t <= first) return (t - first) / ((bars[1].timestamp - first) || 1);
  if (t >= last) return (n - 1) + (t - last) / ((last - bars[n - 2].timestamp) || 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= t) lo = mid; else hi = mid;
  }
  const a = bars[lo].timestamp, b = bars[lo + 1].timestamp;
  return lo + (b > a ? (t - a) / (b - a) : 0);
}

/** Timestamp at a bar position, snapped to the nearest bar. Positions past the loaded bars extrapolate. */
function indexToTime(bars: BaseBar[], idx: number): number {
  const n = bars.length;
  const i = Math.round(idx);
  if (i >= 0 && i < n) return bars[i].timestamp;
  if (i < 0) return bars[0].timestamp + i * ((n > 1 ? bars[1].timestamp - bars[0].timestamp : 1) || 1);
  return bars[n - 1].timestamp + (i - (n - 1)) * ((n > 1 ? bars[n - 1].timestamp - bars[n - 2].timestamp : 1) || 1);
}

function frameOf(bars: BaseBar[], view: ViewState, width: number, height: number, iso: boolean): Frame | null {
  if (bars.length === 0) return null;
  const { minP, pRange, start, vLen } = getPriceRange(bars, view, width);
  if (vLen === 0) return null;
  const bodyOff = iso ? Math.max(1.2, view.barSpacing * 0.72) / 2 : 0;
  return { bars, view, width, height, minP, pRange, start, vLen, bodyOff };
}

function xOfTime(f: Frame, t: number): number {
  return barX(timeToIndex(f.bars, t) - f.start, f.vLen, f.width, f.view.barSpacing, f.view.scrollX) + f.bodyOff;
}
function yOfPrice(f: Frame, price: number): number {
  return priceToY(price, f.minP, f.pRange, f.height, f.view);
}

/** Pixel → data anchor. In isometric mode the bar is read at the centre of its front face. */
export function screenToPoint(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number, iso = false): Point | null {
  const f = frameOf(bars, view, width, height, iso);
  if (!f) return null;
  const idx = Math.round(xToBarIndex(px - f.bodyOff, bars, view, width));
  return { t: indexToTime(bars, idx), price: yToPrice(py, f.minP, f.pRange, height, view) };
}

export function onClick(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number, iso = false): boolean {
  if (tool === 'none') return false;
  if (tool === 'erase') {
    const f = frameOf(bars, view, width, height, iso);
    const hit = f ? drawingAt(f, px, py) : null;
    if (hit) removeById(hit.id);
    return true;
  }
  const pt = screenToPoint(px, py, bars, view, width, height, iso);
  if (!pt) return false;
  const color = PALETTE[colorIdx % PALETTE.length];
  if (tool === 'hline') {
    pushDrawing({ type: 'hline', a: pt, color });
    colorIdx++;
    return true;
  }
  if (tool === 'text') {
    const txt = prompt('Text label:');
    if (txt) pushDrawing({ type: 'text', a: pt, color, text: txt });
    colorIdx++;
    return true;
  }
  if (!pending) { pending = pt; return true; }
  pushDrawing({ type: tool, a: pending, b: pt, color });
  pending = null;
  colorIdx++;
  return true;
}

export function onMove(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number, iso = false): void {
  if (tool === 'none' || tool === 'erase' || !pending) { preview = null; return; }
  preview = screenToPoint(px, py, bars, view, width, height, iso);
}

/**
 * Cursor-mode press. The x handle on the selected drawing deletes it and
 * consumes the press (returns true). Otherwise the topmost drawing under the
 * pointer becomes the selection, and the press falls through to panning.
 */
export function pointerDown(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number, iso = false): boolean {
  const f = frameOf(bars, view, width, height, iso);
  if (!f) return false;
  const sel = selectedId === null ? undefined : drawings.find(d => d.id === selectedId);
  if (sel && handleHit(sel, f, px, py)) {
    removeById(sel.id);
    return true;
  }
  selectedId = drawingAt(f, px, py)?.id ?? null;
  return false;
}

function drawingAt(f: Frame, px: number, py: number): Drawing | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    if (hitDrawing(drawings[i], f, px, py)) return drawings[i];
  }
  return null;
}

/** Centre of the x handle that marks and deletes a selected drawing. */
function handleCentre(d: Drawing, f: Frame): { x: number; y: number } {
  const y = yOfPrice(f, d.a.price);
  if (d.type === 'hline') return { x: chartRight(f.width) - 14, y: y - 12 };
  if (d.type === 'text') return { x: xOfTime(f, d.a.t) + 12, y: y - 20 };
  return { x: xOfTime(f, d.a.t) + 12, y: y - 12 };
}
function handleHit(d: Drawing, f: Frame, px: number, py: number): boolean {
  const h = handleCentre(d, f);
  return Math.hypot(px - h.x, py - h.y) <= 9;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Second endpoint of a ray: extended to the right edge when it reaches past it. */
function rayEnd(x1: number, y1: number, x2: number, y2: number, right: number): [number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) > 0.001) {
    const t = (right - x1) / dx;
    if (t > 1) return [right, y1 + dy * t];
  }
  return [x2, y2];
}

function hitDrawing(d: Drawing, f: Frame, px: number, py: number): boolean {
  const y1 = yOfPrice(f, d.a.price);
  if (d.type === 'hline') return Math.abs(py - y1) <= HIT_PX;
  const x1 = xOfTime(f, d.a.t);
  if (d.type === 'text') {
    const w = (d.text || '').length * 7;
    return px >= x1 + 4 && px <= x1 + 10 + w && py >= y1 - 16 && py <= y1 + 4;
  }
  const b = d.b;
  if (!b) return false;
  const x2 = xOfTime(f, b.t), y2 = yOfPrice(f, b.price);
  if (d.type === 'rect') {
    const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), bt = Math.max(y1, y2);
    return px >= l - HIT_PX && px <= r + HIT_PX && py >= t - HIT_PX && py <= bt + HIT_PX;
  }
  if (d.type === 'fib') {
    const l = Math.min(x1, x2);
    return px >= l - HIT_PX
      && FIB_LEVELS.some(lv => Math.abs(py - yOfPrice(f, d.a.price + (b.price - d.a.price) * lv)) <= HIT_PX);
  }
  if (d.type === 'channel') {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * CHANNEL_OFFSET, ny = (dx / len) * CHANNEL_OFFSET;
    return distToSegment(px, py, x1, y1, x2, y2) <= HIT_PX
      || distToSegment(px, py, x1 + nx, y1 + ny, x2 + nx, y2 + ny) <= HIT_PX;
  }
  const end: [number, number] = d.type === 'ray' ? rayEnd(x1, y1, x2, y2, chartRight(f.width)) : [x2, y2];
  return distToSegment(px, py, x1, y1, end[0], end[1]) <= HIT_PX;
}

/** The x handle that marks the selected drawing and deletes it when pressed. */
function drawHandle(ctx: CanvasRenderingContext2D, d: Drawing, f: Frame): void {
  const h = handleCentre(d, f);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = d.color;
  ctx.fillStyle = 'rgba(12,12,24,0.92)';
  ctx.beginPath(); ctx.arc(h.x, h.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(h.x - 3, h.y - 3); ctx.lineTo(h.x + 3, h.y + 3);
  ctx.moveTo(h.x + 3, h.y - 3); ctx.lineTo(h.x - 3, h.y + 3);
  ctx.stroke();
  ctx.restore();
}

export function drawAll(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState, iso = false): void {
  const { width, height } = logicalSize(ctx);
  const f = frameOf(bars, view, width, height, iso);
  if (!f) return;
  const X = (t: number) => xOfTime(f, t);
  const Y = (p: number) => yOfPrice(f, p);
  const right = chartRight(width);

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.font = '10px "Inter", monospace';

  const renderOne = (d: Drawing, ghost: boolean) => {
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.globalAlpha = ghost ? 0.5 : 1;
    ctx.shadowBlur = 8;
    ctx.shadowColor = d.color + '66';

    if (d.type === 'hline') {
      const y = Y(d.a.price);
      ctx.setLineDash(ghost ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.fillText(d.a.price.toFixed(2), right + 4, y + 3);
      return;
    }
    if (d.type === 'text') {
      const x = X(d.a.t), y = Y(d.a.price);
      ctx.font = 'bold 11px "Inter", monospace';
      ctx.fillStyle = d.color;
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.fillText(d.text || '', x + 6, y - 4);
      ctx.shadowBlur = 0;
      return;
    }
    const b = d.b;
    if (!b) return;
    const x1 = X(d.a.t), y1 = Y(d.a.price);
    let x2 = X(b.t), y2 = Y(b.price);

    if (d.type === 'rect') {
      ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.12;
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.globalAlpha = ghost ? 0.5 : 1;
      ctx.setLineDash(ghost ? [4, 4] : []);
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      return;
    }

    // Extend beyond the second point to the right edge
    if (d.type === 'ray') [x2, y2] = rayEnd(x1, y1, x2, y2, right);

    if (d.type === 'fib') {
      const top = d.a.price, bot = b.price;
      ctx.setLineDash(ghost ? [4, 4] : []);
      for (const lv of FIB_LEVELS) {
        const p = top + (bot - top) * lv;
        const y = Y(p);
        ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.8;
        ctx.beginPath(); ctx.moveTo(Math.min(x1, x2), y); ctx.lineTo(right, y); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillText((lv * 100).toFixed(1) + '%  ' + p.toFixed(1), Math.min(x1, x2) + 4, y - 2);
      }
      ctx.setLineDash([]);
      return;
    }

    // trend / ray / channel base line
    if (d.type === 'channel') {
      // main line + parallel offset line
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * CHANNEL_OFFSET, ny = dx / len * CHANNEL_OFFSET;
      ctx.setLineDash(ghost ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.7;
      ctx.beginPath(); ctx.moveTo(x1 + nx, y1 + ny); ctx.lineTo(x2 + nx, y2 + ny); ctx.stroke();
      ctx.globalAlpha = ghost ? 0.5 : 1;
      // channel fill
      ctx.fillStyle = d.color;
      ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.06;
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.lineTo(x2 + nx, y2 + ny); ctx.lineTo(x1 + nx, y1 + ny); ctx.closePath(); ctx.fill();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      return;
    }

    ctx.setLineDash(ghost ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    if (!ghost) {
      ctx.beginPath(); ctx.arc(x1, y1, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(X(b.t), Y(b.price), 3, 0, Math.PI * 2); ctx.fill();
    }
  };

  for (const d of drawings) renderOne(d, false);

  // Live preview while placing the second point of a two-point tool
  if (pending && preview && tool !== 'none' && tool !== 'erase' && tool !== 'hline') {
    renderOne({ id: 0, type: tool, a: pending, b: preview, color: PALETTE[colorIdx % PALETTE.length] }, true);
  }

  const sel = selectedId === null ? undefined : drawings.find(d => d.id === selectedId);
  if (sel) drawHandle(ctx, sel, f);

  ctx.restore();
}
