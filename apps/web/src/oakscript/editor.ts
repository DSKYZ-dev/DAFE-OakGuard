import { parse, ParseError } from './parser';
import { executeScript } from './interpreter';
import type { OakPlot, OakAlert } from './runtime';
import type { Program, Assignment, CallExpr, Identifier, ASTNode } from './ast';
import { getIndicators, getCategories, type IndicatorDef, saveUserIndicator, getUserIndicators, removeUserIndicator } from './indicators';
import { getDocumentation, type DocSection } from './docs';

export interface OakscriptResult {
  plots: OakPlot[];
  persist: Map<string, any>;
  errors: string[];
  alerts: OakAlert[];
  inputs: InputDef[];
}

export interface InputDef {
  name: string;
  title: string;
  defaultValue: any;
  type: 'number' | 'string' | 'boolean' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface ParsedError {
  line: number;
  col: number;
  message: string;
  raw: string;
}

let currentResult: OakscriptResult | null = null;
let currentSource = '';
let editorVisible = false;
let editorPanel: HTMLDivElement | null = null;
let textarea: HTMLTextAreaElement | null = null;
let errorListDiv: HTMLDivElement | null = null;
let docPanel: HTMLDivElement | null = null;
let persistKey = 'oakscript_persist';
let webhookUrl = localStorage.getItem('oakscript_webhook') || '';
let alertHistory: OakAlert[] = [];

const DEFAULT_SCRIPT = `// DAFE Trading Systems - DskyzInvestment
`;

// ─── Helpers ─────────────────────────────────────────────────────

function inputType(def: any): 'number' | 'string' | 'boolean' {
  if (typeof def === 'boolean') return 'boolean';
  if (typeof def === 'number') return 'number';
  return 'string';
}

export function detectInputs(program: Program): InputDef[] {
  const inputs: InputDef[] = [];
  for (const stmt of program.statements) {
    if (stmt.type === 'VarDecl' || stmt.type === 'ExpressionStmt') {
      let expr = stmt.type === 'ExpressionStmt' ? (stmt as any).expression : null;
      if (stmt.type === 'VarDecl') {
        // var x = input(...) — value is the expression
        if ((stmt as any).value?.type === 'CallExpr') {
          const call = (stmt as any).value as CallExpr;
          if (call.callee?.type === 'Identifier' && (call.callee as Identifier).name === 'input') {
            const name = (stmt as any).name;
            const def = call.args[0] ? evaluateLiteral(call.args[0]) : 0;
            const title = call.args[1] && call.args[1].type === 'StringLiteral' ? (call.args[1] as any).value : name;
            const type = inputType(def);
            const inputDef: InputDef = { name, title, defaultValue: def, type };
            if (type === 'number') {
              inputDef.min = call.args[2]?.type === 'NumberLiteral' ? (call.args[2] as any).value : undefined;
              inputDef.max = call.args[3]?.type === 'NumberLiteral' ? (call.args[3] as any).value : undefined;
              inputDef.step = call.args[4]?.type === 'NumberLiteral' ? (call.args[4] as any).value : undefined;
            }
            inputs.push(inputDef);
          }
        }
      } else if (expr?.type === 'Assignment' && (expr as Assignment).value?.type === 'CallExpr') {
        const call = (expr as Assignment).value as CallExpr;
        if (call.callee?.type === 'Identifier' && (call.callee as Identifier).name === 'input') {
          const target = (expr as Assignment).target;
          if (target?.type === 'Identifier') {
            const name = (target as Identifier).name;
            const def = call.args[0] ? evaluateLiteral(call.args[0]) : 0;
            const title = call.args[1] && call.args[1].type === 'StringLiteral' ? (call.args[1] as any).value : name;
            const type = inputType(def);
            const inputDef: InputDef = { name, title, defaultValue: def, type };
            if (type === 'number') {
              inputDef.min = call.args[2]?.type === 'NumberLiteral' ? (call.args[2] as any).value : undefined;
              inputDef.max = call.args[3]?.type === 'NumberLiteral' ? (call.args[3] as any).value : undefined;
              inputDef.step = call.args[4]?.type === 'NumberLiteral' ? (call.args[4] as any).value : undefined;
            }
            inputs.push(inputDef);
          }
        }
      }
    }
  }
  return inputs;
}

function evaluateLiteral(node: ASTNode): any {
  if (node.type === 'NumberLiteral') return (node as any).value;
  if (node.type === 'StringLiteral') return (node as any).value;
  if (node.type === 'BooleanLiteral') return (node as any).value;
  if (node.type === 'NilLiteral') return null;
  if (node.type === 'UnaryExpr' && (node as any).op === '-') return -(evaluateLiteral((node as any).argument) || 0);
  return 0;
}

function persistState(): void {
  if (currentResult?.persist) {
    const obj: Record<string, any> = {};
    currentResult.persist.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(persistKey, JSON.stringify(obj));
  }
}

function loadPersist(): Map<string, any> {
  try {
    const raw = localStorage.getItem(persistKey);
    if (raw) {
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    }
  } catch {}
  return new Map();
}

export function getCurrentResult(): OakscriptResult | null { return currentResult; }
export function getAlertHistory(): OakAlert[] { return alertHistory; }
export function getWebhookUrl(): string { return webhookUrl; }

export function parseErrorMessage(msg: string): ParsedError {
  const match = msg.match(/Parse error at line (\d+), col (\d+): (.+)/);
  if (match) {
    return { line: parseInt(match[1]), col: parseInt(match[2]), message: match[3], raw: msg };
  }
  const runtimeMatch = msg.match(/Bar (\d+): (.+)/);
  if (runtimeMatch) {
    return { line: -1, col: -1, message: runtimeMatch[2] + ` (bar ${runtimeMatch[1]})`, raw: msg };
  }
  return { line: -1, col: -1, message: msg, raw: msg };
}

export function runScript(source: string, barData: {
  close: number[]; open: number[]; high: number[]; low: number[];
  volume: number[]; time: number[];
}, inputOverrides?: Map<string, any>): OakscriptResult {
  currentSource = source;
  const persist = loadPersist();
  const alerts: OakAlert[] = [];

  try {
    const ast = parse(source);
    const inputs = detectInputs(ast);
    const barCount = barData.close.length;
    const result = executeScript(ast, {
      close: barData.close, open: barData.open, high: barData.high,
      low: barData.low, volume: barData.volume, time: barData.time,
      count: barCount,
    }, persist, inputOverrides);

    for (const alert of result.alerts) {
      alerts.push(alert);
      sendAlert(alert);
    }

    currentResult = {
      plots: result.plots,
      persist: result.persist,
      errors: result.errors,
      alerts,
      inputs,
    };

    persistState();
    return currentResult;
  } catch (e: any) {
    const errMsg = e instanceof ParseError ? e.message : String(e);
    // Try to detect inputs even from failed parse for partial results
    let inputs: InputDef[] = [];
    try { inputs = detectInputs(parse(source)); } catch {}
    currentResult = { plots: [], persist, errors: [errMsg], alerts, inputs };
    return currentResult;
  }
}

export function sendAlert(alert: OakAlert): void {
  alertHistory.unshift(alert);
  if (alertHistory.length > 100) alertHistory = alertHistory.slice(0, 100);

  if (Notification.permission === 'granted') {
    new Notification('OakScript Alert: ' + alert.type, {
      body: alert.message,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚡</text></svg>',
    });
  }

  if (webhookUrl) {
    const payload = {
      type: alert.type,
      message: alert.message,
      barIndex: alert.barIndex,
      timestamp: alert.timestamp,
      price: alert.price,
      script: 'OakScript',
      time: new Date().toISOString(),
    };
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'no-cors',
    }).catch(() => {});
  }
}

