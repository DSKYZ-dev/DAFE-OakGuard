import { openSheet, closeSheet, sectionTitle } from './sheets';
import { state, widgetHidden, type ActiveIndicator, type WidgetKey } from './state';
import { deriveMetrics } from './metrics-adapter';
import { findBackend, backendHeaders } from './backend';
import { nativePost } from './native-http';
import { readLedger, cryptoAvailable, sealFills, verifyLedger, type LedgerEntry } from './ledger';
import { isAutoTradeOn, setAutoTradeOn, isArmed, setArmed, autoTradeStatusText, isPaperOnly, autoTradeQty, setAutoTradeQty } from './autotrade';

export interface PanelsHooks {
  getSymbol: () => string;
  openParams: () => void;
  openScripts: () => void;
  refreshChart: () => void;
  persist: () => void;
  openTab: (id: 'trade' | 'settings') => void;
  getVolumeProfile: () => boolean;
  setVolumeProfile: (on: boolean) => void;
  getLowerPane: () => boolean;
  setLowerPane: (on: boolean) => void;
  setWidgetHidden: (key: WidgetKey, hidden: boolean) => void;
}

const DASH_KEY = 'dafe_mobile_dash_disabled';
const STORYBOARD_KEY = 'dafe_mobile_storyboard';
const KEPT_NOTE = 'Kept when you reset the app. This is the audit log.';
const FED_KEYWORDS = ['fomc', 'federal reserve', 'fed chair', 'jerome powell', 'interest rate', 'fed speech', 'fed meeting', 'fomc minutes', 'fed decision', 'monetary policy'];

interface StoryNote {
  id: string;
  t: number;
  text: string;
}

interface NewsItem {
  title: string;
  url: string;
  tag: 'news' | 'earnings' | 'fed';
}

type NewsResult =
  | { kind: 'offline' }
  | { kind: 'error' }
  | { kind: 'ok'; items: NewsItem[]; fedEventTime: string | null; fetchedAt: string };

// Feeds send entities such as "S&amp;P". The desktop shows them decoded, because
// it writes them through innerHTML. DOMParser is inert: it runs no scripts and loads nothing.
function decodeEntities(text: string): string {
  return new DOMParser().parseFromString(text, 'text/html').documentElement.textContent || '';
}

// Same entry point the ⊞ Widgets hot-action calls.
export function openPanelsSheet(hooks: PanelsHooks): void {
  openSheet((body) => {
    body.appendChild(sectionTitle('Chart overlays'));
    const overlays = document.createElement('div');
    overlays.appendChild(toggleRow('Dashboard metrics band', 'Metric cards under the chart', !widgetHidden('dash'), (next) => {
      hooks.setWidgetHidden('dash', !next);
      openPanelsSheet(hooks);
    }));
    overlays.appendChild(toggleRow('Regime strip', 'Trend / range line above the chart', !widgetHidden('regime'), (next) => {
      hooks.setWidgetHidden('regime', !next);
      openPanelsSheet(hooks);
    }));
    overlays.appendChild(toggleRow('Volume profile', 'Volume-at-price overlay', hooks.getVolumeProfile(), (next) => {
      hooks.setVolumeProfile(next);
      openPanelsSheet(hooks);
    }));
    overlays.appendChild(toggleRow('3D lower pane', 'Lower manifold pane under the chart', hooks.getLowerPane(), (next) => {
      hooks.setLowerPane(next);
      openPanelsSheet(hooks);
    }));
    body.appendChild(overlays);

    body.appendChild(sectionTitle('Open'));
    const list = document.createElement('div');
    list.className = 'sheet-list';
    const active = state.indicators.filter((i) => i.enabled).length;
    list.appendChild(panelRow('📊', 'Active Signal Models', `${active} on chart · Auto-trade ${isAutoTradeOn() ? 'on' : 'off'}`, () => openSignalModelsSheet(hooks)));
    list.appendChild(panelRow('📰', 'News', state.symbol, () => openNewsSheet(hooks)));
    list.appendChild(panelRow('🔗', 'Ledger', 'Fill audit chain', () => openLedgerSheet(hooks)));
    list.appendChild(panelRow('📝', 'Storyboard', 'Chart notes', () => openStoryboardSheet(hooks)));
    list.appendChild(panelRow('💱', 'Trade', 'Orders and positions', () => {
      closeSheet();
      hooks.openTab('trade');
    }));
    list.appendChild(panelRow('⚙', 'Settings', 'Broker, data and risk', () => {
      closeSheet();
      hooks.openTab('settings');
    }));
    body.appendChild(list);
  }, { title: 'Widgets' });
}

