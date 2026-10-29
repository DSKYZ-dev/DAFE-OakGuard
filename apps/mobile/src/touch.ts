export interface GestureCallbacks {
  onPan?: (dx: number, dy: number) => void;
  onPanEnd?: (vx: number, vy: number) => void;
  onPinch?: (scale: number, cx: number, cy: number) => void;
  onTap?: (x: number, y: number) => void;
  onDoubleTap?: (x: number, y: number) => void;
  onLongPress?: (x: number, y: number) => void;
  onMove?: (x: number, y: number) => void;
  onMoveEnd?: () => void;
}

const LONG_PRESS_MS = 420;
const DOUBLE_TAP_MS = 300;
const MOVE_SLOP = 12;

interface TouchInfo { x: number; y: number; lastX: number; lastY: number; t: number; }

export class TouchEngine {
  private el: HTMLElement;
  private cb: GestureCallbacks;
  private touches = new Map<number, TouchInfo>();
  private pinchDist = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;
  private moved = false;
  private lastTap = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private velX = 0;
  private velY = 0;
  private lastMoveT = 0;
  private lastMoveX = 0;
  private lastMoveY = 0;

  constructor(el: HTMLElement, cb: GestureCallbacks) {
    this.el = el;
    this.cb = cb;
    this.attach();
  }

  private attach(): void {
    this.el.addEventListener('touchstart', this.onStart, { passive: false });
    this.el.addEventListener('touchmove', this.onMove, { passive: false });
    this.el.addEventListener('touchend', this.onEnd, { passive: false });
    this.el.addEventListener('touchcancel', this.onEnd, { passive: false });
  }

  private onStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.moved = false;
    this.longPressed = false;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      this.touches.set(t.identifier, { x: t.clientX, y: t.clientY, lastX: t.clientX, lastY: t.clientY, t: performance.now() });
    }
    if (this.touches.size === 1) {
      const t = this.touches.values().next().value!;
      this.velX = 0;
      this.velY = 0;
      this.lastMoveT = performance.now();
      this.lastMoveX = t.x;
      this.lastMoveY = t.y;
      this.longPressTimer = setTimeout(() => {
        if (!this.moved && this.touches.size === 1) {
          this.longPressed = true;
          navigator.vibrate?.(15);
          this.cb.onLongPress?.(t.x, t.y);
        }
      }, LONG_PRESS_MS);
    } else if (this.touches.size === 2) {
      this.clearLongPress();
      const arr = Array.from(this.touches.values());
      this.pinchDist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    }
  };

  private onMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const info = this.touches.get(t.identifier);
      if (info) {
        info.lastX = info.x;
        info.lastY = info.y;
        info.x = t.clientX;
        info.y = t.clientY;
      }
    }
    if (this.touches.size === 1) {
      const info = this.touches.values().next().value!;
      const dx = info.x - info.lastX;
      const dy = info.y - info.lastY;
      if (!this.moved && Math.hypot(info.x - info.lastX, info.y - info.lastY) < 1) return;
      if (!this.moved && (Math.abs(info.x - this.lastMoveX) > MOVE_SLOP || Math.abs(info.y - this.lastMoveY) > MOVE_SLOP)) {
        this.moved = true;
        this.clearLongPress();
      }
      if (this.moved && !this.longPressed) {
        this.cb.onPan?.(dx, dy);
        this.cb.onMove?.(info.x, info.y);
        const now = performance.now();
        const dt = Math.max(1, now - this.lastMoveT);
        this.velX = 0.8 * (dx / dt) * 1000 + 0.2 * this.velX;
        this.velY = 0.8 * (dy / dt) * 1000 + 0.2 * this.velY;
        this.lastMoveT = now;
        this.lastMoveX = info.x;
        this.lastMoveY = info.y;
      }
    } else if (this.touches.size === 2) {
      this.clearLongPress();
      const arr = Array.from(this.touches.values());
      const dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      if (this.pinchDist > 0) {
        const cx = (arr[0].x + arr[1].x) / 2;
        const cy = (arr[0].y + arr[1].y) / 2;
        this.cb.onPinch?.(dist / this.pinchDist, cx, cy);
      }
      this.pinchDist = dist;
    }
  };

  private onEnd = (e: TouchEvent): void => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      this.touches.delete(t.identifier);
    }
    if (this.touches.size === 0) {
      this.clearLongPress();
      if (this.moved && !this.longPressed) {
        this.cb.onPanEnd?.(this.velX, this.velY);
        this.cb.onMoveEnd?.();
      } else if (!this.moved && !this.longPressed) {
        const t = e.changedTouches[0];
        const now = performance.now();
        if (now - this.lastTap < DOUBLE_TAP_MS && Math.abs(t.clientX - this.lastTapX) < 40 && Math.abs(t.clientY - this.lastTapY) < 40) {
          this.lastTap = 0;
          this.cb.onDoubleTap?.(t.clientX, t.clientY);
        } else {
          this.lastTap = now;
          this.lastTapX = t.clientX;
          this.lastTapY = t.clientY;
          this.cb.onTap?.(t.clientX, t.clientY);
        }
      }
      this.moved = false;
      this.longPressed = false;
    } else if (this.touches.size === 1) {
      this.pinchDist = 0;
    }
  };

  private clearLongPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  detach(): void {
    this.clearLongPress();
    this.el.removeEventListener('touchstart', this.onStart);
    this.el.removeEventListener('touchmove', this.onMove);
    this.el.removeEventListener('touchend', this.onEnd);
    this.el.removeEventListener('touchcancel', this.onEnd);
  }
}