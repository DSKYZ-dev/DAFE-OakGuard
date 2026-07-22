/**
 * Time Machine Optimizer — true combinatorial parameter search over a
 * script's numeric input(...) values, ranked by a selectable objective.
 *
 * Supersedes the earlier one-at-a-time "Model Lab" nudge sweep: that design
 * varied a single input at a time (baseline, input A down, input A up,
 * input B down, ...), so it could never discover a combination like "fast
 * EMA lower AND slow EMA higher" — only single-axis moves off the script's
 * own defaults. This module builds the actual cartesian product across up
 * to MAX_OPTIMIZER_INPUTS swept inputs, each sampled at POINTS_PER_INPUT
 * candidate values, capped and randomly subsampled at MAX_OPTIMIZER_RUNS
 * total backtest runs so a script with several wide-range inputs can't
 * blow up into thousands of runs in one click.
 */
import type { InputDef } from '../oakscript/editor';
import type { BacktestResult, ClosedTrade, SampleStats } from './types';

export interface OptimizerVariant {
  label: string;
  /** Empty for the baseline variant (all script defaults). */
  overrides: Map<string, number>;
}

export interface OptimizerRunRow {
  variant: OptimizerVariant;
  result: BacktestResult;
  score: number;
}

export type OptimizerObjective = 'netPnlPct' | 'sharpe' | 'winRate' | 'profitFactor' | 'calmar';

export const OPTIMIZER_OBJECTIVES: { value: OptimizerObjective; label: string; format: (n: number) => string }[] = [
  { value: 'netPnlPct', label: 'Net P&L %', format: (n) => `${(n * 100).toFixed(2)}%` },
  { value: 'sharpe', label: 'Sharpe (per-bar)', format: (n) => n.toFixed(3) },
  { value: 'winRate', label: 'Win Rate', format: (n) => `${(n * 100).toFixed(1)}%` },
  { value: 'profitFactor', label: 'Profit Factor', format: (n) => n.toFixed(2) },
  { value: 'calmar', label: 'Return / Max Drawdown', format: (n) => n.toFixed(2) },
];

export function objectiveLabel(v: OptimizerObjective): string {
  return OPTIMIZER_OBJECTIVES.find(o => o.value === v)?.label ?? v;
}
export function formatObjectiveScore(v: OptimizerObjective, score: number): string {
  return (OPTIMIZER_OBJECTIVES.find(o => o.value === v)?.format ?? ((n: number) => n.toFixed(3)))(score);
}

// Hard caps — a combinatorial grid grows fast (POINTS_PER_INPUT^numInputs),
// so both are needed: MAX_OPTIMIZER_INPUTS bounds how many axes get swept
// at all, MAX_OPTIMIZER_RUNS bounds the total backtests actually executed
// (random-subsampling the full grid, always keeping the baseline, once it
// would exceed this).
export const MAX_OPTIMIZER_INPUTS = 4;
export const POINTS_PER_INPUT: number = 4;
export const MAX_OPTIMIZER_RUNS = 200;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round6(n));
}

/** A small, evenly-spaced candidate set across the input's declared (or
 * inferred) range, always including its own default. */
function candidateValuesFor(inp: InputDef): number[] {
  const base = typeof inp.defaultValue === 'number' ? inp.defaultValue : 0;
  // No declared min/max — infer a symmetric spread around the default so
  // there's still something meaningful to search.
  const spread = Math.max(Math.abs(base) * 0.5, 1);
  const min = inp.min ?? (base - spread);
  const max = inp.max ?? (base + spread);
  const step = inp.step && inp.step > 0 ? inp.step : undefined;

  const values = new Set<number>([round6(base)]);
  for (let k = 0; k < POINTS_PER_INPUT; k++) {
    const t = POINTS_PER_INPUT === 1 ? 0.5 : k / (POINTS_PER_INPUT - 1);
    let v = min + t * (max - min);
    if (step) v = Math.round(v / step) * step;
    v = round6(Math.max(min, Math.min(max, v)));
    values.add(v);
  }
  return Array.from(values).sort((a, b) => a - b);
}

