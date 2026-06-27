import { Layer } from './Layer';
import type { LayerConfig } from '@dafe/types';

export interface Drawing {
  id: string;
  type: 'trendline' | 'fibonacci' | 'rectangle' | 'ellipse' | 'text';
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  label?: string;
}

export class DrawingLayer extends Layer {
  private drawings: Drawing[] = [];

  constructor(config?: Partial<LayerConfig>) {
    super('drawings', { zIndex: 6, ...config });
  }

  addDrawing(drawing: Drawing): void {
    this.drawings.push(drawing);
  }

  removeDrawing(id: string): void {
    this.drawings = this.drawings.filter(d => d.id !== id);
  }

  clear(): void {
    this.drawings = [];
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    for (const d of this.drawings) {
      ctx.strokeStyle = d.color;
      ctx.lineWidth = d.lineWidth;
      ctx.beginPath();

      for (let i = 0; i < d.points.length; i++) {
        if (i === 0) ctx.moveTo(d.points[i].x, d.points[i].y);
        else ctx.lineTo(d.points[i].x, d.points[i].y);
      }
      ctx.stroke();

      if (d.label) {
        ctx.fillStyle = d.color;
        ctx.font = '12px sans-serif';
        const last = d.points[d.points.length - 1];
        ctx.fillText(d.label, last.x + 5, last.y - 5);
      }
    }
  }

  destroy(): void {
    this.drawings = [];
  }
}
