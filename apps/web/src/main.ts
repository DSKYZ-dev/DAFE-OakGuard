import type { BaseBar, VolumeBin, VolumeProfileMode } from '@dafe/types';
import {
  generateBars, generatePerBarVolumes, transformBars,
  type BarType, type Timeframe, type PerBarVolume,
} from './data-generator';
import {
  computeVolumeProfileBins, DEFAULT_VP_SETTINGS,
  type VPSettings, type VPComputed,
} from './volume-profile';
import {
  drawBackground, drawGrid, drawBars, drawTimeAxis,
  drawVolumeProfile, drawCrosshair, drawStatusBar,
  drawOHLCTooltip, drawOakScriptPlots,
  drawSecondaryChart, drawTradeMarkers,
  updateParticles, drawParticles,
  getVisibleRange, visibleBarCount,
  DEFAULT_BAR_SPACING, MIN_BAR_SPACING, MAX_BAR_SPACING, chartRight,
  setPerfMode,
  type ViewState, type TradeMarker,
} from './chart-renderer';
import {
  createEditor, toggleEditor, isEditorVisible,
  getIndicators, getCategories, type OakPlot,
  setSendErrorsCallback, setAgentActionCallback, setAgentChatCallback,
  setToggleVisibilityCallback, registerEditorShortcuts, getDefaultScript,
} from './oakscript';
import * as draw from './drawings';
import type { DrawTool } from './drawings';
import {
  TradeAdvisorAgent, VisualAdapter, WebSearch,
  initBridge,
  agentDiagnoseErrors, agentGenerateIndicatorPhased,
  agentBrainstormIndicator, agentAnalyzeMetrics,
  extractCodeBlocks, applyAgentCode, validateCurrentCode,
} from './trade-advisor';
import type { ChartSnapshot, IndicatorMetrics } from './trade-advisor/visual-adapter';
import { prefetchModelProfile, setModelContextOverride } from './trade-advisor/token-optimizer';
import { AdvisorVoice } from './trade-advisor/voice';
import { LiveDataStream } from './data-stream';
import { HybridDataEngine } from './data-stream/hybrid-engine';
import { getMarketStatus, marketStatusLabel } from './market-hours';
import { render3DViz, toggle3DViz, disposeViz, isViz3DActive, renderMain3DScene, isChart3DMode, mark3DSceneDirty, dispose3DScene } from './three-indicators';
import { show3D, hide3D } from './three-lower-pane';
import { draw3DScene } from './iso3d';
import type { OakPlot3D } from './oakscript/runtime';
import {
  initParticleSystem, updateGPUParticles, drawCPUParticles,
  resizeParticleField, setParticleCount, setParticleMode, setParticleIntensity,
} from './gpu-particles';
import { PerfGovernor, recommendInitialTier, tierParticleCount, type PerfTier } from './perf-governor';
import { createInputsPanel } from './age-inputs-panel';
import { createDashboard } from './dashboard-widget';
import { registerWidget, initWidgetMenu } from './widget-registry';
import { PaperBroker, describeCommission, describeSlippage, DEFAULT_COMMISSION, DEFAULT_SLIPPAGE } from './trading/paper-broker';
import type { CommissionConfig, SlippageMode, CommissionMode } from './trading/paper-broker';
import { detectCurrency } from './trading/currency';
import type { OrderType } from './trading/broker-port';
import {
  addIndicator, removeIndicator, getActiveInstances,
  runAllInstances, getCombinedPlots, hasActiveIndicators,
  setInstanceOverrides, setInstanceEnabled, updateInstanceSource,
  setInstanceDashboardVisible,
  type IndicatorInstance,
} from './indicator-manager';

// ─── URL-based hard reset ──────────────────────────────────────────
if (window.location.search.includes('reset=1')) {
  const keys = ['oakscript_source', 'oakscript_persist', 'oakscript_webhook', 'oakscript_overrides'];
  keys.forEach(k => localStorage.removeItem(k));
  window.location.replace(window.location.pathname);
}
// Clear stale saved source on version bump
const SAVED_SOURCE_VERSION = 'v2';
if (localStorage.getItem('oakscript_source_version') !== SAVED_SOURCE_VERSION) {
  localStorage.removeItem('oakscript_source');
  localStorage.removeItem('oakscript_persist');
  localStorage.setItem('oakscript_source_version', SAVED_SOURCE_VERSION);
}

// ─── State ─────────────────────────────────────────────────────────
let bars: BaseBar[] = generateBars(500, '1m');
let barType: BarType = 'candlestick';
let timeframe: Timeframe = '1m';
let transformed: BaseBar[] = bars;
let perBarVols: PerBarVolume[] = generatePerBarVolumes(bars, 12);

let view: ViewState = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
let vpSettings: VPSettings = { ...DEFAULT_VP_SETTINGS };
let volumeEnabled = true;
let is3DMode = true;
let mouseX = -1, mouseY = -1;
let mouseDown = false, lastMX = 0, lastMY = 0;
let showTooltip = false;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
let time = 0;
let vpiEnabled = true;
// Start from a device-appropriate tier; the governor adapts it live.
let perfMode: PerfTier = recommendInitialTier();
let perfAuto = true;                                  // auto-adapt unless user pins a tier
let bgViz: 'particles' | 'stars' | 'graph' | 'plain' = 'stars';

// Adaptive performance governor — measures FPS and retunes the quality tier.
// The GPU particle buffer is allocated at full size (cheap), so the governor
// can range the active count freely from low up to ultra.
const perfGovernor = new PerfGovernor({
  targetFps: 50,
  onChange: (tier, reason) => {
    perfMode = tier;
    setPerfMode(tier);
    setParticleCount(tierParticleCount(tier));
    const sel = document.getElementById('perf-select') as HTMLSelectElement | null;
    if (sel && perfAuto) sel.title = `Auto: ${tier} (${reason})`;
    console.log(`[DAFE] perf auto → ${tier} (${reason})`);
  },
}, perfMode);

// ─── Live Tick Simulator ──────────────────────────────────────────
let liveTicksEnabled = false;
let liveTickTimer: ReturnType<typeof setInterval> | null = null;
// Wall-clock time of the last bar roll — bars advance on real elapsed time, NOT
// on (now - lastBarTimestamp), which floods flat bars when the feed is delayed.
let lastBarRollTime = 0;

// Data source mode. 'hybrid' = correction-anchored blend of Massive (paid,
// sparse) + yfinance (free, frequent) + synthetic fill, for near-live accuracy
// at a fraction of the API cost.
let dataSourceMode: 'massive' | 'yahoo' | 'hybrid' = 'yahoo';
const hybridEngine = new HybridDataEngine({
  baseUrl: (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788',
});
// Tell the user when the blend adapts (e.g. yfinance doesn't cover the symbol,
// so we run on the paid stream alone at a reduced request rate).
hybridEngine.onCoverageChange = (st) => {
  if (st.mode === 'paid-only') {
    appendAdvisorMessage('system',
      `${currentSymbol}: not covered by Yahoo — switched to paid stream only (reduced ~20s polling + synthetic fill).`);
  } else if (st.mode === 'blend') {
    appendAdvisorMessage('system', `${currentSymbol}: Yahoo coverage restored — full hybrid blend resumed.`);
  } else {
    appendAdvisorMessage('system', `${currentSymbol}: no live provider — pure synthetic mode.`);
  }
};

const TIMEFRAMES_SEC: Record<Timeframe, number> = {
  '1s': 1, '5s': 5, '10s': 10, '30s': 30,
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

// Sub-minute bars only exist on a real second-resolution feed — populated from
// /api/market-data/providers once at load, used to grey out the tf-select
// options the current data source can't actually serve.
let supportedSubMinuteTfs: Set<string> = new Set();

function startLiveTicks(): void {
  if (liveTickTimer) return;
  const status = getMarketStatus(currentSymbol);
  if (status === 'closed') {
    appendAdvisorMessage('system', `Live ticks disabled — ${marketStatusLabel(status)} for ${currentSymbol}`);
    return;
  }
  liveTicksEnabled = true;

  // Hybrid mode: calibrate + start the correction-anchored engine so the
  // synthesized ticks track real prices (corrected by free/paid quotes).
  const useHybrid = dataSourceMode === 'hybrid' && transformed.length > 1;
  if (useHybrid) {
    hybridEngine.calibrate(transformed, TIMEFRAMES_SEC[timeframe]);
    hybridEngine.start(currentSymbol, transformed[transformed.length - 1].close);
  }
  lastBarRollTime = Date.now();

  const tickMs = 300;
  liveTickTimer = setInterval(() => {
    if (transformed.length === 0) return;
    // Periodically check if market closed — stop ticks
    if (Math.random() < 0.02) {
      if (getMarketStatus(currentSymbol) === 'closed') { stopLiveTicks(); updateUI(); return; }
    }
    const last = transformed[transformed.length - 1];
    const now = Date.now();
    const intervalMs = TIMEFRAMES_SEC[timeframe] * 1000;

    // Roll a new bar on REAL elapsed time (one per interval). Using wall-clock
    // here — not (now - last.timestamp) — prevents the flat-bar flood when the
    // upstream feed is delayed. We cap to a single roll per tick, and never
    // stamp a bar past real "now" — guards against runaway bars if the last
    // bar's timestamp is off (stale feed data, symbol/timeframe switch, tab
    // throttling causing missed rolls to pile up).
    const nextBarTs = last.timestamp + intervalMs;
    if (now - lastBarRollTime >= intervalMs && nextBarTs <= now) {
      lastBarRollTime = now;
      const newBar: BaseBar = {
        timestamp: nextBarTs,
        open: last.close, high: last.close, low: last.close, close: last.close, volume: 0,
      };
      transformed.push(newBar);
      bars.push({ ...newBar });
      // Extend the per-bar volume profile so the new bar gets the same VPI
      // voxel/extrusion treatment as historical bars. Without this the fresh
      // bar has no perBarVols entry and the 3D scene renders it as a plain
      // flat candle (looked like a stray 2D bar among the extruded ones).
      perBarVols.push(generatePerBarVolumes([newBar], 12)[0]);
      if (useHybrid && hybridEngine.isActive()) {
        // Re-anchor the new bar to the last close, but do NOT recalibrate from
        // synthetic-polluted bars — that creates a drift feedback loop. The
        // original real-bar calibration (from live-tick start) stays in effect.
        hybridEngine.start(currentSymbol, newBar.close);
      }
      // fall through so the fresh bar gets an immediate price move this tick
    }

    const live = transformed[transformed.length - 1];
    if (useHybrid && hybridEngine.isActive()) {
      // Correction-anchored synthesis: real quotes snap the price to truth.
      const price = hybridEngine.tick(now);
      const prev = live.close;
      live.close = Math.max(0.01, price);
      if (live.close > live.high) live.high = live.close;
      if (live.close < live.low) live.low = live.close;
      live.volume += Math.round(Math.abs((live.close - prev) * 10000) + Math.random() * 50);
    } else {
      // Plain synthetic tick (non-hybrid live mode).
      const volatility = live.close * 0.0003;
      const change = (Math.random() - 0.5) * volatility * 2;
      live.close = Math.max(0.01, live.close + change);
      if (live.close > live.high) live.high = live.close;
      if (live.close < live.low) live.low = live.close;
      live.volume += Math.round(Math.abs(change * 10000) + Math.random() * 50);
    }
    // Refresh the live bar's per-bar volume so its VPI voxels grow with it
    // (keeps the newest bar visually consistent with the extruded history).
    if (perBarVols.length === transformed.length) {
      perBarVols[perBarVols.length - 1] = generatePerBarVolumes([live], 12)[0];
    }
    // Keep the one-click trading panel (buy/sell/spread) in sync with the tick.
    updateTradingPanel();
  }, tickMs);
}

function stopLiveTicks(): void {
  if (liveTickTimer) { clearInterval(liveTickTimer); liveTickTimer = null; }
  hybridEngine.stop();
  liveTicksEnabled = false;
  // Reset so a later startLiveTicks() re-anchors cleanly rather than rolling
  // catch-up bars based on a stale wall-clock reference from before the switch.
  lastBarRollTime = 0;
}

// ─── Ollama model list (shared by both provider dropdowns) ────────
// Fetched once from /api/ollama/models; each dropdown shows only the slice
// matching its provider choice: "ollama" = local daemon tags, "ollama-cloud"
// = signed-in cloud tags. Without this split, cloud tags were mixed in with
// (and mistaken for) local models.
let ollamaModelCache: any[] = [];
let ollamaModelsError = '';
// Remember the last selection per dropdown per kind, so flipping a provider
// between Ollama Local and Ollama Cloud (and back) doesn't silently reset a
// previously chosen model to the first option in the list.
const ollamaChoiceMemory: Record<string, string> = {};

function ollamaKindFor(provider: string): 'local' | 'cloud' {
  return provider === 'ollama-cloud' ? 'cloud' : 'local';
}

function fillOllamaDropdown(ddId: string, kind: 'local' | 'cloud'): void {
  const dd = document.getElementById(ddId) as HTMLSelectElement | null;
  if (!dd) return;
  const prev = dd.value;
  if (prev) {
    const prevModel = ollamaModelCache.find(m => m.name === prev);
    if (prevModel) ollamaChoiceMemory[`${ddId}:${prevModel.cloud ? 'cloud' : 'local'}`] = prev;
  }
  dd.innerHTML = '';
  const models = ollamaModelCache.filter(m => (kind === 'cloud') === !!m.cloud);
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = ollamaModelsError || (kind === 'cloud'
      ? 'No cloud models — run `ollama signin`, then pull a *-cloud model'
      : 'No local Ollama models — run `ollama pull <model>`');
    dd.appendChild(opt);
    return;
  }
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.name;
    const parts: string[] = [m.name];
    if (m.parameter_size) parts.push(m.parameter_size);
    if (m.cloud) parts.push('cloud');
    else if (m.size_gb) parts.push(`${m.size_gb}GB`);
    const ctx = m.context_length;
    if (ctx) parts.push(ctx >= 1024 ? `${Math.round(ctx / 1024)}k ctx` : `${ctx} ctx`);
    opt.textContent = parts.join(' · ');
    dd.appendChild(opt);
  }
  const want = (prev && models.some(m => m.name === prev))
    ? prev : ollamaChoiceMemory[`${ddId}:${kind}`];
  if (want && Array.from(dd.options).some(o => o.value === want)) dd.value = want;
}

// Toggle the coder model fields based on provider (local select vs Ollama dropdown).
function applyCoderProviderUI(provider: string): void {
  const isOllama = provider.startsWith('ollama');
  const localRow = document.getElementById('coder-model-local-row');
  const cloudRow = document.getElementById('coder-model-cloud-row');
  if (localRow) localRow.style.display = isOllama ? 'none' : '';
  if (cloudRow) cloudRow.style.display = isOllama ? '' : 'none';
  if (isOllama) fillOllamaDropdown('set-coder-model-cloud', ollamaKindFor(provider));
}

// Toggle the advisor model fields + local-only controls based on provider.
function applyAdvisorProviderUI(provider: string): void {
  const isOllama = provider.startsWith('ollama');
  const localRow = document.getElementById('advisor-model-local-row');
  const cloudRow = document.getElementById('advisor-model-cloud-row');
  if (localRow) localRow.style.display = isOllama ? 'none' : '';
  if (cloudRow) cloudRow.style.display = isOllama ? '' : 'none';
  if (isOllama) fillOllamaDropdown('set-advisor-model-cloud', ollamaKindFor(provider));
  // Hot-reload button is always available so the user can switch/hot-load a
  // model regardless of provider. Only the hardware readout is local-specific.
  const switchBtn = document.getElementById('set-switch-model');
  const hwInfo = document.getElementById('set-hardware-info');
  if (switchBtn) switchBtn.style.display = '';
  if (hwInfo) hwInfo.style.display = isOllama ? 'none' : '';
}

// Sync the advisor agent with the configured LLM at startup — the settings
// panel does this too, but only when opened. Without this, a page load with
// an Ollama provider left the agent budgeting tokens against the default
// local model name until the user happened to open Settings.
async function syncLlmConfigFromSettings(): Promise<void> {
  try {
    const data = await (await fetch(`${BACKEND_URL}/api/settings`)).json();
    const advisorProv = data.llm_provider || 'local';
    const coderProv = data.llm_coder_provider || 'local';
    if (advisorProv.startsWith('ollama') || coderProv.startsWith('ollama')) {
      try {
        const om = await (await fetch(`${BACKEND_URL}/api/ollama/models`)).json();
        if (om.ok && om.models) {
          ollamaModelCache = om.models;
          for (const m of om.models) {
            if (m.name && m.context_length) setModelContextOverride(m.name, m.context_length);
          }
        }
      } catch { /* daemon offline — overrides just stay unregistered */ }
    }
    const model = data.llm_trade_advisor_model;
    if (model && model !== 'auto') advisor.config.model = model;
  } catch { /* backend offline — defaults stand */ }
}

// Switch data-source mode. Hybrid detects the paid feed and, if live ticks are
// already running, restarts them so the correction-anchored engine takes over.
function applyDataSourceMode(mode: string): void {
  if (mode !== 'massive' && mode !== 'yahoo' && mode !== 'hybrid') return;
  dataSourceMode = mode;
  if (mode === 'hybrid') {
    hybridEngine.detectProviders().then(({ massive }) => {
      appendAdvisorMessage('system',
        `Hybrid data: ${massive ? 'Massive (paid anchors) + ' : ''}yfinance corrections + synthetic fill engaged.`);
    });
  }
  // Reflect the mode in the data status chip immediately.
  const statusEl = document.getElementById('data-status');
  if (statusEl && dataProviderLabel && dataProviderLabel !== 'synthetic') {
    statusEl.textContent = `${currentSymbol} (${mode === 'hybrid' ? `hybrid·${dataProviderLabel}` : dataProviderLabel})`;
  }
  if (liveTicksEnabled) { stopLiveTicks(); startLiveTicks(); }
}

// ─── Trade Advisor state ──────────────────────────────────────────
let currentSymbol = 'SPY';
let advisorOpen = false;
const advisor = new TradeAdvisorAgent({
  agentId: 'trade_advisor',
  agentName: 'Trade Advisor',
  agentIcon: '◆',
  model: 'meta-llama-3.1-8b-instruct',
});
const voice = new AdvisorVoice({
  onResult: (text: string) => {
    const input = document.getElementById('advisorInput') as HTMLInputElement;
    if (input) { input.value = text; }
    sendAdvisorMessage(text);
    advisorOpen = true;
    updateUI();
  },
  onStateChange: (state) => {
    const btn = document.getElementById('advisorVoice');
    if (btn) {
      btn.textContent = state === 'listening' ? '🎤...' : state === 'wake-waiting' ? '🎤?' : state === 'speaking' ? '🔊' : '🎤 Voice';
    }
  },
});
const visualAdapter = new VisualAdapter();
const webSearch = new WebSearch();
const liveStream = new LiveDataStream({ symbol: 'SPY', timeframe: '1h', barCount: 500 });

