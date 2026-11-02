/**
 * OakGuard mutant generation — deterministic, seeded by construction.
 * Mutants are corrupted copies of SHIPPED indicator scripts, so every
 * mutant has a known-good parent and a known defect class.
 */
import { getIndicators } from '../oakscript/indicators';
import { LENGTH_ARG_POSITIONS } from './rules';
import { CONTRAST_SCRIPTS } from './contrast';
import type { CorpusEntry, DefectClass, MutantCase } from './types';

/** The shipped library. */
export function shippedCorpus(): CorpusEntry[] {
  return getIndicators().map(i => ({ name: i.name, category: i.category, source: i.source }));
}

/** Everything a promoted rule must leave alone: the shipped library plus the contrast scripts. */
export function knownGoodCorpus(): CorpusEntry[] {
  return [...shippedCorpus(), ...CONTRAST_SCRIPTS];
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
            defectClass: 'dead-length',
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
        defectClass: 'silent-call',
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

/**
 * Impossible breakouts: a signal compares price with a highest()/lowest()
 * window that includes the current bar, so it can never fire. Each form is
 * appended to a shipped script; the forms vary the operator, the operand
 * order and whether the window is stored in a variable first.
 */
const BREAKOUT_FORMS: Array<{ label: string; lines: (n: number) => string[]; marker: 'up' | 'down' }> = [
  { label: 'crossover(close, highest(high, N))', marker: 'up', lines: n => [`if crossover(close, highest(high, ${n})) {`] },
  { label: 'close > highest(high, N)', marker: 'up', lines: n => [`if close > highest(high, ${n}) {`] },
  { label: 'ogHi = highest(high, N); crossover(close, ogHi)', marker: 'up', lines: n => [`ogHi = highest(high, ${n})`, 'if crossover(close, ogHi) {'] },
  { label: 'ogLo = lowest(low, N); close < ogLo', marker: 'down', lines: n => [`ogLo = lowest(low, ${n})`, 'if close < ogLo {'] },
  { label: 'lowest(low, N) > low', marker: 'down', lines: n => [`if lowest(low, ${n}) > low {`] },
  { label: 'ogHi = highest(high, N); ogBreak = high > ogHi and volume > 0', marker: 'up', lines: n => [`ogHi = highest(high, ${n})`, 'ogBreak = high > ogHi and volume > 0', 'if ogBreak {'] },
  { label: 'crossunder(close, lowest(low, N))', marker: 'down', lines: n => [`if crossunder(close, lowest(low, ${n})) {`] },
  { label: 'ogTop = highest(close, N); ogTop < close', marker: 'up', lines: n => [`ogTop = highest(close, ${n})`, 'if ogTop < close {'] },
];

const BREAKOUT_LENGTHS = [10, 20, 34, 55];

export const BREAKOUT_MARKERS = { up: 'OG Breakout', down: 'OG Breakdown' } as const;

export function breakoutBlock(formIndex: number, length: number): string {
  const form = BREAKOUT_FORMS[formIndex % BREAKOUT_FORMS.length];
  const marker = form.marker === 'up'
    ? `  plotshape(bar_index, low, "${BREAKOUT_MARKERS.up}", "triangleup", "#22cc88")`
    : `  plotshape(bar_index, high, "${BREAKOUT_MARKERS.down}", "triangledown", "#ff4477")`;
  return ['', '// injected signal', ...form.lines(length), marker, '}'].join('\n');
}

export function generateBreakoutMutants(corpus: CorpusEntry[], cap = 120): MutantCase[] {
  const mutants: MutantCase[] = [];
  let n = 0;
  corpus.forEach((entry, idx) => {
    for (let k = 0; k < 2 && mutants.length < cap; k++) {
      const formIndex = (idx * 2 + k) % BREAKOUT_FORMS.length;
      const length = BREAKOUT_LENGTHS[(idx + k) % BREAKOUT_LENGTHS.length];
      n++;
      mutants.push({
        id: `mut-brk-${n}`,
        defectClass: 'impossible-breakout',
        baseIndicator: entry.name,
        source: entry.source + '\n' + breakoutBlock(formIndex, length),
        defect: `signal on ${BREAKOUT_FORMS[formIndex].label.replace(/N/g, String(length))}`,
        heldOut: n % 3 === 2,
      });
    }
  });
  return mutants;
}

export function generateMutantsForClass(defectClass: DefectClass, corpus: CorpusEntry[]): MutantCase[] {
  if (defectClass === 'dead-length') return generateLengthMutants(corpus);
  if (defectClass === 'silent-call') return generateDottedMutants(corpus);
  return generateBreakoutMutants(corpus);
}

export interface SyntheticBarSet { close: number[]; open: number[]; high: number[]; low: number[]; volume: number[]; time: number[]; count: number }

/** mulberry32 PRNG (same family as mega-test): deterministic for a given seed. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic synthetic bars for execution probes (mulberry32, same family as mega-test). */
export function syntheticBars(count = 120): SyntheticBarSet {
  const rnd = mulberry32(42);
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

/** Trend-biased synthetic bars for the signal-clustering probe. `drift` is the
 *  fractional move per bar (0.003 = +0.3%); `noise` is the full width of the
 *  per-bar shock as a fraction of price. */
export function syntheticTrendBars(count: number, drift: number, noise: number, seed: number): SyntheticBarSet {
  const rnd = mulberry32(seed);
  const close: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], volume: number[] = [], time: number[] = [];
  let px = 100;
  for (let i = 0; i < count; i++) {
    const o = px;
    const c = Math.max(1, o * (1 + drift + (rnd() - 0.5) * noise));
    close.push(c); open.push(o);
    high.push(Math.max(o, c) + o * noise * 0.5 * rnd());
    low.push(Math.min(o, c) - o * noise * 0.5 * rnd());
    volume.push(1000 + Math.floor(rnd() * 5000));
    time.push(1700000000000 + i * 60000);
    px = c;
  }
  return { close, open, high, low, volume, time, count };
}
