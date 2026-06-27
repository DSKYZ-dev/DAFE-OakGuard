import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

interface HeikinAshiBar extends BaseBar {
  haOpen: number;
  haClose: number;
  haHigh: number;
  haLow: number;
}

export class HeikinAshiEngine implements BarEngine<HeikinAshiBar> {
  readonly id: BarTypeId = 'heikin-ashi';
  readonly category: BarCategory = 'non-time-based';
  readonly requiresTicks = true;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): HeikinAshiBar[] {
    const rawBars = this.aggregateRawBars(ticks, params);
    if (rawBars.length === 0) return [];

    const haBars: HeikinAshiBar[] = [];
    let prevHaClose = rawBars[0].open;

    for (const bar of rawBars) {
      const haClose = (bar.open + bar.high + bar.low + bar.close) / 4;
      const haOpen = (prevHaClose + (haBars.length > 0 ? haBars[haBars.length - 1].haOpen : prevHaClose)) / 2;
      const haHigh = Math.max(bar.high, haOpen, haClose);
      const haLow = Math.min(bar.low, haOpen, haClose);

      haBars.push({
        ...bar,
        haOpen,
        haClose,
        haHigh,
        haLow,
      });
      prevHaClose = haClose;
    }

    return haBars;
  }

  private aggregateRawBars(ticks: Tick[], params: BarParams): BaseBar[] {
    const bars: BaseBar[] = [];
    const period = params.period || 1;
    for (let i = 0; i < ticks.length; i += period) {
      const slice = ticks.slice(i, i + period);
      if (slice.length === 0) break;
      bars.push({
        timestamp: slice[0].timestamp,
        open: slice[0].price,
        high: Math.max(...slice.map(t => t.price)),
        low: Math.min(...slice.map(t => t.price)),
        close: slice[slice.length - 1].price,
        volume: slice.reduce((s, t) => s + t.size, 0),
      });
    }
    return bars;
  }

  updateLast(bar: HeikinAshiBar, tick: Tick): HeikinAshiBar {
    return {
      ...bar,
      haHigh: Math.max(bar.haHigh, tick.price),
      haLow: Math.min(bar.haLow, tick.price),
      haClose: tick.price,
      volume: bar.volume + tick.size,
    };
  }

  getGeometry(bar: HeikinAshiBar, scale: Scale): BarGeometry {
    const { priceScale, timeScale, priceOffset, timeOffset } = scale;
    const x = (bar.timestamp - timeOffset) * timeScale;
    const openY = (bar.haOpen - priceOffset) * priceScale;
    const highY = (bar.haHigh - priceOffset) * priceScale;
    const lowY = (bar.haLow - priceOffset) * priceScale;
    const closeY = (bar.haClose - priceOffset) * priceScale;
    const bodyWidth = 4;

    const isBull = bar.haClose >= bar.haOpen;
    const r = isBull ? 0.2 : 0.8;
    const g = isBull ? 0.8 : 0.15;
    const b = isBull ? 0.6 : 0.2;

    const positions = new Float32Array([
      x, highY, x, lowY,
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

    return { positions, indices: new Uint32Array([0, 1]), colors };
  }

  getParameters(): ParameterDefinition[] {
    return [
      { id: 'period', label: 'Period', type: 'number', defaultValue: 1, min: 1, max: 100, step: 1 },
    ];
  }
}