async function refreshProviderCapabilities(): Promise<void> {
  try {
    const providers = await liveStream.getProviders();
    const merged = new Set<string>();
    for (const p of providers as any[]) {
      for (const tf of (p.sub_minute_timeframes || p.subMinuteTimeframes || [])) merged.add(tf);
    }
    supportedSubMinuteTfs = merged;
    updateUI();
  } catch { /* leave sub-minute options greyed out on failure */ }
}
let lastChartSnapshot: any = null;
let advisorMessages: Array<{ role: string; content: string }> = [];
let advisorStreaming = false;
let dataProviderLabel = 'synthetic';

// ─── OakScript state ───────────────────────────────────────────────
let oakScriptEnabled = false;
let oakScriptErrors: string[] = [];
let osTextarea: HTMLTextAreaElement | null = null;

// Store the currently selected indicator ID for the inputs panel
let activeInputsId: string | null = null;

const inputsPanel = createInputsPanel((overrides) => {
  if (activeInputsId) {
    setInstanceOverrides(activeInputsId, overrides);
  }
  runAllIndicators();
  const activeInst = getActiveInstances().find(i => i.id === activeInputsId);
  inputsPanel.update(activeInst?.inputs || [], activeInst?.name);
  dashboard.refresh();
  buildIndicatorList();
});

const dashboard = createDashboard();

function getBarData() {
  return {
    close: transformed.map(b => b.close),
    open: transformed.map(b => b.open),
    high: transformed.map(b => b.high),
    low: transformed.map(b => b.low),
    volume: transformed.map(b => b.volume),
    time: transformed.map(b => b.timestamp),
  };
}

// A main-pane 3D indicator (pane="3d") takes over the whole chart, and a
// lower-pane 3D indicator (pane="separate" plot3d) takes over the lower
// pane — running two of either at once would double up that workload for
// no visual benefit (only one can be seen/orbited at a time anyway). Keep
// at most one of each: adding a new 3D-main or 3D-lower indicator evicts
// the previous one occupying that slot.
function enforceSingle3DPerPosition(newId: string): void {
  const all = getActiveInstances();
  const newInst = all.find(i => i.id === newId);
  if (!newInst) return;
  const has3D = (inst: IndicatorInstance, pane: '3d' | 'separate') =>
    inst.plots.some(p => p.type === 'plot3d' && (p as any).pane === pane);
  const newHasMain3D = has3D(newInst, '3d');
  const newHasLower3D = has3D(newInst, 'separate');
  if (!newHasMain3D && !newHasLower3D) return;
  for (const other of all) {
    if (other.id === newId) continue;
    if ((newHasMain3D && has3D(other, '3d')) || (newHasLower3D && has3D(other, 'separate'))) {
      removeIndicator(other.id);
    }
  }
}

// True while any active indicator has a main-pane (pane="3d") plot3d call —
// the unified 3D scene takes over the whole chart in this state.
function hasPane3DActive(): boolean {
  return hasActiveIndicators() && getCombinedPlots().plot3d.some(p => (p as any).pane === '3d');
}

function runAllIndicators(): void {
  runAllInstances(getBarData());
  oakScriptErrors = [];
  for (const inst of getActiveInstances()) {
    oakScriptErrors.push(...inst.errors);
  }
  // Invalidate 3D cache so the render frame rebuilds plot3d scenes
  oakPathKey = '';
  oakPathCache = null;
  buildIndicatorList();
  dashboard.refresh();
  // Show widgets only when indicators are active
  const active = getActiveInstances();
  if (active.length > 0) {
    dashboard.show();
    if (activeInputsId && active.find(i => i.id === activeInputsId)?.inputs.length) {
      inputsPanel.show();
    }
  }
}

// ─── Canvas ────────────────────────────────────────────────────────
const canvas = document.getElementById('chart-canvas') as HTMLCanvasElement;
const secCanvas = document.getElementById('secondary-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const secCtx = secCanvas.getContext('2d')!;
const SEC_HEIGHT = 120;
let lowerHeight = 220; // dynamic for 3D pane and resizable divider

function resize() {
  const w = window.innerWidth;
  const h = Math.max(100, window.innerHeight - lowerHeight);
  canvas.width = w;
  canvas.height = h;
  secCanvas.width = w;
  secCanvas.height = lowerHeight;
  const pane3D = document.getElementById('three-lower-scene');
  if (pane3D) pane3D.style.height = `${lowerHeight}px`;
  (window as any).__dafeLowerHeight = lowerHeight;
  const splitter = document.getElementById('chart-splitter');
  if (splitter) splitter.style.display = '';
}
resize();
window.addEventListener('resize', resize);

// ─── Regeneration ──────────────────────────────────────────────────
function regenerate() {
  if (dataProviderLabel !== 'synthetic') {
    loadLiveData(currentSymbol, timeframe);
    return;
  }
  const count = bars.length;
  bars = generateBars(count, timeframe, currentSymbol);
  transformed = transformBars(bars, barType);
  perBarVols = generatePerBarVolumes(transformed, 12);
  view.scrollX = 0;
  view.offsetY = 0;
  view.barSpacing = DEFAULT_BAR_SPACING;
  vpCacheKey = ''; vpCacheResult = null;
  oakPathKey = ''; oakPathCache = null;
  if (oakScriptEnabled) { runAllIndicators(); }
  updateTradingPanel();
}

// ─── Mouse ─────────────────────────────────────────────────────────
function getBarsThatFit(): number {
  return visibleBarCount(view, canvas.width);
}

canvas.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const oldBs = view.barSpacing;
  const right = chartRight(canvas.width);

  const { start, end } = getVisibleRange(view, canvas.width, bars.length);
  const vLen = end - start + 1;
  const localIdx = vLen - 1 - (right - e.clientX) / oldBs;
  const barUnderMouse = start + Math.round(localIdx);

  view.barSpacing *= e.deltaY > 0 ? 0.9 : 1.1;
  view.barSpacing = Math.max(MIN_BAR_SPACING, Math.min(MAX_BAR_SPACING, view.barSpacing));

  const newCount = visibleBarCount(view, canvas.width);
  const newLocalIdx = newCount - 1 - (right - e.clientX) / view.barSpacing;
  const newStart = Math.max(0, Math.min(bars.length - 1, barUnderMouse - Math.round(newLocalIdx)));
  const newEnd = newStart + newCount - 1;
  const maxScrollPast = -Math.floor(getBarsThatFit() * 0.8);
  view.scrollX = Math.max(maxScrollPast, bars.length - 1 - newEnd);

  visualAdapter.logAction('zoom', `Zoom ${e.deltaY > 0 ? 'out' : 'in'} to ${view.barSpacing.toFixed(1)}px`);
}, { passive: false });

let scaleYDragging = false;
canvas.addEventListener('mousedown', (e) => {
  if (draw.isDrawing() && !is3DMode) {
    draw.onClick(e.clientX, e.clientY, transformed, view, canvas.width, canvas.height);
    visualAdapter.logAction('draw', `Placed ${draw.getTool()} at (${e.clientX}, ${e.clientY})`);
    return;
  }
  if (e.clientX > chartRight(canvas.width)) {
    scaleYDragging = true;
    canvas.style.cursor = 'ns-resize';
    lastMY = e.clientY;
    return;
  }
  mouseDown = true; lastMX = e.clientX; lastMY = e.clientY;
});
canvas.addEventListener('mousemove', (e) => {
  mouseX = e.clientX; mouseY = e.clientY;
  // Show tooltip only after 2s of mouse stillness
  if (tooltipTimer) clearTimeout(tooltipTimer);
  showTooltip = false;
  tooltipTimer = setTimeout(() => { showTooltip = true; }, 2000);
  if (draw.isDrawing() && !is3DMode) {
    draw.onMove(e.clientX, e.clientY, transformed, view, canvas.width, canvas.height);
  }
  if (scaleYDragging) {
    const dy = e.clientY - lastMY;
    if (dy !== 0) {
      view.scaleY = Math.max(0.2, Math.min(5, view.scaleY - dy * 0.02));
      lastMY = e.clientY;
    }
    return;
  }
  if (mouseDown) {
    const dx = e.clientX - lastMX;
    const dy = e.clientY - lastMY;
    if (e.shiftKey) {
      view.offsetY += dy;
    } else {
      view.scrollX += dx / view.barSpacing;
      const maxScrollPast = -Math.floor(getBarsThatFit() * 0.8);
      view.scrollX = Math.max(maxScrollPast, Math.min(bars.length - 1, view.scrollX));
    }
    lastMX = e.clientX; lastMY = e.clientY;
  }
});
canvas.addEventListener('mouseup', () => {
  mouseDown = false;
  scaleYDragging = false;
  canvas.style.cursor = '';
  if (mouseX >= 0) {
    visualAdapter.logAction('mouse', `Clicked at bar near price area`);
  }
});
canvas.addEventListener('mouseleave', () => { mouseDown = false; scaleYDragging = false; canvas.style.cursor = ''; mouseX = -1; showTooltip = false; if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; } });

// ─── Keyboard ──────────────────────────────────────────────────────
window.addEventListener('keydown', (e: KeyboardEvent) => {
  const isNumpad = e.location === 3;

  // ── Numpad hotkeys (NumLock ON: "0"-"9", standard keys retained) ──
  if (isNumpad) {
    e.preventDefault();
    switch (e.key) {
      case '0': is3DMode = !is3DMode; visualAdapter.logAction('mode', `Switched to ${is3DMode ? '3D' : '2D'} mode`); updateUI(); break;
      case '1': document.getElementById('vp-settings-panel')?.classList.toggle('active'); visualAdapter.logAction('toggle', 'Volume profile'); break;
      case '2': e.preventDefault(); const vis = toggleEditor(); oakScriptEnabled = vis; visualAdapter.logAction('indicator', `OakScript ${vis ? 'opened' : 'closed'}`); updateUI(); break;
      case '3': view.scrollX = 0; view.barSpacing = DEFAULT_BAR_SPACING; view.offsetY = 0; visualAdapter.logAction('frame', 'Frame all'); break;
      case '4': setDrawTool(draw.getTool() === 'trend' ? 'none' : 'trend'); break;
      case '5': setDrawTool(draw.getTool() === 'hline' ? 'none' : 'hline'); break;
      case '6': setDrawTool(draw.getTool() === 'ray' ? 'none' : 'ray'); break;
      case '7': setDrawTool(draw.getTool() === 'rect' ? 'none' : 'rect'); break;
      case '8': setDrawTool(draw.getTool() === 'fib' ? 'none' : 'fib'); break;
      case '9': setDrawTool(draw.getTool() === 'channel' ? 'none' : 'channel'); break;
      case '+': setDrawTool(draw.getTool() === 'text' ? 'none' : 'text'); break;
      case '-': draw.undoDrawing(); break;
      case '*': draw.clearDrawings(); break;
      case '.': setDrawTool('none'); break;
    }
    return;
  }

  // ── Standard shortcuts (non-numpad) ──
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isEditorVisible()) {
    e.preventDefault();
    const ta = document.getElementById('os-textarea') as HTMLTextAreaElement;
    if (ta) runAllIndicators();
  }

  const typing = (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT';
  if (typing) return;
  if (e.key === 'Escape') { setDrawTool('none'); }
  if (e.key === 'Delete' || e.key === 'Backspace') { draw.undoDrawing(); }
});

function setDrawTool(t: DrawTool): void {
  draw.setTool(t);
  canvas.style.cursor = t === 'none' ? 'grab' : 'crosshair';
  document.querySelectorAll('.draw-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === t);
  });
  visualAdapter.logAction('draw-tool', t === 'none' ? 'Deselected drawing tool' : `Selected ${t} tool`);
}
(window as any).__setDrawTool = setDrawTool;

// ─── Live Data Loading ────────────────────────────────────────────
const loadLiveData = async function(symbol?: string, tf?: string): Promise<void> {
  const sym = (symbol || currentSymbol).toUpperCase().trim();
  const tfv = tf || timeframe;
  currentSymbol = sym;

  const statusEl = document.getElementById('data-status');
  if (statusEl) {
    statusEl.textContent = 'Loading...';
    statusEl.className = 'loading';
  }

  liveStream.setSymbol(sym);
  liveStream.setTimeframe(tfv);
  stopLiveTicks();

  try {
    const result = await liveStream.fetchBars();
    if (result && result.bars.length > 0) {
      bars = result.bars;
      dataProviderLabel = result.provider;
      transformed = transformBars(bars, barType);
      perBarVols = generatePerBarVolumes(transformed, 12);
      view.scrollX = 0;
      view.barSpacing = DEFAULT_BAR_SPACING;
      vpCacheKey = '';
      oakPathKey = '';
      if (oakScriptEnabled) runAllIndicators();

      if (statusEl) {
        statusEl.textContent = `${sym} (${dataSourceMode === 'hybrid' ? `hybrid·${result.provider}` : result.provider})`;
        statusEl.className = 'loaded';
      }

      updateUI();
      updateAdvisorContext();
      updateTradingPanel();
    } else {
      // Massive + yfinance both unavailable -> robust synthetic so the chart
      // is NEVER blank.
      useSyntheticData(sym, tfv as Timeframe);
      if (statusEl) {
        statusEl.textContent = `${sym} (synthetic)`;
        statusEl.className = 'error';
      }
    }
  } catch (err: any) {
    useSyntheticData(sym, tfv as Timeframe);
    if (statusEl) {
      statusEl.textContent = `${sym} (synthetic — ${err?.message || 'offline'})`;
      statusEl.className = 'error';
    }
  }
}

// Final fallback in the data chain: massive+yfinance -> yfinance -> THIS.
// Generates robust synthetic bars and fully refreshes render state so the
// chart always shows something, even with no backend / no network.
function useSyntheticData(sym: string, tfv: Timeframe): void {
  const count = bars.length >= 50 ? bars.length : 500;
  bars = generateBars(count, tfv, sym);
  dataProviderLabel = 'synthetic';
  transformed = transformBars(bars, barType);
  perBarVols = generatePerBarVolumes(transformed, 12);
  view.scrollX = 0;
  view.barSpacing = DEFAULT_BAR_SPACING;
  vpCacheKey = '';
  oakPathKey = '';
  if (oakScriptEnabled) runAllIndicators();
  updateUI();
  updateAdvisorContext();
  updateTradingPanel();
}

// ─── Advisor UI ────────────────────────────────────────────────────
let currentAdvisorAgent = 'trade_advisor';

function getCurrentModel(): string {
  return advisor.config.model || 'auto';
}

function updateAdvisorContext(): void {
  const symEl = document.getElementById('advisorSymbol');
  const tfEl = document.getElementById('advisorTf');
  const closeEl = document.getElementById('advisorClose');
  const barsEl = document.getElementById('advisorBars');
  if (symEl) symEl.textContent = currentSymbol;
  if (tfEl) tfEl.textContent = timeframe;
  if (barsEl) barsEl.textContent = String(transformed.length);
  if (closeEl && transformed.length > 0) {
    closeEl.textContent = `$${transformed[transformed.length - 1].close.toFixed(2)}`;
  }

  // Auto-inject chart context so advisor always knows what's on screen
  const snapshot = visualAdapter.getLastSnapshot() || captureChartSnapshot();
  const chartCtx = visualAdapter.buildChartContext(snapshot, 'auto', getCurrentModel());
  if (transformed.length > 0) {
    // Replace any previous context message to avoid spamming
    const lastMsg = advisorMessages[advisorMessages.length - 1];
    if (!lastMsg || lastMsg.role !== 'system-context' || lastMsg.content !== chartCtx) {
      // Only push if different from last context
      advisorMessages.push({ role: 'system-context', content: chartCtx });
    }
  }
}

function captureChartSnapshot(): ChartSnapshot {
  const errors: string[] = [];
  const metrics: IndicatorMetrics[] = getActiveInstances().map(inst => ({
    name: inst.name,
    category: inst.category || 'Custom',
    source: inst.source,
    values: inst.plots.filter(p => p.type === 'line' && typeof p.value === 'number').map(p => ({ name: p.name || 'value', value: p.value as number, color: p.color || '#b48cff' })),
    errors: inst.errors,
    inputs: inst.inputs.map((inp: any) => ({ name: inp.name, title: inp.title || inp.name, value: inp.default ?? inp.value ?? 0 })),
    barValues: [],
  }));
  for (const inst of getActiveInstances()) {
    for (const e of inst.errors) errors.push(typeof e === 'string' ? e : String(e));
  }
  const allPlots: OakPlot[] = [];
  for (const inst of getActiveInstances()) allPlots.push(...inst.plots);
  return visualAdapter.captureSnapshot(
    bars,
    transformed,
    barType,
    timeframe,
    currentSymbol,
    dataProviderLabel,
    allPlots,
    errors,
    {
      mode: is3DMode ? '3D' : '2D',
      zoom: view.barSpacing,
      scrollOffset: view.scrollX,
      visibleBars: visibleBarCount(view, canvas.width),
      volumeProfile: vpSettings.mode,
      volumeEngine: vpSettings.visualEngine,
      vpiEnabled,
      oaktScriptEnabled: oakScriptEnabled,
      drawingTool: draw.getTool(),
    },
    draw.count(),
    is3DMode,
    metrics,
  );
}

let snapshotFrameCount = 0;
function updateSnapshotEveryNthFrame(): void {
  snapshotFrameCount++;
  if (snapshotFrameCount % 60 === 0) {
    captureChartSnapshot();
  }
}

