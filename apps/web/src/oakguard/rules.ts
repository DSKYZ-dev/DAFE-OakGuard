/**
 * OakGuard rule engine — compiles a declarative RuleSpec into per-source
 * issues. Token-based and line-numbered, mirroring validator.ts's style.
 * This is the ONLY form a candidate may take: data, not code.
 */
import { tokenize, type Token } from '../oakscript/lexer';
import { BUILTIN_REGISTRY } from '../oakscript/builtins';
import type { DefectClass, RuleFamily, RuleIssue, RuleParams, RuleSpec, WindowOperator } from './types';

/** Length-argument positions (0-based) for builtins whose window must be a positive integer. */
export const LENGTH_ARG_POSITIONS: Record<string, number[]> = {
  sma: [1], ema: [1], wma: [1], hma: [1], rma: [1], vwma: [1], rsi: [1],
  highest: [1], lowest: [1], stdev: [1], roc: [1], median: [1],
  macd: [1, 2, 3],
  linreg: [1], correlation: [2],
  atr: [3], cci: [3], adx: [3], stoch: [3], mfi: [4], cmf: [4],
  pivothigh: [1, 2], pivotlow: [1, 2],
};

export const RULE_FAMILIES: RuleFamily[] = ['positive-int-length', 'unknown-dotted-call', 'self-inclusive-window'];
export const WINDOW_OPERATORS: WindowOperator[] = ['>', '<', '>=', '<=', '==', 'crossover', 'crossunder'];

/** The escape class each family was built for. Used only for the hand-written catalogue;
 *  model candidates are scored against the class of the escape they answer. */
export const FAMILY_DEFECT_CLASS: Record<RuleFamily, DefectClass> = {
  'positive-int-length': 'dead-length',
  'unknown-dotted-call': 'silent-call',
  'self-inclusive-window': 'impossible-breakout',
};

const DOTTED_BUILTINS = new Set(
  BUILTIN_REGISTRY.map(d => d.name).filter(n => n.includes('.')),
);

/** Methods that exist on runtime objects (OakRing / Matrix / table handles), not in the builtin registry. */
export const OBJECT_METHOD_ALLOWLIST = new Set([
  'push', 'pop', 'shift', 'unshift', 'first', 'last', 'clear', 'toArray', 'fill',
  'sum', 'avg', 'min', 'max', 'median', 'std', 'stdev', 'percentile', 'size',
  'get', 'set', 'row', 'col', 'transpose', 'multiply', 'add', 'subtract',
  'cell', 'delete', 'includes', 'indexOf', 'slice', 'copy', 'reverse', 'sort', 'join',
]);

interface CallSite {
  name: string;
  line: number;
  /** Token index of the callee's first token. */
  start: number;
  /** Token index of the closing ')'. */
  close: number;
  /** Token-index ranges [start, end) of each top-level argument. */
  args: Array<{ start: number; end: number }>;
}

function findCallSites(tokens: Token[]): CallSite[] {
  const sites: CallSite[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'IDENTIFIER' && t.type !== 'KEYWORD') continue;
    if (tokens[i - 1]?.value === '.') continue;
    let name = t.value;
    let nameEnd = i;
    // Fold dotted names: root '.' suffix
    if (tokens[i + 1]?.value === '.' && tokens[i + 2] && (tokens[i + 2].type === 'IDENTIFIER' || tokens[i + 2].type === 'KEYWORD')) {
      name = `${t.value}.${tokens[i + 2].value}`;
      nameEnd = i + 2;
    }
    let j = nameEnd + 1;
    while (j < tokens.length && tokens[j].type === 'PUNCTUATION' && tokens[j].value !== '(') j++;
    if (j >= tokens.length || tokens[j].value !== '(') continue;
    // Walk args tracking (), [] depth like validator.ts
    const args: Array<{ start: number; end: number }> = [];
    let pDepth = 0, bDepth = 0;
    let argStart = j + 1;
    let k = j + 1;
    for (; k < tokens.length; k++) {
      const nt = tokens[k];
      if (nt.value === '(') { pDepth++; continue; }
      if (nt.value === ')') {
        if (pDepth === 0) break;
        pDepth--; continue;
      }
      if (nt.value === '[') { bDepth++; continue; }
      if (nt.value === ']') { bDepth = Math.max(0, bDepth - 1); continue; }
      if (nt.value === ',' && pDepth === 0 && bDepth === 0) {
        args.push({ start: argStart, end: k });
        argStart = k + 1;
      }
    }
    if (argStart < k) args.push({ start: argStart, end: k });
    sites.push({ name, line: t.line, start: i, close: k, args });
  }
  return sites;
}

