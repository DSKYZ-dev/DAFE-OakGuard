/**
 * AGE 3D Visual Extensions — Gradient probability clouds, confidence halos, fitness ribbons
 * Renders on canvas using Canvas2D and optionally Three.js overlays.
 */
import type { BaseBar } from '@dafe/types';

// ─── Theme Colors ─────────────────────────────────────────────────
export interface AGETheme {
  gradientBullStrong: string;
  gradientBullMid: string;
  gradientBullWeak: string;
  gradientBearStrong: string;
  gradientBearMid: string;
  gradientBearWeak: string;
  gradientNeutral: string;
  confElite: string;
  confStrong: string;
  confGood: string;
  confModerate: string;
  spawnMarker: string;
  cullMarker: string;
  exitColor: string;
  longPrimary: string;
  shortPrimary: string;
}

export const AGE_THEMES: Record<string, AGETheme> = {
  'Neon Genesis': {
    gradientBullStrong: '#00FF9F', gradientBullMid: '#00D4AA', gradientBullWeak: 'rgba(0,168,149,0.5)',
    gradientBearStrong: '#FF006E', gradientBearMid: '#D4006E', gradientBearWeak: 'rgba(168,0,85,0.5)',
    gradientNeutral: '#8B7CC8',
    confElite: '#00FFF0', confStrong: '#00D4AA', confGood: '#00A895', confModerate: '#007C6E',
    spawnMarker: '#00FFD4', cullMarker: '#FF4D6D',
    exitColor: '#FFB800', longPrimary: '#00FF9F', shortPrimary: '#FF006E',
  },
  'Carbon Fiber': {
    gradientBullStrong: '#4FC3F7', gradientBullMid: '#29B6F6', gradientBullWeak: 'rgba(2,136,209,0.5)',
    gradientBearStrong: '#EF5350', gradientBearMid: '#E53935', gradientBearWeak: 'rgba(198,40,40,0.5)',
    gradientNeutral: '#78909C',
    confElite: '#00E5FF', confStrong: '#4FC3F7', confGood: '#29B6F6', confModerate: '#0288D1',
    spawnMarker: '#4FC3F7', cullMarker: '#EF5350',
    exitColor: '#FFA726', longPrimary: '#4FC3F7', shortPrimary: '#EF5350',
  },
  'Quantum Blue': {
    gradientBullStrong: '#7986CB', gradientBullMid: '#5C6BC0', gradientBullWeak: 'rgba(63,81,181,0.5)',
    gradientBearStrong: '#F06292', gradientBearMid: '#EC407A', gradientBearWeak: 'rgba(216,24,104,0.5)',
    gradientNeutral: '#9575CD',
    confElite: '#8C9EFF', confStrong: '#7986CB', confGood: '#5C6BC0', confModerate: '#3F51B5',
    spawnMarker: '#64B5F6', cullMarker: '#F06292',
    exitColor: '#BA68C8', longPrimary: '#7986CB', shortPrimary: '#F06292',
  },
  'DAFE Signature': {
    gradientBullStrong: '#00BFA5', gradientBullMid: '#00897B', gradientBullWeak: 'rgba(0,105,92,0.5)',
    gradientBearStrong: '#FF5722', gradientBearMid: '#E64A19', gradientBearWeak: 'rgba(191,54,12,0.5)',
    gradientNeutral: '#7E57C2',
    confElite: '#1DE9B6', confStrong: '#00BFA5', confGood: '#00897B', confModerate: '#00695C',
    spawnMarker: '#1DE9B6', cullMarker: '#FF5722',
    exitColor: '#AB47BC', longPrimary: '#00BFA5', shortPrimary: '#FF5722',
  },
};

export function getThemeFromId(id: string): AGETheme {
  if (id.includes('Neon')) return AGE_THEMES['Neon Genesis'];
  if (id.includes('Carbon') || id.includes('Cyber')) return AGE_THEMES['Carbon Fiber'];
  if (id.includes('Quantum') || id.includes('Ice')) return AGE_THEMES['Quantum Blue'];
  return AGE_THEMES['DAFE Signature'];
}

// ─── Gradient Cloud ───────────────────────────────────────────────
export interface CloudConfig {
  layers: number;
  startBar: number;
  endBar: number;
  isLong: boolean;
  probability: number;
  minProbability: number;
  theme: AGETheme;
}

