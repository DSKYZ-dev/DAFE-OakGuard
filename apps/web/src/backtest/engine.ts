import type { OakStrategyOrder } from '../oakscript/runtime';
import { PaperBroker, DEFAULT_COMMISSION, DEFAULT_SLIPPAGE, type PaperBrokerConfig } from '../trading/paper-broker';
import type { BacktestConfig, BacktestResult, EquityPoint, ClosedTrade, BacktestWorkerRequest, BacktestWorkerResponse, SignalShape } from './types';
import { fetchBacktestBars, barsToRuntimeBarData } from './data';
import { computeSampleStats } from './stats';
import { deriveSignalsFromMarkers, DEFAULT_ENTRY_MATCH, DEFAULT_EXIT_MATCH } from '../signal-engine';

// ─── Signal-to-strategy bridge ──────────────────────────────────────────
// The classification logic lives in the shared Signal Engine
// (src/signal-engine.ts) so the live chart's signal stream and this
// backtest replay can never drift apart. This wrapper just projects the
// derived TradeSignals into the OakStrategyOrder shape the replay indexes.
export { DEFAULT_ENTRY_MATCH, DEFAULT_EXIT_MATCH };

export function deriveOrdersFromShapes(
  shapes: SignalShape[],
  entryMatch?: string,
  exitMatch?: string,
): OakStrategyOrder[] {
  return deriveSignalsFromMarkers(shapes, entryMatch, exitMatch).map(s => ({
    kind: s.kind,
    direction: s.direction,
    id: 'signal-derived',
    barIdx: s.barIdx,
  }));
}

// Defense-in-depth beyond the interpreter's own internal MAX_EXECUTION_WALL_MS
// (20s) deadline check — in case that check is somehow bypassed (e.g. a
// single bar's MAX_LOOP_STEPS_PER_BAR-bounded region taking pathologically
// long per step). The synchronous per-bar loop has no cooperative yield
// points, so the only reliable cancel at this layer is a hard terminate().
const ORCHESTRATOR_TIMEOUT_MS = 25_000;

export class BacktestCancelledError extends Error {
  constructor() {
    super('Backtest cancelled.');
    this.name = 'BacktestCancelledError';
  }
}

export interface RunBacktestOptions {
  signal?: AbortSignal;
  onProgress?: (stage: 'fetching' | 'running-script' | 'replaying' | 'done') => void;
  /** Overrides applied on top of the script's own `input(...)` defaults for
   * this run only — the hook Strategy Lab's variant sweep uses to run the
   * same source N times with different parameter values. Unset for a normal
   * single Time Machine run. */
  inputOverrides?: Map<string, unknown>;
}

/**
 * Places optional stop-loss/take-profit bracket orders right after an entry
 * fills, reusing PaperBroker's existing 'stop'/'trailing-stop'/'limit' order
 * types unmodified — no new broker logic, just orchestration. Stop-loss is
 * placed BEFORE take-profit: on a same-tick double-touch (a bar's range
 * spans both levels), PaperBroker.tick() evaluates 'working' orders in Map
 * insertion order, so the stop-loss (the worse outcome) wins the ambiguous
 * bar — a deliberate, conservative choice, not an unexplained ordering
 * dependency.
 */
