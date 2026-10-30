/**
 * Intent mutants: for each indicator family a request can name, take a shipped
 * script that really computes it, remove the family (every call replaced by a
 * neutral series), and require the request-coverage gate to report the missing
 * concept. The intact script must not be reported. Usage:
 *   npx tsx tools/verify/intent-mutants-test.ts
 */
import { getIndicators } from '../../apps/web/src/oakscript/indicators';
import { checkRequestCoverage } from '../../apps/web/src/trade-advisor/request-coverage';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
};

const CASES = [
  { label: 'RSI', fn: 'rsi', request: 'Build an RSI indicator with buy and sell signals.' },
  { label: 'EMA', fn: 'ema', request: 'Build an EMA ribbon with buy and sell signals.' },
  { label: 'MACD', fn: 'macd', request: 'Build a MACD indicator with buy and sell signals.' },
  { label: 'ATR', fn: 'atr', request: 'Build an ATR trailing stop indicator with buy and sell signals.' },
  { label: 'Stochastic', fn: 'stoch', request: 'Build a Stochastic oscillator with zone-gated buy and sell signals.' },
  { label: 'VWAP', fn: 'vwap', request: 'Build VWAP bands with buy and sell signals.' },
];

const callOf = (fn: string) => new RegExp(`(?<![\\w.])${fn}\\s*\\(`);

/** Replace every call to `fn(...)` with the neutral series `close`, matching parentheses. */
function neutralize(src: string, fn: string): string {
  const re = new RegExp(`(?<![\\w.])${fn}\\s*\\(`, 'g');
  let out = src;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) break;
    out = out.slice(0, m.index) + 'close' + out.slice(end + 1);
    re.lastIndex = m.index + 'close'.length;
  }
  return out;
}

/** A coverage message that names the missing requested concept. */
const reportsMissing = (problem: string, label: string) =>
  new RegExp(`request asks for ${label}\\b`, 'i').test(problem) && /never computes/i.test(problem);

/** Builtins that count as separate families, so a reference uses as few others as possible. */
const OTHER_BUILTINS = ['ema', 'sma', 'rsi', 'macd', 'atr', 'stoch', 'vwap', 'cci', 'adx', 'mfi', 'stdev'];
const familyCount = (source: string) => OTHER_BUILTINS.filter(b => callOf(b).test(source)).length;

let caught = 0;
let falsePositives = 0;
for (const c of CASES) {
  const candidates = getIndicators().filter(d => callOf(c.fn).test(d.source));
  const ref = candidates.sort((a, b) => familyCount(a.source) - familyCount(b.source))[0];
  if (!ref) {
    check(`intent: a shipped script computes ${c.label}`, false, 'no reference script found');
    continue;
  }
  const intact = checkRequestCoverage(c.request, ref.source, { prefer3D: true });
  const flagged = intact.some(p => reportsMissing(p, c.label));
  if (flagged) falsePositives++;
  check(`intent: the intact ${c.label} script (${ref.name}) is not reported missing`, !flagged,
    flagged ? intact.find(p => reportsMissing(p, c.label))! : 'computed, not reported');

  const mutant = neutralize(ref.source, c.fn);
  const problems = checkRequestCoverage(c.request, mutant, { prefer3D: true });
  const hit = problems.find(p => reportsMissing(p, c.label));
  if (hit) caught++;
  check(`intent: removing ${c.label} from a script that asks for it is caught`, !!hit,
    hit ?? `not reported (${problems.length} other problems)`);
}

console.log(`\nINTENT MUTANTS: ${caught}/${CASES.length} missing concepts caught · ${falsePositives}/${CASES.length} intact scripts reported`);
console.log(`INTENT TESTS: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
