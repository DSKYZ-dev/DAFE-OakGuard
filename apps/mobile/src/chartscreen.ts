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
  let lastIndicatorRun = 0;
  let disposed = false;

  let perBarVols: PerBarVolume[] = [];
  let vpCache: { key: string; computed: VPComputed } | null = null;
  let formingBar: BaseBar | null = null;

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
    const preferred = getDataSourceForSymbol(state.symbol);
    // Auto-switch: futures → polygon/massive, crypto → binance (tick via relay), fallback Yahoo
    // console.log(`[adapter] ${state.symbol} → ${preferred}`);
    // 1) Massive (paid) — direct from the phone when an API key is configured.
    //    Real tick-derived bars, all timeframes including 1s/5s/10s/30s.
    if (state.massiveApiKey?.trim()) {
      const massive = await fetchMassiveBars(state.symbol, tf);
      if (massive && massive.length > 0) {
        data = massive;
        provider = 'massive';
      }
    }
    // 2) Backend (optional) — same PC server chain when reachable.
    if (!data && state.backendMode !== 'offline') {
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
    if (provider === 'backend' || provider === 'yahoo' || provider === 'massive') cacheBars(state.symbol, tf, data);
    cb.onDataSource(provider);
    state.bars = data;
    rebuildTransformed();
    state.view = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
    runIndicators();
    notifyPrice();
    cb.onEngineBars(data);
    persistSettings();
  }

  function loadSymbol(symbol: string, tf?: Timeframe): void {
    state.symbol = symbol;
    if (tf) state.timeframe = tf;
    syncMarkersForSymbol(symbol);
    void loadBars();
  }

  function setTimeframe(tf: Timeframe): void {
    state.timeframe = tf;
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

  function tickLive(): void {
    const src = state.bars;
    if (src.length === 0) return;
    const last = src[src.length - 1];
    const now = Date.now();
    const intervalMs = TIMEFRAME_MS[state.timeframe];
    const syntheticFeed = state.dataProvider === 'synthetic';

    // Completed-bar boundary: roll a new bar seeded from the last close.
    if (syntheticFeed && now - last.timestamp >= intervalMs) {
      const prevClose = last.close;
      const price = prevClose + (Math.random() - 0.48) * prevClose * 0.008;
      const nb: BaseBar = {
        timestamp: Math.floor(now / intervalMs) * intervalMs,
        open: Math.round(price * 100) / 100,
        high: Math.round(Math.max(price, prevClose) * 100) / 100,
        low: Math.round(Math.min(price, prevClose) * 100) / 100,
        close: Math.round(price * 100) / 100,
        volume: Math.round(100 + Math.random() * 5000),
      };
      src.push(nb);
    } else if (!syntheticFeed && formingBar && now - formingBar.timestamp >= intervalMs) {
      const previous = formingBar;
      formingBar = {
        ...previous,
        timestamp: previous.timestamp + intervalMs,
        open: previous.close,
        high: previous.close,
        low: previous.close,
        close: previous.close,
        volume: 0,
      };
      src.push(formingBar);
    } else if (syntheticFeed) {
      // Synthetic feed: the generator's bars are simulated anyway — extend in place.
      const volatility = last.close * 0.0003;
      const change = (Math.random() - 0.5) * volatility * 2;
      last.close = Math.max(0.01, last.close + change);
      if (last.close > last.high) last.high = last.close;
      if (last.close < last.low) last.low = last.close;
      last.volume += Math.round(Math.abs(change * 10000) + Math.random() * 50);
    } else {
      // Real feed (Yahoo/Massive/backend): NEVER rewrite completed OHLC history.
      // Maintain a separate forming bar appended after the fetched data.
      if (!formingBar) {
        formingBar = { ...last, timestamp: Math.floor(now / intervalMs) * intervalMs };
      }
      const volatility = formingBar.close * 0.0003;
      const change = (Math.random() - 0.5) * volatility * 2;
      formingBar.close = Math.max(0.01, formingBar.close + change);
      if (formingBar.close > formingBar.high) formingBar.high = formingBar.close;
      if (formingBar.close < formingBar.low) formingBar.low = formingBar.close;
      formingBar.volume += Math.round(Math.abs(change * 10000) + Math.random() * 50);
      if (src[src.length - 1] !== formingBar) src.push(formingBar);
    }
    const priceRef = syntheticFeed ? last.close : (formingBar ? formingBar.close : last.close);
    rebuildTransformed();
    if (performance.now() - lastIndicatorRun > 800) runIndicators();
    loadBroker().tick(state.symbol, priceRef, now);
    cb.onEngineTick(priceRef, now);
    notifyPrice();
  }

  function setLive(on: boolean): void {
    state.liveEnabled = on;
    if (on) {
      liveTimer = setInterval(tickLive, 300);
    } else if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
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
      if (enabledPlots.length > 0) {
        drawOakScriptPlots(ctx, enabledPlots.filter((p: any) => p.type !== 'plot3d_shape' && p.type !== 'plot3d_label'), bars, view);
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
    if (enabledPlots.length > 0) drawOakScriptPlots(ctx, enabledPlots, bars, view);

    if (state.markers.length > 0) drawTradeMarkers(ctx, bars, view, state.markers);

    drawTimeAxis(ctx, bars, view, state.timeframe);

    // Lower panel — separate pane plots
    try {
      const lowerCanvas = document.getElementById('mobile-lower-canvas') as HTMLCanvasElement | null;
      if (lowerCanvas) {
        const lctx = lowerCanvas.getContext('2d');
        if (lctx) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const rect = lowerCanvas.getBoundingClientRect();
          lowerCanvas.width = Math.round(rect.width * dpr);
          lowerCanvas.height = Math.round(rect.height * dpr);
          lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          lctx.clearRect(0, 0, rect.width, rect.height);
          const separatePlots = enabledPlots.filter((p:any) => p.pane === 'separate');
          if (separatePlots.length > 0 && bars.length > 0) {
            try { drawSecondaryChart(lctx as any, separatePlots as any, bars, { ...view, barSpacing: 6 }); } catch {
              lctx.fillStyle = 'rgba(10,10,20,0.3)';
              lctx.fillRect(0, 0, rect.width, rect.height);
              lctx.fillStyle = 'rgba(180,140,255,0.5)';
              lctx.font = '10px monospace';
              lctx.textAlign = 'center';
              lctx.fillText(`${separatePlots.length} lower plots`, rect.width/2, rect.height/2);
            }
          } else {
            lctx.fillStyle = 'rgba(8,8,20,0.5)';
            lctx.fillRect(0, 0, rect.width, rect.height);
            if (enabledPlots.length === 0) {
              lctx.fillStyle = 'rgba(255,255,255,0.2)';
              lctx.font = '10px sans-serif';
              lctx.textAlign = 'center';
              lctx.fillText('No lower indicators — enable one with pane="separate"', rect.width/2, rect.height/2);
            } else if (separatePlots.length===0) {
              lctx.fillStyle = 'rgba(255,255,255,0.25)';
              lctx.font = '10px sans-serif';
              lctx.textAlign = 'center';
              lctx.fillText('Main chart indicators active — lower shows separate pane', rect.width/2, rect.height/2);
            }
          }
        }
      }
    } catch {}

    if (state.crosshair) {
      drawCrosshair(ctx, state.crosshair.x, state.crosshair.y);
      drawOHLCTooltip(ctx, bars, view, state.crosshair.x, state.crosshair.y, state.barType);
    }

    rafId = requestAnimationFrame(draw);
  }

  function toCanvasXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  const touch = new TouchEngine(canvas, {
    onPan: (dx, dy) => {
      state.crosshair = null;
      const s = state.view.barSpacing;
      state.view.scrollX = Math.max(0, state.view.scrollX + dx / s);
      state.view.offsetY += dy;
    },
    onPanEnd: (vx, vy) => {
      momentum.vx = vx;
      momentum.vy = vy;
    },
    onPinch: (scale, _cx, _cy) => {
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
    refreshIndicators: () => { runIndicators(); },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (liveTimer) clearInterval(liveTimer);
      touch.detach();
      resizeObserver.disconnect();
      try { dispose3DScene(); } catch { /* not initialized */ }
      canvas.remove();
    },
  };
}