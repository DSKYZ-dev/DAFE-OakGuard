import { parse, ParseError } from './parser';
import { executeScript } from './interpreter';
import type { OakPlot, OakAlert } from './runtime';
import type { Program, Assignment, CallExpr, Identifier, ASTNode } from './ast';
import {
  getIndicators, getCategories, type IndicatorDef, saveUserIndicator, getUserIndicators, removeUserIndicator,
  buildCartridge, cartridgeFilename, parseCartridge,
} from './indicators';
import { getDocumentation, type DocSection } from './docs';
import { escapeHtml } from '../escape-html';
import { listImageAssets, saveImageAsset, deleteImageAsset, getLibraryStats, type AssetRecord } from './image-assets';
import { getImageCacheStats, clearImageCache } from '../image-cache';
import { runBacktestOnBars, BacktestCancelledError, DEFAULT_ENTRY_MATCH, DEFAULT_EXIT_MATCH } from '../backtest/engine';
import { WINDOW_TOP_MIN, SECOND_COLUMN_LEFT, clearOfHeaderTop } from '../header-band';
import { playTone } from '../accessibility';
import { addStoryboardEntry } from '../storyboard';
import { MAX_BACKTEST_BARS, fetchBacktestBars, barsToRuntimeBarData } from '../backtest/data';
import type { BacktestConfig, BacktestResult, StopLossMode, TakeProfitMode } from '../backtest/types';
import { backtestCertificate } from '../oakguard/honesty';
import { PushToTalk } from '../meta-voice';
import { visualCheck } from '../visual-check';
import { newBadge } from '../new-badge';

/** The last request sent to the agent, for the visual check. */
let lastAgentRequest = '';
import type { BaseBar } from '@dafe/types';
import { renderEquityCurve } from '../backtest/chart';
import {
  buildOptimizerGrid, objectiveScore, objectiveLabel, formatObjectiveScore, formatNumber, OPTIMIZER_OBJECTIVES,
  type OptimizerVariant, type OptimizerRunRow, type OptimizerObjective,
} from '../backtest/optimizer';
import {
  detectMlRefs, fetchMlPredictionsMap, fetchRlActionsMap, fetchDeviceInfo,
  trainMlModel, listMlModels, deleteMlModel, trainRlPolicy, listRlPolicies, deleteRlPolicy,
  type MlModelMeta, type RlPolicyMeta, type DeviceInfo,
} from '../ml-client';

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

export interface ConfirmModalOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'accent';
}

/**
 * Themed in-app confirmation modal replacing the browser's raw window.confirm()
 * dialog. Matches the terminal's dark glass + neon card treatment and supports
 * Escape / Enter / backdrop dismissal.
 */
