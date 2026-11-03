/**
 * Minimized windows become tabs along the bottom-left edge. Every tab has the
 * same width, height and style, so the set reads as one row whichever window
 * it came from. A tab restores its window where it was left.
 */

const TAB_WIDTH = 176;
const DOCK_HEIGHT = 26;

interface DockedWindow {
  title: string;
  el: HTMLElement;
  display: string;
}

const docked = new Map<string, DockedWindow>();
let dock: HTMLDivElement | null = null;

function injectStyles(): void {
  if (document.getElementById('window-dock-styles')) return;
  const style = document.createElement('style');
  style.id = 'window-dock-styles';
  style.textContent = `
    #window-dock {
      position: fixed; left: 12px; bottom: 0; z-index: 10002;
      display: none; align-items: flex-end; gap: 4px;
      height: ${DOCK_HEIGHT}px; max-width: calc(100vw - 24px);
      overflow-x: auto; scrollbar-width: none;
    }
    #window-dock::-webkit-scrollbar { display: none; }
    .window-dock-tab {
      flex: 0 0 ${TAB_WIDTH}px; width: ${TAB_WIDTH}px; height: 22px; margin: 0; padding: 0 10px;
      box-sizing: border-box; display: flex; align-items: center; justify-content: center;
      background: rgba(12, 12, 28, 0.94); border: 1px solid rgba(180, 140, 255, 0.28);
      border-bottom: none; border-radius: 6px 6px 0 0;
      color: rgba(236, 232, 255, 0.85); cursor: pointer;
      font: 600 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase;
    }
    .window-dock-tab span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .window-dock-tab:hover { background: rgba(45, 255, 179, 0.1); border-color: rgba(45, 255, 179, 0.55); color: #fff; }
    .window-dock-tab:focus-visible { outline: 1px solid rgba(45, 255, 179, 0.7); outline-offset: -2px; }
  `;
  document.head.appendChild(style);
}

function ensureDock(): HTMLDivElement {
  if (dock) return dock;
  injectStyles();
  dock = document.createElement('div');
  dock.id = 'window-dock';
  document.body.appendChild(dock);
  return dock;
}

function render(): void {
  const d = ensureDock();
  d.replaceChildren(...[...docked].map(([id, w]) => tab(id, w)));
  d.style.display = docked.size > 0 ? 'flex' : 'none';
}

function tab(id: string, w: DockedWindow): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'window-dock-tab';
  b.title = `Restore ${w.title}`;
  const label = document.createElement('span');
  label.textContent = w.title;
  b.appendChild(label);
  b.addEventListener('click', () => restoreWindow(id));
  return b;
}

/** Minimize a window to its tab. The window keeps its state; only its display changes. */
export function minimizeWindow(id: string, title: string, el: HTMLElement): void {
  if (docked.has(id) || el.style.display === 'none') return;
  docked.set(id, { title, el, display: el.style.display });
  el.style.display = 'none';
  render();
}

/** Bring a minimized window back where it was. A window that is not minimized is left alone. */
export function restoreWindow(id: string): void {
  const w = docked.get(id);
  if (!w) return;
  docked.delete(id);
  w.el.style.display = w.display;
  render();
}

/** Drop a window's tab when the window is closed or hidden by other code. */
export function forgetWindow(id: string): void {
  if (docked.delete(id)) render();
}

export function isMinimized(id: string): boolean {
  return docked.has(id);
}
