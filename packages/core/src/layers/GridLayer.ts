import { Layer } from './Layer';
import type { LayerConfig } from '@dafe/types';

export interface GridConfig {
  horizontalLines: number;
  verticalLines: number;
  lineColor: string;
  lineWidth: number;
  labelColor: string;
  labelFont: string;
}

export class GridLayer extends Layer {
  private gridConfig: GridConfig;

  constructor(gridConfig?: Partial<GridConfig>, layerConfig?: Partial<LayerConfig>) {
    super('grid', { zIndex: 1, ...layerConfig });
    this.gridConfig = {
      horizontalLines: 10,
      verticalLines: 20,
      lineColor: 'rgba(255,255,255,0.06)',
      lineWidth: 0.5,
      labelColor: 'rgba(255,255,255,0.3)',
      labelFont: '11px monospace',
      ...gridConfig,
    };
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    const { width, height } = ctx.canvas;
    const { horizontalLines, verticalLines, lineColor, lineWidth, labelColor, labelFont } = this.gridConfig;

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = lineWidth;
    ctx.font = labelFont;
    ctx.fillStyle = labelColor;

    const hStep = height / (horizontalLines + 1);
    for (let i = 1; i <= horizontalLines; i++) {
      const y = hStep * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const vStep = width / (verticalLines + 1);
    for (let i = 1; i <= verticalLines; i++) {
      const x = vStep * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  destroy(): void {}
}