export function showEditorConfirmModal(opts: ConfirmModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.getElementById('dafe-confirm-modal-backdrop');
    if (existing) existing.remove();

    const isDanger = (opts.tone ?? 'danger') === 'danger';
    const accent = isDanger ? '#ff5c8a' : '#22cc88';
    const accentBorder = isDanger ? 'rgba(255, 92, 138, 0.45)' : 'rgba(34, 204, 136, 0.45)';
    const accentBg = isDanger ? 'rgba(255, 68, 119, 0.16)' : 'rgba(34, 204, 136, 0.16)';

    const backdrop = document.createElement('div');
    backdrop.id = 'dafe-confirm-modal-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '10050',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(5, 7, 15, 0.72)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    });

    const card = document.createElement('div');
    card.className = 'dafe-glow-window';
    Object.assign(card.style, {
      width: 'min(400px, calc(100vw - 32px))',
      background: 'linear-gradient(180deg, rgba(16, 20, 36, 0.98) 0%, rgba(10, 12, 24, 0.98) 100%)',
      border: '1px solid rgba(34, 204, 136, 0.28)',
      borderRadius: '12px',
      boxShadow: '0 22px 56px rgba(0, 0, 0, 0.72), 0 0 28px rgba(34, 204, 136, 0.08)',
      padding: '18px 20px 16px',
      color: '#e8ecf8',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '10px',
    });

    const titleWrap = document.createElement('div');
    Object.assign(titleWrap.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '9px',
    });

    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: accent,
      boxShadow: `0 0 10px ${accent}`,
      flexShrink: '0',
    });

    const titleEl = document.createElement('div');
    titleEl.textContent = opts.title;
    Object.assign(titleEl.style, {
      fontSize: '13px',
      fontWeight: '700',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: '#22ffbb',
    });

    titleWrap.appendChild(dot);
    titleWrap.appendChild(titleEl);

    const closeX = document.createElement('button');
    closeX.textContent = '✕';
    Object.assign(closeX.style, {
      background: 'transparent',
      border: 'none',
      color: 'rgba(232, 236, 248, 0.55)',
      fontSize: '13px',
      cursor: 'pointer',
      padding: '2px 6px',
      borderRadius: '4px',
    });

    header.appendChild(titleWrap);
    header.appendChild(closeX);

    const msgEl = document.createElement('div');
    msgEl.textContent = opts.message;
    Object.assign(msgEl.style, {
      fontSize: '12.5px',
      lineHeight: '1.55',
      color: 'rgba(224, 230, 245, 0.85)',
      marginBottom: '18px',
    });

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '8px',
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    Object.assign(cancelBtn.style, {
      padding: '6px 14px',
      borderRadius: '6px',
      border: '1px solid rgba(255, 255, 255, 0.16)',
      background: 'rgba(255, 255, 255, 0.05)',
      color: '#cfd6ea',
      fontSize: '11.5px',
      fontWeight: '600',
      cursor: 'pointer',
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = opts.confirmLabel || 'Confirm';
    Object.assign(confirmBtn.style, {
      padding: '6px 15px',
      borderRadius: '6px',
      border: `1px solid ${accentBorder}`,
      background: accentBg,
      color: accent,
      fontSize: '11.5px',
      fontWeight: '700',
      cursor: 'pointer',
      boxShadow: `0 0 14px ${isDanger ? 'rgba(255, 68, 119, 0.14)' : 'rgba(34, 204, 136, 0.14)'}`,
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    card.appendChild(header);
    card.appendChild(msgEl);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    let settled = false;
    const finish = (val: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(val);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    window.addEventListener('keydown', onKey, true);

    cancelBtn.onclick = () => finish(false);
    closeX.onclick = () => finish(false);
    confirmBtn.onclick = () => finish(true);
    backdrop.onclick = (e) => { if (e.target === backdrop) finish(false); };
    confirmBtn.focus();
  });
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
let mlLabPanel: HTMLDivElement | null = null;
let alertsPanel: HTMLDivElement | null = null;
let persistKey = 'oakscript_persist';
let webhookUrl = localStorage.getItem('oakscript_webhook') || '';
let alertHistory: OakAlert[] = [];
let lastBacktestConfig: Partial<BacktestConfig> | null = null;
// Human-readable description of the bars the last backtest ACTUALLY ran on
// (e.g. "fetched 500 bars (SPY 1h)" vs "fetch failed → chart bars ×500
// (SPY 1m, synthetic)") — rendered with results so provenance is explicit.
let lastBacktestDataLabel: string | null = null;
let lastBacktestResult: BacktestResult | null = null;
let lastBacktestEvidence: { source: string; bars: ReturnType<typeof barsToRuntimeBarData> } | null = null;
let backtestAbortController: AbortController | null = null;
let lastStrategyLabConfig: Partial<BacktestConfig> | null = null;
let lastStrategyLabRows: OptimizerRunRow[] | null = null;
let lastStrategyLabObjective: OptimizerObjective = 'netPnlPct';
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

// ─── Optimizer variant sweep ─────────────────────────────────────────
// The combinatorial grid-search itself (buildOptimizerGrid, objective
// scoring) lives in ../backtest/optimizer.ts — a genuine backtest-domain
// concern, not editor UI. This file just wires that module's output into
// the panel below and reuses OptimizerVariant's Map<string,number>
// overrides shape for the same source-rewrite-on-save flow the old
// one-at-a-time sweep used.

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
export interface EditorChartContext {
  symbol: string;
  timeframe: string;
  baseUrl?: string;
  /** Valid timeframe values (mirrors the chart's own #tf-select options). */
  timeframes?: string[];
  /** Symbol universe for datalist suggestions (not a hard restriction). */
  symbols?: string[];
  /** Label of the chart's active data provider (e.g. 'yahoo', 'synthetic'). */
  provider?: string;
  /** The bars currently loaded in the chart, for dataSource='chart'/'auto'. */
  getChartBars?: () => BaseBar[];
}
let onGetChartContext: (() => EditorChartContext) | null = null;
export function setChartContextCallback(cb: () => EditorChartContext): void {
  onGetChartContext = cb;
}

export function createEditor(container: HTMLElement, onRun: (source: string) => void): { panel: HTMLDivElement; textarea: HTMLTextAreaElement } {
  onRunCallback = onRun;

  editorPanel = document.createElement('div');
  editorPanel.id = 'oakscript-editor';
  editorPanel.className = 'hud-window';
  Object.assign(editorPanel.style, {
    position: 'fixed', left: `${SECOND_COLUMN_LEFT}px`, top: `${WINDOW_TOP_MIN}px`, width: '460px', maxHeight: '90vh',
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
  header.className = 'hud-head';
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
    // Keep the panel below the header bar and on screen
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, saved.left ?? 300));
    const top = clearOfHeaderTop(Math.min(window.innerHeight - h - 12, saved.top ?? WINDOW_TOP_MIN));
    Object.assign(editorPanel.style, {
      left: left + 'px', top: top + 'px',
      width: w + 'px', height: h + 'px',
      maxHeight: 'none', right: 'auto', bottom: 'auto',
    });
  } else {
    // Default position: below the header bar, in the column after Trading
    Object.assign(editorPanel.style, { left: `${SECOND_COLUMN_LEFT}px`, top: `${WINDOW_TOP_MIN}px` });
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
    const y = clearOfHeaderTop(Math.min(window.innerHeight - 40, e.clientY - dragOffY));
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
  viewBtn.title = 'Toggle signal model visibility on chart';
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
        `Cancel = Save as a NEW signal model`
      );
      if (choice) {
        // Replace original
        saveUserIndicator(originalSavedName!, src);
        saveBtn.textContent = '✓';
        setTimeout(() => { saveBtn.textContent = '💾'; }, 1500);
      } else {
        // Save as new
        const name = prompt('Save signal model as:', currentName);
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
      const name = prompt('Save signal model as:', currentName);
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
  manageBtn.title = 'Manage saved signal models (delete, rename)';
  Object.assign(manageBtn.style, btnStyle('rgba(255,68,119,0.5)', 'transparent'));
  manageBtn.onclick = () => {
    const userInds = getUserIndicators();
    if (userInds.length === 0) {
      alert('No saved signal models to manage.');
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
    title.textContent = 'Manage Saved Signal Models';
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
          if (userInds.length === 1) { modal.remove(); alert('All saved signal models deleted.'); }
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
        if (!confirm(`"${finalName}" already exists in your saved signal models. Overwrite it?`)) {
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
  strategyLabBtn.textContent = '🎯 Optimize';
  strategyLabBtn.title = 'Optimizer — combinatorial parameter search against historical data, ranked by a selectable objective';
  Object.assign(strategyLabBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  strategyLabBtn.onclick = () => toggleStrategyLab();

  const mlLabBtn = document.createElement('button');
  mlLabBtn.textContent = '🧠 ML Lab';
  mlLabBtn.title = 'Train ML signal models and RL trading policies for ml.predict()/rl.action()';
  Object.assign(mlLabBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  mlLabBtn.onclick = () => toggleMlLab();

  const alertsBtn = document.createElement('button');
  alertsBtn.textContent = '🔔 Alerts';
  alertsBtn.title = 'Alert History — Explain This Signal shows the script\'s own variable values at the moment each alert fired';
  Object.assign(alertsBtn.style, btnStyle('rgba(255,255,255,0.4)', 'transparent'));
  alertsBtn.onclick = () => toggleAlerts();

  // Clear — wipe the editor to a truly empty state (with a themed in-app
  // confirmation dialog instead of the browser's raw window.confirm alert).
  // Also clears the saved-source cache so a reload doesn't resurrect what was
  // just cleared.
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '🧹 Clear';
  clearBtn.title = 'Clear all code from the editor (fresh start)';
  Object.assign(clearBtn.style, btnStyle('#ff7d9c', 'rgba(255,68,119,0.08)'));
  clearBtn.onclick = async () => {
    if (!textarea) return;
    if (textarea.value.trim()) {
      const ok = await showEditorConfirmModal({
        title: 'Clear Editor Workspace',
        message: 'Clear all code from the editor? Unsaved work in the current workspace will be lost.',
        confirmLabel: 'Clear Code',
        cancelLabel: 'Cancel',
        tone: 'danger',
      });
      if (!ok) return;
    }
    textarea.value = '';
    localStorage.removeItem('oakscript_source');
    showResults([], []);
    textarea.focus();
  };

  const oakguardBtn = document.createElement('button');
  oakguardBtn.textContent = '⬢ OakGuard';
  oakguardBtn.title = 'OakGuard: Muse Wonder writes a rule for each bug the validator missed; an independent referee keeps only rules that catch every broken variant (held-out ones included) without a false alarm.';
  Object.assign(oakguardBtn.style, btnStyle('#2dffb3', 'rgba(45,255,179,0.10)'));
  oakguardBtn.appendChild(newBadge());
  oakguardBtn.onclick = () => {
    document.getElementById('set-open-oakguard')?.click();
  };

  controls.appendChild(viewBtn);
  controls.appendChild(clearBtn);
  controls.appendChild(saveBtn);
  controls.appendChild(manageBtn);
  controls.appendChild(importBtn);
  controls.appendChild(importInput);
  controls.appendChild(indSelect);
  controls.appendChild(docsBtn);
  controls.appendChild(imagesBtn);
  controls.appendChild(backtestBtn);
  controls.appendChild(strategyLabBtn);
  controls.appendChild(mlLabBtn);
  controls.appendChild(alertsBtn);
  controls.appendChild(oakguardBtn);

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
  genBtn.title = 'Generate signal model from description';
  Object.assign(genBtn.style, agentBtnStyle('#22cc88'));
  genBtn.onclick = () => {
    const desc = prompt('Describe the signal analysis model:');
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
  // The reference is a two-part layout: a compact, independently scrollable
  // index above a content viewport. It used to be one scrolling box with a
  // sticky index — once the index grew to 30+ entries it became taller than
  // the panel's 300px cap, so it covered every section no matter where the
  // content was scrolled to (the index looked like the only thing in the
  // panel, and clicking a link moved the hidden content behind it).
  docPanel = document.createElement('div');
  docPanel.id = 'oakscript-docs';
  Object.assign(docPanel.style, {
    overflow: 'hidden', display: 'none', flexDirection: 'column',
    height: '300px', minHeight: '180px', maxHeight: '300px',
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

  // ── ML Lab (ml.predict / rl.action training) Panel ─────────────────
  mlLabPanel = document.createElement('div');
  mlLabPanel.id = 'oakscript-ml-lab';
  Object.assign(mlLabPanel.style, {
    overflow: 'auto', display: 'none', minHeight: '80px', maxHeight: '420px',
    borderBottom: '1px solid rgba(180, 140, 255, 0.08)',
    flexShrink: '0',
  });
  editorPanel.appendChild(mlLabPanel);

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

  // Muse Spark looks at the rendered chart and says whether it shows what was asked.
  const lookBtn = document.createElement('button');
  lookBtn.textContent = '👁 Look';
  lookBtn.title = 'Visual check: Muse Spark looks at the rendered chart and lists what it can and cannot see from your last request.';
  Object.assign(lookBtn.style, {
    padding: '1px 5px', border: '1px solid rgba(127,214,255,0.25)',
    borderRadius: '3px', background: 'transparent',
    color: 'rgba(127,214,255,0.8)', cursor: 'pointer', fontSize: '8px',
  });
  lookBtn.onclick = async () => {
    const request = lastAgentRequest || 'the indicator script that is applied to this chart: its plotted lines, markers and 3D layers';
    lookBtn.disabled = true;
    lookBtn.textContent = '👁 …';
    const v = await visualCheck(request, textarea?.value ?? '');
    lookBtn.disabled = false;
    lookBtn.textContent = '👁 Look';
    if (!v.ok) {
      appendAgentChatMsg('agent', `Visual check: ${v.detail}`);
      return;
    }
    appendAgentChatMsg('agent', `👁 Muse Spark ${v.matches ? '✓ matches the request' : '✕ does not match yet'}: ${v.summary}`);
    if (v.seen.length) appendAgentChatMsg('agent', `Sees: ${v.seen.join(', ')}`);
    if (v.missing.length) appendAgentChatMsg('agent', `Missing: ${v.missing.join(', ')}`);
    if (v.problems.length) appendAgentChatMsg('agent', `Problems: ${v.problems.join('; ')}`);
    appendAgentChatMsg('agent', `${v.model} · ${((v.latencyMs ?? 0) / 1000).toFixed(1)} s · $${(v.costUsd ?? 0).toFixed(4)}`);
  };
  chatTools.appendChild(lookBtn);
  const voiceTag = newBadge();
  voiceTag.title = 'New during the Meta hackathon: 🎤 speak a request (Muse Voice Transcribe) and 👁 Look (Muse Spark checks the rendered chart).';
  chatTitle.appendChild(voiceTag);
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
  chatInput.placeholder = 'Ask agent about this signal model...';
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
      lastAgentRequest = msg;
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
    lastAgentRequest = msg;
    if (agentChatCallback) agentChatCallback(msg);
  };

  // Push-to-talk through Muse Voice Transcribe: speak the indicator you want.
  const ptt = new PushToTalk();
  const chatMic = document.createElement('button');
  chatMic.textContent = '🎤';
  chatMic.title = 'Speak your request (Muse Voice Transcribe). Click to start, click again to send.';
  Object.assign(chatMic.style, {
    padding: '3px 7px', border: '1px solid rgba(180, 140, 255, 0.2)',
    borderRadius: '4px', background: 'rgba(180, 140, 255, 0.08)',
    color: '#b48cff', cursor: 'pointer', fontSize: '11px', minWidth: '30px',
  });
  let micTimer = 0;
  const resetMic = (): void => {
    window.clearInterval(micTimer);
    chatMic.textContent = '🎤';
    chatMic.style.color = '#b48cff';
    chatMic.style.borderColor = 'rgba(180, 140, 255, 0.2)';
    chatMic.disabled = false;
  };
  chatMic.onclick = async () => {
    if (!ptt.active) {
      try {
        await ptt.start();
      } catch {
        appendAgentChatMsg('agent', 'Microphone access was refused, so voice input is off.');
        return;
      }
      chatMic.style.color = '#ff4477';
      chatMic.style.borderColor = 'rgba(255, 68, 119, 0.6)';
      const tick = (): void => { chatMic.textContent = `■ ${Math.floor((Date.now() - ptt.startedAt) / 1000)}s`; };
      tick();
      micTimer = window.setInterval(tick, 250);
      return;
    }
    window.clearInterval(micTimer);
    chatMic.textContent = '…';
    chatMic.disabled = true;
    const result = await ptt.stop();
    resetMic();
    if (!result.ok || !result.text) {
      appendAgentChatMsg('agent', `Voice: ${result.detail || 'nothing was heard.'}`);
      return;
    }
    appendAgentChatMsg('user', `🎤 ${result.text}`);
    appendAgentChatMsg('agent', `Muse Voice Transcribe · ${((result.audioMs ?? 0) / 1000).toFixed(1)} s of audio in ${((result.latencyMs ?? 0) / 1000).toFixed(1)} s`);
    lastAgentRequest = result.text;
    if (agentChatCallback) agentChatCallback(result.text);
  };

  chatRow.appendChild(chatInput);
  chatRow.appendChild(chatMic);
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
  docPanel.style.display = isVisible ? 'none' : 'flex';
  if (!isVisible) {
    try { renderDocs(); } catch (e) {
      docPanel.innerHTML = `<div style="padding:10px;color:#ff4477;font-size:10px;">Failed to load docs: ${escapeHtml(e)}</div>`;
      docPanel.style.display = 'block';
    }
  }
}

function renderDocs(): void {
  if (!docPanel) return;
  docPanel.innerHTML = '';
  const sections = getDocumentation();
  // Index: capped height with its own scrollbar, never allowed to grow over
  // the reading pane below it.
  const nav = document.createElement('div');
  Object.assign(nav.style, {
    background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px',
    display: 'flex', flexWrap: 'wrap', gap: '4px', flexShrink: '0',
    maxHeight: '104px', overflowY: 'auto', alignContent: 'flex-start',
  });

  // Content viewport: the only part that scrolls when jumping to a section.
  const content = document.createElement('div');
  Object.assign(content.style, {
    flex: '1', minHeight: '0', overflowY: 'auto', position: 'relative',
  });
  const sectionEls = new Map<string, HTMLDivElement>();

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
      const sectionEl = sectionEls.get(section.title);
      if (!sectionEl) return;
      const delta = sectionEl.getBoundingClientRect().top - content.getBoundingClientRect().top;
      content.scrollTo({ top: Math.max(0, content.scrollTop + delta), behavior: 'smooth' });
    };
    nav.appendChild(link);
  }
  docPanel.appendChild(nav);
  docPanel.appendChild(content);

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

    sectionEls.set(section.title, sec);
    content.appendChild(sec);
  }
}

function toggleImages(): void {
  if (!imagesPanel) return;
  const isVisible = imagesPanel.style.display !== 'none';
  imagesPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    renderImages().catch((e) => {
      if (!imagesPanel) return;
      imagesPanel.innerHTML = `<div style="padding:10px;color:#ff4477;font-size:10px;">Failed to load image assets: ${escapeHtml(e)}</div>`;
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
// Fallback TF list if the chart context is unavailable — mirrors index.html's
// #tf-select. The form NEVER offers free-text timeframes anymore: a stray
// value like "1" used to persist in lastBacktestConfig and fail every
// subsequent data fetch with "No historical data returned".
const FALLBACK_TIMEFRAMES = ['1s', '5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
let backtestDatalistSeq = 0;

function buildBacktestConfigForm(cfg: {
  symbol: string; timeframe: string; barCount: number; inSamplePct: number;
  qtyPerTrade: number; startingCash: number; stopLossMode: StopLossMode;
  stopLossValue: number; takeProfitMode: TakeProfitMode; takeProfitValue: number;
  timeframes: string[]; symbols: string[];
  dataSource: 'auto' | 'fetch' | 'chart';
  signalSource: 'auto' | 'strategy' | 'shapes';
  entryMatch: string; exitMatch: string;
}): BacktestConfigFormHandle {
  const formWrap = document.createElement('div');
  Object.assign(formWrap.style, { padding: '6px 10px', display: 'flex', flexWrap: 'wrap', gap: '6px' });

  // Symbol: free text (any ticker the data source knows) with datalist
  // suggestions drawn from the same universe the toolbar's symbol search
  // uses — mirrors the chart's current symbol on every panel open.
  const symbolInput = document.createElement('input');
  symbolInput.type = 'text'; symbolInput.value = cfg.symbol;
  const datalistId = `bt-symbols-${++backtestDatalistSeq}`;
  const symbolDatalist = document.createElement('datalist');
  symbolDatalist.id = datalistId;
  for (const sym of cfg.symbols) {
    const opt = document.createElement('option');
    opt.value = sym;
    symbolDatalist.appendChild(opt);
  }
  symbolInput.setAttribute('list', datalistId);
  formWrap.appendChild(symbolDatalist);

  // Timeframe: strict dropdown mirroring the chart's own TF options.
  const timeframeSelect = document.createElement('select');
  const tfList = cfg.timeframes.length > 0 ? cfg.timeframes : FALLBACK_TIMEFRAMES;
  for (const tf of tfList) {
    const opt = document.createElement('option');
    opt.value = tf; opt.textContent = tf;
    if (tf === cfg.timeframe) opt.selected = true;
    timeframeSelect.appendChild(opt);
  }

  // Data source + signal source (the one-script-both-roles bridge controls).
  const dataSourceSelect = document.createElement('select');
  for (const [val, label] of [
    ['auto', 'Auto (fetch → chart)'], ['fetch', 'Fetch historical'], ['chart', 'Chart (loaded bars)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (val === cfg.dataSource) opt.selected = true;
    dataSourceSelect.appendChild(opt);
  }
  const signalSourceSelect = document.createElement('select');
  for (const [val, label] of [
    ['auto', 'Auto (model.* → shapes)'], ['strategy', 'model.*/strategy.* only'], ['shapes', 'Plotted shapes'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (val === cfg.signalSource) opt.selected = true;
    signalSourceSelect.appendChild(opt);
  }
  const entryMatchInput = document.createElement('input');
  entryMatchInput.type = 'text'; entryMatchInput.value = cfg.entryMatch;
  entryMatchInput.title = 'Pipe-separated, case-insensitive label substrings that count a plotted shape as an ENTRY signal';
  const exitMatchInput = document.createElement('input');
  exitMatchInput.type = 'text'; exitMatchInput.value = cfg.exitMatch;
  exitMatchInput.title = 'Pipe-separated, case-insensitive label substrings that count a plotted shape as an EXIT signal';
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
  formWrap.appendChild(configField('Timeframe', timeframeSelect, '70px'));
  formWrap.appendChild(configField('Data', dataSourceSelect, '130px'));
  formWrap.appendChild(configField(`Bars (max ${MAX_BACKTEST_BARS})`, barCountInput, '110px'));
  formWrap.appendChild(configField('In-sample %', inSampleInput, '90px'));
  formWrap.appendChild(configField('Qty/trade', qtyInput, '80px'));
  formWrap.appendChild(configField('Starting cash', cashInput, '100px'));
  formWrap.appendChild(configField('Stop-Loss', slModeSelect, '100px'));
  formWrap.appendChild(configField('SL Value', slValueInput, '80px'));
  formWrap.appendChild(configField('Take-Profit', tpModeSelect, '100px'));
  formWrap.appendChild(configField('TP Value', tpValueInput, '80px'));
  formWrap.appendChild(configField('Signals', signalSourceSelect, '150px'));
  formWrap.appendChild(configField('Entry labels', entryMatchInput, '110px'));
  formWrap.appendChild(configField('Exit labels', exitMatchInput, '130px'));

  return {
    formEl: formWrap,
    getConfig(baseUrl?: string): BacktestConfig {
      return {
        symbol: symbolInput.value.trim().toUpperCase() || 'SPY',
        timeframe: timeframeSelect.value || '1h',
        barCount: Math.max(50, Math.min(MAX_BACKTEST_BARS, parseInt(barCountInput.value, 10) || 500)),
        inSamplePct: Math.max(10, Math.min(90, parseInt(inSampleInput.value, 10) || 70)),
        qtyPerTrade: Math.max(1, parseFloat(qtyInput.value) || 1),
        startingCash: Math.max(1, parseFloat(cashInput.value) || 10000),
        stopLossMode: slModeSelect.value as StopLossMode,
        stopLossValue: Math.max(0.01, parseFloat(slValueInput.value) || 2),
        takeProfitMode: tpModeSelect.value as TakeProfitMode,
        takeProfitValue: Math.max(0.01, parseFloat(tpValueInput.value) || 4),
        baseUrl,
        dataSource: dataSourceSelect.value as 'auto' | 'fetch' | 'chart',
        signalSource: signalSourceSelect.value as 'auto' | 'strategy' | 'shapes',
        entryMatch: entryMatchInput.value.trim(),
        exitMatch: exitMatchInput.value.trim(),
      };
    },
  };
}

/**
 * Resolves the bars a backtest runs against, per config.dataSource:
 * 'fetch' fails hard when the backend has nothing; 'chart' replays the bars
 * currently loaded in the chart (whatever symbol/provider that is — incl.
 * synthetic, so the backtester works fully offline); 'auto' tries fetch and
 * falls back to chart bars. Returns a human-readable label of what was
 * actually used so results can never silently misrepresent their data.
 */
async function resolveBacktestBars(
  config: BacktestConfig,
  chartCtx: EditorChartContext,
): Promise<{ raw: BaseBar[]; label: string }> {
  const mode = config.dataSource ?? 'auto';
  let fetchError: unknown = null;
  if (mode !== 'chart') {
    try {
      const raw = await fetchBacktestBars(config.symbol, config.timeframe, config.barCount, config.baseUrl);
      return { raw, label: `fetched ${raw.length} bars (${config.symbol} ${config.timeframe})` };
    } catch (e) {
      if (mode === 'fetch') throw e;
      fetchError = e;
    }
  }
  const chartBars = chartCtx.getChartBars?.() ?? [];
  if (chartBars.length < 50) {
    throw fetchError instanceof Error
      ? new Error(`${fetchError.message} Chart fallback unavailable too (only ${chartBars.length} bars loaded).`)
      : new Error(`Chart has only ${chartBars.length} bars loaded — not enough to backtest.`);
  }
  const raw = chartBars.slice(-config.barCount);
  const provider = chartCtx.provider ? `, ${chartCtx.provider}` : '';
  const fellBack = mode === 'auto' && fetchError !== null ? 'fetch failed → ' : '';
  return { raw, label: `${fellBack}chart bars ×${raw.length} (${chartCtx.symbol} ${chartCtx.timeframe}${provider})` };
}

/**
 * Scans a script for ml.predict("id")/rl.action("id") literal calls and, if
 * any are found, awaits their predictions/actions for the given bar range
 * up front — a one-shot backtest replay has no render loop to retry an
 * async fetch on (unlike the live chart's resolveMlPrediction/resolveRlAction,
 * which resolve in the background against a synchronous read). Returns {}
 * (no keys) when the script makes no ml.predict/rl.action calls at all, so
 * spreading the result into RunBacktestOptions is always safe.
 */
async function resolveMlRefsForScript(
  source: string, bars: ReturnType<typeof barsToRuntimeBarData>, baseUrl?: string,
): Promise<{ mlPredictions?: Map<string, number[]>; rlActions?: Map<string, number[]> }> {
  const { modelIds, policyIds } = detectMlRefs(source);
  if (modelIds.length === 0 && policyIds.length === 0) return {};
  const [mlPredictions, rlActions] = await Promise.all([
    modelIds.length > 0 ? fetchMlPredictionsMap(modelIds, bars, baseUrl) : Promise.resolve(undefined),
    policyIds.length > 0 ? fetchRlActionsMap(policyIds, bars, baseUrl) : Promise.resolve(undefined),
  ]);
  return { mlPredictions, rlActions };
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

  const chartCtx: EditorChartContext = onGetChartContext ? onGetChartContext() : { symbol: 'SPY', timeframe: '1h', baseUrl: undefined };
  const tfList = chartCtx.timeframes?.length ? chartCtx.timeframes : FALLBACK_TIMEFRAMES;
  // Symbol and timeframe LIVE-MIRROR the chart on every panel open (per
  // explicit user request) — the old lastBacktestConfig-first precedence let
  // a stale or invalid value (e.g. timeframe "1") shadow the chart's state
  // forever. Everything else still remembers the last run's settings.
  const chartTf = tfList.includes(chartCtx.timeframe) ? chartCtx.timeframe : (tfList.includes('1h') ? '1h' : tfList[0]);
  const cfg = {
    symbol: chartCtx.symbol || 'SPY',
    timeframe: chartTf,
    barCount: lastBacktestConfig?.barCount ?? 500,
    inSamplePct: lastBacktestConfig?.inSamplePct ?? 70,
    qtyPerTrade: lastBacktestConfig?.qtyPerTrade ?? 1,
    startingCash: lastBacktestConfig?.startingCash ?? 10000,
    stopLossMode: lastBacktestConfig?.stopLossMode ?? 'none' as const,
    stopLossValue: lastBacktestConfig?.stopLossValue ?? 2,
    takeProfitMode: lastBacktestConfig?.takeProfitMode ?? 'none' as const,
    takeProfitValue: lastBacktestConfig?.takeProfitValue ?? 4,
    timeframes: tfList,
    symbols: chartCtx.symbols ?? [],
    dataSource: lastBacktestConfig?.dataSource ?? 'auto' as const,
    signalSource: lastBacktestConfig?.signalSource ?? 'auto' as const,
    entryMatch: lastBacktestConfig?.entryMatch || DEFAULT_ENTRY_MATCH,
    exitMatch: lastBacktestConfig?.exitMatch || DEFAULT_EXIT_MATCH,
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

  const TRADE_LOG_HEADERS = ['#', 'Side', 'Entry Time', 'Entry Price', 'Exit Time', 'Exit Price', 'Exit Reason', 'Qty', 'P&L', 'Sample'];
  const EXIT_REASON_LABEL: Record<BacktestResult['trades'][number]['exitReason'], string> = {
    signal: 'Signal exit', 'stop-loss': 'Stop-loss', 'take-profit': 'Take-profit',
    'trailing-stop': 'Trailing stop', unknown: 'Unknown',
  };

  function tradeSample(t: BacktestResult['trades'][number], splitBarIdx: number): 'In-Sample' | 'Out-of-Sample' {
    return t.barIdx <= splitBarIdx ? 'In-Sample' : 'Out-of-Sample';
  }

  /** Row cells match TRADE_LOG_HEADERS 1:1 — shared by the on-screen table,
   * CSV export, and print view so the three can never drift apart. */
  function tradeLogRows(result: BacktestResult): string[][] {
    return result.trades.map((t, i) => [
      String(i + 1),
      t.side === 'long' ? 'Long' : 'Short',
      new Date(t.entryTime).toLocaleString(),
      t.entryPrice.toFixed(4),
      new Date(t.exitTime).toLocaleString(),
      t.exitPrice.toFixed(4),
      EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason,
      String(t.qty),
      (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2),
      tradeSample(t, result.splitBarIdx),
    ]);
  }

  function tradeLogToCSV(result: BacktestResult): string {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [TRADE_LOG_HEADERS, ...tradeLogRows(result)].map(row => row.map(esc).join(','));
    return lines.join('\n');
  }

  function openTradeLogPrintView(result: BacktestResult): void {
    const win = window.open('', '_blank', 'width=980,height=720');
    if (!win) return;
    const cfg = result.config;
    const rows = tradeLogRows(result);
    const theadHtml = `<tr>${TRADE_LOG_HEADERS.map(h => `<th>${h}</th>`).join('')}</tr>`;
    const tbodyHtml = rows.map((r, i) => {
      const pnl = result.trades[i].pnl;
      return `<tr>${r.map((cell, ci) => `<td class="${ci === 8 ? (pnl >= 0 ? 'pos' : 'neg') : ''}">${cell}</td>`).join('')}</tr>`;
    }).join('');
    const slDesc = cfg.stopLossMode === 'none' ? 'none' : `${cfg.stopLossMode} ${cfg.stopLossValue}`;
    const tpDesc = cfg.takeProfitMode === 'none' ? 'none' : `${cfg.takeProfitMode} ${cfg.takeProfitValue}`;
    win.document.write(`<!doctype html><html><head><title>Trade Log — ${cfg.symbol} ${cfg.timeframe}</title><style>
      body { font-family: -apple-system, Segoe UI, Arial, sans-serif; padding: 24px; color: #111; }
      h1 { font-size: 16px; margin: 0 0 4px; }
      .meta { font-size: 11px; color: #555; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; font-size: 11px; }
      th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: right; white-space: nowrap; }
      th:nth-child(1), th:nth-child(2), th:nth-child(3), th:nth-child(5), th:nth-child(7), th:nth-child(10),
      td:nth-child(1), td:nth-child(2), td:nth-child(3), td:nth-child(5), td:nth-child(7), td:nth-child(10) { text-align: left; }
      thead { background: #eee; }
      tr:nth-child(even) { background: #fafafa; }
      .pos { color: #0a7d3a; font-weight: 600; } .neg { color: #b3261e; font-weight: 600; }
      @media print { body { padding: 8px; } }
      </style></head><body>
      <h1>Trade Log — ${cfg.symbol} ${cfg.timeframe}</h1>
      <div class="meta">${result.trades.length} trades · ${cfg.barCount} bars · SL: ${slDesc} · TP: ${tpDesc} · generated ${new Date().toLocaleString()}</div>
      <table><thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  }

  function smallActionBtn(label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      padding: '3px 8px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px',
      background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)',
      cursor: 'pointer', fontSize: '9px', fontWeight: '600',
    });
    return btn;
  }

  /** Every closed trade with full entry/exit fill detail — the level of
   * detail the aggregate stat blocks above can't show, e.g. whether a
   * bracket order ever actually fired (Exit Reason) versus every exit
   * being signal-driven regardless of the configured SL/TP. */
  function buildTradeLogSection(result: BacktestResult): HTMLDivElement {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { marginTop: '10px' });

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' });
    const title = document.createElement('div');
    title.textContent = `Trade Log (${result.trades.length})`;
    Object.assign(title.style, { fontSize: '10px', fontWeight: '700', color: 'rgba(255,255,255,0.7)' });
    header.appendChild(title);

    if (result.trades.length > 0) {
      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { display: 'flex', gap: '6px' });

      const csvBtn = smallActionBtn('⬇ CSV');
      csvBtn.onclick = () => {
        const cfg = result.config;
        downloadTextFile(`trade-log_${cfg.symbol}_${cfg.timeframe}_${Date.now()}.csv`, tradeLogToCSV(result), 'text/csv');
      };
      const printBtn = smallActionBtn('🖨 Print');
      printBtn.onclick = () => openTradeLogPrintView(result);

      btnRow.appendChild(csvBtn);
      btnRow.appendChild(printBtn);
      header.appendChild(btnRow);
    }
    wrap.appendChild(header);

    if (result.trades.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No trades were closed in this run.';
      Object.assign(empty.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)', padding: '6px 0' });
      wrap.appendChild(empty);
      return wrap;
    }

    const scrollBox = document.createElement('div');
    Object.assign(scrollBox.style, {
      maxHeight: '220px', overflowY: 'auto', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '5px',
    });

    const table = document.createElement('table');
    Object.assign(table.style, { width: '100%', borderCollapse: 'collapse', fontSize: '9px' });

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const h of TRADE_LOG_HEADERS) {
      const th = document.createElement('th');
      th.textContent = h;
      Object.assign(th.style, {
        position: 'sticky', top: '0', background: '#1a1d29', color: 'rgba(255,255,255,0.5)',
        textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.15)', whiteSpace: 'nowrap',
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    tradeLogRows(result).forEach((r, i) => {
      const trade = result.trades[i];
      const tr = document.createElement('tr');
      if (i % 2 === 1) tr.style.background = 'rgba(255,255,255,0.03)';
      r.forEach((cell, ci) => {
        const td = document.createElement('td');
        td.textContent = cell;
        Object.assign(td.style, { padding: '3px 6px', whiteSpace: 'nowrap', color: 'rgba(255,255,255,0.65)' });
        if (ci === 8) td.style.color = trade.pnl >= 0 ? '#22cc88' : '#ff4477';
        if (ci === 6) {
          td.style.color = trade.exitReason === 'stop-loss' ? '#ff4477'
            : trade.exitReason === 'take-profit' ? '#22cc88'
            : trade.exitReason === 'trailing-stop' ? '#ffaa44'
            : 'rgba(255,255,255,0.5)';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scrollBox.appendChild(table);
    wrap.appendChild(scrollBox);

    return wrap;
  }

  // Honesty certificate: the procedure behind a result, checked on the bars and
  // script it actually ran on. It certifies the procedure, not the outcome.
  function renderHonestyCertificate(cert: ReturnType<typeof backtestCertificate>): HTMLElement {
    const box = document.createElement('div');
    Object.assign(box.style, {
      fontSize: '10px', color: 'rgba(255,255,255,0.8)', background: 'rgba(45,255,179,0.05)',
      border: '1px solid rgba(45,255,179,0.25)', borderRadius: '4px', padding: '6px 8px', marginBottom: '6px',
    });
    const head = document.createElement('div');
    head.textContent = cert.honest ? 'Honesty certificate: procedure checks PASS' : 'Honesty certificate: procedure checks FAIL';
    head.style.fontWeight = '700';
    head.style.color = cert.honest ? 'rgba(45,255,179,0.95)' : 'rgba(255,120,120,0.95)';
    head.appendChild(newBadge());
    box.appendChild(head);
    for (const c of cert.checks) {
      const row = document.createElement('div');
      row.style.marginTop = '3px';
      row.style.color = c.passed ? 'rgba(255,255,255,0.75)' : 'rgba(255,140,140,0.95)';
      row.textContent = `${c.passed ? '✓' : '✗'} ${c.name} — ${c.detail}`;
      box.appendChild(row);
    }
    const live = document.createElement('div');
    Object.assign(live.style, { marginTop: '5px', paddingTop: '4px', borderTop: '1px solid rgba(255,255,255,0.1)' });
    live.style.color = cert.live.passed ? 'rgba(255,255,255,0.75)' : 'rgba(255,200,80,0.95)';
    live.textContent = `${cert.live.passed ? '✓' : '⚠'} live use — ${cert.live.detail}`;
    box.appendChild(live);
    const note = document.createElement('div');
    Object.assign(note.style, { marginTop: '4px', fontSize: '9px', color: 'rgba(255,255,255,0.45)' });
    note.textContent = cert.disclaimer;
    box.appendChild(note);
    return box;
  }

  function renderResults(result: BacktestResult): void {
    resultsDiv.innerHTML = '';

    // Required, always-visible whenever a result is shown — never render
    // stats without it directly above them.
    const disclaimer = document.createElement('div');
    disclaimer.textContent = 'Backtest results use a single fixed historical split. Signal entries/exits fill at next-bar-open (no lookahead); stop-loss/take-profit/trailing brackets are evaluated intrabar against each bar\'s full high/low range, with gap-through pricing. Past performance on this data does not predict live results. This is not financial advice.';
    Object.assign(disclaimer.style, {
      fontSize: '9px', color: 'rgba(255,200,80,0.85)', background: 'rgba(255,200,80,0.08)',
      border: '1px solid rgba(255,200,80,0.2)', borderRadius: '4px', padding: '5px 7px', marginBottom: '6px',
    });
    resultsDiv.appendChild(disclaimer);

    // Provenance — which bars and which signal source this result came from,
    // so a shape-derived run on synthetic chart bars can never be mistaken
    // for an explicit-strategy run on fetched market data.
    const provenance = document.createElement('div');
    const signalDesc = result.signalSourceUsed === 'shapes'
      ? `derived from plotted signal shapes (${result.orderCount} orders, long-flat)`
      : result.signalSourceUsed === 'strategy'
        ? `explicit model.*/strategy.* calls (${result.orderCount} orders)`
        : 'none — the script emitted no model.*/strategy.* calls and no matchable signal shapes';
    provenance.textContent = `Signals: ${signalDesc}${lastBacktestDataLabel ? ` · Data: ${lastBacktestDataLabel}` : ''}`;
    Object.assign(provenance.style, {
      fontSize: '9px', color: 'rgba(180,140,255,0.8)', background: 'rgba(180,140,255,0.07)',
      border: '1px solid rgba(180,140,255,0.18)', borderRadius: '4px', padding: '5px 7px', marginBottom: '6px',
    });
    resultsDiv.appendChild(provenance);

    if (lastBacktestEvidence && lastBacktestResult === result) {
      resultsDiv.appendChild(renderHonestyCertificate(backtestCertificate({
        source: lastBacktestEvidence.source,
        bars: lastBacktestEvidence.bars,
        result,
      })));
    }

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

    resultsDiv.appendChild(buildTradeLogSection(result));
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
      statusMsg.textContent = 'Resolving historical bars...';
      const { raw, label: dataLabel } = await resolveBacktestBars(config, chartCtx);
      if (controller.signal.aborted) throw new BacktestCancelledError();
      lastBacktestDataLabel = dataLabel;
      const bars = barsToRuntimeBarData(raw);
      const mlRefs = await resolveMlRefsForScript(source, bars, chartCtx.baseUrl);
      if (controller.signal.aborted) throw new BacktestCancelledError();
      // Same overrides the Model Inputs panel applies to the live chart for
      // this script (see age-inputs-panel.ts) — without this, Run Backtest
      // silently replayed the script's hardcoded input(...) defaults no
      // matter what the panel's sliders showed, so tuning a parameter never
      // changed a single backtest result.
      const activeName = localStorage.getItem('oakscript_active_name') || undefined;
      const storedOverrides = getStoredOverrides(activeName);
      const result = await runBacktestOnBars(config, source, bars, {
        signal: controller.signal,
        ...mlRefs,
        inputOverrides: storedOverrides.size > 0 ? storedOverrides : undefined,
        onProgress: (stage) => {
          statusMsg.textContent =
            stage === 'running-script' ? 'Running script (signal collection)...' :
            stage === 'replaying' ? 'Replaying fills...' : statusMsg.textContent;
        },
      });
      lastBacktestResult = result;
      lastBacktestEvidence = { source, bars };
      const signalNote = result.signalSourceUsed === 'shapes'
        ? `${result.orderCount} orders derived from plotted signals`
        : result.signalSourceUsed === 'strategy'
          ? `${result.orderCount} model.*/strategy.* orders`
          : 'no signals found (add model.* calls or plotted Buy/Sell shapes)';
      statusMsg.textContent = `Done — ${result.totalBars} bars, ${result.trades.length} trades · ${signalNote} · data: ${dataLabel}`;
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

// ─── Optimizer Panel ──────────────────────────────────────────────────
// True combinatorial parameter search (see ../backtest/optimizer.ts):
// every swept numeric input is varied TOGETHER via buildOptimizerGrid()'s
// cartesian product, capped/randomly-subsampled at MAX_OPTIMIZER_RUNS total
// backtests, and ranked by a user-selectable objective. Still foreground
// only (no scheduling/idle-time framing) and still gated by human approval
// — the same prompt()-based save flow as the editor's own Save button —
// before any variant reaches the saved-indicator library. Nothing here is
// ever applied or saved automatically.

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
  headerTitle.textContent = '🎯 Optimizer';
  Object.assign(headerTitle.style, { color: '#b48cff', fontSize: '11px', fontWeight: '600', marginBottom: '2px' });
  header.appendChild(headerTitle);
  const headerSub = document.createElement('div');
  headerSub.textContent = 'Combinatorial parameter search through Time Machine — every swept numeric input varied together, ranked by your chosen objective. You review and approve before anything is saved.';
  Object.assign(headerSub.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });
  header.appendChild(headerSub);
  strategyLabPanel.appendChild(header);

  const chartCtx: EditorChartContext = onGetChartContext ? onGetChartContext() : { symbol: 'SPY', timeframe: '1h', baseUrl: undefined };
  const labTfList = chartCtx.timeframes?.length ? chartCtx.timeframes : FALLBACK_TIMEFRAMES;
  // Same live-mirror rule as the Backtest panel: symbol/timeframe always
  // track the chart; only run-shape settings are remembered between opens.
  const labChartTf = labTfList.includes(chartCtx.timeframe) ? chartCtx.timeframe : (labTfList.includes('1h') ? '1h' : labTfList[0]);
  const cfg = {
    symbol: chartCtx.symbol || 'SPY',
    timeframe: labChartTf,
    barCount: lastStrategyLabConfig?.barCount ?? lastBacktestConfig?.barCount ?? 500,
    inSamplePct: lastStrategyLabConfig?.inSamplePct ?? lastBacktestConfig?.inSamplePct ?? 70,
    qtyPerTrade: lastStrategyLabConfig?.qtyPerTrade ?? lastBacktestConfig?.qtyPerTrade ?? 1,
    startingCash: lastStrategyLabConfig?.startingCash ?? lastBacktestConfig?.startingCash ?? 10000,
    stopLossMode: lastStrategyLabConfig?.stopLossMode ?? lastBacktestConfig?.stopLossMode ?? 'none' as const,
    stopLossValue: lastStrategyLabConfig?.stopLossValue ?? lastBacktestConfig?.stopLossValue ?? 2,
    takeProfitMode: lastStrategyLabConfig?.takeProfitMode ?? lastBacktestConfig?.takeProfitMode ?? 'none' as const,
    takeProfitValue: lastStrategyLabConfig?.takeProfitValue ?? lastBacktestConfig?.takeProfitValue ?? 4,
    timeframes: labTfList,
    symbols: chartCtx.symbols ?? [],
    dataSource: lastStrategyLabConfig?.dataSource ?? lastBacktestConfig?.dataSource ?? 'auto' as const,
    signalSource: lastStrategyLabConfig?.signalSource ?? lastBacktestConfig?.signalSource ?? 'auto' as const,
    entryMatch: lastStrategyLabConfig?.entryMatch || lastBacktestConfig?.entryMatch || DEFAULT_ENTRY_MATCH,
    exitMatch: lastStrategyLabConfig?.exitMatch || lastBacktestConfig?.exitMatch || DEFAULT_EXIT_MATCH,
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

  let currentVariants: OptimizerVariant[] = [];
  let currentTotalCombinations = 1;
  let currentTruncated = false;
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
      const grid = buildOptimizerGrid(inputs);
      currentVariants = grid.variants;
      currentTotalCombinations = grid.totalCombinations;
      currentTruncated = grid.truncated;
      if (grid.sweptInputs.length === 0) {
        previewDiv.textContent = 'No numeric inputs detected in this script — optimizer will run the baseline only (1 combination).';
      } else {
        const names = grid.sweptInputs.map(i => i.title).join(', ');
        const truncNote = grid.truncated
          ? ` — full grid is ${currentTotalCombinations.toLocaleString()} combinations, randomly subsampled down to ${currentVariants.length} (baseline always kept)`
          : '';
        previewDiv.textContent = `Will run ${currentVariants.length} combination${currentVariants.length === 1 ? '' : 's'} across ${grid.sweptInputs.length} swept input${grid.sweptInputs.length === 1 ? '' : 's'} (${names})${truncNote}.`;
      }
    } catch (e: any) {
      sweepError = e?.message ? String(e.message) : String(e);
      previewDiv.textContent = `Script has a parse error — fix it before running the optimizer: ${sweepError}`;
      previewDiv.style.color = '#ff4477';
    }
  }
  recomputeSweepPreview();

  const actionsRow = document.createElement('div');
  Object.assign(actionsRow.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px 8px', flexWrap: 'wrap' });

  const objectiveSelect = document.createElement('select');
  Object.assign(objectiveSelect.style, {
    padding: '4px 6px', border: '1px solid rgba(180,140,255,0.15)', borderRadius: '4px',
    background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.7)', fontSize: '10px',
  });
  for (const o of OPTIMIZER_OBJECTIVES) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = `Rank by: ${o.label}`;
    if (o.value === lastStrategyLabObjective) opt.selected = true;
    objectiveSelect.appendChild(opt);
  }
  objectiveSelect.onchange = () => {
    lastStrategyLabObjective = objectiveSelect.value as OptimizerObjective;
    if (lastStrategyLabRows) {
      lastStrategyLabRows.forEach(r => { r.score = objectiveScore(r.result, lastStrategyLabObjective); });
      lastStrategyLabRows.sort((a, b) => b.score - a.score);
      renderBatchResults(lastStrategyLabRows);
    }
  };

  const runBatchBtn = document.createElement('button');
  runBatchBtn.textContent = '▶ Run Optimizer';
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

  actionsRow.appendChild(objectiveSelect);
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
  function approveAndSaveVariant(variant: OptimizerVariant, btn: HTMLButtonElement): void {
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
      ? `${currentName} (optimizer baseline)`
      : `${currentName} (${variant.label})`;
    const name = prompt('Save this combination as a new signal model — nothing is saved until you confirm a name:', suggested);
    if (!name) return;
    saveUserIndicator(name, rewritten);
    refreshIndicatorDropdownFn?.();
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = '💾 Approve & Save'; }, 1500);
  }

  function renderBatchResults(rows: OptimizerRunRow[]): void {
    resultsDiv.innerHTML = '';

    const objective = lastStrategyLabObjective;
    const disclaimer = document.createElement('div');
    disclaimer.textContent = `Same single fixed historical split and intrabar bracket fills as Time Machine (signals fill at next-bar-open; SL/TP/trailing brackets check each bar's full high/low range). Ranked by in-sample ${objectiveLabel(objective)} — out-of-sample is shown for reference only, never used to pick a "winner." Nothing is applied or saved automatically. Past performance on this data does not predict live results. This is not financial advice.`;
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
      label.textContent = (isBest ? '★ Best: ' : `#${idx + 1} `) + row.variant.label;
      label.title = row.variant.label;
      Object.assign(label.style, {
        fontSize: '10px', fontWeight: '700', color: isBest ? '#22cc88' : 'rgba(255,255,255,0.75)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      top.appendChild(label);

      const rightSide = document.createElement('div');
      Object.assign(rightSide.style, { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' });

      const scoreBadge = document.createElement('span');
      scoreBadge.textContent = `${objectiveLabel(objective)}: ${formatObjectiveScore(objective, row.score)}`;
      Object.assign(scoreBadge.style, {
        fontSize: '9px', fontWeight: '700', color: isBest ? '#22cc88' : '#b48cff',
        whiteSpace: 'nowrap',
      });
      rightSide.appendChild(scoreBadge);

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
      statusMsg.textContent = 'Fix the script parse error above before running the optimizer.';
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
    lastStrategyLabObjective = objectiveSelect.value as OptimizerObjective;
    const objective = lastStrategyLabObjective;

    resultsDiv.innerHTML = '';
    runBatchBtn.disabled = true;
    runBatchBtn.textContent = 'Running...';
    cancelBtn.style.display = 'inline-block';
    statusMsg.style.color = 'rgba(255,255,255,0.4)';

    const controller = new AbortController();
    strategyLabAbortController = controller;
    const variants = currentVariants;
    const rows: OptimizerRunRow[] = [];

    try {
      statusMsg.textContent = 'Resolving historical bars...';
      const { raw: rawBars, label: dataLabel } = await resolveBacktestBars(config, chartCtx);
      if (controller.signal.aborted) throw new BacktestCancelledError();
      const bars = barsToRuntimeBarData(rawBars);
      const mlRefs = await resolveMlRefsForScript(source, bars, chartCtx.baseUrl);
      if (controller.signal.aborted) throw new BacktestCancelledError();

      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        statusMsg.textContent = `Running combination ${i + 1}/${variants.length} — ${variant.label}...`;
        const result = await runBacktestOnBars(config, source, bars, {
          signal: controller.signal,
          ...mlRefs,
          inputOverrides: variant.overrides.size > 0 ? new Map<string, unknown>(variant.overrides) : undefined,
        });
        rows.push({ variant, result, score: objectiveScore(result, objective) });
      }

      rows.sort((a, b) => b.score - a.score);
      lastStrategyLabRows = rows;
      const sigNote = rows[0]?.result.signalSourceUsed === 'shapes' ? ' · signals derived from plotted shapes' : '';
      const truncNote = currentTruncated ? ` (subsampled from ${currentTotalCombinations.toLocaleString()} total combinations)` : '';
      statusMsg.textContent = `Done — ${rows.length} combinations${truncNote} against ${bars.count} bars · data: ${dataLabel}${sigNote}`;
      renderBatchResults(rows);
    } catch (e: any) {
      if (e instanceof BacktestCancelledError) {
        statusMsg.textContent = `Cancelled — ${rows.length}/${variants.length} combinations completed.`;
        if (rows.length > 0) {
          rows.sort((a, b) => b.score - a.score);
          lastStrategyLabRows = rows;
          renderBatchResults(rows);
        }
      } else {
        statusMsg.textContent = `Optimizer failed: ${e?.message || e}`;
        statusMsg.style.color = '#ff4477';
      }
    } finally {
      runBatchBtn.disabled = false;
      runBatchBtn.textContent = '▶ Run Optimizer';
      cancelBtn.style.display = 'none';
      strategyLabAbortController = null;
    }
  };

  cancelBtn.onclick = () => {
    strategyLabAbortController?.abort();
  };

  if (lastStrategyLabRows) renderBatchResults(lastStrategyLabRows);
}

// ─── ML Lab Panel ─────────────────────────────────────────────────────
// Trains the models/policies ml.predict("id")/rl.action("id") reference.
// Tiered by design, not GPU-gated: gradient boosting / a real 2-hidden-
// layer MLP / logistic regression / tabular Q-learning (all scikit-learn
// or from-scratch numpy) are classical, CPU-fast, and often just as
// accurate on this much tabular data — legitimate choices on any machine.
// LSTM (sequence-aware, a sliding window of bars rather than just the
// current one) and DQN (continuous state, no fixed discretization ceiling)
// are real PyTorch neural nets that benefit from a CUDA GPU when present,
// and still train correctly — just slower — on CPU. The device badge below
// reports which tier is actually in play. See backend/ml_engine.py.

let lastMlLabConfig: { symbol: string; timeframe: string; barCount: number; dataSource: 'auto' | 'fetch' | 'chart' } | null = null;

function toggleMlLab(): void {
  if (!mlLabPanel) return;
  const isVisible = mlLabPanel.style.display !== 'none';
  mlLabPanel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) renderMlLab();
}

function mlLabSectionHeader(text: string): HTMLDivElement {
  const h = document.createElement('div');
  h.textContent = text;
  Object.assign(h.style, {
    fontSize: '10px', fontWeight: '700', color: '#b48cff',
    padding: '10px 10px 4px', textTransform: 'uppercase', letterSpacing: '0.04em',
  });
  return h;
}

function mlLabBtnStyle(color: string): Partial<CSSStyleDeclaration> {
  return {
    padding: '4px 10px', border: `1px solid ${color}66`, borderRadius: '4px',
    background: `${color}26`, color, cursor: 'pointer', fontSize: '10px', fontWeight: '700',
  };
}

function renderMlLab(): void {
  if (!mlLabPanel) return;
  mlLabPanel.innerHTML = '';

  const header = document.createElement('div');
  Object.assign(header.style, {
    position: 'sticky', top: '0', background: 'rgba(8,8,20,0.98)',
    borderBottom: '1px solid rgba(180,140,255,0.1)', padding: '6px 10px', zIndex: '1',
  });
  const headerTitle = document.createElement('div');
  headerTitle.textContent = '🧠 ML Lab';
  Object.assign(headerTitle.style, { color: '#b48cff', fontSize: '11px', fontWeight: '600', marginBottom: '2px' });
  header.appendChild(headerTitle);
  const headerSub = document.createElement('div');
  headerSub.textContent = 'Train ML signal models and RL trading policies against historical bars. Reference them in a script via ml.predict("modelId") / rl.action("policyId"). Classical (Gradient Boosting / MLP / Logistic / Tabular Q-Learning) or deep (LSTM / DQN) — pick per model, not a global setting.';
  Object.assign(headerSub.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });
  header.appendChild(headerSub);

  const deviceBadge = document.createElement('div');
  deviceBadge.textContent = 'Checking device for deep (LSTM/DQN) models…';
  Object.assign(deviceBadge.style, {
    fontSize: '9px', color: 'rgba(255,255,255,0.35)', marginTop: '4px', padding: '4px 6px',
    border: '1px solid rgba(180,140,255,0.15)', borderRadius: '4px', background: 'rgba(180,140,255,0.05)',
  });
  header.appendChild(deviceBadge);
  mlLabPanel.appendChild(header);

  const chartCtx: EditorChartContext = onGetChartContext ? onGetChartContext() : { symbol: 'SPY', timeframe: '1h', baseUrl: undefined };
  const tfList = chartCtx.timeframes?.length ? chartCtx.timeframes : FALLBACK_TIMEFRAMES;
  const chartTf = tfList.includes(chartCtx.timeframe) ? chartCtx.timeframe : (tfList.includes('1h') ? '1h' : tfList[0]);

  // ── Mini data-source form (symbol/timeframe/bars/source only — no
  // SL/TP/qty/signal fields, none of which mean anything for training) ──
  const formWrap = document.createElement('div');
  Object.assign(formWrap.style, { padding: '6px 10px', display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const symbolInput = document.createElement('input');
  symbolInput.type = 'text'; symbolInput.value = lastMlLabConfig?.symbol || chartCtx.symbol || 'SPY';
  const tfSelect = document.createElement('select');
  for (const tf of tfList) {
    const opt = document.createElement('option');
    opt.value = tf; opt.textContent = tf;
    if (tf === (lastMlLabConfig?.timeframe || chartTf)) opt.selected = true;
    tfSelect.appendChild(opt);
  }
  const barCountInput = document.createElement('input');
  barCountInput.type = 'number'; barCountInput.min = '50'; barCountInput.max = String(MAX_BACKTEST_BARS);
  barCountInput.value = String(lastMlLabConfig?.barCount ?? 500);
  const dataSourceSelect = document.createElement('select');
  for (const [val, label] of [
    ['auto', 'Auto (fetch → chart)'], ['fetch', 'Fetch historical'], ['chart', 'Chart (loaded bars)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (val === (lastMlLabConfig?.dataSource ?? 'auto')) opt.selected = true;
    dataSourceSelect.appendChild(opt);
  }
  formWrap.appendChild(configField('Symbol', symbolInput, '90px'));
  formWrap.appendChild(configField('Timeframe', tfSelect, '70px'));
  formWrap.appendChild(configField(`Bars (max ${MAX_BACKTEST_BARS})`, barCountInput, '110px'));
  formWrap.appendChild(configField('Data', dataSourceSelect, '130px'));
  mlLabPanel.appendChild(formWrap);

  function currentDataConfig(): BacktestConfig {
    const cfg: {
      symbol: string; timeframe: string; barCount: number;
      dataSource: 'auto' | 'fetch' | 'chart';
    } = {
      symbol: symbolInput.value.trim().toUpperCase() || 'SPY',
      timeframe: tfSelect.value || '1h',
      barCount: Math.max(50, Math.min(MAX_BACKTEST_BARS, parseInt(barCountInput.value, 10) || 500)),
      dataSource: dataSourceSelect.value as 'auto' | 'fetch' | 'chart',
    };
    lastMlLabConfig = cfg;
    // Unused-by-resolveBacktestBars fields still need to satisfy the type —
    // sensible constants, never read for training.
    return {
      ...cfg, inSamplePct: 70, qtyPerTrade: 1, startingCash: 10000,
      stopLossMode: 'none', stopLossValue: 2, takeProfitMode: 'none', takeProfitValue: 4,
      baseUrl: chartCtx.baseUrl,
    };
  }

  // ── Train ML model ──
  mlLabPanel.appendChild(mlLabSectionHeader('Train ML Signal Model'));
  const mlFormRow = document.createElement('div');
  Object.assign(mlFormRow.style, { padding: '0 10px', display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const modelTypeSelect = document.createElement('select');
  for (const [v, l] of [
    ['gbm', 'Gradient Boosting (classical)'], ['mlp', 'Neural Net — MLP (classical)'],
    ['logistic', 'Logistic/Ridge (classical)'], ['lstm', 'Neural Net — LSTM (deep, sequence-aware)'],
  ] as const) {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = l; modelTypeSelect.appendChild(opt);
  }
  const lstmOption = modelTypeSelect.querySelector('option[value="lstm"]') as HTMLOptionElement;
  const targetTypeSelect = document.createElement('select');
  for (const [v, l] of [['direction', 'Direction (up/down)'], ['return', 'Return (%)']] as const) {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = l; targetTypeSelect.appendChild(opt);
  }
  const horizonInput = document.createElement('input');
  horizonInput.type = 'number'; horizonInput.min = '1'; horizonInput.max = '50'; horizonInput.value = '3';
  const mlTrainPctInput = document.createElement('input');
  mlTrainPctInput.type = 'number'; mlTrainPctInput.min = '50'; mlTrainPctInput.max = '90'; mlTrainPctInput.value = '70';
  mlFormRow.appendChild(configField('Model', modelTypeSelect, '190px'));
  mlFormRow.appendChild(configField('Target', targetTypeSelect, '150px'));
  mlFormRow.appendChild(configField('Horizon (bars)', horizonInput, '90px'));
  mlFormRow.appendChild(configField('Train %', mlTrainPctInput, '70px'));
  mlLabPanel.appendChild(mlFormRow);

  const mlDeepHint = document.createElement('div');
  Object.assign(mlDeepHint.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)', padding: '0 10px 4px', display: 'none' });
  mlLabPanel.appendChild(mlDeepHint);

  const mlActionsRow = document.createElement('div');
  Object.assign(mlActionsRow.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px' });
  const trainMlBtn = document.createElement('button');
  trainMlBtn.textContent = '▶ Train ML Model';
  Object.assign(trainMlBtn.style, mlLabBtnStyle('#22cc88'));
  const mlStatus = document.createElement('span');
  Object.assign(mlStatus.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });
  mlActionsRow.appendChild(trainMlBtn);
  mlActionsRow.appendChild(mlStatus);
  mlLabPanel.appendChild(mlActionsRow);

  // ── Train RL policy ──
  mlLabPanel.appendChild(mlLabSectionHeader('Train RL Trading Policy'));
  const rlFormRow = document.createElement('div');
  Object.assign(rlFormRow.style, { padding: '0 10px', display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const algorithmSelect = document.createElement('select');
  for (const [v, l] of [
    ['tabular', 'Tabular Q-Learning (classical, fast)'], ['dqn', 'Deep Q-Network — DQN (deep, continuous state)'],
  ] as const) {
    const opt = document.createElement('option'); opt.value = v; opt.textContent = l; algorithmSelect.appendChild(opt);
  }
  const dqnOption = algorithmSelect.querySelector('option[value="dqn"]') as HTMLOptionElement;
  const episodesInput = document.createElement('input');
  episodesInput.type = 'number'; episodesInput.min = '20'; episodesInput.max = '2000'; episodesInput.value = '150';
  const rlTrainPctInput = document.createElement('input');
  rlTrainPctInput.type = 'number'; rlTrainPctInput.min = '50'; rlTrainPctInput.max = '90'; rlTrainPctInput.value = '70';
  // DQN does a gradient-descent step per environment step (real backprop,
  // not a table lookup) — meaningfully more work per episode than tabular
  // Q-learning, so it defaults to fewer episodes rather than leaving a
  // 150-episode default that'd feel hung on a CPU-only machine.
  const RL_DEFAULT_EPISODES: Record<string, string> = { tabular: '150', dqn: '40' };
  algorithmSelect.onchange = () => {
    episodesInput.value = RL_DEFAULT_EPISODES[algorithmSelect.value] ?? episodesInput.value;
    updateRlHint();
  };
  rlFormRow.appendChild(configField('Algorithm', algorithmSelect, '220px'));
  rlFormRow.appendChild(configField('Episodes', episodesInput, '90px'));
  rlFormRow.appendChild(configField('Train %', rlTrainPctInput, '70px'));
  mlLabPanel.appendChild(rlFormRow);

  const rlDeepHint = document.createElement('div');
  Object.assign(rlDeepHint.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)', padding: '0 10px 4px', display: 'none' });
  mlLabPanel.appendChild(rlDeepHint);

  const rlActionsRow = document.createElement('div');
  Object.assign(rlActionsRow.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px' });
  const trainRlBtn = document.createElement('button');
  trainRlBtn.textContent = '▶ Train RL Policy';
  Object.assign(trainRlBtn.style, mlLabBtnStyle('#22cc88'));
  const rlStatus = document.createElement('span');
  Object.assign(rlStatus.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)' });
  rlActionsRow.appendChild(trainRlBtn);
  rlActionsRow.appendChild(rlStatus);
  mlLabPanel.appendChild(rlActionsRow);

  // ── Device tier — fetched once per panel open, then drives the badge
  // text, which deep options are actually clickable, and the two inline
  // hints. Classical options never touch this — they're always available. ──
  let deviceInfo: DeviceInfo | null = null;

  function updateMlHint(): void {
    if (modelTypeSelect.value !== 'lstm' || !deviceInfo) { mlDeepHint.style.display = 'none'; return; }
    mlDeepHint.style.display = 'block';
    mlDeepHint.textContent = deviceInfo.device === 'cuda'
      ? `⚡ Will train on ${deviceInfo.deviceName} — fast.`
      : '🖥 No GPU detected — LSTM will still train correctly on CPU, just slower (a few to several seconds). Gradient Boosting above is a fast classical alternative with comparable accuracy on this much data.';
  }
  function updateRlHint(): void {
    if (algorithmSelect.value !== 'dqn' || !deviceInfo) { rlDeepHint.style.display = 'none'; return; }
    rlDeepHint.style.display = 'block';
    rlDeepHint.textContent = deviceInfo.device === 'cuda'
      ? `⚡ Will train on ${deviceInfo.deviceName} — fast.`
      : '🖥 No GPU detected — DQN does real backprop every step, so this can take 20-60s+ on CPU at the default episode count. Tabular Q-Learning above is a fast classical alternative.';
  }
  modelTypeSelect.onchange = updateMlHint;

  fetchDeviceInfo(chartCtx.baseUrl).then((info) => {
    deviceInfo = info;
    if (!info.torchAvailable) {
      deviceBadge.textContent = '⚙️ Classical-only backend — PyTorch isn\'t installed, so LSTM/DQN are unavailable here. Gradient Boosting, Neural Net (MLP), and Tabular Q-Learning below need no extra dependency and work fully as-is.';
      lstmOption.disabled = true;
      dqnOption.disabled = true;
    } else if (info.device === 'cuda') {
      deviceBadge.textContent = `⚡ GPU detected: ${info.deviceName} — LSTM/DQN below will train fast. Classical options are still great for quick iteration.`;
    } else {
      deviceBadge.textContent = '🖥 CPU only (no CUDA GPU detected) — LSTM/DQN below still train correctly, just slower. Gradient Boosting / Tabular Q-Learning are legitimate fast choices on any machine, not just a fallback.';
    }
    deviceBadge.style.color = info.device === 'cuda' ? '#22cc88' : 'rgba(255,255,255,0.45)';
    updateMlHint();
    updateRlHint();
  }).catch(() => {
    deviceBadge.textContent = 'Could not reach the backend to check device — deep (LSTM/DQN) options may be unavailable.';
    deviceBadge.style.color = '#ff4477';
  });

  // ── Lists ──
  const modelsListDiv = document.createElement('div');
  Object.assign(modelsListDiv.style, { padding: '0 10px 10px' });
  const policiesListDiv = document.createElement('div');
  Object.assign(policiesListDiv.style, { padding: '0 10px 10px' });

  const ML_MODEL_TYPE_LABEL: Record<string, string> = {
    gbm: 'Gradient Boosting', mlp: 'Neural Net (MLP)', logistic: 'Logistic/Ridge', lstm: 'LSTM (deep)',
  };
  const RL_ALGORITHM_LABEL: Record<string, string> = { tabular: 'Tabular Q-Learning', dqn: 'Deep Q-Network (DQN)' };
  function deviceTag(device: string | undefined): string {
    if (!device) return '';
    return device === 'cuda' ? ' · ⚡ trained on GPU' : ' · 🖥 trained on CPU';
  }

  function idBadgeRow(id: string, meta: string): HTMLDivElement {
    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', marginBottom: '4px' });
    const label = document.createElement('span');
    label.textContent = id;
    label.title = meta;
    Object.assign(label.style, { fontSize: '10px', fontWeight: '700', color: '#b48cff', fontFamily: 'monospace' });
    top.appendChild(label);
    const btnGroup = document.createElement('div');
    Object.assign(btnGroup.style, { display: 'flex', gap: '4px', flexShrink: '0' });
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy ID';
    Object.assign(copyBtn.style, { padding: '2px 6px', fontSize: '8px', border: '1px solid rgba(180,140,255,0.3)', borderRadius: '3px', background: 'rgba(180,140,255,0.1)', color: '#b48cff', cursor: 'pointer' });
    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(id).catch(() => {});
      copyBtn.textContent = '✓ Copied'; setTimeout(() => { copyBtn.textContent = '📋 Copy ID'; }, 1200);
    };
    btnGroup.appendChild(copyBtn);
    top.appendChild(btnGroup);
    return top;
  }

  async function refreshModelsList(): Promise<void> {
    modelsListDiv.innerHTML = '';
    modelsListDiv.appendChild(mlLabSectionHeader('Trained ML Models'));
    let models: MlModelMeta[];
    try { models = await listMlModels(chartCtx.baseUrl); } catch (e: any) {
      const err = document.createElement('div');
      err.textContent = `Couldn't reach the backend for the model list: ${e?.message || e}`;
      Object.assign(err.style, { fontSize: '9px', color: '#ff4477', padding: '0 10px' });
      modelsListDiv.appendChild(err);
      return;
    }
    if (models.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No trained models yet.';
      Object.assign(empty.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)', padding: '0 10px' });
      modelsListDiv.appendChild(empty);
      return;
    }
    for (const m of models) {
      const card = document.createElement('div');
      Object.assign(card.style, { border: '1px solid rgba(180,140,255,0.12)', borderRadius: '5px', padding: '6px 8px', marginBottom: '5px', background: 'rgba(255,255,255,0.02)' });
      const modelLabel = ML_MODEL_TYPE_LABEL[m.modelType] ?? m.modelType;
      card.appendChild(idBadgeRow(m.id, `${m.symbol} ${m.timeframe} · ${modelLabel} · horizon ${m.horizon} · trained ${new Date(m.createdAt * 1000).toLocaleString()}`));

      const meta = document.createElement('div');
      meta.textContent = `${m.symbol} ${m.timeframe} · ${modelLabel} · target: ${m.targetType} (horizon ${m.horizon}) · ${m.trainRows} train / ${m.valRows} val rows${deviceTag(m.device)}`;
      Object.assign(meta.style, { fontSize: '9px', color: 'rgba(255,255,255,0.5)', marginBottom: '3px' });
      card.appendChild(meta);

      const metricsLine = document.createElement('div');
      if (m.targetType === 'direction') {
        const acc = Number(m.metrics.accuracy), base = Number(m.metrics.baselineAccuracy);
        const beats = acc > base;
        metricsLine.textContent = `Validation accuracy: ${(acc * 100).toFixed(1)}% vs ${(base * 100).toFixed(1)}% baseline (${m.metrics.baselineLabel}) — precision ${(Number(m.metrics.precision) * 100).toFixed(1)}%, recall ${(Number(m.metrics.recall) * 100).toFixed(1)}%`;
        metricsLine.style.color = beats ? '#22cc88' : '#ff4477';
      } else {
        const mae = Number(m.metrics.mae), base = Number(m.metrics.baselineMae);
        const beats = mae < base;
        metricsLine.textContent = `Validation MAE: ${mae.toFixed(4)} vs ${base.toFixed(4)} baseline (${m.metrics.baselineLabel}) — R² ${Number(m.metrics.r2).toFixed(3)}`;
        metricsLine.style.color = beats ? '#22cc88' : '#ff4477';
      }
      Object.assign(metricsLine.style, { fontSize: '9px', fontWeight: '600', marginBottom: '3px' });
      card.appendChild(metricsLine);

      const topFeat = document.createElement('div');
      topFeat.textContent = `Top features: ${m.featureImportances.slice(0, 3).map(f => `${f.feature} (${f.importance.toFixed(3)})`).join(', ')}`;
      Object.assign(topFeat.style, { fontSize: '9px', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' });
      card.appendChild(topFeat);

      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑 Delete';
      Object.assign(delBtn.style, { padding: '2px 6px', fontSize: '8px', border: '1px solid rgba(255,68,119,0.3)', borderRadius: '3px', background: 'rgba(255,68,119,0.1)', color: '#ff4477', cursor: 'pointer' });
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        try { await deleteMlModel(m.id, chartCtx.baseUrl); await refreshModelsList(); } catch (e: any) { delBtn.textContent = 'Failed'; }
      };
      card.appendChild(delBtn);

      modelsListDiv.appendChild(card);
    }
  }

  async function refreshPoliciesList(): Promise<void> {
    policiesListDiv.innerHTML = '';
    policiesListDiv.appendChild(mlLabSectionHeader('Trained RL Policies'));
    let policies: RlPolicyMeta[];
    try { policies = await listRlPolicies(chartCtx.baseUrl); } catch (e: any) {
      const err = document.createElement('div');
      err.textContent = `Couldn't reach the backend for the policy list: ${e?.message || e}`;
      Object.assign(err.style, { fontSize: '9px', color: '#ff4477', padding: '0 10px' });
      policiesListDiv.appendChild(err);
      return;
    }
    if (policies.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No trained RL policies yet.';
      Object.assign(empty.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)', padding: '0 10px' });
      policiesListDiv.appendChild(empty);
      return;
    }
    for (const p of policies) {
      const card = document.createElement('div');
      Object.assign(card.style, { border: '1px solid rgba(180,140,255,0.12)', borderRadius: '5px', padding: '6px 8px', marginBottom: '5px', background: 'rgba(255,255,255,0.02)' });
      const algo = p.algorithm ?? 'tabular';
      const algoLabel = RL_ALGORITHM_LABEL[algo] ?? algo;
      const stateDesc = p.stateSpaceSize != null
        ? `${p.stateSpaceSize} discretized states`
        : `continuous (${p.stateFeatures.length} features, no discretization)`;
      card.appendChild(idBadgeRow(p.id, `${p.symbol} ${p.timeframe} · ${algoLabel} · ${p.episodes} episodes · trained ${new Date(p.createdAt * 1000).toLocaleString()}`));

      const meta = document.createElement('div');
      meta.textContent = `${p.symbol} ${p.timeframe} · ${algoLabel} · ${p.episodes} episodes · state space: ${stateDesc} · ${p.trainRows} train / ${p.valRows} val steps${deviceTag(p.device)}`;
      Object.assign(meta.style, { fontSize: '9px', color: 'rgba(255,255,255,0.5)', marginBottom: '3px' });
      card.appendChild(meta);

      const learningCurve = document.createElement('div');
      const rewards = p.episodeRewards;
      const firstAvg = rewards.slice(0, Math.max(1, Math.floor(rewards.length * 0.1))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(rewards.length * 0.1));
      const lastAvg = rewards.slice(-Math.max(1, Math.floor(rewards.length * 0.1))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(rewards.length * 0.1));
      learningCurve.textContent = `Learning curve (avg episode reward): first 10% ${firstAvg.toFixed(4)} → last 10% ${lastAvg.toFixed(4)}`;
      Object.assign(learningCurve.style, { fontSize: '9px', color: lastAvg > firstAvg ? '#22cc88' : 'rgba(255,255,255,0.5)', marginBottom: '3px' });
      card.appendChild(learningCurve);

      const valLine = document.createElement('div');
      const v = p.validation;
      const beats = v.policy.totalReturn > v.alwaysLong.totalReturn && v.policy.totalReturn > v.alwaysFlat.totalReturn;
      valLine.textContent = `Held-out validation return: policy ${(v.policy.totalReturn * 100).toFixed(2)}% (${(v.policy.winRate * 100).toFixed(0)}% win rate) vs always-long ${(v.alwaysLong.totalReturn * 100).toFixed(2)}% vs always-flat ${(v.alwaysFlat.totalReturn * 100).toFixed(2)}%`;
      Object.assign(valLine.style, { fontSize: '9px', fontWeight: '600', color: beats ? '#22cc88' : '#ff4477', marginBottom: '4px' });
      card.appendChild(valLine);

      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑 Delete';
      Object.assign(delBtn.style, { padding: '2px 6px', fontSize: '8px', border: '1px solid rgba(255,68,119,0.3)', borderRadius: '3px', background: 'rgba(255,68,119,0.1)', color: '#ff4477', cursor: 'pointer' });
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        try { await deleteRlPolicy(p.id, chartCtx.baseUrl); await refreshPoliciesList(); } catch (e: any) { delBtn.textContent = 'Failed'; }
      };
      card.appendChild(delBtn);

      policiesListDiv.appendChild(card);
    }
  }

  trainMlBtn.onclick = async () => {
    trainMlBtn.disabled = true;
    trainMlBtn.textContent = 'Training...';
    mlStatus.style.color = 'rgba(255,255,255,0.4)';
    try {
      mlStatus.textContent = 'Resolving historical bars...';
      const config = currentDataConfig();
      const { raw, label: dataLabel } = await resolveBacktestBars(config, chartCtx);
      const bars = barsToRuntimeBarData(raw);
      mlStatus.textContent = `Training on ${dataLabel}...`;
      const meta = await trainMlModel({
        bars, horizon: Math.max(1, parseInt(horizonInput.value, 10) || 3),
        targetType: targetTypeSelect.value as 'direction' | 'return',
        modelType: modelTypeSelect.value as 'gbm' | 'mlp' | 'logistic' | 'lstm',
        trainPct: Math.max(0.5, Math.min(0.9, (parseInt(mlTrainPctInput.value, 10) || 70) / 100)),
        symbol: config.symbol, timeframe: config.timeframe, baseUrl: chartCtx.baseUrl,
      });
      mlStatus.textContent = `Trained ${meta.id} — copy its id into ml.predict("${meta.id}")`;
      mlStatus.style.color = '#22cc88';
      await refreshModelsList();
    } catch (e: any) {
      mlStatus.textContent = `Training failed: ${e?.message || e}`;
      mlStatus.style.color = '#ff4477';
    } finally {
      trainMlBtn.disabled = false;
      trainMlBtn.textContent = '▶ Train ML Model';
    }
  };

  trainRlBtn.onclick = async () => {
    trainRlBtn.disabled = true;
    trainRlBtn.textContent = 'Training...';
    rlStatus.style.color = 'rgba(255,255,255,0.4)';
    try {
      rlStatus.textContent = 'Resolving historical bars...';
      const config = currentDataConfig();
      const { raw, label: dataLabel } = await resolveBacktestBars(config, chartCtx);
      const bars = barsToRuntimeBarData(raw);
      const algo = algorithmSelect.value as 'tabular' | 'dqn';
      const slowNote = algo === 'dqn' && deviceInfo?.device !== 'cuda' ? ' — real backprop on CPU, this may take a while' : '';
      rlStatus.textContent = `Training on ${dataLabel} (${episodesInput.value} episodes${slowNote})...`;
      const meta = await trainRlPolicy({
        bars, episodes: Math.max(20, Math.min(2000, parseInt(episodesInput.value, 10) || 150)),
        trainPct: Math.max(0.5, Math.min(0.9, (parseInt(rlTrainPctInput.value, 10) || 70) / 100)),
        symbol: config.symbol, timeframe: config.timeframe, baseUrl: chartCtx.baseUrl,
        algorithm: algo,
      });
      rlStatus.textContent = `Trained ${meta.id} — copy its id into rl.action("${meta.id}")`;
      rlStatus.style.color = '#22cc88';
      await refreshPoliciesList();
    } catch (e: any) {
      rlStatus.textContent = `Training failed: ${e?.message || e}`;
      rlStatus.style.color = '#ff4477';
    } finally {
      trainRlBtn.disabled = false;
      trainRlBtn.textContent = '▶ Train RL Policy';
    }
  };

  mlLabPanel.appendChild(modelsListDiv);
  mlLabPanel.appendChild(policiesListDiv);
  refreshModelsList();
  refreshPoliciesList();
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
    card.className = 'dafe-glow-window';
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
