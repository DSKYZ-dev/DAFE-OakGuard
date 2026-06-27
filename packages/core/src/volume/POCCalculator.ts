import type { VolumeBin, POCResult } from '@dafe/types';

export class POCCalculator {
  calculate(bins: VolumeBin[]): POCResult | null {
    if (bins.length === 0) return null;

    let maxVolume = 0;
    let pocIndex = 0;

    for (let i = 0; i < bins.length; i++) {
      if (bins[i].volume > maxVolume) {
        maxVolume = bins[i].volume;
        pocIndex = i;
      }
    }

    return {
      price: bins[pocIndex].price,
      volume: maxVolume,
      index: pocIndex,
    };
  }
}
