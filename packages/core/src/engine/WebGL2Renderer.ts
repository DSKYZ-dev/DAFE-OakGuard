import type { RenderBackend, ChartConfig, RenderStats } from '@dafe/types';
import type { RendererBackend } from './Renderer';

export class WebGL2Renderer implements RendererBackend {
  readonly type: RenderBackend = 'webgl2';
  private gl: WebGL2RenderingContext | null = null;
  private config: ChartConfig | null = null;

  async initialize(canvas: HTMLCanvasElement, config: ChartConfig): Promise<void> {
    this.config = config;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!this.gl) throw new Error('Could not create WebGL2 context');
    this.gl.clearColor(0.05, 0.05, 0.08, 1.0);
  }

  resize(width: number, height: number): void {
    if (this.gl) {
      this.gl.viewport(0, 0, width, height);
    }
  }

  render(): void {
    if (!this.gl) return;
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
  }

  destroy(): void {
    this.gl = null;
  }

  getStats(): RenderStats {
    return { fps: 0, drawCalls: 0, triangles: 0, gpuMemory: 0, workerLatency: 0 };
  }
}
