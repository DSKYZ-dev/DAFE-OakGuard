import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

interface RenkoBar extends BaseBar {
  brickSize: number;
  direction: 'up' | 'down';
}

export class RenkoEngine implements BarEngine<RenkoBar> {
  readonly id: BarTypeId = 'renko';
  readonly category: BarCategory = 'non-time-based';
  readonly requiresTicks = false;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): RenkoBar[] {
    const brickSize = (params.brickSize as number) || 10;
    const bars: RenkoBar[] = [];
    if (ticks.length < 2) return bars;

    let prevPrice = ticks[0].price;
    for (const tick of ticks) {
      const diff = tick.price - prevPrice;
      if (Math.abs(diff) >= brickSize) {
        const count = Math.floor(Math.abs(diff) / brickSize);
        for (let i = 0; i < count; i++) {
          const direction = diff > 0 ? 'up' : 'down';
          const step = direction === 'up' ? brickSize : -brickSize;
          bars.push({
            timestamp: tick.timestamp,
            open: prevPrice + step * i,
            high: Math.max(prevPrice + step * i, prevPrice + step * (i + 1)),
            low: Math.min(prevPrice + step * i, prevPrice + step * (i + 1)),
            close: prevPrice + step * (i + 1),
            volume: tick.size,
            brickSize,
            direction,
          });
        }
        prevPrice = tick.price - (diff % brickSize);
      }
    }
    return bars;
  }

  updateLast(bar: RenkoBar, tick: Tick): RenkoBar {
    return { ...bar, high: Math.max(bar.high, tick.price), low: Math.min(bar.low, tick.price), volume: bar.volume + tick.size };
  }

  getGeometry(bar: RenkoBar, scale: Scale): BarGeometry {
    const x = (bar.timestamp - scale.timeOffset) * scale.timeScale;
    const openY = (bar.open - scale.priceOffset) * scale.priceScale;
    const closeY = (bar.close - scale.priceOffset) * scale.priceScale;
    const isBull = bar.direction === 'up';
    const bodyWidth = 5;
    const positions = new Float32Array([
      x - bodyWidth, openY, x + bodyWidth, openY,
      x - bodyWidth, openY, x + bodyWidth, closeY,
      x + bodyWidth, openY, x + bodyWidth, closeY,
      x - bodyWidth, closeY, x + bodyWidth, closeY,
    ]);
    const colors = new Float32Array(positions.length / 2 * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = isBull ? 0 : 0.8;
      colors[i + 1] = isBull ? 0.8 : 0.15;
      colors[i + 2] = isBull ? 0.6 : 0.2;
    }
    return { positions, indices: new Uint32Array([0, 1]), colors };
  }

  getParameters(): ParameterDefinition[] {
    return [
      { id: 'brickSize', label: 'Brick Size', type: 'number', defaultValue: 10, min: 1, max: 1000, step: 1 },
    ];
  }
}
