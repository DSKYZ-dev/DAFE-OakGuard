import type { BaseBar } from '@dafe/types';
import {
  barX, priceToY, getPriceRange, xToBarIndex, yToPrice,
  chartRight, type ViewState,
} from './chart-renderer';

export type DrawTool = 'none' | 'trend' | 'ray' | 'hline' | 'rect' | 'fib' | 'channel' | 'text';

interface Point { bar: number; price: number; }
interface Drawing { type: Exclude<DrawTool, 'none'>; a: Point; b?: Point; color: string; text?: string; }

const PALETTE = ['#b48cff', '#22cc88', '#ff4477', '#ffd166', '#4cc9f0'];

// Manual drawings are user-driven and long-lived (never rebuilt fresh like
// an OakScript indicator's per-execution plots), so unlike that system
// nothing here self-cleans — a session of casual clicking could otherwise
// accumulate an unbounded array forever. Cap by RENDER COST, not raw count:
// a fib draws 7 levels + 7 labels every frame, a channel draws 2 lines + a
// fill, while a single hline/text is nearly free — so a handful of fibs
// should count for much more of the budget than the same number of hlines.
const DRAWING_WEIGHT: Record<Drawing['type'], number> = {
  hline: 1, text: 1, trend: 1, ray: 1, rect: 1, channel: 2, fib: 5,
};
const MAX_TOTAL_WEIGHT = 150;

let drawings: Drawing[] = [];
let tool: DrawTool = 'none';
let pending: Point | null = null;
let preview: Point | null = null;
let colorIdx = 0;

export function setTool(t: DrawTool): void {
  tool = t;
  pending = null;
}
export function getTool(): DrawTool { return tool; }
export function isDrawing(): boolean { return tool !== 'none'; }
export function hasPending(): boolean { return pending !== null; }

export function clearDrawings(): void { drawings = []; pending = null; }
export function undoDrawing(): void { if (pending) { pending = null; } else { drawings.pop(); } }
export function count(): number { return drawings.length; }

/** Total render-cost weight currently on the chart (see DRAWING_WEIGHT). */
export function totalWeight(): number {
  let w = 0;
  for (const d of drawings) w += DRAWING_WEIGHT[d.type];
  return w;
}

/** Push a new drawing, then evict the OLDEST drawings (oldest-first, same
 * eviction order as every OakScript object cap) until back under budget —
 * so the toolbar never needs a manual "Clear All" just to stay performant. */
function pushDrawing(d: Drawing): void {
  drawings.push(d);
  let w = totalWeight();
  let i = 0;
  while (w > MAX_TOTAL_WEIGHT && i < drawings.length) {
    w -= DRAWING_WEIGHT[drawings[i].type];
    i++;
  }
  if (i > 0) drawings = drawings.slice(i);
}

/** Convert a screen pixel to a data-anchored point. */
export function screenToPoint(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number): Point {
  const { minP, pRange } = getPriceRange(bars, view, width);
  return {
    bar: Math.round(xToBarIndex(px, bars, view, width)),
    price: yToPrice(py, minP, pRange, height, view),
  };
}

export function onClick(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number): boolean {
  if (tool === 'none') return false;
  const pt = screenToPoint(px, py, bars, view, width, height);
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

export function onMove(px: number, py: number, bars: BaseBar[], view: ViewState, width: number, height: number): void {
  if (tool === 'none' || !pending) { preview = null; return; }
  preview = screenToPoint(px, py, bars, view, width, height);
}

export function drawAll(ctx: CanvasRenderingContext2D, bars: BaseBar[], view: ViewState): void {
  const { width, height } = ctx.canvas;
  const { minP, pRange, start, vLen } = getPriceRange(bars, view, width);
  if (vLen === 0) return;
  const X = (bar: number) => barX(bar - start, vLen, width, view.barSpacing, view.scrollX);
  const Y = (price: number) => priceToY(price, minP, pRange, height, view);
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
      const x = X(d.a.bar), y = Y(d.a.price);
      ctx.font = 'bold 11px "Inter", monospace';
      ctx.fillStyle = d.color;
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.fillText(d.text || '', x + 6, y - 4);
      ctx.shadowBlur = 0;
      return;
    }
    if (!d.b) return;
    const x1 = X(d.a.bar), y1 = Y(d.a.price);
    let x2 = X(d.b.bar), y2 = Y(d.b.price);

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

    if (d.type === 'ray') {
      // Extend beyond the second point to the right edge
      const dx = x2 - x1, dy = y2 - y1;
      if (Math.abs(dx) > 0.001) {
        const t = (right - x1) / dx;
        if (t > 1) { x2 = right; y2 = y1 + dy * t; }
      }
    }

    if (d.type === 'fib') {
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const top = d.a.price, bot = d.b.price;
      ctx.setLineDash(ghost ? [4, 4] : []);
      for (const lv of levels) {
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
      const off = 36; // pixel offset for the parallel channel
      const nx = -dy / len * off, ny = dx / len * off;
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
      ctx.beginPath(); ctx.arc(X(d.b.bar), Y(d.b.price), 3, 0, Math.PI * 2); ctx.fill();
    }
  };

  for (const d of drawings) renderOne(d, false);

  // Live preview while placing the second point of a two-point tool
  if (pending && preview && tool !== 'none' && tool !== 'hline') {
    renderOne({ type: tool, a: pending, b: preview, color: PALETTE[colorIdx % PALETTE.length] }, true);
  }

  ctx.restore();
}
