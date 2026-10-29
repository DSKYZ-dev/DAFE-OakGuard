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
  /** Where the historical bars come from. 'fetch' = the backend historical
   * endpoint (fails hard when it has no data); 'chart' = the bars currently
   * loaded in the chart (works offline / with synthetic data, always uses
   * the chart's own symbol+timeframe); 'auto' (default) = try fetch, fall
   * back to chart bars so the backtester always has something to run on.
   * The UI surfaces which source was actually used with every result. */
  dataSource?: 'auto' | 'fetch' | 'chart';
  /** Where trade signals come from — the one-script-both-roles bridge.
   * 'strategy' = only explicit strategy.entry()/strategy.exit() calls;
   * 'shapes' = derive entries/exits from plotted signal markers
   * (plotshape/plotshape_3d) by matching their labels; 'auto' (default) =
   * strategy.* calls when the script makes any, otherwise fall back to
   * shape-derived signals — so ANY indicator that plots Buy/Sell markers is
   * backtestable as-is, no separate strategy version of the script needed. */
  signalSource?: 'auto' | 'strategy' | 'shapes';
  /** Pipe-separated, case-insensitive substrings that mark a shape label as
   * an ENTRY signal when deriving from shapes (default: buy|long|bull). */
  entryMatch?: string;
  /** Same, for EXIT signals (default: sell|short|exit|bear|close). */
  exitMatch?: string;
}

export interface EquityPoint {
  barIdx: number;
  time: number;
  equity: number;
}

/** What closed the trade — which working order type actually filled. Lets
 * the trade log show, per-trade, whether a bracket ever fired at all
 * instead of only inferring it from aggregate stats. */
export type TradeExitReason = 'signal' | 'stop-loss' | 'take-profit' | 'trailing-stop' | 'unknown';

/** One closed position, attributed to the bar it closed on (barIdx/pnl —
 * the original fields stats.ts and optimizer.ts key off) plus full
 * entry/exit fill detail for the trade log and CSV/print export. */
export interface ClosedTrade {
  barIdx: number;
  pnl: number;
  side: 'long' | 'short';
  qty: number;
  entryBarIdx: number;
  entryTime: number;
  entryPrice: number;
  exitBarIdx: number;
  exitTime: number;
  exitPrice: number;
  exitReason: TradeExitReason;
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
  /** Which signal source actually produced the replayed orders ('none' when
   * the script emitted nothing usable) — surfaced in the UI so a derived
   * (shape-based) run is never mistaken for an explicit strategy.* run. */
  signalSourceUsed: 'strategy' | 'shapes' | 'none';
  /** Orders that entered the replay, after any shape derivation. */
  orderCount: number;
}

/** Compact projection of a plotted signal marker (plotshape/plotshape_3d) —
 * just enough for the engine to derive entry/exit orders from labels. */
export interface SignalShape {
  barIdx: number;
  name: string;
  style?: string;
}

// ─── Worker message contract ────────────────────────────────────────────
// The worker runs executeScript() ONCE over the full contiguous bar range
// (signal-collection pass only) and hands back order events plus a COMPACT
// list of plotted signal markers (for shape-derived signals) — never full
// plots, whose per-bar series aren't worth the serialization cost.
export interface BacktestWorkerRequest {
  source: string;
  bars: RuntimeBarData;
  inputOverrides?: Map<string, unknown>;
  /** Pre-fetched (awaited before the worker starts — see ml-client.ts's
   * fetchMlPredictionsMap/fetchRlActionsMap) ml.predict()/rl.action() data,
   * keyed by model/policy id. A one-shot worker pass has no "next frame" to
   * retry an async fetch on, unlike the live-chart path. */
  mlPredictions?: Map<string, number[]>;
  rlActions?: Map<string, number[]>;
}

export interface BacktestWorkerResponse {
  ok: boolean;
  strategyOrders: OakStrategyOrder[];
  signalShapes: SignalShape[];
  alerts: OakAlert[];
  errors: string[];
  parseError?: string;
}
