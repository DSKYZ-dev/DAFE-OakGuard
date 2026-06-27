import type { VolumeBin, VolumeProfileConfig, POCResult, ValueAreaResult, Scale } from '@dafe/types';
import { VolumeBinner } from './VolumeBinner';
import { POCCalculator } from './POCCalculator';
import { ValueAreaCalculator } from './ValueAreaCalculator';

export class VolumeProfileLayer {
  private binner: VolumeBinner;
  private pocCalc: POCCalculator;
  private vaCalc: ValueAreaCalculator;
  private bins: VolumeBin[] = [];
  private poc: POCResult | null = null;
  private valueArea: ValueAreaResult | null = null;
  config: VolumeProfileConfig;

  constructor(config: VolumeProfileConfig) {
    this.config = config;
    this.binner = new VolumeBinner(config);
    this.pocCalc = new POCCalculator();
    this.vaCalc = new ValueAreaCalculator(config.valueAreaPercent);
  }

  update(priceLevels: { price: number; volume: number; buyVolume: number; sellVolume: number }[], barIndex: number): void {
    this.bins = this.binner.bin(priceLevels, barIndex);
    this.poc = this.pocCalc.calculate(this.bins);
    this.valueArea = this.vaCalc.calculate(this.bins, this.poc);
  }

  getBins(): VolumeBin[] {
    return this.bins;
  }

  getPOC(): POCResult | null {
    return this.poc;
  }

  getValueArea(): ValueAreaResult | null {
    return this.valueArea;
  }
}
