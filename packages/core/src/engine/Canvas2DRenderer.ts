import type { RenderBackend, ChartConfig, RenderStats } from '@dafe/types';
import type { RendererBackend } from './Renderer';

export class Canvas2DRenderer implements RendererBackend {
  readonly type: RenderBackend = 'canvas2d';
  private ctx: CanvasRenderingContext2D | null = null;
  private config: ChartConfig | null = null;

  async initialize(canvas: HTMLCanvasElement, config: ChartConfig): Promise<void> {
    this.config = config;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('Could not create 2D context');
  }

  resize(width: number, height: number): void {
    // Canvas size set by element
  }

  render(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  destroy(): void {
    this.ctx = null;
  }

  getStats(): RenderStats {
    return { fps: 0, drawCalls: 0, triangles: 0, gpuMemory: 0, workerLatency: 0 };
  }
}