/** Deterministic seeded shuffle (mulberry32) — so a truncated grid's random
 * subsample is at least reproducible within a session for a given input
 * set, rather than silently different every click for no visible reason. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface OptimizerGrid {
  variants: OptimizerVariant[];
  /** True numeric inputs actually swept (after the MAX_OPTIMIZER_INPUTS cap). */
  sweptInputs: InputDef[];
  /** Full cartesian product size before any MAX_OPTIMIZER_RUNS truncation. */
  totalCombinations: number;
  /** True when totalCombinations exceeded MAX_OPTIMIZER_RUNS and the grid
   * was randomly subsampled (baseline always kept). */
  truncated: boolean;
}

/**
 * Builds the full combinatorial variant grid: every swept input varied
 * TOGETHER, not one axis at a time. Always includes the all-defaults
 * baseline as the first variant.
 */
export function buildOptimizerGrid(inputs: InputDef[]): OptimizerGrid {
  const numeric = inputs.filter(i => i.type === 'number').slice(0, MAX_OPTIMIZER_INPUTS);
  if (numeric.length === 0) {
    return {
      variants: [{ label: 'Baseline (script defaults)', overrides: new Map() }],
      sweptInputs: [], totalCombinations: 1, truncated: false,
    };
  }

  const perInput = numeric.map(inp => ({ inp, values: candidateValuesFor(inp) }));
  let combos: number[][] = [[]];
  for (const { values } of perInput) {
    const next: number[][] = [];
    for (const combo of combos) for (const v of values) next.push([...combo, v]);
    combos = next;
  }
  const totalCombinations = combos.length;

  const baselineCombo = perInput.map(p => round6(typeof p.inp.defaultValue === 'number' ? p.inp.defaultValue : 0));
  let truncated = false;
  if (combos.length > MAX_OPTIMIZER_RUNS) {
    truncated = true;
    const rest = combos.filter(c => c.some((v, i) => v !== baselineCombo[i]));
    const sampled = seededShuffle(rest, rest.length + numeric.length).slice(0, MAX_OPTIMIZER_RUNS - 1);
    combos = [baselineCombo, ...sampled];
  }

  const variants: OptimizerVariant[] = combos.map(combo => {
    const overrides = new Map<string, number>();
    const parts: string[] = [];
    combo.forEach((v, i) => {
      const inp = perInput[i].inp;
      const base = round6(typeof inp.defaultValue === 'number' ? inp.defaultValue : 0);
      if (v !== base) overrides.set(inp.name, v);
      parts.push(`${inp.title}=${formatNumber(v)}`);
    });
    return { label: overrides.size === 0 ? 'Baseline (script defaults)' : parts.join(', '), overrides };
  });

  return { variants, sweptInputs: numeric, totalCombinations, truncated };
}

function profitFactor(trades: ClosedTrade[], splitBarIdx: number, sample: 'in' | 'out'): number {
  let grossProfit = 0, grossLoss = 0;
  for (const t of trades) {
    if (sample === 'in' ? t.barIdx > splitBarIdx : t.barIdx <= splitBarIdx) continue;
    if (t.pnl > 0) grossProfit += t.pnl;
    else if (t.pnl < 0) grossLoss += -t.pnl;
  }
  return grossProfit / (grossLoss || 1e-6);
}

function calmar(stats: SampleStats): number {
  return stats.netPnLPct / (stats.maxDrawdownPct || 1e-6);
}

/** Scores a backtest result on its IN-SAMPLE stats only — optimizing
 * against out-of-sample data would just be curve-fitting the validation
 * set by another name. Out-of-sample stays reference-only, shown alongside
 * every ranked row so an obviously overfit pick (great in-sample, poor
 * out-of-sample) is visible, never hidden by the ranking itself. */
export function objectiveScore(result: BacktestResult, objective: OptimizerObjective): number {
  const stats = result.inSample;
  switch (objective) {
    case 'netPnlPct': return stats.netPnLPct;
    case 'sharpe': return stats.sharpePerBar;
    case 'winRate': return stats.winRate;
    case 'profitFactor': return profitFactor(result.trades, result.splitBarIdx, 'in');
    case 'calmar': return calmar(stats);
  }
}
