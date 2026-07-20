/**
 * IndicatorManager — Supports multiple simultaneous OakScript indicators.
 * Each indicator gets its own instance with separate inputs, overrides, and results.
 */
import { parse, ParseError } from './oakscript/parser';
import { executeScript } from './oakscript/interpreter';
import type { OakPlot, OakAlert } from './oakscript/runtime';
import type { Program } from './oakscript/ast';
import { getIndicators, type IndicatorDef } from './oakscript/indicators';
import { getStoredOverrides, type InputDef } from './oakscript/editor';

export interface IndicatorInstance {
  id: string;
  name: string;
  category: string;
  source: string;
  plots: OakPlot[];
  errors: string[];
  inputs: InputDef[];
  alerts: OakAlert[];
  overrides: Map<string, any>;
  enabled: boolean;
  // Mandatory per-indicator toggle: whether this script's metrics appear on
  // the universal dashboard. Injected by the manager for EVERY script (not
  // declared in source), persisted per indicator name.
  showInDashboard: boolean;
}

// Dashboard visibility persistence — set of indicator NAMES the user hid.
const DASH_HIDDEN_KEY = 'dafe_dash_hidden_indicators';

function loadDashHidden(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DASH_HIDDEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

function saveDashHidden(hidden: Set<string>): void {
  try { localStorage.setItem(DASH_HIDDEN_KEY, JSON.stringify([...hidden])); } catch {}
}

let instances = new Map<string, IndicatorInstance>();
let instanceOrder: string[] = [];
let nextId = 1;

function detectInputsFromSource(source: string): InputDef[] {
  try {
    const ast = parse(source);
    const inputs: InputDef[] = [];
    for (const stmt of ast.statements) {
      if (stmt.type === 'VarDecl' || stmt.type === 'ExpressionStmt') {
        type ASTNode = any;
        let expr: ASTNode = null;
        if (stmt.type === 'VarDecl') {
          if ((stmt as any).value?.type === 'CallExpr') {
            expr = (stmt as any).value;
          }
        } else if ((stmt as any).expression?.type === 'Assignment') {
          const assign = (stmt as any).expression;
          if (assign.value?.type === 'CallExpr') {
            expr = assign.value;
          }
        }
        if (expr && expr.callee?.type === 'Identifier' && expr.callee.name === 'input') {
          const def = expr.args[0] ? evalLit(expr.args[0]) : 0;
          const title = expr.args[1]?.type === 'StringLiteral' ? expr.args[1].value : (stmt.type === 'VarDecl' ? (stmt as any).name : '');
          const type = typeof def === 'boolean' ? 'boolean' : typeof def === 'number' ? 'number' : 'string';
          const varName = stmt.type === 'VarDecl' ? (stmt as any).name : ((stmt as any).expression?.target?.name || '');
          const out: InputDef = { name: varName, title, defaultValue: def, type };
          if (type === 'number') {
            out.min = expr.args[2]?.type === 'NumberLiteral' ? expr.args[2].value : undefined;
            out.max = expr.args[3]?.type === 'NumberLiteral' ? expr.args[3].value : undefined;
            out.step = expr.args[4]?.type === 'NumberLiteral' ? expr.args[4].value : undefined;
          }
          inputs.push(out);
        }
      }
    }
    return inputs;
  } catch {
    return [];
  }
}

function evalLit(node: any): any {
  if (node.type === 'NumberLiteral') return node.value;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'BooleanLiteral') return node.value;
  return 0;
}

export function addIndicator(indDef: IndicatorDef): IndicatorInstance {
  const id = `ind_${nextId++}`;
  const instance: IndicatorInstance = {
    id,
    name: indDef.name,
    category: indDef.category,
    source: indDef.source,
    plots: [],
    errors: [],
    inputs: detectInputsFromSource(indDef.source),
    alerts: [],
    overrides: new Map<string, any>(),
    enabled: true,
    showInDashboard: !loadDashHidden().has(indDef.name),
  };
  instances.set(id, instance);
  instanceOrder.push(id);
  return instance;
}

/** Toggle whether an instance's metrics appear on the universal dashboard.
 * Persisted by indicator name so the choice survives reloads. */
export function setInstanceDashboardVisible(id: string, visible: boolean): void {
  const inst = instances.get(id);
  if (!inst) return;
  inst.showInDashboard = visible;
  const hidden = loadDashHidden();
  if (visible) hidden.delete(inst.name); else hidden.add(inst.name);
  saveDashHidden(hidden);
}

export function removeIndicator(id: string): void {
  instances.delete(id);
  instanceOrder = instanceOrder.filter(i => i !== id);
}

/** Update an instance's source AND re-detect its inputs. Editing a script
 * (e.g. adding an input()) previously left inst.inputs stale, so the inputs
 * panel showed nothing for freshly-added parameters. */
export function updateInstanceSource(id: string, source: string): IndicatorInstance | undefined {
  const inst = instances.get(id);
  if (!inst) return undefined;
  inst.source = source;
  inst.inputs = detectInputsFromSource(source);
  return inst;
}

export function getInstance(id: string): IndicatorInstance | undefined {
  return instances.get(id);
}

export function getActiveInstances(): IndicatorInstance[] {
  return instanceOrder.map(i => instances.get(i)!).filter(Boolean);
}

export function setInstanceOverrides(id: string, overrides: Map<string, any>): void {
  const inst = instances.get(id);
  if (inst) inst.overrides = overrides;
}

export function setInstanceEnabled(id: string, enabled: boolean): void {
  const inst = instances.get(id);
  if (inst) inst.enabled = enabled;
}

export function runAllInstances(barData: {
  close: number[]; open: number[]; high: number[];
  low: number[]; volume: number[]; time: number[];
}, imageAssets?: Map<string, string>): void {
  for (const id of instanceOrder) {
    const inst = instances.get(id);
    if (!inst || !inst.enabled) continue;
    try {
      const ast = parse(inst.source);
      const persist = new Map<string, any>();
      const result = executeScript(ast, {
        close: barData.close,
        open: barData.open,
        high: barData.high,
        low: barData.low,
        volume: barData.volume,
        time: barData.time,
        count: barData.close.length,
      }, persist, inst.overrides.size > 0 ? inst.overrides : undefined, imageAssets);
      inst.plots = result.plots;
      inst.errors = result.errors;
      inst.alerts = result.alerts;
    } catch (e: any) {
      inst.errors = [e instanceof ParseError ? e.message : String(e)];
      inst.plots = [];
    }
  }
}

export function getCombinedPlots(): { main: OakPlot[]; sep: OakPlot[]; plot3d: any[] } {
  const main: OakPlot[] = [];
  const sep: OakPlot[] = [];
  const plot3d: any[] = [];
  for (const id of instanceOrder) {
    const inst = instances.get(id);
    if (!inst || !inst.enabled) continue;
    for (const p of inst.plots) {
      if (p.type === 'plot3d') {
        plot3d.push(p);
      } else if (p.pane === 'separate') {
        sep.push(p);
      } else {
        main.push(p);
      }
    }
  }
  return { main, sep, plot3d };
}

export function hasActiveIndicators(): boolean {
  return getActiveInstances().some(i => i.enabled);
}

export function clearAll(): void {
  instances = new Map();
  instanceOrder = [];
  nextId = 1;
}
