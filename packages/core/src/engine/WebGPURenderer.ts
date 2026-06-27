import type { RenderBackend, ChartConfig, RenderStats } from '@dafe/types';
import type { RendererBackend } from './Renderer';

export class WebGPURenderer implements RendererBackend {
  readonly type: RenderBackend = 'webgpu';
  private device: GPUDevice | null = null;
  private queue: GPUQueue | null = null;
  private context: GPUCanvasContext | null = null;
  private config: ChartConfig | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private presentationFormat: GPUTextureFormat = 'bgra8unorm';

  async initialize(canvas: HTMLCanvasElement, config: ChartConfig): Promise<void> {
    this.canvas = canvas;
    this.config = config;

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter available');
    this.device = await adapter.requestDevice();
    this.queue = this.device.queue;

    this.context = canvas.getContext('webgpu');
    if (!this.context) throw new Error('Could not get WebGPU context');

    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });
  }

  resize(width: number, height: number): void {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  render(): void {
    if (!this.device || !this.context || !this.queue) return;
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.end();

    this.queue.submit([commandEncoder.finish()]);
  }

  destroy(): void {
    this.device?.destroy();
    this.device = null;
    this.context = null;
    this.queue = null;
  }

  getStats(): RenderStats {
    return { fps: 0, drawCalls: 0, triangles: 0, gpuMemory: 0, workerLatency: 0 };
  }
}
