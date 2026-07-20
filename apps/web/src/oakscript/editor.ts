import { parse, ParseError } from './parser';
import { executeScript } from './interpreter';
import type { OakPlot, OakAlert } from './runtime';
import type { Program, Assignment, CallExpr, Identifier, ASTNode } from './ast';
import {
  getIndicators, getCategories, type IndicatorDef, saveUserIndicator, getUserIndicators, removeUserIndicator,
  buildCartridge, cartridgeFilename, parseCartridge,
} from './indicators';
import { getDocumentation, type DocSection } from './docs';
import { listImageAssets, saveImageAsset, deleteImageAsset, getLibraryStats, type AssetRecord } from './image-assets';
import { getImageCacheStats, clearImageCache } from '../image-cache';
import { runBacktest, runBacktestOnBars, BacktestCancelledError } from '../backtest/engine';
import { playTone } from '../accessibility';
import { addStoryboardEntry } from '../storyboard';
import { MAX_BACKTEST_BARS, fetchBacktestBars, barsToRuntimeBarData } from '../backtest/data';
import type { BacktestConfig, BacktestResult, StopLossMode, TakeProfitMode } from '../backtest/types';
import { renderEquityCurve } from '../backtest/chart';

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
let imagesPanel: HTMLDivElement | null = null;
let backtestPanel: HTMLDivElement | null = null;
let strategyLabPanel: HTMLDivElement | null = null;
let alertsPanel: HTMLDivElement | null = null;
let persistKey = 'oakscript_persist';
let webhookUrl = localStorage.getItem('oakscript_webhook') || '';
let alertHistory: OakAlert[] = [];
let lastBacktestConfig: Partial<BacktestConfig> | null = null;
let lastBacktestResult: BacktestResult | null = null;
let backtestAbortController: AbortController | null = null;
let lastStrategyLabConfig: Partial<BacktestConfig> | null = null;
let lastStrategyLabRows: BatchRunRow[] | null = null;
let strategyLabAbortController: AbortController | null = null;
// createEditor() defines refreshIndicatorDropdown() as its own local closure
// (it needs indSelect, which lives only there); this lets the module-scope
// Strategy Lab panel trigger the same refresh after an "Approve & Save"
// without restructuring createEditor.
let refreshIndicatorDropdownFn: (() => void) | null = null;

