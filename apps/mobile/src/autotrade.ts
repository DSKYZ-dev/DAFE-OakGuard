import { loadBroker, type ActiveIndicator } from './state';
import { loadBrokerSettings } from './broker-store';
import type { ExecutionEngine } from './execution';
import { extractSignals, type TradeSignal } from '../../web/src/signal-engine';

// Paper-only auto-trade. Mirrors the desktop onLiveSignal consumer in
// apps/web/src/main.ts: the master switch AND the model's own arm must both be
// on; entries open only when flat; exits flatten only a position on the
// matching side. The first look at a model only records what is already on
// the chart (no orders), so arming never replays history. After that, every
// closed bar since the model's last processed bar is handled in order, up to
// the newest CATCHUP_BARS closed bars.

const MASTER_KEY = 'dafe_mobile_autotrade';
const ARMS_KEY = 'dafe_mobile_autotrade_arms';
const LAST_KEY = 'dafe_mobile_autotrade_last';
const QTY_KEY = 'dafe_mobile_autotrade_qty';
const SEEN_CAP = 40;
const CATCHUP_BARS = 50;

interface SeenRecord {
  last: number;
  keys: string[];
}

let sessionOrders = 0;
let seenCache: Record<string, SeenRecord> | null = null;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isAutoTradeOn(): boolean {
  try { return localStorage.getItem(MASTER_KEY) === '1'; } catch { return false; }
}

export function setAutoTradeOn(on: boolean): void {
  try { localStorage.setItem(MASTER_KEY, on ? '1' : '0'); } catch { /* storage full */ }
}

function armedIds(): string[] {
  const v = readJson(ARMS_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function isArmed(id: string): boolean {
  return armedIds().includes(id);
}

export function setArmed(id: string, on: boolean): void {
  const ids = armedIds().filter((x) => x !== id);
  if (on) ids.push(id);
  try { localStorage.setItem(ARMS_KEY, JSON.stringify(ids)); } catch { /* storage full */ }
}

export function autoTradeQty(): number {
  try {
    const n = Number(localStorage.getItem(QTY_KEY) ?? '1');
    return Number.isInteger(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

export function setAutoTradeQty(qty: number): void {
  try { localStorage.setItem(QTY_KEY, String(qty)); } catch { /* storage full */ }
}

export function autoTradeOrderCount(): number {
  return sessionOrders;
}

export function autoTradeStatusText(): string {
  return isAutoTradeOn() ? `Auto-trade: on · ${sessionOrders} orders this session` : 'Auto-trade: off';
}

export function isPaperOnly(): boolean {
  return loadBrokerSettings().mode === 'paper';
}

// Per model: `last` is the timestamp of the newest closed bar already handled;
// `keys` are `${barTimestamp}:${side}` so one bar and side never orders twice.
// Kept in memory and in localStorage so a reload cannot repeat an order.
function seenState(): Record<string, SeenRecord> {
  if (seenCache) return seenCache;
  const v = readJson(LAST_KEY);
  const out: Record<string, SeenRecord> = {};
  if (v && typeof v === 'object') {
    for (const [id, rec] of Object.entries(v as Record<string, unknown>)) {
      if (!rec || typeof rec !== 'object') continue;
      const { last, keys } = rec as { last?: unknown; keys?: unknown };
      if (typeof last !== 'number' || !Array.isArray(keys)) continue;
      out[id] = { last, keys: keys.filter((k): k is string => typeof k === 'string') };
    }
  }
  seenCache = out;
  return out;
}

function saveSeen(): void {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(seenState())); } catch { /* storage full */ }
}

function sideOf(s: TradeSignal): string {
  if (s.kind === 'exit') return 'exit';
  return s.direction === 'short' ? 'sell' : 'buy';
}

export interface AutoTradeContext {
  symbol: string;
  indicators: ActiveIndicator[];
  bars: readonly { timestamp: number; close: number }[];
  engine: ExecutionEngine;
  notify: (msg: string, kind: 'ok' | 'warn' | 'err') => void;
}

/** Runs once per chart recompute. Returns true when an order was placed. */
export function runAutoTrade(ctx: AutoTradeContext): boolean {
  const n = ctx.bars.length;
  if (n < 2) return false;
  // The newest bar may still be forming, so the newest CLOSED bar is n-2.
  const closedIdx = n - 2;
  const closedTs = ctx.bars[closedIdx].timestamp;
  const firstIdx = Math.max(0, closedIdx - CATCHUP_BARS + 1);
  const master = isAutoTradeOn();
  const seen = seenState();
  let placed = false;
  let dirty = false;

  for (const ind of ctx.indicators) {
    if (!ind.enabled) continue;
    const signals = extractSignals({ plots: ind.plots, strategyOrders: ind.strategyOrders ?? [] }).signals;
    const rec = seen[ind.id];
    if (!rec) {
      seen[ind.id] = {
        last: closedTs,
        keys: signals.filter((s) => s.barIdx === closedIdx).map((s) => `${closedTs}:${sideOf(s)}`),
      };
      dirty = true;
      continue;
    }
    for (let i = firstIdx; i <= closedIdx; i++) {
      const ts = ctx.bars[i].timestamp;
      if (ts <= rec.last) continue;
      for (const s of signals) {
        if (s.barIdx !== i) continue;
        const k = `${ts}:${sideOf(s)}`;
        if (rec.keys.includes(k)) continue;
        rec.keys.push(k);
        if (rec.keys.length > SEEN_CAP) rec.keys.splice(0, rec.keys.length - SEEN_CAP);
        dirty = true;
        if (!master || !isArmed(ind.id)) continue;
        if (fire(ctx, ind, s)) placed = true;
      }
    }
    if (closedTs > rec.last) {
      rec.last = closedTs;
      dirty = true;
    }
  }
  if (dirty) saveSeen();
  return placed;
}

function fire(ctx: AutoTradeContext, ind: ActiveIndicator, s: TradeSignal): boolean {
  const pos = loadBroker().getPositions().find((p) => p.symbol === ctx.symbol && p.qty !== 0);
  let side: 'buy' | 'sell';
  let qty: number;
  if (s.kind === 'entry') {
    if (pos) return false;
    side = s.direction === 'short' ? 'sell' : 'buy';
    qty = autoTradeQty();
  } else {
    if (!pos) return false;
    if (s.direction === 'long' && pos.qty <= 0) return false;
    if (s.direction === 'short' && pos.qty >= 0) return false;
    side = pos.qty > 0 ? 'sell' : 'buy';
    qty = Math.abs(pos.qty);
  }
  if (!isPaperOnly()) {
    ctx.notify('Auto-trade is paper-only on mobile.', 'warn');
    return false;
  }
  const label = s.kind === 'entry' ? (side === 'sell' ? 'short entry' : 'long entry') : 'exit';
  const price = ctx.bars[ctx.bars.length - 1].close;
  const r = ctx.engine.submit({ symbol: ctx.symbol, side, qty, type: 'market' }, price);
  // A rejection is already announced by the engine's risk event (main.ts toast).
  if (r.status === 'rejected') return false;
  sessionOrders++;
  ctx.notify(`⚡ ${ind.name} ${label} → ${qty} ${ctx.symbol} (paper)`, 'ok');
  return true;
}
