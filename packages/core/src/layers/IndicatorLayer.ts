import { Layer } from './Layer';
import type { LayerConfig } from '@dafe/types';

export interface IndicatorOverlay {
  id: string;
  name: string;
  data: Float32Array;
  color: string;
  lineWidth: number;
}

export class IndicatorLayer extends Layer {
  private overlays: Map<string, IndicatorOverlay> = new Map();

  constructor(config?: Partial<LayerConfig>) {
    super('indicators', { zIndex: 5, ...config });
  }

  addOverlay(overlay: IndicatorOverlay): void {
    this.overlays.set(overlay.id, overlay);
  }

  removeOverlay(id: string): void {
    this.overlays.delete(id);
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    for (const overlay of this.overlays.values()) {
      ctx.strokeStyle = overlay.color;
      ctx.lineWidth = overlay.lineWidth;
      ctx.beginPath();

      const { width, height } = ctx.canvas;
      const stepX = width / (overlay.data.length - 1);

      for (let i = 0; i < overlay.data.length; i++) {
        const x = i * stepX;
        const y = height - ((overlay.data[i] + 1) / 2) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  destroy(): void {
    this.overlays.clear();
  }
}