/** If an arg token-range is a plain numeric literal, return its value and raw text. */
function numericLiteral(tokens: Token[], range: { start: number; end: number }): { value: number; raw: string } | null {
  const slice = tokens.slice(range.start, range.end).filter(t => t.type !== 'EOF');
  if (slice.length === 1 && slice[0].type === 'NUMBER') {
    return { value: parseFloat(slice[0].value), raw: slice[0].value };
  }
  if (slice.length === 2 && slice[0].value === '-' && slice[1].type === 'NUMBER') {
    return { value: -parseFloat(slice[1].value), raw: `-${slice[1].value}` };
  }
  return null;
}

// ─── self-inclusive-window ──────────────────────────────────────────
//
// highest(src, n) includes the current bar, so on that bar it is never below
// src (and never below close/open/low when src is high). A strict
// "price > highest(...)" or crossover(price, highest(...)) on the same bar is
// therefore impossible and the signal never fires. lowest() mirrors it.
// A [k >= 1] offset on the window (hh[1], highest(high, 20)[1]) is the fix.

const PRICE_FIELDS = new Set(['open', 'high', 'low', 'close']);

/** A same-bar window value: highest/lowest over a plain price series, with no history offset. */
interface WindowAtom { kind: 'window'; fn: 'highest' | 'lowest'; src: string }
interface PriceAtom { kind: 'price'; name: string }
type Atom = WindowAtom | PriceAtom | null;

/** Statement-level `name = highest(src, n)` bindings (last binding wins). */
function windowBindings(tokens: Token[], sites: CallSite[], fns: Set<string>): Map<string, WindowAtom> {
  const bySite = new Map<number, CallSite>();
  for (const s of sites) bySite.set(s.start, s);
  const out = new Map<string, WindowAtom>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'IDENTIFIER') continue;
    const op = tokens[i + 1];
    if (op.value !== '=' && op.value !== ':=') continue;
    // Statement start: first token on its line (or after `var`).
    const prev = tokens[i - 1];
    if (prev && prev.line === t.line && prev.value !== 'var' && prev.value !== 'varip') continue;
    const site = bySite.get(i + 2);
    const atom = site ? windowCallAtom(tokens, site, fns) : null;
    // The whole right-hand side must be the call (nothing after it on the line).
    if (atom && site && (tokens[site.close + 1]?.line !== t.line || tokens[site.close + 1]?.type === 'EOF')) {
      out.set(t.value, atom);
    } else {
      out.delete(t.value);
    }
  }
  return out;
}

function windowCallAtom(tokens: Token[], site: CallSite, fns: Set<string>): WindowAtom | null {
  if (!fns.has(site.name) || site.args.length < 2) return null;
  const src = tokens.slice(site.args[0].start, site.args[0].end);
  if (src.length !== 1 || !PRICE_FIELDS.has(src[0].value)) return null;
  return { kind: 'window', fn: site.name as 'highest' | 'lowest', src: src[0].value };
}

