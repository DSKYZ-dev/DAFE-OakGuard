import type { VolumeBin, POCResult, ValueAreaResult } from '@dafe/types';

export class ValueAreaCalculator {
  private targetPercent: number;

  constructor(targetPercent: number = 70) {
    this.targetPercent = targetPercent;
  }

  calculate(bins: VolumeBin[], poc: POCResult | null): ValueAreaResult {
    const totalVolume = bins.reduce((sum, b) => sum + b.volume, 0);
    if (totalVolume === 0 || !poc) {
      return { vah: 0, val: 0, totalVolume: 0, includedVolume: 0, percent: 0 };
    }

    const targetVolume = totalVolume * (this.targetPercent / 100);
    let includedVolume = bins[poc.index].volume;
    let lowerIdx = poc.index - 1;
    let upperIdx = poc.index + 1;

    while (includedVolume < targetVolume) {
      const lowerVol = lowerIdx >= 0 ? bins[lowerIdx].volume : 0;
      const upperVol = upperIdx < bins.length ? bins[upperIdx].volume : 0;

      if (lowerVol >= upperVol && lowerIdx >= 0) {
        includedVolume += lowerVol;
        lowerIdx--;
      } else if (upperIdx < bins.length) {
        includedVolume += upperVol;
        upperIdx++;
      } else {
        break;
      }
    }

    return {
      vah: bins[Math.min(upperIdx, bins.length - 1)].price,
      val: bins[Math.max(lowerIdx, 0)].price,
      totalVolume,
      includedVolume,
      percent: (includedVolume / totalVolume) * 100,
    };
  }
}