export function renderGradientCloud(
  ctx: CanvasRenderingContext2D,
  config: CloudConfig,
  barXs: number[],
  high: number,
  low: number,
  atr: number,
  priceToY: (price: number) => number,
): void {
  const { layers, isLong, probability, minProbability, theme } = config;
  const baseColor = isLong ? theme.gradientBullMid : theme.gradientBearMid;
  const strongColor = isLong ? theme.gradientBullStrong : theme.gradientBearStrong;

  for (let layer = 0; layer < layers; layer++) {
    const layerPct = layer / (layers - 1);
    const transBase = 0.08;
    const transRange = 0.02;
    const alpha = transBase - transRange * layerPct * (probability - minProbability) / (1 - minProbability);
    const layerAlpha = Math.max(0.02, alpha);

    const atrMult = 0.3 + 0.7 * layerPct;
    const topY = priceToY(high + atr * atrMult);
    const botY = priceToY(low - atr * atrMult);

    // Interpolate color
    const color = lerpColor(baseColor, strongColor, layerPct);
    const rgba = hexToRGBA(color, layerAlpha);

    const startX = barXs[config.startBar] ?? 0;
    const endX = barXs[config.endBar] ?? 0;

    ctx.fillStyle = rgba;
    ctx.fillRect(startX, topY, endX - startX, botY - topY);
  }
}

// ─── Confidence Halo ──────────────────────────────────────────────
export interface HaloConfig {
  x: number;
  y: number;
  probability: number;
  minProbability: number;
  atr: number;
  isLong: boolean;
  theme: AGETheme;
}

export function renderConfidenceHalo(
  ctx: CanvasRenderingContext2D,
  config: HaloConfig,
  priceToY: (price: number) => number,
): void {
  const { x, probability, minProbability, atr, isLong, theme } = config;
  const radius = atr * (0.3 + 0.7 * (probability - minProbability) / (1 - minProbability));
  const radiusPx = Math.abs(priceToY(0) - priceToY(radius));

  let haloColor: string;
  if (probability >= 0.85) haloColor = theme.confElite;
  else if (probability >= 0.75) haloColor = theme.confStrong;
  else if (probability >= 0.65) haloColor = theme.confGood;
  else haloColor = theme.confModerate;

  const centerY = isLong ? config.y + radiusPx * 0.5 : config.y - radiusPx * 0.5;

  // Outer glow
  ctx.beginPath();
  ctx.arc(x, centerY, radiusPx, 0, Math.PI * 2);
  ctx.fillStyle = hexToRGBA(haloColor, 0.12);
  ctx.fill();

  // Ring
  ctx.beginPath();
  ctx.arc(x, centerY, radiusPx, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRGBA(haloColor, 0.6);
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner fill
  ctx.beginPath();
  ctx.arc(x, centerY, radiusPx * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = hexToRGBA(haloColor, 0.25);
  ctx.fill();
}

// ─── Fitness Ribbon ───────────────────────────────────────────────
export interface RibbonConfig {
  layers: number;
  minFitness: number;
  maxFitness: number;
  activeCount: number;
  fitnessCounts: number[]; // count of strategies at each fitness level
  startX: number;
  endX: number;
  baseY: number; // pixel Y base level
  atr: number;
  theme: AGETheme;
}

export function renderFitnessRibbon(
  ctx: CanvasRenderingContext2D,
  config: RibbonConfig,
  priceToY: (price: number) => number,
): void {
  const { layers, minFitness, maxFitness, activeCount, fitnessCounts, startX, endX, baseY, atr, theme } = config;
  if (maxFitness <= 0) return;

  const atrPx = Math.abs(priceToY(0) - priceToY(atr));

  for (let layer = 0; layer < layers; layer++) {
    const fitLevel = minFitness + (maxFitness - minFitness) * (layer / layers);
    let count = 0;
    for (let i = 0; i < fitnessCounts.length; i++) {
      if (fitnessCounts[i] >= fitLevel) count++;
    }
    if (count > 0) {
      const layerPct = layer / Math.max(layers - 1, 1);
      const ribbonColor = lerpColor(theme.gradientBullWeak, theme.gradientBullStrong, layerPct);
      const y = baseY + atrPx * 0.2 * layer;
      const height = Math.max(2, atrPx * 0.15 * (count / Math.max(activeCount, 1)));

      ctx.strokeStyle = hexToRGBA(ribbonColor, 0.5);
      ctx.lineWidth = height;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      ctx.stroke();
    }
  }
}

// ─── Evolution Markers ────────────────────────────────────────────
export function renderEvolutionMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: 'spawn' | 'cull',
  theme: AGETheme,
): void {
  const color = type === 'spawn' ? theme.spawnMarker : theme.cullMarker;
  const size = 6;

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;

  if (type === 'spawn') {
    // Diamond
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.fill();
  } else {
    // X cross
    ctx.beginPath();
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y + size);
    ctx.moveTo(x + size, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.stroke();
  }
}

// ─── Signal Entry/Exit Markers ────────────────────────────────────
export function renderSignalMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: 'long' | 'short' | 'exit',
  probability: number,
  theme: AGETheme,
): void {
  const size = 10;
  let alpha = 1;
  if (probability >= 0.85) alpha = 1;
  else if (probability >= 0.75) alpha = 0.9;
  else if (probability >= 0.65) alpha = 0.8;
  else alpha = 0.65;

  if (type === 'long') {
    ctx.fillStyle = hexToRGBA(theme.longPrimary, alpha);
    ctx.beginPath();
    ctx.moveTo(x, y - size - 4);
    ctx.lineTo(x - size, y - 4);
    ctx.lineTo(x + size, y - 4);
    ctx.closePath();
    ctx.fill();
  } else if (type === 'short') {
    ctx.fillStyle = hexToRGBA(theme.shortPrimary, alpha);
    ctx.beginPath();
    ctx.moveTo(x, y + size + 4);
    ctx.lineTo(x - size, y + 4);
    ctx.lineTo(x + size, y + 4);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.strokeStyle = theme.exitColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 5);
    ctx.lineTo(x + 5, y + 5);
    ctx.moveTo(x + 5, y - 5);
    ctx.lineTo(x - 5, y + 5);
    ctx.stroke();
  }
}

