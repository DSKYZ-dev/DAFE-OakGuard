import type { Program, ASTNode } from './ast';
import type { Identifier, NumberLiteral, StringLiteral, BooleanLiteral, ArrayLiteral, NilLiteral } from './ast';
import type { BinaryExpr, UnaryExpr, TernaryExpr, CallExpr, IndexExpr, MemberExpr } from './ast';
import type { VarDecl, Assignment, IfStatement, ForStatement, WhileStatement, ReturnStmt, ExpressionStmt } from './ast';
import type { OakPlot, OakAlert } from './runtime';
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
}

// Per-bar cap on while/for loop iterations. A buggy or pathological script
// (infinite condition, mis-scoped loop variable, etc.) would otherwise hang
// the single JS thread forever and freeze the browser tab — there is no
// other backstop. 200k is far beyond any legitimate per-bar loop workload.
const MAX_LOOP_STEPS_PER_BAR = 200_000;

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
  persist: Map<string, RuntimeValue>;
  errors: string[];
}

export function executeScript(program: Program, barData: RuntimeBarData, persist: Map<string, RuntimeValue>, inputOverrides?: Map<string, RuntimeValue>): PlotResult {
  const errors: string[] = [];
  const plots: OakPlot[] = [];
  const alerts: OakAlert[] = [];
  const allPersist = new Map(persist);
  const seriesHistory = new Map<ASTNode, number[]>();
  const cache = new Map<string, any>();
  const seriesByName = new Map<string, number[]>();

  // Execute bar by bar (PineScript execution model)
  for (let bi = 0; bi < barData.count; bi++) {
    const ctx: RuntimeContext = {
      vars: new Map(),
      persist: allPersist,
      bars: barData,
      plots,
      alerts,
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

  return { plots, alerts, persist: allPersist, errors };
}

function evaluateStatement(stmt: ASTNode, ctx: RuntimeContext): void {
  switch (stmt.type) {
    case 'VarDecl': return evaluateVarDecl(stmt as VarDecl, ctx);
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
    const srcNode = (stmt.value as CallExpr).args[0];
    const p1 = typeof ((stmt.value as CallExpr).args[1]) === 'number' ? ((stmt.value as CallExpr).args[1]) : 0;
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
      case 'cci': case 'atr': case 'adx': case 'trueRange': {
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
        // plot3d(source, name, style, color, pane)
        // source is the AST node — pass to buildSeries for full array reconstruction
        const name = typeof args[1] === 'string' ? args[1] : '3D Plot';
        const style = typeof args[2] === 'string' ? args[2] : 'surface';
        const col = typeof args[3] === 'string' ? args[3] : '#b48cff';
        const pane = typeof args[4] === 'string' ? args[4] : 'main';
        if (ctx.barIndex === ctx.bars.close.length - 1) {
          const series = buildSeries(expr.args[0], ctx);
          ctx.plots.push({
            type: 'plot3d', name, series,
            style: style as any, color: col, pane,
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
        ctx.plots.push({ type: 'hline', name: '', price, color: col, pane });
        return price;
      }

      case 'bgcolor': {
        const col = String(args[0] || '');
        const pane = typeof args[1] === 'string' && args[1] === 'separate' ? 'separate' : 'main';
        if (col) ctx.plots.push({ type: 'bgcolor', name: '', color: col, pane, barIdx: ctx.barIndex });
        return null;
      }

      case 'label': {
        const labelType = typeof args[0] === 'string' ? args[0] : 'new';
        if (labelType === 'new') {
          const x = args[1] as number;
          const y = args[2] as number;
          const text = String(args[3] || '');
          const col = typeof args[4] === 'object' ? (args[4] as any)?.color : '#ffffff';
          ctx.plots.push({ type: 'label', name: '', x, y, text, color: String(col) });
        }
        return null;
      }

      case 'label.new': {
        // label.new(x, y, text, color) — proper namespaced form.
        const x = typeof args[0] === 'number' ? args[0] : ctx.barIndex;
        const y = typeof args[1] === 'number' ? args[1] : 0;
        const text = String(args[2] ?? '');
        const col = typeof args[3] === 'string' ? args[3] : '#ffffff';
        ctx.plots.push({ type: 'label', name: '', x, y, text, color: col, barIdx: x });
        return null;
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
          });
        }
        return condition;
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