function placeBracketOrders(
  broker: PaperBroker,
  symbol: string,
  entrySide: 'buy' | 'sell',
  qty: number,
  fillPrice: number,
  config: BacktestConfig,
  // Per-order overrides from model.stopLoss()/model.takeProfit() — when
  // present, this specific entry's bracket uses them instead of the
  // backtest form's SL/TP config. Fixed distance only (pct/abs), no
  // trailing — trailing stays a form-level-only option.
  orderStopLoss?: { mode: 'pct' | 'abs'; value: number },
  orderTakeProfit?: { mode: 'pct' | 'abs'; value: number },
): void {
  const isLong = entrySide === 'buy';
  const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy';

  if (orderStopLoss) {
    const pct = orderStopLoss.mode === 'pct';
    const stopPrice = isLong
      ? (pct ? fillPrice * (1 - orderStopLoss.value / 100) : fillPrice - orderStopLoss.value)
      : (pct ? fillPrice * (1 + orderStopLoss.value / 100) : fillPrice + orderStopLoss.value);
    broker.placeOrder({ symbol, side: exitSide, type: 'stop', qty, stopPrice });
  } else if (config.stopLossMode !== 'none') {
    if (config.stopLossMode === 'trailing-pct' || config.stopLossMode === 'trailing-amount') {
      broker.placeOrder({
        symbol, side: exitSide, type: 'trailing-stop', qty,
        trailAmount: config.stopLossValue,
        trailIsPercent: config.stopLossMode === 'trailing-pct',
      });
    } else {
      const pct = config.stopLossMode === 'fixed-pct';
      const stopPrice = isLong
        ? (pct ? fillPrice * (1 - config.stopLossValue / 100) : fillPrice - config.stopLossValue)
        : (pct ? fillPrice * (1 + config.stopLossValue / 100) : fillPrice + config.stopLossValue);
      broker.placeOrder({ symbol, side: exitSide, type: 'stop', qty, stopPrice });
    }
  }

  if (orderTakeProfit) {
    const pct = orderTakeProfit.mode === 'pct';
    const limitPrice = isLong
      ? (pct ? fillPrice * (1 + orderTakeProfit.value / 100) : fillPrice + orderTakeProfit.value)
      : (pct ? fillPrice * (1 - orderTakeProfit.value / 100) : fillPrice - orderTakeProfit.value);
    broker.placeOrder({ symbol, side: exitSide, type: 'limit', qty, limitPrice });
  } else if (config.takeProfitMode !== 'none') {
    const pct = config.takeProfitMode === 'fixed-pct';
    const limitPrice = isLong
      ? (pct ? fillPrice * (1 + config.takeProfitValue / 100) : fillPrice + config.takeProfitValue)
      : (pct ? fillPrice * (1 - config.takeProfitValue / 100) : fillPrice - config.takeProfitValue);
    broker.placeOrder({ symbol, side: exitSide, type: 'limit', qty, limitPrice });
  }
}

function runSignalCollection(
  source: string,
  bars: ReturnType<typeof barsToRuntimeBarData>,
  opts?: RunBacktestOptions,
): Promise<BacktestWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`Backtest script execution exceeded the ${ORCHESTRATOR_TIMEOUT_MS}ms orchestrator timeout.`));
    }, ORCHESTRATOR_TIMEOUT_MS);

    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(new BacktestCancelledError());
    };
    opts?.signal?.addEventListener('abort', onAbort);

    worker.onmessage = (ev: MessageEvent<BacktestWorkerResponse>) => {
      if (settled) return;
      cleanup();
      resolve(ev.data);
    };
    worker.onerror = (ev: ErrorEvent) => {
      if (settled) return;
      cleanup();
      reject(new Error(`Backtest worker error: ${ev.message}`));
    };

    const req: BacktestWorkerRequest = { source, bars, inputOverrides: opts?.inputOverrides };
    worker.postMessage(req);
  });
}

/**
 * Runs a full Time Machine backtest: fetch historical bars -> collect
 * strategy.entry/exit signals via one Worker pass over the full contiguous
 * range -> replay them chronologically against a fresh, isolated PaperBroker
 * with forced next-bar-open fills -> split the resulting equity curve into
 * in-sample/out-of-sample slices ONLY for stats (never for execution — see
 * the plan's rationale on why splitting before execution would corrupt
 * indicator warmup/persist state at the boundary).
 */
export async function runBacktest(
  config: BacktestConfig,
  source: string,
  opts?: RunBacktestOptions,
): Promise<BacktestResult> {
  if (opts?.signal?.aborted) throw new BacktestCancelledError();

  opts?.onProgress?.('fetching');
  const rawBars = await fetchBacktestBars(config.symbol, config.timeframe, config.barCount, config.baseUrl);
  const bars = barsToRuntimeBarData(rawBars);

  return runBacktestOnBars(config, source, bars, opts);
}

