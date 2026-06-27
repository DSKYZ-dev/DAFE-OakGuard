import { parse, ParseError } from './parser';
import { executeScript } from './interpreter';
import type { OakPlot, OakAlert } from './runtime';
import type { Program, Assignment, CallExpr, Identifier, ASTNode } from './ast';
import { getIndicators, getCategories, type IndicatorDef } from './indicators';
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
let inputsDiv: HTMLDivElement | null = null;
let docPanel: HTMLDivElement | null = null;
let persistKey = 'oakscript_persist';
let webhookUrl = localStorage.getItem('oakscript_webhook') || '';
let alertHistory: OakAlert[] = [];

const DEFAULT_SCRIPT = `// OakScript — TradingVision Indicator Language
// Press E to toggle editor | Ctrl+Enter to run

// Parameters
fastLen = input(9, "Fast Length")
slowLen = input(21, "Slow Length")
showSignals = input(true, "Show Signals")

// Calculate indicators
fastMA = sma(close, fastLen)
slowMA = sma(close, slowLen)

// Plot lines
plot(fastMA, "Fast MA", "#22cc88", 2)
plot(slowMA, "Slow MA", "#ff4477", 2)

// Crossover signals — buys below the bar, sells above
crossed = crossover(fastMA, slowMA)
crossedDown = crossunder(fastMA, slowMA)

if showSignals
    if crossed
        plotshape(bar_index, low, "BUY", "triangleup", "#22cc88")
    if crossedDown
        plotshape(bar_index, high, "SELL", "triangledown", "#ff4477")
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

export function createEditor(container: HTMLElement, onRun: (source: string) => void): { panel: HTMLDivElement; textarea: HTMLTextAreaElement } {
  onRunCallback = onRun;

  editorPanel = document.createElement('div');
  editorPanel.id = 'oakscript-editor';
  Object.assign(editorPanel.style, {
    position: 'fixed', left: '300px', top: '60px', width: '460px', maxHeight: '90vh',
    minWidth: '420px', minHeight: '320px',
    background: 'rgba(8, 8, 20, 0.95)', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '10px', display: 'none', flexDirection: 'column', zIndex: '200',
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

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)',
    cursor: 'pointer', fontSize: '14px', padding: '2px 6px',
  });
  closeBtn.onclick = () => { editorVisible = false; if (editorPanel) editorPanel.style.display = 'none'; };
  header.appendChild(closeBtn);
  editorPanel.appendChild(header);

  // ── Editor area ─────────────────────────────────────────────────
  const editorWrapper = document.createElement('div');
  Object.assign(editorWrapper.style, {
    display: 'flex', maxHeight: '300px', overflow: 'hidden',
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

  editorWrapper.appendChild(lineNum);
  editorWrapper.appendChild(textarea);
  editorPanel.appendChild(editorWrapper);
  updateLineNumbers();

  // ── Controls bar ────────────────────────────────────────────────
  const controls = document.createElement('div');
  Object.assign(controls.style, {
    display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 10px',
    flexWrap: 'wrap', borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });

  const runBtn = document.createElement('button');
  runBtn.textContent = '▶ Run';
  Object.assign(runBtn.style, {
    padding: '4px 12px', border: '1px solid rgba(34, 204, 136, 0.3)',
    borderRadius: '5px', background: 'rgba(34, 204, 136, 0.12)',
    color: '#22cc88', cursor: 'pointer', fontSize: '11px', fontWeight: '600',
  });
  runBtn.onclick = () => doRun();

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 Save';
  Object.assign(saveBtn.style, {
    padding: '4px 8px', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '5px', background: 'transparent',
    color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '11px',
  });
  saveBtn.onclick = () => {
    localStorage.setItem('oakscript_source', textarea!.value);
    saveBtn.textContent = '✓ Saved';
    setTimeout(() => { saveBtn.textContent = '💾 Save'; }, 1500);
  };

  // Indicator dropdown
  const indSelect = document.createElement('select');
  Object.assign(indSelect.style, {
    flex: '1', minWidth: '120px', padding: '4px 6px',
    border: '1px solid rgba(180, 140, 255, 0.15)', borderRadius: '5px',
    background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.7)',
    fontSize: '10px', cursor: 'pointer', outline: 'none',
  });

  // Build grouped options
  const categories = getCategories();
  const indicators = getIndicators();
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = '📊 Load Indicator...';
  defaultOpt.disabled = true;
  defaultOpt.selected = true;
  indSelect.appendChild(defaultOpt);

  for (const cat of categories) {
    const group = document.createElement('optgroup');
    group.label = cat;
    const catInds = indicators.filter(ind => ind.category === cat);
    for (const ind of catInds) {
      const opt = document.createElement('option');
      opt.value = ind.name;
      opt.textContent = ind.name;
      group.appendChild(opt);
    }
    indSelect.appendChild(group);
  }

  indSelect.onchange = () => {
    const selected = indSelect.value;
    if (!selected) return;
    const ind = getIndicators().find(i => i.name === selected);
    if (ind) {
      textarea!.value = ind.source;
      updateLineNumbers();
      localStorage.setItem('oakscript_source', ind.source);
      localStorage.setItem('oakscript_active_name', ind.name);
      // Clear stale input overrides when loading a new indicator
      localStorage.removeItem('oakscript_overrides');
      doRun();
    }
    indSelect.value = '';
  };

  // Docs toggle
  const docsBtn = document.createElement('button');
  docsBtn.textContent = '📖 Docs';
  Object.assign(docsBtn.style, {
    padding: '4px 8px', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '5px', background: 'transparent',
    color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '11px',
  });
  docsBtn.onclick = () => toggleDocs();

  controls.appendChild(runBtn);
  controls.appendChild(saveBtn);
  controls.appendChild(indSelect);
  controls.appendChild(docsBtn);
  editorPanel.appendChild(controls);

  // ── Input controls ──────────────────────────────────────────────
  inputsDiv = document.createElement('div');
  inputsDiv.setAttribute('data-section', 'inputs');
  Object.assign(inputsDiv.style, {
    maxHeight: '180px', overflow: 'auto', display: 'none',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    padding: '6px 10px',
  });
  editorPanel.appendChild(inputsDiv);

  // ── Error list ──────────────────────────────────────────────────
  errorListDiv = document.createElement('div');
  Object.assign(errorListDiv.style, {
    maxHeight: '100px', overflow: 'auto', display: 'none',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });
  editorPanel.appendChild(errorListDiv);

  // ── Webhook section ─────────────────────────────────────────────
  const alertSection = document.createElement('div');
  Object.assign(alertSection.style, {
    padding: '6px 10px', borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });

  const webhookRow = document.createElement('div');
  Object.assign(webhookRow.style, { display: 'flex', gap: '4px', alignItems: 'center' });

  const whIcon = document.createElement('span');
  whIcon.textContent = '🔗';
  whIcon.style.fontSize = '11px';

  const webhookInput = document.createElement('input');
  webhookInput.type = 'url';
  webhookInput.placeholder = 'Webhook URL for alerts...';
  webhookInput.value = webhookUrl;
  Object.assign(webhookInput.style, {
    flex: '1', padding: '3px 6px', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '5px', background: 'rgba(12,12,28,0.9)',
    color: 'rgba(255,255,255,0.5)', fontSize: '10px', fontFamily: 'monospace',
    outline: 'none',
  });
  webhookInput.onchange = () => { setWebhookUrl(webhookInput.value); };

  const testHookBtn = document.createElement('button');
  testHookBtn.textContent = 'Test';
  Object.assign(testHookBtn.style, {
    padding: '3px 8px', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '5px', background: 'transparent',
    color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '10px',
  });
  testHookBtn.onclick = () => {
    sendAlert({
      type: 'TEST', message: 'Test webhook from OakScript Editor',
      barIndex: 0, timestamp: Date.now(), price: 0,
    });
    testHookBtn.textContent = '✓ Sent';
    setTimeout(() => { testHookBtn.textContent = 'Test'; }, 2000);
  };

  webhookRow.appendChild(whIcon);
  webhookRow.appendChild(webhookInput);
  webhookRow.appendChild(testHookBtn);
  alertSection.appendChild(webhookRow);

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  editorPanel.appendChild(alertSection);

  // ── Documentation Panel ─────────────────────────────────────────
  docPanel = document.createElement('div');
  Object.assign(docPanel.style, {
    maxHeight: '300px', overflow: 'auto', display: 'none',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
  });
  editorPanel.appendChild(docPanel);

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

export function showErrors(errors: string[]): void {
  if (!errorListDiv) return;
  errorListDiv.innerHTML = '';
  if (errors.length === 0) { errorListDiv.style.display = 'none'; return; }
  errorListDiv.style.display = 'block';

  const title = document.createElement('div');
  title.textContent = `⚠ ${errors.length} Error${errors.length > 1 ? 's' : ''}`;
  Object.assign(title.style, {
    padding: '5px 10px', color: '#ff4477', fontSize: '10px',
    fontWeight: '600', borderBottom: '1px solid rgba(255, 68, 119, 0.1)',
  });
  errorListDiv.appendChild(title);

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
}

export function showInputs(inputs: InputDef[], onRun: (src: string) => void): void {
  if (!inputsDiv) return;
  inputsDiv.innerHTML = '';
  if (inputs.length === 0) { inputsDiv.style.display = 'none'; return; }
  inputsDiv.style.display = 'block';

  const title = document.createElement('div');
  title.textContent = '⚙ Inputs';
  Object.assign(title.style, {
    color: 'rgba(180,140,255,0.6)', fontSize: '10px',
    fontWeight: '600', marginBottom: '6px',
  });
  inputsDiv.appendChild(title);

  const currentOverrides = getStoredOverrides();

  for (const input of inputs) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px',
    });

    const label = document.createElement('label');
    label.textContent = input.title;
    Object.assign(label.style, {
      color: 'rgba(255,255,255,0.5)', fontSize: '10px', minWidth: '70px',
      flexShrink: '0',
    });
    row.appendChild(label);

    // Use current override value if available
    const currentVal = currentOverrides.has(input.name) ? currentOverrides.get(input.name) : input.defaultValue;

    if (input.type === 'number') {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(input.min ?? 1);
      slider.max = String(input.max ?? 200);
      slider.step = String(input.step ?? 1);
      slider.value = String(currentVal);
      Object.assign(slider.style, { flex: '1', height: '16px', cursor: 'pointer' });

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.value = String(currentVal);
      numInput.min = slider.min;
      numInput.max = slider.max;
      numInput.step = slider.step;
      Object.assign(numInput.style, {
        width: '50px', padding: '2px 4px', border: '1px solid rgba(180,140,255,0.15)',
        borderRadius: '3px', background: 'rgba(12,12,28,0.9)',
        color: 'rgba(255,255,255,0.6)', fontSize: '10px', textAlign: 'center',
        outline: 'none',
      });

      const updateNum = () => {
        const val = parseFloat(slider.value);
        numInput.value = String(val);
        triggerRunWithOverrides(inputs);
      };
      const updateSlider = () => {
        const val = parseFloat(numInput.value);
        if (!isNaN(val) && val >= parseFloat(slider.min) && val <= parseFloat(slider.max)) {
          slider.value = String(val);
          triggerRunWithOverrides(inputs);
        }
      };

      slider.oninput = updateNum;
      numInput.onchange = updateSlider;

      row.appendChild(slider);
      row.appendChild(numInput);
    } else if (input.type === 'boolean') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = currentVal === true;
      Object.assign(checkbox.style, { cursor: 'pointer' });
      checkbox.onchange = () => triggerRunWithOverrides(inputs);
      row.appendChild(checkbox);
    } else {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.value = String(currentVal);
      Object.assign(textInput.style, {
        flex: '1', padding: '2px 6px', border: '1px solid rgba(180,140,255,0.15)',
        borderRadius: '3px', background: 'rgba(12,12,28,0.9)',
        color: 'rgba(255,255,255,0.6)', fontSize: '10px', outline: 'none',
      });
      textInput.onchange = () => triggerRunWithOverrides(inputs);
      row.appendChild(textInput);
    }

    inputsDiv.appendChild(row);
  }
}

function triggerRunWithOverrides(inputs: InputDef[]): void {
  if (!textarea || !onRunCallback) return;
  const overrides = new Map<string, any>();
  const container = inputsDiv!;
  const rows = container.querySelectorAll('div[id]') as any;
  // Read values from the rendered inputs — iterate the children
  let childIdx = 1; // skip title
  for (const input of inputs) {
    const row = container.children[childIdx];
    if (row) {
      if (input.type === 'number') {
        const numInput = row.querySelector('input[type="number"]') as HTMLInputElement;
        if (numInput) overrides.set(input.name, parseFloat(numInput.value) || input.defaultValue);
      } else if (input.type === 'boolean') {
        const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (cb) overrides.set(input.name, cb.checked);
      } else {
        const textInput = row.querySelector('input[type="text"]') as HTMLInputElement;
        if (textInput) overrides.set(input.name, textInput.value);
      }
    }
    childIdx++;
  }
  // Inject into source text before re-running
  const src = textarea.value;
  onRunCallback(src);
  // Overrides will be picked up from the global state
  // Store overrides for the next run
  localStorage.setItem('oakscript_overrides', JSON.stringify(Object.fromEntries(overrides)));
}

export function getStoredOverrides(): Map<string, any> {
  try {
    const raw = localStorage.getItem('oakscript_overrides');
    if (raw) return new Map(Object.entries(JSON.parse(raw)));
  } catch {}
  return new Map();
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

export function showResults(errors: string[], inputs: InputDef[]): void {
  showErrors(errors);
  showInputs(inputs, (s) => { if (onRunCallback) onRunCallback(s); });
}

export function getDefaultScript(): string { return DEFAULT_SCRIPT; }
export function isEditorVisible(): boolean { return editorVisible; }
