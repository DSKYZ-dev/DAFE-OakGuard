// ─── Chart Storyboard ────────────────────────────────────────────
// A chronological, browsable log of noteworthy moments — manually pinned
// notes plus auto-pinned entries from things this session already tracks
// deterministically (fired alerts). Rescoped from "AI Storyboard
// Annotations": the AI-GENERATED narration part is deferred — there is no
// LLM call anywhere in this file — but the underlying "pin moments to a
// timeline you can scroll through" infrastructure is real and useful on its
// own, and an LLM-written summary could plug into addStoryboardEntry()
// later without changing anything here.
//
// Deliberately its own module rather than built on drawings.ts's existing
// text-annotation tool: that system is in-memory only (lost on reload),
// anchors to a raw bar INDEX (meaningless after a symbol/timeframe switch,
// unlike a timestamp), and shares one render-cost eviction budget with
// unrelated trendlines/fibs/rectangles — a storyboard entry could get
// evicted just because the user was sketching elsewhere. This persists to
// localStorage and anchors to wall-clock time, the same convention Glass
// Ledger and trade markers already use.

export type StoryboardSource = 'manual' | 'alert';

export interface StoryboardEntry {
  id: string;
  ts: number;
  symbol: string;
  title: string;
  note: string;
  source: StoryboardSource;
}

const STORYBOARD_KEY = 'dafe_storyboard';
// Generous for a local single-user log — bounded so it can't grow forever,
// not tuned to any particular usage pattern.
const MAX_ENTRIES = 500;

export function getStoryboard(): StoryboardEntry[] {
  try {
    const raw = localStorage.getItem(STORYBOARD_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveStoryboard(entries: StoryboardEntry[]): void {
  try {
    localStorage.setItem(STORYBOARD_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort — a storage failure here must never break whatever
    // caller (e.g. an alert handler) is adding the entry.
  }
}

export function addStoryboardEntry(symbol: string, title: string, note: string, source: StoryboardSource): StoryboardEntry {
  const entries = getStoryboard();
  const entry: StoryboardEntry = {
    id: `sb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    symbol,
    title,
    note,
    source,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  saveStoryboard(entries);
  return entry;
}

export function removeStoryboardEntry(id: string): void {
  saveStoryboard(getStoryboard().filter(e => e.id !== id));
}

// ─── Modal ───────────────────────────────────────────────────────

export function showStoryboardModal(getCurrentSymbol: () => string): void {
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
  title.textContent = '📖 Storyboard';
  Object.assign(title.style, { color: '#b48cff', fontSize: '14px', fontWeight: '600', marginBottom: '4px' });
  modal.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'A chronological log of noteworthy moments — pin your own notes, or let fired alerts pin themselves.';
  Object.assign(subtitle.style, { color: 'rgba(255,255,255,0.4)', fontSize: '10px', marginBottom: '10px' });
  modal.appendChild(subtitle);

  // ── Add form ──
  const form = document.createElement('div');
  Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' });
  const fieldStyle = {
    padding: '5px 7px', border: '1px solid rgba(180,140,255,0.2)', borderRadius: '4px',
    background: 'rgba(12,12,28,0.9)', color: 'rgba(255,255,255,0.8)', fontSize: '11px', outline: 'none',
  };
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Title (e.g. "Broke resistance")';
  Object.assign(titleInput.style, fieldStyle);
  const noteInput = document.createElement('textarea');
  noteInput.placeholder = 'Note (optional)';
  noteInput.rows = 2;
  Object.assign(noteInput.style, { ...fieldStyle, resize: 'vertical' as const, fontFamily: 'inherit' });
  const addRow = document.createElement('div');
  Object.assign(addRow.style, { display: 'flex', gap: '6px', alignItems: 'center' });
  const symbolLabel = document.createElement('span');
  symbolLabel.textContent = getCurrentSymbol();
  Object.assign(symbolLabel.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)' });
  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add Annotation';
  Object.assign(addBtn.style, {
    padding: '5px 12px', border: '1px solid rgba(34,204,136,0.4)', borderRadius: '4px',
    background: 'rgba(34,204,136,0.12)', color: '#22cc88', cursor: 'pointer', fontSize: '11px', fontWeight: '600',
  });
  addRow.appendChild(symbolLabel);
  addRow.appendChild(addBtn);
  form.appendChild(titleInput);
  form.appendChild(noteInput);
  form.appendChild(addRow);
  modal.appendChild(form);

  const list = document.createElement('div');
  Object.assign(list.style, { flex: '1', overflow: 'auto', border: '1px solid rgba(180,140,255,0.1)', borderRadius: '6px', padding: '4px 8px' });

  function renderList(): void {
    list.innerHTML = '';
    const entries = [...getStoryboard()].reverse();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No annotations yet — add one above, or trigger an alert to auto-pin one.';
      Object.assign(empty.style, { color: 'rgba(255,255,255,0.4)', fontSize: '11px', padding: '10px 0' });
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      Object.assign(row.style, { padding: '6px 0', borderBottom: '1px solid rgba(180,140,255,0.08)' });

      const top = document.createElement('div');
      Object.assign(top.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' });

      const left = document.createElement('div');
      const titleLine = document.createElement('div');
      titleLine.textContent = `${entry.source === 'alert' ? '🔔' : '📝'} ${entry.title}`;
      Object.assign(titleLine.style, { fontSize: '11px', fontWeight: '600', color: 'rgba(255,255,255,0.85)' });
      left.appendChild(titleLine);
      if (entry.note) {
        const noteLine = document.createElement('div');
        noteLine.textContent = entry.note;
        Object.assign(noteLine.style, { fontSize: '10px', color: 'rgba(255,255,255,0.55)', marginTop: '1px' });
        left.appendChild(noteLine);
      }
      const metaLine = document.createElement('div');
      metaLine.textContent = `${entry.symbol} · ${new Date(entry.ts).toLocaleString()}`;
      Object.assign(metaLine.style, { fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginTop: '2px' });
      left.appendChild(metaLine);
      top.appendChild(left);

      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      Object.assign(delBtn.style, {
        background: 'none', border: '1px solid rgba(255,68,119,0.25)', color: 'rgba(255,68,119,0.7)',
        cursor: 'pointer', borderRadius: '3px', fontSize: '9px', padding: '1px 5px', flexShrink: '0',
      });
      delBtn.onclick = () => { removeStoryboardEntry(entry.id); renderList(); };
      top.appendChild(delBtn);

      row.appendChild(top);
      list.appendChild(row);
    }
  }
  renderList();
  modal.appendChild(list);

  addBtn.onclick = () => {
    const t = titleInput.value.trim();
    if (!t) { titleInput.focus(); return; }
    addStoryboardEntry(getCurrentSymbol(), t, noteInput.value.trim(), 'manual');
    titleInput.value = '';
    noteInput.value = '';
    renderList();
  };

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
