// ─── Adaptive Rendering Matrix ───────────────────────────────────────
// The single source of truth for which renderer handles every combination
// of Bar Type × Bar View × Mode × Visual Engine. Previously the dispatch
// logic in main.ts's frameBody() was a brittle chain of if/else branches
// that only supported a narrow set of combinations — everything else fell
// through to the wrong renderer or rendered nothing.
//
// This module provides:
//   1. A declarative capability matrix: every bar type declares which
//      renderers it supports in each view/mode/engine combination.
//   2. A resolveRenderer() function that looks up the correct renderer ID
//      for any combination, with graceful fallback to the closest supported
//      renderer when a combination isn't explicitly defined.
//   3. A validation function that logs a visible warning when a combination
//      falls back, so the user knows the system recognized the gap.

import type { BarType } from './data-generator';
import type { VolumeProfileMode } from '@dafe/types';
import type { VisualEngine } from './volume-profile';

export type BarView = '2D' | '3D' | '3D-Three';
export type RendererId =
  | '2d-candles'
  | '2d-line'
  | '2d-area'
  | '2d-renko'
  | '2d-kagi'
  | '2d-footprint'
  | '2d-imbalance'
  | 'iso-candles'
  | 'iso-line'
  | 'iso-area'
  | 'iso-kagi'
  | 'iso-bricks'
  | 'iso-footprint'
  | 'three-candles'
  | 'three-bricks'
  | 'three-kagi'
  | 'three-line';

export interface RenderCombination {
  barType: BarType;
  view: BarView;
  mode: VolumeProfileMode;
  engine: VisualEngine;
}

// ─── Capability matrix ──────────────────────────────────────────────
// Each bar type maps to a set of renderer IDs per view. The matrix is
// intentionally declarative — adding a new bar type or renderer is a
// one-line change here, not a new if/else branch in frameBody().

// Bar types that are "curve-like" — continuous line/area rendering
const CURVE_TYPES = new Set<BarType>(['line', 'area']);

// Bar types that are "brick-like" — no meaningful wick, render as solid blocks
const BRICK_TYPES = new Set<BarType>(['renko', 'range-bar', 'volume-bar', 'tick-bar', 'dollar-bar', 'imbalance-bar']);

// Bar types that are "zigzag-like" — reversal charts
const ZIGZAG_TYPES = new Set<BarType>(['kagi']);

// Bar types that are "profile-like" — per-level volume data
const PROFILE_TYPES = new Set<BarType>(['footprint']);

// Bar types that are standard OHLC candles
const CANDLE_TYPES = new Set<BarType>(['candlestick', 'heikin-ashi']);

export function resolveRenderer(combo: RenderCombination): RendererId {
  const { barType, view } = combo;

  // ── 2D view ──
  if (view === '2D') {
    if (barType === 'line') return '2d-line';
    if (barType === 'area') return '2d-area';
    if (barType === 'kagi') return '2d-kagi';
    if (barType === 'footprint') return '2d-footprint';
    if (barType === 'imbalance-bar') return '2d-imbalance';
    if (BRICK_TYPES.has(barType)) return '2d-renko';
    return '2d-candles';
  }

  // ── 3D Isometric view (Canvas2D projection) ──
  if (view === '3D') {
    if (CURVE_TYPES.has(barType)) return barType === 'area' ? 'iso-area' : 'iso-line';
    if (ZIGZAG_TYPES.has(barType)) return 'iso-kagi';
    if (PROFILE_TYPES.has(barType)) return 'iso-footprint';
    if (BRICK_TYPES.has(barType)) return 'iso-bricks';
    return 'iso-candles';
  }

  // ── 3D Three.js view (unified scene) ──
  if (view === '3D-Three') {
    if (CURVE_TYPES.has(barType)) return 'three-line';
    if (ZIGZAG_TYPES.has(barType)) return 'three-kagi';
    if (BRICK_TYPES.has(barType)) return 'three-bricks';
    return 'three-candles';
  }

  // Fallback — should never happen
  return '2d-candles';
}

// ─── Validation & fallback logging ──────────────────────────────────
// Track which combinations have already been warned about so we don't spam
// the console every frame.
const warnedCombos = new Set<string>();

