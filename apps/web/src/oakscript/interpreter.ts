import type { Program, ASTNode } from './ast';
import type { Identifier, NumberLiteral, StringLiteral, BooleanLiteral, ArrayLiteral, NilLiteral } from './ast';
import type { BinaryExpr, UnaryExpr, TernaryExpr, CallExpr, IndexExpr, MemberExpr } from './ast';
import type { VarDecl, Assignment, IfStatement, ForStatement, WhileStatement, ReturnStmt, ExpressionStmt, FunctionDecl } from './ast';
import type { OakPlot, OakAlert, OakTableCell, OakStrategyOrder } from './runtime';
import { StdLib } from './runtime';

// Recognized plot() render styles (used to disambiguate the 5th positional arg).
const PLOT_STYLES = new Set(['line', 'stepline', 'area', 'histogram', 'columns', 'circles', 'cross']);

// Parse "#rgb" / "#rrggbb" into an [r,g,b] tuple (0..255). Falls back to a
// neutral violet for already-rgba()/named inputs so color.new() never throws.
function hexToRgbTuple(hex: string): [number, number, number] {
  const h = (hex || '').trim();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(h);
  if (m3) return [parseInt(m3[1] + m3[1], 16), parseInt(m3[2] + m3[2], 16), parseInt(m3[3] + m3[3], 16)];
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(h);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return [180, 140, 255];
}

// ─── Drawing-object shared helpers ──────────────────────────────────
// Generalizes hline()'s dedup+rolling-cap pattern (see the 'hline' case
// below) across every persistent drawing-object type. There is no
// Pine-style handle/mutate system here — the whole script re-runs once per
// bar sharing one flat ctx.plots array — so "same id -> mutate in place,
// different id -> push + rolling-cap the type" is the substitute.

// Per-type cap on live objects before the OLDEST is evicted.
const OBJECT_CAPS: Record<string, number> = {
  line_obj: 30,
  box_obj: 30,
  circle_obj: 30,
  arrow_obj: 30,
  polyline_obj: 20,
  linefill_obj: 20,
  image_obj: 20,
  table: 6,
  label: 40,
};

// Same-key upsert: a repeat call with the same (type, id) mutates the
// existing OakPlot in place (Object.assign) instead of stacking a new plot
// every bar/firing. A brand-new id pushes a fresh OakPlot, registers it in
// ctx.objectSeen/ctx.objectOrder, and evicts the OLDEST id for that type
// once OBJECT_CAPS[type] is exceeded (spliced out of ctx.plots too) — same
// eviction behavior as hline()'s 24-line cap, generalized.
function upsertObject(ctx: RuntimeContext, type: string, id: string, fields: Partial<OakPlot>): OakPlot {
  const key = `${type}|${id}`;
  const existing = ctx.objectSeen.get(key);
  if (existing) {
    Object.assign(existing, fields);
    return existing;
  }
  const plot: OakPlot = { type: type as OakPlot['type'], name: '', id, ...fields };
  ctx.plots.push(plot);
  ctx.objectSeen.set(key, plot);
  let order = ctx.objectOrder.get(type);
  if (!order) { order = []; ctx.objectOrder.set(type, order); }
  order.push(id);
  const cap = OBJECT_CAPS[type] ?? 30;
  if (order.length > cap) {
    const oldestId = order.shift()!;
    const oldestKey = `${type}|${oldestId}`;
    const oldestPlot = ctx.objectSeen.get(oldestKey);
    if (oldestPlot) {
      const idx = ctx.plots.indexOf(oldestPlot);
      if (idx >= 0) ctx.plots.splice(idx, 1);
    }
    ctx.objectSeen.delete(oldestKey);
  }
  return plot;
}

// Explicit removal by (type, id) — shared by line.delete/box.delete: splices
// the OakPlot out of ctx.plots and cleans both objectSeen and objectOrder so
// a later new object of the same type doesn't inherit a phantom eviction slot.
function deleteObjectById(ctx: RuntimeContext, type: string, id: string): void {
  const key = `${type}|${id}`;
  const plot = ctx.objectSeen.get(key);
  if (!plot) return;
  const idx = ctx.plots.indexOf(plot);
  if (idx >= 0) ctx.plots.splice(idx, 1);
  ctx.objectSeen.delete(key);
  const order = ctx.objectOrder.get(type);
  if (order) {
    const oi = order.indexOf(id);
    if (oi >= 0) order.splice(oi, 1);
  }
}

// Explicit id if a non-empty string was passed, else one auto id per firing
// bar (`${prefix}:auto:${barIndex}`) — an unconditional top-level call
// re-fires this every bar (dedup/mutate via upsertObject keeps it to one
// object), a conditional call gets a fresh identity each firing bar.
function autoId(ctx: RuntimeContext, explicitArg: RuntimeValue, prefix: string): string {
  if (typeof explicitArg === 'string' && explicitArg.length > 0) return explicitArg;
  return `${prefix}:auto:${ctx.barIndex}`;
}

// "Explain This Signal" — a deterministic snapshot of the script's own
// scalar variables at the bar an alert fires, so a fired alert carries its
// own evidence (no LLM, no re-running the script to reconstruct it later).
// Only number/string/boolean vars are captured — arrays (series/OakRing)
// and plot/object values aren't meaningful in a compact "why did this fire"
// readout and would bloat every single alert. Capped at the first
// MAX_PROVENANCE_VARS in ctx.vars's Map iteration order (== declaration
// order for this language), which tends to surface inputs/top-level
// indicator values before deep helper-function locals.
const MAX_PROVENANCE_VARS = 30;
function captureProvenance(ctx: RuntimeContext): Record<string, number | string | boolean> {
  const snapshot: Record<string, number | string | boolean> = {};
  let count = 0;
  for (const [name, value] of ctx.vars) {
    if (count >= MAX_PROVENANCE_VARS) break;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      snapshot[name] = value;
      count++;
    }
  }
  return snapshot;
}

// ─── OakRing — fixed-size circular buffer ──────────────────────────
function createOakRing(capacity: number): any {
  const data: number[] = [];
  let count = 0;
  let head = 0;
  const ring: any = { _type: 'OakRing', size: 0, capacity };

  function _getSlot(i: number): number {
    if (count === 0 || i < 0 || i >= count) return -1;
    return (head + i) % capacity;
  }

  ring.push = (val: number) => {
    const n = typeof val === 'number' ? val : 0;
    if (count < capacity) { data.push(n); count++; }
    else { data[head] = n; head = (head + 1) % capacity; }
    ring.size = count;
    return null;
  };

  ring.pop = () => {
    if (count === 0) return null;
    const idx = _getSlot(count - 1);
    if (idx < 0) return null;
    const v = data[idx]; count--;
    ring.size = count;
    if (count === 0) head = 0;
    return v;
  };

  ring.first = () => count === 0 ? null : data[_getSlot(0)] ?? null;
  ring.last = () => count === 0 ? null : data[_getSlot(count - 1)] ?? null;
  ring.clear = () => { data.length = 0; count = 0; head = 0; ring.size = 0; return null; };
  ring.toArray = () => { const r: number[] = []; for (let i = 0; i < count; i++) r.push(data[_getSlot(i)]); return r; };

  const _nums = () => { const r: number[] = []; for (let i = 0; i < count; i++) { const v = data[_getSlot(i)]; if (typeof v === 'number') r.push(v); } return r; };

  ring.sum = () => { let s = 0; for (let i = 0; i < count; i++) s += data[_getSlot(i)]; return s; };
  ring.avg = () => count === 0 ? 0 : ring.sum() / count;
  ring.min = () => count === 0 ? null : Math.min(..._nums());
  ring.max = () => count === 0 ? null : Math.max(..._nums());

  ring.std = () => {
    const n = _nums();
    if (n.length < 2) return 0;
    const m = n.reduce((s, v) => s + v, 0) / n.length;
    return Math.sqrt(n.reduce((s, v) => s + (v - m) ** 2, 0) / n.length);
  };

  ring.median = () => {
    const n = _nums().sort((a: number, b: number) => a - b);
    if (n.length === 0) return null;
    const mid = Math.floor(n.length / 2);
    return n.length % 2 === 0 ? (n[mid - 1] + n[mid]) / 2 : n[mid];
  };

  ring.percentile = (pct: number) => {
    const n = _nums().sort((a: number, b: number) => a - b);
    if (n.length === 0) return null;
    const p = Math.max(0, Math.min(100, typeof pct === 'number' ? pct : 50));
    const idx = (p / 100) * (n.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return n[lo];
    return n[lo] + (n[hi] - n[lo]) * (idx - lo);
  };

  ring.fill = (val: number) => { const n = typeof val === 'number' ? val : 0; for (let i = 0; i < capacity; i++) data[i] = n; if (count < capacity) count = capacity; ring.size = count; return null; };

  return ring;
}

// ─── Matrix — 2D numeric matrix ────────────────────────────────────
function createMatrix(rows: number, cols: number, initialVal = 0): any {
  const data: number[][] = [];
  for (let r = 0; r < rows; r++) { const row: number[] = []; for (let c = 0; c < cols; c++) row.push(initialVal); data.push(row); }
  const mat: any = { _type: 'Matrix', rows, cols, _data: data };

  mat.get = (r: number, c: number) => (data[r] ? data[r][c] : 0) ?? 0;
  mat.set = (r: number, c: number, val: number) => { if (data[r]) data[r][c] = typeof val === 'number' ? val : 0; return null; };
  mat.row = (r: number) => (data[r] ? [...data[r]] : []);
  mat.col = (c: number) => data.map(r => r[c] ?? 0);

  mat.sum = () => { let s = 0; for (const r of data) for (const v of r) s += v; return s; };

  mat.transpose = () => {
    const r = createMatrix(cols, rows);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) r._data[j][i] = data[i][j];
    return r;
  };

  mat.multiply = (other: any) => {
    if (!other || other._type !== 'Matrix' || cols !== other.rows) return null;
    const r = createMatrix(rows, other.cols);
    for (let i = 0; i < rows; i++) for (let j = 0; j < other.cols; j++) { let s = 0; for (let k = 0; k < cols; k++) s += data[i][k] * other._data[k][j]; r._data[i][j] = s; }
    return r;
  };

  mat.add = (other: any) => {
    if (!other || other._type !== 'Matrix' || rows !== other.rows || cols !== other.cols) return null;
    const r = createMatrix(rows, cols);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) r._data[i][j] = data[i][j] + other._data[i][j];
    return r;
  };

  mat.subtract = (other: any) => {
    if (!other || other._type !== 'Matrix' || rows !== other.rows || cols !== other.cols) return null;
    const r = createMatrix(rows, cols);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) r._data[i][j] = data[i][j] - other._data[i][j];
    return r;
  };

  mat.toArray = () => data.map(r => [...r]);
  return mat;
}

// ─── Array numeric helpers ─────────────────────────────────────────
function _numericValues(arr: any[]): number[] {
  return arr.filter((v: any) => typeof v === 'number') as number[];
}

export type RuntimeValue =
  | number | string | boolean | null
  | RuntimeValue[] | { [key: string]: RuntimeValue }
  | OakPlot;

