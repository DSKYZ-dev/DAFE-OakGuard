/**
 * OakScript Inputs Panel — Separate draggable/collapsible panel for indicator inputs
 * Includes webhook configuration. Lives independently from the code editor.
 *
 * The panel's update() takes an optional `dashboard` descriptor: when the
 * caller (main.ts) knows this indicator produces dashboard metrics (it
 * always does — the dashboard derives them from plot output automatically),
 * a 📊 Dashboard row is INJECTED at the top of the parameters list. This is
 * an application-level feature: no OakScript code declares it, so every
 * script — library, user-saved, or fresh off the AI coder — gets the toggle
 * for free the moment it produces any observable output.
 */
import type { InputDef } from './oakscript/editor';
import { setWebhookUrl, getWebhookUrl, getStoredOverrides, setStoredOverrides, sendAlert } from './oakscript/editor';
import { TOOLBAR_BAND, clearOfToolbarTop, overlapsToolbarBand } from './toolbar-band';
import { WINDOW_TOP_MIN, SECOND_COLUMN_LEFT, WINDOW_GAP, clearOfHeaderTop } from './header-band';
import { escapeHtml } from './escape-html';

export interface DashboardToggleState {
  visible: boolean;
  onToggle: (next: boolean) => void;
}

function triggerRunWithOverrides(inputs: InputDef[], container: HTMLElement, scope: string | undefined, onRun: (overrides: Map<string, any>) => void): void {
  const overrides = new Map<string, any>();
  // Read each parameter from its own row. Matching by row index drifted as
  // soon as a non-parameter row (the Dashboard toggle) sat above the inputs,
  // so one parameter's value was saved under another's name.
  for (const input of inputs) {
    const row = container.querySelector<HTMLElement>(`.age-input-row[data-input-name="${CSS.escape(input.name)}"]`);
    if (!row) continue;
    if (input.type === 'number') {
      const numInput = row.querySelector('input[type="number"]') as HTMLInputElement | null;
      if (numInput) overrides.set(input.name, parseFloat(numInput.value) || input.defaultValue);
    } else if (input.type === 'boolean') {
      const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb) overrides.set(input.name, cb.checked);
    } else {
      const textInput = row.querySelector('input[type="text"]') as HTMLInputElement | null;
      if (textInput) overrides.set(input.name, textInput.value);
    }
  }
  setStoredOverrides(overrides, scope);
  onRun(overrides);
}

