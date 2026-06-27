import type { BaseBar } from '@dafe/types';

export interface RaycastHit {
  barIndex: number;
  bar: BaseBar;
  distance: number;
  point: { x: number; y: number };
}

export class Raycaster {
  private bars: BaseBar[] = [];
  private scale = { priceScale: 1, timeScale: 1, priceOffset: 0, timeOffset: 0 };

  setBars(bars: BaseBar[]): void {
    this.bars = bars;
  }

  setScale(scale: { priceScale: number; timeScale: number; priceOffset: number; timeOffset: number }): void {
    this.scale = scale;
  }

  hitTest(mouseX: number, mouseY: number, canvasWidth: number, canvasHeight: number): RaycastHit | null {
    const hitRadius = 5;
    let closest: RaycastHit | null = null;

    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i];
      const x = (bar.timestamp - this.scale.timeOffset) * this.scale.timeScale;
      const highY = (bar.high - this.scale.priceOffset) * this.scale.priceScale;
      const lowY = (bar.low - this.scale.priceOffset) * this.scale.priceScale;

      if (Math.abs(mouseX - x) < hitRadius && mouseY >= lowY && mouseY <= highY) {
        const dist = Math.abs(mouseX - x);
        if (!closest || dist < closest.distance) {
          closest = { barIndex: i, bar, distance: dist, point: { x, y: (highY + lowY) / 2 } };
        }
      }
    }

    return closest;
  }
}