export interface RuntimeContext {
  vars: Map<string, RuntimeValue>;
  persist: Map<string, RuntimeValue>;
  bars: RuntimeBarData;
  plots: OakPlot[];
  alerts: OakAlert[];
  // Shared per-execution: strategy.entry/strategy.exit order events emitted
  // by the script, consumed by the backtest engine's execution-replay pass
  // (apps/web/src/backtest/engine.ts). Empty for every non-backtest caller.
  strategyOrders: OakStrategyOrder[];
  barIndex: number;
  returnValue: RuntimeValue | null;
  breakFlag: boolean;
  continueFlag: boolean;
  arrayCache: Map<string, RuntimeValue[]>;
  inputOverrides?: Map<string, RuntimeValue>;
  seriesHistory: Map<ASTNode, number[]>;
  seriesByName: Map<string, number[]>;
  cache: Map<string, any>;
  loopSteps: number;
  // Shared per-execution: dedupes hline() calls. The script runs once per
  // bar, so a top-level hline is reached ~500 times per execution and a
  // conditional one fires for every historical trigger — without dedup each
  // call stacked another permanent line on the chart ("fib lines multiply").
  hlineSeen: Set<string>;
  // Shared per-execution: drawing-object dedup/mutation state (line.new,
  // box.new, table.new, etc.) — same-key upsert generalizes the hlineSeen
  // pattern above. objectSeen key = `${type}|${id}`; objectOrder tracks
  // insertion order per type for rolling-cap eviction (oldest id first).
  objectSeen: Map<string, OakPlot>;
  objectOrder: Map<string, string[]>;
  // Optional name -> data-URL map for image.new/plotimage/plotimage_3d
  // source resolution, threaded in from the caller (indicator-manager.ts /
  // editor.ts). Omitted entirely when the caller doesn't pass one.
  imageAssets?: Map<string, string>;
  // Shared per-execution: user-defined functions (f(x) => ...).
  userFuncs: Map<string, FunctionDecl>;
  // Recursion guard for user-function calls.
  callDepth: number;
  // Consensus Gate: named boolean votes registered via consensus.vote(...)
  // on THIS bar. Deliberately per-bar, not per-execution — ctx itself is
  // rebuilt fresh for every bar (see the bar loop below), so this resets
  // automatically each bar with no separate cleanup needed.
  consensusVotes: Map<string, boolean>;
}

// Per-bar cap on while/for loop iterations. A buggy or pathological script
// (infinite condition, mis-scoped loop variable, etc.) would otherwise hang
// the single JS thread forever and freeze the browser tab — there is no
// other backstop. 200k is far beyond any legitimate per-bar loop workload.
const MAX_LOOP_STEPS_PER_BAR = 200_000;

// Wall-clock backstop across the *whole* run (orthogonal to the per-bar loop
// cap above). A script that's merely slow per-bar rather than infinite-
// looping within one bar can still take unbounded total time across a
// multi-thousand-bar backtest — this bounds that. Checked every N bars
// rather than every bar to keep performance.now() overhead negligible.
const MAX_EXECUTION_WALL_MS = 20_000;
const DEADLINE_CHECK_INTERVAL_BARS = 100;

export interface RuntimeBarData {
  close: number[];
  open: number[];
  high: number[];
  low: number[];
  volume: number[];
  time: number[];
  count: number;
}

export interface PlotResult {
  plots: OakPlot[];
  alerts: OakAlert[];
  strategyOrders: OakStrategyOrder[];
  persist: Map<string, RuntimeValue>;
  errors: string[];
}

export function executeScript(program: Program, barData: RuntimeBarData, persist: Map<string, RuntimeValue>, inputOverrides?: Map<string, RuntimeValue>, imageAssets?: Map<string, string>): PlotResult {
  const errors: string[] = [];
  const plots: OakPlot[] = [];
  const alerts: OakAlert[] = [];
  const strategyOrders: OakStrategyOrder[] = [];
  const allPersist = new Map(persist);
  const seriesHistory = new Map<ASTNode, number[]>();
  const cache = new Map<string, any>();
  const seriesByName = new Map<string, number[]>();
  const hlineSeen = new Set<string>();
  const objectSeen = new Map<string, OakPlot>();
  const objectOrder = new Map<string, string[]>();
  const userFuncs = new Map<string, FunctionDecl>();

  const executionStart = performance.now();

  // Execute bar by bar (PineScript execution model)
  for (let bi = 0; bi < barData.count; bi++) {
    // Wall-clock backstop: MAX_LOOP_STEPS_PER_BAR only bounds a single bar's
    // loop work (caught below by the per-bar try/catch, which lets the run
    // continue to the next bar). A script that's merely slow per-bar rather
    // than looping infinitely within one can still take unbounded total time
    // across a multi-thousand-bar backtest, so this check sits outside that
    // try/catch — an uncaught throw here aborts the whole run instead of
    // just the current bar. Existing callers already wrap executeScript() in
    // try/catch, so this needs no caller changes.
    if (bi > 0 && bi % DEADLINE_CHECK_INTERVAL_BARS === 0 && performance.now() - executionStart > MAX_EXECUTION_WALL_MS) {
      throw new Error(`OakScript execution exceeded ${MAX_EXECUTION_WALL_MS}ms wall-clock limit at bar ${bi}/${barData.count}`);
    }

    const ctx: RuntimeContext = {
      vars: new Map(),
      persist: allPersist,
      bars: barData,
      plots,
      alerts,
      strategyOrders,
      barIndex: bi,
      returnValue: null,
      breakFlag: false,
      continueFlag: false,
      arrayCache: new Map(),
      inputOverrides,
      seriesHistory,
      seriesByName,
      cache,
      loopSteps: 0,
      hlineSeen,
      objectSeen,
      objectOrder,
      imageAssets,
      userFuncs,
      callDepth: 0,
      consensusVotes: new Map(),
    };

    // Set built-in variables
    ctx.vars.set('close', barData.close[bi]);
    ctx.vars.set('open', barData.open[bi]);
    ctx.vars.set('high', barData.high[bi]);
    ctx.vars.set('low', barData.low[bi]);
    ctx.vars.set('volume', barData.volume[bi]);
    ctx.vars.set('time', barData.time[bi]);
    ctx.vars.set('bar_index', bi);

    try {
      for (const stmt of program.statements) {
        evaluateStatement(stmt, ctx);
        if (ctx.breakFlag || ctx.continueFlag || ctx.returnValue !== null) break;
      }
    } catch (e: any) {
      errors.push(`Bar ${bi}: ${e.message}`);
    }
  }

  return { plots, alerts, strategyOrders, persist: allPersist, errors };
}

function evaluateStatement(stmt: ASTNode, ctx: RuntimeContext): void {
  switch (stmt.type) {
    case 'VarDecl': return evaluateVarDecl(stmt as VarDecl, ctx);
    case 'FunctionDecl': ctx.userFuncs.set((stmt as FunctionDecl).name, stmt as FunctionDecl); return;
    case 'Assignment': evaluateAssignment(stmt as Assignment, ctx); return;
    case 'IfStatement': return evaluateIf(stmt as IfStatement, ctx);
    case 'ForStatement': return evaluateFor(stmt as ForStatement, ctx);
    case 'WhileStatement': return evaluateWhile(stmt as WhileStatement, ctx);
    case 'Break': ctx.breakFlag = true; return;
    case 'Continue': ctx.continueFlag = true; return;
    case 'Return': ctx.returnValue = stmt.value ? evaluateExpression(stmt.value, ctx) : null; return;
    case 'ExpressionStmt': evaluateExpression((stmt as ExpressionStmt).expression, ctx); return;
  }
}

/** Invoke a user-defined function (f(x) => ...). Params shadow globals for
 * the duration of the call and are restored after; the return value is the
 * explicit `return` expression or the value of the last expression
 * statement in the body. Control-flow state is saved/restored so a
 * function's `return` never halts the surrounding bar execution. */
function callUserFunction(decl: FunctionDecl, args: RuntimeValue[], ctx: RuntimeContext): RuntimeValue {
  if (ctx.callDepth >= 64) {
    throw new Error(`function '${decl.name}' recursed too deeply (max 64)`);
  }
  ctx.callDepth++;

  // Shadow params (remember what they hid).
  const shadowed = new Map<string, { had: boolean; value: RuntimeValue }>();
  for (let i = 0; i < decl.params.length; i++) {
    const p = decl.params[i];
    shadowed.set(p, { had: ctx.vars.has(p), value: ctx.vars.get(p) ?? null });
    ctx.vars.set(p, args[i] ?? null);
  }

  const prevReturn = ctx.returnValue;
  const prevBreak = ctx.breakFlag;
  const prevContinue = ctx.continueFlag;
  ctx.returnValue = null;
  ctx.breakFlag = false;
  ctx.continueFlag = false;

  let lastVal: RuntimeValue = null;
  try {
    for (const stmt of decl.body) {
      if (stmt.type === 'ExpressionStmt') {
        lastVal = evaluateExpression((stmt as ExpressionStmt).expression, ctx);
      } else {
        evaluateStatement(stmt, ctx);
      }
      if (ctx.returnValue !== null) { lastVal = ctx.returnValue; break; }
      if (ctx.breakFlag || ctx.continueFlag) break; // stray break/continue: stop the body
    }
  } finally {
    ctx.returnValue = prevReturn;
    ctx.breakFlag = prevBreak;
    ctx.continueFlag = prevContinue;
    for (const [p, prev] of shadowed) {
      if (prev.had) ctx.vars.set(p, prev.value);
      else ctx.vars.delete(p);
    }
    ctx.callDepth--;
  }
  return lastVal;
}

function evaluateVarDecl(stmt: VarDecl, ctx: RuntimeContext): void {
  let value: RuntimeValue = null;
  if (stmt.value.type !== 'NilLiteral') {
    value = evaluateExpression(stmt.value, ctx);
  }
  if (stmt.isVar || stmt.isVarip) {
    if (!ctx.persist.has(stmt.name)) {
      ctx.persist.set(stmt.name, value);
    }
    ctx.vars.set(stmt.name, ctx.persist.get(stmt.name)!);
  } else {
    ctx.vars.set(stmt.name, value);
  }
}

