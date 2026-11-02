import type { BaseBar } from '@dafe/types';
import {
  barX, priceToY, getPriceRange, xToBarIndex, yToPrice,
  chartRight, logicalSize, type ViewState,
} from '../../web/src/chart-renderer';

export type DrawTool = 'trend' | 'ray' | 'hline' | 'rect' | 'fib' | 'channel' | 'text';
export type DrawPick = DrawTool | 'none';

export interface DrawPoint { t: number; p: number; }
export interface Drawing { id: string; tool: DrawTool; points: DrawPoint[]; text?: string; }

export const TOOL_POINTS: Record<DrawTool, number> = {
  trend: 2, ray: 2, hline: 1, rect: 2, fib: 2, channel: 3, text: 1,
};

const TOOL_COLOR: Record<DrawTool, string> = {
  trend: '#b48cff', ray: '#22cc88', hline: '#ffd166', rect: '#4cc9f0',
  fib: '#ffb703', channel: '#ff4477', text: '#e8e8f0',
};

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const MAX_DRAWINGS = 200;
const TOOLS: readonly DrawTool[] = ['trend', 'ray', 'hline', 'rect', 'fib', 'channel', 'text'];

export function drawingKey(symbol: string, timeframe: string): string {
  return `dafe_mobile_drawings|${symbol}|${timeframe}`;
}

const lists = new Map<string, Drawing[]>();

function loadList(key: string): Drawing[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((d: any) =>
      d && typeof d.id === 'string' && TOOLS.includes(d.tool) &&
      Array.isArray(d.points) && d.points.length > 0 &&
      d.points.every((pt: any) => Number.isFinite(pt?.t) && Number.isFinite(pt?.p)),
    ).slice(-MAX_DRAWINGS);
  } catch {
    return [];
  }
}

function saveList(key: string, list: Drawing[]): void {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* quota or private mode */ }
}

/** The stored list for one symbol+timeframe. Cached: returns the same array on every call. */
export function getDrawings(symbol: string, timeframe: string): Drawing[] {
  const key = drawingKey(symbol, timeframe);
  let list = lists.get(key);
  if (!list) {
    list = loadList(key);
    lists.set(key, list);
  }
  return list;
}

export function addDrawing(symbol: string, timeframe: string, tool: DrawTool, points: DrawPoint[], text?: string): Drawing {
  const key = drawingKey(symbol, timeframe);
  const list = getDrawings(symbol, timeframe);
  const d: Drawing = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    tool,
    points: points.map((pt) => ({ t: pt.t, p: pt.p })),
  };
  if (text !== undefined) d.text = text;
  list.push(d);
  if (list.length > MAX_DRAWINGS) list.splice(0, list.length - MAX_DRAWINGS);
  saveList(key, list);
  return d;
}

export function undoDrawing(symbol: string, timeframe: string): boolean {
  const list = getDrawings(symbol, timeframe);
  if (list.length === 0) return false;
  list.pop();
  saveList(drawingKey(symbol, timeframe), list);
  return true;
}

export function clearDrawings(symbol: string, timeframe: string): void {
  const list = getDrawings(symbol, timeframe);
  list.length = 0;
  saveList(drawingKey(symbol, timeframe), list);
}

// Bars are sorted by timestamp. A drawing stores the bar's timestamp, and the
// chart maps it back to a (fractional) bar index on every frame, so drawings
// stay on their candle when new bars arrive. Times beyond either end of the
// series are extrapolated with the average bar spacing.
function barSpacingMs(bars: BaseBar[]): number {
  const n = bars.length;
  if (n < 2) return 60000;
  return Math.max(1, (bars[n - 1].timestamp - bars[0].timestamp) / (n - 1));
}

/** Timestamp to fractional bar index (0 = first bar). */
export function timeToIndex(bars: BaseBar[], t: number): number {
  const n = bars.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp < t) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return (t - bars[0].timestamp) / barSpacingMs(bars);
  if (lo === n) return (n - 1) + (t - bars[n - 1].timestamp) / barSpacingMs(bars);
  const a = bars[lo - 1].timestamp;
  const b = bars[lo].timestamp;
  return lo - 1 + (t - a) / Math.max(1, b - a);
}

/** Fractional bar index to timestamp. Snaps to the nearest bar inside the series. */
export function indexToTime(bars: BaseBar[], idx: number): number {
  const n = bars.length;
  if (n === 0) return 0;
  const r = Math.round(idx);
  if (r >= 0 && r < n) return bars[r].timestamp;
  if (r >= n) return Math.round(bars[n - 1].timestamp + (idx - (n - 1)) * barSpacingMs(bars));
  return Math.round(bars[0].timestamp + idx * barSpacingMs(bars));
}

/** Pixel to data point, using the same view mapping the candles use. */
export function screenToPoint(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number): DrawPoint {
  const { minP, pRange } = getPriceRange(bars, view, width);
  return {
    t: indexToTime(bars, xToBarIndex(px, bars, view, width)),
    p: yToPrice(py, minP, pRange, height, view),
  };
}

