import { setPerfMode } from '../../web/src/chart-renderer';
import { runMatrix, runSingleTrick, TrickId, TrickMatrix, DEFAULT_MATRIX, type TrickMetrics } from '../../web/src/perf-trick-test-engine';
import { submitReport } from './reports';
import { state, persistSettings, resetAll, BAR_TYPES, resetPaperBroker } from './state';
import { loadBrokerSettings, saveBrokerSettings, DEFAULT_RISK } from './broker-store';
import { tradovateLogin, syncTradovateProfile } from './tradovate';
import { showOnboarding } from './onboarding';

export interface SettingsScreen {
  dispose: () => void;
}

export function createSettingsScreen(container: HTMLDivElement): SettingsScreen {
  const scroll = document.createElement('div');
  scroll.className = 'scrollable';

  function card(title: string, rows: HTMLElement[]): HTMLElement {
    const c = document.createElement('div');
    c.className = 'trade-card';
    const t = document.createElement('div');
    t.className = 'trade-card-title';
    t.textContent = title;
    c.appendChild(t);
    rows.forEach((r) => c.appendChild(r));
    return c;
  }

  function row(label: string, control: HTMLElement): HTMLElement {
    const r = document.createElement('div');
    r.className = 'set-row';
    const l = document.createElement('label');
    l.textContent = label;
    r.appendChild(l);
    r.appendChild(control);
    return r;
  }

  // ── Backend ────────────────────────────────────────────────────
  const backendInput = document.createElement('input');
  backendInput.type = 'text';
  backendInput.placeholder = 'http://192.168.1.50:8788';
  backendInput.value = state.backendUrl;
  const backendStatus = document.createElement('div');
  backendStatus.className = 'set-status';
  backendStatus.textContent = state.backendUrl ? 'Check connection below' : 'Auto-detect — finds your PC server on the same network';

  const modeSel = document.createElement('select');
  ([
    ['auto', 'Auto-detect'],
    ['backend', 'Backend only'],
    ['offline', 'Offline only'],
  ] as const).forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    modeSel.appendChild(o);
  });
  modeSel.value = state.backendMode;
  modeSel.addEventListener('change', () => {
    state.backendMode = modeSel.value as typeof state.backendMode;
    backendStatus.textContent = state.backendMode === 'offline' ? 'Offline mode — synthetic data, local AI analysis' : 'Next chart load will use the backend';
    persistSettings();
  });

  const testBtn = document.createElement('button');
  testBtn.className = 'editor-run';
  testBtn.textContent = 'TEST CONNECTION';

  function testConnection(): void {
    const url = backendInput.value.trim();
    backendStatus.className = 'set-status wait';
    backendStatus.textContent = 'Connecting...';
    if (!url) {
      backendStatus.className = 'set-status err';
      backendStatus.textContent = 'Enter a server address first';
      return;
    }
    fetch(`${url.replace(/\/$/, '')}/api/ping`, { signal: AbortSignal.timeout(5000) })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          backendStatus.className = 'set-status ok';
          backendStatus.textContent = 'Connected — live data, news and AI advisor available';
        } else {
          throw new Error('Unexpected response');
        }
      })
      .catch((err) => {
        backendStatus.className = 'set-status err';
        backendStatus.textContent = `Unreachable (${err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'no server on this address'})`;
      });
  }
  testBtn.addEventListener('click', testConnection);
  backendInput.addEventListener('change', () => {
    state.backendUrl = backendInput.value.trim();
    persistSettings();
  });

  // Server Connection removed — app is standalone (Massive/Yahoo direct).
  // Backend remains optional via auto-detect but not shown in Settings per user request.
  void modeSel; void backendInput; void backendStatus; void testBtn;

  // ── Massive feed ───────────────────────────────────────────────
  const massiveInput = document.createElement('input');
  massiveInput.type = 'text';
  massiveInput.placeholder = 'Enter your Massive API key';
  massiveInput.value = state.massiveApiKey;
  const massiveStatus = document.createElement('div');
  massiveStatus.className = 'set-status';
  massiveStatus.textContent = state.massiveApiKey ? 'Massive feed enabled — real tick data, all timeframes' : 'Not configured — the app will use Yahoo Finance directly';
  const massiveTestBtn = document.createElement('button');
  massiveTestBtn.className = 'editor-run';
  massiveTestBtn.textContent = 'TEST MASSIVE KEY';
  massiveTestBtn.addEventListener('click', async () => {
    state.massiveApiKey = massiveInput.value.trim();
    persistSettings();
    const key = state.massiveApiKey;
    if (!key) {
      massiveStatus.className = 'set-status err';
      massiveStatus.textContent = 'Enter an API key first';
      return;
    }
    massiveStatus.className = 'set-status wait';
    massiveStatus.textContent = 'Testing...';
    try {
      const { nativeGet } = await import('./native-http');
      const res = await nativeGet('https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/2024-01-01/2024-01-02', { adjusted: 'true', sort: 'asc', limit: '5', apiKey: key }, 15000);
      if (!res || res.status <200 || res.status>=300) throw new Error(`HTTP ${res?.status||'no response'}`);
      const data = res.data;
      if (!data.results || data.results.length === 0) throw new Error('No data returned — key may lack permissions for this ticker/timeframe');
      massiveStatus.className = 'set-status ok';
      massiveStatus.textContent = `Key OK — ${data.results.length} bars fetched. Reload the chart to switch to Massive.`;
    } catch (err: any) {
      // Fallback: check if it's a 403 due to plan (1m should work, 1s requires upgrade)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('NOT_AUTHORIZED')) {
        massiveStatus.className = 'set-status warn';
        massiveStatus.textContent = `Key valid but plan lacks this data (403). Try 1m/1h for SPY — 1s needs upgrade. ${msg.slice(0,80)}`;
      } else {
        massiveStatus.className = 'set-status err';
        massiveStatus.textContent = `Massive rejected the key (${msg.slice(0,100)})`;
      }
    }
  });
  massiveInput.addEventListener('change', () => {
    state.massiveApiKey = massiveInput.value.trim();
    persistSettings();
  });

  scroll.appendChild(card('Data Feeds', [
    row('Massive API key', massiveInput),
    massiveStatus,
    massiveTestBtn,
    (() => {
      // Yahoo (yfinance) feed toggle — always available real data, no key.
      // When Massive is unset or rejected, this keeps the app on REAL prices
      // instead of silently degrading to synthetic.
      const wrap = document.createElement('div');
      wrap.style.marginTop = '10px';
      const lbl = document.createElement('div');
      lbl.textContent = 'Yahoo Finance (yfinance)';
      lbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--text);margin-bottom:4px;';
      const sub = document.createElement('div');
      sub.textContent = 'Free real market data — always on, no API key. Used automatically whenever Massive is not configured.';
      sub.className = 'set-info';
      const yBtn = document.createElement('button');
      yBtn.className = 'editor-run';
      yBtn.textContent = 'USE YFINANCE DATA NOW';
      yBtn.addEventListener('click', async () => {
        yBtn.textContent = 'Testing Yahoo...';
        try {
          const { fetchYahooBars } = await import('./yahoo');
          const bars = await fetchYahooBars('SPY', '5m');
          if (!bars || bars.length === 0) throw new Error('no data returned');
          const last = bars[bars.length - 1];
          const t = document.createElement('div'); t.className = 'toast ok';
          t.textContent = `Yahoo OK — SPY $${last.close.toFixed(2)} @ ${new Date(last.timestamp).toLocaleString()}`;
          document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
          yBtn.textContent = 'YFINANCE ACTIVE — REAL DATA ✓';
          (yBtn as HTMLButtonElement).disabled = false;
        } catch (e: any) {
          const t = document.createElement('div'); t.className = 'toast err';
          t.textContent = 'Yahoo unreachable: ' + (e?.message || e);
          document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
          yBtn.textContent = 'USE YFINANCE DATA NOW';
        }
      });
      wrap.appendChild(lbl);
      wrap.appendChild(sub);
      wrap.appendChild(yBtn);
      return wrap;
    })(),
    (() => {
      const i = document.createElement('div');
      i.className = 'set-info';
      i.textContent = 'Massive fetches real tick-derived bars (1s–30s timeframes) with an API key; Yahoo (yfinance) provides free real prices for every standard timeframe with zero setup.';
      return i;
    })(),
  ]));

  // ── Cloud LLM (unified agent) ────────────────────────────────────
  const LLM_KEY = 'dafe_mobile_llm';
  const OPENCODE_DEFAULT = { provider: 'opencode', baseUrl: 'https://api.opencode.ai/v1', apiKey: '', model: '' };
  const llmSaved = (() => {
    try {
      const cur = JSON.parse(localStorage.getItem(LLM_KEY) || '{}');
      if (!cur.apiKey && !cur.provider) {
        try { localStorage.setItem(LLM_KEY, JSON.stringify(OPENCODE_DEFAULT)); } catch {}
        return { ...OPENCODE_DEFAULT };
      }
      // Migrate stale/invalid default model ids — the live list is fetched
      // from the provider anyway.
      if (cur.model === 'Q-CLI') cur.model = '';
      return cur;
    } catch { return { ...OPENCODE_DEFAULT }; }
  })();
  const llmProv = document.createElement('select');
  (['ollama','opencode','orcarouter','openrouter','openai','anthropic','custom'] as const).forEach(p => {
    const o = document.createElement('option'); o.value = p; o.textContent = p[0].toUpperCase()+p.slice(1);
    llmProv.appendChild(o);
  });
  llmProv.value = llmSaved.provider || 'opencode';
  const llmUrl = document.createElement('input'); llmUrl.type = 'text'; llmUrl.placeholder = 'https://api.openai.com/v1  (or custom URL)';
  llmUrl.value = llmSaved.baseUrl || '';
  const llmKey = document.createElement('input'); llmKey.type = 'password'; llmKey.placeholder = 'API key (stored locally)';
  llmKey.value = llmSaved.apiKey || '';
  const llmModel = document.createElement('select'); llmModel.style.flex='1';
  let availableModels: string[] = Array.isArray(llmSaved.cachedModels) ? llmSaved.cachedModels : [];
  function currentCfg(): any {
    return { provider: llmProv.value, baseUrl: llmUrl.value.trim(), apiKey: llmKey.value.trim(), model: llmModel.value.trim() || llmModelCustom.value.trim() };
  }
  function populateModels(list: string[], selected?: string): void {
    llmModel.replaceChildren();
    for (const m of list) {
      const o = document.createElement('option'); o.value = m; o.textContent = m;
      if (selected ? m === selected : false) o.selected = true;
      llmModel.appendChild(o);
    }
    if (list.length === 0) {
      const o = document.createElement('option'); o.value=''; o.textContent = selected || '(refresh to load models)';
      o.selected = true; llmModel.appendChild(o);
    } else if (selected && !list.includes(selected)) {
      const o = document.createElement('option'); o.value=selected; o.textContent=`${selected} (saved)`; o.selected=true;
      llmModel.appendChild(o);
    }
    if (!selected) llmModel.selectedIndex = 0;
  }
  populateModels(availableModels, llmSaved.model || undefined);

  async function refreshModels(): Promise<void> {
    const cfg = currentCfg();
    if (!cfg.apiKey && cfg.provider !== 'ollama') {
      llmStatus.className = 'set-status err';
      llmStatus.textContent = 'Enter an API key first — then models load automatically';
      return;
    }
    llmStatus.className = 'set-status wait'; llmStatus.textContent = 'Fetching model list...';
    const { fetchLlmModels } = await import('./native-http');
    const r = await fetchLlmModels(cfg);
    if (!r.ok) {
      llmStatus.className = 'set-status err';
      llmStatus.textContent = `Model list failed — ${r.error}. You can still type a model manually.`;
      return;
    }
    availableModels = r.models;
    const saved = (() => { try { return JSON.parse(localStorage.getItem(LLM_KEY) || '{}'); } catch { return {}; } })();
    populateModels(availableModels, saved.model || undefined);
    saveLLM(true);
    const freeCount = r.models.filter(m => /free/i.test(m)).length;
    llmStatus.className = 'set-status ok';
    llmStatus.textContent = `${r.models.length} models loaded${freeCount > 0 ? ` (${freeCount} free listed first)` : ''}`;
  }

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'editor-run'; refreshBtn.textContent = 'LOAD MODELS';
  refreshBtn.addEventListener('click', () => { void refreshModels(); });

  // Also keep a custom input for manual entry / offline providers
  const llmModelCustom = document.createElement('input'); llmModelCustom.type='text'; llmModelCustom.placeholder='Or type custom model id';
  llmModelCustom.style.display='none';
  llmModelCustom.value = llmSaved.model || '';
  const llmStatus = document.createElement('div'); llmStatus.className = 'set-status';
  llmStatus.textContent = llmSaved.apiKey ? `Provider: ${llmSaved.provider || 'opencode'} — tap LOAD MODELS` : 'Connect any OpenAI-compatible API (Ollama local, OpenRouter, OpenAI, Anthropic native, etc.) — models pull straight from the provider';
  const llmTest = document.createElement('button'); llmTest.className = 'editor-run'; llmTest.textContent = 'TEST CONNECTION';

  function persistLLM(cfg: any): void {
    try { localStorage.setItem(LLM_KEY, JSON.stringify({ ...cfg, cachedModels: availableModels.slice(0, 200) })); } catch {}
  }
  const saveLLM = (quiet = false): void => {
    const cfg = currentCfg();
    persistLLM(cfg);
    if (!quiet) { llmStatus.className = 'set-status ok'; llmStatus.textContent = `Saved — ${cfg.provider} / ${cfg.model || 'default model'}`; }
  };

  llmProv.addEventListener('change', ()=>{ availableModels = []; populateModels([], ''); saveLLM(); void refreshModels(); });
  llmUrl.addEventListener('change', ()=>saveLLM());
  llmKey.addEventListener('change', ()=>{ saveLLM(); void refreshModels(); });
  llmModel.addEventListener('change', ()=>{ llmModelCustom.value=llmModel.value; saveLLM(); });
  llmModelCustom.addEventListener('change', ()=>saveLLM());

  llmTest.addEventListener('click', async () => {
    saveLLM();
    const cfg = currentCfg();
    if (!cfg.apiKey && cfg.provider !== 'ollama') { llmStatus.className = 'set-status err'; llmStatus.textContent = 'API key required for this provider'; return; }
    llmStatus.className = 'set-status wait'; llmStatus.textContent = 'Testing connection + loading models...';
    await refreshModels();
    if (llmStatus.className === 'set-status ok') {
      // Real generation probe — /models can succeed where chat fails (wrong
      // model id, quota). A tiny completion is the honest test.
      const { llmChat } = await import('./native-http');
      const probe = await llmChat(cfg, 'Reply with the single word: OK', 'ping', { maxTokens: 8, temperature: 0 });
      if (probe.ok) {
        llmStatus.textContent += ' — chat verified ✓';
      } else {
        llmStatus.className = 'set-status warn';
        llmStatus.textContent += ` — but chat FAILED: ${probe.error}`;
      }
    }
  });
  scroll.appendChild(card('AI — Unified Agent (Advisor + Editor)', [
    row('Provider', llmProv),
    row('Base URL', llmUrl),
    row('API key', llmKey),
    row('Model (auto)', llmModel),
    refreshBtn,
    llmStatus, llmTest,
    (() => { const i=document.createElement('div'); i.className='set-info'; i.textContent='Model list pulls live from your provider — free tiers sort first. TEST CONNECTION now sends a real 1-token chat so "connected" means the Editor and Advisor will actually answer.'; return i; })(),
  ]));

  // ── Trading / risk ─────────────────────────────────────────────
  const settings = loadBrokerSettings();

  const numRow = (label: string, value: number, on: (v: number) => void): HTMLElement => {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.addEventListener('change', () => on(Math.max(1, parseFloat(input.value) || value)));
    return row(label, input);
  };

  const riskRows = [
    numRow('Daily loss limit ($)', settings.risk.dailyLossLimit, (v) => { settings.risk.dailyLossLimit = v; saveBrokerSettings(settings); }),
    numRow('Max loss per trade ($)', settings.risk.maxLossPerTrade, (v) => { settings.risk.maxLossPerTrade = v; saveBrokerSettings(settings); }),
    numRow('Max contracts', settings.risk.maxContracts, (v) => { settings.risk.maxContracts = Math.round(v); saveBrokerSettings(settings); }),
    numRow('Default quantity', settings.risk.defaultQty, (v) => { settings.risk.defaultQty = Math.round(v); saveBrokerSettings(settings); }),
  ];

  const brokerStatus = document.createElement('div');
  brokerStatus.className = 'set-status';
  brokerStatus.textContent = settings.mode === 'tradovate'
    ? `Connected to Tradovate as ${settings.tradovate.name || '—'}`
    : 'Paper trading — no broker connected';
  const reconnectBtn = document.createElement('button');
  reconnectBtn.className = 'editor-run';
  reconnectBtn.textContent = settings.mode === 'tradovate' ? 'TEST TRADOVATE' : 'CONNECT TRADOVATE';
  reconnectBtn.addEventListener('click', async () => {
    if (settings.mode !== 'tradovate') {
      showOnboarding(() => { /* setup finished — settings persisted */ });
      return;
    }
    brokerStatus.className = 'set-status wait';
    brokerStatus.textContent = 'Testing Tradovate connection...';
    try {
      await tradovateLogin(settings.tradovate);
      await syncTradovateProfile();
      brokerStatus.className = 'set-status ok';
      brokerStatus.textContent = 'Connected — live futures data and orders enabled';
    } catch (err) {
      brokerStatus.className = 'set-status err';
      brokerStatus.textContent = err instanceof Error ? err.message : 'Connection failed';
    }
  });

  const paperSizeSel = document.createElement('select');
  ([25000, 50000, 100000, 200000, 300000] as const).forEach(v => {
    const o = document.createElement('option'); o.value = String(v); o.textContent = `$${(v/1000).toFixed(0)}k`; paperSizeSel.appendChild(o);
  });
  paperSizeSel.value = String(settings.paperSize || 100000);
  paperSizeSel.addEventListener('change', () => {
    settings.paperSize = parseInt(paperSizeSel.value, 10) as any;
    saveBrokerSettings(settings);
    try { localStorage.removeItem('dafe_mobile_broker'); } catch {}
  });
  const resetPaperBtn = document.createElement('button');
  resetPaperBtn.className = 'editor-run';
  resetPaperBtn.textContent = 'RESET PAPER ACCOUNT';
  resetPaperBtn.addEventListener('click', () => {
    if (!confirm('Reset paper account to selected size? Clears P&L and trade history.')) return;
    settings.paperSize = parseInt(paperSizeSel.value, 10) as any;
    saveBrokerSettings(settings);
    resetPaperBroker();
    location.reload();
  });

  scroll.appendChild(card('Trading & Risk', [
    row('Account size', paperSizeSel),
    ...riskRows,
    brokerStatus,
    reconnectBtn,
    resetPaperBtn,
  ]));

  // ── Display ────────────────────────────────────────────────────
  const perfSel = document.createElement('select');
  (['low', 'medium', 'high', 'ultra'] as const).forEach((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p[0].toUpperCase() + p.slice(1);
    perfSel.appendChild(o);
  });
  perfSel.value = state.perf;
  perfSel.addEventListener('change', () => {
    state.perf = perfSel.value as typeof state.perf;
    setPerfMode(state.perf);
    persistSettings();
  });

  const barSel = document.createElement('select');
  BAR_TYPES.forEach((b) => {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.label;
    barSel.appendChild(o);
  });
  barSel.value = state.barType;
  barSel.addEventListener('change', () => {
    state.barType = barSel.value as typeof state.barType;
    persistSettings();
  });

  // One-Click Trading — on = OST buttons execute instantly with no confirm
  // dialog; off = every order passes through the confirmation sheet.
  const octSel = document.createElement('select');
  ([['off', 'Off — confirm every order'], ['on', 'On — instant, no confirmation']] as const).forEach(([v, l]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = l; octSel.appendChild(o);
  });
  octSel.value = loadBrokerSettings().oneClick ? 'on' : 'off';
  octSel.addEventListener('change', () => {
    const s = loadBrokerSettings();
    s.oneClick = octSel.value === 'on';
    saveBrokerSettings(s);
    try { (window as any).__dafeSyncOneClick?.(s.oneClick); } catch {}
  });

  scroll.appendChild(card('Display', [
    row('Performance', perfSel),
    row('Default bar type', barSel),
    row('One-Click Trading', octSel),
  ]));

  // ── Performance Tricks ───────────────────────────────────────────
  const matrix = { ...DEFAULT_MATRIX };
  const trickNodes: Array<{ id: TrickId; toggle: HTMLButtonElement; enabled: boolean }> = [];
  for (const id of Object.keys(matrix) as TrickId[]) {
    const enabled = matrix[id].enabled;
    const toggle = document.createElement('button');
    toggle.className = 'toggle' + (enabled ? ' on' : '');
    toggle.textContent = id[0].toUpperCase() + id.slice(1);
    toggle.addEventListener('click', () => {
      matrix[id].enabled = !matrix[id].enabled;
      toggle.classList.toggle('on', matrix[id].enabled);
      persistSettings();
    });
    const label = document.createElement('span');
    label.textContent = ' ' + id;
    ;(toggle as any).insertBefore(label, (toggle as any).firstChild);
    trickNodes.push({ id: id as TrickId, toggle: toggle as any, enabled });
  }

  const renderTrickToggles = (): void => {
    trickNodes.forEach(({ id, toggle }) => {
      ;(toggle as any).classList.toggle('on', matrix[id].enabled);
    });
  };

  const runMatrixBtn = document.createElement('button');
  runMatrixBtn.className = 'editor-run';
  runMatrixBtn.textContent = 'RUN A/B MATRIX (ES=F 1m 500b)';
  runMatrixBtn.addEventListener('click', () => {
    const results = runMatrix(matrix);
    const table = document.createElement('table');
    table.className = 'matrix-results';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.marginTop = '8px';
    table.style.fontSize = '9px';
    table.style.fontFamily = 'monospace';
    table.style.color = 'var(--text)';
    const header = table.createTHead()!.insertRow();
    ['Trick', 'Req W/O', 'Δ', 'Hit W/O', 'Δ', 'Err W/O', 'Δ'].forEach((th) => {
      const h = document.createElement('th');
      h.style.border = '1px solid var(--border)'; h.style.padding = '3px'; h.style.textAlign = 'center'; h.style.color = 'var(--accent)'; h.textContent = th;
      header.appendChild(h);
    });
    const signColor = (v: number): string => (v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text-dim)');
    for (const [id, r] of Object.entries(results)) {
      const tr = table.insertRow();
      const tdId = tr.insertCell(); tdId.style.border = '1px solid var(--border)'; tdId.style.padding = '3px'; tdId.style.textAlign = 'left'; tdId.textContent = id;
      const tdWReq = tr.insertCell(); tdWReq.style.border = '1px solid var(--border)'; tdWReq.style.padding = '3px'; tdWReq.style.textAlign = 'center'; tdWReq.textContent = String(r.with.requests);
      const dReq = r.with.requests - r.without.requests;
      const tdDReq = tr.insertCell(); tdDReq.style.border = '1px solid var(--border)'; tdDReq.style.padding = '3px'; tdDReq.style.textAlign = 'center'; tdDReq.style.color = signColor(dReq); tdDReq.textContent = (dReq >= 0 ? '+' : '') + Number(dReq).toFixed(1);
      const tdWhit = tr.insertCell(); tdWhit.style.border = '1px solid var(--border)'; tdWhit.style.padding = '3px'; tdWhit.style.textAlign = 'center'; tdWhit.textContent = (r.with.hitRatio * 100).toFixed(0) + '%';
      const dHit = r.with.hitRatio - r.without.hitRatio;
      const tdDHit = tr.insertCell(); tdDHit.style.border = '1px solid var(--border)'; tdDHit.style.padding = '3px'; tdDHit.style.textAlign = 'center'; tdDHit.style.color = signColor(dHit); tdDHit.textContent = (dHit >= 0 ? '+' : '') + String((dHit * 100).toFixed(0)) + '%';
      const tdWErr = tr.insertCell(); tdWErr.style.border = '1px solid var(--border)'; tdWErr.style.padding = '3px'; tdWErr.style.textAlign = 'center'; tdWErr.textContent = Number(r.with.syntheticErrorPct).toFixed(2);
      const dErr = r.with.syntheticErrorPct - r.without.syntheticErrorPct;
      const tdDErr = tr.insertCell(); tdDErr.style.border = '1px solid var(--border)'; tdDErr.style.padding = '3px'; tdDErr.style.textAlign = 'center'; tdDErr.style.color = signColor(-dErr); tdDErr.textContent = (dErr >= 0 ? '+' : '') + Number(dErr).toFixed(2);
    }

    const existing = matrixHost.querySelector('.matrix-results');
    if (existing) existing.remove();
    const existingEmail = matrixHost.querySelector('.matrix-email');
    if (existingEmail) existingEmail.remove();
    matrixHost.appendChild(table);
    matrixHost.appendChild(document.createElement('br'));

    const emailBtn = document.createElement('button');
    emailBtn.className = 'editor-run matrix-email matrix-email-slim';
    emailBtn.textContent = 'EMAIL / SHARE REPORT';
    emailBtn.addEventListener('click', () => {
      const t = table.cloneNode(true) as HTMLTableElement;
      const text = extractTableText(t);
      // Rich rows with computed verdicts — drives both the cards and chart.
      const rows: { id: string; reqW: number; reqO: number; hitW: number; hitO: number; errW: number; errO: number }[] = [];
      for (const [id, r] of Object.entries(results)) {
        rows.push({ id, reqW: r.with.requests, reqO: r.without.requests, hitW: r.with.hitRatio * 100, hitO: r.without.hitRatio * 100, errW: r.with.syntheticErrorPct, errO: r.without.syntheticErrorPct });
      }
      const bodyHtml = Array.from(table.querySelectorAll('tr')).map((tr) => {
        const cells = Array.from(tr.querySelectorAll('th,td')).map((td) => `<td>${(td.textContent || '').trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');

      // Per-trick verdict cards with signed-delta chips.
      const cards = rows.map(r => {
        const dReq = r.reqW - r.reqO, dHit = r.hitW - r.hitO, dErr = r.errW - r.errO;
        const saves = dReq < 0 || dHit > 0;
        const chip = (v: number, unit: string, good: boolean) =>
          `<span class="chip ${v === 0 ? 'zero' : good ? 'good' : 'bad'}">${v > 0 ? '+' : ''}${v.toFixed(1)}${unit}</span>`;
        return `<div class="card ${saves ? 'win' : 'loss'}">
  <div class="card-name">${r.id}</div>
  <div class="verdict">${saves ? '✓ IMPROVES' : '✗ REGRESSES'}</div>
  <div class="chips">${chip(dReq, ' req', dReq <= 0)}${chip(dHit, '% hit', dHit >= 0)}${chip(-dErr, '% err', dErr <= 0)}</div>
  <div class="nums">req ${r.reqW} vs ${r.reqO} · hit ${r.hitW.toFixed(0)}% vs ${r.hitO.toFixed(0)}% · err ${r.errW.toFixed(2)}% vs ${r.errO.toFixed(2)}%</div>
</div>`;
      }).join('');

      // Horizontal bar chart of request savings (negative = saves requests).
      const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.reqW - r.reqO)));
      const bars = rows.map(r => {
        const d = r.reqW - r.reqO;
        const w = Math.abs(d) / maxAbs * 45;
        const left = d < 0 ? 50 - w : 50;
        return `<div class="bar-row"><span class="bar-label">${r.id}</span><div class="bar-track"><div class="bar-fill ${d <= 0 ? 'good' : 'bad'}" style="left:${left}%;width:${w}%"></div></div><span class="bar-val">${d > 0 ? '+' : ''}${d.toFixed(1)}</span></div>`;
      }).join('');

      const winners = rows.filter(r => (r.reqW - r.reqO) < 0 || (r.hitW - r.hitO) > 0);
      const losers = rows.filter(r => (r.reqW - r.reqO) > 0 && (r.hitW - r.hitO) <= 0);

      const html =
`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DAFE Charts — Performance Tricks A/B Report</title><style>
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a18;color:#e8e8ff;margin:0;padding:0}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 40px}
.hero{background:linear-gradient(135deg,#17123a 0%,#0d0a24 100%);border:1px solid rgba(180,140,255,.35);border-radius:16px;padding:22px;margin-bottom:22px}
.hero h1{color:#fff;font-size:19px;margin:0 0 6px;letter-spacing:.5px}
.hero .sub{color:#b48cff;font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
.hero .meta{color:#9a9ab8;font-size:10px;margin-top:8px}
h2{color:#00ff88;font-size:13px;margin:26px 0 10px;letter-spacing:1px;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:10px}
.card{background:#10101f;border:1px solid #1c1c3a;border-radius:12px;padding:12px}
.card.win{border-color:rgba(0,255,136,.4)}
.card.loss{border-color:rgba(255,68,119,.35)}
.card-name{font-weight:800;font-size:12px;color:#fff}
.verdict{font-size:9px;font-weight:800;letter-spacing:1px;margin:4px 0}
.win .verdict{color:#00ff88}.loss .verdict{color:#ff4477}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin:6px 0}
.chip{font-size:9px;font-weight:700;padding:2px 7px;border-radius:8px}
.chip.good{background:rgba(0,255,136,.12);color:#00ff88}
.chip.bad{background:rgba(255,68,119,.12);color:#ff4477}
.chip.zero{background:rgba(255,255,255,.06);color:#9a9ab8}
.nums{color:#9a9ab8;font-size:9px}
.bar-row{display:flex;align-items:center;gap:8px;margin:5px 0}
.bar-label{width:130px;text-align:right;font-size:9px;color:#c9c9e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;height:10px;background:#0c0c1e;border-radius:5px;position:relative;overflow:hidden}
.bar-fill{position:absolute;top:0;height:100%;border-radius:5px}
.bar-fill.good{background:linear-gradient(90deg,#0d5c3f,#00ff88)}
.bar-fill.bad{background:linear-gradient(90deg,#7a1f3d,#ff4477)}
.bar-val{width:46px;font-size:9px;color:#9a9ab8;font-weight:700}
.findings li{color:#c9c9e8;font-size:11px;line-height:1.7;margin-bottom:4px}
.findings b{color:#00ff88}
table{border-collapse:collapse;width:100%;font-size:10px;margin-top:10px}
th,td{border:1px solid #1c1c3a;padding:5px 7px;text-align:center}
th{color:#9a9ab8;text-transform:uppercase;font-size:8px;background:#0c0c1e}
tr:nth-child(even) td{background:#0a0a18}
.foot{color:#6a6a8a;font-size:9px;margin-top:28px;border-top:1px solid #1c1c3a;padding-top:12px}
</style></head><body><div class="wrap">
<div class="hero"><h1>⚡ DAFE Charts — Performance Tricks A/B Report</h1><div class="sub">14 isolated engine optimizations · independently measured</div><div class="meta">Benchmark: ES=F · 1m · 500-bar window · in-vitro deterministic harness · generated ${new Date().toLocaleString()}</div></div>
<h2>Verdicts</h2><div class="grid">${cards}</div>
<h2>Request Budget Impact</h2>${bars}
<h2>Findings</h2><ul class="findings">
<li><b>${winners.length} of ${rows.length} tricks measurably improve</b> request budgets or cache hit-ratios with this workload.</li>
<li>Top request saver: <b>${[...rows].sort((a,b)=>(a.reqW-a.reqO)-(b.reqW-b.reqO))[0].id}</b> (${([...rows].sort((a,b)=>(a.reqW-a.reqO)-(b.reqW-b.reqO))[0].reqW - [...rows].sort((a,b)=>(a.reqW-a.reqO)-(b.reqW-b.reqO))[0].reqO).toFixed(0)} req).</li>
<li>Top hit-ratio gain: <b>${[...rows].sort((a,b)=>(b.hitW-b.hitO)-(a.hitW-a.hitO))[0].id}</b> (+${([...rows].sort((a,b)=>(b.hitW-b.hitO)-(a.hitW-a.hitO))[0].hitW - [...rows].sort((a,b)=>(b.hitW-b.hitO)-(a.hitW-a.hitO))[0].hitO).toFixed(0)}%).</li>
${losers.length ? `<li>${losers.length} trick(s) showed no benefit under this workload — ${losers.map(l=>l.id).join(', ')} — safe to leave off for this symbol/timeframe.</li>` : '<li>No regressions detected — every active trick is neutral-or-better.</li>'}
</ul>
<h2>Full A/B Matrix</h2><table><tr><th>Trick</th><th>Req W/O</th><th>Δ Req</th><th>Hit W/O</th><th>Δ Hit</th><th>Err W/O</th><th>Δ Err</th></tr>${bodyHtml}</table>
<div class="foot">DAFE Charts · self-contained report — no network required · deterministic benchmark, reproducible run-for-run.</div>
</div></body></html>`;
      submitReport({
        subject: 'DAFE Charts Performance Tricks A/B Report',
        filename: `dafe-tricks-${new Date().toISOString().slice(0, 10)}.html`,
        html,
        text,
        onDone: (m) => {
          const t = document.createElement('div'); t.className = 'toast ok'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
        },
      });
    });
    matrixHost.appendChild(emailBtn);

    function extractTableText(tbl: HTMLTableElement): string {
      const lines: string[] = ['DAFE Charts — Performance Tricks A/B (ES=F 1m, 500 bars)'];
      for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
        const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent || '').trim());
        if (cells.length) lines.push(cells.join('\t'));
      }
      return lines.join('\n');
    }
  });

  const trickCard = card('Performance Tricks', []);
  trickCard.appendChild(document.createElement('div'));
  trickNodes.forEach(({ id, toggle }) => {
    const rowEl = row(id, toggle);
    trickCard.firstElementChild?.appendChild(rowEl);
  });
  trickCard.appendChild(runMatrixBtn);

  const matrixHost = document.createElement('div');
  matrixHost.style.marginTop = '8px';

  scroll.appendChild(trickCard);
  scroll.appendChild(matrixHost);

  // ── About / reset ──────────────────────────────────────────────
  const resetBtn = document.createElement('button');
  resetBtn.className = 'set-danger';
  resetBtn.textContent = 'RESET ALL DATA';
  resetBtn.addEventListener('click', () => {
    if (window.confirm('Reset all saved data (symbol, scripts, paper account)?')) resetAll();
  });
  scroll.appendChild(card('Data', [resetBtn]));
  const version = document.createElement('div');
  version.className = 'version-line';
  version.textContent = 'DAFE Charts Mobile v0.4.0 — standalone PWA';
  scroll.appendChild(version);

  container.appendChild(scroll);

  return {
    dispose: () => container.replaceChildren(),
  };
}