// Handles BOTH statement-level assignments (`k = input(8, ...)` as its own
// line) AND assignment-as-expression (evaluateExpression's 'Assignment'
// case, e.g. inside a for-loop update clause). These used to be two
// separate implementations — only this one checked ctx.inputOverrides — but
// the parser NEVER produces a bare top-level Assignment statement (a plain
// `x = input(...)` line always parses as ExpressionStmt{Assignment}, since
// parseStatement() has no case for it and falls through to
// parseExpressionStmt()), so evaluateStatement's override-aware 'Assignment'
// case was unreachable dead code and every plain input() declaration — i.e.
// virtually every input() in every indicator — silently ignored the user's
// panel/override values. Unified into one function so there's only one
// place this logic can drift out of sync.
function evaluateAssignment(stmt: Assignment, ctx: RuntimeContext): RuntimeValue {
  if (stmt.target.type === 'Identifier' && stmt.value.type === 'CallExpr') {
    const callee = (stmt.value as CallExpr).callee;
    if (callee.type === 'Identifier' && (callee as Identifier).name === 'input') {
      const name = (stmt.target as Identifier).name;
      if (ctx.inputOverrides?.has(name)) {
        const val = ctx.inputOverrides.get(name)!;
        ctx.vars.set(name, val);
        if (ctx.persist.has(name)) ctx.persist.set(name, val);
        return val;
      }
    }
    // For series functions (rsi, sma, ema, etc.), copy full cached result to seriesHistory
    // and store by variable name for index lookback support
    const fnName = (stmt.value as CallExpr).callee.type === 'Identifier'
      ? ((stmt.value as CallExpr).callee as Identifier).name : '';
    const callArgs = (stmt.value as CallExpr).args;
    if (fnName === 'security') {
      // security(timeframe, source) has the REVERSED shape vs. every other
      // series fn(source, length, ...) assumed below — source is args[1],
      // not args[0] — and its cache key is `security:${timeframe}:${srcName}`
      // (exact match, see the 'security' case in evaluateCall), not the
      // generic fnName:srcName:param prefix-search format. Without this,
      // htf[1]-style lookback on a `security()` result would silently
      // fall through to returning the current value instead of history.
      const tfNode = callArgs[0];
      const srcNode = callArgs[1];
      if (tfNode?.type === 'StringLiteral' && srcNode?.type === 'Identifier') {
        const cacheKey = `security:${(tfNode as StringLiteral).value}:${(srcNode as Identifier).name}`;
        const cached = ctx.cache.get(cacheKey);
        if (Array.isArray(cached)) {
          ctx.seriesHistory.set(stmt.target, cached);
          const varName = (stmt.target as Identifier).name;
          ctx.seriesByName.set(varName, cached);
        }
      }
    } else {
      const srcNode = callArgs[0];
      const p1 = typeof (callArgs[1]) === 'number' ? (callArgs[1]) : 0;
      if (srcNode?.type === 'Identifier' && fnName) {
        const cacheKey = `${fnName}:${(srcNode as Identifier).name}:${p1}`;
        for (const [k] of ctx.cache) {
          if (k.startsWith(cacheKey)) {
            const cached = ctx.cache.get(k);
            if (Array.isArray(cached)) {
              ctx.seriesHistory.set(stmt.target, cached);
              const varName = (stmt.target as Identifier).name;
              ctx.seriesByName.set(varName, cached);
            }
            break;
          }
        }
      }
    }
  }
  const value = evaluateExpression(stmt.value, ctx);
  return evaluateAssignmentTarget(stmt.target, value, ctx);
}

function evaluateIf(stmt: IfStatement, ctx: RuntimeContext): void {
  const cond = evaluateExpression(stmt.condition, ctx);
  if (isTruthy(cond, ctx)) {
    for (const s of stmt.body) { evaluateStatement(s, ctx); if (ctx.breakFlag || ctx.continueFlag || ctx.returnValue !== null) return; }
  } else {
    for (const s of stmt.elseBody) { evaluateStatement(s, ctx); if (ctx.breakFlag || ctx.continueFlag || ctx.returnValue !== null) return; }
  }
}

function evaluateFor(stmt: ForStatement, ctx: RuntimeContext): void {
  // for id in container
  if (stmt.forInContainer && stmt.forInIdx) {
    const container = evaluateExpression(stmt.forInContainer, ctx);
    if (Array.isArray(container)) {
      for (let i = 0; i < container.length; i++) {
        ctx.vars.set(stmt.forInIdx, container[i]);
        if (ctx.persist.has(stmt.forInIdx)) ctx.persist.set(stmt.forInIdx, container[i]);
        for (const s of stmt.body) {
          evaluateStatement(s, ctx);
          if (ctx.breakFlag) { ctx.breakFlag = false; return; }
          if (ctx.continueFlag) { ctx.continueFlag = false; break; }
          if (ctx.returnValue !== null) return;
        }
      }
    }
    return;
  }

  // Standard for loop
  if (stmt.init) evaluateVarDecl(stmt.init, ctx);
  while (true) {
    if (stmt.condition) {
      const cond = evaluateExpression(stmt.condition, ctx);
      if (!isTruthy(cond, ctx)) break;
    }
    if (++ctx.loopSteps > MAX_LOOP_STEPS_PER_BAR) {
      throw new Error(`for loop exceeded ${MAX_LOOP_STEPS_PER_BAR} iterations on bar ${ctx.barIndex} (likely infinite loop)`);
    }
    for (const s of stmt.body) { evaluateStatement(s, ctx); if (ctx.breakFlag) { ctx.breakFlag = false; return; } if (ctx.continueFlag) { ctx.continueFlag = false; break; } if (ctx.returnValue !== null) return; }
    if (stmt.update) evaluateExpression(stmt.update, ctx);
  }
}

function evaluateWhile(stmt: WhileStatement, ctx: RuntimeContext): void {
  while (isTruthy(evaluateExpression(stmt.condition, ctx), ctx)) {
    if (++ctx.loopSteps > MAX_LOOP_STEPS_PER_BAR) {
      throw new Error(`while loop exceeded ${MAX_LOOP_STEPS_PER_BAR} iterations on bar ${ctx.barIndex} (likely infinite loop)`);
    }
    for (const s of stmt.body) { evaluateStatement(s, ctx); if (ctx.breakFlag) { ctx.breakFlag = false; return; } if (ctx.continueFlag) { ctx.continueFlag = false; break; } if (ctx.returnValue !== null) return; }
  }
}

function evaluateExpression(expr: ASTNode, ctx: RuntimeContext): RuntimeValue {
  const val = evaluateExpressionRaw(expr, ctx);
  // Track numeric values in history for building series
  if (typeof val === 'number') {
    if (!ctx.seriesHistory.has(expr)) {
      ctx.seriesHistory.set(expr, []);
    }
    const history = ctx.seriesHistory.get(expr)!;
    if (history.length > ctx.barIndex) {
      // Overwrite the last value for the current bar (re-evaluation)
      history[ctx.barIndex] = val;
    } else {
      // Ensure history length matches ctx.barIndex
      while (history.length < ctx.barIndex) {
        history.push(history.length > 0 ? history[history.length - 1] : val);
      }
      history.push(val);
    }
  }
  return val;
}

function evaluateExpressionRaw(expr: ASTNode, ctx: RuntimeContext): RuntimeValue {
  switch (expr.type) {
    case 'NumberLiteral': return (expr as NumberLiteral).value;
    case 'StringLiteral': return (expr as StringLiteral).value;
    case 'BooleanLiteral': return (expr as BooleanLiteral).value;
    case 'NilLiteral': return null;
    case 'Identifier': return evaluateIdentifier(expr as Identifier, ctx);
    case 'BinaryExpr': return evaluateBinary(expr as BinaryExpr, ctx);
    case 'UnaryExpr': return evaluateUnary(expr as UnaryExpr, ctx);
    case 'TernaryExpr': {
      const t = expr as TernaryExpr;
      return isTruthy(evaluateExpression(t.condition, ctx), ctx)
        ? evaluateExpression(t.consequent, ctx)
        : evaluateExpression(t.alternate, ctx);
    }
    case 'CallExpr': return evaluateCall(expr as CallExpr, ctx);
    case 'IndexExpr': return evaluateIndex(expr as IndexExpr, ctx);
    case 'MemberExpr': return evaluateMember(expr as MemberExpr, ctx);
    case 'ArrayLiteral': return (expr as ArrayLiteral).elements.map(e => evaluateExpression(e, ctx));
    case 'Assignment': return evaluateAssignment(expr as Assignment, ctx);
    default: return null;
  }
}

function evaluateAssignmentTarget(target: ASTNode, value: RuntimeValue, ctx: RuntimeContext): RuntimeValue {
  if (target.type === 'Identifier') {
    const name = (target as Identifier).name;
    ctx.vars.set(name, value);
    if (ctx.persist.has(name)) ctx.persist.set(name, value);
    return value;
  }
  if (target.type === 'IndexExpr') {
    const obj = evaluateExpression((target as IndexExpr).object, ctx);
    const idx = evaluateExpression((target as IndexExpr).index, ctx);
    if (Array.isArray(obj) && typeof idx === 'number') { obj[idx] = value; }
    return value;
  }
  if (target.type === 'MemberExpr') {
    const obj = evaluateExpression((target as MemberExpr).object, ctx);
    const prop = (target as MemberExpr).property;
    if (typeof obj === 'object' && obj !== null) { (obj as any)[prop] = value; }
    return value;
  }
  return value;
}

function evaluateIdentifier(node: Identifier, ctx: RuntimeContext): RuntimeValue {
  const name = node.name;

  // Built-in keywords as series access
  if (name === 'close') return ctx.bars.close[ctx.barIndex];
  if (name === 'open') return ctx.bars.open[ctx.barIndex];
  if (name === 'high') return ctx.bars.high[ctx.barIndex];
  if (name === 'low') return ctx.bars.low[ctx.barIndex];
  if (name === 'volume') return ctx.bars.volume[ctx.barIndex];
  if (name === 'time') return ctx.bars.time[ctx.barIndex];
  if (name === 'bar_index') return ctx.barIndex;
  if (name === 'barstate') return { isnew: ctx.barIndex > 0, isrealtime: false, isconfirmed: true };

  // Check vars
  if (ctx.vars.has(name)) return ctx.vars.get(name)!;
  return null;
}

function evaluateBinary(expr: BinaryExpr, ctx: RuntimeContext): RuntimeValue {
  const left = evaluateExpression(expr.left, ctx);
  const right = evaluateExpression(expr.right, ctx);
  const op = expr.op;

  if (typeof left === 'number' && typeof right === 'number') {
    switch (op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right;
      case '%': return left % right;
      case '==': return left === right;
      case '!=': return left !== right;
      case '<': return left < right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '>=': return left >= right;
      case '=>': return left >= right;
    }
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    if (op === 'and') return left && right;
    if (op === 'or') return left || right;
  }

  if (typeof left === 'string' || typeof right === 'string') {
    if (op === '+') return String(left) + String(right);
    if (op === '==') return left === right;
    if (op === '!=') return left !== right;
  }

  // Comparison of non-numbers (uses truthiness for boolean-like)
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;

  return null;
}

function evaluateUnary(expr: UnaryExpr, ctx: RuntimeContext): RuntimeValue {
  const arg = evaluateExpression(expr.argument, ctx);
  if (expr.op === '-') return typeof arg === 'number' ? -arg : null;
  if (expr.op === '!') return !isTruthy(arg, ctx);
  if (expr.op === 'not') return !isTruthy(arg, ctx);
  return arg;
}