function toggleRow(title: string, sub: string, shown: boolean, onChange: (next: boolean) => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'panel-signal-row';
  const info = document.createElement('div');
  info.className = 'panel-signal-info';
  const name = document.createElement('div');
  name.className = 'panel-signal-name';
  name.textContent = title;
  const s = document.createElement('div');
  s.className = 'panel-row-sub';
  s.textContent = sub;
  info.append(name, s);
  const controls = document.createElement('div');
  controls.className = 'panel-signal-controls';
  controls.appendChild(chip(shown ? 'On' : 'Off', title, () => onChange(!shown), shown ? 'on' : ''));
  row.append(info, controls);
  return row;
}

function panelRow(icon: string, title: string, sub: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sheet-row';
  const ic = document.createElement('span');
  ic.textContent = icon;
  const info = document.createElement('span');
  info.className = 'panel-row-text';
  const t = document.createElement('span');
  t.className = 'panel-row-title';
  t.textContent = title;
  const s = document.createElement('span');
  s.className = 'panel-row-sub';
  s.textContent = sub;
  info.append(t, s);
  b.append(ic, info);
  b.addEventListener('click', onClick);
  return b;
}

function backRow(hooks: PanelsHooks): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'panel-back';
  b.textContent = '← Widgets';
  b.addEventListener('click', () => openPanelsSheet(hooks));
  return b;
}

function infoLine(text: string, kind: '' | 'ok' | 'err' = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'panel-info' + (kind ? ' ' + kind : '');
  d.textContent = text;
  return d;
}

function chip(label: string, title: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'panel-chip' + (extra ? ' ' + extra : '');
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

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

// ─── Active Signal Models ───────────────────────────────────────

function dashOn(name: string): boolean {
  return !readJson<Record<string, boolean>>(DASH_KEY, {})[name];
}

function setDashOn(name: string, on: boolean): void {
  const d = readJson<Record<string, boolean>>(DASH_KEY, {});
  d[name] = !on;
  writeJson(DASH_KEY, d);
}

function openSignalModelsSheet(hooks: PanelsHooks): void {
  openSheet((body, close) => {
    body.appendChild(backRow(hooks));
    body.appendChild(autoTradeBlock(hooks));
    body.appendChild(sectionTitle('Active signal models'));
    // Only models that are on. A removed model leaves this list but stays in the library.
    const on = state.indicators.filter((i) => i.enabled);
    if (on.length === 0) {
      body.appendChild(infoLine('No models on. Turn one on in the Scripts tab.'));
      const go = document.createElement('button');
      go.className = 'panel-action';
      go.textContent = 'Open Scripts';
      go.addEventListener('click', () => {
        close();
        hooks.openScripts();
      });
      body.appendChild(go);
      return;
    }
    const metrics = new Map(deriveMetrics({ indicators: state.indicators }).map((m) => [m.id, m.hasMetrics]));
    for (const ind of on) {
      body.appendChild(signalRow(ind, metrics.get(ind.id) === true, hooks, close));
    }
  }, { title: 'Active Signal Models' });
}

// Master switch for paper auto-trade. Each model still needs its own 🤖 arm.
function autoTradeBlock(hooks: PanelsHooks): HTMLDivElement {
  const block = document.createElement('div');
  const on = isAutoTradeOn();
  block.appendChild(toggleRow('Auto-trade', 'Paper only · each model needs its 🤖 arm', on, (next) => {
    setAutoTradeOn(next);
    openSignalModelsSheet(hooks);
  }));
  block.appendChild(qtyRow());
  block.appendChild(infoLine(autoTradeStatusText(), on ? 'ok' : ''));
  if (!isPaperOnly()) block.appendChild(infoLine('Auto-trade is paper-only on mobile.', 'err'));
  return block;
}

// Whole units per auto order. Anything that is not a whole number >= 1 is
// refused and the field snaps back to the saved value.
function qtyRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'panel-signal-row';
  const info = document.createElement('div');
  info.className = 'panel-signal-info';
  const name = document.createElement('div');
  name.className = 'panel-signal-name';
  name.textContent = 'Order quantity';
  const sub = document.createElement('div');
  sub.className = 'panel-row-sub';
  sub.textContent = 'Whole units per auto order (min 1)';
  info.append(name, sub);
  const controls = document.createElement('div');
  controls.className = 'panel-signal-controls';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.inputMode = 'numeric';
  input.value = String(autoTradeQty());
  input.style.cssText = 'width:72px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-panel);color:var(--text);font-size:12px;';
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isInteger(v) && v >= 1) setAutoTradeQty(v);
    input.value = String(autoTradeQty());
  });
  controls.appendChild(input);
  row.append(info, controls);
  return row;
}

