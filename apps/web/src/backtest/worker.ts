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
 * Deliberately does NOT return plots — unused by the backtest, and dropping
 * them avoids serializing potentially large arrays across the worker
 * boundary for nothing.
 */
import { parse } from '../oakscript/parser';
import { executeScript } from '../oakscript/interpreter';
import type { BacktestWorkerRequest, BacktestWorkerResponse } from './types';

// Sidesteps the DOM/WebWorker global `self` typing conflict that comes from
// this project's single tsconfig including both libs — declare exactly the
// two members this file actually uses instead of relying on ambient globals.
interface WorkerSelf {
  onmessage: ((ev: MessageEvent<BacktestWorkerRequest>) => void) | null;
  postMessage(message: BacktestWorkerResponse): void;
}
const ctx = self as unknown as WorkerSelf;

ctx.onmessage = (ev: MessageEvent<BacktestWorkerRequest>) => {
  const { source, bars, inputOverrides } = ev.data;
  try {
    const ast = parse(source);
    const result = executeScript(ast, bars, new Map(), inputOverrides as Map<string, any> | undefined);
    const response: BacktestWorkerResponse = {
      ok: true,
      strategyOrders: result.strategyOrders,
      alerts: result.alerts,
      errors: result.errors,
    };
    ctx.postMessage(response);
  } catch (e: any) {
    const response: BacktestWorkerResponse = {
      ok: false,
      strategyOrders: [],
      alerts: [],
      errors: [],
      parseError: e?.message ? String(e.message) : String(e),
    };
    ctx.postMessage(response);
  }
};
