import type { TradeRecord } from './execution';

export const TRADES_KEY = 'dafe_mobile_trades';
export const LEDGER_KEY = 'dafe_mobile_ledger';
const GENESIS_HASH = 'GENESIS';

export interface LedgerEntry {
  seq: number;
  ts: number;
  action: string;
  details: TradeRecord;
  prevHash: string;
  hash: string;
}

export type VerifyResult = { ok: true; count: number } | { ok: false; seq: number; reason: string };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readLedger(): LedgerEntry[] {
  return readJson<LedgerEntry[]>(LEDGER_KEY, []);
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x)).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function entryHash(e: Omit<LedgerEntry, 'hash'>): Promise<string> {
  return sha256Hex(canonical({ seq: e.seq, ts: e.ts, action: e.action, details: e.details, prevHash: e.prevHash }));
}

// Every chain write goes through this one queue. Fill-time sealing and the
// sheet's backfill both read the chain tail, so they must run one at a time
// or two entries could claim the same prevHash.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

async function sealMissing(trades: TradeRecord[]): Promise<LedgerEntry[]> {
  const entries = readLedger();
  const sealed = new Set(entries.map((e) => e.details?.id));
  let changed = false;
  for (const t of trades) {
    if (!t || sealed.has(t.id)) continue;
    const prev = entries[entries.length - 1];
    const base = {
      seq: prev ? prev.seq + 1 : 0,
      ts: Date.now(),
      action: 'fill',
      details: t,
      prevHash: prev ? prev.hash : GENESIS_HASH,
    };
    entries.push({ ...base, hash: await entryHash(base) });
    sealed.add(t.id);
    changed = true;
  }
  if (changed) writeJson(LEDGER_KEY, entries);
  return entries;
}

// Seals one fill as it is recorded. Callers pass the record before the trade
// store is trimmed, and the record is held here, so trimming cannot drop it.
export function sealFill(trade: TradeRecord): Promise<LedgerEntry[]> {
  return serial(() => sealMissing([trade]));
}

// Backfill for fills that were never sealed (older builds). Runs on sheet open.
export function sealFills(): Promise<LedgerEntry[]> {
  return serial(() => sealMissing(readJson<TradeRecord[]>(TRADES_KEY, [])));
}

export async function verifyLedger(entries: LedgerEntry[]): Promise<VerifyResult> {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return { ok: false, seq: i, reason: 'sequence gap' };
    if (e.prevHash !== prev) return { ok: false, seq: e.seq, reason: 'previous hash does not match' };
    const h = await entryHash(e);
    if (h !== e.hash) return { ok: false, seq: e.seq, reason: 'entry content does not match its hash' };
    prev = e.hash;
  }
  return { ok: true, count: entries.length };
}
