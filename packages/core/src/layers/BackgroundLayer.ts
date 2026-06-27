import { Layer } from './Layer';
import type { LayerConfig } from '@dafe/types';

export class BackgroundLayer extends Layer {
  private gradient: CanvasGradient | null = null;

  constructor(config: Partial<LayerConfig> = {}) {
    super('background', { zIndex: 0, ...config });
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    const { width, height } = ctx.canvas;
    if (!this.gradient || this.gradient !== undefined) {
      this.gradient = ctx.createLinearGradient(0, 0, 0, height);
      this.gradient.addColorStop(0, '#0a0a14');
      this.gradient.addColorStop(0.5, '#0d0d1a');
      this.gradient.addColorStop(1, '#050510');
    }
    ctx.fillStyle = this.gradient;
    ctx.fillRect(0, 0, width, height);
  }

  destroy(): void {
    this.gradient = null;
  }
}
