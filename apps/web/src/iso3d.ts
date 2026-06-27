import type { BaseBar, VolumeBin, VolumeProfileMode } from '@dafe/types';
import type { PerBarVolume } from './data-generator';
import type { VisualEngine, VPComputed } from './volume-profile';
import {
  getVisibleRange, barX, chartRight, priceToY,
  TOP_FRAC, BOT_FRAC, RIGHT_MARGIN, type ViewState,
} from './chart-renderer';

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

// ─── Atmospheric background ─────────────────────────────────────────
function drawAtmosphere(ctx: CanvasRenderingContext2D, time: number): void {
  const { width, height } = ctx.canvas;

  // Deep space gradient
  const g = ctx.createRadialGradient(width * 0.5, height * 0.38, 0, width * 0.5, height * 0.5, width * 0.9);
  g.addColorStop(0, '#241d4a');
  g.addColorStop(0.35, '#110c28');
  g.addColorStop(0.75, '#070415');
  g.addColorStop(1, '#020105');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Subtle starfield
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
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
  const { width, height } = ctx.canvas;
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
  // Lines receding in depth (vertical-ish, along z)
  const cols = Math.min(28, vLen);
  for (let i = 0; i <= cols; i++) {
    const t = i / cols;
    const fx = x0 + (x1 - x0) * t;
    const a = project(fx, floorY, 0);
    const b = project(fx, floorY, depth);
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, 'rgba(180,140,255,0.18)');
    grad.addColorStop(1, 'rgba(180,140,255,0.02)');
    ctx.strokeStyle = grad;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // Horizontal depth lines
  const rows = 6;
  for (let r = 0; r <= rows; r++) {
    const z = (r / rows) * depth;
    const a = project(x0, floorY, z);
    const b = project(x1, floorY, z);
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, 'rgba(180,140,255,0.16)');
    grad.addColorStop(1, 'rgba(180,140,255,0.03)');
    ctx.strokeStyle = grad;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
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

function drawVolumeBlock(
  ctx: CanvasRenderingContext2D,
  engine: VisualEngine,
  pts: VolFacePts,
  baseCol: string,
): void {
  const { fb, ft, rb, rt, bb, bt, brb, brt, top, bot, ratio, i } = pts;
  const center = { x: (fb.x + brb.x) / 2, y: (fb.y + brt.y) / 2 };

  switch (engine) {
    case 'Thermal': {
      // Strong heat gradient with bright core
      const alpha = 0.25 + ratio * 0.55;
      const g = ctx.createLinearGradient(fb.x, fb.y, bb.x, bb.y);
      g.addColorStop(0, hexToRgba(baseCol, alpha));
      g.addColorStop(0.5, hexToRgba(baseCol, alpha * 0.6));
      g.addColorStop(1, hexToRgba(baseCol, alpha * 0.15));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(bb.x, bb.y); ctx.closePath();
      ctx.fill();
      // Bright hot core on front face
      const cg = ctx.createRadialGradient(center.x, (fb.y + ft.y) / 2, 0, center.x, (fb.y + ft.y) / 2, Math.abs(rt.x - fb.x) * 1.2);
      cg.addColorStop(0, hexToRgba('#ffffff', ratio * 0.55));
      cg.addColorStop(0.4, hexToRgba(baseCol, ratio * 0.3));
      cg.addColorStop(1, hexToRgba(baseCol, 0));
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.fill();
      // Border
      ctx.strokeStyle = hexToRgba(baseCol, 0.9);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.stroke();
      break;
    }

    case 'Nebula': {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const alpha = 0.35 + ratio * 0.6;
      const r = Math.max(4, Math.abs(rt.x - fb.x) * 1.8);
      const g = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r + ratio * 20);
      g.addColorStop(0, hexToRgba('#ffffff', alpha * 0.8));
      g.addColorStop(0.2, hexToRgba(baseCol, alpha));
      g.addColorStop(0.6, hexToRgba(baseCol, alpha * 0.45));
      g.addColorStop(1, hexToRgba(baseCol, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r + ratio * 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }

    case 'Quantum': {
      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 2.4;
      ctx.shadowBlur = 14;
      ctx.shadowColor = 'rgba(0,240,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.stroke();
      // Secondary pulse line
      ctx.strokeStyle = 'rgba(0,240,255,0.45)';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 6;
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
      const alpha = 0.85;
      const turns = 3.0;
      ctx.lineCap = 'round';
      for (let s = 0; s < 2; s++) {
        ctx.strokeStyle = hexToRgba(baseCol, alpha);
        ctx.lineWidth = 2.5;
        ctx.shadowBlur = 6;
        ctx.shadowColor = hexToRgba(baseCol, 0.35);
        ctx.beginPath();
        for (let step = 0; step <= 12; step++) {
          const t = step / 12;
          const ang = (t * turns + s * 0.5 + i * 0.1) * Math.PI * 2;
          const off = Math.sin(ang) * (bot - top) * 0.4;
          const px = fb.x + (bb.x - fb.x) * t;
          const py = (fb.y + ft.y) / 2 + off;
          if (step === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      // Bright rungs
      ctx.strokeStyle = hexToRgba('#ffffff', 0.5);
      ctx.lineWidth = 1.5;
      for (let step = 0; step <= 5; step++) {
        const t = step / 5;
        const ang = (t * turns + i * 0.1) * Math.PI * 2;
        const off = Math.sin(ang) * (bot - top) * 0.4;
        const px = fb.x + (bb.x - fb.x) * t;
        const pyMid = (fb.y + ft.y) / 2 + off;
        ctx.beginPath();
        ctx.moveTo(px, pyMid - (bot - top) * 0.2);
        ctx.lineTo(px, pyMid + (bot - top) * 0.2);
        ctx.stroke();
      }
      break;
    }

    case 'Constellation': {
      const alpha = 0.95;
      const nodes = [fb, ft, rb, rt, bb, bt, brb, brt];
      ctx.fillStyle = hexToRgba('#ffffff', 0.9);
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 2.2 + ratio * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = hexToRgba(baseCol, alpha);
      ctx.lineWidth = 1.2;
      ctx.shadowBlur = 6;
      ctx.shadowColor = hexToRgba(baseCol, 0.4);
      ctx.beginPath();
      // Full box edges
      ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y); ctx.lineTo(rt.x, rt.y); ctx.lineTo(rb.x, rb.y); ctx.closePath();
      ctx.moveTo(bt.x, bt.y); ctx.lineTo(bb.x, bb.y); ctx.lineTo(brb.x, brb.y); ctx.lineTo(brt.x, brt.y); ctx.closePath();
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
      const fillFace = (face: { x: number; y: number }[], brightness: number, alpha = 0.92) => {
        ctx.fillStyle = shade(baseCol, brightness);
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(face[0].x, face[0].y);
        for (let k = 1; k < face.length; k++) ctx.lineTo(face[k].x, face[k].y);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      };
      fillFace([bb, bt, brt, brb], 0.35, 0.75);
      fillFace([fb, ft, bt, bb], 0.55, 0.82);
      fillFace([rb, rt, brt, brb], 0.45, 0.78);
      if (Math.abs(bot - top) > 0.5) fillFace([ft, rt, brt, bt], 1.08, 0.85);
      fillFace([fb, ft, rt, rb], 1.0, 0.92);
      // Strong edge definition
      ctx.strokeStyle = hexToRgba(baseCol, 0.6);
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
  const { width, height } = ctx.canvas;
  const bs = view.barSpacing;
  const p2y = (p: number) => priceToY(p, minP, pRange, height, view);

  if (!perBarVols || !vpiEnabled || vLen === 0) return;
  ctx.save();

  // Heatmap mode forces the thermal engine.
  const engine: VisualEngine = volumeMode === '3D-Heatmap' ? 'Thermal' : visualEngine;

  // Use the same width as the candle body so the volume block fully covers the front face.
  const candleBw = Math.max(1.2, bs * 0.72);
  const bw = candleBw * (0.85 + (profileWidth / 100) * 0.6);
  const colors = vpComputed?.colors;

  for (let i = vLen - 1; i >= 0; i--) {
    const pv = perBarVols[start + i];
    if (!pv || pv.levels.length === 0) continue;
    const bar = visible[i];
    const x = barX(i, vLen, width, bs, view.scrollX);
    if (x < -bs * 2 || x > width + bs * 2) continue;

    const levels = pv.levels;
    const levelH = Math.max(1.5, (p2y(bar.low) - p2y(bar.high)) / levels.length);

    for (const lv of levels) {
      const y = p2y(lv.price);
      const ratio = Math.min(1, lv.volume / Math.max(pv.maxVol, 1));
      if (ratio < 0.02) continue;
      const dz = 0.18 * bs + ratio * BAR_DEPTH * bs * 3.2;
      const buyRatio = lv.buyVol / Math.max(lv.volume, 0.001);
      const baseCol = colors
        ? (buyRatio > 0.55 ? colors.bull : buyRatio < 0.45 ? colors.bear : '#b48cff')
        : (buyRatio > 0.55 ? '#1affa0' : buyRatio < 0.45 ? '#ff3b6b' : '#b48cff');

      // Volume bar starts at the candle front plane (z=0) and extrudes backward.
      const zFront = 0;
      const zBack = dz;
      const left = x;
      const rightX = x + bw;
      const top = y - levelH / 2;
      const bot = y + levelH / 2;

      const pts: VolFacePts = {
        fb: project(left, bot, zFront),
        ft: project(left, top, zFront),
        rb: project(rightX, bot, zFront),
        rt: project(rightX, top, zFront),
        bb: project(left, bot, zBack),
        bt: project(left, top, zBack),
        brb: project(rightX, bot, zBack),
        brt: project(rightX, top, zBack),
        top, bot, ratio, i, bw,
      };

      drawVolumeBlock(ctx, engine, pts, baseCol);
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
}

export function draw3DScene(
  ctx: CanvasRenderingContext2D,
  bars: BaseBar[],
  view: ViewState,
  opts: Scene3DOptions,
): void {
  const { width, height } = ctx.canvas;
  const { start, end } = getVisibleRange(view, width, bars.length);
  if (start >= bars.length) return;
  const visible = bars.slice(start, Math.min(end + 1, bars.length));
  const vLen = visible.length;
  if (vLen === 0) return;

  const all = visible.flatMap(b => [b.high, b.low]);
  const minP = Math.min(...all);
  const maxP = Math.max(...all);
  const pRange = (maxP - minP) || 1;

  // Atmosphere + floor
  drawAtmosphere(ctx, opts.time);
  drawFloorGrid(ctx, bars, view, minP, pRange);

  const bs = view.barSpacing;
  const bw = Math.max(1.2, bs * 0.72);
  const p2y = (p: number) => priceToY(p, minP, pRange, height, view);
  const depth = BAR_DEPTH * bs;

  // ── Candles: paint right-to-left so left bars (front) occlude right bars' tails ──
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
    const color = isBull ? '#1affa0' : '#ff3b6b';
    const bTop = Math.min(openY, closeY);
    const bBot = Math.max(openY, closeY);
    const bH = Math.max(1.5, bBot - bTop);

    // Atmospheric depth fade: bars further "back" (right, higher z) dim slightly
    const depthFade = 1 - (i / vLen) * 0.18;

    // Stronger glow halo
    ctx.shadowBlur = 14;
    ctx.shadowColor = withAlpha(color, 0.45 * depthFade);

    // Wick: bold extruded line from low to high
    const wFront = project(x, highY, 0);
    const wBack = project(x, lowY, 0);
    ctx.strokeStyle = withAlpha(color, 0.95 * depthFade);
    ctx.lineWidth = 3.6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(wFront.x, wFront.y); ctx.lineTo(wBack.x, wBack.y); ctx.stroke();
    ctx.lineCap = 'butt';

    // Body as extruded pillar (hex color so face-shading works)
    ctx.shadowBlur = 12;
    extrudedBox(ctx, x, bTop, bBot, bw, depth, color);

    // Thin black definition border on the right edge of the front face
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1.0;
    const fb = project(x, bBot, 0);
    const ft = project(x, bTop, 0);
    const fbR = project(x + bw, bBot, 0);
    const ftR = project(x + bw, bTop, 0);
    ctx.beginPath();
    ctx.moveTo(fbR.x, fbR.y); ctx.lineTo(ftR.x, ftR.y);
    ctx.stroke();

    // Front-face specular sheen
    const sheen = ctx.createLinearGradient(fb.x, fb.y, ft.x, ft.y);
    sheen.addColorStop(0, withAlpha(color, 0));
    sheen.addColorStop(0.5, 'rgba(255,255,255,0.26)');
    sheen.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.moveTo(fb.x, fb.y); ctx.lineTo(ft.x, ft.y);
    ctx.lineTo(ftR.x, ftR.y); ctx.lineTo(fbR.x, fbR.y); ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Volume profile renders ON TOP of candles so the extruded boxes cover the candle bodies.
  if (opts.volumeEnabled && (opts.volumeMode === '3D-Extrude' || opts.volumeMode === '3D-Heatmap')) {
    draw3DVolume(ctx, visible, start, vLen, minP, pRange, view, opts.perBarVols, opts.vpiEnabled, opts.volumeMode, opts.visualEngine, opts.profileWidth ?? 50, opts.vpComputed);
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