export function setWebhookUrl(url: string): void {
  webhookUrl = url;
  localStorage.setItem('oakscript_webhook', url);
}

export function toggleEditor(): boolean {
  editorVisible = !editorVisible;
  if (editorPanel) editorPanel.style.display = editorVisible ? 'flex' : 'none';
  return editorVisible;
}

let onRunCallback: ((source: string) => void) | null = null;
let onSendErrorsToAdvisor: ((errors: string[], source: string) => void) | null = null;
let onAgentAction: ((action: string, data?: string) => void) | null = null;
let agentChatCallback: ((message: string) => void) | null = null;
let onToggleVisibility: (() => void) | null = null;

export function setSendErrorsCallback(cb: (errors: string[], source: string) => void): void {
  onSendErrorsToAdvisor = cb;
}

export function setAgentActionCallback(cb: (action: string, data?: string) => void): void {
  onAgentAction = cb;
}

export function setAgentChatCallback(cb: (message: string) => void): void {
  agentChatCallback = cb;
}

export function setToggleVisibilityCallback(cb: () => void): void {
  onToggleVisibility = cb;
}

export function createEditor(container: HTMLElement, onRun: (source: string) => void): { panel: HTMLDivElement; textarea: HTMLTextAreaElement } {
  onRunCallback = onRun;

  editorPanel = document.createElement('div');
  editorPanel.id = 'oakscript-editor';
  Object.assign(editorPanel.style, {
    position: 'fixed', left: '300px', top: '60px', width: '460px', maxHeight: '90vh',
    minWidth: '420px', minHeight: '320px',
    background: 'rgba(8, 8, 20, 0.95)', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '10px', display: 'none', flexDirection: 'column', zIndex: '10001',
    backdropFilter: 'blur(12px)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
  });

  // ── Header (draggable) ─────────────────────────────────────────
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 14px', borderBottom: '1px solid rgba(180, 140, 255, 0.1)',
    cursor: 'move', userSelect: 'none',
  });
  header.innerHTML = '<span style="color:#b48cff;font-size:13px;font-weight:600;">OakScript Editor</span>';

  // Restore saved position/size (with sanity clamps so the panel can never collapse)
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem('oakscript_editor_bounds') || 'null'); } catch { return null; }
  })();
  if (saved && typeof saved.width === 'number' && typeof saved.height === 'number') {
    const w = Math.max(420, Math.min(window.innerWidth - 40, saved.width));
    const h = Math.max(320, Math.min(window.innerHeight - 40, saved.height));
    // Keep the panel away from the top-left indicator list (which sits at 12,12)
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, saved.left ?? 300));
    const top = Math.max(12, Math.min(window.innerHeight - h - 12, saved.top ?? 60));
    Object.assign(editorPanel.style, {
      left: left + 'px', top: top + 'px',
      width: w + 'px', height: h + 'px',
      maxHeight: 'none', right: 'auto', bottom: 'auto',
    });
  } else {
    // Default position: offset to the right so it doesn't cover the indicator list
    Object.assign(editorPanel.style, { left: '300px', top: '60px' });
  }

  // Drag logic
  let dragOffX = 0, dragOffY = 0, dragging = false;
  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    if (!editorPanel) return;
    dragging = true;
    const r = editorPanel.getBoundingClientRect();
    dragOffX = e.clientX - r.left;
    dragOffY = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging || !editorPanel) return;
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffX));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffY));
    editorPanel.style.left = x + 'px';
    editorPanel.style.top = y + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; saveBounds(); });

  function saveBounds() {
    if (!editorPanel) return;
    const r = editorPanel.getBoundingClientRect();
    try { localStorage.setItem('oakscript_editor_bounds', JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height })); } catch {}
  }

  const btnGroup = document.createElement('div');
  Object.assign(btnGroup.style, { display: 'flex', alignItems: 'center', gap: '2px' });

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.textContent = '⛶';
  fullscreenBtn.title = 'Fullscreen';
  Object.assign(fullscreenBtn.style, {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)',
    cursor: 'pointer', fontSize: '12px', padding: '2px 6px',
  });
  let isFullscreen = false;
  fullscreenBtn.onclick = () => {
    if (!editorPanel) return;
    isFullscreen = !isFullscreen;
    if (isFullscreen) {
      editorPanel.style.left = '0'; editorPanel.style.top = '0';
      editorPanel.style.width = window.innerWidth + 'px';
      editorPanel.style.height = window.innerHeight + 'px';
      editorPanel.style.maxHeight = 'none';
      editorPanel.style.borderRadius = '0';
    } else {
      editorPanel.style.left = '300px'; editorPanel.style.top = '60px';
      editorPanel.style.width = '460px'; editorPanel.style.height = '';
      editorPanel.style.maxHeight = '90vh';
      editorPanel.style.borderRadius = '10px';
    }
    saveBounds();
  };
  btnGroup.appendChild(fullscreenBtn);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)',
    cursor: 'pointer', fontSize: '14px', padding: '2px 6px',
  });
  closeBtn.onclick = () => { editorVisible = false; if (editorPanel) editorPanel.style.display = 'none'; };
  btnGroup.appendChild(closeBtn);
  header.appendChild(btnGroup);
  editorPanel.appendChild(header);

  // ── Editor area ─────────────────────────────────────────────────
  const editorWrapper = document.createElement('div');
  Object.assign(editorWrapper.style, {
    display: 'flex', flex: '1 1 auto', overflow: 'hidden', minHeight: '0',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });

  const lineNum = document.createElement('div');
  Object.assign(lineNum.style, {
    padding: '10px 8px', background: 'rgba(12,12,28,0.5)',
    color: 'rgba(180,140,255,0.25)',
    font: '11px/1.5 "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
    textAlign: 'right', minWidth: '36px', overflow: 'hidden', userSelect: 'none',
    whiteSpace: 'pre', flexShrink: '0',
  });

  textarea = document.createElement('textarea');
  Object.assign(textarea.style, {
    width: '100%', minHeight: '180px', padding: '10px 12px',
    background: 'transparent', color: 'rgba(255,255,255,0.8)',
    font: '11px/1.5 "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
    border: 'none', outline: 'none', resize: 'vertical',
    tabSize: '2', whiteSpace: 'pre', overflow: 'auto',
  });
  textarea.spellcheck = false;
  textarea.value = localStorage.getItem('oakscript_source') || DEFAULT_SCRIPT;

  const updateLineNumbers = () => {
    const lines = textarea!.value.split('\n');
    lineNum.textContent = lines.map((_, i) => String(i + 1)).join('\n');
  };
  textarea.addEventListener('input', updateLineNumbers);
  textarea.addEventListener('scroll', () => { lineNum.scrollTop = textarea!.scrollTop; });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doRun();
    }
  });

  editorWrapper.appendChild(lineNum);
  editorWrapper.appendChild(textarea);
  editorPanel.appendChild(editorWrapper);
  updateLineNumbers();

  // ── Controls bar ────────────────────────────────────────────────
  const controls = document.createElement('div');
  Object.assign(controls.style, {
    display: 'flex', alignItems: 'center', gap: '4px', padding: '5px 8px',
    flexWrap: 'wrap', borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });

  const btnStyle = (color: string, bg: string) => ({
    padding: '3px 7px', border: `1px solid ${color}33`,
    borderRadius: '4px', background: bg,
    color, cursor: 'pointer', fontSize: '10px', fontWeight: '600',
  });

  let indicatorVisible = true;
  const viewBtn = document.createElement('button');
  viewBtn.textContent = '👁 Hide';
  viewBtn.title = 'Toggle indicator visibility on chart';
  viewBtn.style.cssText = 'padding:3px 7px;border:1px solid rgba(255,184,0,0.25);border-radius:4px;background:rgba(255,184,0,0.12);color:#FFB800;cursor:pointer;font-size:10px;font-weight:600;';
  viewBtn.onclick = () => {
    indicatorVisible = !indicatorVisible;
    viewBtn.textContent = indicatorVisible ? '👁 Hide' : '👁 Show';
    viewBtn.style.color = indicatorVisible ? '#FFB800' : 'rgba(255,255,255,0.3)';
    viewBtn.style.borderColor = indicatorVisible ? 'rgba(255,184,0,0.25)' : 'rgba(255,255,255,0.08)';
    viewBtn.style.background = indicatorVisible ? 'rgba(255,184,0,0.12)' : 'transparent';
    if (onToggleVisibility) onToggleVisibility();
  };

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '';
  saveBtn.title = 'Save to localStorage';
  Object.assign(saveBtn.style, btnStyle('rgba(255,255,255,0.5)', 'transparent'));

  // Track the original saved script name so we can offer replace/delete options
  let originalSavedName: string | null = null;

  saveBtn.onclick = () => {
    const src = textarea!.value;
    localStorage.setItem('oakscript_source', src);
    localStorage.setItem('oakscript_source_version', 'v2');

    const currentName = localStorage.getItem('oakscript_active_name') || 'My Indicator';
    const isEditingSaved = originalSavedName && getUserIndicators().some(i => i.name === originalSavedName);

    if (isEditingSaved) {
      // Show options: save as new, replace original, delete original
      const choice = confirm(
        `You are editing "${originalSavedName}".\n\n` +
        `OK = Replace "${originalSavedName}" with your changes\n` +
        `Cancel = Save as a NEW indicator`
      );
      if (choice) {
        // Replace original
        saveUserIndicator(originalSavedName!, src);
        saveBtn.textContent = '✓';
        setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
      } else {
        // Save as new
        const name = prompt('Save indicator as:', currentName);
        if (name) {
          saveUserIndicator(name, src);
          localStorage.setItem('oakscript_active_name', name);
          originalSavedName = name;
          saveBtn.textContent = '✓';
          setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
        }
      }
    } else {
      // Not editing a saved script — just save as new
      const name = prompt('Save indicator as:', currentName);
      if (name) {
        saveUserIndicator(name, src);
        localStorage.setItem('oakscript_active_name', name);
        originalSavedName = name;
        saveBtn.textContent = '✓';
        setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
      }
    }
    refreshIndicatorDropdown();
  };

  // Manage saved scripts button (delete, view)
  const manageBtn = document.createElement('button');
  manageBtn.textContent = '🗑';
  manageBtn.title = 'Manage saved indicators (delete, rename)';
  Object.assign(manageBtn.style, btnStyle('rgba(255,68,119,0.5)', 'transparent'));
  manageBtn.onclick = () => {
    const userInds = getUserIndicators();
    if (userInds.length === 0) {
      alert('No saved indicators to manage.');
      return;
    }
    // Build a simple modal with delete buttons
    const modal = document.createElement('div');
    Object.assign(modal.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      background: 'rgba(8, 8, 20, 0.98)', border: '1px solid rgba(180, 140, 255, 0.3)',
      borderRadius: '10px', padding: '20px', zIndex: '100000', minWidth: '300px',
      boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
    });
    const title = document.createElement('div');
    title.textContent = 'Manage Saved Indicators';
    Object.assign(title.style, { color: '#b48cff', fontSize: '14px', fontWeight: '600', marginBottom: '12px' });
    modal.appendChild(title);

    const list = document.createElement('div');
    list.style.maxHeight = '400px';
    list.style.overflow = 'auto';
    for (const ind of userInds) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 0', borderBottom: '1px solid rgba(180, 140, 255, 0.1)',
      });
      const name = document.createElement('span');
      name.textContent = ind.name;
      name.style.color = 'rgba(255,255,255,0.8)';
      name.style.fontSize = '11px';
      row.appendChild(name);

      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      Object.assign(delBtn.style, {
        padding: '3px 10px', border: '1px solid rgba(255, 68, 119, 0.4)',
        borderRadius: '4px', background: 'rgba(255, 68, 119, 0.1)',
        color: '#ff4477', cursor: 'pointer', fontSize: '10px',
      });
      delBtn.onclick = () => {
        if (confirm(`Delete "${ind.name}"?`)) {
          removeUserIndicator(ind.name);
          row.remove();
          refreshIndicatorDropdown();
          if (originalSavedName === ind.name) originalSavedName = null;
          if (userInds.length === 1) { modal.remove(); alert('All saved indicators deleted.'); }
        }
      };
      row.appendChild(delBtn);
      list.appendChild(row);
    }
    modal.appendChild(list);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, {
      marginTop: '12px', padding: '6px 16px', border: '1px solid rgba(180, 140, 255, 0.3)',
      borderRadius: '4px', background: 'rgba(180, 140, 255, 0.1)',
      color: '#b48cff', cursor: 'pointer', fontSize: '11px', width: '100%',
    });
    closeBtn.onclick = () => modal.remove();
    modal.appendChild(closeBtn);

    // Backdrop
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', zIndex: '99999',
    });
    backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
  };

  // Indicator dropdown
  const indSelect = document.createElement('select');
  Object.assign(indSelect.style, {
    flex: '1', minWidth: '110px', padding: '3px 5px',
    border: '1px solid rgba(180, 140, 255, 0.15)', borderRadius: '4px',
    background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.7)',
    fontSize: '10px', cursor: 'pointer', outline: 'none',
  });
  // Rebuild the dropdown from the current indicator list (built-ins + user
  // saved). Called on editor creation AND after every save so a newly saved
  // script shows up immediately without a page reload.
  function refreshIndicatorDropdown() {
    const prev = indSelect.value;
    indSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '📊 Load...';
    defaultOpt.disabled = true; defaultOpt.selected = true;
    indSelect.appendChild(defaultOpt);
    for (const cat of getCategories()) {
      const group = document.createElement('optgroup');
      group.label = cat;
      for (const ind of getIndicators().filter(i => i.category === cat)) {
        const opt = document.createElement('option');
        opt.value = ind.name; opt.textContent = ind.name;
        group.appendChild(opt);
      }
      indSelect.appendChild(group);
    }
    indSelect.value = prev;
  }
  refreshIndicatorDropdown();
  indSelect.onchange = () => {
    const sel = indSelect.value; if (!sel) return;
    const ind = getIndicators().find(i => i.name === sel);
    if (ind) {
      textarea!.value = ind.source; updateLineNumbers();
      localStorage.setItem('oakscript_source', ind.source);
      localStorage.setItem('oakscript_active_name', ind.name);
      localStorage.removeItem('oakscript_overrides');
      doRun();
    }
    indSelect.value = '';
  };

  const docsBtn = document.createElement('button');
  docsBtn.textContent = '📖';
  docsBtn.title = 'Documentation';
  Object.assign(docsBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  docsBtn.onclick = () => toggleDocs();

  controls.appendChild(viewBtn);
  controls.appendChild(saveBtn);
  controls.appendChild(manageBtn);
  controls.appendChild(indSelect);
  controls.appendChild(docsBtn);

  // ── Agent command buttons ────────────────────────────────────
  const agentSep = document.createElement('div');
  agentSep.style.width = '1px'; agentSep.style.height = '16px';
  agentSep.style.background = 'rgba(180,140,255,0.1)'; agentSep.style.margin = '0 2px';
  controls.appendChild(agentSep);

  const agentBtnStyle = (color: string) => ({
    padding: '3px 6px', border: `1px solid ${color}22`,
    borderRadius: '4px', background: 'transparent',
    color, cursor: 'pointer', fontSize: '10px', fontWeight: '500',
  });

  const fixBtn = document.createElement('button');
  fixBtn.textContent = '🔧 Fix';
  fixBtn.title = 'Auto-fix errors with agent';
  Object.assign(fixBtn.style, agentBtnStyle('#ff4477'));
  fixBtn.onclick = () => { if (onAgentAction) onAgentAction('fix'); };

  const genBtn = document.createElement('button');
  genBtn.textContent = '✍️ New';
  genBtn.title = 'Generate indicator from description';
  Object.assign(genBtn.style, agentBtnStyle('#22cc88'));
  genBtn.onclick = () => {
    const desc = prompt('Describe the indicator:');
    if (desc && onAgentAction) {
      // Only clear to the placeholder when the editor is ALREADY empty/
      // placeholder — i.e. this really is a from-scratch request. If there's
      // a real script here, this click is almost always someone refining
      // what they just asked for, and main.ts's action handler routes that
      // case through the context-aware edit path using the CURRENT source —
      // wiping it here first would destroy the very thing that path needs
      // to read.
      const current = textarea!.value.trim();
      if (!current || current === DEFAULT_SCRIPT.trim()) {
        textarea!.value = DEFAULT_SCRIPT;
        localStorage.setItem('oakscript_source', DEFAULT_SCRIPT);
        updateLineNumbers();
      }
      onAgentAction('generate', desc);
    }
  };

  const ideasBtn = document.createElement('button');
  ideasBtn.textContent = '💡';
  ideasBtn.title = 'Brainstorm ideas';
  Object.assign(ideasBtn.style, agentBtnStyle('#ffd43b'));
  ideasBtn.onclick = () => { if (onAgentAction) onAgentAction('brainstorm'); };

  const metricsBtn = document.createElement('button');
  metricsBtn.textContent = '📊';
  metricsBtn.title = 'Analyze metrics';
  Object.assign(metricsBtn.style, agentBtnStyle('#b48cff'));
  metricsBtn.onclick = () => { if (onAgentAction) onAgentAction('metrics'); };

  const validateBtn = document.createElement('button');
  validateBtn.textContent = '✓';
  validateBtn.title = 'Validate code';
  Object.assign(validateBtn.style, agentBtnStyle('#00FFF0'));
  validateBtn.onclick = () => { if (onAgentAction) onAgentAction('validate'); };

  controls.appendChild(fixBtn);
  controls.appendChild(genBtn);
  controls.appendChild(ideasBtn);
  controls.appendChild(metricsBtn);
  controls.appendChild(validateBtn);
  editorPanel.appendChild(controls);

  // ── Error list ────────────────────────────────────────────────
  errorListDiv = document.createElement('div');
  Object.assign(errorListDiv.style, {
    maxHeight: '100px', overflow: 'auto', display: 'none',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });
  editorPanel.appendChild(errorListDiv);

  // ── Documentation Panel ─────────────────────────────────────────
  docPanel = document.createElement('div');
  Object.assign(docPanel.style, {
    flex: '1', overflow: 'auto', display: 'none', minHeight: '0',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });
  editorPanel.appendChild(docPanel);

  // ── Agent Chat Box ────────────────────────────────────────────
  const agentChat = document.createElement('div');
  Object.assign(agentChat.style, {
    padding: '4px 0', borderTop: '1px solid rgba(180, 140, 255, 0.08)',
    display: 'flex', flexDirection: 'column',
  });

  const chatMsgs = document.createElement('div');
  chatMsgs.id = 'os-agent-messages';
  Object.assign(chatMsgs.style, {
    maxHeight: '80px', overflow: 'auto', padding: '2px 8px',
    fontSize: '9px', fontFamily: 'monospace',
    color: 'rgba(255,255,255,0.5)',
    display: 'none',
  });

  const chatHeader = document.createElement('div');
  Object.assign(chatHeader.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '1px 8px',
  });
  const chatTitle = document.createElement('span');
  chatTitle.textContent = 'Agent Chat';
  chatTitle.style.cssText = 'color:rgba(180,140,255,0.4);font-size:8px;';

  const chatTools = document.createElement('div');
  Object.assign(chatTools.style, { display: 'flex', gap: '2px', alignItems: 'center' });

  // Font size controls
  let chatFontSize = 9;
  const sizeDown = document.createElement('button');
  sizeDown.textContent = 'A-';
  sizeDown.title = 'Decrease text size';
  Object.assign(sizeDown.style, { padding:'0 3px',border:'1px solid rgba(180,140,255,0.1)',borderRadius:'3px',background:'transparent',color:'rgba(255,255,255,0.25)',cursor:'pointer',fontSize:'7px' });
  sizeDown.onclick = () => { chatFontSize = Math.max(7, chatFontSize - 1); chatMsgs.style.fontSize = chatFontSize + 'px'; };
  const sizeUp = document.createElement('button');
  sizeUp.textContent = 'A+';
  sizeUp.title = 'Increase text size';
  Object.assign(sizeUp.style, { padding:'0 3px',border:'1px solid rgba(180,140,255,0.1)',borderRadius:'3px',background:'transparent',color:'rgba(255,255,255,0.25)',cursor:'pointer',fontSize:'7px' });
  sizeUp.onclick = () => { chatFontSize = Math.min(14, chatFontSize + 1); chatMsgs.style.fontSize = chatFontSize + 'px'; };
  chatTools.appendChild(sizeDown);
  chatTools.appendChild(sizeUp);

  const copyLogBtn = document.createElement('button');
  copyLogBtn.textContent = '📋';
  copyLogBtn.title = 'Copy entire chat log';
  Object.assign(copyLogBtn.style, {
    padding: '1px 5px', border: '1px solid rgba(180,140,255,0.1)',
    borderRadius: '3px', background: 'transparent',
    color: 'rgba(255,255,255,0.25)', cursor: 'pointer', fontSize: '8px',
  });
  copyLogBtn.onclick = () => {
    const lines: string[] = [];
    chatMsgs.querySelectorAll('div').forEach(d => lines.push(d.textContent || ''));
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      copyLogBtn.textContent = '✓';
      setTimeout(() => { copyLogBtn.textContent = '📋'; }, 1500);
    }).catch(() => {});
  };
  chatTools.appendChild(copyLogBtn);
  chatHeader.appendChild(chatTitle);
  chatHeader.appendChild(chatTools);
  agentChat.appendChild(chatHeader);
  agentChat.appendChild(chatMsgs);

  const chatRow = document.createElement('div');
  Object.assign(chatRow.style, {
    display: 'flex', gap: '3px', padding: '3px 8px',
  });

  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.placeholder = 'Ask agent about this indicator...';
  Object.assign(chatInput.style, {
    flex: '1', padding: '3px 6px',
    border: '1px solid rgba(180, 140, 255, 0.12)',
    borderRadius: '4px', background: 'rgba(12,12,28,0.9)',
    color: 'rgba(255,255,255,0.6)', fontSize: '10px', fontFamily: 'monospace',
    outline: 'none',
  });
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && chatInput.value.trim()) {
      const msg = chatInput.value.trim();
      chatInput.value = '';
      appendAgentChatMsg('user', msg);
      if (agentChatCallback) agentChatCallback(msg);
    }
  };

  const chatSend = document.createElement('button');
  chatSend.textContent = '→';
  chatSend.title = 'Send to agent';
  Object.assign(chatSend.style, {
    padding: '3px 8px', border: '1px solid rgba(180, 140, 255, 0.2)',
    borderRadius: '4px', background: 'rgba(180, 140, 255, 0.08)',
    color: '#b48cff', cursor: 'pointer', fontSize: '11px', fontWeight: '600',
  });
  chatSend.onclick = () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    chatInput.value = '';
    appendAgentChatMsg('user', msg);
    if (agentChatCallback) agentChatCallback(msg);
  };

  chatRow.appendChild(chatInput);
  chatRow.appendChild(chatSend);
  agentChat.appendChild(chatRow);

  // Auto-accept + Render priority toggles
  const autoRow = document.createElement('div');
  Object.assign(autoRow.style, {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 8px',
    flexWrap: 'wrap',
  });
  const autoLabel = document.createElement('label');
  Object.assign(autoLabel.style, {
    display: 'flex', alignItems: 'center', gap: '4px',
    color: 'rgba(255,255,255,0.35)', fontSize: '9px', cursor: 'pointer',
  });
  const autoCheck = document.createElement('input');
  autoCheck.type = 'checkbox';
  autoCheck.id = 'os-auto-accept';
  Object.assign(autoCheck.style, { accentColor: '#22cc88' });
  autoCheck.onchange = () => {
    if (onAgentAction) onAgentAction('auto-accept');
  };
  autoLabel.appendChild(autoCheck);
  autoLabel.appendChild(document.createTextNode('Auto-accept'));
  autoRow.appendChild(autoLabel);

  // 3D render priority toggle
  const d3Label = document.createElement('label');
  Object.assign(d3Label.style, {
    display: 'flex', alignItems: 'center', gap: '4px',
    color: 'rgba(255,255,255,0.35)', fontSize: '9px', cursor: 'pointer',
  });
  const d3Check = document.createElement('input');
  d3Check.type = 'checkbox';
  d3Check.id = 'os-prefer-3d';
  d3Check.checked = true;
  Object.assign(d3Check.style, { accentColor: '#b48cff' });
  d3Label.appendChild(d3Check);
  d3Label.appendChild(document.createTextNode('Prefer 3D'));
  autoRow.appendChild(d3Label);
  agentChat.appendChild(autoRow);

  editorPanel.appendChild(agentChat);

  // Expose chat append + auto-accept + 3D prefs for external use
  (window as any).__osAppendChat = (role: string, msg: string) => appendAgentChatMsg(role, msg);
  (window as any).__osGetAutoAccept = () => autoCheck.checked;
  (window as any).__osGetPrefer3D = () => d3Check.checked;

  function appendAgentChatMsg(role: string, msg: string) {
    chatMsgs.style.display = 'block';
    const div = document.createElement('div');
    div.textContent = (role === 'user' ? 'You: ' : 'Agent: ') + msg;
    div.style.color = role === 'user' ? 'rgba(255,255,255,0.5)' : '#b48cff';
    div.style.padding = '1px 0';
    chatMsgs.appendChild(div);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    if (chatMsgs.children.length > 20) chatMsgs.firstChild?.remove();
  }

  // ── Resize handle ───────────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  Object.assign(resizeHandle.style, {
    position: 'absolute', right: '0', bottom: '0', width: '16px', height: '16px',
    cursor: 'nwse-resize', background: 'linear-gradient(135deg, transparent 50%, rgba(180,140,255,0.4) 50%)',
    borderBottomRightRadius: '10px',
  });
  resizeHandle.title = 'Drag to resize';

  let resizing = false, startW = 0, startH = 0, startMX = 0, startMY = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    if (!editorPanel) return;
    resizing = true;
    startW = editorPanel.offsetWidth;
    startH = editorPanel.offsetHeight;
    startMX = e.clientX;
    startMY = e.clientY;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing || !editorPanel) return;
    const nw = Math.max(300, startW + (e.clientX - startMX));
    const nh = Math.max(250, startH + (e.clientY - startMY));
    editorPanel.style.width = nw + 'px';
    editorPanel.style.height = nh + 'px';
  });
  document.addEventListener('mouseup', () => { if (resizing) { resizing = false; saveBounds(); } });

  editorPanel.style.position = 'fixed';
  editorPanel.appendChild(resizeHandle);
  container.appendChild(editorPanel);
  return { panel: editorPanel, textarea };
}

