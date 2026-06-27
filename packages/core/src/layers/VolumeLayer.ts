import { Layer } from './Layer';
import type { LayerConfig, VolumeBin, VolumeProfileConfig, Scale } from '@dafe/types';

export class VolumeLayer extends Layer {
  private bins: VolumeBin[] = [];
  private volConfig: VolumeProfileConfig | null = null;
  private scale: Scale = { priceScale: 1, timeScale: 1, priceOffset: 0, timeOffset: 0 };

  constructor(config?: Partial<LayerConfig>) {
    super('volume', { zIndex: 4, ...config });
  }

  setBins(bins: VolumeBin[]): void {
    this.bins = bins;
  }

  setVolumeConfig(config: VolumeProfileConfig): void {
    this.volConfig = config;
  }

  setScale(scale: Scale): void {
    this.scale = scale;
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    if (!this.volConfig?.enabled || this.bins.length === 0) return;
    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    const { width, height } = ctx.canvas;
    const maxVol = Math.max(...this.bins.map(b => b.volume));
    const barWidth = width / (this.bins.length || 1);

    for (let i = 0; i < this.bins.length; i++) {
      const bin = this.bins[i];
      const volRatio = bin.volume / maxVol;
      const barHeight = volRatio * height * 0.4;
      const x = i * barWidth;
      const y = height - barHeight;

      const ratio = bin.buyVolume / Math.max(bin.volume, 0.001);
      const r = Math.round(255 * (1 - ratio));
      const g = Math.round(255 * ratio);
      ctx.fillStyle = `rgb(${r},${g},50)`;
      ctx.fillRect(x, y, barWidth - 1, barHeight);
    }
  }

  destroy(): void {
    this.bins = [];
  }
}
