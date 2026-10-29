import type { EquityPoint, ClosedTrade, SampleStats } from './types';

/**
 * Running-peak max drawdown. Callers pass ONE sample's slice of the equity
 * curve (never the whole curve for a per-sample stat) so an out-of-sample
 * drawdown isn't measured against an in-sample peak it never actually saw.
 */
export function computeMaxDrawdown(points: EquityPoint[]): { abs: number; pct: number } {
  if (points.length === 0) return { abs: 0, pct: 0 };
  let peak = points[0].equity;
  let maxDD = 0;
  let maxDDPct = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }
  return { abs: maxDD, pct: maxDDPct };
}

/**
 * Per-bar Sharpe, deliberately NOT annualized. A correct annualization
 * factor needs a symbol -> asset-class mapping (equities ~252 trading
 * days/yr, forex/crypto 365, different session lengths) that doesn't exist
 * anywhere in this codebase (checked market-hours.ts) — reporting a raw,
 * clearly-labeled per-bar figure beats fabricating a wrong "annualized"
 * number silently.
 */
export function computeSharpePerBar(points: EquityPoint[]): number {
  if (points.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].equity;
    if (prev === 0) continue;
    returns.push((points[i].equity - prev) / prev);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const stdev = Math.sqrt(variance);
  return stdev === 0 ? 0 : mean / stdev;
}

function emptySampleStats(label: SampleStats['label']): SampleStats {
  return {
    label, startBarIdx: 0, endBarIdx: 0, startEquity: 0, endEquity: 0,
    netPnL: 0, netPnLPct: 0, maxDrawdown: 0, maxDrawdownPct: 0,
    sharpePerBar: 0, winRate: 0, totalTrades: 0, avgWin: 0, avgLoss: 0,
  };
}

export function computeSampleStats(
  label: SampleStats['label'],
  points: EquityPoint[],
  trades: ClosedTrade[],
): SampleStats {
  if (points.length === 0) return emptySampleStats(label);

  const startEquity = points[0].equity;
  const endEquity = points[points.length - 1].equity;
  const netPnL = endEquity - startEquity;
  const netPnLPct = startEquity !== 0 ? netPnL / startEquity : 0;
  const { abs: maxDrawdown, pct: maxDrawdownPct } = computeMaxDrawdown(points);
  const sharpePerBar = computeSharpePerBar(points);

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;

  return {
    label,
    startBarIdx: points[0].barIdx,
    endBarIdx: points[points.length - 1].barIdx,
    startEquity, endEquity, netPnL, netPnLPct,
    maxDrawdown, maxDrawdownPct, sharpePerBar,
    winRate, totalTrades: trades.length, avgWin, avgLoss,
  };
}
