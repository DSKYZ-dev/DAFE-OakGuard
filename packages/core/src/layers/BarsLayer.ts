import { Layer } from './Layer';
import type { LayerConfig, BaseBar, Scale, BarGeometry } from '@dafe/types';
import type { BarEngine } from '../bars/BarEngine';

export class BarsLayer extends Layer {
  private engine: BarEngine | null = null;
  private bars: BaseBar[] = [];
  private scale: Scale = { priceScale: 1, timeScale: 1, priceOffset: 0, timeOffset: 0 };

  constructor(config?: Partial<LayerConfig>) {
    super('bars', { zIndex: 3, ...config });
  }

  setEngine(engine: BarEngine): void {
    this.engine = engine;
  }

  setBars(bars: BaseBar[]): void {
    this.bars = bars;
  }

  setScale(scale: Scale): void {
    this.scale = scale;
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    if (!this.engine || this.bars.length === 0) return;

    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    for (const bar of this.bars) {
      const geometry = this.engine.getGeometry(bar, this.scale);
      this.drawGeometry(ctx, geometry);
    }
  }

  private drawGeometry(ctx: CanvasRenderingContext2D, geo: BarGeometry): void {
    const positions = geo.positions;
    const colors = geo.colors;
    const step = 2;

    for (let i = 0; i < positions.length; i += step * 3) {
      const x1 = positions[i];
      const y1 = positions[i + 1];
      const x2 = positions[i + 2];
      const y2 = positions[i + 3];
      const x3 = positions[i + 4];
      const y3 = positions[i + 5];

      const r = colors[i / step];
      const g = colors[i / step + 1];
      const b = colors[i / step + 2];

      ctx.fillStyle = `rgb(${r * 255},${g * 255},${b * 255})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
    }
  }

  destroy(): void {
    this.engine = null;
    this.bars = [];
  }
}
