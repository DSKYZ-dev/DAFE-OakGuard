// ─── Glass Ledger ────────────────────────────────────────────────
// A hash-chained, tamper-evident audit log of the app's material actions
// (trade fills, indicator saves/deletes). Each entry's hash covers its own
// content AND the previous entry's hash, so editing or removing any single
// past entry breaks verification for every entry after it — the standard
// "blockchain-shaped" integrity property, applied locally with no network
// or consensus involved: this proves internal self-consistency (nothing was
// silently altered after the fact), not who performed an action.
import { sha256Hex } from './crypto-utils';

export interface LedgerEntry {
  seq: number;
  ts: number;
  action: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type LedgerVerification =
  | { ok: true; checkedCount: number; prunedBefore: boolean }
  | { ok: false; brokenAtSeq: number; reason: string };

const LEDGER_KEY = 'dafe_glass_ledger';
const GENESIS_HASH = 'GENESIS';
// Generous for a local single-user log of human-paced actions (trades,
// saves) — pruning the oldest entries once exceeded, not silently unbounded
// growth of localStorage.
const MAX_ENTRIES = 5000;

function computeEntryHash(
  seq: number, ts: number, action: string, details: Record<string, unknown>, prevHash: string,
): Promise<string> {
  return sha256Hex(JSON.stringify({ seq, ts, action, details, prevHash }));
}

export function getLedger(): LedgerEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveLedger(entries: LedgerEntry[]): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
  } catch {
    // Storage quota or similar — the ledger is best-effort auditing, not a
    // system of record the rest of the app depends on, so a write failure
    // here must never throw back into the caller (e.g. a trade fill
    // handler) and break the actual feature it's just observing.
  }
}

async function appendLedgerEntryInternal(action: string, details: Record<string, unknown>): Promise<LedgerEntry> {
  const entries = getLedger();
  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  const prevHash = last ? last.hash : GENESIS_HASH;
  const seq = last ? last.seq + 1 : 0;
  const ts = Date.now();
  const hash = await computeEntryHash(seq, ts, action, details, prevHash);
  const entry: LedgerEntry = { seq, ts, action, details, prevHash, hash };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  saveLedger(entries);
  return entry;
}

// Serializes concurrent appends through one promise chain so two near-
// simultaneous callers (e.g. two fills in the same tick) can never both
// read the same "last entry" and race each other's write — every append
// sees the true previous entry, however many callers fire without awaiting.
let appendQueue: Promise<unknown> = Promise.resolve();
export function appendLedgerEntry(action: string, details: Record<string, unknown>): Promise<LedgerEntry> {
  const result = appendQueue.then(() => appendLedgerEntryInternal(action, details));
  appendQueue = result.catch(() => {});
  return result;
}

/**
 * Walks the stored chain and recomputes every entry's hash from its own
 * content, checking each links to the one before it. Reports `prunedBefore`
 * when the oldest stored entry's own prevHash isn't the GENESIS sentinel —
 * that means old entries were trimmed by MAX_ENTRIES, a disclosed, expected
 * condition, distinct from an actual broken/tampered link.
 */
export async function verifyLedger(): Promise<LedgerVerification> {
  const entries = getLedger();
  if (entries.length === 0) return { ok: true, checkedCount: 0, prunedBefore: false };

  const prunedBefore = entries[0].seq !== 0 || entries[0].prevHash !== GENESIS_HASH;
  let expectedPrevHash = entries[0].prevHash;

  for (const entry of entries) {
    if (entry.prevHash !== expectedPrevHash) {
      return { ok: false, brokenAtSeq: entry.seq, reason: `Entry ${entry.seq}'s prevHash doesn't match entry ${entry.seq - 1}'s hash.` };
    }
    const recomputed = await computeEntryHash(entry.seq, entry.ts, entry.action, entry.details, entry.prevHash);
    if (recomputed !== entry.hash) {
      return { ok: false, brokenAtSeq: entry.seq, reason: `Entry ${entry.seq}'s content doesn't match its stored hash.` };
    }
    expectedPrevHash = entry.hash;
  }
  return { ok: true, checkedCount: entries.length, prunedBefore };
}

// ─── Viewer modal ────────────────────────────────────────────────

function summarizeDetails(action: string, details: Record<string, unknown>): string {
  switch (action) {
    case 'trade.fill':
      return `${String(details.side).toUpperCase()} ${details.qty} ${details.symbol} @ ${Number(details.price).toFixed(4)}`;
    case 'indicator.save':
      return `"${details.name}"${details.overwrite ? ' (overwrite)' : ''}`;
    case 'indicator.delete':
      return `"${details.name}"`;
    default:
      return JSON.stringify(details);
  }
}