export function createInputsPanel(onRun: (overrides: Map<string, any>) => void): {
  panel: HTMLDivElement;
  update: (inputs: InputDef[], name?: string, dashboard?: DashboardToggleState) => void;
  toggle: () => void;
  show: () => void;
  hide: () => void;
  destroy: () => void;
} {
  // Which indicator's overrides are currently being edited — set by
  // update() and used to namespace saved overrides per-indicator (see
  // getStoredOverrides/setStoredOverrides in oakscript/editor.ts).
  let currentScope: string | undefined;
  // Structure of the controls currently on screen. A run re-applies the same
  // controls; rebuilding them then replaced the slider under the pointer.
  let builtKey: string | null = null;
  // True once the window has a saved or dragged position; a fresh placement
  // (beside the indicator list) applies only before that.
  let placedBySaved = false;

  const panel = document.createElement('div');
  panel.id = 'age-inputs-panel';
  panel.className = 'hud-window';
  Object.assign(panel.style, {
    position: 'fixed',
    left: `${SECOND_COLUMN_LEFT}px`,
    top: `${WINDOW_TOP_MIN}px`,
    width: '336px',
    maxHeight: '85vh',
    minWidth: '280px',
    minHeight: '200px',
    background: 'rgba(8, 8, 20, 0.95)',
    border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '10px',
    display: 'none',
    flexDirection: 'column',
    zIndex: '201',
    backdropFilter: 'blur(12px)',
    boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
    overflow: 'hidden',
  });

  try {
    const saved = JSON.parse(localStorage.getItem('age_inputs_bounds') || 'null');
    if (saved) {
      panel.style.left = `${saved.left}px`;
      placedBySaved = true;
      panel.style.top = `${clearOfHeaderTop(saved.top)}px`;
      if (saved.width) panel.style.width = `${saved.width}px`;
    }
  } catch {}

  const header = document.createElement('div');
  header.className = 'hud-head';
  Object.assign(header.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 12px', borderBottom: '1px solid rgba(180, 140, 255, 0.1)',
    cursor: 'move', userSelect: 'none', flexShrink: '0',
  });
  header.innerHTML = '<span style="color:#b48cff;font-size:12px;font-weight:600;">⚙ Model Inputs</span>';

  const btnGroup = document.createElement('div');
  Object.assign(btnGroup.style, { display: 'flex', gap: '4px' });

  const collapseBtn = document.createElement('button');
  collapseBtn.textContent = '−';
  collapseBtn.title = 'Collapse panel';
  Object.assign(collapseBtn.style, {
    background: 'none', border: '1px solid rgba(255,255,255,0.1)',
    color: '#888', cursor: 'pointer', fontSize: '14px', padding: '1px 7px', borderRadius: '4px',
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'none', border: '1px solid rgba(255,255,255,0.1)',
    color: '#888', cursor: 'pointer', fontSize: '12px', padding: '1px 6px', borderRadius: '4px',
  });
  closeBtn.onclick = () => { panel.style.display = 'none'; };

  btnGroup.appendChild(collapseBtn);
  btnGroup.appendChild(closeBtn);
  header.appendChild(btnGroup);
  panel.appendChild(header);

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
    placedBySaved = true;
    const left = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragX));
    const top = clearOfHeaderTop(clearOfToolbarTop(left, Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragY)), panel.offsetWidth, panel.offsetHeight));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      const r = panel.getBoundingClientRect();
      try { localStorage.setItem('age_inputs_bounds', JSON.stringify({ left: r.left, top: r.top, width: r.width })); } catch {}
    }
  });

  const scrollArea = document.createElement('div');
  Object.assign(scrollArea.style, {
    flex: '1', overflowY: 'auto', padding: '8px 12px', minHeight: '0',
  });
  scrollArea.id = 'age-inputs-scroll';
  panel.appendChild(scrollArea);

  // Webhook section
  const webhookDiv = document.createElement('div');
  Object.assign(webhookDiv.style, {
    borderTop: '1px solid rgba(180,140,255,0.1)', padding: '8px 12px', flexShrink: '0',
  });

  const whRow = document.createElement('div');
  Object.assign(whRow.style, { display: 'flex', gap: '4px', alignItems: 'center' });

  const whLabel = document.createElement('span');
  whLabel.textContent = '🔗';
  whLabel.style.fontSize = '11px';

  const whInput = document.createElement('input');
  whInput.type = 'url';
  whInput.placeholder = 'Webhook URL for alerts...';
  whInput.value = getWebhookUrl();
  Object.assign(whInput.style, {
    flex: '1', padding: '3px 6px', border: '1px solid rgba(180,140,255,0.15)',
    borderRadius: '5px', background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.5)',
    fontSize: '10px', fontFamily: 'monospace', outline: 'none',
  });
  whInput.onchange = () => setWebhookUrl(whInput.value);

  const testBtn = document.createElement('button');
  testBtn.textContent = 'Test';
  Object.assign(testBtn.style, {
    padding: '3px 8px', border: '1px solid rgba(180,140,255,0.15)',
    borderRadius: '5px', background: 'transparent', color: 'rgba(255,255,255,0.4)',
    cursor: 'pointer', fontSize: '10px',
  });
  testBtn.onclick = () => {
    sendAlert({ type: 'TEST', message: 'Test webhook from Inputs Panel', barIndex: 0, timestamp: Date.now(), price: 0 });
    testBtn.textContent = '✓ Sent';
    setTimeout(() => { testBtn.textContent = 'Test'; }, 2000);
  };

  whRow.appendChild(whLabel);
  whRow.appendChild(whInput);
  whRow.appendChild(testBtn);
  webhookDiv.appendChild(whRow);

  const notifBtn = document.createElement('button');
  notifBtn.textContent = '🔔 Enable Notifications';
  Object.assign(notifBtn.style, {
    marginTop: '4px', padding: '3px 8px', border: '1px solid rgba(180,140,255,0.15)',
    borderRadius: '5px', background: 'transparent', color: 'rgba(255,255,255,0.3)',
    cursor: 'pointer', fontSize: '9px', width: '100%',
  });
  notifBtn.onclick = () => {
    if ('Notification' in window) {
      Notification.requestPermission().then(p => {
        notifBtn.textContent = p === 'granted' ? '✓ Notifications Enabled' : '⨯ Notifications Blocked';
      });
    }
  };
  webhookDiv.appendChild(notifBtn);
  panel.appendChild(webhookDiv);

  // Resize handle
  const resizeHandle = document.createElement('div');
  Object.assign(resizeHandle.style, {
    position: 'absolute', right: '0', bottom: '0', width: '14px', height: '14px',
    cursor: 'nwse-resize',
    background: 'linear-gradient(135deg, transparent 50%, rgba(180,140,255,0.4) 50%)',
    borderBottomRightRadius: '10px',
  });
  let resizing = false, startW = 0, startH = 0, startMX = 0, startMY = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    resizing = true;
    startW = panel.offsetWidth; startH = panel.offsetHeight;
    startMX = e.clientX; startMY = e.clientY;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const width = Math.max(280, startW + (e.clientX - startMX));
    let height = Math.max(200, startH + (e.clientY - startMY));
    const pr = panel.getBoundingClientRect();
    if (overlapsToolbarBand(pr.left, width, pr.top + height)) {
      height = Math.max(200, window.innerHeight - TOOLBAR_BAND - pr.top);
    }
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  });
  document.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = false;
      const r = panel.getBoundingClientRect();
      try { localStorage.setItem('age_inputs_bounds', JSON.stringify({ left: r.left, top: r.top, width: r.width })); } catch {}
    }
  });
  panel.appendChild(resizeHandle);

  let collapsed = false;
  collapseBtn.onclick = () => {
    collapsed = !collapsed;
    collapseBtn.textContent = collapsed ? '+' : '−';
    scrollArea.style.display = collapsed ? 'none' : 'block';
    webhookDiv.style.display = collapsed ? 'none' : 'block';
    panel.style.height = collapsed ? 'auto' : '';
  };

  document.body.appendChild(panel);

  return {
    panel,
    update(inputs: InputDef[], name?: string, dashboard?: DashboardToggleState) {
      // Signal marker size is a global display setting now (Settings → Display
      // → Signal Markers), where one control covers every model. The script's
      // own "Marker Size" parameter is dropped here instead of sitting in the
      // panel doing nothing for the models that never multiply by it.
      const shown = (inputs || []).filter(i => !/^marker\s*size$/i.test(i.title || ''));
      const structureKey = JSON.stringify([
        name ?? '',
        dashboard ? (dashboard.visible ? 1 : 0) : -1,
        shown.map(i => [i.name, i.title, i.type, i.min ?? null, i.max ?? null, i.step ?? null, i.defaultValue ?? null]),
      ]);
      if (structureKey === builtKey && scrollArea.childElementCount > 0) return;
      builtKey = structureKey;
      currentScope = name;
      scrollArea.innerHTML = '';

      // ── Automatic dashboard toggle (adapter-driven, first row) ──
      // Injected for every indicator that produces metrics — the caller
      // passes the current visibility + toggle handler; the script itself
      // has no say in this (it's a universal per-instance feature).
      if (dashboard) {
        const dashRow = document.createElement('div');
        dashRow.className = 'age-input-row';
        Object.assign(dashRow.style, {
          display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px',
          padding: '5px 6px', border: '1px solid rgba(34,204,136,0.2)', borderRadius: '5px',
          background: 'rgba(34,204,136,0.05)',
        });
        const dl = document.createElement('label');
        dl.textContent = '📊 Dashboard';
        Object.assign(dl.style, { color: 'rgba(34,204,136,0.8)', fontSize: '10px', fontWeight: '600', flex: '1', cursor: 'pointer' });
        const dcb = document.createElement('input');
        dcb.type = 'checkbox';
        dcb.checked = dashboard.visible;
        dcb.style.cursor = 'pointer';
        dcb.onchange = () => dashboard.onToggle(dcb.checked);
        dl.onclick = () => { dcb.checked = !dcb.checked; dashboard.onToggle(dcb.checked); };
        dashRow.appendChild(dl);
        dashRow.appendChild(dcb);
        const hint = document.createElement('span');
        hint.textContent = dashboard.visible ? 'metrics shown' : 'metrics hidden';
        Object.assign(hint.style, { color: 'rgba(255,255,255,0.3)', fontSize: '9px' });
        dcb.addEventListener('change', () => { hint.textContent = dcb.checked ? 'metrics shown' : 'metrics hidden'; });
        dashRow.appendChild(hint);
        scrollArea.appendChild(dashRow);
      }

      // Guard against a null/undefined inputs list — `undefined.length` used to
      // throw here, leaving the panel completely blank (no rows, no message).
      if (shown.length === 0) {
        scrollArea.innerHTML += inputs && inputs.length > 0
          ? `<div style="color:rgba(255,255,255,0.3);font-size:10px;padding:10px;">This model's only parameter was Marker Size — it now lives in <strong style="color:#b48cff">Settings → Display → Signal Markers</strong> and applies to every model at once.</div>`
          : `<div style="color:rgba(255,255,255,0.3);font-size:10px;padding:10px;">${name ? `“${escapeHtml(name)}” has` : 'This script has'} no configurable inputs. Add <code style="color:#b48cff">input(...)</code> calls to your script to expose parameters here.</div>`;
        return;
      }

      const title = document.createElement('div');
      Object.assign(title.style, {
        color: 'rgba(180,140,255,0.5)', fontSize: '9px', fontWeight: '600',
        textTransform: 'uppercase', marginBottom: '8px',
      });
      // Was reading a single GLOBAL localStorage key that nothing in the AI
      // coder's create/edit path ever updated — so every panel showed
      // whatever indicator was last picked from the dropdown (observed as
      // "everything says Lorentzian Classification"), including scripts
      // still being generated with no real name yet. Show the actual
      // instance's name, passed in by the caller.
      const activeName = name || 'In Creation';
      title.textContent = `Parameters: ${activeName}`;
      scrollArea.appendChild(title);

      const overrides = getStoredOverrides(currentScope);

      for (const input of shown) {
        const row = document.createElement('div');
        row.className = 'age-input-row';
        row.dataset.inputName = input.name;
        Object.assign(row.style, {
          display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px',
        });

        const label = document.createElement('label');
        label.textContent = input.title;
        Object.assign(label.style, {
          color: 'rgba(255,255,255,0.5)', fontSize: '10px', minWidth: '75px',
          flexShrink: '0',
        });
        row.appendChild(label);

        const currentVal = overrides.has(input.name) ? overrides.get(input.name) : input.defaultValue;

        if (input.type === 'number') {
          // A stored override can sit outside the slider range (left behind by
          // the old row mix-up); clamp so the number box and slider agree.
          const rawVal = Number(currentVal);
          const numVal = Number.isFinite(rawVal)
            ? Math.min(Number(input.max ?? 200), Math.max(Number(input.min ?? 1), rawVal))
            : Number(input.defaultValue);
          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = String(input.min ?? 1);
          slider.max = String(input.max ?? 200);
          slider.step = String(input.step ?? 1);
          slider.value = String(numVal);
          Object.assign(slider.style, { flex: '1', height: '14px', cursor: 'pointer' });

          const numInput = document.createElement('input');
          numInput.type = 'number';
          numInput.value = String(numVal);
          numInput.min = slider.min;
          numInput.max = slider.max;
          numInput.step = slider.step;
          Object.assign(numInput.style, {
            width: '47px', padding: '2px 4px', border: '1px solid rgba(180,140,255,0.15)',
            borderRadius: '3px', background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.6)',
            fontSize: '10px', textAlign: 'center', outline: 'none',
          });

          const updateNum = () => { numInput.value = slider.value; triggerRunWithOverrides(shown, scrollArea, currentScope, onRun); };
          const updateSlider = () => {
            const v = parseFloat(numInput.value);
            if (!isNaN(v) && v >= parseFloat(slider.min) && v <= parseFloat(slider.max)) {
              slider.value = String(v);
              triggerRunWithOverrides(shown, scrollArea, currentScope, onRun);
            }
          };
          slider.oninput = updateNum;
          numInput.onchange = updateSlider;

          row.appendChild(slider);
          row.appendChild(numInput);
        } else if (input.type === 'boolean') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = currentVal === true;
          cb.onchange = () => triggerRunWithOverrides(shown, scrollArea, currentScope, onRun);
          row.appendChild(cb);
        } else {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.value = String(currentVal);
          Object.assign(textInput.style, {
            flex: '1', padding: '2px 6px', border: '1px solid rgba(180,140,255,0.15)',
            borderRadius: '3px', background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.6)',
            fontSize: '10px', outline: 'none',
          });
          textInput.onchange = () => triggerRunWithOverrides(shown, scrollArea, currentScope, onRun);
          row.appendChild(textInput);
        }
        scrollArea.appendChild(row);
      }
    },
    toggle() { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; },
    show() {
      if (!placedBySaved) {
        // First placement: beside the indicator list, on the same top line.
        const list = document.getElementById('indicator-list');
        const lr = list ? list.getBoundingClientRect() : null;
        panel.style.left = `${lr && lr.width > 0 ? Math.round(lr.right + WINDOW_GAP) : SECOND_COLUMN_LEFT}px`;
        panel.style.top = `${WINDOW_TOP_MIN}px`;
      }
      panel.style.display = 'flex';
      // A saved or dragged position can sit over the toolbar or the header; clamp it once laid out.
      const r = panel.getBoundingClientRect();
      panel.style.top = `${clearOfHeaderTop(clearOfToolbarTop(r.left, r.top, r.width, r.height))}px`;
    },
    hide() { panel.style.display = 'none'; },
    destroy() { panel.remove(); },
  };
}