function signalRow(ind: ActiveIndicator, hasMetrics: boolean, hooks: PanelsHooks, close: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'panel-signal-row';

  const info = document.createElement('div');
  info.className = 'panel-signal-info';
  const name = document.createElement('div');
  name.className = 'panel-signal-name';
  name.textContent = ind.name;
  const sub = document.createElement('div');
  sub.className = 'panel-row-sub';
  sub.textContent = 'On chart';
  info.append(name, sub);

  const controls = document.createElement('div');
  controls.className = 'panel-signal-controls';

  if (hasMetrics) {
    const on = dashOn(ind.name);
    controls.appendChild(chip('📊', 'Dashboard metrics', () => {
      setDashOn(ind.name, !dashOn(ind.name));
      openSignalModelsSheet(hooks);
    }, on ? 'on' : ''));
  }

  const armed = isArmed(ind.id);
  controls.appendChild(chip('🤖', armed ? 'Auto-trade armed (paper) — tap to disarm' : 'Arm auto-trade for this model (paper)', () => {
    setArmed(ind.id, !armed);
    openSignalModelsSheet(hooks);
  }, armed ? 'on' : ''));

  const params = chip('⚙', 'Parameters', () => {
    close();
    hooks.openParams();
  });
  controls.appendChild(params);

  controls.appendChild(chip('✕', 'Remove from chart (stays in library)', () => {
    ind.enabled = false;
    ind.plots = [];
    ind.errors = [];
    hooks.persist();
    hooks.refreshChart();
    openSignalModelsSheet(hooks);
  }, 'danger'));

  row.append(info, controls);
  return row;
}

// ─── News ───────────────────────────────────────────────────────

function extractEventTime(title: string): string {
  const timeMatch = title.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/);
  if (timeMatch) return 'Local: ' + timeMatch[0];
  const dateMatch = title.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/);
  if (dateMatch) return dateMatch[0];
  return '';
}

function parseBody(data: unknown): any {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return null; }
  }
  return data && typeof data === 'object' ? data : null;
}

