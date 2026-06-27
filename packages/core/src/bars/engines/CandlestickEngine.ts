import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

export class CandlestickEngine implements BarEngine {
  readonly id: BarTypeId = 'candlestick';
  readonly category: BarCategory = 'time-based';
  readonly requiresTicks = true;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): BaseBar[] {
    const bars: BaseBar[] = [];
    if (ticks.length === 0) return bars;

    const period = params.period || 1;
    let i = 0;
    while (i < ticks.length) {
      const slice = ticks.slice(i, i + period);
      if (slice.length === 0) break;

      const bar: BaseBar = {
        timestamp: slice[0].timestamp,
        open: slice[0].price,
        high: Math.max(...slice.map(t => t.price)),
        low: Math.min(...slice.map(t => t.price)),
        close: slice[slice.length - 1].price,
        volume: slice.reduce((sum, t) => sum + t.size, 0),
      };
      bars.push(bar);
      i += period;
    }

    return bars;
  }

  updateLast(bar: BaseBar, tick: Tick): BaseBar {
    return {
      ...bar,
      high: Math.max(bar.high, tick.price),
      low: Math.min(bar.low, tick.price),
      close: tick.price,
      volume: bar.volume + tick.size,
    };
  }

  getGeometry(bar: BaseBar, scale: Scale): BarGeometry {
    const { priceScale, timeScale, priceOffset, timeOffset } = scale;
    const x = (bar.timestamp - timeOffset) * timeScale;
    const openY = (bar.open - priceOffset) * priceScale;
    const highY = (bar.high - priceOffset) * priceScale;
    const lowY = (bar.low - priceOffset) * priceScale;
    const closeY = (bar.close - priceOffset) * priceScale;
    const wickWidth = 1;
    const bodyWidth = 4;

    const isBull = bar.close >= bar.open;
    const r = isBull ? 0 : 1;
    const g = isBull ? 1 : 0.2;
    const b = isBull ? 0.4 : 0.3;

    const positions = new Float32Array([
      // Wick
      x, highY, x, lowY,
      // Body quad
      x - bodyWidth, openY, x + bodyWidth, openY,
      x - bodyWidth, openY, x + bodyWidth, closeY,
      x + bodyWidth, openY, x + bodyWidth, closeY,
      x - bodyWidth, closeY, x + bodyWidth, closeY,
    ]);

    const colors = new Float32Array(positions.length / 2 * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = r;
      colors[i + 1] = g;
      colors[i + 2] = b;
    }

    return {
      positions,
      indices: new Uint32Array([0, 1]),
      colors,
    };
  }

  getParameters(): ParameterDefinition[] {
    return [
      { id: 'period', label: 'Period', type: 'number', defaultValue: 1, min: 1, max: 100, step: 1 },
    ];
  }
}
