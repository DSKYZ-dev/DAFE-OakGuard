import type { BarEngine } from '../BarEngine';
import type { BaseBar, Tick, BarParams, BarGeometry, Scale, ParameterDefinition, BarCategory, BarTypeId } from '@dafe/types';

export class AreaEngine implements BarEngine {
  readonly id: BarTypeId = 'area';
  readonly category: BarCategory = 'time-based';
  readonly requiresTicks = false;
  readonly is3DCapable = true;

  aggregate(ticks: Tick[], params: BarParams): BaseBar[] {
    return ticks.map((t, i) => ({
      timestamp: t.timestamp, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.size,
    }));
  }

  updateLast(bar: BaseBar, tick: Tick): BaseBar {
    return { ...bar, close: tick.price, volume: bar.volume + tick.size };
  }

  getGeometry(bar: BaseBar, scale: Scale): BarGeometry {
    const x = (bar.timestamp - scale.timeOffset) * scale.timeScale;
    const y = (bar.close - scale.priceOffset) * scale.priceScale;
    const positions = new Float32Array([x, y]);
    const colors = new Float32Array([0.2, 0.6, 0.9, 0.3]);
    return { positions, indices: new Uint32Array([]), colors };
  }

  getParameters(): ParameterDefinition[] {
    return [];
  }
}