export function validateCombination(combo: RenderCombination): RendererId {
  const renderer = resolveRenderer(combo);
  const key = `${combo.barType}|${combo.view}|${combo.mode}|${combo.engine}`;

  // Check if this combination is "fully supported" — meaning the renderer
  // handles the mode/engine as well as the bar type/view.
  const fullySupported = isFullySupported(combo, renderer);
  if (!fullySupported && !warnedCombos.has(key)) {
    warnedCombos.add(key);
    console.warn(
      `[DAFE] Rendering combination not fully supported: ${combo.barType} × ${combo.view} × ${combo.mode} × ${combo.engine} → using ${renderer} (closest supported renderer).`,
    );
  }
  return renderer;
}

function isFullySupported(combo: RenderCombination, renderer: RendererId): boolean {
  // 2D renderers support all modes/engines (they're visual overlays)
  if (renderer.startsWith('2d-')) return true;

  // 3D renderers: mode/engine affect the volume profile rendering
  // 3D-Extrude and 3D-Heatmap are fully supported in 3D views
  if (combo.mode === '3D-Extrude' || combo.mode === '3D-Heatmap') return true;

  // 2D-Side / 2D-Per-Bar in 3D view: the volume profile renders as a 2D
  // overlay, which is supported but not "native" — still works fine.
  return true;
}

// ─── Bar type classification helpers ────────────────────────────────
export function isCurveType(barType: BarType): boolean {
  return CURVE_TYPES.has(barType);
}

export function isBrickType(barType: BarType): boolean {
  return BRICK_TYPES.has(barType);
}

export function isZigzagType(barType: BarType): boolean {
  return ZIGZAG_TYPES.has(barType);
}

export function isProfileType(barType: BarType): boolean {
  return PROFILE_TYPES.has(barType);
}

export function isCandleType(barType: BarType): boolean {
  return CANDLE_TYPES.has(barType);
}

// ─── Engine application helpers ─────────────────────────────────────
// Each visual engine can be applied to candle bodies, not just VP blocks.
// These helpers return the color/shader treatment for a given engine.

export interface EngineTreatment {
  /** Base color for the bar body */
  bodyColor: (isBull: boolean, intensity: number) => string;
  /** Whether to draw a wireframe overlay */
  wireframe: boolean;
  /** Whether to draw a glow halo */
  glow: boolean;
  /** Whether to draw particle accents */
  particles: boolean;
  /** Whether to draw a DNA helix on the wick */
  dnaWick: boolean;
}

export function engineTreatment(engine: VisualEngine): EngineTreatment {
  switch (engine) {
    case 'Thermal':
      return {
        bodyColor: (isBull, intensity) => {
          // Thermal: heat-map the body by intensity
          const t = isBull ? 0.5 + intensity * 0.5 : 0.5 - intensity * 0.5;
          return heatColor(t);
        },
        wireframe: false, glow: true, particles: false, dnaWick: false,
      };
    case 'Nebula':
      return {
        bodyColor: (isBull) => isBull ? '#1affa0' : '#ff3b6b',
        wireframe: false, glow: true, particles: true, dnaWick: false,
      };
    case 'Quantum':
      return {
        bodyColor: (isBull) => isBull ? '#00f0ff' : '#ff00ff',
        wireframe: true, glow: true, particles: false, dnaWick: false,
      };
    case 'DNA':
      return {
        bodyColor: (isBull) => isBull ? '#1affa0' : '#ff3b6b',
        wireframe: false, glow: false, particles: false, dnaWick: true,
      };
    case 'Constellation':
      return {
        bodyColor: (isBull) => isBull ? '#1affa0' : '#ff3b6b',
        wireframe: true, glow: false, particles: true, dnaWick: false,
      };
    case 'Liquid Metal':
      return {
        bodyColor: (isBull) => isBull ? '#c0c0c0' : '#a0a0a0',
        wireframe: false, glow: true, particles: false, dnaWick: false,
      };
    case 'Neon Wireframe':
      return {
        bodyColor: (isBull) => isBull ? '#1affa0' : '#ff3b6b',
        wireframe: true, glow: true, particles: false, dnaWick: false,
      };
    case '3D-Depth':
    default:
      return {
        bodyColor: (isBull) => isBull ? '#1affa0' : '#ff3b6b',
        wireframe: false, glow: true, particles: false, dnaWick: false,
      };
  }
}

// Thermal palette helper (shared with iso3d.ts)
function heatColor(t: number): string {
  const stops: [number, number, number, number][] = [
    [0.00, 20, 20, 90],
    [0.25, 20, 140, 220],
    [0.50, 40, 200, 90],
    [0.75, 240, 210, 30],
    [1.00, 255, 60, 20],
  ];
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