function evaluateCall(expr: CallExpr, ctx: RuntimeContext): RuntimeValue {
  const callee = expr.callee;
  let funcName = '';
  let args: RuntimeValue[] = [];

  // Resolve BOTH plain calls (plot, rsi) and namespaced calls
  // (label.new, color.new, array.get) — the parser builds the latter as a
  // MemberExpr callee, so flatten it to a dotted name and route it through
  // the same builtin switch. Without this, namespaced calls silently no-op.
  const dottedName = callee.type === 'MemberExpr' && (callee as MemberExpr).object.type === 'Identifier'
    ? `${((callee as MemberExpr).object as Identifier).name}.${(callee as MemberExpr).property}`
    : null;

  if (callee.type === 'Identifier' || dottedName) {
    funcName = dottedName ?? (callee as Identifier).name;
    args = expr.args.map(a => evaluateExpression(a, ctx));

    // Built-in stdlib functions (series -> series)
    switch (funcName) {
      case 'sma': case 'ema': case 'rsi': case 'macd': case 'highest': case 'lowest':
      case 'stdev': case 'roc': case 'cum': case 'change':
      case 'barssince': case 'vwap': case 'linreg': case 'correlation':
      case 'cci': case 'atr': case 'adx': case 'trueRange':
      case 'wma': case 'rma': case 'hma': case 'vwma': case 'mom': case 'median':
      case 'pivothigh': case 'pivotlow': {
        const sourceNode = expr.args[0];
        const param1 = typeof args[1] === 'number' ? args[1] : 14;
        const param2 = typeof args[2] === 'number' ? args[2] : param1;
        const param3 = typeof args[3] === 'number' ? args[3] : 9;

        // Cache full-array results for leaf indicators that depend on built-in
        // series (close/open/high/low/volume). Derived indicators (e.g. sma of
        // another sma) still compute incrementally.
        let cacheKey = '';
        const isBuiltInSrc = sourceNode.type === 'Identifier'
          && ['close','open','high','low','volume','time'].includes((sourceNode as Identifier).name);
        if (isBuiltInSrc) {
          cacheKey = `${funcName}:${(sourceNode as Identifier).name}:${param1}:${param2}:${param3}`;
          if (ctx.cache.has(cacheKey)) {
            const arr = ctx.cache.get(cacheKey);
            if (Array.isArray(arr)) return arr[ctx.barIndex] ?? 0;
            if (arr && typeof arr === 'object' && 'macd' in arr) {
              return {
                macd: arr.macd[ctx.barIndex] ?? 0,
                signal: arr.signal[ctx.barIndex] ?? 0,
                hist: arr.hist[ctx.barIndex] ?? 0
              };
            }
          }
        }

        // Get the full source series (all bars, not truncated to current bar)
        let series: number[];
        if (isBuiltInSrc) {
          const name = (sourceNode as Identifier).name;
          if (name === 'time') series = ctx.bars.close.map(() => 0); // time not needed as series
          else series = (ctx.bars as any)[name];
        } else {
          series = buildSeries(sourceNode, ctx);
        }

        const lenParam = (funcName === 'cci' || funcName === 'atr' || funcName === 'adx')
          ? (typeof args[3] === 'number' ? args[3] : 14)
          : param1;

        const fn = StdLib[funcName as keyof typeof StdLib] as Function;
        if (fn) {
          try {
            let result: any;
            if (funcName === 'correlation') {
              result = fn.call(StdLib, buildSeries(expr.args[0], ctx), buildSeries(expr.args[1], ctx), param1);
            }
            else if (funcName === 'vwap') result = fn.call(StdLib, series, ctx.bars.volume);
            else if (funcName === 'macd') result = fn.call(StdLib, series, param1, param2, param3);
            else if (funcName === 'cci') result = fn.call(StdLib, ctx.bars.high, ctx.bars.low, ctx.bars.close, lenParam);
            else if (funcName === 'atr') result = fn.call(StdLib, ctx.bars.high, ctx.bars.low, ctx.bars.close, lenParam);
            else if (funcName === 'adx') result = fn.call(StdLib, ctx.bars.high, ctx.bars.low, ctx.bars.close, lenParam);
            else if (funcName === 'trueRange') result = fn.call(StdLib, ctx.bars.high, ctx.bars.low, ctx.bars.close);
            else if (funcName === 'vwma') result = fn.call(StdLib, series, ctx.bars.volume, param1);
            else if (funcName === 'pivothigh' || funcName === 'pivotlow') {
              // pivothigh(source, left, right) — cache key already carries
              // param1/param2, so confirmed pivots compute once per execution.
              const left = typeof args[1] === 'number' ? args[1] : 5;
              const right = typeof args[2] === 'number' ? args[2] : left;
              result = fn.call(StdLib, series, left, right);
            }
            else result = fn.call(StdLib, series, param1);

            if (isBuiltInSrc) ctx.cache.set(cacheKey, result);
            if (Array.isArray(result)) return result[ctx.barIndex] ?? 0;
            if (result && typeof result === 'object' && 'macd' in result) {
              return {
                macd: result.macd[ctx.barIndex] ?? 0,
                signal: result.signal[ctx.barIndex] ?? 0,
                hist: result.hist[ctx.barIndex] ?? 0
              };
            }
            return 0;
          } catch { return 0; }
        }
        return 0;
      }

      case 'security': {
        // security(timeframe, source) — Confirmed-Only Multi-Timeframe
        // Confluence: OakScript's equivalent of Pine's request.security(),
        // bare (not dotted) since 'request.' is a blocked Pine namespace
        // and OakScript's own convention drops Pine namespaces anyway
        // (ta.sma -> sma, input.int -> input). Pure in-memory aggregation
        // of bars already loaded — no new fetch, no symbol param (always
        // the current chart's own symbol).
        const tfArg = typeof args[0] === 'string' ? args[0] : '';
        const htfMs = SECURITY_TIMEFRAME_MS[tfArg];
        const sourceNode = expr.args[1];
        if (!htfMs || !sourceNode) return NaN;

        const gapCacheKey = 'security:_gap';
        let medianGap = ctx.cache.get(gapCacheKey);
        if (medianGap === undefined) {
          medianGap = medianBarGapMs(ctx.bars.time);
          ctx.cache.set(gapCacheKey, medianGap);
        }

        const isBuiltInSrc = sourceNode.type === 'Identifier'
          && ['close', 'open', 'high', 'low', 'volume', 'time'].includes((sourceNode as Identifier).name);

        if (isBuiltInSrc) {
          const srcName = (sourceNode as Identifier).name;
          const cacheKey = `security:${tfArg}:${srcName}`;
          if (ctx.cache.has(cacheKey)) {
            const arr = ctx.cache.get(cacheKey);
            return arr[ctx.barIndex] ?? NaN;
          }
          const ohlcField: 'open' | 'high' | 'low' | 'close' | null =
            srcName === 'open' || srcName === 'high' || srcName === 'low' || srcName === 'close' ? srcName : null;
          const values = (ctx.bars as any)[srcName] as number[];
          const result = computeConfirmedHtfSeries(ctx.bars.time, values, htfMs, medianGap, ohlcField);
          ctx.cache.set(cacheKey, result);
          return result[ctx.barIndex] ?? NaN;
        }

        // Derived expression: only "so far" data is knowable at this bar,
        // so this recomputes every bar — the same uncached idiom the
        // sma/highest mega-case above already uses for non-built-in
        // sources (no new performance-cost class introduced).
        const series = buildSeries(sourceNode, ctx);
        const timesSoFar = ctx.bars.time.slice(0, ctx.barIndex + 1);
        const result = computeConfirmedHtfSeries(timesSoFar, series, htfMs, medianGap, null);
        return result[ctx.barIndex] ?? NaN;
      }

      case 'regression.channel': {
        // regression.channel(source,length,mult?) -> {mid,upper,lower} per
        // bar — pure calculation (documented as a plot()+fill() recipe, not
        // an auto-drawing primitive), same per-bar-record shape as the
        // 'macd' case above, including its built-in-source caching pattern.
        const sourceNode = expr.args[0];
        const length = typeof args[1] === 'number' ? args[1] : 14;
        const mult = typeof args[2] === 'number' ? args[2] : 2;
        const isBuiltInSrc = sourceNode.type === 'Identifier'
          && ['close', 'open', 'high', 'low', 'volume'].includes((sourceNode as Identifier).name);
        const cacheKey = isBuiltInSrc
          ? `regression.channel:${(sourceNode as Identifier).name}:${length}:${mult}`
          : '';
        if (cacheKey && ctx.cache.has(cacheKey)) {
          const r = ctx.cache.get(cacheKey);
          return { mid: r.mid[ctx.barIndex] ?? 0, upper: r.upper[ctx.barIndex] ?? 0, lower: r.lower[ctx.barIndex] ?? 0 };
        }
        const series = isBuiltInSrc ? (ctx.bars as any)[(sourceNode as Identifier).name] : buildSeries(sourceNode, ctx);
        const result = StdLib.regressionChannel(series, length, mult);
        if (cacheKey) ctx.cache.set(cacheKey, result);
        return { mid: result.mid[ctx.barIndex] ?? 0, upper: result.upper[ctx.barIndex] ?? 0, lower: result.lower[ctx.barIndex] ?? 0 };
      }

      case 'crossover': case 'crossunder': {
        // Cache full-array results so we don't recompute every bar
        const aNode = expr.args[0], bNode = expr.args[1];
        const cacheKey = `${funcName}:${aNode.type}:${bNode.type}`;
        const cached = ctx.cache.get(cacheKey) as boolean[] | undefined;
        if (cached && cached.length > ctx.barIndex) return cached[ctx.barIndex] || false;

        const a = buildSeries(aNode, ctx);
        const b = buildSeries(bNode, ctx);
        const fn = StdLib[funcName];
        const result = fn(a, b);
        ctx.cache.set(cacheKey, result);
        return result[ctx.barIndex] || false;
      }

      // Bars-based oscillators — read OHLCV directly from the chart, so the
      // source args are positional/documentary and only the length matters:
      //   stoch(high, low, close, length) | mfi(high, low, close, volume, length)
      //   cmf(high, low, close, volume, length) | obv(close, volume)
      case 'stoch': case 'mfi': case 'obv': case 'cmf': {
        const L = funcName === 'stoch' ? (typeof args[3] === 'number' ? args[3] : 14)
                : funcName === 'obv' ? 0
                : typeof args[4] === 'number' ? args[4] : (funcName === 'cmf' ? 20 : 14);
        const cacheKey = `${funcName}:bars:${L}`;
        if (!ctx.cache.has(cacheKey)) {
          const fn = StdLib[funcName as keyof typeof StdLib] as Function;
          const b = ctx.bars;
          const result = funcName === 'obv' ? fn.call(StdLib, b.close, b.volume)
                       : funcName === 'stoch' ? fn.call(StdLib, b.high, b.low, b.close, L)
                       : fn.call(StdLib, b.high, b.low, b.close, b.volume, L);
          ctx.cache.set(cacheKey, result);
        }
        const arr = ctx.cache.get(cacheKey) as number[];
        return arr[ctx.barIndex] ?? 0;
      }

      // Plot functions
      case 'plot': {
        // plot(value, title, color, linewidth, style?|pane?, pane?)
        //   style: line | stepline | area | histogram | columns | circles | cross
        //   color may differ each bar (conditional) -> renderer colors per-bar.
        let val = args[0];
        if (val && typeof val === 'object' && 'macd' in val) {
          val = (val as any).macd;
        }
        const numericVal = typeof val === 'number' ? val : 0;
        const title = typeof args[1] === 'string' ? args[1] : '';
        let color = '#b48cff';
        let lw = 1;
        let pane: 'main' | 'separate' = 'main';
        let style = 'line';
        if (typeof args[2] === 'object' && args[2] !== null) {
          const o = args[2] as any;
          color = o.color || color;
          lw = typeof o.linewidth === 'number' ? o.linewidth : lw;
          if (typeof o.style === 'string') style = o.style;
          if (o.pane === 'separate') pane = 'separate';
        } else {
          if (typeof args[2] === 'string') color = args[2];
          if (typeof args[3] === 'number') lw = args[3];
          // 5th slot may be a style OR the pane.
          if (args[4] === 'separate') pane = 'separate';
          else if (typeof args[4] === 'string' && PLOT_STYLES.has(args[4])) style = args[4];
          if (args[5] === 'separate') pane = 'separate';
        }
        ctx.plots.push({ type: 'line', name: title || 'plot', value: numericVal, color, linewidth: lw, style, pane, barIdx: ctx.barIndex });
        return val;
      }

      case 'plotshape': {
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const title = typeof args[2] === 'string' ? args[2] : '';
        const style = typeof args[3] === 'string' ? args[3] : 'circle';
        const col = typeof args[4] === 'string' ? args[4] : '#b48cff';
        const pane = typeof args[5] === 'string' && args[5] === 'separate' ? 'separate' : 'main';
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        ctx.plots.push({ type: 'shape', name: title, text: title, price, color: col, style, pane, barIdx });
        return true;
      }

      case 'plotarrow': {
        // plotarrow(bar_index, price, title, direction, color, pane)
        // direction: "up" (default) | "down" — renders a filled arrow glyph.
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const title = typeof args[2] === 'string' ? args[2] : '';
        const dir = typeof args[3] === 'string' ? args[3].toLowerCase() : 'up';
        const style = (dir === 'down' || dir === 'arrowdown') ? 'arrowdown' : 'arrowup';
        const col = typeof args[4] === 'string' ? args[4] : (style === 'arrowup' ? '#22cc88' : '#ff4477');
        const pane = args[5] === 'separate' ? 'separate' : 'main';
        ctx.plots.push({ type: 'shape', name: title, text: title, price, color: col, style, pane, barIdx });
        return true;
      }

      case 'plotchar': {
        // plotchar(bar_index, price, char, color, pane) — draws a text/emoji marker.
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const ch = args[2] != null ? String(args[2]) : '•';
        const col = typeof args[3] === 'string' ? args[3] : '#b48cff';
        const pane = args[4] === 'separate' ? 'separate' : 'main';
        // Rendered via the shape pipeline using the 'label' style (draws text at price).
        ctx.plots.push({ type: 'shape', name: ch, text: ch, price, color: col, style: 'label', pane, barIdx });
        return true;
      }

      case 'plot3d': {
        // plot3d(source, name, style, color, pane, z_level?)
        // z_level: number — Z-axis position. Positive = forward, negative = back.
        // Use same level value to stack visuals together; different levels to space them.
        const name = typeof args[1] === 'string' ? args[1] : '3D Plot';
        const style = typeof args[2] === 'string' ? args[2] : 'surface';
        const col = typeof args[3] === 'string' ? args[3] : '#b48cff';
        const pane = typeof args[4] === 'string' ? args[4] : 'main';
        const z_level = typeof args[5] === 'number' ? args[5] : undefined;
        if (ctx.barIndex === ctx.bars.close.length - 1) {
          const series = buildSeries(expr.args[0], ctx);
          ctx.plots.push({
            type: 'plot3d', name, series,
            style: style as any, color: col, pane, z_level,
          } as any);
        }
        return true;
      }

      case 'plotshape_3d': {
        // plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?)
        // shape: "cube" | "sphere" | "pyramid" | "torus" | "diamond" | "coneup" | "conedown"
        // coneup/conedown auto-offset from the bar (gap scales with size) with the
        // tip pointing AT the price — the standard buy/sell markers.
        // rx/ry/rz: optional rotation in DEGREES, applied on top of any built-in
        // orientation, so any shape can be posed for custom scenes.
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const title = typeof args[2] === 'string' ? args[2] : '';
        const shape3d = typeof args[3] === 'string' ? args[3] : 'cube';
        const col = typeof args[4] === 'string' ? args[4] : '#b48cff';
        const size = typeof args[5] === 'number' ? args[5] : 1;
        const z_level = typeof args[6] === 'number' ? args[6] : 0;
        const pane = (args[7] === '3d' || args[7] === 'main' ? args[7] : 'separate') as 'main' | 'separate' | '3d';
        const rx = typeof args[8] === 'number' ? args[8] : 0;
        const ry = typeof args[9] === 'number' ? args[9] : 0;
        const rz = typeof args[10] === 'number' ? args[10] : 0;
        ctx.plots.push({
          type: 'plot3d_shape', name: title,
          barIdx, price, color: col,
          shape3d: shape3d as any,
          size, z_level,
          pane, rx, ry, rz,
        });
        return true;
      }

      case 'label3d': {
        // label3d(bar_index, price, text, color?, size?, z_level?, pane?)
        // Billboard text sprite at exact bar/price/Z coordinates in a 3D scene.
        // Pairs with plot3d/plotshape_3d — names peaks, levels, and signals the
        // way the reference visuals label BTC/ETH nodes or planet spheres.
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const text = args[2] != null ? String(args[2]) : '';
        const col = typeof args[3] === 'string' ? args[3] : '#ffffff';
        const size = typeof args[4] === 'number' ? args[4] : 1;
        const z_level = typeof args[5] === 'number' ? args[5] : 0;
        const pane = typeof args[6] === 'string' ? args[6] : 'separate';
        if (text) {
          ctx.plots.push({
            type: 'plot3d_label', name: text, text,
            barIdx, price, color: col, size, z_level, pane,
          } as any);
        }
        return true;
      }

      case 'fill': {
        // fill(plot1, plot2, color) — creates a filled area between two plot values
        const top = typeof args[0] === 'number' ? args[0] : 0;
        const bot = typeof args[1] === 'number' ? args[1] : 0;
        const col = typeof args[2] === 'string' ? args[2] : 'rgba(180,140,255,0.1)';
        ctx.plots.push({ type: 'fill', name: '', color: col, price: top, fillTop: top, fillBot: bot, barIdx: ctx.barIndex });
        return true;
      }

      case 'hline': {
        const price = args[0] as number;
        const col = typeof args[1] === 'string' ? args[1] : '#b48cff';
        const pane = typeof args[2] === 'string' && args[2] === 'separate' ? 'separate' : 'main';
        if (!Number.isFinite(price)) return price;
        // Dedupe: the same hline statement is reached on every bar (or on
        // every historical trigger when conditional), and each un-deduped
        // call stacked another permanent line — a fib script repainted
        // hundreds of lines over the chart. One entry per unique line.
        const key = `${price}|${col}|${pane}`;
        if (ctx.hlineSeen.has(key)) return price;
        // Rolling cap: when a script emits ever-changing levels (dynamic
        // fibs/pivots), drop the OLDEST line so stale sets clean themselves
        // up instead of accumulating forever. 24 distinct lines per pane is
        // far more than any readable indicator needs.
        const paneLines = ctx.plots.filter(p => p.type === 'hline' && p.pane === pane);
        if (paneLines.length >= 24) {
          const oldest = paneLines[0];
          const idx = ctx.plots.indexOf(oldest);
          if (idx >= 0) ctx.plots.splice(idx, 1);
          ctx.hlineSeen.delete(`${oldest.price}|${oldest.color}|${oldest.pane}`);
        }
        ctx.hlineSeen.add(key);
        ctx.plots.push({ type: 'hline', name: '', price, color: col, pane });
        return price;
      }

      case 'bgcolor': {
        const col = String(args[0] || '');
        const pane = typeof args[1] === 'string' && args[1] === 'separate' ? 'separate' : 'main';
        if (col) ctx.plots.push({ type: 'bgcolor', name: '', color: col, pane, barIdx: ctx.barIndex });
        return null;
      }

      // ─── Drawing objects — lines, boxes, polylines, circles, arrows ───
      // All route through upsertObject/autoId (defined near the top of this
      // file, alongside hexToRgbTuple): same id -> mutate in place, new id ->
      // push + rolling-cap the type. Coordinates: x/x1/x2 = bar_index,
      // y/y1/y2 = price; width = pixels (screen-space, like existing label
      // sizing) not price units.
      case 'line.new': {
        // line.new(x1,y1,x2,y2,color?,width?,style?,extend?,id?)
        const x1 = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y1 = typeof args[1] === 'number' ? args[1] : 0;
        const x2 = typeof args[2] === 'number' ? args[2] : x1;
        const y2 = typeof args[3] === 'number' ? args[3] : y1;
        const col = typeof args[4] === 'string' ? args[4] : '#b48cff';
        const width = typeof args[5] === 'number' ? args[5] : 1;
        const style = typeof args[6] === 'string' ? args[6] : 'solid';
        const extend = (typeof args[7] === 'string' ? args[7] : 'none') as OakPlot['extend'];
        const id = autoId(ctx, args[8], 'line');
        upsertObject(ctx, 'line_obj', id, { x: x1, y: y1, x2, y2, color: col, linewidth: width, style, extend, barIdx: ctx.barIndex });
        return id;
      }

      case 'line.delete': {
        deleteObjectById(ctx, 'line_obj', typeof args[0] === 'string' ? args[0] : '');
        return null;
      }

      case 'box.new': {
        // box.new(left,top,right,bottom,borderColor?,bgColor?,width?,id?)
        const left = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const top = typeof args[1] === 'number' ? args[1] : 0;
        const right = typeof args[2] === 'number' ? args[2] : left;
        const bottom = typeof args[3] === 'number' ? args[3] : top;
        const borderColor = typeof args[4] === 'string' ? args[4] : '#b48cff';
        const bg = typeof args[5] === 'string' ? args[5] : 'rgba(180,140,255,0.15)';
        const width = typeof args[6] === 'number' ? args[6] : 1;
        const id = autoId(ctx, args[7], 'box');
        upsertObject(ctx, 'box_obj', id, { x: left, y: top, x2: right, y2: bottom, color: borderColor, bgColor: bg, linewidth: width, barIdx: ctx.barIndex });
        return id;
      }

      case 'box.delete': {
        deleteObjectById(ctx, 'box_obj', typeof args[0] === 'string' ? args[0] : '');
        return null;
      }

      case 'circle.new': {
        // circle.new(x1,y1,x2,y2,color?,bgColor?,width?,id?) — bounding box;
        // the renderer inscribes an ellipse inside it.
        const x1 = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y1 = typeof args[1] === 'number' ? args[1] : 0;
        const x2 = typeof args[2] === 'number' ? args[2] : x1;
        const y2 = typeof args[3] === 'number' ? args[3] : y1;
        const col = typeof args[4] === 'string' ? args[4] : '#b48cff';
        const bg = typeof args[5] === 'string' ? args[5] : 'transparent';
        const width = typeof args[6] === 'number' ? args[6] : 1;
        const id = autoId(ctx, args[7], 'circle');
        upsertObject(ctx, 'circle_obj', id, { x: x1, y: y1, x2, y2, color: col, bgColor: bg, linewidth: width, barIdx: ctx.barIndex });
        return id;
      }

      case 'arrow.new': {
        // arrow.new(x1,y1,x2,y2,color?,width?,id?) — freeform two-point
        // arrow, distinct from the bar-anchored plotarrow() above.
        const x1 = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y1 = typeof args[1] === 'number' ? args[1] : 0;
        const x2 = typeof args[2] === 'number' ? args[2] : x1;
        const y2 = typeof args[3] === 'number' ? args[3] : y1;
        const col = typeof args[4] === 'string' ? args[4] : '#b48cff';
        const width = typeof args[5] === 'number' ? args[5] : 1;
        const id = autoId(ctx, args[6], 'arrow');
        upsertObject(ctx, 'arrow_obj', id, { x: x1, y: y1, x2, y2, color: col, linewidth: width, barIdx: ctx.barIndex });
        return id;
      }

      case 'polyline.new': {
        // polyline.new(points,color?,width?,closed?,id?)
        // points = a runtime array of 2-element [bar,price] arrays (OakScript
        // array literals already evaluate to RuntimeValue[]) — filtered/mapped
        // defensively into {x,y} objects.
        const rawPoints = Array.isArray(args[0]) ? args[0] : [];
        const points = rawPoints
          .filter((p): p is RuntimeValue[] => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
          .map((p) => ({ x: p[0] as number, y: p[1] as number }));
        const col = typeof args[1] === 'string' ? args[1] : '#b48cff';
        const width = typeof args[2] === 'number' ? args[2] : 1;
        const closed = args[3] === true;
        const id = autoId(ctx, args[4], 'polyline');
        upsertObject(ctx, 'polyline_obj', id, { points, color: col, linewidth: width, closed, barIdx: ctx.barIndex });
        return id;
      }

      case 'linefill.new': {
        // linefill.new(lineId1,lineId2,color) — keyed on BOTH ids (not
        // autoId); the renderer resolves id1/id2 back to their line_obj
        // entries at draw time to fill the band between them.
        const id1 = typeof args[0] === 'string' ? args[0] : '';
        const id2 = typeof args[1] === 'string' ? args[1] : '';
        const col = typeof args[2] === 'string' ? args[2] : 'rgba(180,140,255,0.15)';
        const key = `${id1}|${id2}`;
        upsertObject(ctx, 'linefill_obj', key, { id1, id2, color: col, barIdx: ctx.barIndex });
        return key;
      }

      // ─── Tables & dashboards ───────────────────────────────────────────
      case 'table.new': {
        // table.new(position,columns,rows,bgColor?,id?) — creates the
        // backing 'table' OakPlot via upsertObject, then returns a live JS
        // handle (same established pattern as array()/oakring()/matrix()
        // above) wrapping plot.cells so table.cell(...) can mutate the grid
        // without needing a real object-handle system.
        const position = typeof args[0] === 'string' ? args[0] : 'top_right';
        const cols = typeof args[1] === 'number' ? Math.max(1, Math.floor(args[1])) : 1;
        const rows = typeof args[2] === 'number' ? Math.max(1, Math.floor(args[2])) : 1;
        const bg = typeof args[3] === 'string' ? args[3] : 'rgba(20,20,30,0.85)';
        const id = autoId(ctx, args[4], 'table');
        const cells: OakTableCell[][] = [];
        for (let r = 0; r < rows; r++) {
          const row: OakTableCell[] = [];
          for (let c = 0; c < cols; c++) row.push({ text: '' });
          cells.push(row);
        }
        const plot = upsertObject(ctx, 'table', id, { position, cols, rows, bgColor: bg, cells, barIdx: ctx.barIndex });
        const handle: any = { _type: 'OakTable', id, position, cols, rows };
        handle.cell = (col: number, row: number, text: RuntimeValue, cellBg?: RuntimeValue, cellFg?: RuntimeValue) => {
          const r = plot.cells?.[row];
          if (r && r[col]) {
            r[col].text = text != null ? String(text) : '';
            if (typeof cellBg === 'string') r[col].bgColor = cellBg;
            if (typeof cellFg === 'string') r[col].textColor = cellFg;
          }
          return null;
        };
        return handle;
      }

      case 'table.cell': {
        // table.cell(handle,col,row,text,bgColor?,textColor?) — free-function
        // form for Pine-idiom parity; delegates to the handle's own method.
        const handle = args[0] as any;
        if (handle && typeof handle.cell === 'function') {
          handle.cell(args[1], args[2], args[3], args[4], args[5]);
        }
        return null;
      }

      case 'barcolor': {
        // barcolor(color,pane?) — per-bar candle recolor override, NOT a
        // persistent object (no upsertObject/id): every bar pushes its own
        // entry, read directly by drawBars()'s barColorOverrides scan, not
        // drawOakScriptPlots. pane is accepted for signature parity but
        // objects/overrides in this pass are main-pane only.
        const col = typeof args[0] === 'string' ? args[0] : '';
        if (col) ctx.plots.push({ type: 'barcolor', name: '', color: col, barIdx: ctx.barIndex, pane: 'main' });
        return null;
      }

      // ─── Analyst overlay tools — sugar built on line.new's upsertObject ──
      case 'fibretracement.new': {
        // fibretracement.new(x1,y1,x2,y2,levels?,colorUp?,colorDown?,id?)
        // Sugar: emits N real line_obj entries (one per ratio), not a new
        // OakPlot type.
        const x1 = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y1 = typeof args[1] === 'number' ? args[1] : 0;
        const x2 = typeof args[2] === 'number' ? args[2] : x1;
        const y2 = typeof args[3] === 'number' ? args[3] : y1;
        const levels = Array.isArray(args[4]) && args[4].length > 0
          ? (args[4].filter((v): v is number => typeof v === 'number') as number[])
          : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const colorUp = typeof args[5] === 'string' ? args[5] : '#22cc88';
        const colorDown = typeof args[6] === 'string' ? args[6] : '#ff4477';
        const id = autoId(ctx, args[7], 'fib');
        for (const ratio of levels) {
          const price = y1 + (y2 - y1) * ratio;
          const subId = `${id}:${ratio}`;
          const col = ratio <= 0.5 ? colorUp : colorDown;
          upsertObject(ctx, 'line_obj', subId, {
            x: x1, y: price, x2, y2: price, color: col,
            style: 'dashed', extend: 'right', barIdx: ctx.barIndex,
          });
        }
        return id;
      }

      case 'gannfan.new': {
        // gannfan.new(x1,y1,angleUnit?,color?,id?)
        // Sugar: the 7 classic Gann angles (1x1..1x8/8x1), each a real
        // line_obj entry via upsertObject.
        const x1 = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y1 = typeof args[1] === 'number' ? args[1] : 0;
        const angleUnit = typeof args[2] === 'number' ? args[2] : 1;
        const col = typeof args[3] === 'string' ? args[3] : '#b48cff';
        const id = autoId(ctx, args[4], 'gann');
        const angles: [number, number][] = [[1, 1], [1, 2], [2, 1], [1, 4], [4, 1], [1, 8], [8, 1]];
        for (const [rise, run] of angles) {
          const slope = (angleUnit * rise) / run;
          const subId = `${id}:${rise}x${run}`;
          upsertObject(ctx, 'line_obj', subId, {
            x: x1, y: y1, x2: x1 + 50, y2: y1 + slope * 50,
            style: 'dotted', extend: 'right', color: col, barIdx: ctx.barIndex,
          });
        }
        return id;
      }

      // ─── Images — import & signals ──────────────────────────────────────
      // Source resolution (shared rule): a string starting with 'data:image/'
      // is used directly as imageRef; otherwise it's looked up by exact name
      // in ctx.imageAssets (the saved-asset library threaded into
      // executeScript), defaulting to '' if not found/not provided.
      case 'image.new': {
        // image.new(x,y,source,width?,height?,anchor?,opacity?,rotation?,id?)
        // width/height/opacity are pixels/0..1 (screen-space, not price
        // units); rotation reuses the existing rz field (degrees).
        const x = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y = typeof args[1] === 'number' ? args[1] : 0;
        const source = typeof args[2] === 'string' ? args[2] : '';
        const imageRef = source.startsWith('data:image/') ? source : (ctx.imageAssets?.get(source) ?? '');
        const width = typeof args[3] === 'number' ? args[3] : 48;
        const height = typeof args[4] === 'number' ? args[4] : 48;
        const anchor = typeof args[5] === 'string' ? args[5] : 'center';
        const opacity = typeof args[6] === 'number' ? args[6] : 1;
        const rotation = typeof args[7] === 'number' ? args[7] : 0;
        const id = autoId(ctx, args[8], 'image');
        upsertObject(ctx, 'image_obj', id, {
          x, y, imageRef, imgWidth: width, imgHeight: height,
          position: anchor, opacity, rz: rotation, barIdx: ctx.barIndex,
        });
        return id;
      }

      case 'plotimage': {
        // plotimage(bar_index,price,source,width?,height?,pane?,id?) — a
        // per-bar signal marker (pushed directly, not via upsertObject —
        // one entry per firing bar), parallel to plotshape/plotarrow/plotchar
        // above. Same source-resolution rule as image.new.
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const source = typeof args[2] === 'string' ? args[2] : '';
        const imageRef = source.startsWith('data:image/') ? source : (ctx.imageAssets?.get(source) ?? '');
        const width = typeof args[3] === 'number' ? args[3] : 24;
        const height = typeof args[4] === 'number' ? args[4] : 24;
        const pane = args[5] === 'separate' ? 'separate' : 'main';
        ctx.plots.push({ type: 'shape', name: '', style: 'image', imageRef, imgWidth: width, imgHeight: height, price, barIdx, pane });
        return true;
      }

      case 'plotimage_3d': {
        // plotimage_3d(bar_index,price,source,size?,z_level?,pane?,rx?,ry?,rz?)
        // Parallel to plotshape_3d above, but shape3d is fixed to 'image'
        // (no title/color args — images aren't colorized). Same
        // source-resolution rule as image.new.
        const barIdx = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const price = typeof args[1] === 'number' ? args[1] : 0;
        const source = typeof args[2] === 'string' ? args[2] : '';
        const imageRef = source.startsWith('data:image/') ? source : (ctx.imageAssets?.get(source) ?? '');
        const size = typeof args[3] === 'number' ? args[3] : 1;
        const z_level = typeof args[4] === 'number' ? args[4] : 0;
        const pane = (args[5] === '3d' || args[5] === 'main' ? args[5] : 'separate') as 'main' | 'separate' | '3d';
        const rx = typeof args[6] === 'number' ? args[6] : 0;
        const ry = typeof args[7] === 'number' ? args[7] : 0;
        const rz = typeof args[8] === 'number' ? args[8] : 0;
        ctx.plots.push({
          type: 'plot3d_shape', name: '',
          barIdx, price, imageRef,
          shape3d: 'image',
          size, z_level,
          pane, rx, ry, rz,
        });
        return true;
      }

      case 'label': {
        const labelType = typeof args[0] === 'string' ? args[0] : 'new';
        if (labelType === 'new') {
          const x = args[1] as number;
          const y = args[2] as number;
          const text = String(args[3] || '');
          const col = typeof args[4] === 'object' ? (args[4] as any)?.color : '#ffffff';
          // Neither this legacy form nor label.new below carries an id
          // parameter, so there's no stable identity to mutate in place —
          // dedupe/cap by VALUE instead (same key shape as hline's dedup),
          // mirroring upsertObject's rolling-cap eviction so an unconditional
          // or repeatedly-true-conditional label() can't accumulate forever.
          const key = `${x}|${y}|${text}`;
          upsertObject(ctx, 'label', key, { x, y, text, color: String(col), barIdx: x });
        }
        return null;
      }

      case 'label.new': {
        // label.new(x, y, text, color?, size?, boxed?, align?) — proper
        // namespaced form. size/boxed/align are additive trailing args
        // (boxed defaults true); existing x/y/text/color positional meaning
        // is unchanged. text.new below is the same idea with boxed
        // defaulting false and its own id.
        const x = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y = typeof args[1] === 'number' ? args[1] : 0;
        const text = String(args[2] ?? '');
        const col = typeof args[3] === 'string' ? args[3] : '#ffffff';
        const size = typeof args[4] === 'number' ? args[4] : undefined;
        const boxed = typeof args[5] === 'boolean' ? args[5] : true;
        const align = typeof args[6] === 'string' ? args[6] : undefined;
        // Same value-keyed dedup as the legacy label() case above — no id
        // parameter exists on this signature, so (x,y,text) IS the identity;
        // an unconditional label.new with a changing text/position still
        // accumulates (correctly, that's genuinely a new label each time),
        // capped by OBJECT_CAPS so it can't grow without bound.
        const key = `${x}|${y}|${text}`;
        upsertObject(ctx, 'label', key, { x, y, text, color: col, barIdx: x, size, boxed, align });
        return null;
      }

      case 'text.new': {
        // text.new(x,y,text,color?,size?,id?) — thin sugar over label.new
        // with boxed defaulting false (label.new above defaults true); has
        // its own optional id (label.new does not) and returns it. Unlike
        // the value-keyed cases above, a real id means true same-id-updates-
        // in-place semantics, same as line.new/box.new/etc.
        const x = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y = typeof args[1] === 'number' ? args[1] : 0;
        const text = String(args[2] ?? '');
        const col = typeof args[3] === 'string' ? args[3] : '#ffffff';
        const size = typeof args[4] === 'number' ? args[4] : undefined;
        const id = autoId(ctx, args[5], 'text');
        upsertObject(ctx, 'label', id, { x, y, text, color: col, barIdx: x, size, boxed: false });
        return id;
      }

      case 'color.new': {
        // color.new(baseColor, transp) — transp 0 (opaque) .. 100 (transparent).
        const base = typeof args[0] === 'string' ? args[0] : '#b48cff';
        const transp = typeof args[1] === 'number' ? Math.max(0, Math.min(100, args[1])) : 0;
        const [r, g, b] = hexToRgbTuple(base);
        return `rgba(${r},${g},${b},${(1 - transp / 100).toFixed(3)})`;
      }

      case 'color.rgb': {
        // color.rgb(r, g, b, transp?) — channels 0..255, transp 0..100.
        const r = Math.max(0, Math.min(255, Math.round(args[0] as number) || 0));
        const g = Math.max(0, Math.min(255, Math.round(args[1] as number) || 0));
        const b = Math.max(0, Math.min(255, Math.round(args[2] as number) || 0));
        const transp = typeof args[3] === 'number' ? Math.max(0, Math.min(100, args[3])) : 0;
        return `rgba(${r},${g},${b},${(1 - transp / 100).toFixed(3)})`;
      }

      case 'color.from_gradient': {
        // color.from_gradient(value, bottomValue, topValue, bottomColor, topColor)
        // — linearly interpolates between the two colors as value moves
        // through [bottomValue, topValue]. Pine parity for heatmap coloring.
        const value = typeof args[0] === 'number' ? args[0] : 0;
        const bottomValue = typeof args[1] === 'number' ? args[1] : 0;
        const topValue = typeof args[2] === 'number' ? args[2] : 100;
        const bottomColor = typeof args[3] === 'string' ? args[3] : '#22cc88';
        const topColor = typeof args[4] === 'string' ? args[4] : '#ff4477';
        const span = topValue - bottomValue;
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (value - bottomValue) / span));
        const [r1, g1, b1] = hexToRgbTuple(bottomColor);
        const [r2, g2, b2] = hexToRgbTuple(topColor);
        const r = Math.round(r1 + (r2 - r1) * t);
        const g = Math.round(g1 + (g2 - g1) * t);
        const b = Math.round(b1 + (b2 - b1) * t);
        return `rgba(${r},${g},${b},1)`;
      }

      case 'input': {
        const def = args[0];
        const title = typeof args[1] === 'string' ? args[1] : '';
        return def;
      }

      case 'str': {
        if (args.length >= 2 && typeof args[0] === 'string') {
          // Simple str.format
          let fmt = args[0] as string;
          for (let i = 1; i < args.length; i++) {
            fmt = fmt.replace('{}', String(args[i]));
          }
          return fmt;
        }
        if (args.length === 1) return String(args[0]);
        return '';
      }

      case 'alert': {
        const msg = String(args[0] || '');
        ctx.alerts.push({
          type: 'ALERT',
          message: msg,
          barIndex: ctx.barIndex,
          timestamp: ctx.bars.time[ctx.barIndex],
          price: ctx.bars.close[ctx.barIndex],
          provenance: captureProvenance(ctx),
        });
        return null;
      }

      case 'alertcondition': {
        const condition = isTruthy(args[0], ctx);
        const title = typeof args[1] === 'string' ? args[1] : 'Alert Condition';
        const msg = typeof args[2] === 'string' ? args[2] : title;
        if (condition) {
          ctx.alerts.push({
            type: 'CONDITION',
            message: msg,
            barIndex: ctx.barIndex,
            timestamp: ctx.bars.time[ctx.barIndex],
            price: ctx.bars.close[ctx.barIndex],
            provenance: captureProvenance(ctx),
          });
        }
        return condition;
      }

      // ── Consensus Gate: deterministic multi-condition quorum ───────────
      // "Multi-agent" rescoped to "multi-condition" — named boolean votes
      // the script itself registers and tallies, not LLM personas debating.
      // Same reasoning as Explain This Signal: deterministic and
      // reproducible beats a generated judgment call that can't be tested.
      case 'consensus.vote': {
        const name = String(args[0] ?? '');
        const condition = isTruthy(args[1], ctx);
        if (name) ctx.consensusVotes.set(name, condition);
        return condition;
      }

      case 'consensus.ratio': {
        if (ctx.consensusVotes.size === 0) return 0;
        let trueCount = 0;
        for (const v of ctx.consensusVotes.values()) if (v) trueCount++;
        return trueCount / ctx.consensusVotes.size;
      }

      case 'consensus.count': {
        let trueCount = 0;
        for (const v of ctx.consensusVotes.values()) if (v) trueCount++;
        return trueCount;
      }

      case 'consensus.total':
        return ctx.consensusVotes.size;

      case 'strategy.entry': {
        // strategy.entry(direction, id?, qty?) — position-level (not id-level):
        // PaperBroker keys positions by symbol only, so v1's execution-replay
        // pass treats this as "open a position if none is open." `id` rides
        // along for readability/forward-compat but isn't compared on fill.
        const direction = (typeof args[0] === 'string' ? args[0] : 'long') as 'long' | 'short';
        const id = autoId(ctx, args[1], 'entry');
        const qty = typeof args[2] === 'number' ? args[2] : undefined;
        ctx.strategyOrders.push({ kind: 'entry', direction, id, qty, barIdx: ctx.barIndex });
        return id;
      }

      case 'strategy.exit': {
        // strategy.exit(id?) — closes the open position for this symbol, if
        // any. Not a bracket-order clone (no stop/limit/trailing) — v1 is
        // deliberately a plain flatten-on-signal.
        const id = autoId(ctx, args[0], 'exit');
        ctx.strategyOrders.push({ kind: 'exit', id, barIdx: ctx.barIndex });
        return id;
      }

      case 'tostring': return String(args[0]);
      case 'tonumber': return typeof args[0] === 'number' ? args[0] : parseFloat(String(args[0]));
      case 'abs': return Math.abs(args[0] as number);
      case 'min': return Math.min(args[0] as number, args[1] as number);
      case 'max': return Math.max(args[0] as number, args[1] as number);
      case 'floor': return Math.floor(args[0] as number);
      case 'ceil': return Math.ceil(args[0] as number);
      case 'round': return Math.round(args[0] as number);
      case 'sqrt': return Math.sqrt(args[0] as number);
      case 'log': return Math.log(args[0] as number);
      case 'exp': return Math.exp(args[0] as number);
      case 'sin': return Math.sin(args[0] as number);
      case 'cos': return Math.cos(args[0] as number);
      case 'tan': return Math.tan(args[0] as number);
      case 'pow': return Math.pow(args[0] as number, args[1] as number);
      case 'sign': return Math.sign(args[0] as number);
      case 'log10': return Math.log10(args[0] as number);
      case 'avg': {
        const nums = args.filter((a): a is number => typeof a === 'number');
        return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
      }
      case 'array': {
        if (args.length === 1 && typeof args[0] === 'number') {
          const arr = new Array(args[0]);
          ctx.arrayCache.set(expr.callee.type, arr);
          return arr;
        }
        return [];
      }
      case 'array.get': return Array.isArray(args[0]) && typeof args[1] === 'number' ? args[0][args[1]] : null;
      case 'array.set': { if (Array.isArray(args[0]) && typeof args[1] === 'number') args[0][args[1]] = args[2]; return args[2]; }
      case 'array.push': { if (Array.isArray(args[0])) args[0].push(args[1]); return null; }
      case 'array.pop': { if (Array.isArray(args[0])) return args[0].pop() ?? null; return null; }
      case 'array.size': return Array.isArray(args[0]) ? args[0].length : 0;
      case 'array.shift': { if (Array.isArray(args[0])) return args[0].shift() ?? null; return null; }
      case 'array.unshift': { if (Array.isArray(args[0])) { args[0].unshift(args[1]); } return null; }
      case 'array.remove': { if (Array.isArray(args[0]) && typeof args[1] === 'number') { const v = args[0].splice(args[1], 1)[0]; return v ?? null; } return null; }
      case 'array.insert': { if (Array.isArray(args[0]) && typeof args[1] === 'number') { args[0].splice(args[1], 0, args[2]); } return null; }
      case 'array.clear': { if (Array.isArray(args[0])) args[0].length = 0; return null; }
      case 'array.includes': { if (Array.isArray(args[0])) return args[0].includes(args[1]); return false; }
      case 'array.indexOf': { if (Array.isArray(args[0])) return args[0].indexOf(args[1]); return -1; }
      case 'array.slice': { if (Array.isArray(args[0]) && typeof args[1] === 'number') { const to = typeof args[2] === 'number' ? args[2] : args[0].length; return args[0].slice(args[1], to); } return []; }
      case 'array.join': { if (Array.isArray(args[0])) return args[0].map(String).join(typeof args[1] === 'string' ? args[1] : ','); return ''; }
      case 'array.copy': { if (Array.isArray(args[0])) return [...args[0]]; return []; }
      case 'array.reverse': { if (Array.isArray(args[0])) { args[0].reverse(); } return null; }
      case 'array.sort': { if (Array.isArray(args[0])) { args[0].sort(typeof args[1] === 'string' && args[1] === 'desc' ? (a: any, b: any) => (b as number) - (a as number) : (a: any, b: any) => (a as number) - (b as number)); } return null; }
      case 'array.fill': { if (Array.isArray(args[0])) { const from = typeof args[2] === 'number' ? args[2] : 0; const to = typeof args[3] === 'number' ? args[3] : args[0].length; args[0].fill(args[1], from, to); } return null; }
      case 'array.sum': { if (Array.isArray(args[0])) return args[0].reduce((s: number, v: any) => s + (typeof v === 'number' ? v : 0), 0); return 0; }
      case 'array.avg': { if (Array.isArray(args[0]) && args[0].length > 0) { const n = _numericValues(args[0]); return n.length > 0 ? n.reduce((s: number, v: number) => s + v, 0) / n.length : 0; } return 0; }
      case 'array.min': { if (Array.isArray(args[0]) && args[0].length > 0) { const n = _numericValues(args[0]); return n.length > 0 ? Math.min(...n) : 0; } return 0; }
      case 'array.max': { if (Array.isArray(args[0]) && args[0].length > 0) { const n = _numericValues(args[0]); return n.length > 0 ? Math.max(...n) : 0; } return 0; }
      case 'array.median': {
        if (Array.isArray(args[0])) {
          const n = _numericValues(args[0]).sort((a, b) => a - b);
          if (n.length === 0) return 0;
          const mid = Math.floor(n.length / 2);
          return n.length % 2 === 0 ? (n[mid - 1] + n[mid]) / 2 : n[mid];
        }
        return 0;
      }
      case 'array.stdev': {
        if (Array.isArray(args[0])) {
          const n = _numericValues(args[0]);
          if (n.length < 2) return 0;
          const m = n.reduce((s, v) => s + v, 0) / n.length;
          return Math.sqrt(n.reduce((s, v) => s + (v - m) ** 2, 0) / n.length);
        }
        return 0;
      }
      case 'array.percentile': {
        if (Array.isArray(args[0])) {
          const n = _numericValues(args[0]).sort((a, b) => a - b);
          if (n.length === 0) return 0;
          const pct = Math.max(0, Math.min(100, typeof args[1] === 'number' ? args[1] : 50));
          const idx = (pct / 100) * (n.length - 1);
          const lo = Math.floor(idx), hi = Math.ceil(idx);
          if (lo === hi) return n[lo];
          return n[lo] + (n[hi] - n[lo]) * (idx - lo);
        }
        return 0;
      }
      case 'array.head': { if (Array.isArray(args[0]) && typeof args[1] === 'number') return args[0].slice(0, Math.max(0, args[1])); return []; }
      case 'array.tail': { if (Array.isArray(args[0]) && typeof args[1] === 'number') return args[0].slice(-Math.max(0, args[1])); return []; }
      case 'array.first': { if (Array.isArray(args[0]) && args[0].length > 0) return args[0][0]; return null; }
      case 'array.last': { if (Array.isArray(args[0]) && args[0].length > 0) return args[0][args[0].length - 1]; return null; }
      case 'array.range': {
        const start = typeof args[0] === 'number' ? args[0] : 0;
        const end = typeof args[1] === 'number' ? args[1] : 0;
        const step = typeof args[2] === 'number' ? args[2] : (start <= end ? 1 : -1);
        const r: number[] = [];
        if (step > 0) { for (let i = start; i <= end; i += step) r.push(i); }
        else { for (let i = start; i >= end; i += step) r.push(i); }
        return r;
      }
      case 'oakring': {
        const cap = typeof args[0] === 'number' && args[0] > 0 ? Math.floor(args[0]) : 10;
        return createOakRing(cap);
      }
      case 'matrix': {
        const rows = typeof args[0] === 'number' && args[0] > 0 ? Math.floor(args[0]) : 1;
        const cols = typeof args[1] === 'number' && args[1] > 0 ? Math.floor(args[1]) : 1;
        const val = args.length >= 3 && typeof args[2] === 'number' ? args[2] : 0;
        return createMatrix(rows, cols, val);
      }

      default: {
        // User-defined function (f(x) => ...) — builtins take precedence
        // (all cases above), then user functions, then object methods.
        if (callee.type === 'Identifier' && ctx.userFuncs.has(funcName)) {
          return callUserFunction(ctx.userFuncs.get(funcName)!, args, ctx);
        }
        // funcName (the flattened dottedName, e.g. "m.set", "ring.push")
        // didn't match any recognized builtin/namespace case — that's
        // expected for a method call on a user variable (Matrix/OakRing
        // instance), since dottedName flattening was designed for literal
        // namespace keywords like array./color./label., not arbitrary
        // variable names. This used to unconditionally `return null` here,
        // which ran BEFORE the real object-method dispatch below could ever
        // execute (dottedName is truthy for any `x.y(...)` call, so the
        // `callee.type === 'MemberExpr'` branch further down was dead code
        // for this whole class of call) — every Matrix.set/get and every
        // OakRing.push/avg/etc. call silently no-op'd, always returning
        // null/0 regardless of what was actually pushed/set. Dispatch to
        // the real object method instead of giving up.
        if (callee.type === 'MemberExpr') {
          const obj = evaluateExpression((callee as MemberExpr).object, ctx);
          const prop = (callee as MemberExpr).property;
          const member = (obj as any)?.[prop];
          if (typeof member === 'function') return member.apply(obj, args);
        }
        return null;
      }
    }
  }

  if (callee.type === 'MemberExpr') {
    const obj = evaluateExpression((callee as MemberExpr).object, ctx);
    const prop = (callee as MemberExpr).property;
    const member = (obj as any)?.[prop];
    // If the property is a function AND we already have evaluated args
    // (i.e., this was reached via dottedName fallthrough), call the method
    if (typeof member === 'function' && dottedName) {
      return member.apply(obj, args);
    }
    if (typeof obj === 'string') {
      if (prop === 'tostring') return obj;
    }
    return member ?? null;
  }

  return null;
}