/** Classify the token range [start, end) as exactly one atom, or null. */
function atomOf(tokens: Token[], start: number, end: number, sites: Map<number, CallSite>, fns: Set<string>, vars: Map<string, WindowAtom> | null): Atom {
  if (end <= start) return null;
  const first = tokens[start];
  // A call spanning the whole range.
  const site = sites.get(start);
  if (site && site.close === end - 1) return windowCallAtom(tokens, site, fns);
  if (end - start === 1 && (first.type === 'IDENTIFIER' || first.type === 'KEYWORD')) {
    if (PRICE_FIELDS.has(first.value)) return { kind: 'price', name: first.value };
    const bound = vars?.get(first.value);
    if (bound) return bound;
  }
  // `x[0]` is still the same bar.
  if (end - start === 4 && tokens[start + 1].value === '[' && tokens[start + 2].value === '0' && tokens[start + 3].value === ']') {
    return atomOf(tokens, start, start + 1, sites, fns, vars);
  }
  return null;
}

const LEFT_BOUNDARY = new Set(['(', ',', '{', '=', ':=', '?', ':', 'and', 'or', 'not', 'if', 'while', '!', '&&', '||']);
const RIGHT_BOUNDARY = new Set([')', ',', '{', '}', '?', ':', 'and', 'or', '&&', '||', ']']);

/** Operand immediately left of operator index `op`: walk back over one atom. */
function leftOperand(tokens: Token[], op: number): [number, number] | null {
  let i = op - 1;
  if (i < 0) return null;
  let start = i;
  if (tokens[i].value === ']') {
    // skip index brackets
    let depth = 0;
    for (; i >= 0; i--) {
      if (tokens[i].value === ']') depth++;
      else if (tokens[i].value === '[' && --depth === 0) break;
    }
    i--;
    start = i;
  }
  if (i >= 0 && tokens[i].value === ')') {
    let depth = 0;
    for (; i >= 0; i--) {
      if (tokens[i].value === ')') depth++;
      else if (tokens[i].value === '(' && --depth === 0) break;
    }
    i--; // callee
    start = i;
  }
  if (start < 0 || (tokens[start].type !== 'IDENTIFIER' && tokens[start].type !== 'KEYWORD')) return null;
  const before = tokens[start - 1];
  if (before && before.line === tokens[start].line && !LEFT_BOUNDARY.has(before.value)) return null;
  return [start, op];
}

/** Operand immediately right of operator index `op`: one identifier or call, optional [..]. */
function rightOperand(tokens: Token[], op: number): [number, number] | null {
  const start = op + 1;
  const first = tokens[start];
  if (!first || (first.type !== 'IDENTIFIER' && first.type !== 'KEYWORD')) return null;
  let i = start + 1;
  if (tokens[i]?.value === '(') {
    let depth = 0;
    for (; i < tokens.length; i++) {
      if (tokens[i].value === '(') depth++;
      else if (tokens[i].value === ')' && --depth === 0) break;
    }
    i++;
  }
  if (tokens[i]?.value === '[') {
    let depth = 0;
    for (; i < tokens.length; i++) {
      if (tokens[i].value === '[') depth++;
      else if (tokens[i].value === ']' && --depth === 0) break;
    }
    i++;
  }
  const after = tokens[i];
  if (after && after.type !== 'EOF' && after.line === first.line && !RIGHT_BOUNDARY.has(after.value)) return null;
  return [start, i];
}

/** True when price can never be strictly beyond the same-bar window. */
function dominated(price: PriceAtom, w: WindowAtom): boolean {
  if (price.name === w.src) return true;
  return (w.fn === 'highest' && w.src === 'high') || (w.fn === 'lowest' && w.src === 'low');
}

/** Normalise `a OP b` to (price, window, relation). relation 'above' = price must exceed a highest(). */
function windowComparison(a: Atom, b: Atom, op: WindowOperator): { price: PriceAtom; win: WindowAtom; op: WindowOperator } | null {
  const flip: Record<string, WindowOperator> = { '>': '<', '<': '>', '>=': '<=', '<=': '>=', '==': '==' };
  if (a?.kind === 'price' && b?.kind === 'window') return { price: a, win: b, op };
  if (a?.kind === 'window' && b?.kind === 'price' && flip[op]) return { price: b, win: a, op: flip[op] };
  return null;
}

