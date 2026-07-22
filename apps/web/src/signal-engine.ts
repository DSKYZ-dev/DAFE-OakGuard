// ─── Signal Engine ──────────────────────────────────────────────────
// The one shared signal layer between Signal Analysis Models and everything that acts
// on them:
//
//   Signal Analysis Model (OakScript)
//         │
//         ▼
//    Signal Engine  ← this module
//         │
//         ├── Visualization   (plotted markers — unchanged, drawn from plots)
//         ├── Alerts          (alert()/alertcondition() — unchanged path)
//         ├── Backtester      (backtest/engine.ts derives replay orders here)
//         ├── Paper Trader    (main.ts auto-trade consumer via onLiveSignal)
//         ├── Live Automation (same live-edge stream; real-brokerage routing
//         │                    is deliberately NOT auto-wired — paper only)
//         └── Optimizer       (Model Lab batches run through the same
//                              backtest path, so it consumes this too)
//
// A script expresses signals EITHER as explicit strategy.entry()/exit()
// calls OR as plotted Buy/Sell markers (plotshape/plotshape_3d) — one
// script serves as both a chart study and an executable model, no TradingView-style
// dual-script split. Explicit strategy.* intent always wins when present;
// marker labels (then up/down marker style) classify the rest.

import type { OakPlot, OakStrategyOrder } from './oakscript/runtime';

export interface TradeSignal {
  kind: 'entry' | 'exit';
  direction: 'long' | 'short';
  barIdx: number;
  /** How this signal was expressed by the script. */
  source: 'strategy' | 'shape';
  /** The marker/order label that classified it (for provenance UIs). */
  label: string;
}

/** A live-edge signal handed to subscribed consumers (paper auto-trader). */
export interface LiveSignalEvent {
  instanceId: string;
  indicatorName: string;
  signal: TradeSignal;
}

export const DEFAULT_ENTRY_MATCH = 'buy|long|bull';
export const DEFAULT_EXIT_MATCH = 'sell|short|exit|bear|close';

function parseMatchers(raw: string | undefined, fallback: string): string[] {
  const src = (raw ?? '').trim() || fallback;
  return src.toLowerCase().split('|').map(s => s.trim()).filter(Boolean);
}

/** Minimal view of a plotted signal marker — satisfied by both live OakPlot
 * entries and the backtest worker's compact SignalShape projection. */
export interface SignalMarkerLike {
  barIdx?: number;
  name?: string;
  text?: string;
  style?: string;
  shape3d?: string;
}

/**
 * Classifies one plotted marker as entry/exit/neither. Exit vocabulary is
 * checked FIRST because it's the more specific one — "Exit Long" must be an
 * exit even though it also contains the entry word "long". When the label
 * matches neither list, the marker's up/down style (triangleup, coneup,
 * arrowup vs their down counterparts) breaks the tie.
 */
export function classifyMarker(m: SignalMarkerLike, entries: string[], exits: string[]): 'entry' | 'exit' | null {
  const label = (m.name || m.text || '').toLowerCase();
  if (exits.some(t => label.includes(t))) return 'exit';
  if (entries.some(t => label.includes(t))) return 'entry';
  const style = (m.style || m.shape3d || '').toLowerCase();
  if (/up$/.test(style)) return 'entry';
  if (/down$/.test(style)) return 'exit';
  return null;
}

/**
 * Derives an ordered long-flat signal stream from plotted markers. A bar
 * contributes at most one entry and one exit — scripts like the 3D
 * showcases plot the SAME signal twice (plotshape + plotshape_3d), which
 * must not double-signal.
 */
export function deriveSignalsFromMarkers(
  markers: SignalMarkerLike[],
  entryMatch?: string,
  exitMatch?: string,
): TradeSignal[] {
  const entries = parseMatchers(entryMatch, DEFAULT_ENTRY_MATCH);
  const exits = parseMatchers(exitMatch, DEFAULT_EXIT_MATCH);
  const signals: TradeSignal[] = [];
  const seen = new Set<string>();
  for (const m of markers) {
    if (typeof m.barIdx !== 'number') continue;
    const kind = classifyMarker(m, entries, exits);
    if (!kind) continue;
    const key = `${m.barIdx}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({ kind, direction: 'long', barIdx: m.barIdx, source: 'shape', label: m.name || m.text || m.style || '' });
  }
  signals.sort((a, b) => a.barIdx - b.barIdx);
  return signals;
}

/** Normalizes explicit strategy.entry()/exit() orders into TradeSignals. */
export function signalsFromStrategyOrders(orders: OakStrategyOrder[]): TradeSignal[] {
  return orders.map(o => ({
    kind: o.kind,
    direction: o.direction === 'short' ? 'short' as const : 'long' as const,
    barIdx: o.barIdx,
    source: 'strategy' as const,
    label: o.id,
  }));
}

/** Extracts the signal-marker subset of a script run's plots. */
export function signalMarkersFromPlots(plots: OakPlot[]): SignalMarkerLike[] {
  return plots.filter(p => (p.type === 'shape' || p.type === 'plot3d_shape') && typeof p.barIdx === 'number');
}

/**
 * The one shared extraction rule: explicit strategy.* calls when the script
 * makes any, plotted-marker derivation otherwise ('auto'); or force one
 * side ('strategy'/'shapes').
 */
export function extractSignals(opts: {
  plots: OakPlot[];
  strategyOrders: OakStrategyOrder[];
  mode?: 'auto' | 'strategy' | 'shapes';
  entryMatch?: string;
  exitMatch?: string;
}): { signals: TradeSignal[]; sourceUsed: 'strategy' | 'shapes' | 'none' } {
  const mode = opts.mode ?? 'auto';
  if (mode !== 'shapes' && opts.strategyOrders.length > 0) {
    return { signals: signalsFromStrategyOrders(opts.strategyOrders), sourceUsed: 'strategy' };
  }
  if (mode === 'strategy') return { signals: [], sourceUsed: 'none' };
  const derived = deriveSignalsFromMarkers(signalMarkersFromPlots(opts.plots), opts.entryMatch, opts.exitMatch);
  return { signals: derived, sourceUsed: derived.length > 0 ? 'shapes' : 'none' };
}

// ─── Live-edge pub/sub ─────────────────────────────────────────────
// indicator-manager.ts emits ONLY genuinely-new signals here (first-run
// backfill suppressed, same anti-spam discipline as alert forwarding).
// Consumers must assume events are live-edge and act idempotently.

type LiveSignalListener = (e: LiveSignalEvent) => void;
const liveListeners = new Set<LiveSignalListener>();

export function onLiveSignal(cb: LiveSignalListener): () => void {
  liveListeners.add(cb);
  return () => liveListeners.delete(cb);
}

export function emitLiveSignal(e: LiveSignalEvent): void {
  for (const cb of liveListeners) {
    try { cb(e); } catch { /* one consumer's failure must not starve the rest */ }
  }
}
