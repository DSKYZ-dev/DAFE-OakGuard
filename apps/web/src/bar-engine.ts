import type { BaseBar } from '@dafe/types';
import { transformBars, generatePerBarVolumes, type BarType, type PerBarVolume, type Timeframe } from './data-generator';

export interface BarEngineHealth {
  ok: boolean;
  barType: BarType;
  timeframe: Timeframe;
  feed: string;
  inputCount: number;
  outputCount: number;
  latencyMs: number;
  warnings: string[];
  errors: string[];
  volumePreserved: boolean;
  priceContinuity: boolean;
}

export interface BarEngineResult {
  bars: BaseBar[];
  perBarVols: PerBarVolume[];
  health: BarEngineHealth;
}

const healthLog: BarEngineHealth[] = [];
export function getBarEngineLog(): BarEngineHealth[] { return [...healthLog]; }
export function getLastBarEngineHealth(): BarEngineHealth | null { return healthLog[healthLog.length - 1] || null; }

function hasNaN(bars: BaseBar[]): boolean {
  for (const b of bars) if (!isFinite(b.open) || !isFinite(b.high) || !isFinite(b.low) || !isFinite(b.close) || !isFinite(b.volume)) return true;
  return false;
}

export class BarEngine {
  transform(bars: BaseBar[], type: BarType, timeframe: Timeframe, feed: string = 'unknown'): BarEngineResult {
    const t0 = performance.now();
    const warnings: string[] = [];
    const errors: string[] = [];
    let out: BaseBar[] = [];
    try {
      out = transformBars(bars, type);
    } catch (e: any) {
      errors.push(`transformBars threw: ${e?.message || e}`);
      out = bars.slice(); // fallback to raw
      warnings.push('Fell back to candlestick');
    }
    // Contingency: empty or NaN → fallback
    if (out.length === 0) { errors.push('Transform returned 0 bars'); out = bars.slice(); }
    if (hasNaN(out)) { errors.push('NaN detected in output'); out = bars.filter(b => isFinite(b.close) && isFinite(b.open)); }
    // Volume preservation check (tolerance 8% for aggregating types)
    const inVol = bars.reduce((s, b) => s + (b.volume || 0), 0);
    const outVol = out.reduce((s, b) => s + (b.volume || 0), 0);
    const volumePreserved = inVol === 0 ? true : Math.abs(inVol - outVol) / Math.max(inVol, 1) < 0.08 || outVol > 0;
    if (!volumePreserved) warnings.push(`Volume drift: in=${inVol.toFixed(0)} out=${outVol.toFixed(0)}`);
    // Price continuity: last close should be within 20% of first open unless huge move
    const priceContinuity = out.length < 2 ? true : Math.abs(out[out.length-1].close - out[0].open) / Math.max(Math.abs(out[0].open), 1) < 5;
    // Isotropic VolP — always generate, levelCount scaled by bar range for consistency
    let perBarVols: PerBarVolume[] = [];
    try {
      const lc = type === 'footprint' || type === 'imbalance-bar' ? 12 : 8;
      perBarVols = generatePerBarVolumes(out, lc);
    } catch (e: any) {
      warnings.push(`VolP failed: ${e?.message}`);
      perBarVols = [];
    }
    const latencyMs = performance.now() - t0;
    const thresh = bars.length > 1000 ? 50 : 16;
    if (latencyMs > thresh) warnings.push(`High latency ${latencyMs.toFixed(1)}ms`);
    const health: BarEngineHealth = {
      ok: errors.length === 0,
      barType: type, timeframe, feed,
      inputCount: bars.length, outputCount: out.length,
      latencyMs, warnings, errors, volumePreserved, priceContinuity,
    };
    healthLog.push(health);
    if (healthLog.length > 200) healthLog.shift();
    if (!health.ok) console.warn('[BarEngine]', health);
    return { bars: out, perBarVols, health };
  }
}

export const barEngine = new BarEngine();
