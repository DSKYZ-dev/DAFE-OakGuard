/**
 * IndicatorManager — Supports multiple simultaneous OakScript indicators.
 * Each indicator gets its own instance with separate inputs, overrides, and results.
 */
import { parse, ParseError } from './oakscript/parser';
import { executeScript } from './oakscript/interpreter';
import type { OakPlot, OakAlert } from './oakscript/runtime';
import type { Program } from './oakscript/ast';
import { getIndicators, type IndicatorDef } from './oakscript/indicators';
import { getStoredOverrides, sendAlert, type InputDef } from './oakscript/editor';
import { extractSignals, emitLiveSignal } from './signal-engine';

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
  // Blast-Radius Isolation: set when the circuit breaker below turned this
  // OFF itself (repeated runtime failures, or repeated slow-enough-to-
  // freeze-the-UI executions) — distinct from the user unchecking it, so
  // the UI can show *why* it's off instead of looking identical to a
  // manual disable.
  autoDisabledReason: string | null;
  // Per-model auto-execution arming (Active Signal Models list toggle).
  // Gates whether THIS instance's live signals reach the paper auto-trader
  // — the Trading panel's master switch is a second, independent gate (both
  // must be on). Deliberately session-only, never persisted, and reset to
  // false whenever the source changes (see updateInstanceSource) — the
  // same "a changed script needs a fresh explicit decision" rule the
  // circuit breaker already follows, so editing a script can never leave
  // auto-trading silently armed on unreviewed code.
  autoTradeArmed: boolean;
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
    autoDisabledReason: null,
    autoTradeArmed: false,
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
  lastForwardedAlertCount.delete(id);
  lastForwardedSignalCount.delete(id);
  circuitState.delete(id);
}

/** Update an instance's source AND re-detect its inputs. Editing a script
 * (e.g. adding an input()) previously left inst.inputs stale, so the inputs
 * panel showed nothing for freshly-added parameters. */
export function updateInstanceSource(id: string, source: string): IndicatorInstance | undefined {
  const inst = instances.get(id);
  if (!inst) return undefined;
  inst.source = source;
  inst.inputs = detectInputsFromSource(source);
  // A different script deserves a fresh circuit-breaker verdict, not one
  // carried over from whatever the PREVIOUS version of this source did.
  circuitState.delete(id);
  inst.autoDisabledReason = null;
  // Same reasoning for the signal stream: the next evaluation of a CHANGED
  // script re-backfills (no live emission) instead of diffing its signal
  // count against an unrelated previous script's history.
  lastForwardedSignalCount.delete(id);
  // And for auto-trade arming: edited code is unreviewed code — never let
  // it inherit the previous version's "armed" state.
  inst.autoTradeArmed = false;
  return inst;
}

export function getInstance(id: string): IndicatorInstance | undefined {
  return instances.get(id);
}

export function getActiveInstances(): IndicatorInstance[] {
  return instanceOrder.map(i => instances.get(i)!).filter(Boolean);
}

/** True while a library model with this name is on the chart (one instance per model). */
export function isIndicatorNameActive(name: string): boolean {
  for (const inst of instances.values()) if (inst.name === name) return true;
  return false;
}

export function setInstanceOverrides(id: string, overrides: Map<string, any>): void {
  const inst = instances.get(id);
  if (inst) inst.overrides = overrides;
}

/** Arms/disarms this instance's signals for the paper auto-trader. The
 * Trading panel's master switch is a second, independent gate — both
 * must be on for a signal to actually execute. */
export function setInstanceAutoTradeArmed(id: string, armed: boolean): void {
  const inst = instances.get(id);
  if (inst) inst.autoTradeArmed = armed;
}

export function setInstanceEnabled(id: string, enabled: boolean): void {
  const inst = instances.get(id);
  if (!inst) return;
  inst.enabled = enabled;
  // A user re-enabling a previously auto-disabled instance is explicitly
  // asking to give it another chance — don't count last time's strikes
  // against it immediately, or it would just trip again on frame one with
  // no opportunity to actually run.
  if (enabled) {
    circuitState.delete(id);
    inst.autoDisabledReason = null;
  }
}

// ─── Blast-Radius Isolation ─────────────────────────────────────────
// One indicator's script is user-authored and can be arbitrarily broken or
// slow; runAllInstances()'s existing per-instance try/catch already stops a
// thrown error from corrupting OTHER instances' state, but nothing
// previously stopped a script that fails or runs slowly EVERY frame from
// doing so forever, burning CPU and — for a slow-but-not-throwing script —
// blocking the main render loop repeatedly. This circuit breaker auto-
// disables an instance after a short run of consecutive strikes, rather
// than a full per-indicator Worker sandbox (a much larger rendering-
// pipeline change this pass's "verify it to 100%" bar doesn't support).
const MAX_CONSECUTIVE_RUNTIME_FAILURES = 3;
const MAX_CONSECUTIVE_SLOW_RUNS = 3;
// Already well past disruptive for a script re-run every render frame —
// deliberately far below the interpreter's own MAX_EXECUTION_WALL_MS
// (20s) hard-abort, which exists to bound worst-case runaway time, not to
// define "fine for a per-frame loop."
const SLOW_EXECUTION_MS = 500;

interface CircuitState {
  consecutiveRuntimeFailures: number;
  consecutiveSlowRuns: number;
}
const circuitState = new Map<string, CircuitState>();

