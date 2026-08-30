// ─── Unified Theme Engine ─────────────────────────────────────────────
// Single source of truth for every color in the application. Replaces the
// ~15 hardcoded bull/bear color sites across chart-renderer.ts, iso3d.ts,
// three-indicators.ts, and three-lower-pane.ts with one resolver.
//
// The VP settings panel's "Color Theme" dropdown drives the base palette;
// the accessibility toggle (colorblind-safe blue/orange) overrides the
// bull/bear pair when enabled. Every renderer calls resolveTheme() to get
// the current colors — no more scattered literals.

import { isAccessiblePaletteEnabled } from './accessibility';
import type { VPColorTheme } from './volume-profile';

export interface ThemeColors {
  bull: string;
  bear: string;
  bullRgb: string;   // "r,g,b" for rgba() interpolation
  bearRgb: string;
  grid: string;
  gridMajor: string;
  background: string;
  backgroundAlt: string;
  accent: string;
  accentRgb: string;
  text: string;
  textDim: string;
  poc: string;
  deltaPoc: string;
  vaFill: string;
  vaLine: string;
  hvn: string;
  lvn: string;
  // Thermal palette stops (deep blue → cyan → green → yellow → red)
  thermalStops: [number, number, number, number][];
}

// Base palettes per VP color theme. These drive candles, grid, background,
// and volume profile together — not just the VP bins.
const BASE_PALETTES: Record<VPColorTheme, Omit<ThemeColors, 'bull' | 'bear' | 'bullRgb' | 'bearRgb' | 'poc' | 'deltaPoc' | 'vaFill' | 'vaLine' | 'hvn' | 'lvn' | 'thermalStops'>> = {
  'DAFE Signature': {
    grid: 'rgba(180, 140, 255, 0.10)',
    gridMajor: 'rgba(180, 140, 255, 0.20)',
    background: '#0a0a18',
    backgroundAlt: '#080816',
    accent: '#b48cff',
    accentRgb: '180,140,255',
    text: 'rgba(255,255,255,0.8)',
    textDim: 'rgba(255,255,255,0.4)',
  },
  'Cyber Neon': {
    grid: 'rgba(0, 243, 255, 0.10)',
    gridMajor: 'rgba(0, 243, 255, 0.20)',
    background: '#050510',
    backgroundAlt: '#03030c',
    accent: '#00f3ff',
    accentRgb: '0,243,255',
    text: 'rgba(220,255,255,0.85)',
    textDim: 'rgba(0,243,255,0.4)',
  },
  'Ocean Depths': {
    grid: 'rgba(0, 180, 220, 0.10)',
    gridMajor: 'rgba(0, 180, 220, 0.20)',
    background: '#041018',
    backgroundAlt: '#030c12',
    accent: '#00b4dc',
    accentRgb: '0,180,220',
    text: 'rgba(200,240,255,0.85)',
    textDim: 'rgba(0,180,220,0.4)',
  },
  'Volcanic': {
    grid: 'rgba(255, 120, 40, 0.10)',
    gridMajor: 'rgba(255, 120, 40, 0.20)',
    background: '#120604',
    backgroundAlt: '#0c0402',
    accent: '#ff7828',
    accentRgb: '255,120,40',
    text: 'rgba(255,220,200,0.85)',
    textDim: 'rgba(255,120,40,0.4)',
  },
};

// Bull/bear per theme (before accessibility override)
const THEME_BULL_BEAR: Record<VPColorTheme, { bull: string; bear: string }> = {
  'DAFE Signature': { bull: '#1affa0', bear: '#ff3b6b' },
  'Cyber Neon': { bull: '#00f3ff', bear: '#ff00ff' },
  'Ocean Depths': { bull: '#00ffcc', bear: '#ff6b6b' },
  'Volcanic': { bull: '#ffcc00', bear: '#ff3300' },
};

// Okabe–Ito colorblind-safe pair (overrides bull/bear when enabled)
const ACCESSIBLE_BULL = '#0072B2';
const ACCESSIBLE_BEAR = '#E69F00';

function hexToRgb(hex: string): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : '255,255,255';
}

// Thermal-camera palette — deep blue → cyan → green → yellow → red
const THERMAL_STOPS: [number, number, number, number][] = [
  [0.00, 20, 20, 90],
  [0.25, 20, 140, 220],
  [0.50, 40, 200, 90],
  [0.75, 240, 210, 30],
  [1.00, 255, 60, 20],
];

// Cache the resolved theme so repeated calls per frame are cheap.
let _cachedTheme: ThemeColors | null = null;
let _cachedKey = '';

export function resolveTheme(theme: VPColorTheme = 'DAFE Signature'): ThemeColors {
  const accessible = isAccessiblePaletteEnabled();
  const key = `${theme}|${accessible}`;
  if (_cachedKey === key && _cachedTheme) return _cachedTheme;

  const base = BASE_PALETTES[theme] || BASE_PALETTES['DAFE Signature'];
  const bb = THEME_BULL_BEAR[theme] || THEME_BULL_BEAR['DAFE Signature'];
  const bull = accessible ? ACCESSIBLE_BULL : bb.bull;
  const bear = accessible ? ACCESSIBLE_BEAR : bb.bear;

  _cachedTheme = {
    ...base,
    bull,
    bear,
    bullRgb: hexToRgb(bull),
    bearRgb: hexToRgb(bear),
    poc: '#FFD700',
    deltaPoc: '#FF6B00',
    vaFill: 'rgba(65,105,225,0.3)',
    vaLine: '#4169E1',
    hvn: '#00FF88',
    lvn: '#FF4444',
    thermalStops: THERMAL_STOPS,
  };
  _cachedKey = key;
  return _cachedTheme;
}

/** Invalidate the cache when the accessibility toggle changes. */
export function invalidateThemeCache(): void {
  _cachedTheme = null;
  _cachedKey = '';
}