/** Does the comparison, as written, match the family's flagging semantics for `op`? */
function flaggedRelation(price: PriceAtom, win: WindowAtom, op: WindowOperator): boolean {
  if (!dominated(price, win)) return false;
  if (win.fn === 'highest') return op === '>' || op === 'crossover' || op === '>=' || op === '==';
  return op === '<' || op === 'crossunder' || op === '<=' || op === '==';
}

function selfInclusiveIssues(rule: RuleSpec, tokens: Token[], sites: CallSite[]): RuleIssue[] {
  const p = rule.params || {};
  const fns = new Set<string>(p.windowFunctions?.length ? p.windowFunctions : ['highest', 'lowest']);
  const ops = new Set<WindowOperator>(p.operators?.length ? p.operators : ['>', '<', 'crossover', 'crossunder']);
  const siteMap = new Map<number, CallSite>();
  for (const s of sites) siteMap.set(s.start, s);
  const vars = p.followVariables ? windowBindings(tokens, sites, fns) : null;
  const issues: RuleIssue[] = [];
  const seenLines = new Set<number>();
  const report = (line: number, text: string, win: WindowAtom, op: WindowOperator): void => {
    if (seenLines.has(line)) return;
    seenLines.add(line);
    const strict = op === '>' || op === '<' || op === 'crossover' || op === 'crossunder';
    issues.push({
      line,
      code: rule.issueCode,
      severity: rule.severity,
      message: strict
        ? `${text}: ${win.fn}(${win.src}, n) includes the current bar, so this condition can never be true and the signal never fires.`
        : `${text}: ${win.fn}(${win.src}, n) includes the current bar, so this is only true on an exact tie with the current bar.`,
      fix: rule.fixHint || `Compare against the previous bar's window: ${win.fn}(${win.src}, n)[1] (or x[1] for a stored level).`,
      ruleId: rule.id,
    });
  };

  // Infix comparisons.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'OPERATOR' || !['>', '<', '>=', '<=', '=='].includes(t.value)) continue;
    const op = t.value as WindowOperator;
    const l = leftOperand(tokens, i);
    const r = rightOperand(tokens, i);
    if (!l || !r) continue;
    const cmp = windowComparison(
      atomOf(tokens, l[0], l[1], siteMap, fns, vars),
      atomOf(tokens, r[0], r[1], siteMap, fns, vars),
      op,
    );
    if (!cmp || !ops.has(cmp.op) || !flaggedRelation(cmp.price, cmp.win, cmp.op)) continue;
    report(t.line, `"${cmp.price.name} ${cmp.op} ${cmp.win.fn}(${cmp.win.src}, …)"`, cmp.win, cmp.op);
  }

  // crossover(a, b) / crossunder(a, b).
  for (const s of sites) {
    if ((s.name !== 'crossover' && s.name !== 'crossunder') || s.args.length !== 2) continue;
    if (!ops.has(s.name)) continue;
    const a = atomOf(tokens, s.args[0].start, s.args[0].end, siteMap, fns, vars);
    const b = atomOf(tokens, s.args[1].start, s.args[1].end, siteMap, fns, vars);
    if (a?.kind !== 'price' || b?.kind !== 'window') continue;
    if (!flaggedRelation(a, b, s.name)) continue;
    report(s.line, `"${s.name}(${a.name}, ${b.fn}(${b.src}, …))"`, b, s.name);
  }
  return issues;
}