function doRun(): void {
  if (!textarea) return;
  const src = textarea.value;
  localStorage.setItem('oakscript_source', src);
  if (onRunCallback) onRunCallback(src);
}

function doRunSilent(): void {
  if (!textarea) return;
  const src = textarea.value;
  localStorage.setItem('oakscript_source', src);
  if (onRunCallback) onRunCallback(src);
}

export function showErrors(errors: string[]): void {
  if (!errorListDiv) return;
  errorListDiv.innerHTML = '';
  if (errors.length === 0) { errorListDiv.style.display = 'none'; return; }
  errorListDiv.style.display = 'block';

  const headerRow = document.createElement('div');
  Object.assign(headerRow.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '5px 10px', borderBottom: '1px solid rgba(255, 68, 119, 0.1)',
  });

  const title = document.createElement('div');
  title.textContent = `⚠ ${errors.length} Error${errors.length > 1 ? 's' : ''}`;
  Object.assign(title.style, {
    color: '#ff4477', fontSize: '10px', fontWeight: '600',
  });
  headerRow.appendChild(title);

  // Send all errors to the Trade Advisor for auto-fix
  const sendToAdvisorBtn = document.createElement('button');
  sendToAdvisorBtn.textContent = '🤖 Fix with Advisor';
  sendToAdvisorBtn.title = 'Send all errors to the Trade Advisor for diagnosis and auto-fix';
  Object.assign(sendToAdvisorBtn.style, {
    padding: '3px 8px', border: '1px solid rgba(180, 140, 255, 0.3)',
    borderRadius: '4px', background: 'rgba(180, 140, 255, 0.1)',
    color: '#b48cff', cursor: 'pointer', fontSize: '9px', fontWeight: '600',
  });
  sendToAdvisorBtn.onclick = () => {
    if (onSendErrorsToAdvisor && textarea) {
      onSendErrorsToAdvisor(errors, textarea.value);
      sendToAdvisorBtn.textContent = '✓ Sent to Advisor';
      sendToAdvisorBtn.style.color = '#22cc88';
      sendToAdvisorBtn.style.borderColor = 'rgba(34, 204, 136, 0.4)';
      sendToAdvisorBtn.style.background = 'rgba(34, 204, 136, 0.12)';
      setTimeout(() => {
        sendToAdvisorBtn.textContent = '🤖 Fix with Advisor';
        sendToAdvisorBtn.style.color = '#b48cff';
        sendToAdvisorBtn.style.borderColor = 'rgba(180, 140, 255, 0.3)';
        sendToAdvisorBtn.style.background = 'rgba(180, 140, 255, 0.1)';
      }, 2000);
    }
  };
  headerRow.appendChild(sendToAdvisorBtn);
  errorListDiv.appendChild(headerRow);

  for (const err of errors) {
    const parsed = parseErrorMessage(err);
    const row = document.createElement('div');
    Object.assign(row.style, {
      padding: '5px 10px', borderBottom: '1px solid rgba(255,68,119,0.06)',
      fontSize: '10px', lineHeight: '1.5',
    });

    const loc = document.createElement('div');
    if (parsed.line > 0) {
      loc.textContent = `Line ${parsed.line}, Col ${parsed.col}`;
      loc.style.color = 'rgba(255,68,119,0.7)';
    }
    row.appendChild(loc);

    const msg = document.createElement('div');
    msg.textContent = parsed.message;
    msg.style.color = '#ff6688';
    msg.style.fontWeight = '500';
    row.appendChild(msg);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy';
    Object.assign(copyBtn.style, {
      marginTop: '2px', padding: '2px 8px', border: '1px solid rgba(255,68,119,0.2)',
      borderRadius: '3px', background: 'transparent',
      color: 'rgba(255,68,119,0.5)', cursor: 'pointer', fontSize: '9px',
    });
    copyBtn.onclick = () => {
      const text = `OakScript Error: Line ${parsed.line}, Col ${parsed.col}: ${parsed.message}`;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 1500);
      }).catch(() => {});
    };
    row.appendChild(copyBtn);
    errorListDiv.appendChild(row);
  }

  // Add a "copy all errors" row at the bottom
  const copyAllRow = document.createElement('div');
  Object.assign(copyAllRow.style, {
    padding: '4px 10px', display: 'flex', justifyContent: 'flex-end',
  });
  const copyAllBtn = document.createElement('button');
  copyAllBtn.textContent = '📋 Copy All Errors';
  Object.assign(copyAllBtn.style, {
    padding: '2px 10px', border: '1px solid rgba(255,68,119,0.15)',
    borderRadius: '3px', background: 'transparent',
    color: 'rgba(255,68,119,0.4)', cursor: 'pointer', fontSize: '9px',
  });
  copyAllBtn.onclick = () => {
    const allErrors = errors.join('\n');
    navigator.clipboard.writeText(allErrors).then(() => {
      copyAllBtn.textContent = '✓ Copied';
      setTimeout(() => { copyAllBtn.textContent = '📋 Copy All Errors'; }, 1500);
    }).catch(() => {});
  };
  copyAllRow.appendChild(copyAllBtn);
  errorListDiv.appendChild(copyAllRow);
}