/**
 * Same as runBacktest() but takes already-fetched bars instead of fetching
 * them itself. Strategy Lab's variant sweep needs the exact same historical
 * bars across every variant of a script — fetching once here and replaying
 * it N times avoids N redundant historical-data round-trips for data that
 * would come back identical every time.
 */
export async function runBacktestOnBars(
  config: BacktestConfig,
  source: string,
  bars: ReturnType<typeof barsToRuntimeBarData>,
  opts?: RunBacktestOptions,
): Promise<BacktestResult> {
  if (opts?.signal?.aborted) throw new BacktestCancelledError();

  opts?.onProgress?.('running-script');
  const workerResult = await runSignalCollection(source, bars, opts);
  if (!workerResult.ok) {
    throw new Error(workerResult.parseError || 'Backtest script failed to execute.');
  }

  if (opts?.signal?.aborted) throw new BacktestCancelledError();

  opts?.onProgress?.('replaying');
  const brokerConfig: PaperBrokerConfig = {
    currency: 'USD',
    startingCash: config.startingCash,
    commission: DEFAULT_COMMISSION,
    slippage: DEFAULT_SLIPPAGE,
  };
  const broker = new PaperBroker(brokerConfig);
  const { symbol } = config;

  const equityCurve: EquityPoint[] = [];
  const trades: ClosedTrade[] = [];
  let prevRealizedPnL = 0;
  let currentBarIdx = 0;

  // Unified fill handling — covers BOTH script-driven market orders (entry/
  // exit) AND bracket orders (stop-loss/take-profit), which can fill on any
  // LATER bar via tick(), not just bars with a queued script signal. Two
  // responsibilities per fill:
  //  1. Record the realized-P&L delta as a closed trade, attributed to
  //     whichever bar is currently being processed.
  //  2. Once the position is flat again, sweep-cancel any other 'working'
  //     order for the symbol — handles both a bracket firing (cancel its
  //     sibling) and the script's own strategy.exit firing (cancel both
  //     remaining brackets), so a leftover order can never later
  //     flip/reopen a position while genuinely flat.
  broker.onFill(() => {
    const acct = broker.getAccount();
    const delta = acct.realizedPnL - prevRealizedPnL;
    if (delta !== 0) trades.push({ barIdx: currentBarIdx, pnl: delta });
    prevRealizedPnL = acct.realizedPnL;

    const openPos = broker.getPositions().find(p => p.symbol === symbol && p.qty !== 0);
    if (!openPos) {
      for (const o of broker.getOrders()) {
        if (o.symbol === symbol && o.status === 'working') broker.cancelOrder(o.id);
      }
    }
  });

  // ── Signal source resolution (one-script-both-roles bridge) ──
  // Explicit strategy.entry()/exit() calls always win under 'auto'; scripts
  // that only plot Buy/Sell markers fall back to shape-derived orders, and
  // 'shapes'/'strategy' force one side. The replay below is identical either
  // way — derivation only decides WHICH order stream is replayed.
  const signalMode = config.signalSource ?? 'auto';
  let replayOrders: OakStrategyOrder[] = workerResult.strategyOrders;
  let signalSourceUsed: BacktestResult['signalSourceUsed'] = replayOrders.length > 0 ? 'strategy' : 'none';
  if (signalMode === 'shapes' || (signalMode === 'auto' && replayOrders.length === 0)) {
    const derived = deriveOrdersFromShapes(workerResult.signalShapes ?? [], config.entryMatch, config.exitMatch);
    if (signalMode === 'shapes' || derived.length > 0) {
      replayOrders = derived;
      signalSourceUsed = derived.length > 0 ? 'shapes' : 'none';
    }
  } else if (signalMode === 'strategy') {
    signalSourceUsed = replayOrders.length > 0 ? 'strategy' : 'none';
  }

  // Index by the bar an order was EMITTED on, so each bar's open-tick can
  // look up "orders queued from the previous bar" in O(1).
  const ordersByBarIdx = new Map<number, OakStrategyOrder[]>();
  for (const order of replayOrders) {
    const list = ordersByBarIdx.get(order.barIdx) ?? [];
    list.push(order);
    ordersByBarIdx.set(order.barIdx, list);
  }

  for (let i = 0; i < bars.count; i++) {
    currentBarIdx = i;

    // Open-tick: updates lastPrice to this bar's open, and evaluates any
    // working stop-loss/take-profit bracket orders against it.
    broker.tick(symbol, bars.open[i], bars.time[i]);

    // Fill orders queued from the PREVIOUS bar's signal at THIS bar's open —
    // the next-bar-open rule: a signal computed from a bar's own close
    // cannot fill at that same bar's price (lookahead bias).
    const queued = i > 0 ? ordersByBarIdx.get(i - 1) : undefined;
    if (queued) {
      for (const order of queued) {
        const openPos = broker.getPositions().find(p => p.symbol === symbol && p.qty !== 0);

        // Position-level semantics (PaperBroker keys positions by symbol
        // only, not by order id) — entry/exit are plain flatten-on-signal.
        if (order.kind === 'entry') {
          if (openPos) continue;
          const side = order.direction === 'short' ? 'sell' : 'buy';
          const qty = order.qty ?? config.qtyPerTrade;
          const filled = broker.placeOrder({ symbol, side, type: 'market', qty });
          if (filled.status === 'filled' && filled.fillPrice !== undefined) {
            placeBracketOrders(broker, symbol, side, qty, filled.fillPrice, config, order.stopLoss, order.takeProfit);
          }
        } else {
          if (!openPos) continue;
          // Direction-conditional exit (model.longExit/shortExit): only
          // flattens when the open side matches. Undirected exits
          // (model.exit / legacy strategy.exit) flatten whatever is open.
          if (order.direction === 'long' && openPos.qty <= 0) continue;
          if (order.direction === 'short' && openPos.qty >= 0) continue;
          const side = openPos.qty > 0 ? 'sell' : 'buy';
          broker.placeOrder({ symbol, side, type: 'market', qty: Math.abs(openPos.qty) });
        }
      }
    }

    // Full-bar tick: evaluates every working stop-loss/take-profit/
    // trailing-stop bracket against the bar's ACTUAL high/low range, not
    // just its open and close — a wick that touches a level and reverses
    // before the close now fills, with gap-through pricing and a
    // deterministic same-bar ambiguity rule. See PaperBroker.tickBar() for
    // the full intrabar fill model. Also marks lastPrice to this bar's
    // close, which the equity curve below is priced against.
    broker.tickBar(symbol, { open: bars.open[i], high: bars.high[i], low: bars.low[i], close: bars.close[i] }, bars.time[i]);
    equityCurve.push({ barIdx: i, time: bars.time[i], equity: broker.getAccount().equity });
  }

  const splitBarIdx = Math.max(0, Math.min(bars.count - 1, Math.floor(bars.count * (config.inSamplePct / 100))));
  const inSamplePoints = equityCurve.filter(p => p.barIdx <= splitBarIdx);
  const outOfSamplePoints = equityCurve.filter(p => p.barIdx > splitBarIdx);
  const inSampleTrades = trades.filter(t => t.barIdx <= splitBarIdx);
  const outOfSampleTrades = trades.filter(t => t.barIdx > splitBarIdx);

  opts?.onProgress?.('done');

  return {
    config,
    equityCurve,
    trades,
    inSample: computeSampleStats('in-sample', inSamplePoints, inSampleTrades),
    outOfSample: computeSampleStats('out-of-sample', outOfSamplePoints, outOfSampleTrades),
    scriptErrors: workerResult.errors,
    scriptAlertCount: workerResult.alerts.length,
    splitBarIdx,
    totalBars: bars.count,
    signalSourceUsed,
    orderCount: replayOrders.length,
  };
}