function evaluateIndex(expr: IndexExpr, ctx: RuntimeContext): RuntimeValue {
  const objExpr = expr.object;
  const obj = evaluateExpression(objExpr, ctx);
  const idx = evaluateExpression(expr.index, ctx);

  // Series lookback: close[5] = close value from 5 bars ago
  if (typeof obj === 'number' && typeof idx === 'number') {
    // Negative lookback would read a FUTURE bar (repainting lookahead) —
    // clamp to the current value so no script can peek ahead.
    if (idx < 0) return obj;
    // Check if obj came from a built-in series (close, open, etc.)
    if (objExpr.type === 'Identifier') {
      const name = (objExpr as Identifier).name;
      if (['close', 'open', 'high', 'low', 'volume', 'time'].includes(name)) {
        const lookback = Math.round(idx);
        const target = ctx.barIndex - lookback;
        if (target >= 0 && target < ctx.bars.close.length) {
          return (ctx.bars as any)[name][target];
        }
      }
    }
    // Check if obj came from a user series variable (ema, sma result, etc.)
    // Look up seriesHistory for the object expression node
    const hist = ctx.seriesHistory.get(objExpr);
    if (hist && hist.length > 0) {
      const lookback = Math.round(idx);
      const target = ctx.barIndex - lookback;
      if (target >= 0 && target < hist.length) {
        return hist[target];
      }
    }
    // Also try seriesByName for the variable name
    if (objExpr.type === 'Identifier') {
      const varHist = ctx.seriesByName.get((objExpr as Identifier).name);
      if (varHist && varHist.length > 0) {
        const lookback2 = Math.round(idx);
        const target2 = ctx.barIndex - lookback2;
        if (target2 >= 0 && target2 < varHist.length) {
          return varHist[target2];
        }
      }
    }
    // For any other number indexed by number, return the number (it's just a scalar)
    return obj;
  }

  if (typeof obj === 'string' && typeof idx === 'number') {
    return obj[idx] || '';
  }
  if (Array.isArray(obj) && typeof idx === 'number') {
    return obj[idx] ?? null;
  }
  // OakRing indexing: ring[0] = newest, ring[size-1] = oldest
  if (typeof idx === 'number' && obj && typeof obj === 'object' && (obj as any)._type === 'OakRing') {
    const r = obj as any;
    const sz = r.size;
    if (sz === 0) return null;
    // Normalize negative index: -1 = oldest (first pushed)
    const i = idx >= 0 ? sz - 1 - idx : Math.abs(idx) - 1;
    if (i < 0 || i >= sz) return null;
    const arr = r.toArray();
    return arr[i] ?? null;
  }
  // Matrix indexing: m[row] returns row array
  if (typeof idx === 'number' && obj && typeof obj === 'object' && (obj as any)._type === 'Matrix') {
    const m = obj as any;
    const r = m._data[idx];
    return r ? [...r] : null;
  }
  if (typeof idx === 'string' && typeof obj === 'object' && obj !== null) {
    return (obj as any)[idx] ?? null;
  }
  return null;
}