function appendAdvisorMessage(role: string, content: string, agentLabel?: string, thinking?: string): HTMLDivElement {
  const container = document.getElementById('advisorMessages');
  if (!container) { const d = document.createElement('div'); return d; }
  const div = document.createElement('div');
  div.className = 'advisor-msg ' + role;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.textContent = '📋';
  copyBtn.title = 'Copy message';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content).then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
    }).catch(() => {});
  });

  if (role === 'assistant' && agentLabel) {
    const badge = document.createElement('span');
    badge.className = 'agent-badge';
    badge.textContent = agentLabel;
    div.appendChild(badge);

    // Collapsible thinking section
    if (thinking) {
      const details = document.createElement('details');
      details.className = 'thinking-details';
      const summary = document.createElement('summary');
      summary.textContent = '💭 Chain of thought';
      details.appendChild(summary);
      const thinkDiv = document.createElement('div');
      thinkDiv.className = 'thinking-content';
      thinkDiv.textContent = thinking;
      details.appendChild(thinkDiv);
      div.appendChild(details);
    }

    const textSpan = document.createElement('span');
    textSpan.textContent = content;
    div.appendChild(textSpan);
    div.appendChild(copyBtn);
  } else {
    div.textContent = content;
    div.appendChild(copyBtn);
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function showAdvisorTyping(): HTMLDivElement {
  const container = document.getElementById('advisorMessages');
  if (!container) { const d = document.createElement('div'); return d; }
  const div = document.createElement('div');
  div.className = 'advisor-msg assistant';
  div.id = 'advisorTyping';
  const badge = document.createElement('span');
  badge.className = 'agent-badge';
  badge.textContent = 'Trade Advisor';
  div.appendChild(badge);
  const typing = document.createElement('div');
  typing.className = 'advisor-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  div.appendChild(typing);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function removeAdvisorTyping(): void {
  const el = document.getElementById('advisorTyping');
  if (el) el.remove();
}

async function sendAdvisorMessage(text?: string): Promise<void> {
  const input = document.getElementById('advisorInput') as HTMLTextAreaElement;
  const msg = (text || input?.value || '').trim();
  if (!msg || advisorStreaming) return;

  if (input) { input.value = ''; input.style.height = 'auto'; }
  document.getElementById('advisorSend')?.setAttribute('disabled', 'true');

  appendAdvisorMessage('user', msg);
  advisorMessages.push({ role: 'user', content: msg });
  advisorStreaming = true;
  const typingEl = showAdvisorTyping();

  try {
    const snapshot = visualAdapter.getLastSnapshot() || captureChartSnapshot();
    const chartCtx = visualAdapter.buildChartContext(snapshot, 'auto', 'auto');
    const enhancedMsg = `${msg}\n\n[Current Chart State]\n${chartCtx}`;

    const contextMessages = advisorMessages
      .filter(m => m.role !== 'system-context')
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content }));
    contextMessages.push({ role: 'user', content: enhancedMsg });

    const resp = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: currentAdvisorAgent,
        messages: contextMessages,
        message: enhancedMsg,
      }),
    });

    removeAdvisorTyping();
    const data = await resp.json();

    if (data.ok) {
      const reply = data.reply || '(empty response)';
      appendAdvisorMessage('assistant', reply, currentAdvisorAgent === 'trade_advisor' ? 'Trade Advisor' : currentAdvisorAgent === 'market_intel' ? 'Market Intel' : 'Strategy Tuner', data.thinking || undefined);
      advisorMessages.push({ role: 'assistant', content: reply });
      voice.speak(reply.slice(0, 300));

      // Detect OakScript code blocks in agent response and offer to apply
      const codeBlocks = extractCodeBlocks(reply);
      if (codeBlocks.length > 0 && osTextarea) {
        const desc = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
        applyAgentCode(codeBlocks[0], `From: "${desc}"`, 'create');
      }

      try { advisor.localMemory.store({ content: `User: ${msg}\nAgent: ${reply.slice(0, 500)}`, type: 'conversation', agent: currentAdvisorAgent, tags: ['chat'] }); } catch {}
    } else {
      appendAdvisorMessage('error', data.detail || 'Request failed');
    }
  } catch (err: any) {
    removeAdvisorTyping();
    appendAdvisorMessage('error', 'Connection error. Is the backend running on port 8788?');
  } finally {
    advisorStreaming = false;
    document.getElementById('advisorSend')?.removeAttribute('disabled');
    (document.getElementById('advisorInput') as HTMLTextAreaElement)?.focus();
  }
}

async function analyzeChart(): Promise<void> {
  if (advisorStreaming) return;
  appendAdvisorMessage('system', 'Analyzing chart with web search context...');
  advisorStreaming = true;
  const typingEl = showAdvisorTyping();

  try {
    const snapshot = visualAdapter.getLastSnapshot() || captureChartSnapshot();
    const chartCtx = visualAdapter.buildChartContext(snapshot, 'detailed', 'auto');
    const news = await webSearch.searchNews(currentSymbol);
    const earnings = await webSearch.searchEarnings(currentSymbol);

    const allResults = [...news, ...earnings];

    const searchContext = allResults.length > 0
      ? `\n\n[Web Search Results]\n${allResults.slice(0, 5).map(r => `- ${r.title} (${r.url})`).join('\n')}`
      : '';

    const msg = `Analyze ${currentSymbol} on the ${timeframe} chart (${barType}). Provide a concise market analysis including trend direction, key S/R levels, patterns, volume analysis, and risk assessment.${searchContext.length > 0 ? '\n\nRecent news:\n' + searchContext : ''}\n\n[Current Chart State]\n${chartCtx}`;

    removeAdvisorTyping();
    appendAdvisorMessage('user', `🔍 Analyze ${currentSymbol}`);
    advisorMessages.push({ role: 'user', content: msg });
    advisorStreaming = true;
    const typingEl2 = showAdvisorTyping();

    const resp = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: currentAdvisorAgent,
        messages: [{ role: 'user', content: msg }],
        message: msg,
      }),
    });

    removeAdvisorTyping();
    const data = await resp.json();
    if (data.ok) {
      const reply = data.reply || '(empty response)';
      appendAdvisorMessage('assistant', reply, 'Trade Advisor', data.thinking || undefined);
      advisorMessages.push({ role: 'assistant', content: reply });
    } else {
      appendAdvisorMessage('error', data.detail || 'Analysis failed');
    }
  } catch (err: any) {
    removeAdvisorTyping();
    appendAdvisorMessage('error', 'Analysis failed - is backend running?');
  } finally {
    advisorStreaming = false;
  }
}

// ─── UI Setup ──────────────────────────────────────────────────────
let indicatorListEl: HTMLDivElement | null = null;
function buildIndicatorList() {
  if (indicatorListEl) indicatorListEl.remove();
  const active = getActiveInstances();
  if (active.length === 0) return;

  indicatorListEl = document.createElement('div');
  indicatorListEl.id = 'indicator-list';
  Object.assign(indicatorListEl.style, {
    position: 'fixed', top: '12px', left: '12px', zIndex: '90',
    background: 'rgba(8, 8, 20, 0.85)', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '8px', padding: '8px 10px', backdropFilter: 'blur(12px)',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: '180px', maxWidth: '280px',
    fontSize: '11px', color: 'rgba(255,255,255,0.7)',
  });

  const title = document.createElement('div');
  Object.assign(title.style, {
    color: 'rgba(180,140,255,0.5)', fontSize: '9px', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
  });
  title.textContent = `Active Indicators (${active.length})`;
  indicatorListEl.appendChild(title);

  for (const inst of active) {
    const section = document.createElement('div');
    Object.assign(section.style, {
      borderTop: '1px solid rgba(180,140,255,0.08)',
      padding: '4px 0',
    });

    // Header row with name, settings, remove
    const item = document.createElement('div');
    Object.assign(item.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '2px 0', gap: '4px',
    });

    const label = document.createElement('span');
    label.textContent = inst.name;
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;';

    const settingsBtn = document.createElement('button');
    settingsBtn.textContent = '⚙';
    settingsBtn.title = 'Configure inputs';
    Object.assign(settingsBtn.style, {
      background: 'none', border: '1px solid rgba(180,140,255,0.2)',
      color: 'rgba(180,140,255,0.5)', cursor: 'pointer', borderRadius: '4px',
      width: '20px', height: '20px', fontSize: '10px', padding: '0',
    });
    settingsBtn.onclick = () => {
      activeInputsId = inst.id;
      inputsPanel.update(inst.inputs, inst.name);
      inputsPanel.show();
    };

    // Mandatory dashboard toggle — every script gets one, no opt-out for
    // authors: metrics stay on the chart but can be dropped from the
    // universal dashboard when unneeded.
    const dashBtn = document.createElement('button');
    dashBtn.textContent = '📊';
    const dashStyle = (on: boolean) => {
      dashBtn.title = on ? 'Shown on dashboard — click to hide its metrics'
                         : 'Hidden from dashboard — click to show its metrics';
      dashBtn.style.opacity = on ? '1' : '0.3';
      dashBtn.style.borderColor = on ? 'rgba(34,204,136,0.35)' : 'rgba(255,255,255,0.15)';
    };
    Object.assign(dashBtn.style, {
      background: 'none', border: '1px solid rgba(34,204,136,0.35)',
      cursor: 'pointer', borderRadius: '4px',
      width: '20px', height: '20px', fontSize: '9px', padding: '0',
    });
    dashStyle(inst.showInDashboard !== false);
    dashBtn.onclick = () => {
      const next = !(inst.showInDashboard !== false);
      setInstanceDashboardVisible(inst.id, next);
      dashStyle(next);
      dashboard.refresh();
    };

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Remove';
    Object.assign(closeBtn.style, {
      background: 'none', border: '1px solid rgba(255,68,119,0.2)',
      color: 'rgba(255,68,119,0.5)', cursor: 'pointer', borderRadius: '4px',
      width: '20px', height: '20px', fontSize: '10px', padding: '0',
    });
    closeBtn.onclick = () => {
      removeIndicator(inst.id);
      if (activeInputsId === inst.id) {
        activeInputsId = null;
        inputsPanel.hide();
      }
      // Re-evaluate 3D state after removal. The old check only tore down 3D
      // when EVERY indicator was gone, so removing just the one indicator
      // that owned the main-pane (pane="3d") or lower-pane 3D slot — while
      // OTHER indicators stayed active — left its Three.js scene/geometry
      // rendering forever with no owning indicator (reported as "removing
      // ChronoSphere left both ChronoSphere and Lorentzian's 3D active").
      if (!hasPane3DActive() && isChart3DMode()) {
        dispose3DScene();
      }
      const stillHasLowerPane3D = hasActiveIndicators()
        && getCombinedPlots().plot3d.some(p => (p as any).pane === 'separate');
      if (!stillHasLowerPane3D && isViz3DActive()) {
        hide3D();
        disposeViz();
      }
      if (getActiveInstances().length === 0) {
        oakScriptEnabled = false;
        inputsPanel.hide();
        dashboard.hide();
      }
      runAllIndicators();
      updateUI();
    };

    item.appendChild(label);
    item.appendChild(dashBtn);
    item.appendChild(settingsBtn);
    item.appendChild(closeBtn);
    section.appendChild(item);

    // Sub-plots (collapsed by default, shown as colored dots)
    if (inst.plots.length > 0) {
      const seen = new Set<string>();
      const names: Array<{ name: string; color: string; pane: string }> = [];
      for (const p of inst.plots) {
        const n = (p.name || '').trim();
        if (n && !seen.has(n)) {
          seen.add(n);
          names.push({ name: n, color: p.color || '#b48cff', pane: p.pane || 'main' });
        }
      }
      if (names.length > 0) {
        const sub = document.createElement('div');
        Object.assign(sub.style, {
          padding: '1px 0 2px 10px', fontSize: '9px',
          color: 'rgba(255,255,255,0.4)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        });
        sub.textContent = names.map(n => n.pane === 'separate' ? `${n.name}(osc)` : n.name).join(', ');
        section.appendChild(sub);
      }
    }

    // Error count
    if (inst.errors.length > 0) {
      const errDiv = document.createElement('div');
      errDiv.textContent = `⚠ ${inst.errors.length} error${inst.errors.length > 1 ? 's' : ''}`;
      errDiv.style.cssText = 'color:#ff4477;font-size:9px;padding:1px 0 0 10px;';
      section.appendChild(errDiv);
    }

    indicatorListEl.appendChild(section);
  }

  document.body.appendChild(indicatorListEl);
}

function updateUI() {
  const vpToggle = document.getElementById('vp-toggle');
  if (vpToggle) {
    vpToggle.classList.toggle('active', volumeEnabled);
    vpToggle.textContent = volumeEnabled ? `VP ${vpSettings.mode}` : 'VP Off';
  }
  const tb = document.getElementById('mode-toggle');
  if (tb) { tb.textContent = is3DMode ? '3D' : '2D'; tb.classList.toggle('active', is3DMode); }
  const bt = document.getElementById('bar-type-select') as HTMLSelectElement;
  if (bt) {
    bt.value = barType;
    // A 3D main-chart indicator renders its own bar geometry in the unified
    // Three.js scene — switching bar type mid-3D would mean rebuilding that
    // geometry from a different representation for no visual gain (the 3D
    // bars don't follow Heikin-Ashi/Renko/etc.), so lock it while active.
    const lock3D = hasPane3DActive();
    bt.disabled = lock3D;
    bt.title = lock3D ? 'Bar type is locked while a 3D main-chart indicator is active' : '';
  }
  const tfSelect = document.getElementById('tf-select') as HTMLSelectElement;
  if (tfSelect) {
    tfSelect.value = timeframe;
    for (const opt of Array.from(tfSelect.options)) {
      if (opt.dataset.subMinute !== 'true') continue;
      const supported = supportedSubMinuteTfs.has(opt.value);
      opt.disabled = !supported;
      opt.title = supported ? '' : 'Requires a provider with second-resolution data (e.g. Massive with an API key)';
    }
  }
  document.getElementById('os-status')?.classList.toggle('has-errors', oakScriptErrors.length > 0);
  document.getElementById('live-tick-toggle')?.classList.toggle('active', liveTicksEnabled);
  buildIndicatorList();
  syncVPSettingsPanel();
  updateAdvisorContext();
}

// ─── Volume Profile settings panel ─────────────────────────────────
function setupVPSettingsPanel() {
  const panel = document.getElementById('vp-settings-panel');
  const header = document.getElementById('vp-settings-header');
  const closeBtns = document.querySelectorAll('#vp-settings-close, #vp-settings-close-btn');
  if (!panel || !header) return;

  closeBtns.forEach((b) => b.addEventListener('click', () => panel.classList.remove('active')));

  // ── Draggable like the editor ─────────────────────────────────────
  let dragging = false, dragOffX = 0, dragOffY = 0;
  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dragOffX = e.clientX - r.left;
    dragOffY = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffX));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffY));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  const modeSel = document.getElementById('vp-mode') as HTMLSelectElement;
  const engineSel = document.getElementById('vp-engine') as HTMLSelectElement;
  const widthIn = document.getElementById('vp-width') as HTMLInputElement;
  const binsIn = document.getElementById('vp-bins') as HTMLInputElement;
  const lbIn = document.getElementById('vp-lookback') as HTMLInputElement;
  const vaIn = document.getElementById('vp-va') as HTMLInputElement;
  const themeSel = document.getElementById('vp-theme') as HTMLSelectElement;
  const showVA = document.getElementById('vp-show-va') as HTMLInputElement;
  const showDelta = document.getElementById('vp-show-delta') as HTMLInputElement;
  const showNodes = document.getElementById('vp-show-nodes') as HTMLInputElement;

  modeSel?.addEventListener('change', () => { vpSettings.mode = modeSel.value as VolumeProfileMode; volumeEnabled = true; vpCacheKey = ''; updateUI(); });
  engineSel?.addEventListener('change', () => { vpSettings.visualEngine = engineSel.value as any; updateUI(); });
  widthIn?.addEventListener('input', () => { vpSettings.profileWidth = parseInt(widthIn.value, 10); vpCacheKey = ''; updateUI(); });
  binsIn?.addEventListener('input', () => { vpSettings.binCount = parseInt(binsIn.value, 10); vpCacheKey = ''; updateUI(); });
  lbIn?.addEventListener('input', () => { vpSettings.lookbackBars = parseInt(lbIn.value, 10); vpCacheKey = ''; updateUI(); });
  vaIn?.addEventListener('input', () => { vpSettings.valueAreaPct = parseInt(vaIn.value, 10); vpCacheKey = ''; updateUI(); });
  themeSel?.addEventListener('change', () => { vpSettings.colorTheme = themeSel.value as any; updateUI(); });
  showVA?.addEventListener('change', () => { vpSettings.showValueArea = showVA.checked; updateUI(); });
  showDelta?.addEventListener('change', () => { vpSettings.showDelta = showDelta.checked; updateUI(); });
  showNodes?.addEventListener('change', () => { vpSettings.showNodes = showNodes.checked; updateUI(); });

  // Bar view toggle (2D / 3D Isometric) — controls is3DMode
  const barViewSel = document.getElementById('vp-bar-view') as HTMLSelectElement;
  barViewSel?.addEventListener('change', () => {
    is3DMode = barViewSel.value === '3D';
    visualAdapter.logAction('mode', `Switched to ${is3DMode ? '3D' : '2D'} mode`);
    updateUI();
  });
}

function syncVPSettingsPanel() {
  const modeSel = document.getElementById('vp-mode') as HTMLSelectElement;
  const engineSel = document.getElementById('vp-engine') as HTMLSelectElement;
  const widthIn = document.getElementById('vp-width') as HTMLInputElement;
  const binsIn = document.getElementById('vp-bins') as HTMLInputElement;
  const lbIn = document.getElementById('vp-lookback') as HTMLInputElement;
  const vaIn = document.getElementById('vp-va') as HTMLInputElement;
  const themeSel = document.getElementById('vp-theme') as HTMLSelectElement;
  const showVA = document.getElementById('vp-show-va') as HTMLInputElement;
  const showDelta = document.getElementById('vp-show-delta') as HTMLInputElement;
  const showNodes = document.getElementById('vp-show-nodes') as HTMLInputElement;
  if (modeSel) modeSel.value = vpSettings.mode;
  if (engineSel) engineSel.value = vpSettings.visualEngine;
  if (widthIn) { widthIn.value = String(vpSettings.profileWidth); document.getElementById('vp-width-val')!.textContent = String(vpSettings.profileWidth); }
  if (binsIn) { binsIn.value = String(vpSettings.binCount); document.getElementById('vp-bins-val')!.textContent = String(vpSettings.binCount); }
  if (lbIn) { lbIn.value = String(vpSettings.lookbackBars); document.getElementById('vp-lookback-val')!.textContent = vpSettings.lookbackBars === 0 ? 'Visible' : String(vpSettings.lookbackBars); }
  if (vaIn) { vaIn.value = String(vpSettings.valueAreaPct); document.getElementById('vp-va-val')!.textContent = `${vpSettings.valueAreaPct}%`; }
  if (themeSel) themeSel.value = vpSettings.colorTheme;
  if (showVA) showVA.checked = vpSettings.showValueArea;
  if (showDelta) showDelta.checked = vpSettings.showDelta;
  if (showNodes) showNodes.checked = vpSettings.showNodes;
  const barViewSel = document.getElementById('vp-bar-view') as HTMLSelectElement;
  if (barViewSel) barViewSel.value = is3DMode ? '3D' : '2D';
}

