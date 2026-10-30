/**
 * OakGuard honesty checks: deterministic tests a result can pass without any
 * claim about profit.
 *   - replay: outputs on earlier bars do not change when later bars are removed,
 *     so the history contains no lookahead;
 *   - open-bar stability: signals on the forming bar do not change across the
 *     prices that bar could still close at. A signal that flickers there is
 *     gone by the close, so the live chart repaints.
 */
import { parse } from '../oakscript/parser';
import { executeScript, type RuntimeBarData } from '../oakscript/interpreter';
import type { BacktestResult } from '../backtest/types';
import { DEFAULT_COMMISSION, DEFAULT_SLIPPAGE } from '../trading/paper-broker';

export interface HonestyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

const sameValue = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

function plotsOf(source: string, bars: RuntimeBarData): any[] | null {
  try {
    return executeScript(parse(source), bars, new Map()).plots as any[];
  } catch {
    return null;
  }
}

function headBars(bars: RuntimeBarData, n: number): RuntimeBarData {
  return {
    close: bars.close.slice(0, n),
    open: bars.open.slice(0, n),
    high: bars.high.slice(0, n),
    low: bars.low.slice(0, n),
    volume: bars.volume.slice(0, n),
    time: bars.time.slice(0, n),
    count: n,
    live: false,
  };
}

/** First output that differs between the full run and a run on the first `cut` bars. */
function replayDifference(full: any[], head: any[], cut: number): string | null {
  const fullLines = new Map<string, number>();
  for (const p of full) if (p.type === 'line' && p.barIdx < cut) fullLines.set(`${p.name}|${p.barIdx}`, p.value);
  for (const p of head) {
    if (p.type !== 'line' || p.barIdx >= cut) continue;
    const f = fullLines.get(`${p.name}|${p.barIdx}`);
    if (f === undefined || !sameValue(f, p.value)) {
      return `line "${p.name}" bar ${p.barIdx} is ${p.value} on ${cut} bars but ${f} with later bars`;
    }
  }
  const fullMarks = new Set(full.filter(p => p.type === 'shape' && p.barIdx < cut).map(p => `${p.name}|${p.barIdx}`));
  const headMarks = new Set(head.filter(p => p.type === 'shape' && p.barIdx < cut).map(p => `${p.name}|${p.barIdx}`));
  for (const k of fullMarks) if (!headMarks.has(k)) return `marker ${k} appears only with later bars`;
  for (const k of headMarks) if (!fullMarks.has(k)) return `marker ${k} appears only on ${cut} bars`;
  const fullLayers = new Map<string, number[]>();
  for (const p of full) if (p.type === 'plot3d' && !fullLayers.has(p.name)) fullLayers.set(p.name, p.series);
  for (const p of head) {
    if (p.type !== 'plot3d') continue;
    const fs = fullLayers.get(p.name);
    if (!fs) return `3D layer "${p.name}" appears only on ${cut} bars`;
    for (let i = 0; i < Math.min(cut, p.series.length, fs.length); i++) {
      if (!sameValue(fs[i], p.series[i])) return `3D layer "${p.name}" bar ${i} changes with later bars`;
    }
  }
  return null;
}

/** History is final: every output before each cut is identical when the later bars are removed. */
export function replayCheck(source: string, bars: RuntimeBarData, cuts?: number[]): HonestyCheck {
  const name = 'replay: history does not change with later bars';
  const full = plotsOf(source, { ...bars, live: false });
  if (!full) return { name, passed: false, detail: 'script does not run on the full history' };
  const points = cuts ?? [Math.floor(bars.count * 0.7), Math.floor(bars.count * 0.75) + 3];
  for (const cut of points) {
    const head = plotsOf(source, headBars(bars, cut));
    if (!head) return { name, passed: false, detail: `script does not run on ${cut} bars` };
    const diff = replayDifference(full, head, cut);
    if (diff) return { name, passed: false, detail: diff };
  }
  return { name, passed: true, detail: `identical at ${points.length} cut points (${points.join(', ')} of ${bars.count} bars)` };
}

