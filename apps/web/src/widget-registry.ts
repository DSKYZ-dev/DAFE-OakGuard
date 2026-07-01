/**
 * Central registry so every closable widget can be reopened from one menu
 * instead of being lost once its own close button is clicked.
 */
export interface RegisteredWidget {
  name: string;
  show: () => void;
  hide: () => void;
  isVisible: () => boolean;
}

const widgets: RegisteredWidget[] = [];

export function registerWidget(w: RegisteredWidget): void {
  widgets.push(w);
}

export function getRegisteredWidgets(): RegisteredWidget[] {
  return widgets;
}

export function initWidgetMenu(toggleId: string, menuId: string): void {
  const toggle = document.getElementById(toggleId);
  const menu = document.getElementById(menuId);
  if (!toggle || !menu) return;

  function render(): void {
    if (!menu) return;
    menu.innerHTML = '';
    for (const w of widgets) {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 10px;cursor:pointer;color:rgba(255,255,255,0.75);';
      item.onmouseenter = () => { item.style.background = 'rgba(180,140,255,0.12)'; };
      item.onmouseleave = () => { item.style.background = 'transparent'; };
      const visible = w.isVisible();
      item.innerHTML = `<span>${w.name}</span><span style="opacity:${visible ? '1' : '0.3'}">${visible ? '●' : '○'}</span>`;
      item.onclick = () => {
        if (w.isVisible()) w.hide(); else w.show();
        render();
      };
      menu.appendChild(item);
    }
    if (widgets.length === 0) {
      menu.innerHTML = '<div style="padding:6px 10px;color:rgba(255,255,255,0.3)">No widgets registered</div>';
    }
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.style.display !== 'none';
    if (open) { menu.style.display = 'none'; return; }
    render();
    menu.style.display = 'block';
  });
  document.addEventListener('click', (e) => {
    if (menu.style.display === 'none') return;
    if (e.target === toggle || menu.contains(e.target as Node)) return;
    menu.style.display = 'none';
  });
}
