/**
 * Signal marker style — size, brightness and geometry for buy/sell markers.
 *
 * Kept separate from the 3D visual settings because it applies to the whole
 * application, not just the 3D scene: chart-renderer.ts paints the markers on
 * the 2D canvas and three-indicators.ts paints their 3D twins, and both must
 * agree. Settings → Display owns the controls.
 *
 * This replaced the per-script `input(1.0, "Marker Size", ...)` row that used
 * to sit in the Model Inputs panel: it only scaled the one model whose script
 * happened to multiply by it, so in most models it did nothing at all.
 */

export type SignalMarkerStyle = 'arrows' | 'orbs' | 'diamonds';

export interface SignalStyleSettings {
  /** Global multiplier on marker geometry (1 = authored/cone size). */
  size: number;
  /** Glow multiplier. Below 1 calms an over-bright signal without hiding it. */
  brightness: number;
  /** Distance from the bar (1 = current gap, 0 = sitting on the bar). */
  offset: number;
  style: SignalMarkerStyle;
}

const KEY = 'dafe_signal_style_v1';

// 0.8 by default: the stock cones read as blown-out next to the candles, so
// the shipped look is already the slightly-tempered one.
const DEFAULTS: SignalStyleSettings = { size: 1, brightness: 0.8, offset: 1, style: 'arrows' };

const _s: SignalStyleSettings = { ...DEFAULTS };

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, n));
}

function normalize(raw: Partial<SignalStyleSettings> | null | undefined): void {
  if (!raw || typeof raw !== 'object') return;
  _s.size = clampNum(raw.size, 0.4, 2.5, _s.size);
  _s.brightness = clampNum(raw.brightness, 0.2, 1.8, _s.brightness);
  _s.offset = clampNum(raw.offset, 0, 3, _s.offset);
  if (raw.style === 'arrows' || raw.style === 'orbs' || raw.style === 'diamonds') _s.style = raw.style;
}

try {
  normalize(JSON.parse(localStorage.getItem(KEY) || 'null'));
} catch { /* defaults */ }

export function getSignalStyle(): Readonly<SignalStyleSettings> {
  return _s;
}

export function saveSignalStyle(): void {
  try { localStorage.setItem(KEY, JSON.stringify(_s)); } catch { /* unavailable */ }
}

export function setSignalStyle(patch: Partial<SignalStyleSettings>): void {
  normalize(patch);
  saveSignalStyle();
}
