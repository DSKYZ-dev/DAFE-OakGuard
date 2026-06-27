import type { LayerConfig, RenderStats } from '@dafe/types';

export abstract class Layer {
  readonly id: string;
  config: LayerConfig;

  constructor(id: string, config: Partial<LayerConfig> = {}) {
    this.id = id;
    this.config = {
      id,
      zIndex: 0,
      enabled: true,
      opacity: 1.0,
      ...config,
    };
  }

  abstract render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void>;
  abstract destroy(): void;

  getStats(): RenderStats {
    return { fps: 0, drawCalls: 0, triangles: 0, gpuMemory: 0, workerLatency: 0 };
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  setOpacity(opacity: number): void {
    this.config.opacity = Math.max(0, Math.min(1, opacity));
  }
}