// executeScript() re-runs the FULL bar range every call (this function runs
// every render frame), so result.alerts is the complete list from bar 0
// every time, not just newly-fired ones — the array only ever grows as more
// bars arrive, so a per-instance "how many have we already forwarded"
// cursor is enough to notify/log each alert exactly once instead of
// re-firing every alert on every single frame. Known v1 edge case: if the
// user changes this instance's input overrides, the recomputed alert list
// can differ in content at the same index (a threshold moved, so different
// bars now qualify) — the count-based cursor can't detect that and may
// re-forward or skip a handful of alerts right at that boundary. Rare
// (requires editing inputs on a script that also alerts) and never worse
// than the pre-existing behavior of forwarding nothing at all.
const lastForwardedAlertCount = new Map<string, number>();
// Per-instance count of signals already seen (Signal Engine live edge) —
// same newness model as alert forwarding: count-based, first run backfills.
const lastForwardedSignalCount = new Map<string, number>();
// undefined (not just 0) marks "never seen this instance" so the very
// first run — which can already contain hundreds of historical alerts,
// since executeScript() processes the full bar range in one pass — records
// them into Alert History without firing a browser Notification/webhook
// POST per bar. Only alerts from the SECOND run onward (i.e. genuinely new
// since the user started watching this instance) get the full sendAlert()
// side effects.

function tripCircuitBreaker(inst: IndicatorInstance, reason: string): void {
  inst.enabled = false;
  inst.autoDisabledReason = reason;
  inst.errors = [reason];
  inst.plots = [];
}

export function runAllInstances(barData: {
  close: number[]; open: number[]; high: number[];
  low: number[]; volume: number[]; time: number[];
}, imageAssets?: Map<string, string>): void {
  for (const id of instanceOrder) {
    const inst = instances.get(id);
    if (!inst || !inst.enabled) continue;
    const state = circuitState.get(id) ?? { consecutiveRuntimeFailures: 0, consecutiveSlowRuns: 0 };

    const startedAt = performance.now();
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

      const prevCount = lastForwardedAlertCount.get(id);
      if (prevCount === undefined) {
        for (const alert of result.alerts) sendAlert(alert, false);
      } else {
        for (let i = prevCount; i < result.alerts.length; i++) sendAlert(result.alerts[i]);
      }
      lastForwardedAlertCount.set(id, result.alerts.length);

      // ── Signal Engine live edge ──
      // Same first-run-backfill discipline as alert forwarding above: the
      // first evaluation of an instance yields the FULL historical signal
      // stream (hundreds of entries/exits) — record the count, emit nothing.
      // Only signals appearing in later evaluations are genuinely live and
      // reach subscribed consumers (the paper auto-trader).
      const { signals } = extractSignals({ plots: result.plots, strategyOrders: result.strategyOrders });
      const prevSignals = lastForwardedSignalCount.get(id);
      if (prevSignals !== undefined) {
        for (let i = prevSignals; i < signals.length; i++) {
          emitLiveSignal({ instanceId: id, indicatorName: inst.name, signal: signals[i] });
        }
      }
      lastForwardedSignalCount.set(id, signals.length);

      // executeScript() has its OWN per-bar try/catch (see interpreter.ts)
      // that recovers from most runtime errors — including hitting
      // MAX_LOOP_STEPS_PER_BAR, the most likely "blast radius" case — by
      // recording them into result.errors and continuing to the next bar,
      // rather than throwing. Only a parse failure or the rarer 20s wall-
      // clock backstop actually reach this function's catch block below, so
      // a non-empty result.errors on an otherwise-successful return counts
      // as a strike here too, or the circuit breaker would never see the
      // most common failure shape at all.
      let tripped = false;
      if (result.errors.length > 0) {
        state.consecutiveRuntimeFailures++;
        if (state.consecutiveRuntimeFailures >= MAX_CONSECUTIVE_RUNTIME_FAILURES) {
          tripCircuitBreaker(inst, `Auto-disabled after ${state.consecutiveRuntimeFailures} consecutive runs with errors: ${result.errors[0]}`);
          tripped = true;
        }
      } else {
        state.consecutiveRuntimeFailures = 0;
      }

      // Slowness is tracked independently of success/failure: a script can
      // throw (or error-and-recover) fast, or succeed cleanly but slowly —
      // both matter, but for different reasons, so neither resets the other.
      // Skipped once already tripped above so its (less specific) message
      // can't overwrite the real reason for the same frame's trip.
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs > SLOW_EXECUTION_MS) {
        state.consecutiveSlowRuns++;
        if (!tripped && state.consecutiveSlowRuns >= MAX_CONSECUTIVE_SLOW_RUNS) {
          tripCircuitBreaker(inst, `Auto-disabled: took over ${SLOW_EXECUTION_MS}ms to run ${state.consecutiveSlowRuns} times in a row, which would keep blocking the chart's render loop.`);
        }
      } else {
        state.consecutiveSlowRuns = 0;
      }
    } catch (e: any) {
      const isParseError = e instanceof ParseError;
      const msg = isParseError ? e.message : String(e?.message ?? e);
      inst.errors = [msg];
      inst.plots = [];
      // A parse error means the SOURCE TEXT is malformed — cheap to detect
      // (fails before any script logic runs) and won't resolve itself by
      // retrying, only by the user editing the script (which already resets
      // this state via updateInstanceSource). Not a "blast radius" concern
      // the same way a runtime failure or a slow-but-valid script is, so it
      // doesn't count toward the trip threshold.
      if (!isParseError) {
        state.consecutiveRuntimeFailures++;
        state.consecutiveSlowRuns = 0;
        if (state.consecutiveRuntimeFailures >= MAX_CONSECUTIVE_RUNTIME_FAILURES) {
          tripCircuitBreaker(inst, `Auto-disabled after ${state.consecutiveRuntimeFailures} consecutive execution failures: ${msg}`);
        }
      }
    }
    circuitState.set(id, state);
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
