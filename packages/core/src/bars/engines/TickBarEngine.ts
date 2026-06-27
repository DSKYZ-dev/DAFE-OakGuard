import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

export class TickBarEngine implements BarEngine {
  readonly id: BarTypeId = 'tick-bar';
  readonly category: BarCategory = 'non-time-based';
  readonly requiresTicks = true;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): BaseBar[] {
    const tickCount = (params.tickCount as number) || 100;
    const bars: BaseBar[] = [];
    for (let i = 0; i < ticks.length; i += tickCount) {
      const slice = ticks.slice(i, i + tickCount);
      if (slice.length === 0) break;
      bars.push({
        timestamp: slice[0].timestamp, open: slice[0].price,
        high: Math.max(...slice.map(t => t.price)),
        low: Math.min(...slice.map(t => t.price)),
        close: slice[slice.length - 1].price,
        volume: slice.reduce((s, t) => s + t.size, 0),
      });
    }
    return bars;
  }

  updateLast(bar: BaseBar, tick: Tick): BaseBar {
    return { ...bar, high: Math.max(bar.high, tick.price), low: Math.min(bar.low, tick.price), close: tick.price, volume: bar.volume + tick.size };
  }

  getGeometry(bar: BaseBar, scale: Scale): BarGeometry {
    const x = (bar.timestamp - scale.timeOffset) * scale.timeScale;
    const openY = (bar.open - scale.priceOffset) * scale.priceScale;
    const closeY = (bar.close - scale.priceOffset) * scale.priceScale;
    const isBull = bar.close >= bar.open;
    const bodyWidth = 4;
    const positions = new Float32Array([
      x - bodyWidth, openY, x + bodyWidth, openY,
      x - bodyWidth, openY, x + bodyWidth, closeY,
      x + bodyWidth, openY, x + bodyWidth, closeY,
      x - bodyWidth, closeY, x + bodyWidth, closeY,
    ]);
    const colors = new Float32Array(positions.length / 2 * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = isBull ? 0 : 1;
      colors[i + 1] = isBull ? 1 : 0.2;
      colors[i + 2] = isBull ? 0.4 : 0.3;
    }
    return { positions, indices: new Uint32Array([0, 1]), colors };
  }

  getParameters(): ParameterDefinition[] {
    return [{ id: 'tickCount', label: 'Ticks per Bar', type: 'number', defaultValue: 100, min: 1, max: 10000, step: 10 }];
  }
}