const DEFAULT_SCRIPT = `//DAFE Trading Systems - DskyzInvestment
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

// ─── Strategy Lab batch-variant sweep ───────────────────────────────
// v1 scope (per the adversarial review's mandated cuts): a single
// deterministic one-at-a-time parameter sweep, never a GA — no iteration,
// no fitness-guided mutation, no randomness. Running buildBatchVariants()
// twice on the same inputs always produces the exact same list.

export interface BatchVariant {
  label: string;
  /** Empty for the baseline variant. */
  overrides: Map<string, number>;
}

export interface BatchRunRow {
  variant: BatchVariant;
  result: BacktestResult;
}

/** Hard, fixed caps — "small fixed N" per the review, never a user-facing
 * dial. Sweeping more inputs or generating more variants than this starts
 * to look like the optimizer that was explicitly cut. */
export const MAX_SWEPT_INPUTS = 4;
export const MAX_BATCH_VARIANTS = 1 + MAX_SWEPT_INPUTS * 2;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round6(n));
}

/**
 * Baseline (script defaults) plus, for each of up to MAX_SWEPT_INPUTS
 * numeric inputs (in script order), one variant nudged down and one nudged
 * up by the input's own declared step (or 20% of its default when no step
 * is declared), clamped to any declared min/max and deduped against the
 * baseline value.
 */
export function buildBatchVariants(inputs: InputDef[]): BatchVariant[] {
  const variants: BatchVariant[] = [{ label: 'Baseline (script defaults)', overrides: new Map() }];
  const numeric = inputs.filter(i => i.type === 'number').slice(0, MAX_SWEPT_INPUTS);

  for (const inp of numeric) {
    const base = typeof inp.defaultValue === 'number' ? inp.defaultValue : 0;
    const step = inp.step && inp.step > 0 ? inp.step : Math.max(Math.abs(base) * 0.2, 1e-6);
    const seen = new Set<number>([round6(base)]);

    for (const raw of [base - step, base + step]) {
      let clamped = raw;
      if (inp.min !== undefined) clamped = Math.max(inp.min, clamped);
      if (inp.max !== undefined) clamped = Math.min(inp.max, clamped);
      clamped = round6(clamped);
      if (seen.has(clamped)) continue;
      seen.add(clamped);
      variants.push({
        label: `${inp.title}: ${formatNumber(base)} → ${formatNumber(clamped)}`,
        overrides: new Map([[inp.name, clamped]]),
      });
    }
  }

  // Belt-and-braces — the loop above can only ever reach 1 + 4*2 = 9, but
  // this is the one line that actually GUARANTEES "small fixed N" holds
  // regardless of future edits above.
  return variants.slice(0, MAX_BATCH_VARIANTS);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites the numeric default-value literal of each named input(...) call
 * directly in the source text, for both the `var NAME = input(...)` and
 * `NAME = input(...)` forms detectInputs() recognizes (kept in lockstep
 * with it — same two shapes). Used only by Strategy Lab's "Approve & Save":
 * a saved script always runs with no runtime overrides, so a chosen
 * variant's tuned values have to live in the text itself to survive being
 * saved and reloaded later.
 */
export function applyOverridesToSource(source: string, overrides: Map<string, number>): string {
  if (overrides.size === 0) return source;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [name, value] of overrides) {
      const re = new RegExp(`^(\\s*(?:var\\s+)?${escapeRegExp(name)}\\s*=\\s*input\\s*\\(\\s*)(-?\\d+(?:\\.\\d+)?)`);
      const m = lines[i].match(re);
      if (m) {
        lines[i] = m[1] + formatNumber(value) + lines[i].slice(m[0].length);
        break;
      }
    }
  }
  return lines.join('\n');
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
}, inputOverrides?: Map<string, any>, imageAssets?: Map<string, string>): OakscriptResult {
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
    }, persist, inputOverrides, imageAssets);

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

/**
 * @param notify Skip the browser Notification and webhook POST when false —
 * used to backfill Alert History with a script's pre-existing historical
 * alerts (e.g. when it's first applied and executeScript() reports every
 * bar back to bar 0 in one pass) without blasting the user with a
 * notification/webhook per bar for signals that already happened in the
 * past. History (the Explain This Signal panel) always gets every alert
 * either way — only the two side effects are conditional.
 */
export function sendAlert(alert: OakAlert, notify: boolean = true): void {
  alertHistory.unshift(alert);
  if (alertHistory.length > 100) alertHistory = alertHistory.slice(0, 100);

  if (!notify) return;

  playTone('alert');
  const symbol = onGetChartContext ? onGetChartContext().symbol : 'unknown';
  addStoryboardEntry(symbol, alert.type === 'ALERT' ? 'Alert' : 'Condition met', alert.message, 'alert');

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
let onImageAssetsChanged: (() => void) | null = null;

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

// Fired whenever the Images panel adds or deletes a saved asset, so callers
// (main.ts) can refresh their own cached name->dataUrl map that gets threaded
// into executeScript. Mirrors the setXCallback pattern used above.
export function setImageAssetsChangedCallback(cb: () => void): void {
  onImageAssetsChanged = cb;
}

// Lets the Backtest panel pre-fill its symbol/timeframe fields from the
// live chart's current state instead of starting blank every time. A
// synchronous getter (not a push callback) since the panel only needs the
// value at the moment it opens.
let onGetChartContext: (() => { symbol: string; timeframe: string; baseUrl?: string }) | null = null;
export function setChartContextCallback(cb: () => { symbol: string; timeframe: string; baseUrl?: string }): void {
  onGetChartContext = cb;
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
    // Without this, content taller than the panel's own height (e.g. a
    // populated Backtest results section) paints OUTSIDE this box instead
    // of clipping/scrolling — visually bleeding onto whatever is
    // positioned underneath (confirmed live: scrollHeight can exceed
    // clientHeight once results are shown).
    overflowY: 'auto',
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

  // ── Resize handle between editor and bottom panels ────────────
  const editorResizeHandle = document.createElement('div');
  Object.assign(editorResizeHandle.style, {
    height: '4px', cursor: 'ns-resize', flexShrink: '0',
    background: 'rgba(180,140,255,0.06)',
    borderTop: '1px solid rgba(180,140,255,0.08)',
    borderBottom: '1px solid rgba(180,140,255,0.08)',
  });
  editorResizeHandle.title = 'Drag to resize editor';
  let editorResizing = false;
  editorResizeHandle.addEventListener('mousedown', (e) => {
    editorResizing = true; e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!editorResizing || !editorWrapper) return;
    const newH = Math.max(50, editorWrapper.offsetHeight + (e.clientY - (editorWrapper.getBoundingClientRect().bottom)));
    editorWrapper.style.height = newH + 'px';
    editorWrapper.style.flex = '0 0 auto';
  });
  document.addEventListener('mouseup', () => { editorResizing = false; });
  editorPanel.appendChild(editorResizeHandle);

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

      const exportBtn = document.createElement('button');
      exportBtn.textContent = '⬇ Export';
      exportBtn.title = 'Download as a portable OakCartridge file';
      Object.assign(exportBtn.style, {
        padding: '3px 10px', border: '1px solid rgba(34, 204, 136, 0.4)',
        borderRadius: '4px', background: 'rgba(34, 204, 136, 0.1)',
        color: '#22cc88', cursor: 'pointer', fontSize: '10px',
      });
      exportBtn.onclick = async () => {
        exportBtn.disabled = true;
        try {
          const cartridge = await buildCartridge(ind);
          downloadTextFile(cartridgeFilename(ind.name), JSON.stringify(cartridge, null, 2), 'application/json');
        } catch (e: any) {
          alert(`Export failed: ${e?.message || e}`);
        } finally {
          exportBtn.disabled = false;
        }
      };
      row.appendChild(exportBtn);

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

    // Backdrop
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', zIndex: '99999',
    });
    backdrop.onclick = () => { modal.remove(); backdrop.remove(); };

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, {
      marginTop: '12px', padding: '6px 16px', border: '1px solid rgba(180, 140, 255, 0.3)',
      borderRadius: '4px', background: 'rgba(180, 140, 255, 0.1)',
      color: '#b48cff', cursor: 'pointer', fontSize: '11px', width: '100%',
    });
    // Previously only removed `modal`, leaving the full-viewport backdrop
    // div behind — invisible-ish (dark overlay) but still catching every
    // click on the rest of the app until something else happened to also
    // remove it (e.g. clicking the backdrop itself, missing the button).
    closeBtn.onclick = () => { modal.remove(); backdrop.remove(); };
    modal.appendChild(closeBtn);

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
  };

  // Import an OakCartridge (.oak.json) file — deliberately its own always-
  // available button rather than living inside the Manage modal above,
  // since that modal alert-and-returns when there are zero saved
  // indicators yet, which is exactly when importing is most useful.
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.style.display = 'none';

  const importBtn = document.createElement('button');
  importBtn.textContent = '⬆';
  importBtn.title = 'Import an OakCartridge (.oak.json) file';
  Object.assign(importBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  importBtn.onclick = () => importInput.click();

  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    importInput.value = ''; // reset so re-selecting the same file still fires onchange
    if (!file) return;

    try {
      const text = await file.text();
      const { def, integrity } = await parseCartridge(text);

      if (integrity === 'mismatch') {
        const proceed = confirm(
          `"${def.name}" — this file's content hash doesn't match its contents (edited or corrupted since export). Import anyway?`
        );
        if (!proceed) return;
      }

      try {
        parse(def.source);
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        if (!confirm(`"${def.name}" has a script parse error: ${msg}\n\nImport anyway?`)) return;
      }

      let finalName = def.name;
      if (getUserIndicators().some(i => i.name === finalName)) {
        if (!confirm(`"${finalName}" already exists in your saved indicators. Overwrite it?`)) {
          const renamed = prompt('Import under a different name:', `${finalName} (imported)`);
          if (!renamed) return;
          finalName = renamed;
        }
      }

      saveUserIndicator(finalName, def.source);
      refreshIndicatorDropdown();
      alert(`Imported "${finalName}".`);
    } catch (e: any) {
      alert(`Import failed: ${e?.message || e}`);
    }
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
  refreshIndicatorDropdownFn = refreshIndicatorDropdown;
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

  const imagesBtn = document.createElement('button');
  imagesBtn.textContent = '🖼️ Images';
  imagesBtn.title = 'Image Assets';
  Object.assign(imagesBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  imagesBtn.onclick = () => toggleImages();

  const backtestBtn = document.createElement('button');
  backtestBtn.textContent = '⏱️ Backtest';
  backtestBtn.title = 'Time Machine — backtest this script against historical data';
  Object.assign(backtestBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  backtestBtn.onclick = () => toggleBacktest();

  const strategyLabBtn = document.createElement('button');
  strategyLabBtn.textContent = '🧪 Batch';
  strategyLabBtn.title = 'Strategy Lab — run a small fixed batch of parameter variants against historical data';
  Object.assign(strategyLabBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  strategyLabBtn.onclick = () => toggleStrategyLab();

  const alertsBtn = document.createElement('button');
  alertsBtn.textContent = '🔔 Alerts';
  alertsBtn.title = 'Alert History — Explain This Signal shows the script\'s own variable values at the moment each alert fired';
  Object.assign(alertsBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  alertsBtn.onclick = () => toggleAlerts();

  controls.appendChild(viewBtn);
  controls.appendChild(saveBtn);
  controls.appendChild(manageBtn);
  controls.appendChild(importBtn);
  controls.appendChild(importInput);
  controls.appendChild(indSelect);
  controls.appendChild(docsBtn);
  controls.appendChild(imagesBtn);
  controls.appendChild(backtestBtn);
  controls.appendChild(strategyLabBtn);
  controls.appendChild(alertsBtn);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = '▶ Apply';
  applyBtn.title = 'Run script on chart';
  Object.assign(applyBtn.style, {
    padding: '3px 9px', border: '1px solid rgba(34,204,136,0.4)',
    borderRadius: '4px', background: 'rgba(34,204,136,0.15)',
    color: '#22cc88', cursor: 'pointer', fontSize: '10px', fontWeight: '700',
  });
  applyBtn.onclick = () => doRun();
  controls.appendChild(applyBtn);

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
  docPanel.id = 'oakscript-docs';
  Object.assign(docPanel.style, {
    overflow: 'auto', display: 'none', minHeight: '80px', maxHeight: '300px',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    flexShrink: '0',
  });
  editorPanel.appendChild(docPanel);

  // ── Image Assets Panel ───────────────────────────────────────────
  imagesPanel = document.createElement('div');
  imagesPanel.id = 'oakscript-images';
  Object.assign(imagesPanel.style, {
    overflow: 'auto', display: 'none', minHeight: '80px', maxHeight: '300px',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    flexShrink: '0',
  });
  editorPanel.appendChild(imagesPanel);

  // ── Backtest (Time Machine) Panel ─────────────────────────────────
  backtestPanel = document.createElement('div');
  backtestPanel.id = 'oakscript-backtest';
  Object.assign(backtestPanel.style, {
    overflow: 'auto', display: 'none', minHeight: '80px', maxHeight: '420px',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    flexShrink: '0',
  });
  editorPanel.appendChild(backtestPanel);

  // ── Strategy Lab (batch variant sweep) Panel ──────────────────────
  strategyLabPanel = document.createElement('div');
  strategyLabPanel.id = 'oakscript-strategy-lab';
  Object.assign(strategyLabPanel.style, {
    overflow: 'auto', display: 'none', minHeight: '80px', maxHeight: '420px',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    flexShrink: '0',
  });
  editorPanel.appendChild(strategyLabPanel);

  // ── Alert History (Explain This Signal) Panel ──────────────────────
  alertsPanel = document.createElement('div');
  alertsPanel.id = 'oakscript-alerts';
  Object.assign(alertsPanel.style, {
    overflow: 'auto', display: 'none', minHeight: '80px', maxHeight: '420px',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    flexShrink: '0',
  });
  editorPanel.appendChild(alertsPanel);

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
    display: 'none', resize: 'vertical',
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
  if (!isVisible) {
    try { renderDocs(); } catch (e) {
      docPanel.innerHTML = `<div style="padding:10px;color:#ff4477;font-size:10px;">Failed to load docs: ${e}</div>`;
      docPanel.style.display = 'block';
    }
  }
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

function toggleImages(): void {
  if (!imagesPanel) return;
  const isVisible = imagesPanel.style.display !== 'none';
  imagesPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    renderImages().catch((e) => {
      if (!imagesPanel) return;
      imagesPanel.innerHTML = `<div style="padding:10px;color:#ff4477;font-size:10px;">Failed to load image assets: ${e}</div>`;
      imagesPanel.style.display = 'block';
    });
  }
}

async function renderImages(): Promise<void> {
  if (!imagesPanel) return;
  imagesPanel.innerHTML = '';

  const header = document.createElement('div');
  Object.assign(header.style, {
    position: 'sticky', top: '0', background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px',
    zIndex: '1',
  });

  const headerTitle = document.createElement('div');
  headerTitle.textContent = '🖼️ Image Assets';
  Object.assign(headerTitle.style, {
    color: '#b48cff', fontSize: '11px', fontWeight: '600', marginBottom: '4px',
  });
  header.appendChild(headerTitle);

  // ── Add form ──
  const form = document.createElement('div');
  Object.assign(form.style, {
    display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center',
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg';
  Object.assign(fileInput.style, {
    fontSize: '9px', color: 'rgba(255,255,255,0.5)', maxWidth: '150px',
  });
  form.appendChild(fileInput);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'asset name';
  Object.assign(nameInput.style, {
    flex: '1', minWidth: '80px', padding: '3px 5px',
    border: '1px solid rgba(180, 140, 255, 0.15)', borderRadius: '4px',
    background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.7)',
    fontSize: '10px', outline: 'none',
  });
  form.appendChild(nameInput);

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add';
  Object.assign(addBtn.style, {
    padding: '3px 9px', border: '1px solid rgba(34,204,136,0.4)',
    borderRadius: '4px', background: 'rgba(34,204,136,0.15)',
    color: '#22cc88', cursor: 'pointer', fontSize: '10px', fontWeight: '600',
  });
  form.appendChild(addBtn);

  header.appendChild(form);

  const statusMsg = document.createElement('div');
  Object.assign(statusMsg.style, {
    fontSize: '9px', marginTop: '3px', minHeight: '11px',
  });
  header.appendChild(statusMsg);

  addBtn.onclick = async () => {
    const file = fileInput.files && fileInput.files[0];
    const name = nameInput.value.trim();
    statusMsg.style.color = '#ff6688';
    if (!file) { statusMsg.textContent = 'Choose a PNG or JPEG file first.'; return; }
    if (!name) { statusMsg.textContent = 'Enter a name for the asset.'; return; }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';
    try {
      await saveImageAsset(name, file);
      if (onImageAssetsChanged) onImageAssetsChanged();
      await renderImages();
    } catch (e: any) {
      statusMsg.textContent = `Failed to add: ${e?.message || e}`;
      addBtn.disabled = false;
      addBtn.textContent = '+ Add';
    }
  };

  imagesPanel.appendChild(header);

  // ── Asset list ──
  const listDiv = document.createElement('div');
  Object.assign(listDiv.style, { padding: '4px 0' });

  const assets: AssetRecord[] = await listImageAssets();
  if (assets.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No saved image assets yet.';
    Object.assign(empty.style, {
      padding: '8px 10px', color: 'rgba(255,255,255,0.3)', fontSize: '10px',
    });
    listDiv.appendChild(empty);
  } else {
    for (const asset of assets) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', borderBottom: '1px solid rgba(180,140,255,0.05)',
      });

      const thumb = document.createElement('img');
      thumb.src = asset.dataUrl;
      Object.assign(thumb.style, {
        width: '28px', height: '28px', objectFit: 'contain',
        background: 'rgba(255,255,255,0.05)', borderRadius: '3px', flexShrink: '0',
      });
      row.appendChild(thumb);

      const nameBtn = document.createElement('button');
      nameBtn.textContent = asset.name;
      nameBtn.title = 'Click to copy an image.new(...) snippet using this asset';
      Object.assign(nameBtn.style, {
        flex: '1', textAlign: 'left', border: 'none', background: 'transparent',
        color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '10px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      nameBtn.onclick = () => {
        const snippet = `image.new(bar_index, close, "${asset.name}", 48, 48)`;
        navigator.clipboard.writeText(snippet).then(() => {
          const prev = nameBtn.textContent;
          nameBtn.textContent = '✓ Copied snippet';
          setTimeout(() => { nameBtn.textContent = prev; }, 1200);
        }).catch(() => {});
      };
      row.appendChild(nameBtn);

      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete asset';
      Object.assign(delBtn.style, {
        border: '1px solid rgba(255,68,119,0.2)', borderRadius: '3px',
        background: 'transparent', color: 'rgba(255,68,119,0.6)',
        cursor: 'pointer', fontSize: '9px', padding: '2px 6px', flexShrink: '0',
      });
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        try {
          await deleteImageAsset(asset.name);
          if (onImageAssetsChanged) onImageAssetsChanged();
          await renderImages();
        } catch {
          delBtn.disabled = false;
        }
      };
      row.appendChild(delBtn);

      listDiv.appendChild(row);
    }
  }

  imagesPanel.appendChild(listDiv);

  // ── Resource monitor: saved-library disk usage + decoded-image memory
  // cache usage, with a one-click flush for the (purely derived, safe to
  // drop at any time) decode cache. The saved library itself is user
  // content and is never auto-deleted — see image-assets.ts's soft cap. ──
  const statsRow = document.createElement('div');
  Object.assign(statsRow.style, {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
    padding: '6px 10px', borderTop: '1px solid rgba(180,140,255,0.08)',
    fontSize: '9px', color: 'rgba(255,255,255,0.35)',
  });

  const statsText = document.createElement('span');
  statsText.style.flex = '1';
  statsRow.appendChild(statsText);

  const flushBtn = document.createElement('button');
  flushBtn.textContent = '🧹 Flush image cache';
  flushBtn.title = 'Release decoded images from memory — safe anytime, they redecode on next use';
  Object.assign(flushBtn.style, {
    border: '1px solid rgba(180,140,255,0.2)', borderRadius: '3px',
    background: 'transparent', color: 'rgba(180,140,255,0.7)',
    cursor: 'pointer', fontSize: '9px', padding: '2px 6px', flexShrink: '0',
  });
  flushBtn.onclick = () => {
    clearImageCache();
    refreshStatsText();
  };
  statsRow.appendChild(flushBtn);

  imagesPanel.appendChild(statsRow);

  function refreshStatsText(): void {
    const cacheStats = getImageCacheStats();
    statsText.textContent =
      `Library: ${libraryStats.count} saved (${formatBytes(libraryStats.totalBytes)}) · ` +
      `Decode cache: ${cacheStats.entries} in memory (~${formatBytes(cacheStats.approxBytes)})`;
  }

  const libraryStats = await getLibraryStats();
  refreshStatsText();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Standard client-side "save text as a file" trigger — a throwaway <a
 * download> click, same technique regardless of what's being exported. */
function downloadTextFile(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Backtest (Time Machine) Panel ───────────────────────────────────
const BT_IN_SAMPLE_COLOR = '#22cc88';
const BT_OUT_OF_SAMPLE_COLOR = '#22aaff';

interface BacktestConfigFormHandle {
  formEl: HTMLDivElement;
  getConfig(baseUrl?: string): BacktestConfig;
}

function fieldInputStyle() {
  return {
    width: '100%', padding: '3px 5px', boxSizing: 'border-box' as const,
    border: '1px solid rgba(180, 140, 255, 0.15)', borderRadius: '4px',
    background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.7)',
    fontSize: '10px', outline: 'none',
  };
}

function configField(labelText: string, input: HTMLInputElement | HTMLSelectElement, width: string): HTMLDivElement {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '2px', width });
  const label = document.createElement('label');
  label.textContent = labelText;
  Object.assign(label.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });
  Object.assign(input.style, fieldInputStyle());
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

/**
 * Symbol/timeframe/bars/in-sample%/qty/cash/SL/TP form shared by the Time
 * Machine single-run panel and the Strategy Lab batch panel — same fields,
 * same defaulting, same clamped parsing, so the two can never drift into
 * reading a config differently.
 */
function buildBacktestConfigForm(cfg: {
  symbol: string; timeframe: string; barCount: number; inSamplePct: number;
  qtyPerTrade: number; startingCash: number; stopLossMode: StopLossMode;
  stopLossValue: number; takeProfitMode: TakeProfitMode; takeProfitValue: number;
}): BacktestConfigFormHandle {
  const formWrap = document.createElement('div');
  Object.assign(formWrap.style, { padding: '6px 10px', display: 'flex', flexWrap: 'wrap', gap: '6px' });

  const symbolInput = document.createElement('input');
  symbolInput.type = 'text'; symbolInput.value = cfg.symbol;
  const timeframeInput = document.createElement('input');
  timeframeInput.type = 'text'; timeframeInput.value = cfg.timeframe;
  const barCountInput = document.createElement('input');
  barCountInput.type = 'number'; barCountInput.min = '50'; barCountInput.max = String(MAX_BACKTEST_BARS);
  barCountInput.value = String(cfg.barCount);
  const inSampleInput = document.createElement('input');
  inSampleInput.type = 'number'; inSampleInput.min = '10'; inSampleInput.max = '90';
  inSampleInput.value = String(cfg.inSamplePct);
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number'; qtyInput.min = '1'; qtyInput.step = '1'; qtyInput.value = String(cfg.qtyPerTrade);
  const cashInput = document.createElement('input');
  cashInput.type = 'number'; cashInput.min = '1'; cashInput.value = String(cfg.startingCash);

  // Optional bracket orders — reuse PaperBroker's existing 'stop'/
  // 'trailing-stop'/'limit' order types (see engine.ts's
  // placeBracketOrders()); "None" (default) preserves the exact pre-bracket
  // behavior where entries only ever close via the script's own
  // strategy.exit(). Value inputs stay always-visible/enabled — the mode
  // dropdown alone decides whether they're used, deliberately no
  // show/hide wiring for a 2-field form.
  const slModeSelect = document.createElement('select');
  for (const [val, label] of [
    ['none', 'None'], ['fixed-pct', 'Fixed %'], ['fixed-amount', 'Fixed $'],
    ['trailing-pct', 'Trailing %'], ['trailing-amount', 'Trailing $'],
  ] as [StopLossMode, string][]) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (val === cfg.stopLossMode) opt.selected = true;
    slModeSelect.appendChild(opt);
  }
  const slValueInput = document.createElement('input');
  slValueInput.type = 'number'; slValueInput.min = '0.01'; slValueInput.step = '0.01';
  slValueInput.value = String(cfg.stopLossValue);
  slValueInput.title = 'Interpreted as % or $ depending on the Stop-Loss mode selected';

  const tpModeSelect = document.createElement('select');
  for (const [val, label] of [
    ['none', 'None'], ['fixed-pct', 'Fixed %'], ['fixed-amount', 'Fixed $'],
  ] as [TakeProfitMode, string][]) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (val === cfg.takeProfitMode) opt.selected = true;
    tpModeSelect.appendChild(opt);
  }
  const tpValueInput = document.createElement('input');
  tpValueInput.type = 'number'; tpValueInput.min = '0.01'; tpValueInput.step = '0.01';
  tpValueInput.value = String(cfg.takeProfitValue);
  tpValueInput.title = 'Interpreted as % or $ depending on the Take-Profit mode selected';

  formWrap.appendChild(configField('Symbol', symbolInput, '90px'));
  formWrap.appendChild(configField('Timeframe', timeframeInput, '70px'));
  formWrap.appendChild(configField(`Bars (max ${MAX_BACKTEST_BARS})`, barCountInput, '110px'));
  formWrap.appendChild(configField('In-sample %', inSampleInput, '90px'));
  formWrap.appendChild(configField('Qty/trade', qtyInput, '80px'));
  formWrap.appendChild(configField('Starting cash', cashInput, '100px'));
  formWrap.appendChild(configField('Stop-Loss', slModeSelect, '100px'));
  formWrap.appendChild(configField('SL Value', slValueInput, '80px'));
  formWrap.appendChild(configField('Take-Profit', tpModeSelect, '100px'));
  formWrap.appendChild(configField('TP Value', tpValueInput, '80px'));

  return {
    formEl: formWrap,
    getConfig(baseUrl?: string): BacktestConfig {
      return {
        symbol: symbolInput.value.trim().toUpperCase() || 'SPY',
        timeframe: timeframeInput.value.trim() || '1h',
        barCount: Math.max(50, Math.min(MAX_BACKTEST_BARS, parseInt(barCountInput.value, 10) || 500)),
        inSamplePct: Math.max(10, Math.min(90, parseInt(inSampleInput.value, 10) || 70)),
        qtyPerTrade: Math.max(1, parseFloat(qtyInput.value) || 1),
        startingCash: Math.max(1, parseFloat(cashInput.value) || 10000),
        stopLossMode: slModeSelect.value as StopLossMode,
        stopLossValue: Math.max(0.01, parseFloat(slValueInput.value) || 2),
        takeProfitMode: tpModeSelect.value as TakeProfitMode,
        takeProfitValue: Math.max(0.01, parseFloat(tpValueInput.value) || 4),
        baseUrl,
      };
    },
  };
}

function toggleBacktest(): void {
  if (!backtestPanel) return;
  const isVisible = backtestPanel.style.display !== 'none';
  backtestPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) renderBacktest();
}

function renderBacktest(): void {
  if (!backtestPanel) return;
  backtestPanel.innerHTML = '';

  const header = document.createElement('div');
  Object.assign(header.style, {
    position: 'sticky', top: '0', background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px',
    zIndex: '1',
  });
  const headerTitle = document.createElement('div');
  headerTitle.textContent = '⏱️ Time Machine — Backtest';
  Object.assign(headerTitle.style, { color: '#b48cff', fontSize: '11px', fontWeight: '600', marginBottom: '4px' });
  header.appendChild(headerTitle);
  backtestPanel.appendChild(header);

  const chartCtx = onGetChartContext ? onGetChartContext() : { symbol: 'SPY', timeframe: '1h', baseUrl: undefined };
  const cfg = {
    symbol: lastBacktestConfig?.symbol ?? chartCtx.symbol ?? 'SPY',
    timeframe: lastBacktestConfig?.timeframe ?? chartCtx.timeframe ?? '1h',
    barCount: lastBacktestConfig?.barCount ?? 500,
    inSamplePct: lastBacktestConfig?.inSamplePct ?? 70,
    qtyPerTrade: lastBacktestConfig?.qtyPerTrade ?? 1,
    startingCash: lastBacktestConfig?.startingCash ?? 10000,
    stopLossMode: lastBacktestConfig?.stopLossMode ?? 'none',
    stopLossValue: lastBacktestConfig?.stopLossValue ?? 2,
    takeProfitMode: lastBacktestConfig?.takeProfitMode ?? 'none',
    takeProfitValue: lastBacktestConfig?.takeProfitValue ?? 4,
  };

  const formHandle = buildBacktestConfigForm(cfg);
  backtestPanel.appendChild(formHandle.formEl);

  const actionsRow = document.createElement('div');
  Object.assign(actionsRow.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px 8px' });

  const runBtn = document.createElement('button');
  runBtn.textContent = '▶ Run Backtest';
  Object.assign(runBtn.style, {
    padding: '4px 10px', border: '1px solid rgba(34,204,136,0.4)',
    borderRadius: '4px', background: 'rgba(34,204,136,0.15)',
    color: '#22cc88', cursor: 'pointer', fontSize: '10px', fontWeight: '700',
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ Cancel';
  Object.assign(cancelBtn.style, {
    padding: '4px 10px', border: '1px solid rgba(255,68,119,0.4)',
    borderRadius: '4px', background: 'rgba(255,68,119,0.1)',
    color: '#ff4477', cursor: 'pointer', fontSize: '10px', fontWeight: '600',
    display: 'none',
  });

  const statusMsg = document.createElement('span');
  Object.assign(statusMsg.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });

  actionsRow.appendChild(runBtn);
  actionsRow.appendChild(cancelBtn);
  actionsRow.appendChild(statusMsg);
  backtestPanel.appendChild(actionsRow);

  const resultsDiv = document.createElement('div');
  Object.assign(resultsDiv.style, { padding: '0 10px 10px' });
  backtestPanel.appendChild(resultsDiv);

  function statBlock(stats: BacktestResult['inSample'], color: string): HTMLDivElement {
    const block = document.createElement('div');
    Object.assign(block.style, {
      flex: '1', minWidth: '160px', border: `1px solid ${color}33`, borderRadius: '5px',
      padding: '6px 8px', background: `${color}0d`,
    });
    const title = document.createElement('div');
    title.textContent = stats.label === 'in-sample' ? 'In-Sample' : 'Out-of-Sample';
    Object.assign(title.style, { color, fontSize: '10px', fontWeight: '700', marginBottom: '4px' });
    block.appendChild(title);

    const rows: [string, string][] = [
      ['Net P&L', `$${stats.netPnL.toFixed(2)} (${(stats.netPnLPct * 100).toFixed(1)}%)`],
      ['Max drawdown', `$${stats.maxDrawdown.toFixed(2)} (${(stats.maxDrawdownPct * 100).toFixed(1)}%)`],
      ['Sharpe (per-bar, unannualized)', stats.sharpePerBar.toFixed(3)],
      ['Win rate', `${(stats.winRate * 100).toFixed(1)}% (${stats.totalTrades} trades)`],
      ['Avg win / loss', `$${stats.avgWin.toFixed(2)} / $${stats.avgLoss.toFixed(2)}`],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', fontSize: '9px',
        color: 'rgba(255,255,255,0.6)', padding: '1px 0',
      });
      const l = document.createElement('span');
      l.textContent = label; l.style.color = 'rgba(255,255,255,0.35)';
      const v = document.createElement('span');
      v.textContent = value;
      row.appendChild(l); row.appendChild(v);
      block.appendChild(row);
    }
    return block;
  }

  function renderResults(result: BacktestResult): void {
    resultsDiv.innerHTML = '';

    // Required, always-visible whenever a result is shown — never render
    // stats without it directly above them.
    const disclaimer = document.createElement('div');
    disclaimer.textContent = 'Backtest results use a single fixed historical split and simplified next-bar-open fills. Past performance on this data does not predict live results. This is not financial advice.';
    Object.assign(disclaimer.style, {
      fontSize: '9px', color: 'rgba(255,200,80,0.85)', background: 'rgba(255,200,80,0.08)',
      border: '1px solid rgba(255,200,80,0.2)', borderRadius: '4px', padding: '5px 7px', marginBottom: '6px',
    });
    resultsDiv.appendChild(disclaimer);

    if (result.scriptErrors.length > 0) {
      const errBox = document.createElement('div');
      const shown = result.scriptErrors.slice(0, 3).join(' | ');
      const more = result.scriptErrors.length > 3 ? ` (+${result.scriptErrors.length - 3} more)` : '';
      errBox.textContent = `Script errors during backtest: ${shown}${more}`;
      Object.assign(errBox.style, {
        fontSize: '9px', color: '#ff4477', background: 'rgba(255,68,119,0.08)',
        border: '1px solid rgba(255,68,119,0.2)', borderRadius: '4px', padding: '5px 7px', marginBottom: '6px',
      });
      resultsDiv.appendChild(errBox);
    }

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '140px', display: 'block' });
    resultsDiv.appendChild(canvas);
    // Deferred a frame so clientWidth/clientHeight are resolved post-layout.
    requestAnimationFrame(() => renderEquityCurve(canvas, result));

    // Always shown side by side, never just one sample alone — so a result
    // can't be mistaken for genuine out-of-sample performance.
    const statsRow = document.createElement('div');
    Object.assign(statsRow.style, { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' });
    statsRow.appendChild(statBlock(result.inSample, BT_IN_SAMPLE_COLOR));
    statsRow.appendChild(statBlock(result.outOfSample, BT_OUT_OF_SAMPLE_COLOR));
    resultsDiv.appendChild(statsRow);
  }

  runBtn.onclick = async () => {
    const config = formHandle.getConfig(chartCtx.baseUrl);
    lastBacktestConfig = config;

    const source = textarea ? textarea.value : '';
    if (!source.trim()) {
      statusMsg.textContent = 'Editor is empty — nothing to backtest.';
      statusMsg.style.color = '#ff4477';
      return;
    }

    resultsDiv.innerHTML = '';
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    cancelBtn.style.display = 'inline-block';
    statusMsg.style.color = 'rgba(255,255,255,0.4)';

    const controller = new AbortController();
    backtestAbortController = controller;

    try {
      const result = await runBacktest(config, source, {
        signal: controller.signal,
        onProgress: (stage) => {
          statusMsg.textContent =
            stage === 'fetching' ? 'Fetching historical bars...' :
            stage === 'running-script' ? 'Running script (signal collection)...' :
            stage === 'replaying' ? 'Replaying fills...' : 'Done.';
        },
      });
      lastBacktestResult = result;
      statusMsg.textContent = `Done — ${result.totalBars} bars, ${result.trades.length} trades.`;
      renderResults(result);
    } catch (e: any) {
      if (e instanceof BacktestCancelledError) {
        statusMsg.textContent = 'Cancelled.';
      } else {
        statusMsg.textContent = `Backtest failed: ${e?.message || e}`;
        statusMsg.style.color = '#ff4477';
      }
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '▶ Run Backtest';
      cancelBtn.style.display = 'none';
      backtestAbortController = null;
    }
  };

  cancelBtn.onclick = () => {
    backtestAbortController?.abort();
  };

  if (lastBacktestResult) renderResults(lastBacktestResult);
}

// ─── Strategy Lab (batch variant sweep) Panel ────────────────────────
// Rescoped exactly per the adversarial review's mandated cuts on the
// original "Overnight Strategy Lab" concept: no GA, no scheduling/idle-time
// framing — a foreground "Run Batch" button only, a small fixed N of
// variants (buildBatchVariants(), capped at MAX_BATCH_VARIANTS), the
// existing single in-sample/out-of-sample Time Machine split (never
// walk-forward), and a human-approval gate — the same prompt()-based save
// flow as the editor's own Save button — before anything reaches the saved-
// indicator library. Nothing here is ever applied or saved automatically.

function toggleStrategyLab(): void {
  if (!strategyLabPanel) return;
  const isVisible = strategyLabPanel.style.display !== 'none';
  strategyLabPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) renderStrategyLab();
}

function renderStrategyLab(): void {
  if (!strategyLabPanel) return;
  strategyLabPanel.innerHTML = '';

  const header = document.createElement('div');
  Object.assign(header.style, {
    position: 'sticky', top: '0', background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px',
    zIndex: '1',
  });
  const headerTitle = document.createElement('div');
  headerTitle.textContent = '🧪 Strategy Lab — Batch Run';
  Object.assign(headerTitle.style, { color: '#b48cff', fontSize: '11px', fontWeight: '600', marginBottom: '2px' });
  header.appendChild(headerTitle);
  const headerSub = document.createElement('div');
  headerSub.textContent = `Runs a fixed batch of up to ${MAX_BATCH_VARIANTS} parameter variants (baseline + up to ${MAX_SWEPT_INPUTS} numeric inputs, nudged one at a time) through Time Machine. You review and approve before anything is saved.`;
  Object.assign(headerSub.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });
  header.appendChild(headerSub);
  strategyLabPanel.appendChild(header);

  const chartCtx = onGetChartContext ? onGetChartContext() : { symbol: 'SPY', timeframe: '1h', baseUrl: undefined };
  const cfg = {
    symbol: lastStrategyLabConfig?.symbol ?? lastBacktestConfig?.symbol ?? chartCtx.symbol ?? 'SPY',
    timeframe: lastStrategyLabConfig?.timeframe ?? lastBacktestConfig?.timeframe ?? chartCtx.timeframe ?? '1h',
    barCount: lastStrategyLabConfig?.barCount ?? lastBacktestConfig?.barCount ?? 500,
    inSamplePct: lastStrategyLabConfig?.inSamplePct ?? lastBacktestConfig?.inSamplePct ?? 70,
    qtyPerTrade: lastStrategyLabConfig?.qtyPerTrade ?? lastBacktestConfig?.qtyPerTrade ?? 1,
    startingCash: lastStrategyLabConfig?.startingCash ?? lastBacktestConfig?.startingCash ?? 10000,
    stopLossMode: lastStrategyLabConfig?.stopLossMode ?? lastBacktestConfig?.stopLossMode ?? 'none',
    stopLossValue: lastStrategyLabConfig?.stopLossValue ?? lastBacktestConfig?.stopLossValue ?? 2,
    takeProfitMode: lastStrategyLabConfig?.takeProfitMode ?? lastBacktestConfig?.takeProfitMode ?? 'none',
    takeProfitValue: lastStrategyLabConfig?.takeProfitValue ?? lastBacktestConfig?.takeProfitValue ?? 4,
  };

  const formHandle = buildBacktestConfigForm(cfg);
  strategyLabPanel.appendChild(formHandle.formEl);

  // Sweep preview — computed up front so the user knows exactly what's
  // about to run before clicking, never a surprise. Recomputed at panel-
  // open time and again right before running (in case the script changed
  // in between); not live on every keystroke, same as the rest of this form.
  const previewDiv = document.createElement('div');
  Object.assign(previewDiv.style, { padding: '0 10px 6px', fontSize: '9px', color: 'rgba(255,255,255,0.55)' });
  strategyLabPanel.appendChild(previewDiv);

  let currentVariants: BatchVariant[] = [];
  let sweepError: string | null = null;

  function recomputeSweepPreview(): void {
    const source = textarea ? textarea.value : '';
    sweepError = null;
    currentVariants = [];
    previewDiv.style.color = 'rgba(255,255,255,0.55)';
    if (!source.trim()) {
      previewDiv.textContent = 'Editor is empty — nothing to run.';
      return;
    }
    try {
      const ast = parse(source);
      const inputs = detectInputs(ast);
      currentVariants = buildBatchVariants(inputs);
      const numericCount = inputs.filter(i => i.type === 'number').length;
      if (numericCount === 0) {
        previewDiv.textContent = 'No numeric inputs detected in this script — batch will run the baseline only (1 variant).';
      } else {
        const swept = numericCount > MAX_SWEPT_INPUTS ? `first ${MAX_SWEPT_INPUTS} of ${numericCount}` : `${numericCount}`;
        previewDiv.textContent = `Will run ${currentVariants.length} variants: ${currentVariants.map(v => v.label).join(' · ')} (sweeping ${swept} numeric input${numericCount === 1 ? '' : 's'}).`;
      }
    } catch (e: any) {
      sweepError = e?.message ? String(e.message) : String(e);
      previewDiv.textContent = `Script has a parse error — fix it before running a batch: ${sweepError}`;
      previewDiv.style.color = '#ff4477';
    }
  }
  recomputeSweepPreview();

  const actionsRow = document.createElement('div');
  Object.assign(actionsRow.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px 8px' });

  const runBatchBtn = document.createElement('button');
  runBatchBtn.textContent = '▶ Run Batch';
  Object.assign(runBatchBtn.style, {
    padding: '4px 10px', border: '1px solid rgba(34,204,136,0.4)',
    borderRadius: '4px', background: 'rgba(34,204,136,0.15)',
    color: '#22cc88', cursor: 'pointer', fontSize: '10px', fontWeight: '700',
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ Cancel';
  Object.assign(cancelBtn.style, {
    padding: '4px 10px', border: '1px solid rgba(255,68,119,0.4)',
    borderRadius: '4px', background: 'rgba(255,68,119,0.1)',
    color: '#ff4477', cursor: 'pointer', fontSize: '10px', fontWeight: '600',
    display: 'none',
  });

  const statusMsg = document.createElement('span');
  Object.assign(statusMsg.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });

  actionsRow.appendChild(runBatchBtn);
  actionsRow.appendChild(cancelBtn);
  actionsRow.appendChild(statusMsg);
  strategyLabPanel.appendChild(actionsRow);

  const resultsDiv = document.createElement('div');
  Object.assign(resultsDiv.style, { padding: '0 10px 10px' });
  strategyLabPanel.appendChild(resultsDiv);

  function miniStatBlock(stats: BacktestResult['inSample'], color: string): HTMLDivElement {
    const block = document.createElement('div');
    Object.assign(block.style, { fontSize: '9px', color: 'rgba(255,255,255,0.65)' });
    const title = document.createElement('span');
    title.textContent = (stats.label === 'in-sample' ? 'IS ' : 'OOS ');
    Object.assign(title.style, { color, fontWeight: '700' });
    block.appendChild(title);
    const text = document.createElement('span');
    text.textContent = `Sharpe ${stats.sharpePerBar.toFixed(3)} · P&L ${(stats.netPnLPct * 100).toFixed(1)}% · DD ${(stats.maxDrawdownPct * 100).toFixed(1)}% · ${stats.totalTrades} trades`;
    block.appendChild(text);
    return block;
  }

  // Deliberately does NOT touch oakscript_active_name/originalSavedName —
  // the editor is still editing the ORIGINAL script; approving a variant
  // creates a new, separate saved indicator alongside it, never silently
  // switches what a later Save/Apply click thinks it's editing.
  function approveAndSaveVariant(variant: BatchVariant, btn: HTMLButtonElement): void {
    const source = textarea ? textarea.value : '';
    const rewritten = applyOverridesToSource(source, variant.overrides);
    // applyOverridesToSource() matches input(...) calls line-by-line, but
    // this DSL's lexer treats newlines as insignificant whitespace (see
    // lexer.ts), so a multi-line `input(\n  9, "X"\n)` call — which
    // detectInputs() (AST-based) sees fine — would silently fail to match
    // here, saving a copy identical to the unmodified script instead of the
    // tuned variant the user just reviewed. Only the empty-overrides
    // (baseline) case is expected to leave the source byte-for-byte
    // unchanged; any other case where nothing changed means the rewrite
    // didn't find what it was looking for, so refuse to save silently-wrong
    // content rather than let it pass as if it were the real variant.
    if (variant.overrides.size > 0 && rewritten === source) {
      alert(`Couldn't locate "${variant.label}" in the script text to update it (e.g. an unusually formatted input(...) call) — refusing to save a copy that wouldn't actually match what was tested.`);
      return;
    }
    const currentName = localStorage.getItem('oakscript_active_name') || 'My Indicator';
    const suggested = variant.overrides.size === 0
      ? `${currentName} (batch baseline)`
      : `${currentName} (${variant.label})`;
    const name = prompt('Save this variant as a new indicator — nothing is saved until you confirm a name:', suggested);
    if (!name) return;
    saveUserIndicator(name, rewritten);
    refreshIndicatorDropdownFn?.();
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = '💾 Approve & Save'; }, 1500);
  }

  function renderBatchResults(rows: BatchRunRow[]): void {
    resultsDiv.innerHTML = '';

    const disclaimer = document.createElement('div');
    disclaimer.textContent = 'Same single fixed historical split and simplified next-bar-open fills as Time Machine. Ranked by in-sample Sharpe — out-of-sample is shown for reference only, never used to pick a "winner." Nothing is applied or saved automatically. Past performance on this data does not predict live results. This is not financial advice.';
    Object.assign(disclaimer.style, {
      fontSize: '9px', color: 'rgba(255,200,80,0.85)', background: 'rgba(255,200,80,0.08)',
      border: '1px solid rgba(255,200,80,0.2)', borderRadius: '4px', padding: '5px 7px', marginBottom: '8px',
    });
    resultsDiv.appendChild(disclaimer);

    const list = document.createElement('div');
    Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '5px' });

    rows.forEach((row, idx) => {
      const isBest = idx === 0;
      const card = document.createElement('div');
      Object.assign(card.style, {
        border: isBest ? '1px solid rgba(34,204,136,0.35)' : '1px solid rgba(180,140,255,0.12)',
        borderRadius: '5px', padding: '6px 8px',
        background: isBest ? 'rgba(34,204,136,0.06)' : 'rgba(255,255,255,0.02)',
      });

      const top = document.createElement('div');
      Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', gap: '6px' });

      const label = document.createElement('span');
      label.textContent = (isBest ? '★ Best (in-sample): ' : `#${idx + 1} `) + row.variant.label;
      Object.assign(label.style, {
        fontSize: '10px', fontWeight: '700', color: isBest ? '#22cc88' : 'rgba(255,255,255,0.75)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      top.appendChild(label);

      const rightSide = document.createElement('div');
      Object.assign(rightSide.style, { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' });

      if (row.result.scriptErrors.length > 0) {
        const warn = document.createElement('span');
        warn.textContent = '⚠ errors';
        warn.title = row.result.scriptErrors.slice(0, 3).join(' | ');
        Object.assign(warn.style, { fontSize: '9px', color: '#ff4477' });
        rightSide.appendChild(warn);
      }

      const saveBtnRow = document.createElement('button');
      saveBtnRow.textContent = '💾 Approve & Save';
      Object.assign(saveBtnRow.style, {
        padding: '3px 8px', border: '1px solid rgba(34,204,136,0.4)', borderRadius: '4px',
        background: 'rgba(34,204,136,0.12)', color: '#22cc88', cursor: 'pointer',
        fontSize: '9px', fontWeight: '600', whiteSpace: 'nowrap',
      });
      saveBtnRow.onclick = () => approveAndSaveVariant(row.variant, saveBtnRow);
      rightSide.appendChild(saveBtnRow);

      top.appendChild(rightSide);
      card.appendChild(top);

      const statsRow = document.createElement('div');
      Object.assign(statsRow.style, { display: 'flex', gap: '14px', flexWrap: 'wrap' });
      statsRow.appendChild(miniStatBlock(row.result.inSample, BT_IN_SAMPLE_COLOR));
      statsRow.appendChild(miniStatBlock(row.result.outOfSample, BT_OUT_OF_SAMPLE_COLOR));
      card.appendChild(statsRow);

      list.appendChild(card);
    });

    resultsDiv.appendChild(list);
  }

  runBatchBtn.onclick = async () => {
    recomputeSweepPreview();
    if (sweepError) {
      statusMsg.textContent = 'Fix the script parse error above before running a batch.';
      statusMsg.style.color = '#ff4477';
      return;
    }
    if (currentVariants.length === 0) {
      statusMsg.textContent = 'Editor is empty — nothing to run.';
      statusMsg.style.color = '#ff4477';
      return;
    }

    const source = textarea ? textarea.value : '';
    const config = formHandle.getConfig(chartCtx.baseUrl);
    lastStrategyLabConfig = config;

    resultsDiv.innerHTML = '';
    runBatchBtn.disabled = true;
    runBatchBtn.textContent = 'Running...';
    cancelBtn.style.display = 'inline-block';
    statusMsg.style.color = 'rgba(255,255,255,0.4)';

    const controller = new AbortController();
    strategyLabAbortController = controller;
    const variants = currentVariants;
    const rows: BatchRunRow[] = [];

    try {
      statusMsg.textContent = 'Fetching historical bars...';
      const rawBars = await fetchBacktestBars(config.symbol, config.timeframe, config.barCount, config.baseUrl);
      if (controller.signal.aborted) throw new BacktestCancelledError();
      const bars = barsToRuntimeBarData(rawBars);

      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        statusMsg.textContent = `Running variant ${i + 1}/${variants.length} — ${variant.label}...`;
        const result = await runBacktestOnBars(config, source, bars, {
          signal: controller.signal,
          inputOverrides: variant.overrides.size > 0 ? new Map<string, unknown>(variant.overrides) : undefined,
        });
        rows.push({ variant, result });
      }

      rows.sort((a, b) => b.result.inSample.sharpePerBar - a.result.inSample.sharpePerBar);
      lastStrategyLabRows = rows;
      statusMsg.textContent = `Done — ${rows.length} variants against ${bars.count} bars.`;
      renderBatchResults(rows);
    } catch (e: any) {
      if (e instanceof BacktestCancelledError) {
        statusMsg.textContent = `Cancelled — ${rows.length}/${variants.length} variants completed.`;
        if (rows.length > 0) {
          rows.sort((a, b) => b.result.inSample.sharpePerBar - a.result.inSample.sharpePerBar);
          lastStrategyLabRows = rows;
          renderBatchResults(rows);
        }
      } else {
        statusMsg.textContent = `Batch failed: ${e?.message || e}`;
        statusMsg.style.color = '#ff4477';
      }
    } finally {
      runBatchBtn.disabled = false;
      runBatchBtn.textContent = '▶ Run Batch';
      cancelBtn.style.display = 'none';
      strategyLabAbortController = null;
    }
  };

  cancelBtn.onclick = () => {
    strategyLabAbortController?.abort();
  };

  if (lastStrategyLabRows) renderBatchResults(lastStrategyLabRows);
}

