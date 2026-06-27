export class TouchController {
  private element: HTMLElement;
  private onPan: ((dx: number, dy: number) => void) | null = null;
  private onPinch: ((scale: number) => void) | null = null;
  private lastTouches: Map<number, { x: number; y: number }> = new Map();
  private lastPinchDist = 0;

  constructor(element: HTMLElement) {
    this.element = element;
    this.attach();
  }

  private attach(): void {
    this.element.addEventListener('touchstart', this.onTouchStart);
    this.element.addEventListener('touchmove', this.onTouchMove);
    this.element.addEventListener('touchend', this.onTouchEnd);
  }

  private onTouchStart = (e: TouchEvent): void => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      this.lastTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
    if (e.touches.length === 2) {
      this.lastPinchDist = this.getPinchDist(e.touches);
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const last = this.lastTouches.get(touch.identifier);
      if (last && this.onPan) {
        this.onPan(touch.clientX - last.x, touch.clientY - last.y);
      }
      this.lastTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }

    if (e.touches.length === 2 && this.onPinch) {
      const dist = this.getPinchDist(e.touches);
      if (this.lastPinchDist > 0) {
        this.onPinch(dist / this.lastPinchDist);
      }
      this.lastPinchDist = dist;
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      this.lastTouches.delete(touch.identifier);
    }
    this.lastPinchDist = 0;
  };

  private getPinchDist(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  onPanCallback(cb: (dx: number, dy: number) => void): void {
    this.onPan = cb;
  }

  onPinchCallback(cb: (scale: number) => void): void {
    this.onPinch = cb;
  }

  detach(): void {
    this.element.removeEventListener('touchstart', this.onTouchStart);
    this.element.removeEventListener('touchmove', this.onTouchMove);
    this.element.removeEventListener('touchend', this.onTouchEnd);
  }
}
