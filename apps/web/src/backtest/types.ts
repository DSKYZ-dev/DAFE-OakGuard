/**
 * Time Machine — OakScript backtest engine, shared types.
 *
 * v1 scope (see the plan): single fixed in-sample/out-of-sample split (not
 * walk-forward), forced next-bar-open fills, flat qty-per-trade sizing, no
 * pyramiding, single symbol only. Optional single-bracket stop-loss/
 * take-profit is supported (one of each per position, placed on entry) —
 * see engine.ts's placeBracketOrders().
 */

import type { OakAlert, OakStrategyOrder } from '../oakscript/runtime';
import type { RuntimeBarData } from '../oakscript/interpreter';

export type StopLossMode = 'none' | 'fixed-pct' | 'fixed-amount' | 'trailing-pct' | 'trailing-amount';
export type TakeProfitMode = 'none' | 'fixed-pct' | 'fixed-amount';

export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  barCount: number;
  /** 0-100. Bars [0, splitBarIdx] are in-sample; the rest are out-of-sample. */
  inSamplePct: number;
  qtyPerTrade: number;
  startingCash: number;
  baseUrl?: string;
  /** Reuses PaperBroker's existing 'stop'/'trailing-stop' order types — see
   * engine.ts's placeBracketOrders(). 'none' (default) preserves the exact
   * pre-bracket behavior: entries only ever close via the script's own
   * strategy.exit(). */
  stopLossMode: StopLossMode;
  /** Interpreted as a percent (fixed-pct/trailing-pct) or an absolute $
   * distance (fixed-amount/trailing-amount) depending on stopLossMode. */
  stopLossValue: number;
  /** Reuses PaperBroker's 'limit' order type. 'none' (default) preserves
   * the exact pre-bracket behavior. */
  takeProfitMode: TakeProfitMode;
  /** Interpreted as a percent (fixed-pct) or an absolute $ distance
   * (fixed-amount) depending on takeProfitMode. */
  takeProfitValue: number;
}

export interface EquityPoint {
  barIdx: number;
  time: number;
  equity: number;
}

/** One closed (or partially closed) position, attributed to the bar it closed on. */
export interface ClosedTrade {
  barIdx: number;
  pnl: number;
}

export interface SampleStats {
  label: 'in-sample' | 'out-of-sample';
  startBarIdx: number;
  endBarIdx: number;
  startEquity: number;
  endEquity: number;
  netPnL: number;
  netPnLPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** Per-bar, unannualized — see stats.ts for why this isn't annualized. */
  sharpePerBar: number;
  winRate: number;
  totalTrades: number;
  avgWin: number;
  avgLoss: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  equityCurve: EquityPoint[];
  trades: ClosedTrade[];
  inSample: SampleStats;
  outOfSample: SampleStats;
  scriptErrors: string[];
  scriptAlertCount: number;
  splitBarIdx: number;
  totalBars: number;
}

// ─── Worker message contract ────────────────────────────────────────────
// The worker runs executeScript() ONCE over the full contiguous bar range
// (signal-collection pass only) and hands back order events — never plots,
// which the backtest doesn't use and aren't worth the serialization cost.
export interface BacktestWorkerRequest {
  source: string;
  bars: RuntimeBarData;
  inputOverrides?: Map<string, unknown>;
}

export interface BacktestWorkerResponse {
  ok: boolean;
  strategyOrders: OakStrategyOrder[];
  alerts: OakAlert[];
  errors: string[];
  parseError?: string;
}
