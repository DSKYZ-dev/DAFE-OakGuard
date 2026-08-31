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
import { parse, executeScript } from '../../web/src/oakscript';
import type { OakPlot3D } from '../../web/src/oakscript/runtime';
import { barsToRuntimeBarData } from '../../web/src/backtest/data';
import { draw3DScene } from '../../web/src/iso3d';
import { renderMain3DScene, mark3DSceneDirty, dispose3DScene, getRenderTime } from '../../web/src/three-indicators';
import { show3D, hide3D, setLowerPaneHost } from '../../web/src/three-lower-pane';
import { findBackend, fetchBackendBars } from './backend';
import { fetchMassiveBars } from './massive';
import { fetchYahooBars } from './yahoo';
import { getDataSourceForSymbol } from './data-adapter';
import { state, persistSettings, loadBroker, cacheBars, loadCachedBars, syncMarkersForSymbol, type DataProvider } from './state';
import { TouchEngine } from './touch';

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
  reload: () => void;
  resetView: () => void;
  refreshIndicators: () => void;
  dispose: () => void;
}

export function createChartScreen(container: HTMLDivElement, cb: ChartScreenCallbacks): ChartScreen {
  const canvas = document.createElement('canvas');
  canvas.id = 'chart-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  let rafId = 0;
  let lastTs = 0;
  let time = 0;
  let momentum = { vx: 0, vy: 0 };
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let lastSyntheticAt = 0;
  let lastIndicatorRun = 0;
  let disposed = false;

  let perBarVols: PerBarVolume[] = [];
  let vpCache: { key: string; computed: VPComputed } | null = null;

  // ── Dashboard Window (adaptive, its own panel) ──────────────────────
  // Sits between the main chart and the lower pane in DOM order (appended
  // to this container which ends above the splitter). Every indicator that
  // produces table()/label() readouts feeds it — content ADAPTS: sections
  // stack vertically, wrap horizontally, and scroll only as a last resort.
  // The ORIGINAL canvas-drawn dashboards are gone: table/label plots no
  // longer render on the chart canvas at all (see draw loop filter).
  // Each section has a header (indicator name) + power toggle so any
  // dashboard can be turned on/off per indicator; state persists.
  const dashWin = document.createElement('div');
  dashWin.id = 'dashboard-win';
  container.appendChild(dashWin);
  let dashLastRender = 0;
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
  function fmtVal(v: any): string {
    if (typeof v === 'number') {
      if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + 'K';
      return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
    }
    return String(v ?? '');
  }
  function renderDashboardWindow(plots: any[], indicators: { name: string }[]): void {
    const now = performance.now();
    if (now - dashLastRender < 900) return;
    dashLastRender = now;
    // Group dashboard-bearing plots by their OWNING indicator so each gets
    // its own section with its own toggle. Plots carry `__ind` (set in
    // runIndicators) identifying the parent indicator id/name.
    const byInd = new Map<string, { name: string; rows: { v: string; bg?: string; fg?: string }[] }>();
    for (const p of plots) {
      if (p.type !== 'table' || !Array.isArray(p.cells)) continue;
      const indName = (p as any).__ind || 'Indicator';
      if (!isDashOn(indName)) continue;
      let sec = byInd.get(indName);
      if (!sec) { sec = { name: indName, rows: [] }; byInd.set(indName, sec); }
      for (const row of p.cells as any[][]) {
        for (const cell of row) {
          if (cell == null || typeof cell !== 'object') continue;
          const txt = String(cell.text ?? '').trim();
          if (!txt) continue;
          const entry = { v: txt.slice(0, 40), bg: cell.bgColor || '', fg: cell.textColor || '' };
          if (!sec.rows.some(r => r.v === entry.v)) sec.rows.push(entry);
        }
      }
    }
    for (const p of plots) {
      if (p.type !== 'label' || typeof p.text !== 'string' || !p.text) continue;
      const indName = (p as any).__ind || 'Indicator';
      if (!isDashOn(indName)) continue;
      let sec = byInd.get(indName);
      if (!sec) { sec = { name: indName, rows: [] }; byInd.set(indName, sec); }
      sec.rows.push({ v: p.text.slice(0, 60) });
    }
    if (byInd.size === 0) {
      if (dashWin.childElementCount > 0) dashWin.replaceChildren();
      dashWin.style.display = 'none';
      return;
    }
    dashWin.style.display = 'block';
    // Rebuild only when the CONTENT SIGNATURE changes — not every frame.
    let sig = '';
    for (const [name, s] of byInd) sig += name + '|' + s.rows.map(r => r.v).join(';');
    if (sig === (dashWin as any).__sig) return;
    (dashWin as any).__sig = sig;
    dashWin.replaceChildren();
    for (const [name, sec] of byInd) {
      const card = document.createElement('div');
      card.className = 'dash-section';
      const head = document.createElement('div');
      head.className = 'dash-section-head';
      const nm = document.createElement('span');
      nm.className = 'dash-section-name';
      nm.textContent = name;
      // Power toggle — per-indicator dashboard on/off, persisted.
      const pw = document.createElement('button');
      pw.className = 'dash-power';
      pw.textContent = '⏻';
      pw.title = `Toggle ${name} dashboard`;
      pw.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDash(name);
        // Rebuild from the LIVE plot set (other indicators may still have
        // dashboard content) — not from empty arrays.
        (dashWin as any).__sig = '';
        dashLastRender = 0;
        const livePlots = state.indicators.filter((i) => i.enabled).flatMap((i) => i.plots);
        renderDashboardWindow(livePlots, state.indicators);
      });
      head.appendChild(nm);
      head.appendChild(pw);
      card.appendChild(head);
      const body = document.createElement('div');
      body.className = 'dash-section-body';
      for (const r of sec.rows.slice(0, 16)) {
        const chip = document.createElement('div');
        chip.className = 'dash-chip';
        chip.textContent = r.v;
        chip.title = `${name}: ${r.v}`;
        if (r.bg) chip.style.background = r.bg;
        if (r.fg) chip.style.color = r.fg;
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
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
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
    // Auto-refresh calls this too — caller sets viewIsFromUser accordingly.
    const tf = state.timeframe;
    const count = tf.startsWith('1') || tf.startsWith('5') || tf.startsWith('10') || tf.startsWith('30') ? 480 : 320;
    let data: BaseBar[] | null = null;
    let provider: DataProvider = 'synthetic';
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
    state.is3D = on;
    if (!on) {
      // Tearing down 3D: drop the GL overlay so the 2D canvas is clean again.
      gen3DDisabled = false;
      try { dispose3DScene(); } catch { /* not initialized */ }
    } else {
      // Re-entering 3D resets the fallback latch so a previously slow device
      // gets a fresh try (e.g. after the user lowered performance mode).
      gen3DDisabled = false;
      warned3D = false;
      slowFrames = 0;
      renderSamples = 0;
      renderSampleSum = 0;
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
        ind.errors = result.errors;
        // Tag every plot with its OWNING indicator so the dashboard window
        // can group sections and offer per-indicator on/off toggles.
        for (const p of ind.plots) (p as any).__ind = ind.name;
        if (result.errors && result.errors.length > 0) {
          (window as any).__dafeEditorChat?.('error', `[${ind.name}] ${result.errors.join(' | ').slice(0, 600)}`);
        }
      } catch (err) {
        ind.plots = [];
        ind.errors = [err instanceof Error ? err.message : String(err)];
        (window as any).__dafeEditorChat?.('error', `[${ind.name}] ${ind.errors[0].slice(0, 600)}`);
      }
    }
    lastIndicatorRun = performance.now();
    mark3DSceneDirty();
  }


  function setLive(on: boolean): void {
    // Live tick simulation is REMOVED — synthetic random-walk corrupted real
    // data. setLive now drives a REAL-feed auto-refresher instead: while the
    // chart is visible it re-fetches from the live provider on a fixed cadence
    // (real prices, real weekends — closed markets simply show no new bars).
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
        void loadBars();
      }, 60_000);
    }
  }
  // Real-feed auto-refresh is always on (60s cadence, paused while hidden
  // or on synthetic data). The user never manages a play/pause again.
  setLive(true);

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
    // Clamp vertical pan/fling inside a sane band so candles can't be flung
    // fully off-canvas (the "bars flattened out / went invisible" symptom when
    // a fling carried offsetY to an extreme).
    state.view.offsetY = Math.max(-h * 2, Math.min(h * 2, state.view.offsetY));

    if (state.is3D) {
      const enabledPlots = state.indicators.filter((i) => i.enabled).flatMap((i) => i.plots);
      const pl3d = enabledPlots.filter((p: any) => p.type === 'plot3d') as OakPlot3D[];
      const shape3d = enabledPlots.filter((p: any) => p.type === 'plot3d_shape' || p.type === 'plot3d_label');
      const canWebGL = detectWebGL();

      // Genuine Three.js rendering is the DEFAULT when plot3d indicators are
      // present. We only drop to the iso-2D proxy when the device genuinely
      // can't sustain it (WebGL absent / context failure / sustained low fps).
      if (pl3d.length > 0 && canWebGL && !gen3DDisabled) {
        try {
          drawBackground(ctx, time);
          renderMain3DScene(bars, pl3d, view, w, h, shape3d);
          if (!recordRendererMs(getRenderTime())) {
            gen3DDisabled = true;
            dispose3DScene();
            show3DFallbackWarning('Sustained frame rate below ~18fps while rendering 3D indicators.');
          } else {
            drawTimeAxis(ctx, bars, view, state.timeframe);
            rafId = requestAnimationFrame(draw);
            return;
          }
        } catch {
          gen3DDisabled = true;
          try { dispose3DScene(); } catch { /* already disposed */ }
          show3DFallbackWarning('WebGL context could not be created for 3D indicators.');
        }
      }

      // ── Iso-3D candle scene (non-plot3d 3D mode) or fallback path ──
      drawBackground(ctx, time);
      let vp: ReturnType<typeof computeVolumeProfileBins> | undefined;
      if (state.vpEnabled && bars.length > 0) {
        const { start, end } = getVisibleRange(view, w, bars.length);
        const slice = bars.slice(start, end);
        if (slice.length > 0) vp = computeVolumeProfileBins(slice, { ...DEFAULT_VP_SETTINGS });
      }
      draw3DScene(ctx, bars, view, {
        barType: state.barType,
        perBarVols: state.vpEnabled ? perBarVols : undefined,
        volumeBins: vp?.bins,
        // Mobile 3D uses the isometric candle scene; the 2D profile mode
        // prevents the VP voxel layer from covering every candle.
        volumeMode: MOBILE_VP_SETTINGS.mode as VolumeProfileMode,
        visualEngine: DEFAULT_VP_SETTINGS.visualEngine,
        volumeEnabled: false,
        vpiEnabled: state.vpEnabled,
        time,
        profileWidth: state.vpWidth,
        vpComputed: vp,
        bgViz: 'stars',
        plots: enabledPlots,
      });
      // Ordinary 2D plots stay visible as an overlay; plot3d series are shown
      // as a 2D proxy so their DATA is still visible even when GL is off.
      // table/label (dashboard readouts) NEVER draw on canvas — they render
      // exclusively in the dashboard window below the chart.
      if (enabledPlots.length > 0) {
        drawOakScriptPlots(ctx, enabledPlots.filter((p: any) => p.type !== 'plot3d_shape' && p.type !== 'plot3d_label' && p.type !== 'table' && p.type !== 'label'), bars, view);
      }
      rafId = requestAnimationFrame(draw);
      return;
    }

    drawBackground(ctx, time);
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

    const enabledPlots = state.indicators.filter((i) => i.enabled).flatMap((i) => i.plots);
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

    // ── Dashboard strip ──
    // Indicator table()/label() readouts render into a FIXED static strip
    // below the x-axis instead of free-floating on the canvas (where the OST
    // rail and buy/sell buttons used to cover them). Panel metrics adapt to
    // the strip, never the other way around.
    // table/label readouts render ONLY in the dashboard window below — never
    // free-floating on the canvas (the original dashboards are removed).
    renderDashboardWindow(enabledPlots.filter((p: any) => p.type === 'table' || p.type === 'label'), state.indicators);

    rafId = requestAnimationFrame(draw);
  }

  function toCanvasXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  const touch = new TouchEngine(canvas, {
    onPan: (dx, dy) => {
      state.crosshair = null;
      markViewUserTouched();
      const s = state.view.barSpacing;
      state.view.scrollX = Math.max(0, state.view.scrollX + dx / s);
      state.view.offsetY += dy;
    },
    onPanEnd: (vx, vy) => {
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
      if (state.crosshair) state.crosshair = toCanvasXY(x, y);
    },
    onMoveEnd: () => { },
    onTap: () => { state.crosshair = null; },
    onDoubleTap: () => {
      viewIsFromUser = false;
      state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
    },
    onLongPress: (x, y) => {
      state.crosshair = toCanvasXY(x, y);
    },
  });

  const resizeObserver = new ResizeObserver(() => sizeCanvas());
  resizeObserver.observe(container);

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
      cancelAnimationFrame(rafId);
      if (liveTimer) clearInterval(liveTimer);
      touch.detach();
      resizeObserver.disconnect();
      try { dispose3DScene(); } catch { /* not initialized */ }
      try { hide3D(); } catch { /* not initialized */ }
      setLowerPaneHost(null);
      canvas.remove();
    },
  };
}
