// ─── Volume-profile extrusions: pure geometry and colour ──────────────────
// The 3D view stands each bar's profile on the candle plane as blocks that
// extrude backwards. Everything that decides where a block sits, how far it
// extrudes and what colour it takes lives here, free of canvas and DOM, so the
// invariants can be tested headlessly (tools/verify/volume-extrusion-test.ts).

/** Colour for a bias of 0: no buy or sell lean. */
export const NEUTRAL_BIAS = '#9aa3b8';

export interface VolumeLevelLike {
  volume: number;
  buyVol: number;
  sellVol: number;
}

/** Volume bias in [-1, 1]: +1 is all buying, -1 is all selling, 0 is balanced. */
export function biasOf(level: VolumeLevelLike): number {
  if (!(level.volume > 0)) return 0;
  return Math.max(-1, Math.min(1, (level.buyVol - level.sellVol) / level.volume));
}

/**
 * Horizontal span of a profile centred on its candle's front face. `bodyLeft` is
 * the candle's left edge and `bodyWidth` its full width.
 */
export function bodySpan(bodyLeft: number, bodyWidth: number, widthFactor: number): { left: number; right: number } {
  const w = bodyWidth * widthFactor;
  const left = bodyLeft + (bodyWidth - w) / 2;
  return { left, right: left + w };
}

export interface ExtrusionBox {
  /** Pixel edges of the price bin, top < bottom. */
  top: number;
  bottom: number;
  /** Extrusion length in pixels, proportional to the level's volume. */
  depth: number;
  /** Volume as a share of the window's largest level, in (0, 1]. */
  share: number;
  /** Buy volume as a share of the level, in [0, 1]: the buy part of the depth, nearest the candle. */
  buyShare: number;
}

/**
 * One level's extrusion. Depth is linear in volume against the window's largest
 * level, so a level with twice the volume extrudes exactly twice as far. Returns
 * null when there is nothing to draw.
 */
export function extrusionBox(input: {
  top: number;
  bottom: number;
  volume: number;
  buyVolume: number;
  maxVolume: number;
  maxDepth: number;
}): ExtrusionBox | null {
  const { top, bottom, volume, buyVolume, maxVolume, maxDepth } = input;
  if (!(volume > 0) || !(maxVolume > 0) || !(bottom > top) || !(maxDepth >= 0)) return null;
  const share = Math.min(1, volume / maxVolume);
  return {
    top,
    bottom,
    depth: share * maxDepth,
    share,
    buyShare: Math.min(1, Math.max(0, buyVolume / volume)),
  };
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = Math.max(0, Math.min(1, t));
  let out = '#';
  for (const shift of [16, 8, 0]) {
    const c = Math.round(((pa >> shift) & 255) * (1 - k) + ((pb >> shift) & 255) * k);
    out += c.toString(16).padStart(2, '0');
  }
  return out;
}

/** Colour for a bias: neutral at 0, the bull colour at +1, the bear colour at -1. */
export function biasMix(bias: number, bull: string, bear: string, neutral: string = NEUTRAL_BIAS): string {
  const b = Math.max(-1, Math.min(1, bias));
  return b >= 0 ? mixHex(neutral, bull, b) : mixHex(neutral, bear, -b);
}