// Overrides are namespaced by indicator name — the old single global
// "oakscript_overrides" key was shared across every indicator, so saved
// settings from one indicator (e.g. a `showSignals`/`atrLen` override, both
// very common input names) silently bled into any other indicator that
// happened to declare an input with the same name. `scope` defaults to a
// legacy shared bucket only for callers that don't know their indicator's
// name yet.
function overridesKey(scope?: string): string {
  return scope ? `oakscript_overrides:${scope}` : 'oakscript_overrides';
}

export function getStoredOverrides(scope?: string): Map<string, any> {
  try {
    const raw = localStorage.getItem(overridesKey(scope));
    if (raw) return new Map(Object.entries(JSON.parse(raw)));
  } catch {}
  return new Map();
}

export function setStoredOverrides(overrides: Map<string, any>, scope?: string): void {
  localStorage.setItem(overridesKey(scope), JSON.stringify(Object.fromEntries(overrides)));
}

function toggleDocs(): void {
  if (!docPanel) return;
  const isVisible = docPanel.style.display !== 'none';
  docPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) renderDocs();
}

function renderDocs(): void {
  if (!docPanel) return;
  docPanel.innerHTML = '';
  const sections = getDocumentation();
  const nav = document.createElement('div');
  Object.assign(nav.style, {
    position: 'sticky', top: '0', background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px',
    display: 'flex', flexWrap: 'wrap', gap: '4px', zIndex: '1',
  });

  const navTitle = document.createElement('span');
  navTitle.textContent = '📖 OakScript Reference';
  Object.assign(navTitle.style, {
    color: '#b48cff', fontSize: '11px', fontWeight: '600', width: '100%',
    marginBottom: '2px',
  });
  nav.appendChild(navTitle);

  for (const section of sections) {
    const link = document.createElement('a');
    link.textContent = section.title;
    link.href = '#';
    Object.assign(link.style, {
      color: 'rgba(255,255,255,0.4)', fontSize: '9px', textDecoration: 'none',
      padding: '1px 6px', borderRadius: '3px',
    });
    link.onmouseenter = () => { link.style.color = '#b48cff'; link.style.background = 'rgba(180,140,255,0.08)'; };
    link.onmouseleave = () => { link.style.color = 'rgba(255,255,255,0.4)'; link.style.background = 'transparent'; };
    link.onclick = (e) => {
      e.preventDefault();
      const sectionEl = docPanel!.querySelector(`[data-section="${section.title}"]`);
      if (sectionEl) sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    nav.appendChild(link);
  }
  docPanel.appendChild(nav);

  for (const section of sections) {
    const sec = document.createElement('div');
    sec.setAttribute('data-section', section.title);
    Object.assign(sec.style, {
      padding: '8px 10px', borderBottom: '1px solid rgba(180,140,255,0.05)',
    });

    const heading = document.createElement('div');
    heading.textContent = section.title;
    Object.assign(heading.style, {
      color: '#b48cff', fontSize: '11px', fontWeight: '600', marginBottom: '4px',
    });
    sec.appendChild(heading);

    const body = document.createElement('div');
    body.textContent = section.content;
    Object.assign(body.style, {
      color: 'rgba(255,255,255,0.6)', fontSize: '10px', lineHeight: '1.6',
      whiteSpace: 'pre-wrap', fontFamily: 'monospace',
    });
    sec.appendChild(body);

    docPanel.appendChild(sec);
  }
}

export function showResults(errors: string[], _inputs: InputDef[]): void {
  showErrors(errors);
}

export function getDefaultScript(): string { return DEFAULT_SCRIPT; }
export function isEditorVisible(): boolean { return editorVisible; }

/**
 * Register global keyboard shortcuts for when the editor has focus.
 * Returns an unsubscribe function.
 */
export function registerEditorShortcuts(shortcuts: Array<{
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  handler: () => void;
}>): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!editorVisible || !textarea) return;
    const active = document.activeElement;
    if (active !== textarea && active !== editorPanel) return;
    for (const sc of shortcuts) {
      const ctrlMatch = sc.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
      const altMatch = sc.alt ? e.altKey : !e.altKey;
      const shiftMatch = sc.shift ? e.shiftKey : !e.shiftKey;
      const keyUpper = sc.key.toUpperCase();
      const eKeyUpper = e.key.toUpperCase();
      if ((eKeyUpper === keyUpper || e.key === sc.key) && ctrlMatch && altMatch && shiftMatch) {
        e.preventDefault();
        e.stopPropagation();
        sc.handler();
        return;
      }
    }
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