export function evaluateRuleOnSource(rule: RuleSpec, source: string): RuleIssue[] {
  const tokens = tokenize(source);
  const sites = findCallSites(tokens);
  const issues: RuleIssue[] = [];

  if (rule.family === 'positive-int-length') {
    const only = rule.params?.functions?.length ? new Set(rule.params.functions) : null;
    for (const site of sites) {
      if (only && !only.has(site.name)) continue;
      const positions = LENGTH_ARG_POSITIONS[site.name];
      if (!positions) continue;
      for (const pos of positions) {
        const range = site.args[pos];
        if (!range) continue;
        const lit = numericLiteral(tokens, range);
        if (!lit) continue; // dynamic (input/var) lengths are out of scope for the literal rule
        if (!Number.isInteger(lit.value) || lit.value <= 0) {
          issues.push({
            line: site.line,
            code: rule.issueCode,
            severity: rule.severity,
            message: `${site.name}() length argument ${lit.raw} is not a positive integer — the series computes to NaN/garbage and the indicator silently renders nothing.`,
            fix: rule.fixHint || `Use a positive integer length, e.g. ${site.name}(close, 14).`,
            ruleId: rule.id,
          });
        }
      }
    }
  }

  if (rule.family === 'unknown-dotted-call') {
    for (const site of sites) {
      if (!site.name.includes('.')) continue;
      if (DOTTED_BUILTINS.has(site.name)) continue;
      const suffix = site.name.split('.')[1];
      if (rule.allowObjectMethods && OBJECT_METHOD_ALLOWLIST.has(suffix)) continue;
      issues.push({
        line: site.line,
        code: rule.issueCode,
        severity: rule.severity,
        message: `'${site.name}()' is not an OakScript builtin — the call silently returns 0/null.`,
        fix: rule.fixHint || 'Check the dotted builtin list (array.*, line.new, table.cell, model.*, color.*, consensus.*, ml.predict, rl.action) or call a method on an OakRing/Matrix/handle object.',
        ruleId: rule.id,
      });
    }
  }

  if (rule.family === 'self-inclusive-window') {
    issues.push(...selfInclusiveIssues(rule, tokens, sites));
  }

  return issues;
}

// ─── Candidate spec validation ──────────────────────────────────────

/** Issue codes the baseline validator already owns; a candidate may not shadow them. */
export const RESERVED_ISSUE_CODES = new Set([
  'EQ_IN_CONDITION', 'INPUT_NO_ASSIGN', 'PINE_NAMESPACE', 'PINE_MATH', 'PINE_SHAPE', 'PINE_COLOR',
  'PINE_INPUT', 'PINE_DECLARATION', 'PINE_STRATEGY', 'PINE_NA', 'NAMED_ARGS', 'VAR_DYNAMIC_INIT',
  'FUTURE_INDEX', 'PLOT_IN_CONDITIONAL', 'PLOTSHAPE_UNCONDITIONAL', 'STRATEGY_CALL_UNCONDITIONAL',
  'OBJECT_NO_ID_UNCONDITIONAL', 'OBJECT_STATIC_ID_IN_CONDITIONAL', 'UNKNOWN_FUNCTION', 'UNDEFINED_VAR',
  'PARSE_ERROR', 'UNMATCHED_PAREN', 'UNMATCHED_BRACE', 'UNMATCHED_BRACKET', 'UNCLOSED_PAREN',
  'UNCLOSED_BRACE', 'UNCLOSED_BRACKET', 'ARRAY_CTOR_VALUES', 'FN_TOO_FEW_ARGS', 'FN_TOO_MANY_ARGS',
  'HLINE_INVALID_COLOR', 'PLOTSHAPE_PINE_SIGNATURE',
]);

/**
 * Check a candidate before it reaches the referee. A malformed spec is
 * rejected with a reason the proposer can act on; nothing in it is executed.
 */
