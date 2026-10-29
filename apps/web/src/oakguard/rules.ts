/**
 * OakGuard rule engine — compiles a declarative RuleSpec into per-source
 * issues. Token-based and line-numbered, mirroring validator.ts's style.
 * This is the ONLY form a candidate may take: data, not code.
 */
import { tokenize, type Token } from '../oakscript/lexer';
import { BUILTIN_REGISTRY } from '../oakscript/builtins';
import type { RuleIssue, RuleSpec } from './types';

/** Length-argument positions (0-based) for builtins whose window must be a positive integer. */
export const LENGTH_ARG_POSITIONS: Record<string, number[]> = {
  sma: [1], ema: [1], wma: [1], hma: [1], rma: [1], vwma: [1], rsi: [1],
  highest: [1], lowest: [1], stdev: [1], roc: [1], median: [1],
  macd: [1, 2, 3],
  linreg: [1], correlation: [2],
  atr: [3], cci: [3], adx: [3], stoch: [3], mfi: [4], cmf: [4],
  pivothigh: [1, 2], pivotlow: [1, 2],
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
    sites.push({ name, line: t.line, args });
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

export function evaluateRuleOnSource(rule: RuleSpec, source: string): RuleIssue[] {
  const tokens = tokenize(source);
  const sites = findCallSites(tokens);
  const issues: RuleIssue[] = [];

  if (rule.family === 'positive-int-length') {
    for (const site of sites) {
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
            fix: `Use a positive integer length, e.g. ${site.name}(close, 14).`,
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
        fix: 'Check the dotted builtin list (array.*, line.new, table.cell, model.*, color.*, consensus.*, ml.predict, rl.action) or call a method on an OakRing/Matrix/handle object.',
        ruleId: rule.id,
      });
    }
  }

  return issues;
}

/** The candidate catalogue — what the (fixed) agent proposes in the demo. Specs only. */
export const CANDIDATE_CATALOGUE: RuleSpec[] = [
  {
    id: 'cand-length-v1',
    name: 'Positive-Integer Lookback Lengths',
    family: 'positive-int-length',
    issueCode: 'INVALID_LENGTH_ARG',
    severity: 'error',
    description: 'Every length/window argument of a series builtin must be a positive-integer literal.',
    rationale: 'Seed failure sma(close, 0) executed to an all-NaN series while the baseline validator reported the script valid. RSI/EMA with non-positive or fractional lengths produce garbage or intermittent NaNs.',
    proposedBy: 'oakguard-agent (fixed model, candidate catalogue #1)',
  },
  {
    id: 'cand-dotted-naive-v1',
    name: 'Unknown Dotted Calls (naive)',
    family: 'unknown-dotted-call',
    issueCode: 'UNKNOWN_DOTTED_FUNCTION',
    severity: 'error',
    description: 'Flag every dotted call that is not in the builtin registry.',
    rationale: 'Dotted typos (array.pushh, m.macdd-style calls) silently return 0/null because the validator skips dotted names. This naive form has no object-method allowlist.',
    proposedBy: 'oakguard-agent (fixed model, candidate catalogue #2)',
  },
  {
    id: 'cand-dotted-refined-v1',
    name: 'Unknown Dotted Calls (refined)',
    family: 'unknown-dotted-call',
    issueCode: 'UNKNOWN_DOTTED_FUNCTION',
    severity: 'error',
    description: 'Flag dotted calls outside the registry, allowing known OakRing/Matrix/handle object methods.',
    rationale: 'Refinement of the naive candidate: runtime objects (OakRing, Matrix, table handles) expose methods that are not registry builtins and must not be flagged.',
    proposedBy: 'oakguard-agent (fixed model, candidate catalogue #3)',
    allowObjectMethods: true,
  },
];

export function failureSignature(rule: RuleSpec): string {
  return `${rule.family}:${rule.allowObjectMethods ? 'refined' : 'naive'}:${rule.issueCode}`;
}