function evaluateMember(expr: MemberExpr, ctx: RuntimeContext): RuntimeValue {
  const obj = evaluateExpression(expr.object, ctx);
  if (typeof obj === 'object' && obj !== null) {
    return (obj as any)[expr.property] ?? null;
  }
  return null;
}

function buildSeries(node: ASTNode, ctx: RuntimeContext): number[] {
  if (node.type === 'Identifier') {
    const name = (node as Identifier).name;
    if (['close', 'open', 'high', 'low', 'volume', 'time'].includes(name)) {
      return (ctx.bars as any)[name].slice(0, ctx.barIndex + 1);
    }
  }

  const history = ctx.seriesHistory.get(node);
  if (history && history.length > 0) {
    if (history.length < ctx.barIndex + 1) {
      const padded = [...history];
      const lastVal = history[history.length - 1];
      while (padded.length <= ctx.barIndex) padded.push(lastVal);
      return padded;
    }
    return history.slice(0, ctx.barIndex + 1);
  }

  // Fallback to evaluating the node
  const value = evaluateExpression(node, ctx);
  if (Array.isArray(value)) return value as number[];
  const numVal = typeof value === 'number' ? value : 0;
  const series: number[] = [];
  for (let i = 0; i <= ctx.barIndex; i++) {
    series.push(i < ctx.barIndex ? ctx.bars.close[i] : numVal);
  }
  return series;
}

