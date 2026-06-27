import type { ChartMode } from '@dafe/types';

export interface MouseState {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  isDragging: boolean;
  isHovering: boolean;
}

export class MouseController {
  private state: MouseState = { x: 0, y: 0, worldX: 0, worldY: 0, isDragging: false, isHovering: false };
  private onPan: ((dx: number, dy: number) => void) | null = null;
  private onZoom: ((delta: number, mode: ChartMode) => void) | null = null;
  private onClick: ((x: number, y: number) => void) | null = null;

  constructor(private element: HTMLElement) {
    this.attach();
  }

  private attach(): void {
    this.element.addEventListener('mousedown', this.onMouseDown);
    this.element.addEventListener('mousemove', this.onMouseMove);
    this.element.addEventListener('mouseup', this.onMouseUp);
    this.element.addEventListener('wheel', this.onWheel);
  }

  private onMouseDown = (e: MouseEvent): void => {
    this.state.isDragging = true;
    this.state.x = e.clientX;
    this.state.y = e.clientY;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const dx = e.clientX - this.state.x;
    const dy = e.clientY - this.state.y;

    if (this.state.isDragging && this.onPan) {
      this.onPan(dx, dy);
    }

    this.state.x = e.clientX;
    this.state.y = e.clientY;
    this.state.isHovering = true;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.state.isDragging) {
      this.state.isDragging = false;
      if (this.onClick) this.onClick(e.clientX, e.clientY);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.onZoom) {
      this.onZoom(-e.deltaY, e.shiftKey ? '3D' : '2D');
    }
  };

  onPanCallback(cb: (dx: number, dy: number) => void): void {
    this.onPan = cb;
  }

  onZoomCallback(cb: (delta: number, mode: ChartMode) => void): void {
    this.onZoom = cb;
  }

  onClickCallback(cb: (x: number, y: number) => void): void {
    this.onClick = cb;
  }

  getState(): MouseState {
    return { ...this.state };
  }

  detach(): void {
    this.element.removeEventListener('mousedown', this.onMouseDown);
    this.element.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('mouseup', this.onMouseUp);
    this.element.removeEventListener('wheel', this.onWheel);
  }
}
