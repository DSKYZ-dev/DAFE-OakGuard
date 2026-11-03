import type { BaseBar, VolumeBin, VolumeProfileMode } from '@dafe/types';
import type { PerBarVolume } from './data-generator';
import type { VisualEngine, VPComputed } from './volume-profile';
import {
  getVisibleRange, barX, chartRight, priceToY, logicalSize,
  TOP_FRAC, BOT_FRAC, RIGHT_MARGIN, type ViewState,
} from './chart-renderer';
import { resolveTheme } from './theme-engine';
import { isBrickType, isCurveType, isZigzagType, isProfileType, engineTreatment } from './rendering-matrix';
import { paintRegimeGlow, regimeBoxes, type RegimeSegment } from './regime-ribbon';
import { biasMix, biasOf, bodySpan, extrusionBox, NEUTRAL_BIAS } from './volume-extrusion';

// ─── Isometric projection ───────────────────────────────────────────
// Cabinet projection: the depth axis recedes up-and-to-the-left.
const ISO_ANGLE = Math.PI / 6.5;        // ~27.7°
const ISO_COS = Math.cos(ISO_ANGLE);
const ISO_SIN = Math.sin(ISO_ANGLE);
const DEPTH_SCALE = 0.62;               // how aggressively depth offsets pixels
const BAR_DEPTH = 0.85;                 // candle extrusion length in "bar units"

/** Project a 3D point (data-x, data-y, depth-z) to screen pixels. */
function project(x: number, y: number, z: number): { x: number; y: number } {
  return {
    x: x - z * ISO_COS * DEPTH_SCALE,
    y: y - z * ISO_SIN * DEPTH_SCALE,
  };
}

/** Deep blue → cyan → green → yellow → red thermal-camera palette keyed by 0..1 intensity. */
function heatColor(t: number): string {
  const stops = resolveTheme().thermalStops;
  const c = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (c >= t0 && c <= t1) {
      const f = (c - t0) / (t1 - t0 || 1);
      const r = Math.round(r0 + (r1 - r0) * f);
      const g = Math.round(g0 + (g1 - g0) * f);
      const b = Math.round(b0 + (b1 - b0) * f);
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }
  }
  return '#ff3c14';
}

function shade(hex: string, factor: number): string {
  // hex like #rrggbb → multiply rgb by factor
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor);
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

function withAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function hexToRgba(col: string, a: number): string {
  if (col.startsWith('#')) {
    const r = parseInt(col.slice(1, 3), 16);
    const g = parseInt(col.slice(3, 5), 16);
    const b = parseInt(col.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  // Already rgba(...)
  return col.replace(/[\d.]+\)$/, `${a})`);
}

/** Draw an extruded box (front face + top cap + right side) for a candle body. */
function extrudedBox(
  ctx: CanvasRenderingContext2D,
  fx: number, fyTop: number, fyBot: number, bw: number, depth: number,
  color: string,
) {
  const fb = project(fx, fyBot, 0);
  const ft = project(fx, fyTop, 0);
  const ftR = project(fx + bw, fyTop, 0);
  const fbR = project(fx + bw, fyBot, 0);
  const bt = project(fx, fyTop, depth);
  const btR = project(fx + bw, fyTop, depth);
  const bbR = project(fx + bw, fyBot, depth);

  // Right side face (darkest)
  ctx.fillStyle = shade(color, 0.45);
  ctx.beginPath();
  ctx.moveTo(fbR.x, fbR.y); ctx.lineTo(ftR.x, ftR.y);
  ctx.lineTo(btR.x, btR.y); ctx.lineTo(bbR.x, bbR.y); ctx.closePath(); ctx.fill();

  // Top cap (mid-light, only visible if body has height)
  if (Math.abs(fyBot - fyTop) > 0.5) {
    ctx.fillStyle = shade(color, 1.18);
    ctx.beginPath();
    ctx.moveTo(ft.x, ft.y); ctx.lineTo(ftR.x, ftR.y);
    ctx.lineTo(btR.x, btR.y); ctx.lineTo(bt.x, bt.y); ctx.closePath(); ctx.fill();
  }

  // Front face (brightest)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y);
  ctx.lineTo(ftR.x, ftR.y); ctx.lineTo(fbR.x, fbR.y); ctx.closePath(); ctx.fill();

  // Edge highlight on the front
  ctx.strokeStyle = withAlpha(color, 0.9);
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ─── 3D line / area series ──────────────────────────────────────────
// Renders the close-price curve as a projected ribbon in the iso scene so the
// Line and Area chart types read as a continuous line (with an optional filled
// skirt for Area), not a row of bars.
function draw3DLineSeries(
  ctx: CanvasRenderingContext2D,
  visible: { close: number }[],
  vLen: number,
  p2y: (p: number) => number,
  view: ViewState,
  bs: number,
  width: number,
  height: number,
  fill: boolean,
): void {
  const lineCol = '#38d0ff';
  // Centre the curve on each bar's front-face column.
  const bw = Math.max(1.2, bs * 0.72);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < vLen; i++) {
    const cx = barX(i, vLen, width, bs, view.scrollX) + bw / 2;
    const p = project(cx, p2y(visible[i].close), 0);
    pts.push({ x: p.x, y: p.y });
  }
  if (pts.length === 0) return;

  ctx.save();
  if (fill) {
    // Skirt down to the floor of the price area, following the projected base.
    const floorY = height * BOT_FRAC;
    const baseL = project(barX(0, vLen, width, bs, view.scrollX) + bw / 2, floorY, 0);
    const baseR = project(barX(vLen - 1, vLen, width, bs, view.scrollX) + bw / 2, floorY, 0);
    const grad = ctx.createLinearGradient(0, pts[0].y, 0, baseL.y);
    grad.addColorStop(0, withAlpha(lineCol, 0.32));
    grad.addColorStop(1, withAlpha(lineCol, 0.02));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseL.x, baseL.y);
    for (const pt of pts) ctx.lineTo(pt.x, pt.y);
    ctx.lineTo(baseR.x, baseR.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.shadowBlur = 12;
  ctx.shadowColor = withAlpha(lineCol, 0.6);
  ctx.strokeStyle = lineCol;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  // Node dots for readability
  ctx.shadowBlur = 0;
  ctx.fillStyle = lineCol;
  const step = pts.length > 120 ? 4 : 1;
  for (let i = 0; i < pts.length; i += step) {
    ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Kagi is a reversal chart — a continuous stepped line whose thickness/colour
// flips at yin/yang turns — not a row of bars. Map its (few) reversal points
// across the full visible width so it reads as a clean zigzag instead of a
// cluster of candles jammed at the newest edge.
function draw3DKagiSeries(
  ctx: CanvasRenderingContext2D,
  visible: { open: number; close: number }[],
  vLen: number,
  p2y: (p: number) => number,
  _view: ViewState,
  width: number,
): void {
  if (vLen < 2) return;
  // Kagi has few reversal points — spread them evenly across the full plot
  // width (rather than by bar spacing, which would jam them at the newest
  // edge) so the zigzag reads across the whole chart.
  const left = 12;
  const rightEdge = chartRight(width);
  const span = Math.max(1, rightEdge - left);
  const xs: number[] = [];
  for (let i = 0; i < vLen; i++) xs.push(left + (i / (vLen - 1)) * span);
  const theme = resolveTheme();
  const up = theme.bull, dn = theme.bear;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 1; i < vLen; i++) {
    const rising = visible[i].close >= visible[i].open;
    const col = rising ? up : dn;
    const yPrev = p2y(visible[i - 1].close);
    const yCur = p2y(visible[i].close);
    const a = project(xs[i - 1], yPrev, 0);
    const b = project(xs[i], yPrev, 0);   // horizontal leg at prior level
    const c = project(xs[i], yCur, 0);    // vertical leg to new level
    ctx.strokeStyle = col;
    ctx.lineWidth = rising ? 3.4 : 1.8;   // yang (up) thicker than yin (down)
    ctx.shadowBlur = 8;
    ctx.shadowColor = withAlpha(col, 0.5);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── Graph-paper background (3D "graph" mode) ───────────────────────
// Static (never self-animates) and anchored to the chart's view transform, so
// it pans and scales WITH the chart under any zoom/pan/stretch/compress and
// stays perfectly still when the chart is still.
function drawGraph3DBackground(ctx: CanvasRenderingContext2D, view: ViewState): void {
  const { width, height } = logicalSize(ctx);
  ctx.fillStyle = '#070713';
  ctx.fillRect(0, 0, width, height);

  const sx = view.scrollX || 0;
  const oy = view.offsetY || 0;
  // Cell size tracks horizontal zoom (barSpacing) and vertical zoom (scaleY).
  const colStep = Math.max(16, (view.barSpacing || 8) * 4);
  const rowStep = Math.max(16, 40 * (view.scaleY || 1));
  const wrap = (off: number, step: number) => ((off % step) + step) % step;

  // Minor grid — anchored to scroll/offset so it moves with the chart.
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(40,40,80,0.30)';
  ctx.beginPath();
  for (let x = -wrap(sx, colStep); x <= width; x += colStep) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = -wrap(oy, rowStep); y <= height; y += rowStep) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();

  // Major grid every 4 cells — brighter, same anchoring.
  const majX = colStep * 4, majY = rowStep * 4;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(70,70,130,0.42)';
  ctx.beginPath();
  for (let x = -wrap(sx, majX); x <= width; x += majX) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = -wrap(oy, majY); y <= height; y += majY) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();
}

// ─── Atmospheric background ─────────────────────────────────────────
// `stars` gates the twinkling starfield so non-star modes (particles) keep the
// nebula glow without the stars.
function drawAtmosphere(ctx: CanvasRenderingContext2D, time: number, stars: boolean = true): void {
  const { width, height } = logicalSize(ctx);

  // Deep space gradient
  const g = ctx.createRadialGradient(width * 0.5, height * 0.38, 0, width * 0.5, height * 0.5, width * 0.9);
  g.addColorStop(0, '#241d4a');
  g.addColorStop(0.35, '#110c28');
  g.addColorStop(0.75, '#070415');
  g.addColorStop(1, '#020105');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Subtle starfield (only in the dedicated "stars" background)
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (stars) {
    const starSeed = 12345;
    const pseudo = (n: number) => {
      const x = Math.sin(starSeed + n) * 10000;
      return x - Math.floor(x);
    };
    for (let i = 0; i < 120; i++) {
      const sx = pseudo(i * 2) * width;
      const sy = pseudo(i * 3) * height;
      const size = 0.4 + pseudo(i) * 1.2;
      const twinkle = 0.35 + 0.35 * Math.sin(time * 0.0015 + i * 0.7);
      ctx.fillStyle = `rgba(255,255,255,${twinkle})`;
      ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Drifting nebula wisps — richer colors
  for (let i = 0; i < 4; i++) {
    const t = time * 0.00006 + i * 1.7;
    const cx = width * (0.2 + 0.6 * Math.sin(t));
    const cy = height * (0.35 + 0.35 * Math.cos(t * 0.6));
    const r = Math.max(100, width * (0.18 + i * 0.04));
    const ng = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const cols = [
      '120,80,255',   // purple
      '34,204,136',   // green
      '76,201,240',   // cyan
      '255,80,180',   // pink
    ];
    const col = cols[i];
    ng.addColorStop(0, `rgba(${col},0.13)`);
    ng.addColorStop(0.45, `rgba(${col},0.05)`);
    ng.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = ng;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();

  // Soft vignette
  const vg = ctx.createRadialGradient(width * 0.5, height * 0.5, height * 0.25, width * 0.5, height * 0.5, width * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, width, height);

  // Top/Bottom light sheen
  const sg = ctx.createLinearGradient(0, 0, 0, height);
  sg.addColorStop(0, 'rgba(180,140,255,0.04)');
  sg.addColorStop(0.5, 'rgba(180,140,255,0)');
  sg.addColorStop(1, 'rgba(34,204,136,0.03)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, width, height);
}

// ─── Perspective floor grid ─────────────────────────────────────────
function drawFloorGrid(
  ctx: CanvasRenderingContext2D,
  bars: BaseBar[], view: ViewState, minP: number, pRange: number,
): void {
  const { width, height } = logicalSize(ctx);
  const { start, end } = getVisibleRange(view, width, bars.length);
  const vLen = Math.max(0, Math.min(end, bars.length - 1) - Math.max(0, start) + 1);
  if (vLen === 0) return;
  const cBot = height * BOT_FRAC;
  const floorY = cBot + 8;
  const bs = view.barSpacing;
  const x0 = barX(0, vLen, width, bs, view.scrollX);
  const x1 = barX(vLen - 1, vLen, width, bs, view.scrollX);
  const depth = BAR_DEPTH * bs * 1.6;

  ctx.save();
  ctx.lineWidth = 1;
  // Batch all receding depth lines into a single path + shared gradient
  const cols = Math.min(28, vLen);
  const a0 = project(x0, floorY, 0);
  const b0 = project(x0, floorY, depth);
  const colGrad = ctx.createLinearGradient(0, a0.y, 0, b0.y);
  colGrad.addColorStop(0, 'rgba(180,140,255,0.18)');
  colGrad.addColorStop(1, 'rgba(180,140,255,0.02)');
  ctx.strokeStyle = colGrad;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const t = i / cols;
    const fx = x0 + (x1 - x0) * t;
    const a = project(fx, floorY, 0);
    const b = project(fx, floorY, depth);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // Batch horizontal depth lines into a single path + shared gradient
  const rows = 6;
  const rStart = project(x0, floorY, 0);
  const rEnd = project(x1, floorY, 0);
  const rowGrad = ctx.createLinearGradient(rStart.x, 0, rEnd.x, 0);
  rowGrad.addColorStop(0, 'rgba(180,140,255,0.16)');
  rowGrad.addColorStop(1, 'rgba(180,140,255,0.03)');
  ctx.strokeStyle = rowGrad;
  ctx.beginPath();
  for (let r = 0; r <= rows; r++) {
    const z = (r / rows) * depth;
    const a = project(x0, floorY, z);
    const b = project(x1, floorY, z);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  // Glow point where grid converges
  const converge = project(x0 + (x1 - x0) * 0.5, floorY, depth);
  const glow = ctx.createRadialGradient(converge.x, converge.y, 0, converge.x, converge.y, depth * 0.35);
  glow.addColorStop(0, 'rgba(180,140,255,0.10)');
  glow.addColorStop(1, 'rgba(180,140,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

// ─── 3D Volume rendering ────────────────────────────────────────────
// Draw per-bar volume profile as an extruded bar ON TOP of each candle.
// The front face sits at z=0 (the candle plane) so it covers the candle
// body; depth extrudes backward. Alpha lets the OHLC remain readable.
interface VolFacePts {
  fb: { x: number; y: number }; ft: { x: number; y: number };
  rb: { x: number; y: number }; rt: { x: number; y: number };
  bb: { x: number; y: number }; bt: { x: number; y: number };
  brb: { x: number; y: number }; brt: { x: number; y: number };
  top: number; bot: number; ratio: number; i: number; bw: number;
}

/** The buy share of a level, as the part of its depth nearest the candle plane. */
interface VolSplit {
  buyShare: number;
  buyCol: string;
  sellCol: string;
}

function drawVolumeBlock(
  ctx: CanvasRenderingContext2D,
  engine: VisualEngine,
  pts: VolFacePts,
  baseCol: string,
  split: VolSplit | null,
): void {
  const { fb, ft, rb, rt, bb, bt, brb, brt, top, bot, ratio, i } = pts;
  const center = { x: (fb.x + brb.x) / 2, y: (fb.y + brt.y) / 2 };

  switch (engine) {
    case 'Thermal': {
      // Heat map of bias: the buy share glows the bull colour and the sell share
      // the bear colour, split along the extrusion in proportion to volume.
      // Brightness is the level's share of the window's largest volume.
      const alpha = 0.32 + ratio * 0.4;
      const g = ctx.createLinearGradient(fb.x, fb.y, bb.x, bb.y);
      if (split) {
        g.addColorStop(0, hexToRgba(split.buyCol, alpha));
        g.addColorStop(split.buyShare, hexToRgba(split.buyCol, alpha));
        g.addColorStop(split.buyShare, hexToRgba(split.sellCol, alpha));
        g.addColorStop(1, hexToRgba(split.sellCol, alpha));
      } else {
        g.addColorStop(0, hexToRgba(baseCol, alpha));
        g.addColorStop(1, hexToRgba(baseCol, alpha * 0.12));
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(bb.x, bb.y); ctx.closePath();
      ctx.fill();
      // Core glow and outline on the front face, in the dominant side's colour.
      const dominant = split ? (split.buyShare >= 0.5 ? split.buyCol : split.sellCol) : baseCol;
      const cg = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, Math.abs(rt.x - fb.x) * 1.1);
      cg.addColorStop(0, hexToRgba('#ffffff', ratio * 0.22));
      cg.addColorStop(0.5, hexToRgba(dominant, ratio * 0.22));
      cg.addColorStop(1, hexToRgba(dominant, 0));
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hexToRgba(dominant, 0.75);
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'Nebula': {
      // Dropped the additive 'lighter' blend — with many stacked volume levels
      // per bar it summed straight to blown-out white regardless of alpha.
      // Plain alpha blending with a modest ceiling stays readable at any density.
      ctx.save();
      const alpha = 0.14 + ratio * 0.22;
      const r = Math.max(3, Math.abs(rt.x - fb.x) * 1.0);
      const g = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r + ratio * 8);
      g.addColorStop(0, hexToRgba('#ffffff', alpha * 0.35));
      g.addColorStop(0.3, hexToRgba(baseCol, alpha));
      g.addColorStop(0.65, hexToRgba(baseCol, alpha * 0.3));
      g.addColorStop(1, hexToRgba(baseCol, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r + ratio * 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }

    case 'Quantum': {
      ctx.strokeStyle = 'rgba(0,240,255,0.7)';
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 5;
      ctx.shadowColor = 'rgba(0,240,255,0.3)';
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.stroke();
      // Secondary pulse line
      ctx.strokeStyle = 'rgba(0,240,255,0.25)';
      ctx.lineWidth = 0.8;
      ctx.shadowBlur = 2;
      ctx.beginPath();
      ctx.moveTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(brt.x, brt.y); ctx.lineTo(rt.x, rt.y);
      ctx.moveTo(bb.x, bb.y); ctx.lineTo(brb.x, brb.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }

    case 'Neon Wireframe': {
      ctx.strokeStyle = hexToRgba(baseCol, 0.95);
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 10;
      ctx.shadowColor = hexToRgba(baseCol, 0.5);
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.moveTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(brt.x, brt.y); ctx.lineTo(rt.x, rt.y);
      ctx.moveTo(bt.x, bt.y); ctx.lineTo(bb.x, bb.y); ctx.lineTo(brb.x, brb.y); ctx.lineTo(brt.x, brt.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }

    case 'DNA': {
      // Real double helix: two strands 180° out of phase (mirror images of
      // each other) so they visibly cross, plus base-pair rungs between them
      // colored by which strand is "forward" at that point — reads like an
      // actual DNA render rather than one wavy line traced twice.
      const turns = 2.2;
      const amp = (bot - top) * 0.42;
      const midY = (fb.y + ft.y) / 2;
      const steps = 16;
      const strandPts: { x: number; y: number }[][] = [[], []];
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const px = fb.x + (bb.x - fb.x) * t;
        const ang = (t * turns + i * 0.15) * Math.PI * 2;
        strandPts[0].push({ x: px, y: midY + Math.sin(ang) * amp });
        strandPts[1].push({ x: px, y: midY + Math.sin(ang + Math.PI) * amp });
      }
      ctx.lineCap = 'round';
      const strandCols = [baseCol, '#ffffff'];
      for (let s = 0; s < 2; s++) {
        ctx.strokeStyle = hexToRgba(strandCols[s], 0.85);
        ctx.lineWidth = 2.2;
        ctx.shadowBlur = 5;
        ctx.shadowColor = hexToRgba(strandCols[s], 0.3);
        ctx.beginPath();
        strandPts[s].forEach((p, k) => k === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // Base-pair rungs — only where strands are far enough apart to read as rungs
      const rungStep = Math.max(1, Math.floor(steps / 8));
      for (let step = 0; step <= steps; step += rungStep) {
        const p0 = strandPts[0][step], p1 = strandPts[1][step];
        if (Math.abs(p0.y - p1.y) < amp * 0.3) continue;
        ctx.strokeStyle = hexToRgba(baseCol, 0.4);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      break;
    }

    case 'Constellation': {
      const nodes = [fb, ft, rb, rt, bb, bt, brb, brt];
      ctx.fillStyle = hexToRgba('#ffffff', 0.9);
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 2.2 + ratio * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // All connecting lines white — the front/back box outlines carry no
      // dominance signal, only the four depth-axis (front→back) lines do.
      ctx.strokeStyle = hexToRgba('#ffffff', 0.55);
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.moveTo(bt.x, bt.y); ctx.lineTo(bb.x, bb.y); ctx.lineTo(brb.x, brb.y); ctx.lineTo(brt.x, brt.y); ctx.closePath();
      ctx.stroke();
      // Depth (horizontal, front-to-back) lines carry the buy/sell dominance color
      ctx.strokeStyle = hexToRgba(baseCol, 0.95);
      ctx.lineWidth = 1.4;
      ctx.shadowBlur = 6;
      ctx.shadowColor = hexToRgba(baseCol, 0.4);
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(bb.x, bb.y);
      ctx.moveTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y);
      ctx.moveTo(rb.x, rb.y); ctx.lineTo(brb.x, brb.y);
      ctx.moveTo(rt.x, rt.y); ctx.lineTo(brt.x, brt.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }

    case 'Liquid Metal': {
      const g = ctx.createLinearGradient(fb.x, top, fb.x, bot);
      g.addColorStop(0, hexToRgba('#ffffff', 0.9));
      g.addColorStop(0.22, hexToRgba(baseCol, 0.85));
      g.addColorStop(0.48, hexToRgba('#ffffff', 0.7));
      g.addColorStop(0.74, hexToRgba(baseCol, 0.85));
      g.addColorStop(1, hexToRgba('#000000', 0.5));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.fill();
      // Left side with depth shade
      ctx.fillStyle = shade(baseCol, 0.55);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(bb.x, bb.y); ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // Edge stroke
      ctx.strokeStyle = hexToRgba('#ffffff', 0.6);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.lineTo(fb.x, fb.y); ctx.closePath();
      ctx.stroke();
      break;
    }

    case '3D-Depth':
    default: {
      const fillFace = (face: { x: number; y: number }[], brightness: number, alpha = 0.92, col = baseCol) => {
        ctx.fillStyle = shade(col, brightness);
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(face[0].x, face[0].y);
        for (let k = 1; k < face.length; k++) ctx.lineTo(face[k].x, face[k].y);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      };
      // In cabinet projection (depth recedes up-and-left), the back face and the
      // inner right face are hidden behind the visible left, top and front faces,
      // so only those three are drawn.
      const hasTop = Math.abs(bot - top) > 0.5;
      if (split && split.buyShare > 0 && split.buyShare < 1) {
        // Each side is two faces that meet exactly at the split: the buy share
        // nearest the candle plane, the sell share behind it. Their lengths are
        // the volume proportions.
        const f = split.buyShare;
        const along = (a: { x: number; y: number }, b: { x: number; y: number }) =>
          ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
        const mt = along(ft, bt);
        const mb = along(fb, bb);
        const mrt = along(rt, brt);
        fillFace([fb, ft, mt, mb], 0.55, 0.82, split.buyCol);
        fillFace([mb, mt, bt, bb], 0.55, 0.82, split.sellCol);
        if (hasTop) {
          fillFace([ft, rt, mrt, mt], 1.08, 0.85, split.buyCol);
          fillFace([mt, mrt, brt, bt], 1.08, 0.85, split.sellCol);
        }
        fillFace([fb, ft, rt, rb], 1.0, 0.92, baseCol);
      } else {
        const col = split ? (split.buyShare >= 1 ? split.buyCol : split.sellCol) : baseCol;
        fillFace([fb, ft, bt, bb], 0.55, 0.82, col);
        if (hasTop) fillFace([ft, rt, brt, bt], 1.08, 0.85, col);
        fillFace([fb, ft, rt, rb], 1.0, 0.92, col);
      }
      // Strong edge definition on the front face, in the front colour.
      const front = baseCol;
      ctx.strokeStyle = hexToRgba(front, 0.6);
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.stroke();
      break;
    }
  }
}

function draw3DVolume(
  ctx: CanvasRenderingContext2D,
  visible: BaseBar[], start: number, vLen: number, minP: number, pRange: number,
  view: ViewState, perBarVols: PerBarVolume[] | undefined, vpiEnabled: boolean,
  volumeMode: VolumeProfileMode, visualEngine: VisualEngine,
  profileWidth: number, vpComputed?: VPComputed,
): void {
  const { width, height } = logicalSize(ctx);
  const bs = view.barSpacing;
  const p2y = (p: number) => priceToY(p, minP, pRange, height, view);

  if (!perBarVols || !vpiEnabled || vLen === 0) return;

  // One depth scale for the whole visible window: the largest level is the full
  // depth, and every other level extrudes in proportion to its volume.
  let maxVolume = 0;
  for (let i = 0; i < vLen; i++) {
    const pv = perBarVols[start + i];
    if (!pv) continue;
    for (const lv of pv.levels) if (lv.volume > maxVolume) maxVolume = lv.volume;
  }
  if (maxVolume <= 0) return;
  const maxDepth = bs * 1.5;

  ctx.save();

  // Heatmap mode uses the thermal engine. Both modes colour by bias.
  const engine: VisualEngine = volumeMode === '3D-Heatmap' ? 'Thermal' : visualEngine;
  const candleBw = Math.max(1.2, bs * 0.72);
  const widthFactor = Math.min(1, 0.85 + (profileWidth / 100) * 0.6);
  const colors = vpComputed?.colors;
  const theme = resolveTheme();
  const bull = colors ? colors.bull : theme.bull;
  const bear = colors ? colors.bear : theme.bear;

  for (let i = vLen - 1; i >= 0; i--) {
    const pv = perBarVols[start + i];
    if (!pv || pv.levels.length === 0) continue;
    const x = barX(i, vLen, width, bs, view.scrollX);
    if (x < -bs * 2 || x > width + bs * 2) continue;
    // The front face spans x..x+candleBw; the profile is centred on it.
    const { left, right } = bodySpan(x, candleBw, widthFactor);
    const bw = right - left;

    for (const lv of pv.levels) {
      const yA = p2y(lv.hi);
      const yB = p2y(lv.lo);
      const box = extrusionBox({
        top: Math.min(yA, yB),
        bottom: Math.max(yA, yB),
        volume: lv.volume,
        buyVolume: lv.buyVol,
        maxVolume,
        maxDepth,
      });
      if (!box || box.depth < 0.25) continue;
      const pts: VolFacePts = {
        fb: project(left, box.bottom, 0),
        ft: project(left, box.top, 0),
        rb: project(right, box.bottom, 0),
        rt: project(right, box.top, 0),
        bb: project(left, box.bottom, box.depth),
        bt: project(left, box.top, box.depth),
        brb: project(right, box.bottom, box.depth),
        brt: project(right, box.top, box.depth),
        top: box.top,
        bot: box.bottom,
        ratio: box.share,
        i,
        bw,
      };
      const baseCol = biasMix(biasOf(lv), bull, bear, NEUTRAL_BIAS);
      drawVolumeBlock(ctx, engine, pts, baseCol, { buyShare: box.buyShare, buyCol: bull, sellCol: bear });
    }
  }
  ctx.restore();
}
// ─── Main 3D scene entry ────────────────────────────────────────────
export interface Scene3DOptions {
  barType: string;
  perBarVols?: PerBarVolume[];
  volumeBins?: VolumeBin[];
  volumeMode: VolumeProfileMode;
  visualEngine: VisualEngine;
  volumeEnabled: boolean;
  vpiEnabled: boolean;
  time: number;
  profileWidth?: number;
  vpComputed?: VPComputed;
  bgViz?: 'particles' | 'stars' | 'graph' | 'plain';
  /** Regime history for the coloured fog: runs of one regime over absolute bar indices. */
  regimeSegments?: RegimeSegment[];
  plots?: Array<{
    type?: string;
    name?: string;
    series?: number[];
    color?: string;
    barIdx?: number;
    price?: number;
    size?: number;
    z_level?: number;
  }>;
}

function draw3DIndicatorPlots(
  ctx: CanvasRenderingContext2D,
  plots: NonNullable<Scene3DOptions['plots']>,
  start: number,
  vLen: number,
  width: number,
  height: number,
  bs: number,
  view: ViewState,
  minP: number,
  pRange: number,
): void {
  for (const plot of plots) {
    const color = plot.color || '#b48cff';
    if (plot.type === 'plot3d' && Array.isArray(plot.series)) {
      const series = plot.series;
      const values = plot.series.slice(start, start + vLen).filter(Number.isFinite);
      if (values.length < 2) continue;
      const lo = Math.min(...values);
      const span = Math.max(Number.EPSILON, Math.max(...values) - lo);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 8;
      ctx.shadowColor = color;
      const depth = Math.max(5, bs * 0.9);
      const drawPath = (offset: number): void => {
        ctx.beginPath();
        let moved = false;
        for (let i = 0; i < vLen; i++) {
          const value = series[start + i];
          if (!Number.isFinite(value)) { moved = false; continue; }
          const x = barX(i, vLen, width, bs, view.scrollX);
          const y = priceToY(minP + ((value - lo) / span) * pRange, minP, pRange, height, view);
          const point = project(x, y, offset);
          if (!moved) { ctx.moveTo(point.x, point.y); moved = true; }
          else ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();
      };
      ctx.globalAlpha = 0.3;
      drawPath(depth);
      ctx.globalAlpha = 0.9;
      drawPath(0);
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      for (let i = 1; i < vLen; i++) {
        const a = series[start + i - 1];
        const b = series[start + i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const ay = priceToY(minP + ((a - lo) / span) * pRange, minP, pRange, height, view);
        const by = priceToY(minP + ((b - lo) / span) * pRange, minP, pRange, height, view);
        const a0 = project(barX(i - 1, vLen, width, bs, view.scrollX), ay, 0);
        const a1 = project(barX(i - 1, vLen, width, bs, view.scrollX), ay, depth);
        const b0 = project(barX(i, vLen, width, bs, view.scrollX), by, 0);
        const b1 = project(barX(i, vLen, width, bs, view.scrollX), by, depth);
        ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b0.x, b0.y); ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = 0.12; ctx.fill();
      }
      ctx.restore();
    } else if (plot.type === 'plot3d_shape' && typeof plot.barIdx === 'number' && typeof plot.price === 'number') {
      const idx = plot.barIdx - start;
      if (idx < 0 || idx >= vLen || !Number.isFinite(plot.price)) continue;
      const x = barX(idx, vLen, width, bs, view.scrollX);
      const point = project(x, priceToY(plot.price, minP, pRange, height, view), (plot.z_level || 0) * bs * 0.15);
      const radius = Math.max(3, Math.min(12, (plot.size || 1) * 4));
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowBlur = 10;
      ctx.shadowColor = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

export function draw3DScene(
  ctx: CanvasRenderingContext2D,
  bars: BaseBar[],
  view: ViewState,
  opts: Scene3DOptions,
): void {
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

  // Atmosphere + floor — respect bgViz setting.
  //   plain     → solid dark, no decoration
  //   graph     → graph-paper background (no stars)
  //   particles → nebula glow only (no stars; GPU particles drawn on top)
  //   stars     → full atmosphere WITH starfield
  if (opts.bgViz === 'plain') {
    ctx.fillStyle = '#0a0a18';
    ctx.fillRect(0, 0, width, height);
  } else if (opts.bgViz === 'graph') {
    drawGraph3DBackground(ctx, view);
  } else {
    drawAtmosphere(ctx, opts.time, opts.bgViz === 'stars' || opts.bgViz === undefined);
  }
  if (opts.bgViz !== 'plain') drawFloorGrid(ctx, bars, view, minP, pRange);

  const bs = view.barSpacing;
  const bw = Math.max(1.2, bs * 0.72);
  const p2y = (p: number) => priceToY(p, minP, pRange, height, view);
  // Depth is capped at half a bar: the cabinet shift moves the back face left,
  // and a deeper candle would run into the bar before it.
  const depth = Math.min(BAR_DEPTH * bs, bs * 0.5);

  if (opts.regimeSegments?.length) paintRegimeGlow(ctx, regimeBoxes(opts.regimeSegments, bars, start, end, (abs) => barX(abs - start, vLen, width, bs, view.scrollX), p2y, bw / 2), 'back');

  // ── Adaptive bar-type dispatch ──
  // Line / area chart types are a continuous curve, not per-bar solids — draw
  // them as a projected 3D ribbon instead of candles.
  if (isCurveType(opts.barType as any)) {
    draw3DLineSeries(ctx, visible, vLen, p2y, view, bs, width, height, opts.barType === 'area');
  } else if (isZigzagType(opts.barType as any)) {
    draw3DKagiSeries(ctx, visible, vLen, p2y, view, width);
  } else {
  // ── Candles / bricks / footprint: paint right-to-left so left bars (front) occlude right bars' tails ──
  const theme = resolveTheme();
  const treatment = engineTreatment(opts.visualEngine);
  const isBrick = isBrickType(opts.barType as any);
  const isFootprint = isProfileType(opts.barType as any);
  ctx.save();
  for (let i = vLen - 1; i >= 0; i--) {
    const bar = visible[i];
    const x = barX(i, vLen, width, bs, view.scrollX);
    if (x < -bs * 2 || x > width + bs * 2) continue;
    const openY = p2y(bar.open);
    const closeY = p2y(bar.close);
    const highY = p2y(bar.high);
    const lowY = p2y(bar.low);
    const isBull = bar.close >= bar.open;
    const intensity = Math.min(1, bar.volume / 3000);
    // Apply the visual engine's body color treatment
    const color = treatment.bodyColor(isBull, intensity);
    const bTop = Math.min(openY, closeY);
    const bBot = Math.max(openY, closeY);
    const bH = Math.max(1.5, bBot - bTop);

    // Atmospheric depth fade: bars further "back" (right, higher z) dim slightly
    const depthFade = 1 - (i / vLen) * 0.18;

    // Fast translucent halo pass instead of per-face Gaussian shadowBlur
    // (ctx.shadowBlur ran 5 blur kernels per candle = ~750 blurs/frame).
    ctx.shadowBlur = 0;

    // Wick: bold extruded line from low to high. Brick types carry no
    // meaningful wick (open==high or ==low after transform), so this
    // naturally renders as a clean brick for them.
    if (!isBrick) {
      const wFront = project(x, highY, 0);
      const wBack = project(x, lowY, 0);
      if (treatment.glow) {
        ctx.strokeStyle = withAlpha(color, 0.22 * depthFade);
        ctx.lineWidth = 7.0;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(wFront.x, wFront.y); ctx.lineTo(wBack.x, wBack.y); ctx.stroke();
      }
      ctx.strokeStyle = withAlpha(color, 0.95 * depthFade);
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(wFront.x, wFront.y); ctx.lineTo(wBack.x, wBack.y); ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Body as extruded pillar (hex color so face-shading works)
    extrudedBox(ctx, x, bTop, bBot, bw, depth, color);

    // Wireframe overlay for Quantum/Neon Wireframe/Constellation engines
    if (treatment.wireframe) {
      ctx.strokeStyle = withAlpha(color, 0.8);
      ctx.lineWidth = 1.2;
      const fb = project(x, bBot, 0);
      const ft = project(x, bTop, 0);
      const fbR = project(x + bw, bBot, 0);
      const ftR = project(x + bw, bTop, 0);
      const bb = project(x, bBot, depth);
      const bt = project(x, bTop, depth);
      const bbR = project(x + bw, bBot, depth);
      const btR = project(x + bw, bTop, depth);
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(ftR.x, ftR.y); ctx.lineTo(fbR.x, fbR.y); ctx.closePath();
      ctx.moveTo(bb.x, bb.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(btR.x, btR.y); ctx.lineTo(bbR.x, bbR.y); ctx.closePath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(bb.x, bb.y);
      ctx.moveTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y);
      ctx.moveTo(fbR.x, fbR.y); ctx.lineTo(bbR.x, bbR.y);
      ctx.moveTo(ftR.x, ftR.y); ctx.lineTo(btR.x, btR.y);
      ctx.stroke();
    }

    // Thin black definition border on the right edge of the front face
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1.0;
    const fb = project(x, bBot, 0);
    const ft = project(x, bTop, 0);
    const fbR = project(x + bw, bBot, 0);
    const ftR = project(x + bw, bTop, 0);
    ctx.beginPath();
    ctx.moveTo(fbR.x, fbR.y); ctx.lineTo(ftR.x, ftR.y);
    ctx.stroke();

    // Zero-allocation front-face specular sheen (mid-band highlight)
    if (bH > 3) {
      const mTop = ft.y + (fb.y - ft.y) * 0.28;
      const mBot = ft.y + (fb.y - ft.y) * 0.68;
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(ft.x, mTop, ftR.x - ft.x, mBot - mTop);
    }
  }
  ctx.restore();
  }

  if (opts.regimeSegments?.length) paintRegimeGlow(ctx, regimeBoxes(opts.regimeSegments, bars, start, end, (abs) => barX(abs - start, vLen, width, bs, view.scrollX), p2y, bw / 2), 'front');

  // Volume profile renders ON TOP of candles so the extruded boxes cover the
  // candle bodies. Skip it entirely for line/area — the per-bar VPI voxels
  // would bury the curve and make Line look identical to the bar types.
  const isCurve = opts.barType === 'line' || opts.barType === 'area' || opts.barType === 'kagi';
  if (!isCurve && opts.volumeEnabled && (opts.volumeMode === '3D-Extrude' || opts.volumeMode === '3D-Heatmap')) {
    draw3DVolume(ctx, visible, start, vLen, minP, pRange, view, opts.perBarVols, opts.vpiEnabled, opts.volumeMode, opts.visualEngine, opts.profileWidth ?? 50, opts.vpComputed);
  }



  if (opts.plots?.length) {
    draw3DIndicatorPlots(ctx, opts.plots, start, vLen, width, height, bs, view, minP, pRange);
  }

  // Right-edge price axis (in 3D space, receding)
  const right = chartRight(width);
  const cBot = height * BOT_FRAC;
  const cTop = height * TOP_FRAC;
  const axDepth = depth * 1.4;
  const axTop = project(right, cTop, axDepth);
  const axBot = project(right, cBot, axDepth);
  ctx.strokeStyle = 'rgba(180,140,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(axTop.x, axTop.y); ctx.lineTo(axBot.x, axBot.y); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '9px monospace';
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const price = minP + pRange * (1 - t);
    const y = cTop + (cBot - cTop) * t;
    const p = project(right, y, axDepth);
    ctx.fillText(price.toFixed(2), p.x + 6, p.y + 3);
  }
}
