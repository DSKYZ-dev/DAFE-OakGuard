/**
 * Shared behaviour for floating windows. Pressing a window raises it above the
 * other windows, and the fullscreen toggle fills the viewport, then restores
 * the exact rectangle the window had before. Minimizing lives in window-dock.ts.
 */

// Raised windows take z-indexes from this base upward. Windows that have not
// been raised keep their lower resting z-index, so a raised window always lands
// on top. window-dock.ts sits above this band, and the confirm dialog (10050)
// sits above that.
const WINDOW_Z_BASE = 10010;

let stack: HTMLElement[] = [];

/** Move a window to the top of the stack. */
function raiseWindow(el: HTMLElement): void {
  stack = [...stack.filter(w => w !== el && w.isConnected), el];
  stack.forEach((w, i) => { w.style.zIndex = String(WINDOW_Z_BASE + i); });
}

/** Raise a window whenever the pointer goes down anywhere inside it. */
export function raiseOnPress(el: HTMLElement): void {
  el.addEventListener('pointerdown', () => raiseWindow(el), true);
}

interface Frame {
  left: string;
  top: string;
  width: string;
  height: string;
  maxHeight: string;
  borderRadius: string;
}

const frameBeforeFullscreen = new WeakMap<HTMLElement, Frame>();

export function isFullscreen(el: HTMLElement): boolean {
  return frameBeforeFullscreen.has(el);
}

/** Fill the viewport, or restore the rectangle the window had before. Returns true while full. */
export function toggleFullscreen(el: HTMLElement): boolean {
  const before = frameBeforeFullscreen.get(el);
  if (before) {
    frameBeforeFullscreen.delete(el);
    Object.assign(el.style, before);
    return false;
  }
  frameBeforeFullscreen.set(el, {
    left: el.style.left,
    top: el.style.top,
    width: el.style.width,
    height: el.style.height,
    maxHeight: el.style.maxHeight,
    borderRadius: el.style.borderRadius,
  });
  Object.assign(el.style, {
    left: '0px',
    top: '0px',
    width: `${window.innerWidth}px`,
    height: `${window.innerHeight}px`,
    maxHeight: 'none',
    borderRadius: '0px',
  });
  return true;
}