// ─── Startup ─────────────────────────────────────────────────────
const BACKEND_URL = (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788';

async function startupChecks(): Promise<void> {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/ping`);
    if (resp.ok) {
      const statusEl = document.getElementById('data-status');
      if (statusEl) { statusEl.textContent = 'Backend OK'; statusEl.className = 'loaded'; }
      // Prefetch model context size so token optimizer uses real limits
      prefetchModelProfile().then(ctx => {
        console.log(`[DAFE] Model context: ${ctx} tokens`);
      });
    }
  } catch {
    const statusEl = document.getElementById('data-status');
    if (statusEl) { statusEl.textContent = 'Backend offline'; statusEl.className = 'error'; }
  }
}

// ─── Paper Trading ───────────────────────────────────────────────
// Loaded once from localStorage so the commission/slippage model survives a
// reload — the settings panel is the only UI for editing it (the widget
// itself just shows Buy/Sell + the resulting positions/orders).
function loadTradeSettings(): { cash: number; commission: CommissionConfig; slippage: { mode: SlippageMode; value: number; tickSize: number } } {
  try {
    const saved = JSON.parse(localStorage.getItem('dafe_trade_settings') || 'null');
    if (saved) return saved;
  } catch {}
  return { cash: 100000, commission: DEFAULT_COMMISSION, slippage: DEFAULT_SLIPPAGE };
}
function saveTradeSettings(cfg: { cash: number; commission: CommissionConfig; slippage: { mode: SlippageMode; value: number; tickSize: number } }): void {
  try { localStorage.setItem('dafe_trade_settings', JSON.stringify(cfg)); } catch {}
}

const initialTradeSettings = loadTradeSettings();
let tradeCurrencyOverride: string | null = null;
let hideTradeMarkers = (() => { try { return localStorage.getItem('dafe_hide_trade_markers') === '1'; } catch { return false; } })();
const broker = new PaperBroker({
  currency: detectCurrency(currentSymbol),
  startingCash: initialTradeSettings.cash,
  commission: initialTradeSettings.commission,
  slippage: initialTradeSettings.slippage,
});
// Chart markers for executed fills, kept per-symbol so switching symbols
// shows the right trade history instead of another symbol's markers.
const tradeMarkersBySymbol = new Map<string, TradeMarker[]>();
broker.onFill((fill) => {
  const note = document.getElementById('tradeFillNote');
  if (note) {
    note.innerHTML = `Last fill: ${fill.side.toUpperCase()} ${fill.qty} @ ${fill.price.toFixed(4)}<br>Commission: $${fill.commission.toFixed(2)} · Slippage: $${fill.slippage.toFixed(4)}`;
  }
  appendAdvisorMessage('system', `${fill.side.toUpperCase()} ${fill.qty} ${getQtyUnit(fill.symbol)} of ${fill.symbol} filled @ ${fill.price.toFixed(4)} (commission $${fill.commission.toFixed(2)}, slippage $${fill.slippage.toFixed(4)})`);
  const markers = tradeMarkersBySymbol.get(fill.symbol) || [];
  markers.push({ timestamp: fill.timestamp, price: fill.price, side: fill.side, qty: fill.qty });
  tradeMarkersBySymbol.set(fill.symbol, markers);
  renderTradeAccount();
  renderTradePositions();
});
broker.onOrderUpdate(() => renderTradeOrders());

/** Flatten a position with a market order for the opposite side. */
function closePosition(symbol: string): void {
  const pos = broker.getPositions().find(p => p.symbol === symbol);
  if (!pos || pos.qty === 0) return;
  broker.placeOrder({ symbol, side: pos.qty > 0 ? 'sell' : 'buy', type: 'market', qty: Math.abs(pos.qty) });
  renderTradePositions();
}
function closeAllPositions(): void {
  for (const pos of broker.getPositions()) closePosition(pos.symbol);
}

function renderTradeAccount(): void {
  const acct = broker.getAccount();
  const cashEl = document.getElementById('tradeCash');
  const eqEl = document.getElementById('tradeEquity');
  const rEl = document.getElementById('tradeRealizedPnL');
  const uEl = document.getElementById('tradeUnrealizedPnL');
  if (cashEl) cashEl.textContent = `${acct.cash.toFixed(2)} ${acct.currency}`;
  if (eqEl) eqEl.textContent = `${acct.equity.toFixed(2)} ${acct.currency}`;
  if (rEl) { rEl.textContent = acct.realizedPnL.toFixed(2); rEl.className = `val ${acct.realizedPnL >= 0 ? 'pos' : 'neg'}`; }
  if (uEl) { uEl.textContent = acct.unrealizedPnL.toFixed(2); uEl.className = `val ${acct.unrealizedPnL >= 0 ? 'pos' : 'neg'}`; }
}

/** Open a toolbar popover up or down depending on where the (draggable)
 * toolbar currently sits — so pinning it to the top of the screen doesn't
 * push an upward-opening menu off-screen. */
function orientToolbarPopover(menu: HTMLElement): void {
  const toolbar = document.getElementById('toolbar');
  const openDown = toolbar ? (toolbar.getBoundingClientRect().top < window.innerHeight / 2) : false;
  if (openDown) {
    menu.style.top = '100%'; menu.style.bottom = 'auto';
    menu.style.marginTop = '2px'; menu.style.marginBottom = '0';
  } else {
    menu.style.bottom = '100%'; menu.style.top = 'auto';
    menu.style.marginBottom = '2px'; menu.style.marginTop = '0';
  }
}

/** currentSymbol is free-typed user text, not a fixed enum — it must be
 * escaped before landing in innerHTML (trade lists render it directly). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTradePositions(): void {
  const list = document.getElementById('tradePositionsList');
  if (!list) return;
  const positions = broker.getPositions();
  if (positions.length === 0) { list.innerHTML = '<div class="trade-list-empty">No open positions</div>'; return; }
  list.innerHTML = positions.map(p => {
    const px = transformed[transformed.length - 1]?.close ?? p.avgPrice;
    const unreal = (px - p.avgPrice) * p.qty;
    return `<div class="trade-list-row"><span class="pos-info">${escapeHtml(p.symbol)} ${p.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)} @ ${p.avgPrice.toFixed(2)}<button class="close-position" data-close-symbol="${escapeHtml(p.symbol)}">Close</button></span><span class="${unreal >= 0 ? 'pos' : 'neg'}" style="color:${unreal >= 0 ? '#22cc88' : '#ff4477'}">${unreal >= 0 ? '+' : ''}${unreal.toFixed(2)}</span></div>`;
  }).join('');
  list.querySelectorAll('.close-position').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sym = (btn as HTMLElement).dataset.closeSymbol;
      if (sym) closePosition(sym);
    });
  });
}

function renderTradeOrders(): void {
  const list = document.getElementById('tradeOrdersList');
  if (!list) return;
  const working = broker.getOrders().filter(o => o.status === 'working');
  if (working.length === 0) { list.innerHTML = '<div class="trade-list-empty">No open orders</div>'; return; }
  list.innerHTML = working.map(o => {
    const priceLabel = o.type === 'trailing-stop' ? `trail ${o.trailAmount}${o.trailIsPercent ? '%' : ''}`
      : o.limitPrice !== undefined ? `@ ${o.limitPrice}` : o.stopPrice !== undefined ? `stop ${o.stopPrice}` : '';
    return `<div class="trade-list-row"><span>${o.side.toUpperCase()} ${o.qty} ${escapeHtml(o.symbol)} ${o.type} ${escapeHtml(priceLabel)}</span><button class="cancel-order" data-order-id="${o.id}">✕</button></div>`;
  }).join('');
  list.querySelectorAll('.cancel-order').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.orderId;
      if (id) broker.cancelOrder(id);
      renderTradeOrders();
    });
  });
}

function getQtyUnit(symbol: string): string {
  const sym = symbol.toUpperCase();
  if (sym.includes('USD') || sym.includes('EUR') || sym.includes('GBP') || sym.includes('JPY')) return 'lots';
  if (sym === 'BTCUSD' || sym === 'ETHUSD') return 'coins';
  if (sym === 'ES' || sym === 'NQ' || sym === 'YM' || sym === 'RTY') return 'contracts';
  if (sym === 'CL' || sym === 'GC' || sym === 'SI' || sym === 'NG') return 'contracts';
  return 'shares';
}

function updateTradingPanel(): void {
  const lastBar = transformed[transformed.length - 1];
  if (!lastBar) return;

  const bid = lastBar.close * 0.9999;
  const ask = lastBar.close * 1.0001;
  const spread = ask - bid;

  const sellPriceEl = document.getElementById('sellPrice');
  const buyPriceEl = document.getElementById('buyPrice');
  const spreadEl = document.getElementById('tradingSpread');
  const qtyUnitEl = document.getElementById('tradeQtyUnit');

  if (sellPriceEl) sellPriceEl.textContent = bid.toFixed(2);
  if (buyPriceEl) buyPriceEl.textContent = ask.toFixed(2);
  if (spreadEl) spreadEl.textContent = spread.toFixed(2);
  if (qtyUnitEl) qtyUnitEl.textContent = getQtyUnit(currentSymbol);

  broker.tick(currentSymbol, lastBar.close, Date.now());
  renderTradeAccount();
  renderTradePositions();
  renderTradeOrders();

  const autoEl = document.getElementById('tradeCurrencyAuto');
  const curSel = document.getElementById('tradeCurrency') as HTMLSelectElement | null;
  if (autoEl && curSel && !tradeCurrencyOverride) {
    const detected = detectCurrency(currentSymbol);
    autoEl.textContent = `auto: ${detected}`;
    if (curSel.value !== detected) curSel.value = detected;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  startupChecks();
  refreshProviderCapabilities();
  syncLlmConfigFromSettings();

  // Initialize GPU particle system. Allocate the full buffer (cheap, ~200KB)
  // so the perf governor can scale the active count freely; start at the
  // device-recommended tier.
  initParticleSystem(canvas, {
    count: tierParticleCount('ultra'),
    colorMode: 'cosmic',
    intensity: 1.0,
  }).then(gpuOk => {
    setParticleCount(tierParticleCount(perfMode));
    if (gpuOk) console.log(`[DAFE] GPU particles ready — starting tier ${perfMode}`);
  });

  // Drawing tools rail
  document.querySelectorAll('.draw-btn').forEach((btn) => {
    const el = btn as HTMLElement;
    if (el.id === 'draw-clear') {
      el.addEventListener('click', () => draw.clearDrawings());
      return;
    }
    el.addEventListener('click', () => setDrawTool((el.dataset.tool as DrawTool) || 'none'));
  });

  // Chart controls
  document.getElementById('vp-toggle')?.addEventListener('click', () => {
    document.getElementById('vp-settings-panel')?.classList.toggle('active');
    visualAdapter.logAction('toggle', 'Volume profile settings panel');
  });
  document.getElementById('live-tick-toggle')?.addEventListener('click', () => {
    if (liveTicksEnabled) {
      stopLiveTicks();
      (document.getElementById('live-tick-toggle') as HTMLElement).classList.remove('active');
    } else {
      startLiveTicks();
      (document.getElementById('live-tick-toggle') as HTMLElement).classList.add('active');
    }
  });
  document.getElementById('btn-frame')?.addEventListener('click', () => {
    view.scrollX = 0; view.barSpacing = DEFAULT_BAR_SPACING; view.offsetY = 0;
    visualAdapter.logAction('frame', 'Reset chart view');
  });
  document.getElementById('mode-toggle')?.addEventListener('click', () => {
    is3DMode = !is3DMode;
    visualAdapter.logAction('mode', `Switched to ${is3DMode ? '3D' : '2D'} mode`);
    updateUI();
  });

  // Indicator select menu — populate from OakScript indicator library
  const indSelect = document.getElementById('indicator-select') as HTMLSelectElement;
  if (indSelect) {
    const categories2 = getCategories();
    for (const cat of categories2) {
      const group = document.createElement('optgroup');
      group.label = cat;
      const catInds = getIndicators().filter(ind => ind.category === cat);
      for (const ind of catInds) {
        const opt = document.createElement('option');
        opt.value = ind.name;
        opt.textContent = ind.name;
        group.appendChild(opt);
      }
      indSelect.appendChild(group);
    }
    indSelect.addEventListener('change', () => {
      const name = indSelect.value;
      if (!name) return;
      const ind = getIndicators().find(i => i.name === name);
      if (ind) {
        const inst = addIndicator(ind);
        runAllIndicators();
        enforceSingle3DPerPosition(inst.id);
        oakScriptEnabled = true;
        activeInputsId = inst.id;
        inputsPanel.update(inst.inputs, inst.name);
        inputsPanel.show();
        dashboard.show();
        updateUI();
      }
      indSelect.value = '';
    });
  }

  document.getElementById('bar-type-select')?.addEventListener('change', (e) => {
    const newType = (e.target as HTMLSelectElement).value as BarType;
    visualAdapter.logAction('bar-type', `Changed from ${barType} to ${newType}`);
    barType = newType;
    regenerate();
    updateUI();
  });
  document.getElementById('tf-select')?.addEventListener('change', (e) => {
    const newTf = (e.target as HTMLSelectElement).value as Timeframe;
    visualAdapter.logAction('timeframe', `Changed from ${timeframe} to ${newTf}`);
    timeframe = newTf;
    regenerate();
    updateUI();
  });
  document.getElementById('vpi-enabled')?.addEventListener('change', (e) => {
    vpiEnabled = (e.target as HTMLInputElement).checked;
    visualAdapter.logAction('vpi', `VPI ${vpiEnabled ? 'enabled' : 'disabled'}`);
  });

  // Volume Profile settings panel
  setupVPSettingsPanel();

  // Apply new source to the instance actually being worked on, instead of
  // guessing from instance count. The old logic (separately duplicated in
  // both the editor's onChange and the AI bridge's onRunScript) fell back to
  // "just use active[0]" whenever more than one indicator was active — for
  // the AI bridge that meant editing indicator #2 silently overwrote
  // indicator #1's source AND DELETED every other active instance. Track
  // the real target via activeInputsId (set whenever the user picks an
  // indicator to edit, via its gear icon or the editor itself) and only
  // fall back to count-based guessing when there is truly no known target.
  function applyEditorSource(source: string): IndicatorInstance {
    const active = getActiveInstances();
    let inst = activeInputsId ? active.find(i => i.id === activeInputsId) : undefined;
    if (!inst) inst = active.find(i => i.source === source);
    if (!inst) {
      if (active.length === 1) {
        inst = active[0];
        updateInstanceSource(inst.id, source);
      } else {
        // Either nothing is active, or multiple instances exist with no
        // known target — create a fresh instance rather than guessing which
        // existing one to overwrite (and never delete unrelated instances).
        inst = addIndicator({
          name: 'Editor Script',
          category: 'Custom',
          source,
          description: 'User-edited indicator',
        });
      }
    } else {
      updateInstanceSource(inst.id, source);
    }
    activeInputsId = inst.id;
    // Keep the inputs panel in sync with the edited script — re-detecting
    // inputs (above) means newly-added input() params now appear instead of a
    // blank/stale panel.
    inputsPanel.update(inst.inputs, inst.name);
    return inst;
  }

  // OakScript editor
  const { textarea } = createEditor(document.body, (source: string) => {
    applyEditorSource(source);
    runAllIndicators();
    updateUI();
  });
  textarea.id = 'os-textarea';
  osTextarea = textarea;

  // Initialize the OakScript-TradeAdvisor bridge
  initBridge(advisor, {
    editorTextarea: textarea,
    onRunScript: (source: string) => {
      if (textarea) {
        textarea.value = source;
        localStorage.setItem('oakscript_source', source);
      }
      applyEditorSource(source);
      runAllIndicators();
      updateUI();
    },
    getSnapshot: () => visualAdapter.getLastSnapshot() || captureChartSnapshot(),
    getActiveInstances: () => getActiveInstances(),
    getEditorSource: () => textarea?.value || '',
    setEditorSource: (source: string) => {
      if (textarea) {
        textarea.value = source;
        localStorage.setItem('oakscript_source', source);
      }
    },
    getErrors: () => {
      const errs: string[] = [];
      for (const inst of getActiveInstances()) {
        for (const e of inst.errors) errs.push(e);
      }
      return errs;
    },
  });

  // Wire the "send errors to advisor" button in the editor
  setSendErrorsCallback((errors: string[], source: string) => {
    if (advisorStreaming) return;
    appendAdvisorMessage('system', `Sending ${errors.length} indicator error(s) to Trade Advisor for diagnosis...`);
    (async () => {
      advisorStreaming = true;
      const typingEl = showAdvisorTyping();
      try {
        const snapshot = visualAdapter.getLastSnapshot() || captureChartSnapshot();
        const resp = await advisor.diagnoseErrors(source, errors, snapshot);
        removeAdvisorTyping();
        if (resp.ok) {
          appendAdvisorMessage('assistant', resp.reply, 'Trade Advisor', resp.thinking || undefined);
          advisorMessages.push({ role: 'assistant', content: resp.reply });
          // Auto-apply code if we find a code block
          const codeBlocks = extractCodeBlocks(resp.reply);
          if (codeBlocks.length > 0) {
            applyAgentCode(codeBlocks[0], `Auto-fix ${errors.length} error(s)`, 'fix', source);
          }
        } else {
          appendAdvisorMessage('error', resp.reply);
        }
      } catch (err: any) {
        removeAdvisorTyping();
        appendAdvisorMessage('error', `Diagnosis failed: ${err.message}`);
      } finally {
        advisorStreaming = false;
      }
    })();
  });

  // ── Wire editor agent callbacks ──
  setAgentActionCallback(async (action: string, data?: string) => {
    const appendChat = (role: string, msg: string) => {
      (window as any).__osAppendChat?.(role, msg);
    };
    if (action === 'fix') {
      const errs: string[] = [];
      for (const inst of getActiveInstances()) {
        for (const e of inst.errors) errs.push(e);
      }
      if (errs.length === 0) { appendChat('agent', 'No errors to fix.'); return; }
      appendChat('agent', `Diagnosing ${errs.length} error(s)...`);
      await agentDiagnoseErrors((reply: string) => {
        appendChat('agent', reply.slice(0, 200));
      });
    } else if (action === 'generate' && data) {
      if (hasRealEditorScript()) {
        // There's already a real script in the editor — this "New" request
        // is almost always someone refining what they just asked for
        // ("anchor the fib lines to swing points", "remove the lower
        // visual"), not actually starting from scratch. Route through the
        // context-aware edit path (current source + "you are EDITING this,
        // not generating a new one") instead of a fresh Phase-1 design that
        // has never seen the existing script and can't act on a follow-up
        // that references it.
        appendChat('agent', `Refining current script: "${data.slice(0, 80)}"...`);
        await sendOakScriptChatMessage(data);
      } else {
        appendChat('agent', `Generating: "${data.slice(0, 80)}"...`);
        await agentGenerateIndicatorPhased(data, undefined, (msg) => {
          appendChat('agent', msg.slice(0, 200));
        });
      }
    } else if (action === 'brainstorm') {
      appendChat('agent', 'Brainstorming...');
      await agentBrainstormIndicator(undefined, (reply: string) => {
        appendChat('agent', reply.slice(0, 300));
      });
    } else if (action === 'metrics') {
      if (getActiveInstances().length === 0) { appendChat('agent', 'No active indicators.'); return; }
      appendChat('agent', 'Analyzing metrics...');
      await agentAnalyzeMetrics((reply: string) => {
        appendChat('agent', reply.slice(0, 300));
      });
    } else if (action === 'validate') {
      await validateCurrentCode((result: string) => {
        appendChat('agent', result);
      });
    }
  });

  // ── Wire editor agent chat ──
  // Extracted to a named function so the "generate new indicator" entry
  // points (the New button / Ctrl+Alt+G) can also reach it — see below,
  // where it's used instead of a fresh Phase-1 generation whenever there's
  // already a real script in the editor, so follow-up refinement requests
  // ("anchor the fib lines to swing points", "remove the lower visual")
  // actually see and build on the current script instead of starting over
  // from just that one line of text with no memory of what came before.
  async function sendOakScriptChatMessage(msg: string): Promise<void> {
    const appendChat = (role: string, text: string) => {
      (window as any).__osAppendChat?.(role, text);
    };
    try {
      const source = osTextarea?.value || '';
      const prefer3D = (window as any).__osGetPrefer3D?.() ?? true;

      const active = getActiveInstances();
      let stateInfo = '';
      if (active.length > 0) {
        const inst = active[0];
        const plotTypes = new Set(inst.plots.map(p => p.type));
        const signalCount = inst.plots.filter(p => p.type === 'shape').length;
        const has3D = inst.plots.some(p => p.type === 'plot3d');
        const errors = inst.errors.length > 0 ? `\nErrors (${inst.errors.length}): ${inst.errors.slice(0, 3).join('; ')}` : '';
        stateInfo = `Indicator: ${inst.name} | Plots: ${plotTypes.size ? [...plotTypes].join(',') : 'none'} | Signals: ${signalCount} | 3D: ${has3D ? 'yes' : 'no'} | Prefer 3D: ${prefer3D}${errors}`;
        if (signalCount === 0) stateInfo += '\nIssue: No signals generated. You MUST add plotshape() calls this edit — see CRITICAL RULES below.';
        // Only nudge toward 3D when the user hasn't explicitly asked for a
        // 2D/main-chart-only indicator — the user's words outrank the toggle.
        if (!has3D && prefer3D && !/\b(main chart only|2d only|no 3d|without 3d|remove( the)? 3d|flat chart)\b/i.test(msg)) stateInfo += '\nIssue: No 3D rendering.';
      } else {
        stateInfo = 'No active indicator.';
      }

      // The state diagnostics above can flag "no signals generated," but that
      // was never actually acted on — the rules below only said "preserve
      // existing logic," so the model dutifully left the gap alone instead of
      // fixing it. Detect the same signal intent from the user's own wording
      // and give an explicit, unambiguous instruction either way.
      const wantsSignals = /\b(signal|reversal|buy|sell|entry|exit|long|short|marker|arrow|triangle|cross(over|under))/i.test(msg);
      const signalRule = (wantsSignals || /No signals generated/.test(stateInfo))
        ? `\n- The user is asking for trading signals. You MUST add plotshape(bar_index, price, "LABEL", "triangleup"|"triangledown"|"circle"|"cross", "#hexcolor") calls with NO pane argument (or pane="main") so they render as markers on the MAIN price chart — not a plot() line in a separate oscillator pane. Derive the actual buy/sell condition from the indicator's own math (e.g. crossover/crossunder, threshold breach, divergence) rather than leaving signal count at zero.`
        : '';
      // The user's explicit wording beats the Prefer-3D toggle: "main chart
      // only" must produce a clean 2D indicator, not a surface takeover.
      const wants2DOnly = /\b(main chart only|2d only|no 3d|without 3d|remove( the)? 3d|flat chart)\b/i.test(msg);
      const dimensionRule = wants2DOnly
        ? `\n- The user asked for a MAIN-CHART-ONLY (2D) indicator: do NOT add ANY plot3d() calls, and REMOVE every existing plot3d() call. All rendering must be 2D — plot()/plotshape()/fill()/bgcolor() on the main pane.`
        : '';

      const promptText = `[OakScript Expert] ${msg}

${stateInfo}

CURRENT INDICATOR SOURCE (the script you MUST edit — output the COMPLETE modified version, never a different/simplified indicator):
\`\`\`oakscript
${source}
\`\`\`

CRITICAL RULES:
- You are EDITING the script above, NOT generating a new one. Preserve ALL existing logic, calculations, variables, loops, signals, and structure — EXCEPT where the user's request or an Issue above requires a real change; fixing what was asked takes priority over pure preservation.
- Do NOT simplify, summarize, remove, or rename existing logic. Only ADD or MODIFY what the user asked for.
- Output the COMPLETE script (every line, start to finish) inside \`\`\`oakscript fences. Never output a partial script or stop mid-script.
- Block syntax: use { } braces around multi-statement bodies under if/else/for/while. A single statement may follow without braces. There is NO indentation-based block parsing — multi-statement blocks MUST use braces.
- Colors MUST be hex strings: "#22cc88" NOT "green". Strings MUST be quoted.
- == not = in conditions. Use input() for params.
- var is ONLY for persistent state with a LITERAL initial value (var lastHigh = 0.0), updated with := inside logic. A var initializer runs ONCE on bar 0 and FREEZES — NEVER declare calculations/conditions/inputs-derived expressions with var; plain assignment recomputes every bar.
- NEVER use a negative history index like high[-1] — that reads a FUTURE bar. Use [1]/[2] for past bars; confirm swings 1-2 bars late.
- DYNAMIC price levels (fibs, pivots, moving S/R that follow new swings) MUST use plot(level, "Title", "#hex", 1, "stepline") — the line then moves when the level changes. hline() is ONLY for constants that never change (e.g. RSI 70/30); an hline whose value changes leaves a NEW permanent line each time and buries the chart.
- The 3D engine supports plot3d(series, name, style, color, pane) with styles: surface, ribbon, scatter, bars3d, wireframe, mesh, line3d, helix, vortex, manifold, nebula, constellation, torus, trail. pane="main" renders a 3D scene on the main chart; pane="separate" renders in the lower 3D pane. Multiple plot3d("separate") calls stack side-by-side.
- When the user asks for 3D visuals, ADD plot3d() calls while keeping every existing 2D plot and signal intact. Make it visually stunning — use surface/ribbon/bars3d/helix/vortex/manifold with vivid hex colors.${signalRule}${dimensionRule}
- Goal: the best, most visually stunning version of the user's idea.`;
      const snapshot = visualAdapter.getLastSnapshot() || captureChartSnapshot();
      const resp = await advisor.sendMessage(promptText, snapshot, undefined, 'oakscript_coder');

      if (resp.ok) {
        appendChat('agent', resp.reply.slice(0, 600));
        const blocks = extractCodeBlocks(resp.reply);
        if (blocks.length > 0) {
          // Run the draft through the validator BEFORE surfacing it — errors
          // like frozen var initializers or future-bar indexes are silent at
          // runtime (the script "works" but computes garbage), so the user
          // could never catch them via Test. Give the model up to 2 fix
          // rounds with the validator's targeted messages first.
          let code = blocks[0];
          try {
            const { validate } = await import('./oakscript/validator');
            if (!validate(code).valid) {
              appendChat('agent', '⏳ Draft failed validation — auto-fixing…');
              const iter = await advisor.validateAndIterate(code, 2, snapshot, undefined, msg);
              code = iter.finalCode;
              appendChat('agent', iter.valid
                ? '✓ Auto-fix passed validation.'
                : '⚠ Issues remain after auto-fix — use Test before Accept.');
            }
          } catch { /* validator unavailable — surface the raw draft */ }
          // Always surface the review panel (View / Test / Accept / Decline) so
          // the user can act on the proposal — even a partial one, which they
          // can Test before accepting. The accept handler guards against bad code.
          applyAgentCode(code, msg.slice(0, 60), 'edit', source);
        } else {
          appendChat('agent', '⚠ No code block found in the response — try rephrasing the request.');
        }
      } else {
        appendChat('agent', 'Error: ' + resp.reply.slice(0, 200));
      }
    } catch (err: any) {
      appendChat('agent', 'Error: ' + err.message);
    }
  }
  setAgentChatCallback(sendOakScriptChatMessage);

  // True once there's a real script in the editor worth refining, as
  // opposed to the blank placeholder or truly empty content — used to
  // decide whether a "generate" request is actually a create-from-scratch
  // or a follow-up refinement of what's already there.
  function hasRealEditorScript(): boolean {
    const src = (osTextarea?.value || '').trim();
    return src.length > 0 && src !== getDefaultScript().trim();
  }

  // ── Wire editor visibility toggle ──
  setToggleVisibilityCallback(() => {
    const insts = getActiveInstances();
    if (insts.length > 0) {
      const inst = insts[0];
      setInstanceEnabled(inst.id, !inst.enabled);
      if (!inst.enabled) {
        hide3D();
        disposeViz();
      } else {
        runAllIndicators();
      }
      updateUI();
    }
  });

  // ── Register editor keyboard shortcuts ──
  registerEditorShortcuts([
    {
      key: 'F', ctrl: true, alt: true,
      handler: () => {
        const errors: string[] = [];
        for (const inst of getActiveInstances()) {
          for (const e of inst.errors) errors.push(e);
        }
        if (errors.length === 0) {
          (window as any).__osAppendChat?.('agent', 'No errors to fix.');
          return;
        }
        (window as any).__osAppendChat?.('agent', `Diagnosing ${errors.length} error(s)...`);
        agentDiagnoseErrors((reply: string) => {
          (window as any).__osAppendChat?.('agent', reply.slice(0, 200));
        });
      },
    },
    {
      key: 'G', ctrl: true, alt: true,
      handler: () => {
        const t = prompt('Describe the indicator:');
        if (t && osTextarea) {
          if (hasRealEditorScript()) {
            (window as any).__osAppendChat?.('agent', `Refining current script: "${t.slice(0, 50)}"...`);
            sendOakScriptChatMessage(t);
          } else {
            (window as any).__osAppendChat?.('agent', `Generating: "${t.slice(0, 50)}..."`);
            agentGenerateIndicatorPhased(t, undefined, (msg) => {
              (window as any).__osAppendChat?.('agent', msg.slice(0, 200));
            });
          }
        }
      },
    },
    {
      key: 'B', ctrl: true, alt: true,
      handler: () => {
        (window as any).__osAppendChat?.('agent', 'Brainstorming...');
        agentBrainstormIndicator(undefined, (reply: string) => {
          (window as any).__osAppendChat?.('agent', reply.slice(0, 300));
        });
      },
    },
    {
      key: 'M', ctrl: true, alt: true,
      handler: () => {
        (window as any).__osAppendChat?.('agent', 'Analyzing metrics...');
        agentAnalyzeMetrics((reply: string) => {
          (window as any).__osAppendChat?.('agent', reply.slice(0, 300));
        });
      },
    },
    {
      key: 'V', ctrl: true, alt: true,
      handler: () => {
        validateCurrentCode((result: string) => {
          (window as any).__osAppendChat?.('agent', result);
        });
      },
    },
  ]);

  // ─── Securities Combo (search + dropdown) ───────────────────────
  const symbolInput = document.getElementById('symbol-input') as HTMLInputElement;
  const symbolDropdown = document.getElementById('symbol-dropdown') as HTMLDivElement;
  let securitiesCache: Array<{symbol:string;name:string}> = [
    {symbol:'SPY',name:'S&P 500 ETF'},{symbol:'QQQ',name:'Nasdaq-100 ETF'},{symbol:'DIA',name:'Dow Jones ETF'},{symbol:'IWM',name:'Russell 2000 ETF'},
    {symbol:'VTI',name:'Total Stock Market ETF'},{symbol:'VOO',name:'S&P 500 Index ETF'},{symbol:'BND',name:'Total Bond Market ETF'},{symbol:'GLD',name:'Gold ETF'},
    {symbol:'SLV',name:'Silver ETF'},{symbol:'TLT',name:'20+ Year Treasury ETF'},{symbol:'EEM',name:'Emerging Markets ETF'},
    {symbol:'XLF',name:'Financial Sector ETF'},{symbol:'XLK',name:'Technology Sector ETF'},{symbol:'XLE',name:'Energy Sector ETF'},
    {symbol:'XLV',name:'Healthcare Sector ETF'},{symbol:'XLI',name:'Industrial Sector ETF'},{symbol:'XLP',name:'Consumer Staples ETF'},
    {symbol:'XLY',name:'Consumer Disc. ETF'},{symbol:'XLU',name:'Utilities Sector ETF'},{symbol:'SMH',name:'Semiconductor ETF'},
    {symbol:'IBIT',name:'iShares Bitcoin Trust'},{symbol:'ARKK',name:'ARK Innovation ETF'},{symbol:'TQQQ',name:'3x Bull Nasdaq-100'},{symbol:'SQQQ',name:'3x Bear Nasdaq-100'},
    {symbol:'AAPL',name:'Apple Inc'},{symbol:'MSFT',name:'Microsoft Corp'},{symbol:'GOOGL',name:'Alphabet Inc'},{symbol:'AMZN',name:'Amazon.com'},
    {symbol:'NVDA',name:'NVIDIA Corp'},{symbol:'META',name:'Meta Platforms'},{symbol:'TSLA',name:'Tesla Inc'},{symbol:'AVGO',name:'Broadcom Inc'},
    {symbol:'AMD',name:'AMD'},{symbol:'NFLX',name:'Netflix Inc'},{symbol:'ADBE',name:'Adobe Inc'},{symbol:'CRM',name:'Salesforce Inc'},
    {symbol:'INTC',name:'Intel Corp'},{symbol:'CSCO',name:'Cisco Systems'},{symbol:'ORCL',name:'Oracle Corp'},{symbol:'IBM',name:'IBM Corp'},
    {symbol:'QCOM',name:'Qualcomm Inc'},{symbol:'MU',name:'Micron Technology'},{symbol:'TSM',name:'Taiwan Semiconductor'},
    {symbol:'NOW',name:'ServiceNow Inc'},{symbol:'PANW',name:'Palo Alto Networks'},{symbol:'CRWD',name:'CrowdStrike Holdings'},{symbol:'SNOW',name:'Snowflake Inc'},
    {symbol:'JPM',name:'JPMorgan Chase'},{symbol:'BAC',name:'Bank of America'},{symbol:'WFC',name:'Wells Fargo'},{symbol:'GS',name:'Goldman Sachs'},
    {symbol:'MS',name:'Morgan Stanley'},{symbol:'C',name:'Citigroup Inc'},{symbol:'V',name:'Visa Inc'},{symbol:'MA',name:'Mastercard Inc'},
    {symbol:'PYPL',name:'PayPal Holdings'},{symbol:'SQ',name:'Block Inc'},{symbol:'AXP',name:'American Express'},{symbol:'SCHW',name:'Charles Schwab'},
    {symbol:'BLK',name:'BlackRock Inc'},
    {symbol:'XOM',name:'Exxon Mobil'},{symbol:'CVX',name:'Chevron Corp'},{symbol:'COP',name:'ConocoPhillips'},{symbol:'SLB',name:'Schlumberger NV'},
    {symbol:'OXY',name:'Occidental Petroleum'},{symbol:'EOG',name:'EOG Resources'},
    {symbol:'JNJ',name:'Johnson & Johnson'},{symbol:'UNH',name:'UnitedHealth Group'},{symbol:'PFE',name:'Pfizer Inc'},{symbol:'ABBV',name:'AbbVie Inc'},
    {symbol:'MRK',name:'Merck & Co'},{symbol:'LLY',name:'Eli Lilly & Co'},{symbol:'TMO',name:'Thermo Fisher'},{symbol:'MDT',name:'Medtronic PLC'},
    {symbol:'ABT',name:'Abbott Laboratories'},{symbol:'ISRG',name:'Intuitive Surgical'},{symbol:'GILD',name:'Gilead Sciences'},{symbol:'AMGN',name:'Amgen Inc'},
    {symbol:'WMT',name:'Walmart Inc'},{symbol:'COST',name:'Costco Wholesale'},{symbol:'HD',name:'Home Depot Inc'},{symbol:'MCD',name:"McDonald's Corp"},
    {symbol:'SBUX',name:'Starbucks Corp'},{symbol:'NKE',name:'Nike Inc'},{symbol:'PG',name:'Procter & Gamble'},{symbol:'KO',name:'Coca-Cola Co'},
    {symbol:'PEP',name:'PepsiCo Inc'},{symbol:'PM',name:'Philip Morris'},{symbol:'MO',name:'Altria Group'},{symbol:'TGT',name:'Target Corp'},
    {symbol:'LOW',name:"Lowe's Companies"},{symbol:'DIS',name:'Walt Disney Co'},{symbol:'CMG',name:'Chipotle Mexican Grill'},
    {symbol:'BA',name:'Boeing Co'},{symbol:'CAT',name:'Caterpillar Inc'},{symbol:'GE',name:'General Electric'},{symbol:'HON',name:'Honeywell Intl'},
    {symbol:'UPS',name:'UPS'},{symbol:'RTX',name:'RTX Corp'},{symbol:'LMT',name:'Lockheed Martin'},{symbol:'GD',name:'General Dynamics'},
    {symbol:'NOC',name:'Northrop Grumman'},
    {symbol:'COIN',name:'Coinbase Global'},{symbol:'MSTR',name:'MicroStrategy'},{symbol:'PLTR',name:'Palantir Technologies'},{symbol:'RKLB',name:'Rocket Lab USA'},
    {symbol:'SOFI',name:'SoFi Technologies'},{symbol:'HOOD',name:'Robinhood Markets'},{symbol:'UPST',name:'Upstart Holdings'},
    {symbol:'DDOG',name:'Datadog Inc'},{symbol:'MDB',name:'MongoDB Inc'},{symbol:'CFG',name:'Citizens Financial'},{symbol:'NU',name:'Nu Holdings'},
    {symbol:'CELH',name:'Celsius Holdings'},
    {symbol:'BTC-USD',name:'Bitcoin USD'},{symbol:'ETH-USD',name:'Ethereum USD'},{symbol:'SOL-USD',name:'Solana USD'},{symbol:'XRP-USD',name:'XRP USD'},
    {symbol:'DOGE-USD',name:'Dogecoin USD'},{symbol:'ADA-USD',name:'Cardano USD'},{symbol:'AVAX-USD',name:'Avalanche USD'},
    {symbol:'DOT-USD',name:'Polkadot USD'},{symbol:'LINK-USD',name:'Chainlink USD'},{symbol:'LTC-USD',name:'Litecoin USD'},
    {symbol:'UNI-USD',name:'Uniswap USD'},{symbol:'ATOM-USD',name:'Cosmos USD'},
    {symbol:'EURUSD=X',name:'EUR/USD'},{symbol:'GBPUSD=X',name:'GBP/USD'},{symbol:'USDJPY=X',name:'USD/JPY'},{symbol:'USDCHF=X',name:'USD/CHF'},
    {symbol:'USDCAD=X',name:'USD/CAD'},{symbol:'AUDUSD=X',name:'AUD/USD'},{symbol:'NZDUSD=X',name:'NZD/USD'},
    {symbol:'GBPJPY=X',name:'GBP/JPY'},{symbol:'EURJPY=X',name:'EUR/JPY'},{symbol:'DX-Y.NYB',name:'US Dollar Index'},
    {symbol:'GC=F',name:'Gold Futures'},{symbol:'SI=F',name:'Silver Futures'},{symbol:'CL=F',name:'Crude Oil'},{symbol:'NG=F',name:'Natural Gas'},
    {symbol:'ZC=F',name:'Corn Futures'},{symbol:'ZW=F',name:'Wheat Futures'},{symbol:'CT=F',name:'Cotton Futures'},
    {symbol:'HG=F',name:'Copper Futures'},{symbol:'PA=F',name:'Palladium Futures'},{symbol:'PL=F',name:'Platinum Futures'},
  ];
  let selectedIdx = -1;

  function renderDropdown(filter: string) {
    const q = filter.toUpperCase().trim();
    const filtered = q
      ? securitiesCache.filter(s => s.symbol.includes(q) || s.name.toUpperCase().includes(q))
      : securitiesCache;
    if (filtered.length === 0) {
      symbolDropdown.innerHTML = `<div style="padding:6px 10px;color:rgba(255,255,255,0.3)">No match — press Enter for "${escapeHtml(filter)}"</div>`;
      symbolDropdown.style.display = 'block'; orientToolbarPopover(symbolDropdown);
      return;
    }
    symbolDropdown.innerHTML = filtered.map((s, i) =>
      `<div class="sym-item" data-idx="${i}" data-sym="${escapeHtml(s.symbol)}" style="padding:5px 10px;cursor:pointer;display:flex;justify-content:space-between;color:rgba(255,255,255,0.7);border-bottom:1px solid rgba(255,255,255,0.03);background:${i === selectedIdx ? 'rgba(0,204,255,0.12)' : 'transparent'}">
        <span>${escapeHtml(s.symbol)}</span>
        <span style="color:rgba(255,255,255,0.25);font-size:9px">${escapeHtml(s.name)}</span>
      </div>`
    ).join('') + `<div class="sym-item" data-sym="${escapeHtml(filter)}" style="padding:4px 10px;cursor:pointer;color:rgba(0,204,255,0.4);font-size:9px;border-top:1px solid rgba(255,255,255,0.05)">↩ Use "${escapeHtml(filter)}" as custom symbol</div>`;
    symbolDropdown.style.display = 'block'; orientToolbarPopover(symbolDropdown);
    symbolDropdown.querySelectorAll('.sym-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const sym = (el as HTMLElement).dataset.sym || '';
        if (sym) {
          symbolInput.value = sym;
          symbolDropdown.style.display = 'none';
          loadLiveData(sym);
          setTimeout(() => fetchNews(), 1500);
        }
      });
    });
  }

  symbolInput?.addEventListener('focus', () => renderDropdown(symbolInput.value));
  symbolInput?.addEventListener('input', () => { selectedIdx = -1; renderDropdown(symbolInput.value); });
  symbolInput?.addEventListener('blur', () => setTimeout(() => { symbolDropdown.style.display = 'none'; }, 200));
  symbolInput?.addEventListener('keydown', (e) => {
    const items = symbolDropdown.querySelectorAll('.sym-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      renderDropdown(symbolInput.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, -1);
      renderDropdown(symbolInput.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      symbolDropdown.style.display = 'none';
      if (selectedIdx >= 0 && selectedIdx < items.length) {
        const sym = (items[selectedIdx] as HTMLElement).dataset.sym || '';
        if (sym) { symbolInput.value = sym; loadLiveData(sym); setTimeout(() => fetchNews(), 1500); }
      } else {
        const val = symbolInput.value.toUpperCase().trim();
        if (val) loadLiveData(val);
      }
    } else if (e.key === 'Escape') {
      symbolDropdown.style.display = 'none';
    }
  });

  // ─── Settings Panel ──────────────────────────────────────────────
  const settingsPanel = document.getElementById('settings-panel');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsClose = document.getElementById('settings-close');
  settingsToggle?.addEventListener('click', () => {
    settingsPanel?.classList.toggle('active');
    if (settingsPanel?.classList.contains('active')) loadSettingsUI();
  });
  settingsClose?.addEventListener('click', () => settingsPanel?.classList.remove('active'));

  // Settings: Open OakScript Editor button
  document.getElementById('set-open-editor')?.addEventListener('click', () => {
    const vis2 = toggleEditor();
    oakScriptEnabled = vis2;
    settingsPanel?.classList.remove('active');
    updateUI();
  });

  document.getElementById('perf-select')?.addEventListener('change', () => {
    const val = (document.getElementById('perf-select') as HTMLSelectElement)?.value;
    if (val === 'auto') {
      // Hand control back to the adaptive governor.
      perfAuto = true;
      perfGovernor.setEnabled(true);
      return;
    }
    if (val === 'low' || val === 'medium' || val === 'high' || val === 'ultra') {
      // User pinned a fixed tier — stop auto-adapting.
      perfAuto = false;
      perfGovernor.setEnabled(false);
      perfGovernor.setTier(val);
      perfMode = val;
      setPerfMode(val);
      setParticleCount(tierParticleCount(val));
    }
  });

  document.getElementById('chart-reset')?.addEventListener('click', () => {
    // Restore the view to its initial state: newest bars in view, default zoom,
    // no vertical pan or price-scale stretch.
    view.scrollX = 0;
    view.barSpacing = DEFAULT_BAR_SPACING;
    view.offsetY = 0;
    view.scaleY = 1;
    visualAdapter.logAction('reset', 'Chart view reset to default');
    updateUI();
  });

  document.getElementById('toolbar-collapse')?.addEventListener('click', () => {
    const tb = document.getElementById('toolbar');
    const btn = document.getElementById('toolbar-collapse');
    if (!tb || !btn) return;
    const collapsed = tb.classList.toggle('collapsed');
    for (const c of Array.from(tb.children)) {
      if (c === btn || (c as HTMLElement).classList?.contains('label')) continue;
      (c as HTMLElement).style.display = collapsed ? 'none' : '';
    }
    btn.textContent = collapsed ? 'Menu »' : '«';
  });

  // Make toolbar draggable
  const tbar = document.getElementById('toolbar');
  if (tbar) {
    tbar.style.cursor = 'grab';
    let tOffX = 0, tOffY = 0;
    tbar.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'INPUT') return;
      tOffX = e.clientX - tbar.offsetLeft;
      tOffY = e.clientY - tbar.offsetTop;
      tbar.style.cursor = 'grabbing';
      const onMove = (ev: MouseEvent) => {
        tbar.style.transform = 'none';
        tbar.style.left = Math.max(0, Math.min(window.innerWidth - 200, ev.clientX - tOffX)) + 'px';
        tbar.style.bottom = 'auto';
        tbar.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - tOffY)) + 'px';
      };
      const onUp = () => {
        tbar.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // Resizable toolbar — drag the right-edge handle to change max-width (the
  // toolbar wraps its buttons onto more/fewer rows as it narrows/widens).
  const resizeHandle = document.getElementById('toolbar-resize-handle');
  if (tbar && resizeHandle) {
    try {
      const savedWidth = localStorage.getItem('dafe_toolbar_maxwidth');
      if (savedWidth) tbar.style.maxWidth = `${savedWidth}px`;
    } catch {}
    let startW = 0, startMX = 0;
    resizeHandle.addEventListener('mousedown', (e) => {
      startW = tbar.getBoundingClientRect().width;
      startMX = (e as MouseEvent).clientX;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startMX;
        const newW = Math.max(320, Math.min(window.innerWidth * 0.98, startW + dx * 2));
        tbar.style.maxWidth = `${newW}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem('dafe_toolbar_maxwidth', String(parseFloat(tbar.style.maxWidth))); } catch {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // Draggable settings
  const settingsHeader = document.getElementById('settings-header');
  if (settingsPanel && settingsHeader) {
    let sOffX = 0, sOffY = 0;
    settingsHeader.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      sOffX = e.clientX - settingsPanel.offsetLeft;
      sOffY = e.clientY - settingsPanel.offsetTop;
      const onMove = (ev: MouseEvent) => {
        settingsPanel.style.left = (ev.clientX - sOffX) + 'px';
        settingsPanel.style.top = (ev.clientY - sOffY) + 'px';
        settingsPanel.style.transform = 'none';
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  async function loadSettingsUI() {
    try {
      const resp = await fetch(`${BACKEND_URL}/api/settings`);
      const data = await resp.json();
      const s = (id: string) => (document.getElementById(id) as HTMLInputElement);
      const sel = (id: string) => (document.getElementById(id) as HTMLSelectElement);
      if (data.massive_api_key_masked) s('set-massive-key').value = data.massive_api_key_masked;
      if (data.serpapi_api_key_masked) s('set-serp-key').value = data.serpapi_api_key_masked;
      if (data.tradovate_password_masked) s('set-tradovate-pass').value = data.tradovate_password_masked;
      if (data.tradovate_username) s('set-tradovate-user').value = data.tradovate_username;
      if (data.tradovate_environment) sel('set-tradovate-env').value = data.tradovate_environment;
      const advisorProvider = data.llm_provider || 'local';
      const coderProvider = data.llm_coder_provider || 'local';
      // Set both provider selects BEFORE populating the Ollama dropdowns —
      // the dropdowns are filtered (local vs cloud tags) by these values.
      sel('set-llm-provider').value = advisorProvider;
      sel('set-coder-provider').value = coderProvider;
      if (data.ollama_base_url) s('set-ollama-url').value = data.ollama_base_url;

      // Populate model dropdowns from backend
      await populateModelDropdowns();
      await populateOllamaDropdowns();

      // Restore advisor model into the right field for its provider.
      if (advisorProvider.startsWith('ollama')) {
        sel('set-advisor-model-cloud').value = data.llm_trade_advisor_model && data.llm_trade_advisor_model !== 'auto' ? data.llm_trade_advisor_model : '';
      } else if (data.llm_trade_advisor_model) {
        sel('set-advisor-model').value = data.llm_trade_advisor_model;
      }
      applyAdvisorProviderUI(advisorProvider);
      // Coder: restore its model into the field matching its provider.
      if (coderProvider.startsWith('ollama')) {
        sel('set-coder-model-cloud').value = data.llm_coder_model && data.llm_coder_model !== 'auto' ? data.llm_coder_model : '';
      } else if (data.llm_coder_model) {
        sel('set-coder-model').value = data.llm_coder_model;
      }
      applyCoderProviderUI(coderProvider);
      // Point the advisor agent at the model that will actually serve it, so
      // token budgeting resolves the right context (Ollama tags carry their
      // real ctx as an override; local names track the llama.cpp process).
      if (data.llm_trade_advisor_model && data.llm_trade_advisor_model !== 'auto') {
        advisor.config.model = data.llm_trade_advisor_model;
      }

      // Hardware info
      try {
        const hwResp = await fetch(`${BACKEND_URL}/api/hardware`);
        const hw = await hwResp.json();
        if (hw.ok) {
          const info = hw.hardware;
          const hwEl = document.getElementById('set-hardware-info');
          if (hwEl) {
            const parts = [];
            if (info.gpu) parts.push(`GPU: ${info.gpu_name} (${info.vram_mb}MB)`);
            parts.push(`CPU: ${info.cpu_cores} cores`);
            if (info.ram_gb) parts.push(`RAM: ${info.ram_gb}GB`);
            parts.push(`Suggested ctx: ${info.suggested_ctx}`);
            hwEl.textContent = parts.join(' | ');
          }
        }
      } catch {}

      const voicePref = localStorage.getItem('dafe_voice_pref') || 'auto';
      const voiceSel = sel('set-voice');
      if (voiceSel) voiceSel.value = voicePref;

      const bgSel = sel('set-bg-viz');
      if (bgSel) {
        // Only set the dropdown's displayed value — do NOT mutate the live
        // bgViz variable here. Opening settings (or toggling the dropdown)
        // must not change the active background before Save is clicked;
        // otherwise the star background flips to "plain" the moment the
        // panel opens. The Save handler applies the choice for real.
        bgSel.value = data.bg_viz || bgViz;
      }
      if (data.market_data_source) {
        sel('set-data-source').value = data.market_data_source;
        applyDataSourceMode(data.market_data_source);
      }

      const hkMap: Record<string, string> = {hk3d:'hotkey_3d',hkvp:'hotkey_vp',hkframe:'hotkey_frame',hkoak:'hotkey_oak',hktrend:'hotkey_trend',hkhline:'hotkey_hline',hkray:'hotkey_ray',hkrect:'hotkey_rect',hkfib:'hotkey_fib',hkchannel:'hotkey_channel',hktext:'hotkey_text',hkundo:'hotkey_undo',hkclear:'hotkey_clear',hkdeselect:'hotkey_deselect'};
      for (const [id, key] of Object.entries(hkMap)) {
        const el = document.getElementById('hk-' + id.replace('hk','')) as HTMLInputElement;
        if (el && data[key]) el.value = data[key];
      }
    } catch { /* silent */ }
    // Re-apply any locally-saved edits on top of the backend defaults so the
    // user's choices survive closing/reopening the panel even when the backend
    // is offline (the fetch above just fails silently in that case).
    restoreSettingsForm();
  }

  // Generic client-side persistence for the settings form so toggling the panel
  // doesn't wipe unsaved selections. Excluded from this:
  //  - secret/masked fields — they live on the backend, never mirrored locally.
  //  - LLM provider/model fields — these are already authoritatively loaded
  //    from the backend's /api/settings response (and the Ollama dropdowns are
  //    rebuilt live from the daemon's actual model list) every time the panel
  //    opens. Re-applying a stale local snapshot on top of that after-the-fact
  //    was clobbering a correctly-saved "ollama" provider back to whatever
  //    value (often "local") happened to be cached from before — the exact
  //    "everything keeps reverting to local" bug.
  const SETTINGS_LOCAL_KEY = 'dafe_settings_form';
  const SETTINGS_EXCLUDED_IDS = new Set([
    'set-massive-key', 'set-serp-key', 'set-tradovate-pass',
    'set-llm-provider', 'set-ollama-url', 'set-advisor-model', 'set-advisor-model-cloud',
    'set-coder-provider', 'set-coder-model', 'set-coder-model-cloud',
  ]);
  function snapshotSettingsForm(): void {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    const out: Record<string, string | boolean> = {};
    panel.querySelectorAll('input, select, textarea').forEach((el) => {
      const e = el as HTMLInputElement;
      if (!e.id || SETTINGS_EXCLUDED_IDS.has(e.id)) return;
      out[e.id] = e.type === 'checkbox' ? e.checked : e.value;
    });
    try { localStorage.setItem(SETTINGS_LOCAL_KEY, JSON.stringify(out)); } catch {}
  }
  function restoreSettingsForm(): void {
    let saved: Record<string, string | boolean> | null = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_LOCAL_KEY) || 'null'); } catch {}
    if (!saved) return;
    for (const [id, val] of Object.entries(saved)) {
      // Defensive: skip excluded ids even if an older snapshot (saved before
      // this exclusion existed) still has them cached.
      if (SETTINGS_EXCLUDED_IDS.has(id)) continue;
      const e = document.getElementById(id) as HTMLInputElement | null;
      if (!e) continue;
      if (e.type === 'checkbox') e.checked = Boolean(val);
      else e.value = String(val);
    }
  }
  // Persist on any change within the panel.
  document.getElementById('settings-panel')?.addEventListener('change', snapshotSettingsForm);

  // ─── Paper Trading settings (client-side only — no backend round trip) ──
  function updateTradeFormulaPreview(): void {
    const preview = document.getElementById('set-trade-formula-preview');
    if (!preview) return;
    const cfg = broker.getConfig();
    const lastPrice = transformed[transformed.length - 1]?.close ?? 100;
    const qty = parseFloat((document.getElementById('tradeQuantity') as HTMLInputElement)?.value || '1') || 1;
    const c = describeCommission(cfg.commission, qty);
    const sl = describeSlippage(cfg.slippage, lastPrice);
    preview.innerHTML = `Commission: ${c.formula}<br>Slippage: ${sl.formula}`;
  }
  function applyTradeSettingsFromForm(): void {
    const cashEl = document.getElementById('set-trade-cash') as HTMLInputElement;
    const commModeEl = document.getElementById('set-trade-comm-mode') as HTMLSelectElement;
    const commValEl = document.getElementById('set-trade-comm-value') as HTMLInputElement;
    const slipModeEl = document.getElementById('set-trade-slip-mode') as HTMLSelectElement;
    const slipValEl = document.getElementById('set-trade-slip-value') as HTMLInputElement;
    const tickSizeEl = document.getElementById('set-trade-tick-size') as HTMLInputElement;
    const commission: CommissionConfig = { mode: (commModeEl?.value || 'per-trade') as CommissionMode, value: parseFloat(commValEl?.value || '1') || 0 };
    const slippage = { mode: (slipModeEl?.value || 'fixed-ticks') as SlippageMode, value: parseFloat(slipValEl?.value || '1') || 0, tickSize: parseFloat(tickSizeEl?.value || '0.01') || 0.01 };
    broker.updateConfig({ commission, slippage });
    saveTradeSettings({ cash: parseFloat(cashEl?.value || '100000') || 100000, commission, slippage });
    updateTradeFormulaPreview();
  }
  function populateTradeSettingsUI(): void {
    const cfg = broker.getConfig();
    const s = (id: string) => document.getElementById(id) as HTMLInputElement;
    const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
    if (s('set-trade-cash')) s('set-trade-cash').value = String(cfg.startingCash);
    if (sel('set-trade-comm-mode')) sel('set-trade-comm-mode').value = cfg.commission.mode;
    if (s('set-trade-comm-value')) s('set-trade-comm-value').value = String(cfg.commission.value);
    if (sel('set-trade-slip-mode')) sel('set-trade-slip-mode').value = cfg.slippage.mode;
    if (s('set-trade-slip-value')) s('set-trade-slip-value').value = String(cfg.slippage.value);
    if (s('set-trade-tick-size')) s('set-trade-tick-size').value = String(cfg.slippage.tickSize);
    const hideEl = document.getElementById('set-trade-hide-markers') as HTMLInputElement;
    if (hideEl) hideEl.checked = hideTradeMarkers;
    updateTradeFormulaPreview();
  }
  populateTradeSettingsUI();
  ['set-trade-cash', 'set-trade-comm-mode', 'set-trade-comm-value', 'set-trade-slip-mode', 'set-trade-slip-value', 'set-trade-tick-size'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', applyTradeSettingsFromForm);
    document.getElementById(id)?.addEventListener('input', updateTradeFormulaPreview);
  });
  document.getElementById('set-trade-hide-markers')?.addEventListener('change', (e) => {
    hideTradeMarkers = (e.target as HTMLInputElement).checked;
    try { localStorage.setItem('dafe_hide_trade_markers', hideTradeMarkers ? '1' : '0'); } catch {}
  });
  document.getElementById('set-trade-clear')?.addEventListener('click', () => {
    // Reset the account/positions/orders only — execution markers already
    // drawn on the chart are kept so past trades stay visible for reference.
    broker.reset();
    renderTradeAccount();
    renderTradePositions();
    renderTradeOrders();
    const note = document.getElementById('tradeFillNote');
    if (note) note.innerHTML = '';
    appendAdvisorMessage('system', 'Trade history cleared — account reset to a fresh starting balance.');
  });

  async function populateModelDropdowns() {
    try {
      const resp = await fetch(`${BACKEND_URL}/api/models`);
      const data = await resp.json();
      if (!data.ok || !data.models) return;
      const dropdowns = ['set-advisor-model', 'set-coder-model'];
      for (const ddId of dropdowns) {
        const dd = document.getElementById(ddId) as HTMLSelectElement;
        if (!dd) continue;
        // Keep "Auto-detect" option, clear the rest
        while (dd.options.length > 1) dd.remove(1);
        for (const m of data.models) {
          const opt = document.createElement('option');
          opt.value = m.name.replace('.gguf', '');
          // Show the context this model will get on THIS machine, when known.
          const ctx = m.recommended?.ctx;
          const ctxLabel = ctx ? ` · ${ctx >= 1024 ? (ctx / 1024) + 'k' : ctx} ctx` : '';
          opt.textContent = `${m.name.replace('.gguf', '')} (${m.size_gb}GB${ctxLabel})`;
          dd.appendChild(opt);
        }
      }
    } catch { /* silent */ }
  }

  // Refresh the shared Ollama model cache from the backend's /api/ollama/models
  // proxy (which lists every tag the local Ollama daemon knows — local AND
  // cloud), then fill each dropdown with only the slice matching its
  // provider's kind. Also registers each tag's REAL context size with the
  // token optimizer so Ollama models stop being budgeted against the local
  // llama.cpp context.
  async function populateOllamaDropdowns() {
    try {
      const resp = await fetch(`${BACKEND_URL}/api/ollama/models`);
      const data = await resp.json();
      ollamaModelCache = (data.ok && data.models) ? data.models : [];
      ollamaModelsError = data.ok ? '' : (data.detail || '');
      for (const m of ollamaModelCache) {
        if (m.name && m.context_length) setModelContextOverride(m.name, m.context_length);
      }
    } catch {
      ollamaModelCache = [];
      ollamaModelsError = 'Backend unreachable — Ollama model list unavailable';
    }
    const advisorProv = (document.getElementById('set-llm-provider') as HTMLSelectElement)?.value || 'local';
    const coderProv = (document.getElementById('set-coder-provider') as HTMLSelectElement)?.value || 'local';
    fillOllamaDropdown('set-advisor-model-cloud', ollamaKindFor(advisorProv));
    fillOllamaDropdown('set-coder-model-cloud', ollamaKindFor(coderProv));
  }

  document.getElementById('settings-save')?.addEventListener('click', async () => {
    const g = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value || '';
    const sel = (id: string) => (document.getElementById(id) as HTMLSelectElement)?.value || '';
    const body: Record<string, string> = {
      massive_api_key: g('set-massive-key'),
      serpapi_api_key: g('set-serp-key'),
      tradovate_username: g('set-tradovate-user'),
      tradovate_password: g('set-tradovate-pass'),
      tradovate_environment: sel('set-tradovate-env'),
      llm_provider: sel('set-llm-provider'),
      ollama_base_url: g('set-ollama-url') || 'http://localhost:11434',
      // "auto" lets the backend pick a tag of the right kind (local vs cloud)
      // from what the daemon actually has, instead of hardcoding a family.
      llm_trade_advisor_model: sel('set-llm-provider').startsWith('ollama')
        ? (g('set-advisor-model-cloud').trim() || 'auto')
        : sel('set-advisor-model'),
      llm_coder_provider: sel('set-coder-provider'),
      // Coder model comes from the Ollama dropdown when provider is ollama*.
      llm_coder_model: sel('set-coder-provider').startsWith('ollama')
        ? (g('set-coder-model-cloud').trim() || 'auto')
        : sel('set-coder-model'),
      market_data_source: sel('set-data-source'),
      bg_viz: sel('set-bg-viz'),
      hotkey_3d: g('hk-3d'), hotkey_vp: g('hk-vp'), hotkey_frame: g('hk-frame'),
      hotkey_oak: g('hk-oak'), hotkey_trend: g('hk-trend'), hotkey_hline: g('hk-hline'),
      hotkey_ray: g('hk-ray'), hotkey_rect: g('hk-rect'), hotkey_fib: g('hk-fib'),
      hotkey_channel: g('hk-channel'), hotkey_text: g('hk-text'), hotkey_undo: g('hk-undo'),
      hotkey_clear: g('hk-clear'), hotkey_deselect: g('hk-deselect'),
    };
    const btn = document.getElementById('settings-save') as HTMLButtonElement;
    const status = document.getElementById('settings-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
      const resp = await fetch(`${BACKEND_URL}/api/settings`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (status) {
        status.textContent = data.ok ? '✓ Settings saved successfully' : '✕ Error saving: ' + (data.detail || 'Unknown error');
        status.style.display = '';
        status.style.color = data.ok ? '#22cc88' : '#ff4477';
        setTimeout(() => { status.style.display = 'none'; }, 4000);
      }
      if (data.ok) {
        bgViz = (document.getElementById('set-bg-viz') as HTMLSelectElement)?.value as any || bgViz;
        const advisorProv = sel('set-llm-provider');
        const coderProv = sel('set-coder-provider');
        // Keep the advisor agent pointed at the model that will actually
        // serve it — an Ollama tag when on Ollama, the .gguf name when local.
        // (Previously this always took the LOCAL dropdown, so Ollama users'
        // token budgets were computed against a local model.)
        const advisorModel = advisorProv.startsWith('ollama')
          ? g('set-advisor-model-cloud').trim()
          : sel('set-advisor-model');
        if (advisorModel && advisorModel !== 'auto') advisor.config.model = advisorModel;
        // Hot-reload only manages the local llama.cpp process — trigger it
        // only when a role actually runs locally and its model changed.
        if (advisorProv === 'local' || coderProv === 'local') {
          const newModel = advisorProv === 'local' ? sel('set-advisor-model') : sel('set-coder-model');
          if (newModel && newModel !== (window as any).__dafeLastModel) {
            (window as any).__dafeLastModel = newModel;
            switchModelNow();
          }
        }
        // Massive key may have just been added/removed — re-check which
        // sub-minute timeframes are actually servable.
        refreshProviderCapabilities();
      }
    } catch (err: any) {
      if (status) {
        status.textContent = '✕ Connection error - is backend running?';
        status.style.display = '';
        status.style.color = '#ff4477';
        setTimeout(() => { status.style.display = 'none'; }, 4000);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Settings'; }
    }
  });

  // ── Hot-swap model button ──
  async function switchModelNow(): Promise<void> {
    const status = document.getElementById('set-switch-status');
    const btn = document.getElementById('set-switch-model') as HTMLButtonElement;
    if (!status || !btn) return;
    status.style.display = '';
    status.textContent = 'Stopping current model...';
    status.style.color = '#FFB800';
    btn.disabled = true;
    try {
      // /api/model/reload only manages the LOCAL llama.cpp process — it
      // resolves whatever "model" string it's given against .gguf files on
      // disk. Sending it an Ollama model id (e.g. "qwen3-coder:480b-cloud")
      // doesn't error, it just fails to match and silently falls back to
      // auto-picking a local model that fits available VRAM — which is how
      // this button previously ended up hot-loading a small local model out
      // from under a user who had explicitly selected Ollama for both roles.
      // Ollama models don't need "reloading" at all — the model name is sent
      // fresh with every chat request — so only ever hit this endpoint when
      // at least one role is actually configured to run locally.
      const advisorProvider = (document.getElementById('set-llm-provider') as HTMLSelectElement)?.value || 'local';
      const coderProvider = (document.getElementById('set-coder-provider') as HTMLSelectElement)?.value || 'local';
      // Only the explicit "local" provider runs on the llama.cpp process.
      // (The old check was `!== 'ollama'`, which mis-classified any other
      // provider value — e.g. "ollama-cloud" — as local.)
      const advisorIsLocal = advisorProvider === 'local';
      const coderIsLocal = coderProvider === 'local';

      if (!advisorIsLocal && !coderIsLocal) {
        status.textContent = 'Both roles use Ollama — no local reload needed, model is selected per-request.';
        status.style.color = '#22cc88';
        resetAdvisorChat();
        return;
      }

      const autoOn = (document.getElementById('set-model-auto') as HTMLInputElement)?.checked;
      // Prefer whichever role is actually local — the coder's local model if
      // the coder is local, otherwise the advisor's (there is one local
      // llama.cpp process shared by both roles, so only one can be "hot").
      const chosen = coderIsLocal
        ? (document.getElementById('set-coder-model') as HTMLSelectElement)?.value
        : (document.getElementById('set-advisor-model') as HTMLSelectElement)?.value;
      const model = autoOn ? 'auto' : (chosen || 'auto');
      status.textContent = `Loading ${model}... (may take 30-60s)`;
      const resp = await fetch(`${BACKEND_URL}/api/model/reload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await resp.json();
      if (data.ok) {
        status.textContent = `✓ ${data.model || model} loaded (ctx: ${data.ctx || '?'})`;
        status.style.color = '#22cc88';
        // Refresh token optimizer with new context size
        import('./trade-advisor/token-optimizer').then(m => m.prefetchModelProfile());
        resetAdvisorChat(`Now running ${data.model || model}.`);
      } else if (data.loading) {
        // Model is still loading (large / partially-offloaded). Poll status
        // until it becomes ready instead of reporting a hard failure.
        status.textContent = `${data.model || model} loading… still warming up`;
        status.style.color = '#FFB800';
        const ok = await pollModelReady(180_000);
        if (ok) {
          status.textContent = `✓ ${data.model || model} ready`;
          status.style.color = '#22cc88';
          import('./trade-advisor/token-optimizer').then(m => m.prefetchModelProfile());
          resetAdvisorChat(`Now running ${data.model || model}.`);
        } else {
          status.textContent = `⚠ ${data.model || model} still loading — try chatting in a moment`;
          status.style.color = '#FFB800';
        }
      } else {
        status.textContent = `✕ ${data.detail || 'Failed to load'}`;
        status.style.color = '#ff4477';
      }
    } catch (err: any) {
      status.textContent = '✕ Backend unreachable — is it running?';
      status.style.color = '#ff4477';
    } finally {
      btn.disabled = false;
      setTimeout(() => { status.style.display = 'none'; }, 10000);
    }
  }

  // Poll /api/model/status until the server reports a running model.
  async function pollModelReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const r = await fetch(`${BACKEND_URL}/api/model/status`);
        const d = await r.json();
        if (d.ok && d.running) return true;
      } catch {}
    }
    return false;
  }

  document.getElementById('set-switch-model')?.addEventListener('click', switchModelNow);

  document.getElementById('set-voice')?.addEventListener('change', () => {
    const val = (document.getElementById('set-voice') as HTMLSelectElement)?.value || 'auto';
    voice.setVoicePreference(val as any);
  });

  // Background viz is only applied on Save — changing the dropdown here must
  // NOT mutate the live bgViz, or the background flips before saving.
  document.getElementById('set-bg-viz')?.addEventListener('change', () => {
    // no-op live; the Save button reads this dropdown's value and applies it.
  });

  document.getElementById('set-data-source')?.addEventListener('change', () => {
    applyDataSourceMode((document.getElementById('set-data-source') as HTMLSelectElement)?.value || 'yahoo');
  });

  document.getElementById('set-coder-provider')?.addEventListener('change', () => {
    applyCoderProviderUI((document.getElementById('set-coder-provider') as HTMLSelectElement)?.value || 'local');
  });

  document.getElementById('set-llm-provider')?.addEventListener('change', () => {
    applyAdvisorProviderUI((document.getElementById('set-llm-provider') as HTMLSelectElement)?.value || 'local');
  });

  // ─── News Box ────────────────────────────────────────────────────
  const newsBody = document.getElementById('news-body');
  const newsList = document.getElementById('news-list');
  document.getElementById('news-toggle')?.addEventListener('click', () => {
    newsBody?.classList.toggle('collapsed');
    const btn = document.getElementById('news-toggle');
    if (btn) btn.textContent = newsBody?.classList.contains('collapsed') ? '+' : '−';
  });

  let firstNewsLoad = true;

  async function fetchNews(options?: { silent?: boolean }) {
    if (!newsList) return;
    const sym = currentSymbol;
    const isSilent = options?.silent || !firstNewsLoad;
    try {
      const [newsResp, earningsResp, fedResp, econResp] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/api/web-search/search`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({query: `${sym} stock`, category: 'news'}),
        }),
        fetch(`${BACKEND_URL}/api/web-search/search`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({query: `${sym} earnings`, category: 'earnings'}),
        }),
        fetch(`${BACKEND_URL}/api/web-search/search`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({query: 'federal reserve fed chair speech market', category: 'news'}),
        }),
        fetch(`${BACKEND_URL}/api/web-search/search`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({query: 'economic calendar fed meeting FOMC minutes release this week', category: 'news'}),
        }),
      ]);
      const items: Array<{title:string;url:string;tag:string;fetchedAt:string}> = [];
      let hasFedWarning = false;
      let fedEventTitle = '';
      const fedKeywords = ['fomc', 'federal reserve', 'fed chair', 'jerome powell', 'interest rate', 'fed speech', 'fed meeting', 'fomc minutes', 'fed decision', 'monetary policy'];
      const fetchTime = new Date();
      const fetchTimeStr = fetchTime.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      for (const result of [newsResp, earningsResp, fedResp, econResp]) {
        if (result.status !== 'fulfilled') continue;
        const data = await result.value.json();
        if (data.ok && data.results) {
          let tag = 'news';
          if (result === earningsResp) tag = 'earnings';
          else if (result === fedResp || result === econResp) tag = 'fed';
          for (const r of data.results.slice(0, 4)) {
            const title = r.title || r.snippet || '';
            items.push({title, url: r.url || '', tag, fetchedAt: fetchTimeStr});
            if (tag === 'fed' && fedKeywords.some(k => title.toLowerCase().includes(k))) {
              hasFedWarning = true;
              if (!fedEventTitle) fedEventTitle = title;
            }
          }
        }
      }
      if (items.length === 0) {
        if (!isSilent) newsList.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,0.2);padding:12px;min-height:40px">No recent news</div>';
        return;
      }
      const eventTime = fedEventTitle ? extractEventTime(fedEventTitle) : '';
      const fedBanner = hasFedWarning
        ? `<div style="background:rgba(255,200,0,0.15);border:1px solid rgba(255,200,0,0.4);color:#ffcc00;padding:6px 8px;margin-bottom:6px;border-radius:4px;font-size:11px;font-weight:600"><span style="float:right;font-size:9px;opacity:0.6;font-weight:400">${fetchTimeStr}</span>⚠ FED EVENT${eventTime ? ' — ' + eventTime : ''} — Expect volatility</div>`
        : '';
      const html = fedBanner + items.map(i =>
        `<div class="news-item" onclick="window.open('${i.url.replace(/'/g,'')}','_blank')">
          <div class="news-title">${i.title}</div>
          <div class="news-meta"><span class="news-tag${i.tag === 'earnings' ? ' earnings' : i.tag === 'fed' ? ' risk' : ''}">${i.tag}</span><span style="margin-left:auto;opacity:0.4;font-size:9px">${i.fetchedAt}</span></div>
        </div>`
      ).join('');
      newsList.innerHTML = html;
    } catch {
      if (!isSilent) newsList.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,0.2);padding:12px;min-height:40px">News unavailable</div>';
    }
    firstNewsLoad = false;
  }

  // Helper: extract time from fed event title for local time display
  function extractEventTime(title: string): string {
    const timeMatch = title.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/);
    if (timeMatch) return 'Local: ' + timeMatch[0];
    const dateMatch = title.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/);
    if (dateMatch) return dateMatch[0];
    return '';
  }

  // Fetch news periodically — silent refreshes so no flash. Skip when the tab
  // is hidden or the news panel is collapsed to avoid pointless web-search load.
  setTimeout(() => fetchNews(), 3000);
  setInterval(() => {
    if (document.hidden) return;
    const body = document.getElementById('news-body');
    if (body && body.classList.contains('collapsed')) return;
    fetchNews({ silent: true });
  }, 300000);

  // ─── Trade Advisor Controls ─────────────────────────────────────
  const fab = document.getElementById('advisor-fab');
  const panel = document.getElementById('advisor-panel');
  fab?.addEventListener('click', () => {
    advisorOpen = !advisorOpen;
    panel?.classList.toggle('visible', advisorOpen);
    fab?.classList.toggle('open', advisorOpen);
    if (advisorOpen) {
      updateAdvisorContext();
      (document.getElementById('advisorInput') as HTMLTextAreaElement)?.focus();
    }
  });

  // ── Draggable advisor panel ──
  const advisorHeader = panel?.querySelector('.advisor-header') as HTMLElement;
  if (panel && advisorHeader) {
    let dragOffX = 0, dragOffY = 0;
    advisorHeader.style.cursor = 'grab';
    advisorHeader.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      dragOffX = e.clientX - panel.offsetLeft;
      dragOffY = e.clientY - panel.offsetTop;
      panel.classList.add('dragging');
      const onMove = (ev: MouseEvent) => {
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 100, ev.clientX - dragOffX)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dragOffY)) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const onUp = () => {
        panel.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  const advisorInput = document.getElementById('advisorInput') as HTMLTextAreaElement;
  advisorInput?.addEventListener('input', () => {
    advisorInput.style.height = 'auto';
    advisorInput.style.height = Math.min(advisorInput.scrollHeight, 90) + 'px';
  });
  advisorInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAdvisorMessage();
    }
  });
  document.getElementById('advisorSend')?.addEventListener('click', () => sendAdvisorMessage());

  document.getElementById('advisorAnalyze')?.addEventListener('click', analyzeChart);
  document.getElementById('advisorVoice')?.addEventListener('click', async () => {
    const ok = await voice.requestMicrophone();
    if (!ok) { return; }
    if (voice.getState() === 'listening' || voice.getState() === 'wake-waiting') {
      voice.stopWakeListening();
    } else {
      voice.startWakeListening();
    }
  });
  document.getElementById('advisorVoiceFree')?.addEventListener('click', async () => {
    const ok = await voice.requestMicrophone();
    if (!ok) { return; }
    voice.toggleContinuous();
    const btn = document.getElementById('advisorVoiceFree');
    if (btn) btn.style.background = voice.isContinuous() ? '#00ff88' : '';
  });
  function resetAdvisorChat(reason?: string): void {
    advisorMessages = [];
    // Also wipe the agent's own conversation history — clearing only the UI
    // list left the model still primed with the previous exchange, which
    // leaked stale context (and prior model's answers) into the next turn.
    advisor.clearHistory();
    const container = document.getElementById('advisorMessages');
    if (container) {
      const greeting = reason
        ? `New model loaded — chat reset for a clean start. ${reason}`
        : "Hi, I'm your Trade Advisor and assistant, how can I help you today?";
      container.innerHTML = `<div class="advisor-msg system">${escapeHtml(greeting)}</div>`;
    }
  }
  document.getElementById('advisorClear')?.addEventListener('click', () => resetAdvisorChat());
  (window as any).__resetAdvisorChat = resetAdvisorChat;

  document.getElementById('advisor-close')?.addEventListener('click', () => {
    advisorOpen = false;
    panel?.classList.remove('visible');
    fab?.classList.remove('open');
  });

  // ─── Trading Panel ─────────────────────────────────────────────
  const tradingPanel = document.getElementById('trading-panel');
  const tradingPanelHeader = document.getElementById('tradingPanelHeader');
  const tradingPanelCollapse = document.getElementById('tradingPanelCollapse');
  const tradingPanelClose = document.getElementById('tradingPanelClose');
  const tradingPanelBody = document.getElementById('tradingPanelBody');

  if (tradingPanelCollapse && tradingPanel) {
    tradingPanelCollapse.addEventListener('click', () => {
      tradingPanel.classList.toggle('collapsed');
      tradingPanelCollapse.textContent = tradingPanel.classList.contains('collapsed') ? '+' : '−';
    });
  }
  tradingPanelClose?.addEventListener('click', () => {
    if (tradingPanel) tradingPanel.style.display = 'none';
  });

  // ─── Widget Registry (close/reopen menu) ────────────────────────
  const newsBoxEl = document.getElementById('news-box');
  document.getElementById('news-close')?.addEventListener('click', () => {
    if (newsBoxEl) newsBoxEl.style.display = 'none';
  });

  registerWidget({
    name: 'Dashboard',
    show: () => dashboard.show(),
    hide: () => dashboard.hide(),
    isVisible: () => dashboard.panel.style.display !== 'none',
  });
  registerWidget({
    name: 'News & Events',
    show: () => { if (newsBoxEl) newsBoxEl.style.display = ''; },
    hide: () => { if (newsBoxEl) newsBoxEl.style.display = 'none'; },
    isVisible: () => !!newsBoxEl && newsBoxEl.style.display !== 'none',
  });
  registerWidget({
    name: 'Trade Advisor',
    show: () => {
      advisorOpen = true;
      panel?.classList.add('visible');
      fab?.classList.add('open');
      updateAdvisorContext();
    },
    hide: () => { advisorOpen = false; panel?.classList.remove('visible'); fab?.classList.remove('open'); },
    isVisible: () => !!panel?.classList.contains('visible'),
  });
  registerWidget({
    name: 'Trading',
    show: () => { if (tradingPanel) tradingPanel.style.display = ''; },
    hide: () => { if (tradingPanel) tradingPanel.style.display = 'none'; },
    isVisible: () => !!tradingPanel && tradingPanel.style.display !== 'none',
  });
  initWidgetMenu('widgets-toggle', 'widgets-menu');

  if (tradingPanel && tradingPanelHeader) {
    let tOffX = 0, tOffY = 0;
    tradingPanelHeader.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      tOffX = e.clientX - tradingPanel.offsetLeft;
      tOffY = e.clientY - tradingPanel.offsetTop;
      tradingPanel.classList.add('dragging');
      const onMove = (ev: MouseEvent) => {
        tradingPanel.style.left = Math.max(0, Math.min(window.innerWidth - 100, ev.clientX - tOffX)) + 'px';
        tradingPanel.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - tOffY)) + 'px';
        tradingPanel.style.right = 'auto';
      };
      const onUp = () => {
        tradingPanel.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // ─── Order form: type-dependent rows + submit ──────────────────
  const orderTypeSel = document.getElementById('tradeOrderType') as HTMLSelectElement | null;
  const limitRow = document.getElementById('tradeLimitRow');
  const stopRow = document.getElementById('tradeStopRow');
  const trailRow = document.getElementById('tradeTrailRow');
  function syncOrderRows(): void {
    const t = (orderTypeSel?.value || 'market') as OrderType;
    limitRow?.classList.toggle('hidden', t !== 'limit' && t !== 'stop-limit');
    stopRow?.classList.toggle('hidden', t !== 'stop' && t !== 'stop-limit');
    trailRow?.classList.toggle('hidden', t !== 'trailing-stop');
  }
  orderTypeSel?.addEventListener('change', syncOrderRows);
  syncOrderRows();

  document.getElementById('tradeCurrency')?.addEventListener('change', (e) => {
    tradeCurrencyOverride = (e.target as HTMLSelectElement).value;
    broker.updateConfig({ currency: tradeCurrencyOverride });
    const autoEl = document.getElementById('tradeCurrencyAuto');
    if (autoEl) autoEl.textContent = 'manual';
    renderTradeAccount();
  });

  function submitOrder(side: 'buy' | 'sell'): void {
    const qty = parseFloat((document.getElementById('tradeQuantity') as HTMLInputElement)?.value || '1') || 1;
    const type = (orderTypeSel?.value || 'market') as OrderType;
    const limitPrice = parseFloat((document.getElementById('tradeLimitPrice') as HTMLInputElement)?.value || '');
    const stopPrice = parseFloat((document.getElementById('tradeStopPrice') as HTMLInputElement)?.value || '');
    const trailAmount = parseFloat((document.getElementById('tradeTrailAmount') as HTMLInputElement)?.value || '');
    const trailIsPercent = (document.getElementById('tradeTrailUnit') as HTMLSelectElement)?.value === 'pct';

    if ((type === 'limit' || type === 'stop-limit') && !isFinite(limitPrice)) {
      appendAdvisorMessage('system', 'Enter a limit price for this order type.'); return;
    }
    if ((type === 'stop' || type === 'stop-limit') && !isFinite(stopPrice)) {
      appendAdvisorMessage('system', 'Enter a stop price for this order type.'); return;
    }
    if (type === 'trailing-stop' && !isFinite(trailAmount)) {
      appendAdvisorMessage('system', 'Enter a trail amount for this order type.'); return;
    }

    const order = broker.placeOrder({
      symbol: currentSymbol, side, type, qty,
      limitPrice: isFinite(limitPrice) ? limitPrice : undefined,
      stopPrice: isFinite(stopPrice) ? stopPrice : undefined,
      trailAmount: isFinite(trailAmount) ? trailAmount : undefined,
      trailIsPercent,
    });
    if (order.status === 'rejected') {
      appendAdvisorMessage('system', `Order rejected: ${order.rejectReason}`);
    } else if (order.status === 'working') {
      appendAdvisorMessage('system', `${side.toUpperCase()} ${qty} ${getQtyUnit(currentSymbol)} of ${currentSymbol} — ${type} order working`);
    }
    renderTradeOrders();
  }
  document.getElementById('tradeSell')?.addEventListener('click', () => submitOrder('sell'));
  document.getElementById('tradeBuy')?.addEventListener('click', () => submitOrder('buy'));
  document.getElementById('tradeCloseAll')?.addEventListener('click', () => closeAllPositions());

  updateUI();
  updateTradingPanel();

  // Resizable chart divider
  const splitter = document.getElementById('chart-splitter');

  // Make news widget draggable
  const newsBox = document.getElementById('news-box');
  const newsHeader = document.getElementById('news-header');
  if (newsBox && newsHeader) {
    let nX = 0, nY = 0;
    newsHeader.style.cursor = 'grab';
    newsHeader.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      nX = e.clientX - newsBox.offsetLeft;
      nY = e.clientY - newsBox.offsetTop;
      const onMove = (ev: MouseEvent) => {
        newsBox.style.left = Math.max(0, ev.clientX - nX) + 'px';
        newsBox.style.top = Math.max(0, ev.clientY - nY) + 'px';
        newsBox.style.right = 'auto';
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // Resizable chart divider handler
  if (splitter) {
    let sY = 0;
    splitter.addEventListener('mousedown', (e) => {
      sY = e.clientY;
      const onMove = (ev: MouseEvent) => {
        lowerHeight = Math.max(80, Math.min(500, lowerHeight + (sY - ev.clientY)));
        sY = ev.clientY;
        resize();
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }
});

// ─── Render loop ───────────────────────────────────────────────────
// Cache VP results across frames to avoid recomputing on every paint
let vpCacheKey = '';
let vpCacheResult: VPComputed | null = null;
let vpCacheBins: VolumeBin[] = [];

// Cache OakScript path data so it isn't rebuilt every frame
let oakPathKey = '';
interface OakPathCache {
  mainPlots: OakPlot[];
  sepPlots: OakPlot[];
}
let oakPathCache: OakPathCache | null = null;

// Content fingerprint of the unified 3D scene's plot3d series — distinct from
// oakPathKey (which only tracks plot COUNT). Scripts like ChronoSphere/Echo
// Chamber emit the same fixed number of plot3d() calls every bar, so a
// count-only key never changes after the indicator is first toggled on,
// and the 3D geometry rebuild (mark3DSceneDirty) would never fire again as
// new bars/ticks stream in — leaving indicator geometry frozen or absent
// while the bar group (built independently) keeps rendering.
let chart3DSig = '';

function frame(now: number) {
  // A throw anywhere in frameBody() must not kill the recursive rAF chain —
  // otherwise one bad render (e.g. NaN/Infinity from a buggy indicator
  // reaching the 3D builders) permanently freezes the canvas with no
  // visible error, which looks exactly like a browser crash to the user.
  try {
    frameBody(now);
  } catch (e) {
    console.error('[DAFE] frame() error — render loop recovering:', e);
  }
  requestAnimationFrame(frame);
}

function frameBody(now: number) {
  time = now;
  const { width, height } = canvas;

  // Adaptive performance governor — samples FPS and retunes quality live.
  perfGovernor.sample(now);

  updateSnapshotEveryNthFrame();

  // Compute visible range once per frame — shared by all drawing functions
  const { start: visStart, end: visEnd } = getVisibleRange(view, canvas.width, transformed.length);

  // Volume profile with cache
  const vpKey = `${visStart}_${visEnd}_${vpSettings.lookbackBars}_${vpSettings.binCount}_${vpSettings.valueAreaPct}_${vpSettings.mode}_${vpSettings.profileWidth}`;
  let vpComputed: VPComputed;
  let volumeBins: VolumeBin[];
  if (vpKey === vpCacheKey && vpCacheResult) {
    vpComputed = vpCacheResult;
    volumeBins = vpCacheBins;
  } else {
    vpCacheKey = vpKey;
    const profileBars = vpSettings.lookbackBars > 0
      ? transformed.slice(Math.max(0, transformed.length - vpSettings.lookbackBars))
      : transformed.slice(Math.max(0, visStart), Math.min(transformed.length, visEnd + 1));
    vpComputed = computeVolumeProfileBins(profileBars, vpSettings);
    vpCacheResult = vpComputed;
    volumeBins = vpComputed.bins;
    vpCacheBins = volumeBins;
  }

  // ── 3D indicator scene takes over when pane='3d' is active ──
  // getCombinedPlots() walks every plot of every active indicator (which can
  // be thousands of entries — plot()/hline() push once per BAR, not once per
  // indicator) — compute it once per frame here and reuse it below instead
  // of calling it again, which was doubling that cost on every single frame.
  const activeIndicators = hasActiveIndicators();
  const combined3d = activeIndicators ? getCombinedPlots() : null;
  const hasPane3d = combined3d ? combined3d.plot3d.some(p => p.pane === '3d') : false;

  if (hasPane3d) {
    // 3D indicator mode: render bars + indicator geometry in Three.js every frame
    renderMain3DScene(transformed, combined3d!.plot3d as OakPlot3D[], view, canvas.width, canvas.height);
    // Draw time axis on the 2D canvas (always needed)
    drawTimeAxis(ctx, transformed, view);
  } else if (is3DMode) {
    draw3DScene(ctx, transformed, view, {
      barType, perBarVols: vpiEnabled ? perBarVols : undefined,
      volumeBins, volumeMode: vpSettings.mode, visualEngine: vpSettings.visualEngine,
      volumeEnabled, vpiEnabled, time, profileWidth: vpSettings.profileWidth, vpComputed,
      bgViz,
    });
    drawTimeAxis(ctx, transformed, view);
  } else {
    // 2D mode — background layer based on bgViz
    if (bgViz === 'stars') drawBackground(ctx, time);
    else if (bgViz === 'graph') {
      // Subtle graph-paper grid
      ctx.fillStyle = '#080816';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(30,30,60,0.4)';
      ctx.lineWidth = 0.5;
      const gs = 40;
      for (let x = 0; x < width; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
      for (let y = 0; y < height; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    }
    else { ctx.fillStyle = '#0a0a18'; ctx.fillRect(0, 0, width, height); }
    drawGrid(ctx, transformed, view, time);
    drawBars(ctx, transformed, view, time, barType, vpiEnabled ? perBarVols : undefined);
    drawTimeAxis(ctx, transformed, view);
  }

  if (bgViz === 'particles') {
    updateGPUParticles(time);
    drawCPUParticles(ctx, time, width, height, perfMode === 'low' ? 0.4 : perfMode === 'medium' ? 0.7 : 1.0);
  }

  const is2DVolMode = vpSettings.mode === '2D-Side' || vpSettings.mode === '2D-Per-Bar';
  if (volumeEnabled && !hasPane3d && (!is3DMode || is2DVolMode)) {
    drawVolumeProfile(ctx, volumeBins, vpSettings.mode, time, vpComputed, vpSettings.profileWidth);
  }

  // OakScript plots — combined from all active indicator instances
  if (hasActiveIndicators()) {
    const combined = getCombinedPlots();
    const filterKey = combined.main.length + combined.sep.length + combined.plot3d.length;

    if (hasPane3d) {
      // Rebuild the 3D scene whenever the indicator's actual series data
      // changes (new bar/tick), not just when the plot count changes.
      const p3d = combined.plot3d as OakPlot3D[];
      const sig = p3d.map(p => `${p.name}|${p.style}|${p.pane}|${p.series.length}|${p.series[p.series.length - 1]}`).join(';');
      if (sig !== chart3DSig) {
        chart3DSig = sig;
        mark3DSceneDirty();
      }
    }

    if (String(filterKey) !== oakPathKey || !oakPathCache) {
      oakPathKey = String(filterKey);
      oakPathCache = { mainPlots: combined.main, sepPlots: combined.sep };

      if (hasPane3d) {
        // 3D indicator active: no separate pane 3D, no 2D overlays
        hide3D();
        if (isViz3DActive()) disposeViz();
      } else {
        // Regular mode: handle separate pane 3D + overlay 3D
        const sep3D = combined.plot3d.filter(p => p.pane === 'separate') as OakPlot3D[];
        show3D(sep3D);
        const main3D = combined.plot3d.filter(p => p.pane !== 'separate') as OakPlot3D[];
        if (main3D.length > 0 && !isViz3DActive()) toggle3DViz(transformed, view, canvas.width, canvas.height);
        if (main3D.length === 0 && isViz3DActive()) { disposeViz(); }
      }
    }
    if (filterKey > 0) {
      if (hasPane3d) {
        // 3D indicator active: clear secondary canvas, no 2D plots
        secCtx.fillStyle = '#0a0a18';
        secCtx.fillRect(0, 0, secCanvas.width, secCanvas.height);
      } else {
        if (oakPathCache.mainPlots.length > 0 && !isChart3DMode()) {
          drawOakScriptPlots(ctx, oakPathCache.mainPlots, transformed, view);
        }
        if (oakPathCache.sepPlots.length > 0) drawSecondaryChart(secCtx, oakPathCache.sepPlots, transformed, view);
      }
    } else {
      secCtx.fillStyle = '#0a0a18';
      secCtx.fillRect(0, 0, secCanvas.width, secCanvas.height);
      if (isViz3DActive()) disposeViz();
      if (isChart3DMode()) dispose3DScene();
      hide3D();
    }
  } else {
    secCtx.fillStyle = '#0a0a18';
    secCtx.fillRect(0, 0, secCanvas.width, secCanvas.height);
    if (isViz3DActive()) disposeViz();
    if (isChart3DMode()) dispose3DScene();
    hide3D();
  }

  if (!is3DMode && !hasPane3d) draw.drawAll(ctx, transformed, view);

  if (!hideTradeMarkers) drawTradeMarkers(ctx, transformed, view, tradeMarkersBySymbol.get(currentSymbol) || [], is3DMode);

  if (mouseX >= 0 && mouseY >= 0) {
    drawCrosshair(ctx, mouseX, mouseY);
    if (showTooltip) drawOHLCTooltip(ctx, transformed, view, mouseX, mouseY, barType);
  }

  // Status bar — only rebuild string when content changes (not every frame)
  const osCount = oakPathCache ? oakPathCache.mainPlots.length + oakPathCache.sepPlots.length : 0;
  const osErr = oakScriptErrors.length;
  const hybridActive = dataSourceMode === 'hybrid' && hybridEngine.isActive();
  const hybridSt = hybridActive ? hybridEngine.getStatus() : null;
  const hybridAcc = hybridSt ? (hybridSt.accuracy * 100).toFixed(1) : '';
  const hybridMode = hybridSt ? (hybridSt.mode === 'blend' ? 'blend' : hybridSt.mode === 'paid-only' ? 'paid' : 'synth') : '';
  const statusKey = `${currentSymbol}|${dataProviderLabel}|${is3DMode ? 3 : 2}|${barType}|${timeframe}|${volumeEnabled}|${vpSettings.mode}|${view.barSpacing.toFixed(1)}|${liveTicksEnabled}|${hybridAcc}|${hybridMode}`;
  if (statusKey !== (window as any).__dafeStatusKey) {
    (window as any).__dafeStatusKey = statusKey;
    const parts = [
      `DAFE ${currentSymbol}`,
      `Data: ${dataProviderLabel}`,
      `Mode: ${is3DMode ? '3D' : '2D'}`,
      `Type: ${barType}`,
      `TF: ${timeframe}`,
      `Live: ${liveTicksEnabled ? (hybridActive ? `⚡Hybrid ${hybridMode} ${hybridAcc}%` : '◆') : '-'}`,
      getMarketStatus(currentSymbol) === 'open' ? '●' : '○',
    ];
    if (osCount > 0 || osErr > 0) parts.push(`Oak: ${osCount}${osErr ? ` (${osErr} err)` : ''}`);
    parts.push(`Vol: ${volumeEnabled ? vpSettings.mode : 'OFF'}`);
    parts.push(`Zoom: ${view.barSpacing.toFixed(1)}px`);
    drawStatusBar(ctx, parts.join('  │  '));
  }
}

requestAnimationFrame(frame);
