import type { Program, ASTNode } from './ast';
import type { Identifier, NumberLiteral, StringLiteral, BooleanLiteral, ArrayLiteral, NilLiteral } from './ast';
import type { BinaryExpr, UnaryExpr, CallExpr, IndexExpr, MemberExpr } from './ast';
import type { VarDecl, Assignment, IfStatement, ForStatement, WhileStatement, ReturnStmt, ExpressionStmt } from './ast';
import type { OakPlot, OakAlert } from './runtime';
import { StdLib } from './runtime';

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
  cache: Map<string, any>;
}

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
      cache,
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
    case 'Assignment': return evaluateAssignment(stmt as Assignment, ctx);
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

function evaluateAssignment(stmt: Assignment, ctx: RuntimeContext): void {
  if (stmt.target.type === 'Identifier' && stmt.value.type === 'CallExpr') {
    const callee = (stmt.value as CallExpr).callee;
    if (callee.type === 'Identifier' && (callee as Identifier).name === 'input') {
      const name = (stmt.target as Identifier).name;
      if (ctx.inputOverrides?.has(name)) {
        const val = ctx.inputOverrides.get(name)!;
        ctx.vars.set(name, val);
        if (ctx.persist.has(name)) ctx.persist.set(name, val);
        return;
      }
    }
    // For series functions (rsi, sma, ema, etc.), copy full cached result to seriesHistory
    // so plot3d() can find it via buildSeries() from the variable identifier
    const fnName = (stmt.value as CallExpr).callee.type === 'Identifier'
      ? ((stmt.value as CallExpr).callee as Identifier).name : '';
    const srcNode = (stmt.value as CallExpr).args[0];
    const p1 = typeof ((stmt.value as CallExpr).args[1]) === 'number' ? ((stmt.value as CallExpr).args[1]) : 0;
    if (srcNode?.type === 'Identifier' && fnName) {
      const cacheKey = `${fnName}:${(srcNode as Identifier).name}:${p1}`;
      for (const [k] of ctx.cache) {
        if (k.startsWith(cacheKey)) {
          const cached = ctx.cache.get(k);
          if (Array.isArray(cached)) { ctx.seriesHistory.set(stmt.target, cached); }
          break;
        }
      }
    }
  }
  const value = evaluateExpression(stmt.value, ctx);
  evaluateAssignmentTarget(stmt.target, value, ctx);
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
    for (const s of stmt.body) { evaluateStatement(s, ctx); if (ctx.breakFlag) { ctx.breakFlag = false; return; } if (ctx.continueFlag) { ctx.continueFlag = false; break; } if (ctx.returnValue !== null) return; }
    if (stmt.update) evaluateExpression(stmt.update, ctx);
  }
}

function evaluateWhile(stmt: WhileStatement, ctx: RuntimeContext): void {
  while (isTruthy(evaluateExpression(stmt.condition, ctx), ctx)) {
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
    case 'CallExpr': return evaluateCall(expr as CallExpr, ctx);
    case 'IndexExpr': return evaluateIndex(expr as IndexExpr, ctx);
    case 'MemberExpr': return evaluateMember(expr as MemberExpr, ctx);
    case 'ArrayLiteral': return (expr as ArrayLiteral).elements.map(e => evaluateExpression(e, ctx));
    case 'Assignment': {
      const a = expr as Assignment;
      return evaluateAssignmentTarget(a.target, evaluateExpression(a.value, ctx), ctx);
    }
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
  let funcName: string;
  let args: RuntimeValue[];

  if (callee.type === 'Identifier') {
    funcName = (callee as Identifier).name;
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
        let val = args[0];
        if (val && typeof val === 'object' && 'macd' in val) {
          val = (val as any).macd;
        }
        const numericVal = typeof val === 'number' ? val : 0;
        const title = typeof args[1] === 'string' ? args[1] : '';
        let color = '#b48cff';
        let lw = 1;
        let pane: 'main' | 'separate' = 'main';
        if (typeof args[2] === 'string') {
          color = args[2];
          lw = typeof args[3] === 'number' ? args[3] : 1;
          if (args[4] === 'separate') pane = 'separate';
        } else if (typeof args[2] === 'object') {
          color = (args[2] as any)?.color || '#b48cff';
          lw = (args[2] as any)?.linewidth || 1;
          if ((args[2] as any)?.pane === 'separate') pane = 'separate';
        }
        ctx.plots.push({ type: 'line', name: title || 'plot', value: numericVal, color, linewidth: lw, pane, barIdx: ctx.barIndex });
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

      case 'plot3d': {
        // plot3d(source, name, style, color, pane)
        // source is the AST node — pass to buildSeries for full array reconstruction
        const name = typeof args[1] === 'string' ? args[1] : '3D Plot';
        const style = typeof args[2] === 'string' ? args[2] : 'surface';
        const col = typeof args[3] === 'string' ? args[3] : '#b48cff';
        const pane = typeof args[4] === 'string' && args[4] === 'separate' ? 'separate' : 'main';
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

      default: return null;
    }
  }

  if (callee.type === 'MemberExpr') {
    const obj = evaluateExpression((callee as MemberExpr).object, ctx);
    const prop = (callee as MemberExpr).property;
    if (typeof obj === 'string') {
      if (prop === 'tostring') return obj;
    }
    return (obj as any)?.[prop] ?? null;
  }

  return null;
}

function evaluateIndex(expr: IndexExpr, ctx: RuntimeContext): RuntimeValue {
  const obj = evaluateExpression(expr.object, ctx);
  const idx = evaluateExpression(expr.index, ctx);

  if (typeof obj === 'string' && typeof idx === 'number') {
    return obj[idx] || '';
  }
  if (Array.isArray(obj) && typeof idx === 'number') {
    return obj[idx] ?? null;
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
