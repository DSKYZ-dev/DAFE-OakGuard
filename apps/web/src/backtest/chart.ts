import type { BacktestResult } from './types';

/**
 * Minimal custom-canvas equity curve renderer — deliberately NOT reusing
 * chart-renderer.ts, which is built around candle/pane chart state (view
 * transforms, zoom/pan, multi-pane layout) this doesn't need. Colors the
 * in-sample and out-of-sample segments differently with a dashed split
 * marker so the two halves are never visually ambiguous.
 */

const IN_SAMPLE_COLOR = '#22cc88';
const OUT_OF_SAMPLE_COLOR = '#22aaff';
const GRID_COLOR = 'rgba(255,255,255,0.06)';
const SPLIT_LINE_COLOR = 'rgba(255,255,255,0.28)';
const TEXT_COLOR = 'rgba(255,255,255,0.5)';

export function renderEquityCurve(canvas: HTMLCanvasElement, result: BacktestResult): void {
  const ctxOrNull = canvas.getContext('2d');
  if (!ctxOrNull) return;
  // Rebind to a const so the non-null narrowing survives inside the nested
  // drawSegment() closure below (TS re-widens captured `let`/mutable
  // bindings across closure boundaries even when they're never reassigned).
  const ctx = ctxOrNull;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 400;
  const cssHeight = canvas.clientHeight || 160;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const points = result.equityCurve;
  if (points.length < 2) {
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '11px sans-serif';
    ctx.fillText('Not enough data to chart.', 10, cssHeight / 2);
    return;
  }

  const padding = { top: 10, right: 10, bottom: 18, left: 44 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  let minEq = Infinity;
  let maxEq = -Infinity;
  for (const p of points) {
    if (p.equity < minEq) minEq = p.equity;
    if (p.equity > maxEq) maxEq = p.equity;
  }
  if (minEq === maxEq) { minEq -= 1; maxEq += 1; }

  const xForIdx = (i: number) => padding.left + (i / (points.length - 1)) * plotW;
  const yForEq = (eq: number) => padding.top + (1 - (eq - minEq) / (maxEq - minEq)) * plotH;

  // Gridlines
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = padding.top + (g / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(cssWidth - padding.right, y);
    ctx.stroke();
  }

  // Split marker — first equity-curve point that falls after splitBarIdx.
  const splitPointIdx = Math.max(0, points.findIndex(p => p.barIdx > result.splitBarIdx));
  const splitIdx = points[splitPointIdx] && points[splitPointIdx].barIdx > result.splitBarIdx
    ? splitPointIdx
    : points.length - 1;
  const splitX = xForIdx(splitIdx);
  ctx.strokeStyle = SPLIT_LINE_COLOR;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(splitX, padding.top);
  ctx.lineTo(splitX, cssHeight - padding.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  function drawSegment(from: number, to: number, color: string): void {
    if (to <= from) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const x = xForIdx(i);
      const y = yForEq(points[i].equity);
      if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Segments share the boundary point so the line stays visually continuous.
  drawSegment(0, splitIdx + 1, IN_SAMPLE_COLOR);
  drawSegment(splitIdx, points.length, OUT_OF_SAMPLE_COLOR);

  // Axis labels
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`$${maxEq.toFixed(0)}`, padding.left - 4, padding.top + 8);
  ctx.fillText(`$${minEq.toFixed(0)}`, padding.left - 4, cssHeight - padding.bottom - 2);
  ctx.textAlign = 'left';
  ctx.fillStyle = IN_SAMPLE_COLOR;
  ctx.fillText('in-sample', padding.left, cssHeight - 4);
  ctx.fillStyle = OUT_OF_SAMPLE_COLOR;
  ctx.fillText('out-of-sample', Math.min(splitX + 4, cssWidth - 80), cssHeight - 4);
}
