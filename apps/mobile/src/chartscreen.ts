import type { BaseBar, VolumeProfileMode } from '@dafe/types';
import type { PerBarVolume } from '../../web/src/data-generator';
import {
  generateBars, generatePerBarVolumes, transformBars,
  type BarType, type Timeframe,
} from '../../web/src/data-generator';
import {
  drawBackground, drawGrid, drawBars, drawTimeAxis,
  drawVolumeProfile, drawCrosshair, drawOHLCTooltip,
  drawOakScriptPlots, drawTradeMarkers, drawSecondaryChart,
  getVisibleRange, getPriceRange,
  MIN_BAR_SPACING, MAX_BAR_SPACING, DEFAULT_BAR_SPACING,
  type ViewState,
} from '../../web/src/chart-renderer';
import { computeVolumeProfileBins, DEFAULT_VP_SETTINGS, type VPComputed } from '../../web/src/volume-profile';
const MOBILE_VP_SETTINGS = { ...DEFAULT_VP_SETTINGS, mode: '2D-Side' as const };
import { parse, executeScript, validate, formatValidationIssues } from '../../web/src/oakscript';
import type { OakPlot3D, OakPlot } from '../../web/src/oakscript/runtime';
import { barsToRuntimeBarData } from '../../web/src/backtest/data';
import { draw3DScene } from '../../web/src/iso3d';
import { renderMain3DScene, mark3DSceneDirty, dispose3DScene, getRenderTime, renderIsoOverlay3D, setIsoCompositeHost, isIsoCompositeActive } from '../../web/src/three-indicators';
import { show3D, hide3D, setLowerPaneHost } from '../../web/src/three-lower-pane';
import { findBackend, fetchBackendBars } from './backend';
import { fetchMassiveBars } from './massive';
import { fetchYahooBars } from './yahoo';
import { getDataSourceForSymbol } from './data-adapter';
import { LiveMarketEngine } from './live-engine';
import { deriveMetrics } from './metrics-adapter';
import { state, persistSettings, loadBroker, cacheBars, loadCachedBars, syncMarkersForSymbol, DEMO_MODE, widgetHidden, saveWidgetHidden, type DataProvider, type WidgetKey } from './state';
import { TouchEngine } from './touch';
import { createRegimeStrip } from './regime-ribbon';
import { particlesEnabled } from './particles';
import {
  renderDrawings, getDrawings, addDrawing, undoDrawing, clearDrawings, screenToPoint,
  TOOL_POINTS, type Drawing, type DrawPick, type DrawPoint, type DrawTool,
} from './drawings';

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000,
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000,
};

export interface ChartScreenCallbacks {
  onPriceUpdate: (close: number, prevClose: number, symbol: string, tf: Timeframe) => void;
  onDataSource: (provider: DataProvider) => void;
  onEngineBars: (bars: BaseBar[]) => void;
  onEngineTick: (price: number, ts: number) => void;
  onIndicatorsRun?: (bars: BaseBar[]) => void;
}

export interface ChartScreen {
  canvas: HTMLCanvasElement;
  container: HTMLDivElement;
  loadSymbol: (symbol: string, tf?: Timeframe) => void;
  setTimeframe: (tf: Timeframe) => void;
  setBarType: (t: BarType) => void;
  setVpEnabled: (on: boolean) => void;
  setLive: (on: boolean) => void;
  set3D: (on: boolean) => void;
  setDrawMode: (on: boolean) => void;
  isDrawMode: () => boolean;
  setWidgetHidden: (key: WidgetKey, hidden: boolean) => void;
  reload: () => void;
  resetView: () => void;
  refreshIndicators: () => void;
  dispose: () => void;
}

// With the particle backdrop on, the chart leaves its background clear so the field shows through.
function paintChartBackground(ctx: CanvasRenderingContext2D, time: number, w: number, h: number): void {
  if (particlesEnabled()) ctx.clearRect(0, 0, w, h);
  else drawBackground(ctx, time);
}

