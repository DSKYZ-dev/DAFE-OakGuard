import type { LayerConfig, RenderStats } from '@dafe/types';
import type { Layer } from '../layers/Layer';

export class Compositor {
  private layers: Map<string, Layer> = new Map();
  private sortedLayers: Layer[] = [];
  private dirty = true;

  addLayer(layer: Layer): void {
    this.layers.set(layer.id, layer);
    this.dirty = true;
  }

  removeLayer(id: string): void {
    this.layers.delete(id);
    this.dirty = true;
  }

  getLayer(id: string): Layer | undefined {
    return this.layers.get(id);
  }

  private sortLayers(): void {
    this.sortedLayers = Array.from(this.layers.values())
      .filter(l => l.config.enabled)
      .sort((a, b) => a.config.zIndex - b.config.zIndex);
    this.dirty = false;
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    if (this.dirty) this.sortLayers();
    for (const layer of this.sortedLayers) {
      await layer.render(device);
    }
  }

  updateConfig(id: string, config: Partial<LayerConfig>): void {
    const layer = this.layers.get(id);
    if (layer) {
      Object.assign(layer.config, config);
      this.dirty = true;
    }
  }

  getRenderStats(): RenderStats[] {
    return this.sortedLayers.map(l => l.getStats());
  }

  destroy(): void {
    for (const layer of this.layers.values()) {
      layer.destroy();
    }
    this.layers.clear();
    this.sortedLayers = [];
  }
}
