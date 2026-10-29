/**
 * DAFE Adaptive Performance Governor.
 *
 * Measures real frame cadence and auto-tunes the quality tier so the app runs
 * smoothly on ANY machine — a weak laptop settles lower, a strong desktop
 * climbs higher — without the user touching a setting.
 *
 * Levers driven by the tier (all read live each frame elsewhere):
 *   - background star count + dot lattice (chart-renderer setPerfMode)
 *   - CPU/GPU particle counts + intensity
 * The governor never exceeds the GPU particle buffer allocated at startup.
 */

export type PerfTier = 'low' | 'medium' | 'high' | 'ultra';
const TIERS: PerfTier[] = ['low', 'medium', 'high', 'ultra'];

export function tierParticleCount(tier: PerfTier): number {
  return tier === 'ultra' ? 8192 : tier === 'high' ? 4096 : tier === 'medium' ? 2048 : 512;
}

/** Pick a sensible starting tier from device capability hints. */
export function recommendInitialTier(): PerfTier {
  const nav = navigator as any;
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory || 4;          // GB (Chromium only)
  const hasWebGPU = !!nav.gpu;
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent || '');

  let score = 0;
  if (cores >= 12) score += 2; else if (cores >= 8) score += 1; else if (cores <= 4) score -= 1;
  if (mem >= 16) score += 2; else if (mem >= 8) score += 1; else if (mem <= 4) score -= 1;
  if (hasWebGPU) score += 1;
  if (isMobile) score -= 2;

  if (score >= 4) return 'ultra';
  if (score >= 2) return 'high';
  if (score >= 0) return 'medium';
  return 'low';
}

export interface GovernorOptions {
  onChange: (tier: PerfTier, reason: string) => void;
  minTier?: PerfTier;
  maxTier?: PerfTier;
  targetFps?: number;     // we aim to keep smoothed FPS at/above this
}

export class PerfGovernor {
  private dtEwma = 1000 / 60;
  private last = 0;
  private idx: number;
  private minIdx: number;
  private maxIdx: number;
  private target: number;
  private lastChange = -Infinity;
  private belowSince = 0;
  private aboveSince = 0;
  enabled = true;

  constructor(private opts: GovernorOptions, startTier: PerfTier) {
    this.idx = Math.max(0, TIERS.indexOf(startTier));
    this.minIdx = Math.max(0, TIERS.indexOf(opts.minTier || 'low'));
    this.maxIdx = TIERS.indexOf(opts.maxTier || 'ultra');
    this.target = opts.targetFps || 50;
  }

  get tier(): PerfTier { return TIERS[this.idx]; }
  get fps(): number { return 1000 / this.dtEwma; }

  setEnabled(on: boolean): void { this.enabled = on; if (!on) { this.belowSince = 0; this.aboveSince = 0; } }

  /** Manually pin the tier (e.g. user picked a fixed mode). */
  setTier(tier: PerfTier): void {
    const i = TIERS.indexOf(tier);
    if (i >= 0) { this.idx = i; this.lastChange = performance.now(); }
  }

  /** Call once per animation frame with the rAF timestamp. */
  sample(now: number): void {
    if (this.last === 0) { this.last = now; return; }
    const dt = now - this.last;
    this.last = now;
    // Ignore tab-switch stalls and absurd gaps.
    if (dt <= 0 || dt > 500) return;
    this.dtEwma = this.dtEwma * 0.9 + dt * 0.1;
    if (!this.enabled) return;

    const now2 = now;
    // Settle period after any change to avoid oscillation.
    if (now2 - this.lastChange < 3500) return;

    const fps = this.fps;
    // Hysteresis band keeps us stable; thresholds stay reachable under the
    // common 60 Hz vsync cap (so headroom upgrades can actually fire).
    if (fps < this.target - 8 && this.idx > this.minIdx) {
      // Sustained low FPS -> step down quickly.
      if (!this.belowSince) this.belowSince = now2;
      this.aboveSince = 0;
      if (now2 - this.belowSince > 1200) { this.idx--; this.commit(now2, `low FPS ${fps | 0} → ${this.tier}`); }
    } else if (fps > this.target + 6 && this.idx < this.maxIdx) {
      // Sustained headroom -> step up slowly (cautious).
      if (!this.aboveSince) this.aboveSince = now2;
      this.belowSince = 0;
      if (now2 - this.aboveSince > 6000) { this.idx++; this.commit(now2, `headroom ${fps | 0} → ${this.tier}`); }
    } else {
      this.belowSince = 0;
      this.aboveSince = 0;
    }
  }

  private commit(now: number, reason: string): void {
    this.lastChange = now;
    this.belowSince = 0;
    this.aboveSince = 0;
    this.opts.onChange(this.tier, reason);
  }
}