export function showLedgerModal(): void {
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', zIndex: '99999' });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    background: 'rgba(8, 8, 20, 0.98)', border: '1px solid rgba(180, 140, 255, 0.3)',
    borderRadius: '10px', padding: '20px', zIndex: '100000', width: '480px', maxWidth: '90vw',
    maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
  });

  const title = document.createElement('div');
  title.textContent = '🔗 Glass Ledger';
  Object.assign(title.style, { color: '#b48cff', fontSize: '14px', fontWeight: '600', marginBottom: '4px' });
  modal.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'A hash-chained, tamper-evident record of trade fills and indicator saves/deletes.';
  Object.assign(subtitle.style, { color: 'rgba(255,255,255,0.4)', fontSize: '10px', marginBottom: '10px' });
  modal.appendChild(subtitle);

  const verifyRow = document.createElement('div');
  Object.assign(verifyRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' });
  const verifyBtn = document.createElement('button');
  verifyBtn.textContent = '✓ Verify Integrity';
  Object.assign(verifyBtn.style, {
    padding: '5px 12px', border: '1px solid rgba(34,204,136,0.4)', borderRadius: '4px',
    background: 'rgba(34,204,136,0.12)', color: '#22cc88', cursor: 'pointer', fontSize: '11px', fontWeight: '600',
  });
  const verifyStatus = document.createElement('span');
  Object.assign(verifyStatus.style, { fontSize: '10px', color: 'rgba(255,255,255,0.5)' });
  verifyBtn.onclick = async () => {
    verifyBtn.disabled = true;
    verifyStatus.textContent = 'Verifying...';
    verifyStatus.style.color = 'rgba(255,255,255,0.5)';
    const result = await verifyLedger();
    if (result.ok) {
      verifyStatus.textContent = result.checkedCount === 0
        ? 'Ledger is empty.'
        : `✓ Chain intact — ${result.checkedCount} entries verified.${result.prunedBefore ? ' (Oldest entries have been pruned; verified from the oldest entry still stored.)' : ''}`;
      verifyStatus.style.color = '#22cc88';
    } else {
      verifyStatus.textContent = `✗ BROKEN at entry ${result.brokenAtSeq}: ${result.reason}`;
      verifyStatus.style.color = '#ff4477';
    }
    verifyBtn.disabled = false;
  };
  verifyRow.appendChild(verifyBtn);
  verifyRow.appendChild(verifyStatus);
  modal.appendChild(verifyRow);

  const list = document.createElement('div');
  Object.assign(list.style, { flex: '1', overflow: 'auto', border: '1px solid rgba(180,140,255,0.1)', borderRadius: '6px', padding: '4px 8px' });

  const entries = getLedger();
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No ledger entries yet — they appear as you place trades or save indicators.';
    Object.assign(empty.style, { color: 'rgba(255,255,255,0.4)', fontSize: '11px', padding: '10px 0' });
    list.appendChild(empty);
  } else {
    for (const entry of [...entries].reverse()) {
      const row = document.createElement('div');
      Object.assign(row.style, { padding: '6px 0', borderBottom: '1px solid rgba(180,140,255,0.08)' });

      const top = document.createElement('div');
      Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', fontSize: '10px' });
      const actionLabel = document.createElement('span');
      actionLabel.textContent = `#${entry.seq} · ${entry.action}`;
      actionLabel.style.color = '#b48cff';
      actionLabel.style.fontWeight = '600';
      const timeLabel = document.createElement('span');
      timeLabel.textContent = new Date(entry.ts).toLocaleString();
      timeLabel.style.color = 'rgba(255,255,255,0.35)';
      top.appendChild(actionLabel);
      top.appendChild(timeLabel);
      row.appendChild(top);

      const detail = document.createElement('div');
      detail.textContent = summarizeDetails(entry.action, entry.details);
      Object.assign(detail.style, { fontSize: '10px', color: 'rgba(255,255,255,0.65)', marginTop: '2px' });
      row.appendChild(detail);

      const hashLine = document.createElement('div');
      hashLine.textContent = `hash ${entry.hash.slice(0, 16)}…`;
      Object.assign(hashLine.style, { fontSize: '9px', color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', marginTop: '2px' });
      row.appendChild(hashLine);

      list.appendChild(row);
    }
  }
  modal.appendChild(list);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, {
    marginTop: '12px', padding: '6px 16px', border: '1px solid rgba(180, 140, 255, 0.3)',
    borderRadius: '4px', background: 'rgba(180, 140, 255, 0.1)',
    color: '#b48cff', cursor: 'pointer', fontSize: '11px', width: '100%',
  });
  closeBtn.onclick = () => { modal.remove(); backdrop.remove(); };
  modal.appendChild(closeBtn);

  backdrop.onclick = () => { modal.remove(); backdrop.remove(); };
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
}
