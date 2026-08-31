import './styles.css';
import { setPerfMode } from '../../web/src/chart-renderer';
import { initSheets, openSheet, sectionTitle, gridButton, searchInput, listRow } from './sheets';
import { createChartScreen, type ChartScreen } from './chartscreen';
import { createTradeScreen } from './tradescreen';
import { createAiScreen } from './aiscreen';
import { createScriptScreen } from './scriptscreen';
import { createSettingsScreen } from './settingscreen';
import { createPerformanceScreen } from './performance';
import { ExecutionEngine, type NewExecOrder, type ExecOrder } from './execution';
import { createChartDom, confirmExec } from './chartdom';
import { showOnboarding } from './onboarding';
import { loadBrokerSettings } from './broker-store';
import { state, persistSettings, loadIndicators, loadBroker, hookFillMarkers, SYMBOLS, TIMEFRAMES, BAR_TYPES, type DataProvider } from './state';

function showToast(msg: string, kind: 'ok' | 'warn' | 'err' = 'ok'): void {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

const TABS = [
  { id: 'chart', icon: '📈', label: 'Chart' },
  { id: 'trade', icon: '💱', label: 'Trade' },
  { id: 'ai', icon: '◆', label: 'Advisor' },
  { id: 'perf', icon: '📊', label: 'Perf' },
  { id: 'scripts', icon: '🧩', label: 'Scripts' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function boot(): void {
  const app = document.getElementById('app')!;
  app.replaceChildren();

  // ── Top bar ────────────────────────────────────────────────────
  const topbar = document.createElement('div');
  topbar.id = 'topbar';

  const symbolBtn = document.createElement('button');
  symbolBtn.className = 'tb-btn';
  symbolBtn.id = 'tb-symbol';
  const symMain = document.createElement('span');
  symMain.className = 'tb-main';
  symMain.textContent = state.symbol;
  const symSub = document.createElement('span');
  symSub.className = 'tb-sub';
  symSub.textContent = 'Symbol';
  symbolBtn.appendChild(symMain);
  symbolBtn.appendChild(symSub);

  const tfBtn = document.createElement('button');
  tfBtn.className = 'tb-btn';
  const tfMain = document.createElement('span');
  tfMain.className = 'tb-main';
  tfMain.textContent = state.timeframe;
  const tfSub = document.createElement('span');
  tfSub.className = 'tb-sub';
  tfSub.textContent = 'Timeframe';
  tfBtn.appendChild(tfMain);
  tfBtn.appendChild(tfSub);

  const priceBox = document.createElement('div');
  priceBox.id = 'tb-price';
  priceBox.style.cursor = 'pointer';
  const priceEl = document.createElement('span');
  priceEl.className = 'price';
  priceEl.textContent = '--';
  const changeEl = document.createElement('span');
  changeEl.className = 'change';
  changeEl.textContent = '';
  const sourceEl = document.createElement('span');
  sourceEl.style.fontSize = '8px';
  sourceEl.style.letterSpacing = '0.5px';
  sourceEl.style.fontWeight = '700';
  sourceEl.textContent = '';
  priceBox.appendChild(priceEl);
  priceBox.appendChild(changeEl);
  priceBox.appendChild(sourceEl);
  // Tap the price for full data provenance — symbol, price, date/time of the
  // newest bar, and which feed actually produced it. Makes any stale/fake
  // data instantly visible instead of silently misleading.
  priceBox.addEventListener('click', () => {
    const b = state.bars[state.bars.length - 1];
    const when = b ? new Date(b.timestamp) : null;
    const badge = PROVIDER_BADGE[state.dataProvider];
    const msg = when
      ? `${state.symbol} · $${b.close.toFixed(2)}\n\nLast bar: ${when.toLocaleDateString()} ${when.toLocaleTimeString()}\nBar open: $${b.open.toFixed(2)} · high $${b.high.toFixed(2)} · low $${b.low.toFixed(2)}\n\nFeed: ${badge.label} (${state.dataProvider})\nSynthetic bars timestamped to the current wall clock; real feeds carry the exchange's bar time.`
      : 'No bars loaded yet';
    const t = document.createElement('div');
    t.className = 'toast ' + (state.dataProvider === 'synthetic' ? 'warn' : 'ok');
    t.style.whiteSpace = 'pre-line';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  });

  const PROVIDER_BADGE: Record<DataProvider, { label: string; color: string; title: string }> = {
    backend: { label: '● LIVE', color: 'var(--green)', title: 'Connected feed — live data' },
    massive: { label: '● MASSIVE', color: 'var(--green)', title: 'Massive feed — real tick-derived bars' },
    yahoo: { label: '◌ YAHOO', color: 'rgba(255,184,0,0.9)', title: 'Yahoo Finance fallback data — connect a feed for live' },
    cache: { label: '◌ CACHE', color: 'rgba(255,255,255,0.45)', title: 'Cached data (offline) — last known prices' },
    synthetic: { label: '◌ DEMO', color: 'rgba(255,255,255,0.25)', title: 'Demo data — no feed connected' },
  };

  function setSourceBadge(p: DataProvider): void {
    const b = PROVIDER_BADGE[p];
    sourceEl.textContent = b.label;
    sourceEl.style.color = b.color;
    priceBox.title = `${state.symbol} · ${b.title}`;
  }

  // Live tick simulation button REMOVED by design: the random-walk "live"
  // feed corrupted real data (weekend price swings on closed markets, price
  // divergence vs real venues, stale price across symbol switches). Real
  // feeds refresh themselves; the chart never needs a manual play/pause.

  topbar.appendChild(symbolBtn);
  topbar.appendChild(tfBtn);
  topbar.appendChild(priceBox);

  // ── Screens ────────────────────────────────────────────────────
  const screens: Record<TabId, HTMLDivElement> = Object.fromEntries(
    TABS.map((t) => [t.id, (() => {
      const el = document.createElement('div');
      el.className = 'screen';
      el.id = 'screen-' + t.id;
      return el;
    })()])
  ) as Record<TabId, HTMLDivElement>;

  const chartContainer = screens.chart;
  // Inner flex container for chart layout — keeps .screen active toggling intact
  const chartInner = document.createElement('div');
  chartInner.style.flex='1'; chartInner.style.display='flex'; chartInner.style.flexDirection='column'; chartInner.style.minHeight='0'; chartInner.style.overflow='hidden';
  chartContainer.appendChild(chartInner);
  // Dominance control
  let paneDominance: 'both'|'main'|'lower' = (localStorage.getItem('dafe_mobile_pane_dom') as any) || 'both';
  let lowerPct = parseInt(localStorage.getItem('dafe_mobile_lower_pct')||'45',10);
  const domBar = document.createElement('div'); domBar.style.display='flex'; domBar.style.gap='6px'; domBar.style.padding='4px 8px'; domBar.style.alignItems='center'; domBar.style.background='rgba(10,10,20,0.85)'; domBar.style.borderBottom='1px solid rgba(180,140,255,0.12)'; domBar.style.flexShrink='0';
  const domSel = document.createElement('select'); domSel.style.flex='1'; domSel.style.fontSize='11px'; domSel.style.padding='4px 6px'; domSel.style.border='1px solid rgba(180,140,255,0.15)'; domSel.style.borderRadius='6px'; domSel.style.background='rgba(12,12,28,0.95)'; domSel.style.color='rgba(255,255,255,0.75)'; domSel.style.outline='none';
  for(const [v,l] of [['both','Both (Main over Lower)'],['main','Main Only'],['lower','Lower Only']] as const){ const o=document.createElement('option'); o.value=v; o.textContent=l; o.style.background='rgba(12,12,28,0.95)'; o.style.color='rgba(255,255,255,0.85)'; if(v===paneDominance) o.selected=true; domSel.appendChild(o); }

  // ── Indicator manager dropdown (replaces the old pct label) ──
  // Shows EVERY active indicator — library toggles, saved signals AND the
  // unsaved test script — each with a × remove button. This is the only
  // way to close out a testing script without saving it.
  const indSel = document.createElement('select'); indSel.style.flex='1.2'; indSel.style.fontSize='11px'; indSel.style.padding='4px 6px'; indSel.style.border='1px solid rgba(180,140,255,0.15)'; indSel.style.borderRadius='6px'; indSel.style.background='rgba(12,12,28,0.95)'; indSel.style.color='rgba(255,255,255,0.75)'; indSel.style.outline='none';
  const indRemoveBtn = document.createElement('button'); indRemoveBtn.textContent='×'; indRemoveBtn.title='Remove selected indicator from chart';
  indRemoveBtn.style.cssText='flex-shrink:0;width:30px;height:28px;border-radius:6px;border:1px solid rgba(255,68,119,.4);background:rgba(255,68,119,.08);color:var(--red);font-size:14px;font-weight:800;cursor:pointer;';
  function refreshIndSel(){
    indSel.replaceChildren();
    const active = state.indicators.filter(i=>i.enabled);
    if (active.length===0){ const o=document.createElement('option'); o.value=''; o.textContent='No indicators on chart'; indSel.appendChild(o); indRemoveBtn.style.display='none'; return; }
    indRemoveBtn.style.display='';
    for (const ind of active){ const o=document.createElement('option'); o.value=ind.id; o.textContent=(ind.id==='custom'?'⚙ Test script: ':'')+ind.name; indSel.appendChild(o); }
  }
  indRemoveBtn.addEventListener('click', ()=>{
    const id=indSel.value; if(!id) return;
    const idx=state.indicators.findIndex(i=>i.id===id); if(idx>=0) state.indicators.splice(idx,1);
    persistSettings(); refreshIndSel();
    try{ (window as any).__dafeChartRefresh?.(); }catch{}
  });
  // Live sync: indicators are added from the Scripts tab (runIndicator) and
  // by library toggles on other screens — this screen had no re-render hook,
  // so the dropdown stayed stuck at its boot-time contents forever.
  (window as any).__dafeRefreshIndSel = refreshIndSel;
  setInterval(refreshIndSel, 1500);
  refreshIndSel();

  domBar.appendChild(domSel); domBar.appendChild(indSel); domBar.appendChild(indRemoveBtn);
  chartInner.appendChild(domBar);

  const mainWrap = document.createElement('div'); mainWrap.style.flex='1'; mainWrap.style.position='relative'; mainWrap.style.minHeight='80px'; mainWrap.style.overflow='hidden';
  const splitter = document.createElement('div'); splitter.style.height='10px'; splitter.style.background='rgba(180,140,255,0.18)'; splitter.style.cursor='row-resize'; splitter.style.display='flex'; splitter.style.alignItems='center'; splitter.style.justifyContent='center'; splitter.style.color='rgba(255,255,255,0.5)'; splitter.style.fontSize='12px'; splitter.style.letterSpacing='3px'; splitter.style.flexShrink='0'; splitter.textContent='═';
  const lowerWrap = document.createElement('div'); lowerWrap.style.height=`${lowerPct}%`; lowerWrap.style.minHeight='60px'; lowerWrap.style.borderTop='1px solid rgba(180,140,255,0.18)'; lowerWrap.style.display='flex'; lowerWrap.style.flexDirection='column'; lowerWrap.style.flexShrink='0'; lowerWrap.style.background='rgba(8,8,20,0.5)'; lowerWrap.style.overflow='hidden';
  const lowerCanvas = document.createElement('canvas'); lowerCanvas.id='mobile-lower-canvas'; lowerCanvas.style.flex='1'; lowerCanvas.style.width='100%'; lowerCanvas.style.display='block';
  const lowerLabel = document.createElement('div'); lowerLabel.style.fontSize='9px'; lowerLabel.style.color='rgba(255,255,255,0.35)'; lowerLabel.style.textAlign='center'; lowerLabel.style.padding='2px'; lowerLabel.textContent='Lower Manifold — manifold/ridgeline when active';
  lowerWrap.appendChild(lowerCanvas); lowerWrap.appendChild(lowerLabel);
  chartInner.appendChild(mainWrap);
  chartInner.appendChild(splitter);
  chartInner.appendChild(lowerWrap);

  function applyPaneDom(){
    // Authoritative on EVERY call — inline height AND flex are both reset so
    // no stale expanded state survives a mode switch (the old 'lower' mode
    // left flex='1' overriding the % height on return to 'both').
    lowerWrap.style.flex='';
    lowerWrap.style.height='';
    mainWrap.style.flex='';
    mainWrap.style.height='';
    if(paneDominance==='main'){ mainWrap.style.display='flex'; mainWrap.style.flexDirection='column'; mainWrap.style.flex='1'; splitter.style.display='none'; lowerWrap.style.display='none'; }
    else if(paneDominance==='lower'){ mainWrap.style.display='none'; splitter.style.display='none'; lowerWrap.style.display='flex'; lowerWrap.style.flex='1'; }
    else {
      if(lowerPct>80 || lowerPct<20){ lowerPct=45; try{localStorage.setItem('dafe_mobile_lower_pct', String(lowerPct));}catch{} }
      mainWrap.style.display='flex'; mainWrap.style.flexDirection='column'; mainWrap.style.flex='1'; splitter.style.display='flex'; lowerWrap.style.display='flex'; lowerWrap.style.height=`${lowerPct}%`;
    }
    // Keep the GL lower pane's camera/renderer matched to the NEW container
    // height — otherwise expanding shows fixed-height GL content floating in
    // black unused space.
    try {
      const glPane = document.getElementById('three-lower-scene') as HTMLCanvasElement | null;
      if (glPane && lowerWrap.style.display !== 'none') {
        const h = Math.max(60, lowerWrap.clientHeight - lowerLabel.clientHeight);
        (window as any).__dafeLowerHeight = h;
        glPane.style.height = `${h}px`;
      }
    } catch {}
  }
  domSel.addEventListener('change', ()=>{
    paneDominance=domSel.value as any;
    try{localStorage.setItem('dafe_mobile_pane_dom',paneDominance);}catch{}
    applyPaneDom();
  });
  // Robust slider: track start positions, compute from container, not incremental delta
  let startY=0, startLowerPct=45, dragging=false;
  function startDrag(y:number){
    if(paneDominance!=='both') return;
    dragging=true; startY=y; startLowerPct=lowerPct;
    splitter.style.background='rgba(180,140,255,0.35)';
  }
  function moveDrag(y:number){
    if(!dragging || paneDominance!=='both') return;
    const total=chartInner.clientHeight - domBar.clientHeight - splitter.clientHeight;
    const dy=y - startY; // positive = dragging down
    let newPct = startLowerPct - (dy/total*100);
    newPct=Math.max(15, Math.min(85, Math.round(newPct)));
    lowerPct=newPct;
    lowerWrap.style.height=`${lowerPct}%`;
    try{localStorage.setItem('dafe_mobile_lower_pct', String(lowerPct));}catch{}
  }
  function endDrag(){ dragging=false; splitter.style.background='rgba(180,140,255,0.18)'; applyPaneDom(); }
  splitter.addEventListener('touchstart', (e)=>{ startDrag(e.touches[0].clientY); e.preventDefault(); }, {passive:false});
  splitter.addEventListener('touchmove', (e)=>{ moveDrag(e.touches[0].clientY); e.preventDefault(); }, {passive:false});
  splitter.addEventListener('touchend', endDrag);
  splitter.addEventListener('touchcancel', endDrag);
  splitter.addEventListener('mousedown', (e)=>{ startDrag(e.clientY); const onMove=(ev:MouseEvent)=> moveDrag(ev.clientY); const onUp=()=>{ endDrag(); document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); }; document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp); e.preventDefault(); });
  applyPaneDom();

  const chartFabLayer = document.createElement('div');
  chartFabLayer.className = 'chart-fabs';
  mainWrap.appendChild(chartFabLayer);

  let chart: ChartScreen;

  // ── Tab bar ────────────────────────────────────────────────────
  const tabbar = document.createElement('div');
  tabbar.id = 'tabbar';
  const tabBtns: Record<TabId, HTMLButtonElement> = {} as Record<TabId, HTMLButtonElement>;
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.tab = t.id;
    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.textContent = t.icon;
    const label = document.createElement('span');
    label.textContent = t.label;
    b.appendChild(icon);
    b.appendChild(label);
    b.addEventListener('click', () => switchTab(t.id));
    tabBtns[t.id] = b;
    tabbar.appendChild(b);
  }

  app.appendChild(topbar);
  TABS.forEach((t) => app.appendChild(screens[t.id]));
  app.appendChild(tabbar);

  // ── Chart fabs — ALL live inside the Hot-Action menu now ──────────
  // The standalone floating circles (VP / ◫ / 3D / ⟲) duplicated menu items
  // and cluttered the right edge; they are fully replaced by the collapsible
  // stack under ☰ (below). The toggles keep their own click logic.
  const vpFab = document.createElement('button');
  vpFab.style.display = 'none';
  vpFab.addEventListener('click', () => {
    const on = !state.vpEnabled;
    state.vpEnabled = on;
    chart.setVpEnabled(on);
    syncHotToggles();
    persistSettings();
  });
  const barTypeFab = document.createElement('button');
  barTypeFab.style.display = 'none';
  barTypeFab.addEventListener('click', () => openBarTypeSheet());
  const d3Fab = document.createElement('button');
  d3Fab.style.display = 'none';
  d3Fab.addEventListener('click', () => {
    const on = !state.is3D;
    state.is3D = on;
    chart.set3D(on);
    syncHotToggles();
  });
  const ostFab = document.createElement('button');
  ostFab.style.display = 'none';
  ostFab.addEventListener('click', () => {
    // Reset ONLY viewing state — never indicators, orders, or positions.
    chart.resetView();
    paneDominance = 'both';
    lowerPct = 45;
    try { localStorage.setItem('dafe_mobile_pane_dom', 'both'); localStorage.setItem('dafe_mobile_lower_pct', '45'); } catch {}
    applyPaneDom();
    const t = document.createElement('div'); t.className = 'toast ok'; t.textContent = 'Chart reset — view restored';
    document.body.appendChild(t); setTimeout(() => t.remove(), 2500);
    navigator.vibrate?.(10);
  });
  chartFabLayer.appendChild(vpFab);
  chartFabLayer.appendChild(barTypeFab);
  chartFabLayer.appendChild(d3Fab);
  chartFabLayer.appendChild(ostFab);

  // ── Hot-Action menu (bottom-right, above the settings tab) ──
  // ONE collapsed ☰ button. Every former floating fab (Params / Reset /
  // Bars / VP / 3D) lives inside the stack and COLLAPSES with the menu.
  const hotMenu = document.createElement('div');
  hotMenu.id = 'hot-action-menu';
  const hotBtn = document.createElement('button');
  hotBtn.id = 'hot-action-btn';
  hotBtn.textContent = '☰';
  hotBtn.title = 'Chart actions';
  const hotStack = document.createElement('div');
  hotStack.id = 'hot-action-stack';
  function makeHotAction(label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'hot-action-item';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  const hotParams = makeHotAction('⚙ Params', 'Adjust indicator parameters', () => openIndicatorParamsSheet());
  const hotReset = makeHotAction('⟲ Reset', 'Reset chart view', () => ostFab.click());
  const hotBarType = makeHotAction('◫ Bars', 'Bar type', () => openBarTypeSheet());
  const hotVP = makeHotAction('VP', 'Volume profile', () => vpFab.click());
  const hot3D = makeHotAction('3D', 'Toggle 3D mode', () => d3Fab.click());
  hotStack.appendChild(hotParams);
  hotStack.appendChild(hotReset);
  hotStack.appendChild(hotBarType);
  hotStack.appendChild(hotVP);
  hotStack.appendChild(hot3D);
  let hotOpen = false;
  // Active-state sync: VP and 3D items show a live on/off chip.
  function syncHotToggles(): void {
    hotVP.classList.toggle('active', state.vpEnabled);
    hotVP.textContent = state.vpEnabled ? 'VP ✓' : 'VP';
    hot3D.classList.toggle('active', state.is3D);
    hot3D.textContent = state.is3D ? '3D ✓' : '3D';
  }
  function syncHotMenu(): void {
    hotMenu.classList.toggle('open', hotOpen);
    hotStack.style.display = hotOpen ? 'flex' : 'none';
    hotBtn.textContent = hotOpen ? '✕' : '☰';
    if (hotOpen) syncHotToggles();
  }
  hotBtn.addEventListener('click', (e) => { e.stopPropagation(); hotOpen = !hotOpen; syncHotMenu(); });
  // Tap anywhere outside collapses the stack.
  document.addEventListener('click', (e) => {
    if (hotOpen && !hotMenu.contains(e.target as Node)) { hotOpen = false; syncHotMenu(); }
  });
  hotMenu.appendChild(hotStack);
  hotMenu.appendChild(hotBtn);
  mainWrap.appendChild(hotMenu);
  syncHotToggles();
  // Params visibility follows active indicators, same as the old lone fab.
  function syncIndParamsFab() {
    const hasEnabled = state.indicators.some(i => i.enabled);
    hotParams.style.display = hasEnabled ? '' : 'none';
    hotParams.disabled = !hasEnabled;
  }
  setInterval(syncIndParamsFab, 1500);
  setTimeout(syncIndParamsFab, 600);

  function parseInputs(source: string): { title: string; def: string; kind: 'bool'|'num'|'str'; min?: number; max?: number; step?: number }[] {
    const out: any[] = [];
    const re = /input\s*\(\s*([^,]+?)\s*,\s*"([^"]+)"(?:\s*,\s*([^,\)]+)\s*,\s*([^,\)]+)\s*,\s*([^,\)]+))?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const defRaw = m[1].trim();
      const title = m[2];
      const minRaw = m[3]?.trim();
      const maxRaw = m[4]?.trim();
      const stepRaw = m[5]?.trim();
      let kind: 'bool'|'num'|'str' = 'num';
      if (/^(true|false)$/i.test(defRaw)) kind = 'bool';
      else if (/^["']/.test(defRaw)) kind = 'str';
      const entry: any = { title, def: defRaw, kind };
      if (minRaw !== undefined && maxRaw !== undefined) {
        const mn = parseFloat(minRaw), mx = parseFloat(maxRaw), st = parseFloat(stepRaw || '1');
        if (!isNaN(mn) && !isNaN(mx)) { entry.min = mn; entry.max = mx; entry.step = isNaN(st) ? 1 : st; }
      }
      out.push(entry);
    }
    return out;
  }

  function openIndicatorParamsSheet(): void {
    const enabled = state.indicators.filter(i => i.enabled);
    if (enabled.length === 0) { showToast('No indicators active — enable one in Scripts', 'warn'); return; }
    const overlay=document.createElement('div'); overlay.className='indicator-params-overlay';
    const sheet=document.createElement('div'); sheet.className='indicator-params-sheet';
    const head=document.createElement('div'); head.className='indicator-params-head';
    head.innerHTML='<b style="color:var(--accent)">Indicator Parameters</b>';
    const closeBtn=document.createElement('button'); closeBtn.textContent='✕'; closeBtn.style.cssText='background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;padding:4px 8px;';
    closeBtn.addEventListener('click', ()=>overlay.remove());
    head.appendChild(closeBtn); sheet.appendChild(head);
    const body=document.createElement('div'); body.className='indicator-params-body';
    for (const ind of enabled) {
      const sec=document.createElement('div'); sec.className='indicator-params-section';
      const t=document.createElement('div'); t.className='indicator-params-section-title'; t.textContent=ind.name; sec.appendChild(t);
      const inputs = parseInputs(ind.source);
      if (inputs.length === 0) {
        const empty=document.createElement('div'); empty.textContent='No adjustable inputs (fixed parameters)'; empty.style.cssText='font-size:11px;color:var(--text-faint);padding:6px 0;'; sec.appendChild(empty);
      } else {
        for (const inp of inputs) {
          const row=document.createElement('div'); row.className='indicator-param-row';
          const lab=document.createElement('span'); lab.className='indicator-param-label'; lab.textContent=inp.title; row.appendChild(lab);
          const ctrl=document.createElement('div'); ctrl.className='indicator-param-control'; ctrl.style.cssText='display:flex;gap:6px;align-items:center;flex:1;max-width:58%;justify-content:flex-end;';
          if (inp.kind === 'bool') {
            const isTrue = /^true$/i.test(inp.def);
            const tog=document.createElement('button'); tog.className='toggle'+(isTrue?' on':''); tog.addEventListener('click', ()=>{
              const on = !tog.classList.contains('on'); tog.classList.toggle('on', on);
              const newVal = on ? 'true' : 'false';
              // Patch source: replace that specific input's default
              const escTitle = inp.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
              const pat = new RegExp(`input\\s*\\(\\s*(?:true|false)\\s*,\\s*"${escTitle}"`, 'i');
              ind.source = ind.source.replace(pat, `input(${newVal}, "${inp.title}"`);
              try { chart.refreshIndicators(); } catch {}
              persistSettings();
            });
            ctrl.appendChild(tog);
          } else if (inp.kind === 'num') {
            const defNum = parseFloat(inp.def);
            const mn = inp.min ?? (defNum > 100 ? 1 : defNum < 1 ? 0.1 : 1);
            const mx = inp.max ?? (defNum > 100 ? 500 : defNum > 20 ? 100 : 50);
            const step = inp.step ?? (defNum < 1 ? 0.1 : 1);
            const sel=document.createElement('select');
            sel.style.cssText='padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-panel);color:var(--text);font-size:11px;flex:1;';
            // Build 7 adaptive options centered on default
            const vals = new Set<number>();
            vals.add(defNum);
            vals.add(mn); vals.add(mx);
            if (!isNaN(defNum)) {
              vals.add(Math.max(mn, Math.round(defNum*0.5/step)*step));
              vals.add(Math.max(mn, Math.round(defNum*0.75/step)*step));
              vals.add(Math.min(mx, Math.round(defNum*1.25/step)*step));
              vals.add(Math.min(mx, Math.round(defNum*1.5/step)*step));
            }
            const sorted = Array.from(vals).filter(v=>v>=mn && v<=mx).sort((a,b)=>a-b);
            for (const v of sorted) { const o=document.createElement('option'); o.value=String(v); o.textContent=String(v); if (Math.abs(v-defNum)<1e-9) o.selected=true; sel.appendChild(o); }
            // Range slider
            const range=document.createElement('input'); range.type='range'; range.min=String(mn); range.max=String(mx); range.step=String(step); range.value=String(defNum); range.style.cssText='flex:1;';
            const valLab=document.createElement('span'); valLab.textContent=String(defNum); valLab.style.cssText='min-width:36px;text-align:center;font-size:11px;font-weight:700;color:var(--accent);';
            const syncRange = (v: number) => { valLab.textContent=String(v); sel.value=String(v); };
            range.addEventListener('input', ()=> syncRange(parseFloat(range.value)));
            const commit = () => {
              const v = sel.value || range.value;
              const escTitle = inp.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
              const pat = new RegExp(`input\\s*\\(\\s*[^,]+?\\s*,\\s*"${escTitle}"(?:\\s*,\\s*[^,]+\\s*,\\s*[^,]+\\s*,\\s*[^)]+)?\\s*\\)`);
              ind.source = ind.source.replace(pat, (full)=> full.replace(/input\s*\(\s*[^,]+/, `input(${v}`));
              try { chart.refreshIndicators(); } catch {}
              persistSettings();
            };
            range.addEventListener('change', commit);
            sel.addEventListener('change', ()=>{ range.value=sel.value; valLab.textContent=sel.value; commit(); });
            ctrl.appendChild(range); ctrl.appendChild(valLab); ctrl.appendChild(sel);
          } else {
            const inpEl=document.createElement('input'); inpEl.type='text'; inpEl.value=inp.def.replace(/^["']|["']$/g,''); inpEl.style.cssText='flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-panel);color:var(--text);font-size:11px;';
            inpEl.addEventListener('change', ()=>{
              const escTitle = inp.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
              ind.source = ind.source.replace(new RegExp(`input\\s*\\(\\s*["'][^"']*["']\\s*,\\s*"${escTitle}"`), `input("${inpEl.value}", "${inp.title}"`);
              try { chart.refreshIndicators(); } catch {}
              persistSettings();
            });
            ctrl.appendChild(inpEl);
          }
          row.appendChild(ctrl); sec.appendChild(row);
        }
      }
      body.appendChild(sec);
    }
    sheet.appendChild(body);
    const foot=document.createElement('div'); foot.style.cssText='padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;';
    const done=document.createElement('button'); done.className='editor-run'; done.textContent='Done'; done.style.flex='0 0 auto'; done.addEventListener('click', ()=>overlay.remove());
    foot.appendChild(done); sheet.appendChild(foot);
    overlay.appendChild(sheet); overlay.addEventListener('click', (e)=>{ if(e.target===overlay) overlay.remove(); }); document.body.appendChild(overlay);
  }

  // ── Sheets ─────────────────────────────────────────────────────
  function openSymbolSheet(): void {
    openSheet((body, close) => {
      const tabs = document.createElement('div'); tabs.style.cssText='display:flex;gap:6px;padding:6px 0;overflow-x:auto;';
      const SYM_CATS: (typeof SYMBOLS[number]['cat'])[] = ['Futures','Crypto','FX','ETFs','Equities'] as any;
      let activeCat: string = 'Futures';
      const results = document.createElement('div');
      results.className = 'sheet-list';
      const render = (filter: string = '') => {
        results.replaceChildren();
        const q = filter.toUpperCase().trim();
        let list = SYMBOLS.filter(s => s.cat === (activeCat as any));
        if (q) list = SYMBOLS.filter(s => s.symbol.includes(q) || s.name.toUpperCase().includes(q));
        if (q && q.length >= 2 && !list.some(m => m.symbol === q)) list.unshift({ symbol: q, name: 'Custom symbol', cat: activeCat } as any);
        for (const m of list.slice(0, 60)) {
          results.appendChild(listRow(m.symbol, m.name, () => {
            chart.loadSymbol(m.symbol);
            symMain.textContent = m.symbol;
            close();
          }));
        }
        if (list.length === 0) {
          const e=document.createElement('div'); e.textContent='No symbols in this category'; e.style.cssText='padding:16px;text-align:center;color:var(--text-faint);font-size:11px;'; results.appendChild(e);
        }
      };
      for (const cat of SYM_CATS) {
        const b=document.createElement('button'); b.textContent=cat; b.style.cssText='flex-shrink:0;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-raised);color:var(--text-dim);font-size:11px;font-weight:700;';
        if (cat===activeCat) { b.style.color='var(--accent)'; b.style.borderColor='var(--accent)'; b.style.background='rgba(180,140,255,0.1)'; }
        b.addEventListener('click', ()=>{ activeCat=cat; for (const x of Array.from(tabs.children) as HTMLButtonElement[]) { x.style.color='var(--text-dim)'; x.style.borderColor='var(--border)'; x.style.background='var(--bg-raised)'; } b.style.color='var(--accent)'; b.style.borderColor='var(--accent)'; b.style.background='rgba(180,140,255,0.1)'; render((body.querySelector('input') as HTMLInputElement)?.value||''); });
        tabs.appendChild(b);
      }
      const search = searchInput('Search symbol...', (q) => render(q));
      body.appendChild(tabs);
      body.appendChild(search);
      body.appendChild(results);
      render('');
    }, { title: 'Select Symbol', height: '80vh' });
  }

  function openTfSheet(): void {
    openSheet((body, close) => {
      body.appendChild(sectionTitle('Timeframe'));
      const grid = document.createElement('div');
      grid.className = 'sheet-grid';
      for (const tf of TIMEFRAMES) {
        grid.appendChild(gridButton(tf, tf === state.timeframe, () => {
          state.timeframe = tf;
          tfMain.textContent = tf;
          chart.setTimeframe(tf);
          close();
        }));
      }
      body.appendChild(grid);
    }, { title: 'Timeframe' });
  }

  function openBarTypeSheet(): void {
    openSheet((body, close) => {
      body.appendChild(sectionTitle('Bar type'));
      const grid = document.createElement('div');
      grid.className = 'sheet-grid';
      for (const t of BAR_TYPES) {
        grid.appendChild(gridButton(t.label, t.id === state.barType, () => {
          state.barType = t.id;
          barTypeFab.textContent = t.label.slice(0, 2).toUpperCase();
          chart.setBarType(t.id);
          close();
        }));
      }
      body.appendChild(grid);
    }, { title: 'Bar Type' });
  }

  symbolBtn.addEventListener('click', openSymbolSheet);
  tfBtn.addEventListener('click', openTfSheet);

  // ── Tab switching ──────────────────────────────────────────────
  const tabs: Record<TabId, unknown> = { chart: null, trade: null, ai: null, perf: null, scripts: null, settings: null };
  let activeTab: TabId = 'chart';

  function switchTab(id: TabId): void {
    activeTab = id;
    for (const t of TABS) {
      screens[t.id].classList.toggle('active', t.id === id);
      tabBtns[t.id].classList.toggle('active', t.id === id);
    }
    if (id === 'trade' && !tabs.trade) {
      tabs.trade = createTradeScreen(screens.trade, { onFill: () => chart.refreshIndicators() });
    }
    if (id === 'trade') (tabs.trade as { refresh: () => void }).refresh();
    if (id === 'ai' && !tabs.ai) tabs.ai = createAiScreen(screens.ai);
    if (id === 'perf' && !tabs.perf) tabs.perf = createPerformanceScreen(screens.perf, engine);
    if (id === 'scripts' && !tabs.scripts) tabs.scripts = createScriptScreen(screens.scripts, chart);
    if (id === 'settings' && !tabs.settings) tabs.settings = createSettingsScreen(screens.settings);
  }

  // ── Boot ───────────────────────────────────────────────────────
  initSheets();
  loadIndicators();
  loadBroker();
  hookFillMarkers();
  setPerfMode(state.perf);

  const engine = new ExecutionEngine(() => loadBrokerSettings().risk);
  engine.onRiskEvent((msg, level) => showToast(msg, level === 'halt' ? 'err' : 'warn'));

  let dom: ReturnType<typeof createChartDom> | null = null;

  function lastPrice(): number {
    const b = state.bars;
    return b.length ? b[b.length - 1].close : 0;
  }

  function requestOrder(o: NewExecOrder): ExecOrder {
    const oneClick = loadBrokerSettings().oneClick;
    const doSubmit = (): ExecOrder => {
      const r = engine.submit(o, lastPrice());
      dom?.refresh();
      if (r.status === 'rejected') showToast(`Order rejected: ${r.rejectReason}`, 'err');
      else if (r.status === 'filled') showToast(`${o.side.toUpperCase()} ${o.qty} filled @ ${r.fillPrice?.toFixed(2)}`, 'ok');
      else showToast(`${o.side.toUpperCase()} ${o.qty} working (${o.type})`, 'ok');
      return r;
    };
    if (oneClick) return doSubmit();
    const summary = `${o.side.toUpperCase()} ${o.qty} ${o.symbol}\n${o.type.replace(/-/g, ' ')}${o.triggerPrice != null ? ` @ ${o.triggerPrice.toFixed(2)}` : ' (market)'}`;
    confirmExec((confirmed) => { if (confirmed) doSubmit(); }, summary);
    return { id: 'confirming', symbol: o.symbol, side: o.side, qty: o.qty, type: o.type, status: 'working', createdAt: Date.now() };
  }

  function syncDom(): void {
    if (state.domEnabled && !dom) {
      dom = createChartDom(mainWrap, engine, {
        getSymbol: () => state.symbol,
        getPrice: lastPrice,
        onRequest: requestOrder,
      });
    } else if (!state.domEnabled && dom) {
      dom.destroy();
      dom = null;
    }
  }

  chart = createChartScreen(mainWrap, {
    onPriceUpdate: (close, prevClose, symbol) => {
      priceEl.textContent = close.toFixed(2);
      const chg = ((close - prevClose) / prevClose) * 100;
      priceEl.className = 'price ' + (chg >= 0 ? 'up' : 'down');
      changeEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
      changeEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
    },
    onDataSource: setSourceBadge,
    onEngineBars: (bars) => {
      engine.setBars(bars);
      dom?.refresh();
    },
    onEngineTick: (price, ts) => {
      engine.onTick(price, ts);
      dom?.refresh();
    },
  });
  // Global chart re-fetch hook — Settings switches (yfinance etc.) call this
  // to force an immediate reload from the NEW preferred feed. It was
  // referenced in three places but never assigned (dead global).
  (window as any).__dafeChartRefresh = () => { try { chart?.reload(); } catch {} };

  syncDom();

  switchTab('chart');

  // Live-simulate when the tab is visible (lazy screens created on demand).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeTab === 'trade') (tabs.trade as { refresh: () => void })?.refresh();
  });

  // ── PWA service worker ─────────────────────────────────────────
  // Native (Capacitor) builds NEVER register a SW — assets are local and SW
  // caching poisoned installs with stale bundles (black screen on launch).
  const isNative = !!(window as any).Capacitor?.isNativePlatform?.();
  if (!isNative && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline fallback not critical */ });
  }
}

function main(): void {
  try { document.getElementById('boot-splash')?.remove(); } catch { /* noop */ }
  if (!state.onboarded) {
    showOnboarding(() => boot());
  } else {
    boot();
  }
}

try {
  main();
} catch (e) {
  // Belt-and-braces: paint boot failures even if the early overlay missed them.
  const ov = document.getElementById('crash-overlay');
  if (ov) {
    ov.style.display = 'block';
    ov.innerHTML = '<h3>Startup error</h3>';
    const msg = document.createElement('div');
    msg.textContent = e instanceof Error ? (e.stack || e.message) : String(e);
    ov.appendChild(msg);
  }
}