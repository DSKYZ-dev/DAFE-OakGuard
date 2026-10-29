/**
 * OakGuard mutant generation — deterministic, seeded by construction.
 * Mutants are corrupted copies of SHIPPED indicator scripts, so every
 * mutant has a known-good parent and a known defect class.
 */
import { getIndicators } from '../oakscript/indicators';
import { LENGTH_ARG_POSITIONS } from './rules';
import type { CorpusEntry, MutantCase, RuleFamily } from './types';

export function knownGoodCorpus(): CorpusEntry[] {
  return getIndicators().map(i => ({ name: i.name, category: i.category, source: i.source }));
}

const LENGTH_CALL_RE = /\b(sma|ema|wma|hma|rma|vwma|rsi|highest|lowest|stdev|roc|median|macd|linreg|correlation|atr|cci|adx|stoch|mfi|cmf|pivothigh|pivotlow)\s*\(/g;

function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function findMatchingParen(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const MUTANT_LENGTH_VALUES = ['0', '-1', '2.5'];

export function generateLengthMutants(corpus: CorpusEntry[], cap = 240): MutantCase[] {
  const mutants: MutantCase[] = [];
  let n = 0;
  for (const entry of corpus) {
    LENGTH_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LENGTH_CALL_RE.exec(entry.source)) !== null) {
      const fn = m[1];
      const positions = LENGTH_ARG_POSITIONS[fn];
      if (!positions) continue;
      const openIdx = entry.source.indexOf('(', m.index);
      const closeIdx = findMatchingParen(entry.source, openIdx);
      if (closeIdx < 0) continue;
      const inner = entry.source.slice(openIdx + 1, closeIdx);
      const args = splitTopLevelArgs(inner);
      for (const pos of positions) {
        const raw = (args[pos] || '').trim();
        if (!/^-?\d+(\.\d+)?$/.test(raw)) continue; // literal lengths only
        for (const bad of MUTANT_LENGTH_VALUES) {
          if (bad === raw) continue;
          const mutatedArgs = [...args];
          mutatedArgs[pos] = ` ${bad}`;
          const source = entry.source.slice(0, openIdx + 1) + mutatedArgs.join(',') + entry.source.slice(closeIdx);
          n++;
          mutants.push({
            id: `mut-len-${n}`,
            family: 'positive-int-length',
            baseIndicator: entry.name,
            source,
            defect: `${fn}() length ${raw} → ${bad}`,
            heldOut: n % 3 === 2,
          });
          if (mutants.length >= cap) return mutants;
        }
      }
    }
  }
  return mutants;
}

const DOTTED_REPLACEMENTS: Array<[string, string]> = [
  ['array.push', 'array.pushh'],
  ['array.get', 'array.gett'],
  ['line.new', 'line.neww'],
  ['box.new', 'box.neww'],
  ['table.cell', 'table.celll'],
  ['model.longEntry', 'model.longEntryy'],
  ['model.exit', 'model.exitt'],
  ['color.new', 'color.neww'],
];

export function generateDottedMutants(corpus: CorpusEntry[], cap = 120): MutantCase[] {
  const mutants: MutantCase[] = [];
  let n = 0;
  for (const entry of corpus) {
    for (const [good, bad] of DOTTED_REPLACEMENTS) {
      const idx = entry.source.indexOf(good + '(');
      if (idx < 0) continue;
      const source = entry.source.slice(0, idx) + bad + entry.source.slice(idx + good.length);
      n++;
      mutants.push({
        id: `mut-dot-${n}`,
        family: 'unknown-dotted-call',
        baseIndicator: entry.name,
        source,
        defect: `${good}() → ${bad}()`,
        heldOut: n % 3 === 2,
      });
      if (mutants.length >= cap) return mutants;
    }
  }
  return mutants;
}

export function generateMutants(family: RuleFamily, corpus: CorpusEntry[]): MutantCase[] {
  return family === 'positive-int-length' ? generateLengthMutants(corpus) : generateDottedMutants(corpus);
}

/** Deterministic synthetic bars for execution probes (mulberry32, same family as mega-test). */
export function syntheticBars(count = 120): { close: number[]; open: number[]; high: number[]; low: number[]; volume: number[]; time: number[]; count: number } {
  let s = 42 >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const close: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], volume: number[] = [], time: number[] = [];
  let px = 100;
  for (let i = 0; i < count; i++) {
    const o = px;
    const c = Math.max(1, o + (rnd() - 0.48) * 4);
    close.push(c); open.push(o);
    high.push(Math.max(o, c) + rnd());
    low.push(Math.min(o, c) - rnd());
    volume.push(1000 + Math.floor(rnd() * 5000));
    time.push(1700000000000 + i * 60000);
    px = c;
  }
  return { close, open, high, low, volume, time, count };
}
