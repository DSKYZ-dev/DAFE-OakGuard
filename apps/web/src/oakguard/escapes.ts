/**
 * Escapes — scripts the baseline validator accepts but the runtime oracles
 * prove broken. Each escape is the starting point of one OakGuard loop: a
 * model is shown the script and the evidence and asked for a rule that
 * would have caught it before it ran.
 *
 * `origin` says where the script came from. Seeds are hand-written
 * reproductions of a bug class; drafts are real model output, recorded with
 * the model, the request and the time.
 */
import type { DefectClass } from './types';

export interface EscapeCase {
  id: string;
  defectClass: DefectClass;
  title: string;
  source: string;
  origin: 'seed' | 'model-draft';
  model?: string;
  request?: string;
  recordedAt?: string;
}

export const SEED_ESCAPES: EscapeCase[] = [
  {
    id: 'esc-dead-length',
    defectClass: 'dead-length',
    title: 'A moving average with a zero length',
    origin: 'seed',
    source: [
      '// Seed failure — produced in coder testing',
      'len = 14',
      'x = sma(close, 0)',
      'r = rsi(close, len)',
      'plot(x, "SMA", "#22cc88", 2)',
      'plot(r, "RSI", "#ffd166", 1, "separate")',
    ].join('\n'),
  },
  {
    id: 'esc-silent-call',
    defectClass: 'silent-call',
    title: 'A misspelled array builtin',
    origin: 'seed',
    source: [
      '// RSI smoothed over its last three readings',
      'len = input(14, "Length", 2, 100, 1)',
      'r = rsi(close, len)',
      'vals = [r, r[1], r[2]]',
      'smooth = array.avgg(vals)',
      'plot(smooth, "Smoothed RSI", "#ffd166", 2, "separate")',
      'hline(70, "#ff4477", "separate")',
      'hline(30, "#22cc88", "separate")',
    ].join('\n'),
  },
  {
    id: 'esc-impossible-breakout',
    defectClass: 'impossible-breakout',
    title: 'A breakout that can never fire',
    origin: 'seed',
    source: [
      '// 20-bar channel breakout',
      'len = input(20, "Lookback", 5, 100, 1)',
      'upper = highest(high, len)',
      'lower = lowest(low, len)',
      'if crossover(close, upper) {',
      '  plotshape(bar_index, low, "Breakout", "triangleup", "#22cc88")',
      '}',
      'if crossunder(close, lower) {',
      '  plotshape(bar_index, high, "Breakdown", "triangledown", "#ff4477")',
      '}',
      'plot(upper, "Upper", "#22aaff", 1, "stepline")',
      'plot(lower, "Lower", "#ff8844", 1, "stepline")',
    ].join('\n'),
  },
];

export const DEFECT_CLASS_LABELS: Record<DefectClass, string> = {
  'dead-length': 'Zero or fractional lookback length',
  'silent-call': 'Call to a builtin that does not exist',
  'impossible-breakout': 'Breakout signal that can never fire',
};