// ─── Regime Background ────────────────────────────────────────────
export function renderRegimeBackground(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  regimeType: number,
  theme: AGETheme,
): void {
  if (regimeType === 1) {
    ctx.fillStyle = 'rgba(0,61,52,0.08)'; // Trending green tint
  } else if (regimeType === 2) {
    ctx.fillStyle = 'rgba(77,0,38,0.07)'; // Volatile red tint
  } else if (regimeType === 0) {
    ctx.fillStyle = 'rgba(44,26,71,0.05)'; // Balanced purple tint
  } else {
    return;
  }
  ctx.fillRect(x, y, width, height);
}

// ─── Intrabar Highlight ───────────────────────────────────────────
export function renderIntrabarHighlight(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  atConfluence: boolean,
  atPoc: boolean,
  atVah: boolean,
  atVal: boolean,
): void {
  if (atConfluence) {
    ctx.fillStyle = 'rgba(255,215,0,0.06)';
  } else if (atPoc) {
    ctx.fillStyle = 'rgba(255,215,0,0.05)';
  } else if (atVah) {
    ctx.fillStyle = 'rgba(255,107,53,0.05)';
  } else if (atVal) {
    ctx.fillStyle = 'rgba(0,200,83,0.05)';
  } else {
    return;
  }
  ctx.fillRect(x, y, width, height);
}

// ─── POC/VAH/VAL Lines ────────────────────────────────────────────
export function renderProfileLines(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  poc: number,
  vah: number,
  val: number,
  priceToY: (price: number) => number,
): void {
  const pocY = priceToY(poc);
  const vahY = priceToY(vah);
  const valY = priceToY(val);

  // POC
  ctx.strokeStyle = 'rgba(255,215,0,0.3)';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, pocY);
  ctx.lineTo(x + width, pocY);
  ctx.stroke();
  ctx.setLineDash([]);

  // VAH
  ctx.strokeStyle = 'rgba(255,107,53,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, vahY);
  ctx.lineTo(x + width, vahY);
  ctx.stroke();

  // VAL
  ctx.strokeStyle = 'rgba(0,200,83,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, valY);
  ctx.lineTo(x + width, valY);
  ctx.stroke();
}

// ─── Helpers ──────────────────────────────────────────────────────
function hexToRGBA(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function lerpColor(c1: string, c2: string, t: number): string {
  const a = parseHex(c1);
  const b = parseHex(c2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

// ─── 3D Ribbon (Three.js) ─────────────────────────────────────────
export function create3DFitnessRibbon(
  _scene: any,
  fitnessData: { x: number; y: number; z: number }[],
  color: number,
  opacity: number,
): any {
  if (fitnessData.length < 2) return null;
  try {
    const THREE = (globalThis as any).THREE;
    if (!THREE) return null;

    const points = fitnessData.map(d => new THREE.Vector3(d.x, d.y, d.z));
    const curve = new THREE.CatmullRomCurve3(points);
    const geom = new THREE.TubeGeometry(curve, points.length * 2, 0.05, 8, false);
    const mat = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity,
      emissive: color,
      emissiveIntensity: 0.3,
      shininess: 60,
    });
    const mesh = new THREE.Mesh(geom, mat);
    _scene.add(mesh);
    return mesh;
  } catch {
    return null;
  }
}
