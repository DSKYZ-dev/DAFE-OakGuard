import type { BaseBar } from '@dafe/types';

export interface IndicatorDefinition {
  id: string;
  name: string;
  description: string;
  params: IndicatorParam[];
  compute: (bars: BaseBar[], params: Record<string, number>) => Float64Array;
}

export interface IndicatorParam {
  id: string;
  label: string;
  type: 'number' | 'boolean' | 'select';
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: unknown }[];
}

export class IndicatorRegistry {
  private indicators: Map<string, IndicatorDefinition> = new Map();

  register(indicator: IndicatorDefinition): void {
    this.indicators.set(indicator.id, indicator);
  }

  get(id: string): IndicatorDefinition | undefined {
    return this.indicators.get(id);
  }

  getAll(): IndicatorDefinition[] {
    return Array.from(this.indicators.values());
  }

  compute(id: string, bars: BaseBar[], params: Record<string, number>): Float64Array {
    const indicator = this.indicators.get(id);
    if (!indicator) throw new Error(`Indicator '${id}' not found`);
    return indicator.compute(bars, params);
  }
}

export const builtinIndicators: IndicatorDefinition[] = [
  {
    id: 'sma',
    name: 'Simple Moving Average',
    description: 'Simple moving average over N periods',
    params: [{ id: 'period', label: 'Period', type: 'number', default: 14, min: 1, max: 500, step: 1 }],
    compute: (bars: BaseBar[], params: Record<string, number>) => {
      const period = params.period || 14;
      const closes = bars.map(b => b.close);
      const result = new Float64Array(closes.length);
      for (let i = period - 1; i < closes.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += closes[i - j];
        result[i] = sum / period;
      }
      return result;
    },
  },
  {
    id: 'ema',
    name: 'Exponential Moving Average',
    description: 'Exponential moving average with higher weight on recent data',
    params: [{ id: 'period', label: 'Period', type: 'number', default: 14, min: 1, max: 500, step: 1 }],
    compute: (bars: BaseBar[], params: Record<string, number>) => {
      const period = params.period || 14;
      const closes = bars.map(b => b.close);
      const alpha = 2 / (period + 1);
      const result = new Float64Array(closes.length);
      result[0] = closes[0];
      for (let i = 1; i < closes.length; i++) {
        result[i] = alpha * closes[i] + (1 - alpha) * result[i - 1];
      }
      return result;
    },
  },
  {
    id: 'rsi',
    name: 'Relative Strength Index',
    description: 'Momentum oscillator measuring speed and magnitude of price changes',
    params: [{ id: 'period', label: 'Period', type: 'number', default: 14, min: 1, max: 100, step: 1 }],
    compute: (bars: BaseBar[], params: Record<string, number>) => {
      const period = params.period || 14;
      const closes = bars.map(b => b.close);
      const result = new Float64Array(closes.length);
      for (let i = period; i < closes.length; i++) {
        let gains = 0, losses = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const diff = closes[j] - closes[j - 1];
          if (diff > 0) gains += diff;
          else losses -= diff;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
      }
      return result;
    },
  },
];