/** Markers on the forming bar do not change across the prices it could still close at. */
export function openBarStability(source: string, bars: RuntimeBarData, steps: number[] = [0, 0.25, 0.5, 0.75, 1]): HonestyCheck {
  const name = 'open bar: signals do not flicker before close';
  const last = bars.count - 1;
  if (last < 0) return { name, passed: true, detail: 'no bars' };
  const seen: string[] = [];
  for (const f of steps) {
    const price = bars.low[last] + f * (bars.high[last] - bars.low[last]);
    const variant: RuntimeBarData = {
      ...bars,
      live: true,
      close: bars.close.map((c, i) => (i === last ? price : c)),
      high: bars.high.map((h, i) => (i === last ? Math.max(h, price) : h)),
      low: bars.low.map((l, i) => (i === last ? Math.min(l, price) : l)),
    };
    const plots = plotsOf(source, variant);
    if (!plots) return { name, passed: false, detail: 'script does not run on a forming-bar variant' };
    seen.push(plots.filter(p => (p.type === 'shape' || p.type === 'plot3d_shape') && p.barIdx === last).map(p => String(p.name)).sort().join(', ') || 'none');
  }
  const distinct = [...new Set(seen)];
  if (distinct.length > 1) {
    return { name, passed: false, detail: `a marker on the forming bar depends on the price it closes at (${distinct.join(' / ')}); gate it with barstate.isconfirmed` };
  }
  return { name, passed: true, detail: `forming-bar markers unchanged across ${steps.length} intrabar prices (${distinct[0]})` };
}

export interface BacktestEvidence {
  source: string;
  /** The bars the backtest ran on. */
  bars: RuntimeBarData;
  result: BacktestResult;
  /** Parameter sets evaluated for this result (1 for a single run). */
  trials?: number;
  /** What the parameters were ranked on. The optimizer ranks on in-sample. */
  selectedOn?: 'in-sample' | 'out-of-sample';
  /** Out-of-sample trades needed before the result means anything. */
  minOutOfSampleTrades?: number;
}

export interface BacktestCertificate {
  /** Historical checks: the procedure that produced the result. */
  checks: HonestyCheck[];
  /** Live check: whether the script's forming-bar markers can repaint on close. */
  live: HonestyCheck;
  honest: boolean;
  disclaimer: string;
}

/** Certifies the procedure behind a backtest result. It says nothing about future returns. */
export function backtestCertificate(e: BacktestEvidence): BacktestCertificate {
  const { source, bars, result } = e;
  const trials = e.trials ?? 1;
  const minOos = e.minOutOfSampleTrades ?? 20;
  const checks: HonestyCheck[] = [];

  checks.push(replayCheck(source, bars));

  const slip = DEFAULT_SLIPPAGE.mode === 'fixed-ticks' ? DEFAULT_SLIPPAGE.value * DEFAULT_SLIPPAGE.tickSize : Number.NaN;
  const off = result.trades.filter(t => !(Math.abs(t.entryPrice - bars.open[t.entryBarIdx]) <= slip + 1e-9));
  checks.push({
    name: 'fills: entries fill at the open of the entry bar, not the signal close',
    passed: result.trades.length > 0 && Number.isFinite(slip) && off.length === 0,
    detail: result.trades.length === 0
      ? 'no trades, nothing to certify'
      : `${result.trades.length - off.length} of ${result.trades.length} trades fill at their entry bar's open (within ${slip} slippage)`,
  });

  checks.push({
    name: 'costs: commission and slippage are charged',
    passed: DEFAULT_COMMISSION.value > 0 && DEFAULT_SLIPPAGE.value > 0,
    detail: `paper broker charges ${DEFAULT_COMMISSION.value} ${DEFAULT_COMMISSION.mode} commission and ${DEFAULT_SLIPPAGE.value} ${DEFAULT_SLIPPAGE.mode} slippage`,
  });

  const oos = result.outOfSample;
  checks.push({
    name: 'holdout: a later period is reserved for out-of-sample results',
    passed: result.splitBarIdx > 0 && result.splitBarIdx < result.totalBars - 1 && oos.endBarIdx > oos.startBarIdx,
    detail: `in-sample bars 0 to ${result.splitBarIdx}, out-of-sample bars ${oos.startBarIdx} to ${oos.endBarIdx} of ${result.totalBars}`,
  });

  checks.push({
    name: `sample: at least ${minOos} out-of-sample trades`,
    passed: oos.totalTrades >= minOos,
    detail: `${oos.totalTrades} out-of-sample trades (${result.inSample.totalTrades} in-sample)`,
  });

  const selectedOn = e.selectedOn ?? 'in-sample';
  checks.push({
    name: 'selection: parameters are chosen without the out-of-sample period',
    passed: trials <= 1 || selectedOn === 'in-sample',
    detail: trials <= 1
      ? 'single parameter set, nothing selected'
      : `best of ${trials} parameter sets, ranked on in-sample. Net P&L in-sample ${result.inSample.netPnLPct.toFixed(2)}% vs out-of-sample ${oos.netPnLPct.toFixed(2)}%`,
  });

  return {
    checks,
    live: openBarStability(source, bars),
    honest: checks.every(c => c.passed),
    disclaimer: 'Certifies the test procedure only: no lookahead, fills at the next open with costs, a reserved out-of-sample period, and no selection on it. It is not a forecast and does not show the strategy will make money.',
  };
}