// Scratch mapping for one render pass. Module-level so a frame allocates nothing.
const map = { bars: [] as BaseBar[], view: null as ViewState | null, start: 0, vLen: 0, width: 0, height: 0, minP: 0, pRange: 1 };

function mapX(t: number): number {
  return barX(timeToIndex(map.bars, t) - map.start, map.vLen, map.width, map.view!.barSpacing, map.view!.scrollX);
}

function mapY(p: number): number {
  return priceToY(p, map.minP, map.pRange, map.height, map.view!);
}

function drawPoints(ctx: CanvasRenderingContext2D, d: Drawing, n: number): void {
  for (let i = 0; i < n && i < d.points.length; i++) {
    const x = mapX(d.points[i].t);
    const y = mapY(d.points[i].p);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
}

function drawOne(ctx: CanvasRenderingContext2D, d: Drawing, right: number, ghost: boolean): void {
  const color = TOOL_COLOR[d.tool];
  const pts = d.points;
  const need = TOOL_POINTS[d.tool];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = ghost ? 0.5 : 1;
  ctx.setLineDash(ghost ? [4, 4] : []);

  if (d.tool === 'text') {
    if (pts.length === 0) return;
    ctx.font = 'bold 11px "Inter", monospace';
    ctx.fillText(d.text || '', mapX(pts[0].t) + 6, mapY(pts[0].p) - 4);
    return;
  }

  if (d.tool === 'hline') {
    const y = mapY(pts[0].p);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.font = '10px "Inter", monospace';
    ctx.fillText(pts[0].p.toFixed(2), right + 4, y + 3);
    return;
  }

  if (pts.length < need) {
    drawPoints(ctx, d, pts.length);
    return;
  }

  const x1 = mapX(pts[0].t), y1 = mapY(pts[0].p);
  const x2 = mapX(pts[1].t), y2 = mapY(pts[1].p);

  if (d.tool === 'trend') {
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    drawPoints(ctx, d, 2);
  } else if (d.tool === 'ray') {
    // Extend from the first point through the second to the edge of the plot.
    const dx = x2 - x1, dy = y2 - y1;
    let ex = x2, ey = y2;
    if (Math.abs(dx) > 0.001) {
      const edge = dx > 0 ? right : 0;
      const k = Math.max(1, (edge - x1) / dx);
      ex = x1 + dx * k;
      ey = y1 + dy * k;
    }
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
    drawPoints(ctx, d, 2);
  } else if (d.tool === 'rect') {
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.14;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.globalAlpha = ghost ? 0.5 : 1;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
    drawPoints(ctx, d, 2);
  } else if (d.tool === 'fib') {
    const top = pts[0].p, bot = pts[1].p;
    const left = Math.min(x1, x2);
    ctx.font = '10px "Inter", monospace';
    ctx.lineWidth = 1;
    for (const lv of FIB_LEVELS) {
      const price = top + (bot - top) * lv;
      const y = mapY(price);
      ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.85;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.globalAlpha = ghost ? 0.5 : 1;
      ctx.fillText((lv * 100).toFixed(1) + '%  ' + price.toFixed(2), left + 4, y - 2);
    }
    drawPoints(ctx, d, 2);
  } else if (d.tool === 'channel') {
    // Points 1-2 set the line; point 3 sets the parallel offset (perpendicular
    // distance in pixels from the line to point 3).
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    let off = 0;
    if (pts.length >= 3) {
      const x3 = mapX(pts[2].t), y3 = mapY(pts[2].p);
      off = (x3 - x1) * nx + (y3 - y1) * ny;
    }
    const ox = nx * off, oy = ny * off;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.7;
    ctx.beginPath(); ctx.moveTo(x1 + ox, y1 + oy); ctx.lineTo(x2 + ox, y2 + oy); ctx.stroke();
    ctx.globalAlpha = (ghost ? 0.5 : 1) * 0.07;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2 + ox, y2 + oy); ctx.lineTo(x1 + ox, y1 + oy);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = ghost ? 0.5 : 1;
    drawPoints(ctx, d, 2);
  }
  ctx.setLineDash([]);
}

/**
 * Draw one symbol+timeframe's drawings over the candles. `bars` must be the
 * same array drawBars() uses (state.transformed); the visible window is
 * derived from it by getPriceRange(), exactly as the candles are.
 * `ghost` is an in-progress drawing shown dashed while the finger is down.
 */
export function renderDrawings(ctx: CanvasRenderingContext2D, view: ViewState, bars: BaseBar[], list: Drawing[], ghost: Drawing | null): void {
  if (list.length === 0 && !ghost) return;
  if (bars.length === 0) return;
  const { width, height } = logicalSize(ctx);
  const { minP, pRange, start, vLen } = getPriceRange(bars, view, width);
  if (vLen === 0) return;

  map.bars = bars;
  map.view = view;
  map.start = start;
  map.vLen = vLen;
  map.width = width;
  map.height = height;
  map.minP = minP;
  map.pRange = pRange;
  const right = chartRight(width);

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.font = '10px "Inter", monospace';
  for (let i = 0; i < list.length; i++) drawOne(ctx, list[i], right, false);
  if (ghost) drawOne(ctx, ghost, right, true);
  ctx.restore();
}
