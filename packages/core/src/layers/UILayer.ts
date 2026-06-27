import { Layer } from './Layer';
import type { LayerConfig } from '@dafe/types';

export interface UIElement {
  id: string;
  type: 'tooltip' | 'crosshair' | 'legend' | 'label';
  x: number;
  y: number;
  text: string;
  color?: string;
}

export class UILayer extends Layer {
  private elements: UIElement[] = [];

  constructor(config?: Partial<LayerConfig>) {
    super('ui', { zIndex: 7, ...config });
  }

  setElements(elements: UIElement[]): void {
    this.elements = elements;
  }

  addElement(el: UIElement): void {
    this.elements.push(el);
  }

  removeElement(id: string): void {
    this.elements = this.elements.filter(e => e.id !== id);
  }

  async render(device: GPUDevice | WebGL2RenderingContext | CanvasRenderingContext2D): Promise<void> {
    const ctx = device as CanvasRenderingContext2D;
    if (!ctx || !(ctx instanceof CanvasRenderingContext2D)) return;

    for (const el of this.elements) {
      ctx.fillStyle = el.color || 'rgba(255,255,255,0.9)';
      ctx.font = '12px monospace';
      ctx.fillText(el.text, el.x, el.y);
    }
  }

  destroy(): void {
    this.elements = [];
  }
}