async function fetchNews(sym: string): Promise<NewsResult> {
  try {
    if (state.backendMode === 'offline') return { kind: 'offline' };
    const base = await findBackend();
    if (!base) return { kind: 'offline' };
    const queries: { query: string; category: string; tag: NewsItem['tag'] }[] = [
      { query: `${sym} stock`, category: 'news', tag: 'news' },
      { query: `${sym} earnings`, category: 'earnings', tag: 'earnings' },
      { query: 'federal reserve fed chair speech market', category: 'news', tag: 'fed' },
      { query: 'economic calendar fed meeting FOMC minutes release this week', category: 'news', tag: 'fed' },
    ];
    const responses = await Promise.all(
      queries.map((q) => nativePost(`${base}/api/web-search/search`, { query: q.query, category: q.category }, backendHeaders())),
    );
    const fetchedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const items: NewsItem[] = [];
    let fedEventTime: string | null = null;
    for (let i = 0; i < queries.length; i++) {
      const res = responses[i];
      const data = res && res.status >= 200 && res.status < 300 ? parseBody(res.data) : null;
      if (!data || !data.ok || !Array.isArray(data.results)) continue;
      for (const r of data.results.slice(0, 4)) {
        const title = decodeEntities(String(r?.title || r?.snippet || '')).trim();
        if (!title) continue;
        const tag = queries[i].tag;
        items.push({ title, url: String(r?.url || ''), tag });
        if (tag === 'fed' && fedEventTime === null && FED_KEYWORDS.some((k) => title.toLowerCase().includes(k))) {
          fedEventTime = extractEventTime(title);
        }
      }
    }
    return { kind: 'ok', items, fedEventTime, fetchedAt };
  } catch {
    return { kind: 'error' };
  }
}

function openNewsSheet(hooks: PanelsHooks): void {
  const sym = hooks.getSymbol();
  openSheet((body) => {
    body.appendChild(backRow(hooks));
    body.appendChild(sectionTitle(`News · ${sym}`));
    const out = document.createElement('div');
    out.appendChild(infoLine('Loading news…'));
    body.appendChild(out);
    void fetchNews(sym).then((res) => renderNews(out, res));
  }, { title: 'News' });
}

function renderNews(out: HTMLElement, res: NewsResult): void {
  out.replaceChildren();
  if (res.kind === 'offline') {
    out.appendChild(infoLine('Connect the backend in Settings to load news.'));
    return;
  }
  if (res.kind === 'error') {
    out.appendChild(infoLine('News unavailable'));
    return;
  }
  if (res.items.length === 0) {
    out.appendChild(infoLine('No recent news'));
    return;
  }
  if (res.fedEventTime !== null) {
    const banner = document.createElement('div');
    banner.className = 'panel-fed-banner';
    const time = document.createElement('span');
    time.textContent = res.fetchedAt;
    const msg = document.createElement('span');
    msg.textContent = `⚠ FED EVENT${res.fedEventTime ? ' — ' + res.fedEventTime : ''} — Expect volatility`;
    banner.append(msg, time);
    out.appendChild(banner);
  }
  for (const it of res.items) {
    const openable = /^https?:\/\//i.test(it.url);
    const b = document.createElement('button');
    b.className = 'panel-news-item';
    b.disabled = !openable;
    const title = document.createElement('div');
    title.className = 'panel-news-title';
    title.textContent = it.title;
    const meta = document.createElement('div');
    meta.className = 'panel-news-meta';
    const tag = document.createElement('span');
    tag.className = 'panel-tag ' + it.tag;
    tag.textContent = it.tag;
    const time = document.createElement('span');
    time.textContent = res.fetchedAt;
    meta.append(tag, time);
    b.append(title, meta);
    b.addEventListener('click', () => {
      if (openable) window.open(it.url, '_blank', 'noopener');
    });
    out.appendChild(b);
  }
}

// ─── Ledger ─────────────────────────────────────────────────────

function openLedgerSheet(hooks: PanelsHooks): void {
  openSheet((body) => {
    body.appendChild(backRow(hooks));
    body.appendChild(sectionTitle('Ledger'));
    body.appendChild(infoLine('Covers fills on this device only. The desktop ledger also records model changes; mobile does not yet.'));
    body.appendChild(infoLine(KEPT_NOTE));
    if (!cryptoAvailable()) {
      body.appendChild(infoLine('Hash unavailable on this device', 'err'));
      return;
    }
    const verifyRow = document.createElement('div');
    const verify = document.createElement('button');
    verify.className = 'panel-action';
    verify.textContent = 'Verify chain';
    const result = document.createElement('div');
    verifyRow.append(verify, result);
    const list = document.createElement('div');
    list.className = 'sheet-list';
    body.append(verifyRow, list);

    verify.addEventListener('click', async () => {
      verify.disabled = true;
      result.replaceChildren(infoLine('Verifying…'));
      try {
        const v = await verifyLedger(readLedger());
        result.replaceChildren(v.ok
          ? infoLine(`Chain ok — ${v.count} entr${v.count === 1 ? 'y' : 'ies'} verified`, 'ok')
          : infoLine(`Chain broken at entry #${v.seq}: ${v.reason}`, 'err'));
      } catch {
        result.replaceChildren(infoLine('Hash unavailable on this device', 'err'));
      }
      verify.disabled = false;
    });

    sealFills().then((entries) => renderLedgerList(list, entries)).catch(() => {
      list.replaceChildren(infoLine('Hash unavailable on this device', 'err'));
    });
  }, { title: 'Ledger' });
}

