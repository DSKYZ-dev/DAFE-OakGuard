/**
 * Universal Dashboard Widget — Auto-populates from all active OakScript indicators.
 * Single movable/resizable/scrollable panel with adjustable text size.
 */
import { getActiveInstances } from './indicator-manager';
import type { IndicatorInstance } from './indicator-manager';
import type { OakPlot } from './oakscript/runtime';
import type { InputDef } from './oakscript/editor';
import { TOOLBAR_BAND, clearOfToolbarTop, overlapsToolbarBand } from './toolbar-band';
import { WINDOW_TOP_MIN, NEWS_BOX_BOTTOM, WINDOW_GAP, clearOfHeaderTop } from './header-band';

export function createDashboard(): {
  panel: HTMLDivElement;
  refresh: () => void;
  toggle: () => void;
  show: () => void;
  hide: () => void;
  destroy: () => void;
} {
  const panel = document.createElement('div');
  panel.id = 'dafe-dashboard';
  Object.assign(panel.style, {
    position: 'fixed',
    right: '12px',
    top: `${WINDOW_TOP_MIN}px`,
    width: '320px',
    minWidth: '240px',
    minHeight: '180px',
    maxHeight: '75vh',
    background: 'rgba(8, 8, 20, 0.94)',
    border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '10px',
    display: 'none',
    flexDirection: 'column',
    zIndex: '202',
    backdropFilter: 'blur(12px)',
    boxShadow: '0 6px 30px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  });

  let placedBySaved = false;
  // Restore position
  try {
    const saved = JSON.parse(localStorage.getItem('dafe_dashboard_bounds') || 'null');
    // A window saved over the bottom toolbar covers its selects and buttons, so
    // drop that position and open the window in its default place instead.
    const onToolbar = !!saved
      && overlapsToolbarBand(saved.left || 0, saved.width || 0, (saved.top || 0) + (saved.height || 0));
    if (onToolbar) localStorage.removeItem('dafe_dashboard_bounds');
    else if (saved) {
      placedBySaved = true;
      if (saved.left) { panel.style.left = `${saved.left}px`; panel.style.right = 'auto'; }
      if (saved.top) panel.style.top = `${clearOfHeaderTop(saved.top)}px`;
      if (saved.width) panel.style.width = `${saved.width}px`;
      if (saved.height) panel.style.maxHeight = `${saved.height}px`;
    }
  } catch {}

  // Header
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '7px 10px', borderBottom: '1px solid rgba(180, 140, 255, 0.1)',
    cursor: 'move', userSelect: 'none', flexShrink: '0',
  });

  const titleSpan = document.createElement('span');
  titleSpan.style.cssText = 'color:#b48cff;font-size:11px;font-weight:600;';
  titleSpan.textContent = '📊 Dashboard';

  const btnGroup = document.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:4px;align-items:center;';

  const sizeDown = document.createElement('button');
  sizeDown.textContent = 'A-';
  sizeDown.title = 'Smaller text';
  sizeDown.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:9px;padding:2px 6px;border-radius:4px;';

  const sizeUp = document.createElement('button');
  sizeUp.textContent = 'A+';
  sizeUp.title = 'Larger text';
  sizeUp.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:9px;padding:2px 6px;border-radius:4px;';

  const collapseBtn = document.createElement('button');
  collapseBtn.textContent = '−';
  collapseBtn.title = 'Collapse';
  collapseBtn.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:12px;padding:1px 7px;border-radius:4px;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:1px solid rgba(255,255,255,0.1);color:#888;cursor:pointer;font-size:10px;padding:1px 6px;border-radius:4px;';
  closeBtn.onclick = () => { panel.style.display = 'none'; };

  btnGroup.appendChild(sizeDown);
  btnGroup.appendChild(sizeUp);
  btnGroup.appendChild(collapseBtn);
  btnGroup.appendChild(closeBtn);
  header.appendChild(titleSpan);
  header.appendChild(btnGroup);
  panel.appendChild(header);

  // Drag logic
  let dragX = 0, dragY = 0, dragging = false;
  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dragX = e.clientX - r.left;
    dragY = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.right = 'auto';
    placedBySaved = true;
    const left = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragX));
    const top = clearOfHeaderTop(clearOfToolbarTop(left, Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragY)), panel.offsetWidth, panel.offsetHeight));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      saveBounds();
    }
  });

  function saveBounds() {
    const r = panel.getBoundingClientRect();
    try { localStorage.setItem('dafe_dashboard_bounds', JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height })); } catch {}
  }

  // Content area (scrollable)
  const content = document.createElement('div');
  Object.assign(content.style, {
    flex: '1', overflowY: 'auto', padding: '8px 10px', minHeight: '0',
    fontFamily: 'monospace',
  });
  content.id = 'dafe-dashboard-content';
  panel.appendChild(content);

  // Resize handle
  const resizeHandle = document.createElement('div');
  Object.assign(resizeHandle.style, {
    position: 'absolute', left: '0', bottom: '0', width: '100%', height: '6px',
    cursor: 'ns-resize',
  });
  let resizing = false, startH = 0, startMY = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    resizing = true;
    startH = panel.offsetHeight;
    startMY = e.clientY;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    let nh = Math.max(200, startH + (e.clientY - startMY));
    const pr = panel.getBoundingClientRect();
    if (overlapsToolbarBand(pr.left, pr.width, pr.top + nh)) {
      nh = Math.max(200, window.innerHeight - TOOLBAR_BAND - pr.top);
    }
    panel.style.maxHeight = `${nh}px`;
    panel.style.height = `${nh}px`;
  });
  document.addEventListener('mouseup', () => { if (resizing) { resizing = false; saveBounds(); } });
  panel.appendChild(resizeHandle);

  // Text size
  let fontSize = 10;
  sizeDown.onclick = () => { fontSize = Math.max(7, fontSize - 1); updateFont(); };
  sizeUp.onclick = () => { fontSize = Math.min(16, fontSize + 1); updateFont(); };
  // Rows size themselves from fontSize when rendered, so re-render instead of
  // changing the container's base font (which shrank the text on A+).
  function updateFont() { widget.refresh(); }

  // Collapse toggle
  let collapsed = false;
  collapseBtn.onclick = () => {
    collapsed = !collapsed;
    collapseBtn.textContent = collapsed ? '+' : '−';
    content.style.display = collapsed ? 'none' : 'block';
    // Hiding `content` alone left the panel stuck at its 180px minHeight —
    // the outer panel enforces that floor regardless of the inner content's
    // visibility, so collapsing only hid the plot list while leaving a big
    // empty box below the header. Relax the panel's own height constraints
    // while collapsed so it actually shrinks to just the header.
    panel.style.minHeight = collapsed ? '0' : '180px';
    panel.style.maxHeight = collapsed ? 'none' : '75vh';
  };

  document.body.appendChild(panel);

  function colorBox(c: string): string {
    return `<span style="display:inline-block;width:8px;height:8px;background:${c};border-radius:2px;margin-right:3px;"></span>`;
  }

  function valColor(v: number, up: string, dn: string, neu: string): string {
    if (v > 0.3) return up;
    if (v < -0.3) return dn;
    return neu;
  }

  function formatVal(v: number): string {
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'K';
    if (Math.abs(v) >= 100) return v.toFixed(1);
    return v.toFixed(3);
  }

  const widget = {
    panel,
    refresh() {
      const all = getActiveInstances();
      // Honor each indicator's mandatory dashboard toggle (📊 in the Active
      // Indicators panel) — hidden ones keep rendering on the chart but stay
      // off this dash.
      const instances = all.filter(i => i.showInDashboard !== false);
      if (all.length === 0) {
        content.innerHTML = '<div style="color:rgba(255,255,255,0.25);font-size:10px;padding:8px;">No active indicators. Select one from the toolbar.</div>';
        return;
      }
      if (instances.length === 0) {
        content.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:10px;padding:8px;">All ${all.length} signal model${all.length > 1 ? 's are' : ' is'} hidden from the dashboard — use the 📊 toggle in the Active Signal Models panel to show metrics.</div>`;
        return;
      }

      let html = '';

      for (let idx = 0; idx < instances.length; idx++) {
        const inst = instances[idx];
        const categoryColors: Record<string, string> = {
          'Moving Averages': '#22cc88', 'Oscillators': '#b48cff', 'Volatility': '#ffa94d',
          'Volume': '#ffd166', 'Machine Learning': '#22aaff', '3D Visualizations': '#ff6b6b',
          'Adaptive Genesis': '#00FF9F',
        };
        const catColor = categoryColors[inst.category] || '#b48cff';

        // Section separator between indicators
        if (idx > 0) {
          html += `<div style="border-top:1px solid rgba(180,140,255,0.15);margin:6px 0;"></div>`;
        }

        // Indicator header
        html += `<div style="display:flex;align-items:center;gap:4px;margin-bottom:3px;">
          <span style="display:inline-block;width:8px;height:8px;background:${catColor};border-radius:2px;"></span>
          <span style="color:${catColor};font-size:${fontSize}px;font-weight:600;">${inst.name}</span>
          <span style="color:rgba(255,255,255,0.2);font-size:${fontSize - 2}px;">[${inst.category}]</span>
        </div>`;

        // Group plots
        const shapes: OakPlot[] = [];
        const hlines: OakPlot[] = [];
        const bgFills: OakPlot[] = [];
        const plot3ds: OakPlot[] = [];
        const mainPlots: OakPlot[] = [];
        const sepPlots: OakPlot[] = [];

        for (const p of inst.plots) {
          if (p.type === 'shape') shapes.push(p);
          else if (p.type === 'hline') hlines.push(p);
          else if (p.type === 'bgcolor' || p.type === 'fill') bgFills.push(p);
          else if (p.type === 'plot3d') plot3ds.push(p);
          else if (p.pane === 'separate') sepPlots.push(p);
          else mainPlots.push(p);
        }

        // Signal status
        if (shapes.length > 0) {
          const lastShape = shapes[shapes.length - 1];
          const isLong = (lastShape.style || '').includes('up');
          const dt = isLong ? '▲ LONG' : '▼ SHORT';
          const dc = isLong ? '#00FF9F' : '#FF006E';
          html += `<div style="color:${dc};font-size:${fontSize}px;font-weight:bold;margin:3px 0 0 8px;">${dt}</div>`;
        }

        // Main values
        // Note: plot()/hline() run once PER BAR (the script executes bar-by-bar
        // over the whole dataset), so `inst.plots` holds one entry per call per
        // bar — a 500-bar chart means ~500 near-duplicate pushes per plot(). Use
        // a Map keyed by name and keep overwriting it while iterating in bar
        // order, so the last (most recent/current) value per name wins instead
        // of silently freezing on bar 0's value.
        if (mainPlots.length > 0) {
          html += `<div style="color:rgba(255,255,255,0.3);font-size:${fontSize - 2}px;margin:4px 0 2px 4px;">Chart</div>`;
          const latest = new Map<string, OakPlot>();
          for (const p of mainPlots) {
            const n = (p.name || 'plot').trim();
            if (!n) continue;
            latest.set(n, p);
          }
          for (const [n, p] of latest) {
            const v = p.value ?? (p.price ?? 0);
            const c = p.color || '#b48cff';
            html += `<div style="font-size:${fontSize - 1}px;padding:1px 0 1px 8px;">${colorBox(c)}${n}: <span style="color:${c};">${formatVal(v)}</span></div>`;
          }
        }

        // Oscillator pane
        if (sepPlots.length > 0) {
          html += `<div style="color:rgba(255,255,255,0.3);font-size:${fontSize - 2}px;margin:4px 0 2px 4px;">Oscillator</div>`;
          const latest2 = new Map<string, OakPlot>();
          for (const p of sepPlots) {
            const n = (p.name || 'plot').trim();
            if (!n) continue;
            latest2.set(n, p);
          }
          for (const [n, p] of latest2) {
            const v = p.value ?? 0;
            const c = p.color || '#b48cff';
            html += `<div style="font-size:${fontSize - 1}px;padding:1px 0 1px 8px;">${colorBox(c)}${n}: <span style="color:${c};">${formatVal(v)}</span></div>`;
          }
        }

        // Levels — hline() has no `name` field, so dedupe by price+color instead
        // (the same call pushes the identical price/color every bar; this is
        // what was causing the same level(s) to repeat once per bar in the list).
        if (hlines.length > 0) {
          html += `<div style="color:rgba(255,255,255,0.3);font-size:${fontSize - 2}px;margin:4px 0 2px 4px;">Levels</div>`;
          const byLevel = new Map<string, OakPlot>();
          for (const h of hlines) {
            const v = h.price ?? 0;
            byLevel.set(`${v.toFixed(4)}|${h.color || ''}`, h);
          }
          for (const h of byLevel.values()) {
            const v = h.price ?? 0;
            html += `<div style="font-size:${fontSize - 1}px;padding:1px 0 1px 8px;">${colorBox(h.color || '#888')}<span style="color:rgba(255,255,255,0.4);">${v.toFixed(2)}</span></div>`;
          }
        }

        // 3D
        if (plot3ds.length > 0) {
          html += `<div style="color:rgba(255,255,255,0.3);font-size:${fontSize - 2}px;margin:4px 0 2px 4px;">3D</div>`;
          for (const d of plot3ds) {
            html += `<div style="font-size:${fontSize - 1}px;padding:1px 0 1px 8px;">${colorBox(d.color || '#b48cff')}${d.name || '3D'}: ${((d as any).style || 'surface')}</div>`;
          }
        }

        // Regime
        if (bgFills.length > 0) {
          const lastBg = bgFills[bgFills.length - 1];
          const bgType = (lastBg.color || '').includes('255,0,110') ? 'Volatile' : 'Trending';
          const bgColor = (lastBg.color || '').includes('255,0,110') ? '#FF006E' : '#00FF9F';
          html += `<div style="font-size:${fontSize - 1}px;padding:1px 0 1px 8px;">${colorBox(bgColor)}Regime: <span style="color:${bgColor};">${bgType}</span></div>`;
        }

        // Signal counts
        const longs = shapes.filter(s => (s.style || '').includes('up')).length;
        const shorts = shapes.filter(s => (s.style || '').includes('down')).length;
        if (longs + shorts > 0) {
          html += `<div style="font-size:${fontSize - 1}px;padding:1px 0 1px 8px;color:rgba(255,255,255,0.4);">Signals: <span style="color:#00FF9F;">${longs}L</span> / <span style="color:#FF006E;">${shorts}S</span></div>`;
        }

        // Errors
        if (inst.errors.length > 0) {
          for (const err of inst.errors.slice(0, 2)) {
            html += `<div style="color:rgba(255,0,110,0.5);font-size:${fontSize - 2}px;padding:1px 0 1px 8px;">⚠ ${err.slice(0, 80)}</div>`;
          }
        }
      }

      content.innerHTML = html;
    },
    toggle() { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; },
    show() {
      // First placement sits under News & Events in the right column. A saved or
      // dragged position stays where the user left it.
      if (!placedBySaved) {
        const news = document.getElementById('news-box');
        const newsShown = !!news && news.style.display !== 'none';
        panel.style.top = `${newsShown ? NEWS_BOX_BOTTOM + WINDOW_GAP : WINDOW_TOP_MIN}px`;
      }
      panel.style.display = 'flex';
      this.refresh();
    },
    hide() { panel.style.display = 'none'; },
    destroy() { panel.remove(); },
  };
  return widget;
}
