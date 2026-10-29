/**
 * Time Machine backtest worker — the signal-collection pass.
 *
 * Runs executeScript() ONCE over the full contiguous historical bar range
 * (in-sample + out-of-sample back to back). Splitting the range before
 * execution would starve out-of-sample bars of indicator warmup history and
 * reset persist/var state at the boundary — see engine.ts and the plan for
 * why the in-sample/out-of-sample split is applied only at stats time,
 * against the resulting continuous strategyOrders list.
 *
 * Returns order events plus a COMPACT projection of plotted signal markers
 * (plotshape/plotshape_3d → SignalShape) so the engine can derive entries/
 * exits from an indicator's own Buy/Sell markers — the one-script-both-roles
 * bridge. Full plots (per-bar line series etc.) are still deliberately NOT
 * returned; they're unused by the backtest and not worth serializing.
 */
import { parse } from '../oakscript/parser';
import { executeScript } from '../oakscript/interpreter';
import type { BacktestWorkerRequest, BacktestWorkerResponse, SignalShape } from './types';

// Safety valve for pathological scripts that stamp a marker on every bar of
// a huge range — beyond this the derivation would be meaningless anyway.
const MAX_SIGNAL_SHAPES = 20_000;

// Sidesteps the DOM/WebWorker global `self` typing conflict that comes from
// this project's single tsconfig including both libs — declare exactly the
// two members this file actually uses instead of relying on ambient globals.
interface WorkerSelf {
  onmessage: ((ev: MessageEvent<BacktestWorkerRequest>) => void) | null;
  postMessage(message: BacktestWorkerResponse): void;
}
const ctx = self as unknown as WorkerSelf;

ctx.onmessage = (ev: MessageEvent<BacktestWorkerRequest>) => {
  const { source, bars, inputOverrides, mlPredictions, rlActions } = ev.data;
  try {
    const ast = parse(source);
    const result = executeScript(ast, bars, new Map(), inputOverrides as Map<string, any> | undefined, undefined, mlPredictions, rlActions);
    const signalShapes: SignalShape[] = [];
    for (const p of result.plots) {
      if (signalShapes.length >= MAX_SIGNAL_SHAPES) break;
      if ((p.type === 'shape' || p.type === 'plot3d_shape') && typeof p.barIdx === 'number') {
        signalShapes.push({ barIdx: p.barIdx, name: p.name || p.text || '', style: p.style || p.shape3d });
      }
    }
    const response: BacktestWorkerResponse = {
      ok: true,
      strategyOrders: result.strategyOrders,
      signalShapes,
      alerts: result.alerts,
      errors: result.errors,
    };
    ctx.postMessage(response);
  } catch (e: any) {
    const response: BacktestWorkerResponse = {
      ok: false,
      strategyOrders: [],
      signalShapes: [],
      alerts: [],
      errors: [],
      parseError: e?.message ? String(e.message) : String(e),
    };
    ctx.postMessage(response);
  }
};
