import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

export class RangeBarEngine implements BarEngine {
  readonly id: BarTypeId = 'range-bar';
  readonly category: BarCategory = 'non-time-based';
  readonly requiresTicks = true;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): BaseBar[] {
    const range = (params.range as number) || 10;
    const bars: BaseBar[] = [];
    if (ticks.length === 0) return bars;

    let currentBar: BaseBar = {
      timestamp: ticks[0].timestamp, open: ticks[0].price,
      high: ticks[0].price, low: ticks[0].price,
      close: ticks[0].price, volume: 0,
    };

    for (const tick of ticks) {
      currentBar.high = Math.max(currentBar.high, tick.price);
      currentBar.low = Math.min(currentBar.low, tick.price);
      currentBar.volume += tick.size;

      if ((currentBar.high - currentBar.low) >= range) {
        currentBar.close = tick.price;
        bars.push(currentBar);
        currentBar = {
          timestamp: tick.timestamp, open: tick.price,
          high: tick.price, low: tick.price,
          close: tick.price, volume: 0,
        };
      }
    }

    if (currentBar.volume > 0) bars.push(currentBar);
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
    return [{ id: 'range', label: 'Range', type: 'number', defaultValue: 10, min: 0.1, max: 1000, step: 0.1 }];
  }
}
