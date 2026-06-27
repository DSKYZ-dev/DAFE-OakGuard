import type { VolumeBin, VolumeProfileConfig, BinningAlgorithm } from '@dafe/types';

export class VolumeBinner {
  private config: VolumeProfileConfig;

  constructor(config: VolumeProfileConfig) {
    this.config = config;
  }

  bin(
    priceLevels: { price: number; volume: number; buyVolume: number; sellVolume: number }[],
    barIndex: number,
  ): VolumeBin[] {
    if (priceLevels.length === 0) return [];

    switch (this.config.binningAlgorithm) {
      case 'adaptive': return this.adaptiveBin(priceLevels, barIndex);
      case 'TPO': return this.tpoBin(priceLevels, barIndex);
      default: return this.fixedBin(priceLevels, barIndex);
    }
  }

  private fixedBin(
    priceLevels: { price: number; volume: number; buyVolume: number; sellVolume: number }[],
    barIndex: number,
  ): VolumeBin[] {
    const resolution = this.config.priceResolution;
    const binMap = new Map<number, VolumeBin>();

    for (const level of priceLevels) {
      const binPrice = Math.round(level.price / resolution) * resolution;
      const existing = binMap.get(binPrice);
      if (existing) {
        existing.volume += level.volume;
        existing.buyVolume += level.buyVolume;
        existing.sellVolume += level.sellVolume;
        existing.tickCount++;
      } else {
        binMap.set(binPrice, {
          price: binPrice,
          volume: level.volume,
          buyVolume: level.buyVolume,
          sellVolume: level.sellVolume,
          barIndex,
          tickCount: 1,
        });
      }
    }

    return Array.from(binMap.values()).sort((a, b) => a.price - b.price);
  }

  private adaptiveBin(
    priceLevels: { price: number; volume: number; buyVolume: number; sellVolume: number }[],
    barIndex: number,
  ): VolumeBin[] {
    const baseResolution = this.config.priceResolution;
    const sorted = [...priceLevels].sort((a, b) => a.price - b.price);
    const priceRange = sorted[sorted.length - 1].price - sorted[0].price;
    const dynamicResolution = priceRange / Math.min(priceLevels.length, 50);
    const effectiveResolution = Math.max(baseResolution, dynamicResolution);

    const tempConfig = { ...this.config, priceResolution: effectiveResolution };
    const tempBinner = new VolumeBinner(tempConfig);
    return tempBinner.fixedBin(priceLevels, barIndex);
  }

  private tpoBin(
    priceLevels: { price: number; volume: number; buyVolume: number; sellVolume: number }[],
    barIndex: number,
  ): VolumeBin[] {
    const resolution = this.config.priceResolution;
    const binMap = new Map<number, VolumeBin>();

    for (const level of priceLevels) {
      const binPrice = Math.round(level.price / resolution) * resolution;
      if (binMap.has(binPrice)) {
        const bin = binMap.get(binPrice)!;
        bin.tickCount++;
      } else {
        binMap.set(binPrice, {
          price: binPrice,
          volume: level.volume,
          buyVolume: level.buyVolume,
          sellVolume: level.sellVolume,
          barIndex,
          tickCount: 1,
        });
      }
    }

    return Array.from(binMap.values()).sort((a, b) => a.price - b.price);
  }

  updateConfig(config: VolumeProfileConfig): void {
    this.config = config;
  }
}
