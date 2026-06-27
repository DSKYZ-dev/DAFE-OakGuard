import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

interface FootprintBar extends BaseBar {
  bidVolume: number;
  askVolume: number;
  delta: number;
  priceLevels: Map<number, { bid: number; ask: number; total: number }>;
}

export class FootprintEngine implements BarEngine<FootprintBar> {
  readonly id: BarTypeId = 'footprint';
  readonly category: BarCategory = 'advanced';
  readonly requiresTicks = true;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): FootprintBar[] {
    const bars: FootprintBar[] = [];
    const period = (params.period as number) || 1;
    for (let i = 0; i < ticks.length; i += period) {
      const slice = ticks.slice(i, i + period);
      if (slice.length === 0) break;

      const priceLevels = new Map<number, { bid: number; ask: number; total: number }>();
      let bidVol = 0, askVol = 0;

      for (const t of slice) {
        const level = priceLevels.get(t.price) || { bid: 0, ask: 0, total: 0 };
        if (t.side === 'buy') { level.ask += t.size; askVol += t.size; }
        else { level.bid += t.size; bidVol += t.size; }
        level.total += t.size;
        priceLevels.set(t.price, level);
      }

      bars.push({
        timestamp: slice[0].timestamp,
        open: slice[0].price,
        high: Math.max(...slice.map(t => t.price)),
        low: Math.min(...slice.map(t => t.price)),
        close: slice[slice.length - 1].price,
        volume: slice.reduce((s, t) => s + t.size, 0),
        bidVolume: bidVol,
        askVolume: askVol,
        delta: askVol - bidVol,
        priceLevels,
      });
    }
    return bars;
  }

  updateLast(bar: FootprintBar, tick: Tick): FootprintBar {
    const updated = { ...bar };
    updated.high = Math.max(bar.high, tick.price);
    updated.low = Math.min(bar.low, tick.price);
    updated.close = tick.price;
    updated.volume += tick.size;
    if (tick.side === 'buy') { updated.askVolume += tick.size; }
    else { updated.bidVolume += tick.size; }
    updated.delta = updated.askVolume - updated.bidVolume;
    return updated;
  }

  getGeometry(bar: FootprintBar, scale: Scale): BarGeometry {
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
      colors[i] = isBull ? 0 : 0.8;
      colors[i + 1] = isBull ? 0.8 : 0.15;
      colors[i + 2] = isBull ? 0.4 : 0.2;
    }
    return { positions, indices: new Uint32Array([0, 1]), colors };
  }

  getParameters(): ParameterDefinition[] {
    return [{ id: 'period', label: 'Period', type: 'number', defaultValue: 1, min: 1, max: 100, step: 1 }];
  }
}
