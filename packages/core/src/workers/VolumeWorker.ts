import type { VolumeBin } from '@dafe/types';
import { VolumeBinner } from '../volume/VolumeBinner';

let binner: VolumeBinner | null = null;

self.onmessage = (event: MessageEvent) => {
  const { type, data } = event.data;

  switch (type) {
    case 'init': {
      binner = new VolumeBinner(data);
      break;
    }
    case 'bin': {
      if (!binner) return;
      const { priceLevels, barIndex } = data as {
        priceLevels: { price: number; volume: number; buyVolume: number; sellVolume: number }[];
        barIndex: number;
      };
      const bins = binner.bin(priceLevels, barIndex);
      self.postMessage({ type: 'bins', data: bins });
      break;
    }
  }
};
