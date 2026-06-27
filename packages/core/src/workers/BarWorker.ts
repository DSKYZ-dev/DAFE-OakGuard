import type { Tick, BaseBar, BarParams, BarTypeId } from '@dafe/types';
import { BarRegistry } from '../bars/BarRegistry';

const registry = new BarRegistry();

self.onmessage = (event: MessageEvent) => {
  const { type, data } = event.data;

  switch (type) {
    case 'register':
      break;
    case 'aggregate': {
      const { barType, ticks, params } = data as { barType: BarTypeId; ticks: Tick[]; params: BarParams };
      const engine = registry.get(barType);
      if (engine) {
        const bars = engine.aggregate(ticks, params);
        self.postMessage({ type: 'bars', data: bars }, { transfer: [getTransferable(bars)] });
      }
      break;
    }
    case 'update': {
      const { barType, bar, tick } = data as { barType: BarTypeId; bar: BaseBar; tick: Tick };
      const engine = registry.get(barType);
      if (engine) {
        const updated = engine.updateLast(bar, tick);
        self.postMessage({ type: 'barUpdate', data: updated });
      }
      break;
    }
  }
};

function getTransferable(bars: BaseBar[]): Transferable[] {
  const size = bars.length * 6 * 4;
  const buf = new ArrayBuffer(size);
  const view = new Float32Array(buf);
  bars.forEach((b, i) => {
    const o = i * 6;
    view[o] = b.timestamp;
    view[o + 1] = b.open;
    view[o + 2] = b.high;
    view[o + 3] = b.low;
    view[o + 4] = b.close;
    view[o + 5] = b.volume;
  });
  return [buf];
}