export function validateRuleSpec(rule: RuleSpec): string[] {
  const errs: string[] = [];
  if (!RULE_FAMILIES.includes(rule.family)) errs.push(`Unknown family "${rule.family}". Use one of: ${RULE_FAMILIES.join(', ')}.`);
  if (!/^[A-Z][A-Z0-9_]{3,40}$/.test(rule.issueCode || '')) errs.push('issueCode must be UPPER_SNAKE_CASE, 4 to 41 characters.');
  if (RESERVED_ISSUE_CODES.has(rule.issueCode)) errs.push(`issueCode ${rule.issueCode} belongs to the baseline validator. Choose a new code.`);
  if (rule.severity !== 'error' && rule.severity !== 'warning') errs.push('severity must be "error" or "warning".');
  if (!rule.name || rule.name.length > 80) errs.push('name is required (80 characters max).');
  const p: RuleParams = rule.params || {};
  if (p.functions) {
    const bad = p.functions.filter(f => !LENGTH_ARG_POSITIONS[f]);
    if (bad.length) errs.push(`params.functions has names with no length argument: ${bad.join(', ')}.`);
  }
  if (p.windowFunctions) {
    const bad = p.windowFunctions.filter(f => f !== 'highest' && f !== 'lowest');
    if (bad.length) errs.push(`params.windowFunctions may only contain highest and lowest (got ${bad.join(', ')}).`);
  }
  if (p.operators) {
    const bad = p.operators.filter(o => !WINDOW_OPERATORS.includes(o));
    if (bad.length) errs.push(`params.operators has unknown operators: ${bad.join(', ')}.`);
  }
  return errs;
}

/** The candidate catalogue — hand-written candidate rules that the demo loads. Specs only. */
export const CANDIDATE_CATALOGUE: RuleSpec[] = [
  {
    id: 'cand-length-v1',
    name: 'Positive-Integer Lookback Lengths',
    family: 'positive-int-length',
    issueCode: 'INVALID_LENGTH_ARG',
    severity: 'error',
    description: 'Every length/window argument of a series builtin must be a positive-integer literal.',
    rationale: 'Seed failure sma(close, 0) executed to an all-NaN series while the baseline validator reported the script valid. RSI/EMA with non-positive or fractional lengths produce garbage or intermittent NaNs.',
    proposedBy: 'hand-written candidate catalogue #1',
  },
  {
    id: 'cand-dotted-naive-v1',
    name: 'Unknown Dotted Calls (naive)',
    family: 'unknown-dotted-call',
    issueCode: 'UNKNOWN_DOTTED_FUNCTION',
    severity: 'error',
    description: 'Flag every dotted call that is not in the builtin registry.',
    rationale: 'Dotted typos (array.pushh, m.macdd-style calls) silently return 0/null because the validator skips dotted names. This naive form has no object-method allowlist.',
    proposedBy: 'hand-written candidate catalogue #2',
  },
  {
    id: 'cand-dotted-refined-v1',
    name: 'Unknown Dotted Calls (refined)',
    family: 'unknown-dotted-call',
    issueCode: 'UNKNOWN_DOTTED_FUNCTION',
    severity: 'error',
    description: 'Flag dotted calls outside the registry, allowing known OakRing/Matrix/handle object methods.',
    rationale: 'Refinement of the naive candidate: runtime objects (OakRing, Matrix, table handles) expose methods that are not registry builtins and must not be flagged.',
    proposedBy: 'hand-written candidate catalogue #3',
    allowObjectMethods: true,
  },
];

/** Shape of a rule for the resurrection guard: same family + same parameters + same code = same rule. */
export function failureSignature(rule: RuleSpec): string {
  if (!rule.params) {
    return `${rule.family}:${rule.allowObjectMethods ? 'refined' : 'naive'}:${rule.issueCode}`;
  }
  const p = rule.params || {};
  const norm = {
    functions: p.functions ? [...p.functions].sort() : undefined,
    windowFunctions: p.windowFunctions ? [...p.windowFunctions].sort() : undefined,
    operators: p.operators ? [...p.operators].sort() : undefined,
    followVariables: p.followVariables ?? undefined,
    allowObjectMethods: rule.allowObjectMethods ?? undefined,
  };
  return `${rule.family}:${JSON.stringify(norm)}:${rule.issueCode}`;
}

export function defectClassOf(rule: RuleSpec): DefectClass {
  return rule.defectClass ?? FAMILY_DEFECT_CLASS[rule.family];
}
