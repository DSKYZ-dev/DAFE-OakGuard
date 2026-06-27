import type { RenderBackend, ChartConfig, RenderStats } from '@dafe/types';

export interface RendererBackend {
  readonly type: RenderBackend;
  initialize(canvas: HTMLCanvasElement, config: ChartConfig): Promise<void>;
  resize(width: number, height: number): void;
  render(): void;
  destroy(): void;
  getStats(): RenderStats;
}

export class Renderer {
  private backend: RendererBackend | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private config: ChartConfig | null = null;

  async initialize(canvas: HTMLCanvasElement, config: ChartConfig): Promise<void> {
    this.canvas = canvas;
    this.config = config;
    this.backend = await this.detectBackend(canvas, config);
    await this.backend.initialize(canvas, config);
  }

  private async detectBackend(canvas: HTMLCanvasElement, config: ChartConfig): Promise<RendererBackend> {
    if (config.mode === '3D') {
      const { ThreeRenderer } = await import('./ThreeRenderer');
      return new ThreeRenderer();
    }
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const { WebGPURenderer } = await import('./WebGPURenderer');
        return new WebGPURenderer();
      }
    }
    const gl = canvas.getContext('webgl2');
    if (gl) {
      const { WebGL2Renderer } = await import('./WebGL2Renderer');
      return new WebGL2Renderer();
    }
    const { Canvas2DRenderer } = await import('./Canvas2DRenderer');
    return new Canvas2DRenderer();
  }

  resize(width: number, height: number): void {
    this.backend?.resize(width, height);
  }

  render(): void {
    this.backend?.render();
  }

  destroy(): void {
    this.backend?.destroy();
  }

  getStats(): RenderStats {
    return this.backend?.getStats() ?? { fps: 0, drawCalls: 0, triangles: 0, gpuMemory: 0, workerLatency: 0 };
  }
}