export function createChartScreen(container: HTMLDivElement, cb: ChartScreenCallbacks): ChartScreen {
  // The container is a flex column (see main.ts mainWrap). Layout, top to
  // bottom: [chart canvas — flex:1, shrinks] [dashboard band — content-fit,
  // shrink:0] — so the band takes real space between the main chart and the
  // lower pane instead of floating OVER the candles.
  const canvas = document.createElement('canvas');
  canvas.id = 'chart-canvas';
  canvas.style.position = 'relative';
  canvas.style.flex = '1';
  canvas.style.minHeight = '0';
  canvas.style.width = '100%';
  canvas.style.display = 'block';
  container.appendChild(canvas);
  const regimeStrip = createRegimeStrip();
  container.insertBefore(regimeStrip.el, canvas);
  const ctx = canvas.getContext('2d')!;
  let dashHidden = widgetHidden('dash');
  let regimeHidden = widgetHidden('regime');

  let rafId = 0;
  let lastTs = 0;
  let time = 0;
  let momentum = { vx: 0, vy: 0 };
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let lastSyntheticAt = 0;
  let lastIndicatorRun = 0;
  let disposed = false;

  // ── Live Market Engine — the unbreakable stream ──────────────────────
  // Replaces the fetch-once-then-freeze model. Layered: Massive (paid, fast
  // anchors, 403-aware) → Yahoo (free corrections) → calibration-anchored
  // synthesis (always-moving micro-ticks between real updates). See
  // live-engine.ts for the layer contract.
  const engineLive = new LiveMarketEngine();
  let liveTickDirty = false;          // live bar mutated since last runIndicators
  let indicatorsRunTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleIndicatorRerun(): void {
    // Throttled re-run of indicator math on live ticks — full executeScript
    // over 500+ bars every 400ms would starve the render loop, but never
    // re-running leaves plots frozen at fetch time. 500ms cadence + a dirty
    // flag keeps plotted values current at a fraction of the cost.
    if (indicatorsRunTimer) return;
    indicatorsRunTimer = setTimeout(() => {
      indicatorsRunTimer = null;
      if (liveTickDirty && !disposed) {
        liveTickDirty = false;
        try { runIndicators(); } catch { /* render loop survives */ }
      }
    }, 500);
  }

  let perBarVols: PerBarVolume[] = [];
  let vpCache: { key: string; computed: VPComputed } | null = null;

  // ── Dashboard Band (adaptive, adapter-driven) ────────────────────────
  // Sits between the main chart and the lower pane. The Universal Metrics
  // Adapter (metrics-adapter.ts) derives the metric set from EVERY active
  // script's plots — no script declares or draws its own dashboard. The band
  // adapts its layout to the content: sections wrap horizontally into
  // columns, chips flow within a section, and only extreme overflow scrolls.
  // Each section carries a per-indicator power toggle (auto-populated for
  // any script whose adapter output is non-empty — the "dashboard toggle").
  const dashWin = document.createElement('div');
  dashWin.id = 'dashboard-win';
  container.appendChild(dashWin);

  // ── Preview overlay (review only) ────────────────────────────────────
  // state.preview runs as an extra overlay. Its plots live in previewPlots,
  // never in state.indicators, so the accepted set and saved source are untouched.
  let previewPlots: OakPlot[] = [];
  let previewErrors: string[] = [];
  const previewBadge = document.createElement('div');
  previewBadge.id = 'preview-badge';
  previewBadge.style.cssText = 'position:absolute;top:6px;left:50%;transform:translateX(-50%);z-index:5;display:none;pointer-events:none;max-width:90%;font-size:10px;font-weight:700;letter-spacing:0.3px;padding:3px 8px;border-radius:6px;background:rgba(255,190,60,0.14);border:1px solid rgba(255,190,60,0.6);color:rgba(255,200,90,0.98);text-align:center;';
  const previewLabel = document.createElement('div');
  previewLabel.textContent = 'PREVIEW · not applied to your indicator';
  const previewErrEl = document.createElement('div');
  previewErrEl.style.cssText = 'font-weight:400;color:rgba(255,160,160,0.95);';
  previewBadge.appendChild(previewLabel);
  previewBadge.appendChild(previewErrEl);
  container.appendChild(previewBadge);

  function updatePreviewBadge(): void {
    previewBadge.style.display = state.preview ? '' : 'none';
    previewErrEl.textContent = previewErrors.length ? `⚠ ${previewErrors[0].slice(0, 120)}` : '';
  }

  function activePlots(): OakPlot[] {
    return [...state.indicators.filter((i) => i.enabled).flatMap((i) => i.plots), ...previewPlots];
  }
  let dashLastRender = 0;
  let dashLastSig = '';
  const DASH_KEY = 'dafe_mobile_dash_disabled';

  function loadDashDisabled(): Record<string, boolean> {
    try { return JSON.parse(localStorage.getItem(DASH_KEY) || '{}'); } catch { return {}; }
  }
  function isDashOn(indicatorName: string): boolean {
    return !loadDashDisabled()[indicatorName];
  }
  function toggleDash(indicatorName: string): void {
    const d = loadDashDisabled();
    d[indicatorName] = !d[indicatorName];
    try { localStorage.setItem(DASH_KEY, JSON.stringify(d)); } catch {}
  }

  function renderDashboardWindow(): void {
    if (dashHidden) { dashWin.style.display = 'none'; return; }
    const now = performance.now();
    if (now - dashLastRender < 900) return;
    dashLastRender = now;
    // Adapter pull — metrics from every enabled indicator's live plot set.
    const metrics = deriveMetrics({ indicators: state.indicators });
    const visible = metrics.filter(m => m.hasMetrics && isDashOn(m.name));
    if (visible.length === 0) {
      if (dashWin.childElementCount > 0) { dashWin.replaceChildren(); dashLastSig = ''; }
      dashWin.style.display = 'none';
      return;
    }
    // Rebuild only when the CONTENT SIGNATURE changes (not every frame).
    let sig = '';
    for (const m of visible) sig += m.name + '|' + m.rows.map(r => r.label + r.value).join(';');
    if (sig === dashLastSig) return;
    dashLastSig = sig;
    dashWin.style.display = 'flex';
    dashWin.replaceChildren();
    for (const m of visible) {
      const card = document.createElement('div');
      card.className = 'dash-section';
      const head = document.createElement('div');
      head.className = 'dash-section-head';
      const nm = document.createElement('span');
      nm.className = 'dash-section-name';
      nm.textContent = m.name;
      // Signal-colored section header — a live LONG/SHORT state tints the
      // whole section so the eye lands on the active signal first.
      if (m.signal === 'long') card.classList.add('sig-long');
      else if (m.signal === 'short') card.classList.add('sig-short');
      // Power toggle — auto-populated for every metric-bearing indicator
      // (adapter decides "has a dashboard", the user decides "show it").
      const pw = document.createElement('button');
      pw.className = 'dash-power';
      pw.textContent = '⏻';
      pw.title = `Toggle ${m.name} metrics`;
      pw.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDash(m.name);
        dashLastSig = '';
        dashLastRender = 0;
        renderDashboardWindow();
      });
      head.appendChild(nm);
      head.appendChild(pw);
      card.appendChild(head);
      const body = document.createElement('div');
      body.className = 'dash-section-body';
      for (const r of m.rows.slice(0, 16)) {
        const chip = document.createElement('div');
        chip.className = 'dash-chip' + (r.emphasis && r.emphasis !== 'none' ? ` chip-${r.emphasis}` : '');
        chip.title = r.hint ? `${m.name}: ${r.hint}` : `${m.name}: ${r.label} ${r.value}`;
        if (r.label) {
          const lab = document.createElement('span');
          lab.className = 'dash-chip-label';
          lab.textContent = r.label;
          chip.appendChild(lab);
        }
        const val = document.createElement('span');
        val.className = 'dash-chip-value';
        val.textContent = r.value;
        if (r.color) val.style.color = r.color;
        if (r.bg) chip.style.background = r.bg;
        chip.appendChild(val);
        body.appendChild(chip);
      }
      card.appendChild(body);
      dashWin.appendChild(card);
    }
  }

  // ── Genuine 3D capability detection + graceful fallback ──────────────
  // The Three.js renderer is the DEFAULT for plot3d indicators. The 2D proxy
  // fallback is shown ONLY when this device genuinely can't hold the GL scene:
  // WebGL missing, context creation failure, or sustained frames below ~18fps.
  let webglOk: boolean | null = null;
  let warned3D = false;
  let gen3DDisabled = false;
  let slowFrames = 0;
  let renderSamples = 0;
  let renderSampleSum = 0;

  function detectWebGL(): boolean {
    if (webglOk !== null) return webglOk;
    try {
      const probe = document.createElement('canvas');
      const gl = (probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl')) as WebGLRenderingContext | null;
      webglOk = !!gl;
      if (gl) {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch {
      webglOk = false;
    }
    return webglOk;
  }

  function show3DFallbackWarning(reason: string): void {
    if (warned3D) return;
    warned3D = true;
    const ov = document.createElement('div');
    ov.id = 'perf-warning';
    const panel = document.createElement('div');
    panel.className = 'perf-warning-panel';
    const close = document.createElement('button');
    close.className = 'perf-warning-close';
    close.textContent = '×';
    close.addEventListener('click', () => ov.remove());
    const title = document.createElement('div');
    title.className = 'perf-warning-title';
    title.textContent = '3D render limit reached';
    const body = document.createElement('div');
    body.className = 'perf-warning-body';
    body.innerHTML = [
      `<div class="perf-warning-reason">${reason}</div>`,
      '<div>This device is hitting its rendering limits, so 3D indicators are shown in a reliable 2D view instead. To recover genuine 3D or improve smoothness:</div>',
      '<ul>',
      '<li>Open Settings → Display → set <b>Performance</b> to <b>Low</b> or <b>Medium</b></li>',
      '<li>Turn <b>3D off</b> (or reduce the number of 3D indicators)</li>',
      '<li>Close other apps to free memory</li>',
      '<li>Use a smaller timeframe or fewer visible bars</li>',
      '</ul>',
    ].join('');
    panel.appendChild(close);
    panel.appendChild(title);
    panel.appendChild(body);
    ov.appendChild(panel);
    container.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  }

  function recordRendererMs(ms: number | null): boolean {
    // Returns false when the device is too slow to sustain genuine 3D.
    if (ms == null || !Number.isFinite(ms)) return true;
    renderSampleSum += ms;
    renderSamples++;
    if (renderSamples < 20) return true;
    const avg = renderSampleSum / renderSamples;
    renderSampleSum = 0;
    renderSamples = 0;
    if (avg > 55) {
      slowFrames++;
      if (slowFrames >= 3) return false;
    } else {
      slowFrames = Math.max(0, slowFrames - 1);
    }
    return true;
  }

  function sizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Measure the CANVAS box, not the container — the dashboard band now
    // takes real flex space below the canvas, so the drawing surface is
    // exactly the remaining chart area.
    const w = canvas.clientWidth || container.clientWidth;
    const h = canvas.clientHeight || container.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rebuildTransformed(): void {
    state.transformed = transformBars(state.bars, state.barType);
    perBarVols = generatePerBarVolumes(state.transformed, 10);
  }

  function notifyPrice(): void {
    const b = state.transformed;
    if (b.length > 0) {
      cb.onPriceUpdate(b[b.length - 1].close, b.length > 1 ? b[b.length - 2].close : b[b.length - 1].close, state.symbol, state.timeframe);
    }
  }

  // True when the CURRENT view came from user pan/zoom (auto-refresh keeps it).
  // False on symbol/timeframe switches (fresh default view).
  let viewIsFromUser = false;
  function markViewUserTouched(): void { viewIsFromUser = true; }

  async function loadBars(): Promise<void> {
    try {
      await loadBarsInner();
    } catch {
      // Any unexpected failure must still leave a usable chart — never an empty one.
      if (state.bars.length === 0) {
        state.bars = generateBars(state.timeframe.startsWith('1') || state.timeframe.startsWith('5') || state.timeframe.startsWith('10') || state.timeframe.startsWith('30') ? 480 : 320, state.timeframe, state.symbol);
        rebuildTransformed();
        cb.onEngineBars(state.bars);
        notifyPrice();
      }
    }
  }

  async function loadBarsInner(): Promise<void> {
    const tf = state.timeframe;
    const count = tf.startsWith('1') || tf.startsWith('5') || tf.startsWith('10') || tf.startsWith('30') ? 480 : 320;
    let data: BaseBar[] | null = null;
    let provider: DataProvider = 'synthetic';
    // DEMO MODE: synthetic only — the public web demo must never touch real
    // feeds, keys or any external network. generateBars keeps the chart alive
    // and the live engine below runs purely on calibrated synthesis.
    if (DEMO_MODE) {
      data = generateBars(count, tf, state.symbol);
      state.dataProvider = 'synthetic';
      state.dataSource = 'synthetic';
      state.bars = data;
      rebuildTransformed();
      if (!viewIsFromUser) state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
      runIndicators();
      notifyPrice();
      cb.onDataSource('synthetic');
      cb.onEngineBars(data);
      startLiveEngine();
      return;
    }
    const preferred = getDataSourceForSymbol(state.symbol);
    const feed = state.preferredFeed; // 'auto' follows the normal chain
    // 0) FORCED Yahoo — the Settings switch. Skips Massive/Backend entirely so
    //    a dead Massive key can never shadow free real Yahoo data.
    if (feed === 'yahoo') {
      const yahoo = await fetchYahooBars(state.symbol, tf);
      if (yahoo && yahoo.length > 0) { data = yahoo; provider = 'yahoo'; }
    }
    // 1) Massive (paid) — direct from the phone when an API key is configured.
    //    Real tick-derived bars, all timeframes including 1s/5s/10s/30s.
    if (!data && feed !== 'yahoo' && state.massiveApiKey?.trim()) {
      const massive = await fetchMassiveBars(state.symbol, tf);
      if (massive && massive.length > 0) {
        data = massive;
        provider = 'massive';
      }
    }
    // 2) Backend (optional) — same PC server chain when reachable.
    if (!data && feed !== 'yahoo' && state.backendMode !== 'offline') {
      const url = await findBackend();
      if (url) {
        if (state.backendUrl !== url) {
          state.backendUrl = url;
          persistSettings();
        }
        const res = await fetchBackendBars(state.symbol, tf, Math.min(count * 2, 2000), url);
        if (res && res.bars.length > 0) {
          data = res.bars;
          provider = 'backend';
        }
      }
    }
    // 3) Yahoo Finance — direct from the phone, no PC required.
    if (!data) {
      const yahoo = await fetchYahooBars(state.symbol, tf);
      if (yahoo && yahoo.length > 0) {
        data = yahoo;
        provider = 'yahoo';
      }
    }
    if (!data) {
      const cached = loadCachedBars(state.symbol, tf);
      if (cached && cached.length > 0) {
        data = cached;
        provider = 'cache';
      }
    }
    if (!data || data.length === 0) data = generateBars(count, tf, state.symbol);
    state.dataSource = provider === 'synthetic' ? 'synthetic' : 'live';
    state.dataProvider = provider;
    if (provider === 'synthetic') lastSyntheticAt = Date.now();
    if (provider === 'backend' || provider === 'yahoo' || provider === 'massive') cacheBars(state.symbol, tf, data);
    cb.onDataSource(provider);
    state.bars = data;
    rebuildTransformed();
    // Auto-refresh (60s) must NOT wipe the user's pan/zoom — only an explicit
    // symbol/timeframe switch resets the view.
    if (!viewIsFromUser) state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
    runIndicators();
    notifyPrice();
    cb.onEngineBars(data);
    persistSettings();

    // ── Hand the bar set to the live engine so the stream KEEPS MOVING ──
    // Every symbol/timeframe switch re-anchors the engine; from here on it
    // owns polling (adaptive per layer) + micro-tick synthesis.
    startLiveEngine();
  }

  function startLiveEngine(): void {
    engineLive.start({
      symbol: state.symbol,
      timeframe: state.timeframe,
      seedBars: state.bars,
      onEvent: (ev) => {
        if (disposed) return;
        if (ev.type === 'bars') {
          state.bars = ev.bars;
          state.dataProvider = ev.provider === 'synthetic' ? 'synthetic' : (ev.provider as DataProvider);
          state.dataSource = ev.provider === 'synthetic' ? 'synthetic' : 'live';
          rebuildTransformed();
          runIndicators();
          notifyPrice();
          cb.onEngineBars(ev.bars);
          cb.onDataSource(state.dataProvider);
        } else if (ev.type === 'tick') {
          // Synthesized micro-tick — mutate ONLY the live bar of the visible
          // bar set (cheap), mark dirty for the throttled indicator re-run,
          // and notify price + engine. The LiveMarketEngine keeps its own
          // anchor copy; state.bars stays the single source of truth for
          // rendering, indicators, and the execution engine.
          const src = state.bars;
          if (src.length > 0) {
            const tfMs = TIMEFRAME_MS[state.timeframe] || 60000;
            const live = src[src.length - 1];
            const nextTs = Math.floor(Date.now() / tfMs) * tfMs;
            let rolled = false;
            if (nextTs > live.timestamp) {
              src.push({ timestamp: nextTs, open: live.close, high: live.close, low: live.close, close: live.close, volume: 0 });
              rolled = true;
            }
            const cur = src[src.length - 1];
            const maxMove = cur.close * 0.012;
            const p = Math.max(0.01, ev.price);
            cur.close = Math.abs(p - cur.close) > maxMove ? cur.close + Math.sign(p - cur.close) * maxMove : p;
            if (cur.close > cur.high) cur.high = cur.close;
            if (cur.close < cur.low) cur.low = cur.close;
            // Transform-aware but CHEAP: a full transform rebuild runs only
            // when a new bar rolled (bar-type transforms need the whole set);
            // intra-bar ticks just refresh the live bar's derived volume.
            if (rolled) {
              rebuildTransformed();
            } else if (state.barType === 'candlestick' || state.barType === 'line' || state.barType === 'area' || state.barType === 'footprint') {
              // Identity transforms: state.transformed IS state.bars — refresh
              // only the live bar's per-bar volume voxel in place.
              state.transformed = src;
              if (perBarVols.length === src.length) {
                perBarVols[perBarVols.length - 1] = generatePerBarVolumes([cur], 10)[0];
              }
            } else {
              rebuildTransformed();
            }
            liveTickDirty = true;
            scheduleIndicatorRerun();
            notifyPrice();
            cb.onEngineTick(cur.close, ev.ts);
          }
        } else if (ev.type === 'layer') {
          // Reflect the active layer honestly in the provider badge.
          const map: Record<string, DataProvider> = { massive: 'massive', yahoo: 'yahoo', synthetic: 'synthetic' };
          state.dataProvider = map[ev.layer] || 'synthetic';
          state.dataSource = ev.layer === 'synthetic' ? 'synthetic' : 'live';
          cb.onDataSource(state.dataProvider);
        }
      },
    });
  }

  function loadSymbol(symbol: string, tf?: Timeframe): void {
    state.symbol = symbol;
    if (tf) state.timeframe = tf;
    viewIsFromUser = false;
    if (tf) state.timeframe = tf;
    syncMarkersForSymbol(symbol);
    void loadBars();
  }

  function setTimeframe(tf: Timeframe): void {
    state.timeframe = tf;
    viewIsFromUser = false;
    void loadBars();
  }

  function setBarType(t: BarType): void {
    state.barType = t;
    rebuildTransformed();
    runIndicators();
    notifyPrice();
    persistSettings();
  }

  function setVpEnabled(on: boolean): void {
    state.vpEnabled = on;
    persistSettings();
  }

  function set3D(on: boolean): void {
    if (on) setDrawMode(false);
    state.is3D = on;
    if (!on) {
      // Tearing down 3D: drop the GL overlay (composite OR unified) so the
      // 2D canvas is clean again.
      gen3DDisabled = false;
      try { setIsoCompositeHost(null); } catch { /* noop */ }
      try { dispose3DScene(); } catch { /* not initialized */ }
    } else {
      // Re-entering 3D resets the fallback latch so a previously slow device
      // gets a fresh try (e.g. after the user lowered performance mode).
      gen3DDisabled = false;
      warned3D = false;
      slowFrames = 0;
      renderSamples = 0;
      renderSampleSum = 0;
      // Re-register the overlay host (setIsoCompositeHost(null) clears it).
      setIsoCompositeHost(() => canvas.parentElement);
    }
  }

  function runIndicators(): void {
    const barData = barsToRuntimeBarData(state.transformed);
    for (const ind of state.indicators) {
      if (!ind.enabled) continue;
      try {
        const program = parse(ind.source);
        const result = executeScript(program, barData, new Map());
        ind.plots = result.plots;
        ind.strategyOrders = result.strategyOrders;
        ind.errors = result.errors;
        // Tag every plot with its OWNING indicator so the dashboard window
        // can group sections and offer per-indicator on/off toggles.
        for (const p of ind.plots) (p as any).__ind = ind.name;
        if (result.errors && result.errors.length > 0) {
          (window as any).__dafeEditorChat?.('error', `[${ind.name}] ${result.errors.join(' | ').slice(0, 600)}`);
        }
      } catch (err) {
        ind.plots = [];
        ind.strategyOrders = [];
        ind.errors = [err instanceof Error ? err.message : String(err)];
        (window as any).__dafeEditorChat?.('error', `[${ind.name}] ${ind.errors[0].slice(0, 600)}`);
      }
    }
    previewPlots = [];
    previewErrors = [];
    if (state.preview) {
      try {
        const v = validate(state.preview.source);
        if (!v.valid) {
          previewErrors = formatValidationIssues(v.issues).split('\n').filter(Boolean);
        } else {
          const result = executeScript(parse(state.preview.source), barData, new Map());
          previewPlots = result.plots;
          previewErrors = result.errors ?? [];
        }
      } catch (err) {
        previewErrors = [err instanceof Error ? err.message : String(err)];
      }
    }
    updatePreviewBadge();
    lastIndicatorRun = performance.now();
    mark3DSceneDirty();
    try { cb.onIndicatorsRun?.(state.transformed); } catch { /* listener failure must not break the chart */ }
  }

  function setWidgetHidden(key: WidgetKey, hidden: boolean): void {
    saveWidgetHidden(key, hidden);
    if (key === 'dash') {
      dashHidden = hidden;
      dashLastSig = '';
      dashLastRender = 0;
      if (hidden) dashWin.style.display = 'none';
      else renderDashboardWindow();
    } else {
      regimeHidden = hidden;
      // The strip paints only on its own 3s recompute; show the last paint at once.
      regimeStrip.el.style.display = hidden || !regimeStrip.el.textContent ? 'none' : 'flex';
    }
  }


  function setLive(on: boolean): void {
    // The LiveMarketEngine (startLiveEngine) is the real stream: adaptive
    // polling per layer + micro-tick synthesis. This legacy switch now only
    // gates the extra stuck-synthetic rescue refresher — the stream itself
    // always runs so the price never freezes.
    state.liveEnabled = on;
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (on) {
      liveTimer = setInterval(() => {
        if (document.hidden) return;
        if (state.dataProvider === 'synthetic') {
          // STUCK-SYNTHETIC RESCUE: initial fetch fell through to demo data
          // (dead key + unreachable feeds). Keep retrying the real chain
          // every 15s instead of freezing the chart forever on one price.
          const since = Date.now() - (lastSyntheticAt || 0);
          if (lastSyntheticAt === 0 || since >= 15_000) {
            lastSyntheticAt = Date.now();
            void loadBars();
          }
          return;
        }
      }, 60_000);
    }
  }
  // Real-feed auto-refresh is always on (rescue cadence above, engine polls
  // otherwise). The user never manages a play/pause again.
  setLive(true);

  // ── Draw mode (touch drawing tools) ──────────────────────────────
  // OFF by default: every touch path below is the pre-existing one. ON: the
  // toolbar appears above the canvas and a single-finger gesture places the
  // active tool's points. Tool 'none' (Pan) keeps single-finger panning.
  // Two fingers always cancel the drawing gesture so pinch zoom still works.
  const DRAW_TOOLS: { id: DrawPick; label: string }[] = [
    { id: 'none', label: 'Pan' }, { id: 'trend', label: 'Trend' }, { id: 'ray', label: 'Ray' },
    { id: 'hline', label: 'H-Line' }, { id: 'rect', label: 'Rect' }, { id: 'fib', label: 'Fib' },
    { id: 'channel', label: 'Channel' }, { id: 'text', label: 'Text' },
  ];
  let drawMode = false;
  let drawTool: DrawPick = 'none';
  const drawPending: DrawPoint[] = [];
  let drawGesture: { sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
  const ghostDrawing: Drawing = { id: 'ghost', tool: 'trend', points: [] };
  let ghost: Drawing | null = null;
  let listSym = '';
  let listTf = '';
  let listCur: Drawing[] = [];

  const drawBar = document.createElement('div');
  drawBar.id = 'draw-toolbar';
  drawBar.className = 'draw-toolbar';
  drawBar.style.display = 'none';
  const toolBtns = new Map<DrawPick, HTMLButtonElement>();
  function drawBtn(label: string, cls: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  for (const t of DRAW_TOOLS) {
    const b = drawBtn(t.label, 'draw-tool-btn', () => setDrawTool(t.id));
    toolBtns.set(t.id, b);
    drawBar.appendChild(b);
  }
  drawBar.appendChild(drawBtn('Undo', 'draw-tool-btn draw-action', () => { undoDrawing(state.symbol, state.timeframe); }));
  drawBar.appendChild(drawBtn('Clear', 'draw-tool-btn draw-action', () => {
    if (window.confirm(`Clear all drawings on ${state.symbol} ${state.timeframe}?`)) clearDrawings(state.symbol, state.timeframe);
  }));
  drawBar.appendChild(drawBtn('Done', 'draw-tool-btn draw-action', () => setDrawMode(false)));
  container.insertBefore(drawBar, canvas);

  function syncDrawToolbar(): void {
    for (const [id, b] of toolBtns) b.classList.toggle('active', id === drawTool);
  }

  function canvasSize(): { w: number; h: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return { w: canvas.width / dpr, h: canvas.height / dpr };
  }

  function screenPoint(x: number, y: number): DrawPoint {
    const { w, h } = canvasSize();
    return screenToPoint(x, y, state.transformed, state.view, w, h);
  }

  // The list for the current symbol+timeframe. Reads state each frame but only
  // re-resolves the cached list when the key changes (no per-frame allocation).
  function currentDrawings(): Drawing[] {
    if (state.symbol !== listSym || state.timeframe !== listTf) {
      listSym = state.symbol;
      listTf = state.timeframe;
      listCur = getDrawings(listSym, listTf);
      drawPending.length = 0;
      drawGesture = null;
      refreshGhost();
    }
    return listCur;
  }

  function refreshGhost(): void {
    if (!drawMode || drawTool === 'none') { ghost = null; return; }
    const tool: DrawTool = drawTool;
    const req = TOOL_POINTS[tool];
    const pts = ghostDrawing.points;
    pts.length = 0;
    for (const pt of drawPending) pts.push(pt);
    if (drawGesture && drawGesture.moved && req >= 2) {
      if (drawPending.length === 0) pts.push(screenPoint(drawGesture.sx, drawGesture.sy));
      pts.push(screenPoint(drawGesture.cx, drawGesture.cy));
    }
    ghostDrawing.tool = tool;
    ghost = pts.length > 0 ? ghostDrawing : null;
  }

  function addDrawPoint(pt: DrawPoint): void {
    if (!drawMode || drawTool === 'none') return;
    const tool: DrawTool = drawTool;
    drawPending.push(pt);
    if (drawPending.length >= TOOL_POINTS[tool]) {
      let text: string | undefined;
      if (tool === 'text') {
        const input = window.prompt('Text label:');
        if (!input || !input.trim()) { drawPending.length = 0; refreshGhost(); return; }
        text = input.trim();
      }
      addDrawing(state.symbol, state.timeframe, tool, drawPending, text);
      drawPending.length = 0;
    }
    refreshGhost();
  }

  // A drag places its start and end (1-point tools place only the start).
  // Once a point is pending, a later drag places just its end point.
  function finishDrawGesture(): void {
    const g = drawGesture;
    drawGesture = null;
    if (!g || !drawMode || drawTool === 'none') { refreshGhost(); return; }
    const req = TOOL_POINTS[drawTool];
    if (req === 1) addDrawPoint(screenPoint(g.sx, g.sy));
    else if (drawPending.length === 0) {
      addDrawPoint(screenPoint(g.sx, g.sy));
      addDrawPoint(screenPoint(g.cx, g.cy));
    } else addDrawPoint(screenPoint(g.cx, g.cy));
    refreshGhost();
  }

  function setDrawTool(t: DrawPick): void {
    drawTool = t;
    drawPending.length = 0;
    drawGesture = null;
    syncDrawToolbar();
    refreshGhost();
  }

  function setDrawMode(on: boolean): void {
    const next = on && !state.is3D;
    if (next === drawMode) return;
    drawMode = next;
    drawBar.style.display = next ? 'flex' : 'none';
    setDrawTool('none');
  }

  function draw(ts: number): void {
    if (disposed) return;
    const dt = Math.min(50, ts - lastTs || 16);
    lastTs = ts;
    time += dt;

    if (Math.abs(momentum.vx) > 0.5 || Math.abs(momentum.vy) > 0.5) {
      const decay = Math.pow(0.92, dt / 16);
      state.view.scrollX = Math.max(0, state.view.scrollX + (momentum.vx * dt / 1000) / state.view.barSpacing);
      state.view.offsetY += momentum.vy * dt / 1000;
      momentum.vx *= decay;
      momentum.vy *= decay;
      if (Math.abs(momentum.vx) < 0.5 && Math.abs(momentum.vy) < 0.5) { momentum.vx = 0; momentum.vy = 0; }
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const view: ViewState = state.view;
    const bars = state.transformed;
    if (!regimeHidden) regimeStrip.update(bars, Date.now());
    // Clamp vertical pan/fling inside a sane band so candles can't be flung
    // fully off-canvas (the "bars flattened out / went invisible" symptom when
    // a fling carried offsetY to an extreme).
    state.view.offsetY = Math.max(-h * 2, Math.min(h * 2, state.view.offsetY));

    if (state.is3D) {
      const enabledPlots = activePlots();
      const pl3d = enabledPlots.filter((p: any) => p.type === 'plot3d') as OakPlot3D[];
      const shape3d = enabledPlots.filter((p: any) => p.type === 'plot3d_shape' || p.type === 'plot3d_label');
      const canWebGL = detectWebGL();

      // ── ISO-COMPOSITE (Option B) ──────────────────────────────────────
      // The user's isometric candle scene is ALWAYS the base layer — never
      // replaced. When plot3d indicators are active AND the device can hold
      // GL, the genuine Three.js geometry renders on a TRANSPARENT overlay
      // canvas in the same rect, projected to match iso's cabinet math, so
      // iso candles + GL indicator layers read as ONE coherent 3D scene.
      if (pl3d.length === 0) {
        // No 3D layers wanted — make sure no stale overlay lingers.
        try { if (isIsoCompositeActive()) { setIsoCompositeHost(null); } } catch { /* noop */ }
      } else if (canWebGL && !gen3DDisabled) {
        try {
          renderIsoOverlay3D(bars, pl3d, view, w, h, shape3d);
          if (!recordRendererMs(getRenderTime())) {
            gen3DDisabled = true;
            setIsoCompositeHost(null);
            show3DFallbackWarning('Sustained frame rate below ~18fps while rendering 3D indicators.');
          }
        } catch {
          gen3DDisabled = true;
          try { setIsoCompositeHost(null); } catch { /* already disposed */ }
          show3DFallbackWarning('WebGL context could not be created for 3D indicators.');
        }
      } else {
        // GL unavailable/disabled — no overlay; iso3d's OWN 2D plot3d proxy
        // (draw3DIndicatorPlots inside draw3DScene) still shows the data.
        try { if (isIsoCompositeActive()) setIsoCompositeHost(null); } catch { /* noop */ }
      }

      // ── Iso-3D candle scene — the BASE, always rendered in 3D mode ──
      paintChartBackground(ctx, time, w, h);
      let vp: ReturnType<typeof computeVolumeProfileBins> | undefined;
      if (state.vpEnabled && bars.length > 0) {
        const { start, end } = getVisibleRange(view, w, bars.length);
        const slice = bars.slice(start, end);
        if (slice.length > 0) vp = computeVolumeProfileBins(slice, { ...DEFAULT_VP_SETTINGS });
      }
      draw3DScene(ctx, bars, view, {
        barType: state.barType,
        // VPI ON = the signature look from the hero screenshots: per-level
        // volume voxels extruded behind every candle (green/red/neutral by
        // buy pressure, POC-tinted via vpComputed colors) — the SAME
        // 3D-Extrude + 3D-Depth defaults as the web app. The VP toggle in
        // the chart menu drives it; OFF = clean candles only.
        perBarVols: state.vpEnabled ? perBarVols : undefined,
        volumeBins: vp?.bins,
        volumeMode: '3D-Extrude',
        visualEngine: DEFAULT_VP_SETTINGS.visualEngine,
        volumeEnabled: state.vpEnabled,
        vpiEnabled: state.vpEnabled,
        time,
        profileWidth: state.vpWidth,
        vpComputed: vp,
        bgViz: 'stars',
        plots: enabledPlots.filter((p: any) => p.type !== 'plot3d'),
      });
      // Ordinary 2D plots stay visible as an overlay; plot3d series are shown
      // as a 2D proxy so their DATA is still visible even when GL is off.
      // table/label (dashboard readouts) NEVER draw on canvas — they render
      // exclusively in the dashboard window below the chart.
      if (enabledPlots.length > 0) {
        drawOakScriptPlots(ctx, enabledPlots.filter((p: any) => p.type !== 'plot3d_shape' && p.type !== 'plot3d_label' && p.type !== 'table' && p.type !== 'label' && p.type !== 'plot3d'), bars, view);
      }
      drawTimeAxis(ctx, bars, view, state.timeframe);
      renderDashboardWindow();
      rafId = requestAnimationFrame(draw);
      return;
    }

    // Leaving 3D mode entirely — tear down any composite overlay.
    try { if (isIsoCompositeActive()) setIsoCompositeHost(null); } catch { /* noop */ }

    paintChartBackground(ctx, time, w, h);
    drawGrid(ctx, bars, view, time);

    if (state.vpEnabled && bars.length > 0) {
      const { start, end } = getVisibleRange(view, w, bars.length);
      if (start < bars.length && end >= start) {
        const endIdx = Math.min(end + 1, bars.length);
        // Recompute bins only when the visible window or data actually changes;
        // alignment maps the cached bins through live pan/zoom every frame.
        const lastBar = bars[endIdx - 1];
        const vpKey = `${state.symbol}:${state.timeframe}:${start}:${endIdx}:${lastBar.timestamp}:${lastBar.close}`;
        if (!vpCache || vpCache.key !== vpKey) {
          vpCache = { key: vpKey, computed: computeVolumeProfileBins(bars.slice(start, endIdx), { ...MOBILE_VP_SETTINGS }) };
        }
        const vp = vpCache.computed;
        const pr = getPriceRange(bars, view, w);
        drawVolumeProfile(ctx, vp.bins, MOBILE_VP_SETTINGS.mode as VolumeProfileMode, time, vp, state.vpWidth, { minP: pr.minP, pRange: pr.pRange, view });
      }
    }

    drawBars(ctx, bars, view, time, state.barType, perBarVols);
    renderDrawings(ctx, view, bars, currentDrawings(), ghost);

    const enabledPlots = activePlots();
    // Dashboard readouts (table/label) render ONLY in the dashboard window.
    if (enabledPlots.length > 0) drawOakScriptPlots(ctx, enabledPlots.filter((p: any) => p.type !== 'table' && p.type !== 'label'), bars, view);

    if (state.markers.length > 0) drawTradeMarkers(ctx, bars, view, state.markers);

    drawTimeAxis(ctx, bars, view, state.timeframe);

    // Lower panel — separate pane plots
    try {
      const lowerCanvas = document.getElementById('mobile-lower-canvas') as HTMLCanvasElement | null;
      if (lowerCanvas) {
        // ── Genuine Three.js lower pane (pane="separate" plot3d) ──
        // This is the same renderer the web app uses — surface/mesh/nebula/
        // constellation/torus/etc all render as real geometry here, not lines.
        const sep3D = enabledPlots.filter((p: any) => p.type === 'plot3d' && p.pane === 'separate') as OakPlot3D[];
        if (sep3D.length > 0 && !state.is3D) {
          const shapesForSep = enabledPlots.filter((p: any) => (p.type === 'plot3d_shape' || p.type === 'plot3d_label') && p.pane !== '3d');
          show3D(sep3D, shapesForSep, bars.length);
        } else {
          hide3D();
          const lctx = lowerCanvas.getContext('2d');
          if (lctx) {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const rect = lowerCanvas.getBoundingClientRect();
            lowerCanvas.width = Math.round(rect.width * dpr);
            lowerCanvas.height = Math.round(rect.height * dpr);
            lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            lctx.clearRect(0, 0, rect.width, rect.height);
            const separatePlots = enabledPlots.filter((p:any) => p.pane === 'separate' && p.type !== 'plot3d');
            if (separatePlots.length > 0 && bars.length > 0) {
              try { drawSecondaryChart(lctx as any, separatePlots as any, bars, { ...view, barSpacing: 6 }); } catch {
                lctx.fillStyle = 'rgba(10,10,20,0.3)';
                lctx.fillRect(0, 0, rect.width, rect.height);
                lctx.fillStyle = 'rgba(180,140,255,0.5)';
                lctx.font = '10px monospace';
                lctx.textAlign = 'center';
                lctx.fillText(`${separatePlots.length} lower plots`, rect.width/2, rect.height/2);
              }
            } else if (sep3D.length === 0) {
              lctx.fillStyle = 'rgba(8,8,20,0.5)';
              lctx.fillRect(0, 0, rect.width, rect.height);
              if (enabledPlots.length === 0) {
                lctx.fillStyle = 'rgba(255,255,255,0.2)';
                lctx.font = '10px sans-serif';
                lctx.textAlign = 'center';
                lctx.fillText('No lower indicators — enable one with pane="separate"', rect.width/2, rect.height/2);
              } else {
                lctx.fillStyle = 'rgba(255,255,255,0.25)';
                lctx.font = '10px sans-serif';
                lctx.textAlign = 'center';
                lctx.fillText('Main chart indicators active — lower shows separate pane', rect.width/2, rect.height/2);
              }
            }
          }
        }
      }
    } catch {}

    if (state.crosshair) {
      drawCrosshair(ctx, state.crosshair.x, state.crosshair.y);
      drawOHLCTooltip(ctx, bars, view, state.crosshair.x, state.crosshair.y, state.barType);
    }

    // ── Dashboard band ──
    // The Universal Metrics Adapter pulls every active script's metric set
    // and renders the adaptive band between the chart and lower pane. Readouts
    // NEVER render free-floating on the canvas — this band is their exclusive
    // home, adapting its layout to whatever the scripts produce.
    renderDashboardWindow();

    rafId = requestAnimationFrame(draw);
  }

  function toCanvasXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  const touch = new TouchEngine(canvas, {
    onTouchDown: (x, y, count) => {
      drawGesture = null;
      if (!drawMode || drawTool === 'none') return;
      if (count === 1) {
        const c = toCanvasXY(x, y);
        drawGesture = { sx: c.x, sy: c.y, cx: c.x, cy: c.y, moved: false };
      }
      refreshGhost();
    },
    onPan: (dx, dy) => {
      if (drawGesture) return;
      state.crosshair = null;
      markViewUserTouched();
      const s = state.view.barSpacing;
      state.view.scrollX = Math.max(0, state.view.scrollX + dx / s);
      state.view.offsetY += dy;
    },
    onPanEnd: (vx, vy) => {
      if (drawGesture) { finishDrawGesture(); return; }
      momentum.vx = vx;
      momentum.vy = vy;
    },
    onPinch: (scale, _cx, _cy) => {
      markViewUserTouched();
      const s = Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, state.view.barSpacing * scale));
      state.view.barSpacing = s;
      state.view.scaleY = Math.min(4, Math.max(0.3, state.view.scaleY * (1 + (scale - 1) * 0.4)));
    },
    onMove: (x, y) => {
      if (drawGesture) {
        const c = toCanvasXY(x, y);
        drawGesture.cx = c.x;
        drawGesture.cy = c.y;
        drawGesture.moved = true;
        refreshGhost();
        return;
      }
      if (state.crosshair) state.crosshair = toCanvasXY(x, y);
    },
    onMoveEnd: () => { },
    onTap: (x, y) => {
      if (drawMode && drawTool !== 'none') {
        drawGesture = null;
        const c = toCanvasXY(x, y);
        addDrawPoint(screenPoint(c.x, c.y));
        return;
      }
      state.crosshair = null;
    },
    onDoubleTap: (x, y) => {
      // A double tap is the second tap of a two-point tool. For one-point tools
      // the first tap already placed the point, so the second is ignored.
      if (drawMode && drawTool !== 'none') {
        drawGesture = null;
        if (TOOL_POINTS[drawTool] > 1) {
          const c = toCanvasXY(x, y);
          addDrawPoint(screenPoint(c.x, c.y));
        }
        return;
      }
      viewIsFromUser = false;
      state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
    },
    onLongPress: (x, y) => {
      drawGesture = null;
      refreshGhost();
      state.crosshair = toCanvasXY(x, y);
    },
  });

  // ── Desktop input (mouse + wheel) ─────────────────────────────────
  // The app was built touch-first; embedded in the website demo (desktop
  // browsers) it needs the same gestures with a mouse: drag = pan, wheel =
  // zoom, double-click = reset view, hover = crosshair.
  let mouseDown = false;
  let lastMX = 0;
  let lastMY = 0;
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    markViewUserTouched();
    state.crosshair = null;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    state.view.barSpacing = Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, state.view.barSpacing * factor));
    state.view.scaleY = Math.min(4, Math.max(0.3, state.view.scaleY * (e.deltaY > 0 ? 0.97 : 1.03)));
  }, { passive: false });
  canvas.addEventListener('mousedown', (e) => {
    mouseDown = true;
    lastMX = e.clientX;
    lastMY = e.clientY;
    state.crosshair = null;
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('mousemove', (e) => {
    const { x, y } = toCanvasXY(e.clientX, e.clientY);
    if (mouseDown) {
      markViewUserTouched();
      const dx = e.clientX - lastMX;
      const dy = e.clientY - lastMY;
      state.view.scrollX = Math.max(0, state.view.scrollX + dx / state.view.barSpacing);
      state.view.offsetY += dy;
      lastMX = e.clientX;
      lastMY = e.clientY;
    } else {
      state.crosshair = { x, y };
    }
  });
  canvas.addEventListener('mouseup', () => {
    mouseDown = false;
    canvas.style.cursor = '';
  });
  canvas.addEventListener('mouseleave', () => {
    mouseDown = false;
    canvas.style.cursor = '';
    state.crosshair = null;
  });
  canvas.addEventListener('dblclick', () => {
    viewIsFromUser = false;
    state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
    momentum = { vx: 0, vy: 0 };
  });

  // Observe BOTH the container and the canvas itself — the canvas resizes
  // whenever the dashboard band appears/disappears (flex reflow), not just
  // when the container does.
  const resizeObserver = new ResizeObserver(() => sizeCanvas());
  resizeObserver.observe(container);
  resizeObserver.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      lastTs = 0;
      rafId = requestAnimationFrame(draw);
    }
  });

  void loadBars();
  sizeCanvas();
  // Register the mobile lower-pane wrapper so three-lower-pane's GL canvas
  // mounts there (web anchors on #chart-container/#secondary-canvas which
  // don't exist on mobile).
  const lowerHost = document.getElementById('mobile-lower-canvas')?.parentElement ?? null;
  setLowerPaneHost(lowerHost);
  // ISO-COMPOSITE overlay host: the GL canvas mounts in the SAME container
  // as the iso chart canvas, so the overlay rect tracks the chart exactly.
  setIsoCompositeHost(() => canvas.parentElement);
  rafId = requestAnimationFrame(draw);

  return {
    canvas,
    container,
    loadSymbol,
    setTimeframe,
    setBarType,
    setVpEnabled,
    setLive,
    set3D,
    setDrawMode,
    isDrawMode: () => drawMode,
    setWidgetHidden,
    reload: () => { void loadBars(); }, // Settings feed switches call this
    resetView: () => {
      // Pure view reset — pan/zoom/scale back to the default framing.
      // Never touches indicators, orders, or positions.
      viewIsFromUser = false;
      state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
      momentum = { vx: 0, vy: 0 };
    },
    refreshIndicators: () => { runIndicators(); },
    dispose: () => {
      disposed = true;
      engineLive.stop();
      if (indicatorsRunTimer) { clearTimeout(indicatorsRunTimer); indicatorsRunTimer = null; }
      cancelAnimationFrame(rafId);
      if (liveTimer) clearInterval(liveTimer);
      touch.detach();
      resizeObserver.disconnect();
      setIsoCompositeHost(null);
      try { dispose3DScene(); } catch { /* not initialized */ }
      try { hide3D(); } catch { /* not initialized */ }
      setLowerPaneHost(null);
      canvas.remove();
      drawBar.remove();
      regimeStrip.el.remove();
    },
  };
}