function renderLedgerList(list: HTMLElement, entries: LedgerEntry[]): void {
  list.replaceChildren();
  if (entries.length === 0) {
    list.appendChild(infoLine('No fills recorded on this device yet.'));
    return;
  }
  for (const e of [...entries].reverse()) {
    const d = e.details;
    const row = document.createElement('div');
    row.className = 'panel-signal-row';
    const info = document.createElement('div');
    info.className = 'panel-signal-info';
    const head = document.createElement('div');
    head.className = 'panel-signal-name';
    head.textContent = `#${e.seq} · ${String(d.side).toUpperCase()} ${d.qty} ${d.symbol}`;
    const sub = document.createElement('div');
    sub.className = 'panel-row-sub';
    const pnl = Number(d.pnl) || 0;
    sub.textContent = `${new Date(d.exitTime).toLocaleString()} · ${(pnl >= 0 ? '+' : '') + pnl.toFixed(2)}`;
    const hash = document.createElement('div');
    hash.className = 'panel-hash';
    hash.textContent = e.hash.slice(0, 16) + '…';
    info.append(head, sub, hash);
    row.appendChild(info);
    list.appendChild(row);
  }
}

// ─── Storyboard ─────────────────────────────────────────────────

function readNotes(): StoryNote[] {
  return readJson<StoryNote[]>(STORYBOARD_KEY, []).filter((n) => n && typeof n.text === 'string');
}

function openStoryboardSheet(hooks: PanelsHooks): void {
  openSheet((body) => {
    body.appendChild(backRow(hooks));
    body.appendChild(sectionTitle('Storyboard'));
    body.appendChild(infoLine('Your notes on this device. Triggered alert events are not on mobile yet.'));
    body.appendChild(infoLine(KEPT_NOTE));

    const input = document.createElement('textarea');
    input.className = 'panel-textarea';
    input.rows = 3;
    input.maxLength = 2000;
    input.placeholder = 'Write a note about this chart…';
    const add = document.createElement('button');
    add.className = 'panel-action';
    add.textContent = 'Add note';
    const status = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'sheet-list';

    const render = (): void => {
      list.replaceChildren();
      const notes = readNotes().sort((a, b) => b.t - a.t);
      if (notes.length === 0) list.appendChild(infoLine('No notes yet.'));
      for (const n of notes) {
        const item = document.createElement('div');
        item.className = 'panel-note-item';
        const text = document.createElement('div');
        text.className = 'panel-note-text';
        text.textContent = n.text;
        const meta = document.createElement('div');
        meta.className = 'panel-note-meta';
        const time = document.createElement('span');
        time.textContent = new Date(n.t).toLocaleString();
        const del = chip('✕', 'Delete note', () => {
          writeJson(STORYBOARD_KEY, readNotes().filter((x) => x.id !== n.id));
          render();
        }, 'danger');
        meta.append(time, del);
        item.append(text, meta);
        list.appendChild(item);
      }
    };

    add.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      const notes = readNotes();
      notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), t: Date.now(), text });
      if (!writeJson(STORYBOARD_KEY, notes)) {
        status.replaceChildren(infoLine('Could not save the note (storage full).', 'err'));
        return;
      }
      status.replaceChildren();
      input.value = '';
      render();
    });

    body.append(input, add, status, list);
    render();
  }, { title: 'Storyboard' });
}
