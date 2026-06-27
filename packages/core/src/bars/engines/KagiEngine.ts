import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

interface KagiLine {
  timestamp: number;
  price: number;
  direction: 'yang' | 'yin';
  reversal: boolean;
}

export class KagiEngine implements BarEngine<BaseBar> {
  readonly id: BarTypeId = 'kagi';
  readonly category: BarCategory = 'non-time-based';
  readonly requiresTicks = false;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): BaseBar[] {
    const reversal = (params.reversalAmount as number) || 4;
    const lines: KagiLine[] = [];
    if (ticks.length < 2) return [];

    let currentLine: KagiLine = {
      timestamp: ticks[0].timestamp, price: ticks[0].price,
      direction: 'yang', reversal: false,
    };

    for (const tick of ticks) {
      const diff = tick.price - currentLine.price;
      if (currentLine.direction === 'yang' && diff >= 0) {
        currentLine.price = tick.price;
      } else if (currentLine.direction === 'yin' && diff <= 0) {
        currentLine.price = tick.price;
      } else if (Math.abs(diff) >= reversal) {
        lines.push(currentLine);
        currentLine = {
          timestamp: tick.timestamp, price: tick.price,
          direction: diff > 0 ? 'yang' : 'yin', reversal: true,
        };
      }
    }
    lines.push(currentLine);

    return lines.map((l, i) => ({
      timestamp: l.timestamp,
      open: i > 0 ? lines[i - 1].price : l.price,
      high: Math.max(l.price, i > 0 ? lines[i - 1].price : l.price),
      low: Math.min(l.price, i > 0 ? lines[i - 1].price : l.price),
      close: l.price,
      volume: 1,
    }));
  }

  updateLast(bar: BaseBar, tick: Tick): BaseBar {
    return { ...bar, close: tick.price, high: Math.max(bar.high, tick.price), low: Math.min(bar.low, tick.price) };
  }

  getGeometry(bar: BaseBar, scale: Scale): BarGeometry {
    const x = (bar.timestamp - scale.timeOffset) * scale.timeScale;
    const openY = (bar.open - scale.priceOffset) * scale.priceScale;
    const closeY = (bar.close - scale.priceOffset) * scale.priceScale;
    const isBull = bar.close >= bar.open;
    const bodyWidth = 3;
    const positions = new Float32Array([
      x, openY, x, closeY,
      x - bodyWidth, closeY, x + bodyWidth, closeY,
    ]);
    const colors = new Float32Array(positions.length / 2 * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = isBull ? 0 : 0.6;
      colors[i + 1] = isBull ? 0.6 : 0.1;
      colors[i + 2] = isBull ? 0.4 : 0.2;
    }
    return { positions, indices: new Uint32Array([0, 1]), colors };
  }

  getParameters(): ParameterDefinition[] {
    return [{ id: 'reversalAmount', label: 'Reversal Amount', type: 'number', defaultValue: 4, min: 1, max: 100, step: 1 }];
  }
}