// ─── Alert History / Explain This Signal Panel ───────────────────────
// Every fired alert already carries a deterministic snapshot of the
// script's own variable values at that bar (captureProvenance() in
// interpreter.ts) — this panel just displays it. No LLM, no re-running the
// script: the same script + the same historical bar always reproduces the
// same "why," which is the whole point for a trading tool (an explanation
// that isn't reproducible isn't trustworthy).

function toggleAlerts(): void {
  if (!alertsPanel) return;
  const isVisible = alertsPanel.style.display !== 'none';
  alertsPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) renderAlerts();
}

function renderAlerts(): void {
  if (!alertsPanel) return;
  alertsPanel.innerHTML = '';

  const header = document.createElement('div');
  Object.assign(header.style, {
    position: 'sticky', top: '0', background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: '1',
  });
  const headerTitle = document.createElement('div');
  headerTitle.textContent = '🔔 Alert History — Explain This Signal';
  Object.assign(headerTitle.style, { color: '#b48cff', fontSize: '11px', fontWeight: '600' });
  header.appendChild(headerTitle);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '🔄';
  refreshBtn.title = 'Refresh (new alerts since this panel opened aren\'t shown automatically)';
  Object.assign(refreshBtn.style, {
    padding: '2px 6px', border: '1px solid rgba(180,140,255,0.2)', borderRadius: '4px',
    background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '10px',
  });
  refreshBtn.onclick = () => renderAlerts();
  header.appendChild(refreshBtn);
  alertsPanel.appendChild(header);

  const body = document.createElement('div');
  Object.assign(body.style, { padding: '6px 10px' });

  const history = getAlertHistory();
  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No alerts fired yet. alert(...) and alertcondition(...) calls will appear here with the exact variable values that made them fire.';
    Object.assign(empty.style, { color: 'rgba(255,255,255,0.4)', fontSize: '10px' });
    body.appendChild(empty);
  }

  for (const a of history) {
    const card = document.createElement('div');
    Object.assign(card.style, {
      border: '1px solid rgba(180,140,255,0.12)', borderRadius: '5px',
      padding: '6px 8px', marginBottom: '5px', background: 'rgba(255,255,255,0.02)',
    });

    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', fontSize: '10px' });
    const typeLabel = document.createElement('span');
    typeLabel.textContent = a.type;
    Object.assign(typeLabel.style, { color: '#b48cff', fontWeight: '700' });
    const timeLabel = document.createElement('span');
    timeLabel.textContent = new Date(a.timestamp).toLocaleString();
    Object.assign(timeLabel.style, { color: 'rgba(255,255,255,0.35)' });
    top.appendChild(typeLabel);
    top.appendChild(timeLabel);
    card.appendChild(top);

    const msg = document.createElement('div');
    msg.textContent = `${a.message} — bar ${a.barIndex}, price ${a.price}`;
    Object.assign(msg.style, { fontSize: '10px', color: 'rgba(255,255,255,0.75)', marginTop: '2px' });
    card.appendChild(msg);

    const provEntries = a.provenance ? Object.entries(a.provenance) : [];
    if (provEntries.length > 0) {
      const whyToggle = document.createElement('div');
      whyToggle.textContent = `Why? ▸ (${provEntries.length} variables)`;
      Object.assign(whyToggle.style, { fontSize: '9px', color: '#22cc88', cursor: 'pointer', marginTop: '4px' });

      const whyBody = document.createElement('div');
      Object.assign(whyBody.style, {
        display: 'none', marginTop: '4px', padding: '5px 6px', borderRadius: '4px',
        background: 'rgba(34,204,136,0.06)', border: '1px solid rgba(34,204,136,0.15)',
      });
      for (const [name, value] of provEntries) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', justifyContent: 'space-between', fontSize: '9px', padding: '1px 0' });
        const n = document.createElement('span');
        n.textContent = name;
        n.style.color = 'rgba(255,255,255,0.45)';
        const v = document.createElement('span');
        v.textContent = typeof value === 'string' ? `"${value}"` : String(value);
        v.style.color = 'rgba(255,255,255,0.8)';
        row.appendChild(n);
        row.appendChild(v);
        whyBody.appendChild(row);
      }

      let expanded = false;
      whyToggle.onclick = () => {
        expanded = !expanded;
        whyToggle.textContent = `Why? ${expanded ? '▾' : '▸'} (${provEntries.length} variables)`;
        whyBody.style.display = expanded ? 'block' : 'none';
      };
      card.appendChild(whyToggle);
      card.appendChild(whyBody);
    }

    body.appendChild(card);
  }

  alertsPanel.appendChild(body);
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