// ─── security() — confirmed-only multi-timeframe aggregation ───────
// Timeframe -> ms lookup, deliberately self-contained (duplicated, not
// imported from data-generator.ts, which already has its own private
// TIMEFRAMES_MS with identical values). interpreter.ts currently has
// zero imports from outside oakscript/ and is bundled into a real Web
// Worker (backtest/worker.ts) — importing data-generator.ts's ~400-line,
// DOM/fetch-adjacent module for 12 numbers would trade that provable
// Worker-safety guarantee for a trivial saving.
const SECURITY_TIMEFRAME_MS: Record<string, number> = {
  '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000,
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000,
};

function medianBarGapMs(times: number[]): number {
  if (times.length < 2) return Infinity;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

// Confirmed-only HTF aggregation: result[i] is the last FULLY CLOSED
// higher-timeframe bucket's value as of bar i — never the still-forming
// one (that would repaint/lookahead). NaN until the first bucket has
// closed — same "withhold with NaN until confirmed" idiom StdLib's
// pivothigh/pivotlow already use (runtime.ts), just triggered by a
// timeframe-bucket boundary crossing instead of a fixed left/right window.
function computeConfirmedHtfSeries(
  times: number[], values: number[], htfMs: number, medianGap: number,
  ohlcField: 'open' | 'high' | 'low' | 'close' | null,
): number[] {
  const result = new Array(times.length).fill(NaN);
  // Guard: requesting a timeframe at or finer than what's actually loaded
  // is nonsensical (nothing to downsample) — 1.5x sits safely below the
  // smallest real adjacent-tier ratio in the Timeframe union (2x, e.g.
  // 30m->1h) while still reliably catching same-timeframe requests under
  // minor real-world timestamp jitter (e.g. live gaps averaging 59998ms
  // instead of exactly 60000ms, which a bare `<=` would miss).
  if (!Number.isFinite(medianGap) || htfMs < medianGap * 1.5) return result;

  let curBucket: number | null = null;
  let running = NaN;
  let lastConfirmed = NaN;
  for (let i = 0; i < times.length; i++) {
    const bId = Math.floor(times[i] / htfMs);
    if (curBucket === null || bId !== curBucket) {
      if (curBucket !== null) lastConfirmed = running; // previous bucket just closed
      curBucket = bId;
      running = values[i]; // seed new bucket
    } else if (ohlcField === 'high') running = Math.max(running, values[i]);
    else if (ohlcField === 'low') running = Math.min(running, values[i]);
    else if (ohlcField !== 'open') running = values[i]; // close/volume/time/derived: last value wins
    result[i] = lastConfirmed;
  }
  return result;
}

function isTruthy(val: RuntimeValue, ctx?: RuntimeContext): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0 && !isNaN(val);
  if (typeof val === 'string') return val.length > 0;
  // Series arrays (from crossover, comparisons, etc.) — check the current bar's value
  if (Array.isArray(val) && ctx) {
    const v = val[ctx.barIndex];
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && !isNaN(v);
    return !!v;
  }
  return true;
}
