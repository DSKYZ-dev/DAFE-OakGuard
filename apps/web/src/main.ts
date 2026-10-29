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
  getVisibleRange, visibleBarCount, getPriceRange,
  DEFAULT_BAR_SPACING, MIN_BAR_SPACING, MAX_BAR_SPACING, chartRight,
  setPerfMode,
  type ViewState, type TradeMarker,
} from './chart-renderer';
import {
  createEditor, toggleEditor, isEditorVisible,
  getIndicators, getCategories, type OakPlot,
  setSendErrorsCallback, setAgentActionCallback, setAgentChatCallback,
  setToggleVisibilityCallback, setImageAssetsChangedCallback, setChartContextCallback, registerEditorShortcuts, getDefaultScript,
  StdLib,
} from './oakscript';
import { getAllAssetsAsMap } from './oakscript/image-assets';
import {
  classifyRegime, createRegimeRibbon, createInitialRegimeState, applyHysteresis,
  type RegimeResult,
} from './regime-ribbon';
import { onLiveSignal } from './signal-engine';
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
import { appendLedgerEntry, showLedgerModal } from './ledger';
import { showStoryboardModal } from './storyboard';
import {
  signalColors, playTone,
  isAccessiblePaletteEnabled, setAccessiblePaletteEnabled,
  isSonificationEnabled, setSonificationEnabled,
} from './accessibility';
import { invalidateThemeCache } from './theme-engine';
import { validateCombination } from './rendering-matrix';
import { detectCurrency } from './trading/currency';
import type { OrderType } from './trading/broker-port';
import {
  addIndicator, removeIndicator, getActiveInstances,
  runAllInstances, getCombinedPlots, hasActiveIndicators,
  setInstanceOverrides, setInstanceEnabled, updateInstanceSource,
  setInstanceDashboardVisible, setInstanceAutoTradeArmed, getInstance,
  type IndicatorInstance,
} from './indicator-manager';
import { setMlRedrawCallback } from './ml-client';
import { mountOakGuardLauncher, openOakGuard } from './oakguard/panel';
import { mountVisualEditor } from './visual-editor';


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
// Background baseline is STARS on first load; a saved choice (Settings →
// Display) restores after that. The settings dropdown is initialized FROM
// this variable and applies immediately when changed (below).
let bgViz: 'particles' | 'stars' | 'graph' | 'plain' = 'stars';
try {
  const savedBg = localStorage.getItem('dafe_bg_viz');
  if (savedBg === 'stars' || savedBg === 'particles' || savedBg === 'graph' || savedBg === 'plain') bgViz = savedBg;
} catch { /* first load: stars */ }

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
// ANCHORED ticks: the simulator never rewrites price history. It captures
// the real last bar as an anchor and only wiggles the live close inside a
// tight band (±0.25%) around that anchor, mean-reverting toward it. The old
// unbounded per-tick random walk compounded 1.2% clamps every 300ms until
// the newest candle was a giant spike and the 3D scene's price-range
// normalization rescaled every extrusion around it. On stop/roll the live
// bar is restored to its anchor exactly, so price action is never distorted.
let liveTicksEnabled = false;
let liveTickTimer: ReturnType<typeof setInterval> | null = null;
let liveAnchor: { open: number; high: number; low: number; close: number; volume: number } | null = null;
let liveOffset = 0;
let liveTickVolume = 0;
function captureLiveAnchor(): void {
  const b = transformed[transformed.length - 1];
  if (!b) { liveAnchor = null; return; }
  liveAnchor = { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  liveOffset = 0;
  liveTickVolume = 0;
}
function restoreLiveAnchor(): void {
  const b = transformed[transformed.length - 1];
  if (!b || !liveAnchor) return;
  b.open = liveAnchor.open; b.high = liveAnchor.high; b.low = liveAnchor.low;
  b.close = liveAnchor.close; b.volume = liveAnchor.volume;
}
// Wall-clock time of the last bar roll — bars advance on real elapsed time, NOT
// on (now - lastBarTimestamp), which floods flat bars when the feed is delayed.
let lastBarRollTime = 0;

// Data source mode. 'hybrid' = correction-anchored blend of Massive (paid,
// sparse) + yfinance (free, frequent) + synthetic fill, for near-live accuracy
// at a fraction of the API cost.
let dataSourceMode: string = 'yahoo';
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
  captureLiveAnchor();

  const tickMs = 300;
  liveTickTimer = setInterval(() => {
    if (!liveTicksEnabled) return; // orphaned-interval guard: a stopped engine never ticks again
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
      // Commit the REAL anchor close, never the simulated wiggle.
      restoreLiveAnchor();
      const anchorClose = liveAnchor?.close ?? last.close;
      const newBar: BaseBar = {
        timestamp: nextBarTs,
        open: anchorClose, high: anchorClose, low: anchorClose, close: anchorClose, volume: 0,
      };
      // Transform-aware: push the bar through the current barType transform
      // so non-candlestick types (renko, kagi, range-bar, etc.) get proper
      // live bars instead of raw untransformed candles.
      bars.push({ ...newBar });
      const transformedNew = transformBars(bars, barType);
      // If the transform produced a new bar (e.g. renko brick), use it;
      // otherwise the raw bar is the live bar.
      if (transformedNew.length > transformed.length) {
        transformed = transformedNew;
      } else {
        transformed.push(newBar);
      }
      // Extend the per-bar volume profile so the new bar gets the same VPI
      // voxel/extrusion treatment as historical bars.
      perBarVols = generatePerBarVolumes(transformed, 12);
      if (useHybrid && hybridEngine.isActive()) {
        // Re-anchor the new bar to the last close, but do NOT recalibrate from
        // synthetic-polluted bars — that creates a drift feedback loop.
        hybridEngine.start(currentSymbol, anchorClose);
      }
      liveAnchor = { open: anchorClose, high: anchorClose, low: anchorClose, close: anchorClose, volume: 0 };
      liveOffset = 0;
      liveTickVolume = 0;
      // fall through so the fresh bar gets an immediate price move this tick
    }

    const live = transformed[transformed.length - 1];
    if (!liveAnchor) captureLiveAnchor();
    if (liveAnchor) {
      // Bounded, mean-reverting wiggle around the anchor — never a walk.
      const band = liveAnchor.close * 0.0025; // ±0.25% hard band
      if (useHybrid && hybridEngine.isActive()) {
        // Real corrected prices may drift: let the ANCHOR follow slowly
        // (≤0.05%/tick) so the band tracks reality instead of fighting it.
        const real = hybridEngine.tick(now);
        const step = Math.max(-liveAnchor.close * 0.0005, Math.min(liveAnchor.close * 0.0005, real - liveAnchor.close));
        liveAnchor.close = Math.max(0.01, liveAnchor.close + step);
        liveAnchor.high = Math.max(liveAnchor.high, liveAnchor.close);
        liveAnchor.low = Math.min(liveAnchor.low, liveAnchor.close);
      }
      liveOffset = liveOffset * 0.92 + (Math.random() - 0.5) * liveAnchor.close * 0.0006;
      liveOffset = Math.max(-band, Math.min(band, liveOffset));
      live.close = Math.max(0.01, liveAnchor.close + liveOffset);
      live.high = Math.max(liveAnchor.high, Math.min(live.close, liveAnchor.close + band));
      live.low = Math.min(liveAnchor.low, Math.max(live.close, liveAnchor.close - band));
      liveTickVolume += Math.round(Math.abs(liveOffset) * 100 + Math.random() * 8);
      live.volume = liveAnchor.volume + liveTickVolume;
    }
    // Per-bar VPI for the live bar is intentionally NOT regenerated per
    // tick anymore — regenerating it reseeded the newest bars' voxels and
    // made the 3-5 newest extrusions jump. It refreshes on bar roll only.
    // Keep the one-click trading panel (buy/sell/spread) in sync with the tick.
    updateTradingPanel();
  }, tickMs);
}

/** Single authoritative Live toggle — every caller goes through here so
 * state, timer, and button can never disagree (the old split start/stop
 * calls left the button lit after the engine had stopped and vice versa). */
function setLiveTicks(on: boolean): void {
  if (on) startLiveTicks(); else stopLiveTicks();
  const btn = document.getElementById('live-tick-toggle') as HTMLButtonElement | null;
  if (btn) {
    btn.classList.toggle('active', liveTicksEnabled);
    btn.setAttribute('aria-pressed', String(liveTicksEnabled));
    btn.title = liveTicksEnabled ? 'Live tick simulation ON — click to stop' : 'Live tick simulation — click to start';
  }
}

function stopLiveTicks(): void {
  if (liveTickTimer) { clearInterval(liveTickTimer); liveTickTimer = null; }
  hybridEngine.stop();
  restoreLiveAnchor();
  liveAnchor = null;
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

// Hosted providers mirror the mobile app's list. Keys live on the backend
// (encrypted), and completions are proxied, so the browser never holds one.
const HOSTED_PROVIDERS = new Set(['meta', 'opencode', 'openrouter', 'openai', 'anthropic', 'orcarouter', 'nvidia', 'custom']);
const hostedModelCache: Record<string, string[]> = {};

function fillHostedModelSelect(ddId: string, models: string[], selected?: string): void {
  const dd = document.getElementById(ddId) as HTMLSelectElement | null;
  if (!dd) return;
  dd.innerHTML = '';
  // Free tiers first — same ordering rule the mobile settings use.
  const opts = [...models].sort(
    (a, b) => Number(b.toLowerCase().includes('free')) - Number(a.toLowerCase().includes('free'))
  );
  if (opts.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No models — save the key, then hit Test';
    dd.appendChild(o);
    return;
  }
  for (const m of opts) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    dd.appendChild(o);
  }
  if (selected) {
    if (!opts.includes(selected)) {
      const o = document.createElement('option');
      o.value = selected;
      o.textContent = selected + ' (saved)';
      dd.appendChild(o);
    }
    dd.value = selected;
  }
}

async function loadHostedModels(provider: string, ddId: string, selected?: string): Promise<string[]> {
  if (!HOSTED_PROVIDERS.has(provider)) return [];
  let models = hostedModelCache[provider];
  if (!models) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/llm/models?provider=${encodeURIComponent(provider)}`);
      const d = await r.json();
      models = d.ok ? (d.models || []) : [];
    } catch { models = []; }
    hostedModelCache[provider] = models;
  }
  fillHostedModelSelect(ddId, models || [], selected);
  return models || [];
}

// Toggle the coder model fields based on provider (local select vs Ollama dropdown).
function applyCoderProviderUI(provider: string): void {
  const isOllama = provider.startsWith('ollama');
  const isHosted = HOSTED_PROVIDERS.has(provider);
  const localRow = document.getElementById('coder-model-local-row');
  const cloudRow = document.getElementById('coder-model-cloud-row');
  const hostedRow = document.getElementById('coder-model-hosted-row');
  if (localRow) localRow.style.display = (isOllama || isHosted) ? 'none' : '';
  if (cloudRow) cloudRow.style.display = isOllama ? '' : 'none';
  if (hostedRow) hostedRow.style.display = isHosted ? '' : 'none';
  if (isOllama) fillOllamaDropdown('set-coder-model-cloud', ollamaKindFor(provider));
  if (isHosted) {
    const dd = document.getElementById('set-coder-model-hosted') as HTMLSelectElement | null;
    void loadHostedModels(provider, 'set-coder-model-hosted', dd?.value || undefined);
  }
}

// Toggle the advisor model fields + local-only controls based on provider.
function applyAdvisorProviderUI(provider: string): void {
  const isOllama = provider.startsWith('ollama');
  const isHosted = HOSTED_PROVIDERS.has(provider);
  const localRow = document.getElementById('advisor-model-local-row');
  const cloudRow = document.getElementById('advisor-model-cloud-row');
  const hostedRow = document.getElementById('advisor-model-hosted-row');
  if (localRow) localRow.style.display = (isOllama || isHosted) ? 'none' : '';
  if (cloudRow) cloudRow.style.display = isOllama ? '' : 'none';
  if (hostedRow) hostedRow.style.display = isHosted ? '' : 'none';
  if (isOllama) fillOllamaDropdown('set-advisor-model-cloud', ollamaKindFor(provider));
  if (isHosted) {
    const dd = document.getElementById('set-advisor-model-hosted') as HTMLSelectElement | null;
    void loadHostedModels(provider, 'set-advisor-model-hosted', dd?.value || undefined);
  }
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
  if (!mode) return;
  // 'hybrid' = Massive anchors + Yahoo corrections + synthetic fill.
  // Anything else is a registered universal provider id (yahoo, massive,
  // polygon, alpaca, twelvedata, custom) served by the backend adapter.
  dataSourceMode = mode;
  try { liveStream.setProvider(mode === 'hybrid' ? '' : mode); } catch { /* stream not ready */ }
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

// Resolved name->dataUrl map for saved image assets (image-assets.ts's
// IndexedDB library), threaded into every executeScript call so
// image.new()/plotimage()/plotimage_3d() can resolve a saved asset name.
// Populated once at startup and refreshed whenever the editor's Images
// panel adds or deletes an asset (see setImageAssetsChangedCallback below).
let imageAssetsCache: Map<string, string> = new Map();
function refreshImageAssetsCache(): void {
  getAllAssetsAsMap().then(map => {
    imageAssetsCache = map;
    runAllIndicators();
    updateUI();
  }).catch(() => {});
}

// Store the currently selected indicator ID for the inputs panel
let activeInputsId: string | null = null;

const inputsPanel = createInputsPanel((overrides) => {
  if (activeInputsId) {
    setInstanceOverrides(activeInputsId, overrides);
  }
  runAllIndicators();
  const activeInst = getActiveInstances().find(i => i.id === activeInputsId);
  inputsPanel.update(activeInst?.inputs || [], activeInst?.name, dashboardToggleFor(activeInst?.id));
  dashboard.refresh();
  buildIndicatorList();
});

const dashboard = createDashboard();

// Dashboard-toggle descriptor for the inputs panel — auto-populated for
// EVERY instance (the dashboard derives metrics from any observable plot
// output, so "has a dashboard" is always true while enabled; hidden while
// the instance is off since there's nothing to show).
function dashboardToggleFor(id?: string): import('./age-inputs-panel').DashboardToggleState | undefined {
  if (!id) return undefined;
  const inst = getActiveInstances().find(i => i.id === id);
  if (!inst) return undefined;
  return {
    visible: inst.showInDashboard !== false,
    onToggle: (next: boolean) => {
      setInstanceDashboardVisible(id, next);
      dashboard.refresh();
      buildIndicatorList();
    },
  };
}

// ml.predict()/rl.action() resolve synchronously against a cache and kick
// off a background fetch on a miss (see ml-client.ts's resolveGeneric) —
// this is the "next render picks up the real value" half of that contract.
// Without it, a script applied on a static/paused chart would show the
// neutral default (0.5/0) forever instead of just until the fetch lands,
// since nothing else forces a re-run absent a new bar/tick.
setMlRedrawCallback(() => {
  if (oakScriptEnabled) { runAllIndicators(); updateUI(); }
});

// ─── Regime Ribbon ─────────────────────────────────────────────────
// Persistent, advisory-only top-of-chart strip — see regime-ribbon.ts for
// the classification/hysteresis logic. Appended into #chart-area so it's
// scoped to the chart canvas, not the whole viewport.
const regimeRibbon = createRegimeRibbon();
document.getElementById('chart-area')?.appendChild(regimeRibbon.el);
const regimeState = createInitialRegimeState();
// Discoverability toggle (toolbar "◉ Regime" button + Indicators dropdown
// entry) — the ribbon itself stays advisory-only; this only shows/hides
// the classification readout (dot/label/confidence/ADX/ATR/"advisory").
// The "Suggest: X" button is a distinct feature, NOT gated by this toggle
// (see regimeRibbon.update()'s infoVisible param) — visibility for both is
// actually applied on the next updateRegimeRibbon() tick, not here.
// Persisted; default ON (matches the always-on behavior it shipped with).
let regimeRibbonEnabled = (() => { try { return localStorage.getItem('dafe_regime_ribbon') !== '0'; } catch { return true; } })();
function setRegimeRibbonEnabled(enabled: boolean): void {
  regimeRibbonEnabled = enabled;
  try { localStorage.setItem('dafe_regime_ribbon', enabled ? '1' : '0'); } catch {}
  document.getElementById('regime-toggle')?.classList.toggle('active', enabled);
  visualAdapter.logAction('toggle', `Regime classification display ${enabled ? 'shown' : 'hidden'} (suggestion button unaffected)`);
}
let lastRegimeComputeAt = 0;
const REGIME_RECOMPUTE_THROTTLE_MS = 3000; // ADX/ATR over up to 300 bars — cheap, but no reason to redo it every rAF frame

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

// Throttled regime recompute — called every render frame but only does real
// work once per REGIME_RECOMPUTE_THROTTLE_MS. Cheap enough (bounded 300-bar
// window) that this throttle exists purely to avoid pointless repeat work at
// 60fps, not because the computation itself is expensive.
function updateRegimeRibbon(now: number): void {
  // The toggle controls ONLY the classification display (dot/label/
  // confidence/ADX/ATR/"advisory") via infoVisible below — it must NOT
  // early-return and skip computing/calling update() entirely, or the
  // "Suggest: X" button (a separate feature per the toggle's own scope)
  // would go stale/hidden along with it instead of continuing to work.
  if (now - lastRegimeComputeAt < REGIME_RECOMPUTE_THROTTLE_MS) return;
  lastRegimeComputeAt = now;
  if (transformed.length === 0) { regimeRibbon.update(null, applyIndicatorByName, regimeRibbonEnabled); return; }
  const high = transformed.map(b => b.high);
  const low = transformed.map(b => b.low);
  const close = transformed.map(b => b.close);
  const fresh = classifyRegime(high, low, close);
  if (!fresh) { regimeRibbon.update(null, applyIndicatorByName, regimeRibbonEnabled); return; }
  const displayed: RegimeResult = applyHysteresis(regimeState, fresh, now);
  regimeRibbon.update(displayed, applyIndicatorByName, regimeRibbonEnabled);
}

// Programmatically apply a built-in indicator by name — the same direct path
// the toolbar's "📊 Indicators" dropdown uses (see its change handler below),
// extracted so the Regime Ribbon's suggestion button can reuse it exactly
// rather than duplicating the apply logic.
function applyIndicatorByName(name: string): void {
  const ind = getIndicators().find(i => i.name === name);
  if (!ind) return;
  const inst = addIndicator(ind);
  runAllIndicators();
  enforceSingle3DPerPosition(inst.id);
  oakScriptEnabled = true;
  activeInputsId = inst.id;
  inputsPanel.update(inst.inputs, inst.name, dashboardToggleFor(inst.id));
  inputsPanel.show();
  dashboard.show();
  updateUI();
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
  runAllInstances(getBarData(), imageAssetsCache);
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
let paneDominance: 'both' | 'main' | 'lower' = (localStorage.getItem('dafe_pane_dominance') as any) || 'both';

function applyPaneDominance(){
  const chartArea = document.getElementById('chart-area') as HTMLElement;
  const splitterEl = document.getElementById('chart-splitter') as HTMLElement;
  const secEl = document.getElementById('secondary-canvas') as HTMLElement;
  const canvas3dEl = document.getElementById('canvas-3d') as HTMLElement;
  if(!chartArea || !secEl) return;
  if(paneDominance==='main'){ secEl.style.display='none'; if(splitterEl) splitterEl.style.display='none'; chartArea.style.flex='1'; }
  else if(paneDominance==='lower'){ (document.getElementById('chart-canvas') as HTMLElement).style.display='none'; if(canvas3dEl) canvas3dEl.style.display='none'; secEl.style.display='block'; secEl.style.flex='1'; if(splitterEl) splitterEl.style.display='none'; }
  else { (document.getElementById('chart-canvas') as HTMLElement).style.display='block'; secEl.style.display='block'; if(splitterEl) splitterEl.style.display='flex'; secEl.style.flex=''; chartArea.style.flex='1'; }
}

function resize() {
  const w = window.innerWidth;
  // #toolbar floats via position:fixed, entirely decoupled from #chart-area's
  // flex:1 CSS rule — #chart-area fills 100% of #chart-container regardless
  // of any JS-computed height, so the fix has to happen in real CSS: reserve
  // the toolbar's live footprint as padding-bottom on the flex container
  // itself, which shrinks the space flex:1 actually resolves against. (An
  // earlier version of this only shrank the canvas's internal draw-buffer
  // math, which changed nothing about the visual layout — #chart-area still
  // filled the full container and the toolbar still overlapped it.)
  const toolbarEl = document.getElementById('toolbar');
  const toolbarTop = toolbarEl ? toolbarEl.getBoundingClientRect().top : window.innerHeight;
  const availableHeight = Math.max(200, Math.min(window.innerHeight, toolbarTop - 8));
  const chartContainer = document.getElementById('chart-container');
  if (chartContainer) chartContainer.style.paddingBottom = `${window.innerHeight - availableHeight}px`;
  const h = Math.max(100, availableHeight - lowerHeight);
  // Backing-store resolution is scaled by devicePixelRatio (clamped like
  // every other renderer in this app — three-indicators.ts, webgl-renderer.ts
  // — to cap GPU/fill cost on very-high-DPI displays) so the chart renders
  // at native sharpness instead of a blurry 1x bitmap stretched to fill a
  // Retina-size CSS box. The CSS display size (canvas is `width:100%;
  // height:100%` of its container, unchanged) stays exactly w×h regardless,
  // and setTransform makes every existing draw call — all written in
  // CSS-pixel coordinates — land correctly on the higher-res buffer without
  // having to rescale a single one of them by hand.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  secCanvas.width = Math.round(w * dpr);
  secCanvas.height = Math.round(lowerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  secCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  return visibleBarCount(view, canvas.clientWidth);
}

canvas.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const oldBs = view.barSpacing;
  const right = chartRight(canvas.clientWidth);

  const { start, end } = getVisibleRange(view, canvas.clientWidth, bars.length);
  const vLen = end - start + 1;
  const localIdx = vLen - 1 - (right - e.clientX) / oldBs;
  const barUnderMouse = start + Math.round(localIdx);

  view.barSpacing *= e.deltaY > 0 ? 0.9 : 1.1;
  view.barSpacing = Math.max(MIN_BAR_SPACING, Math.min(MAX_BAR_SPACING, view.barSpacing));

  const newCount = visibleBarCount(view, canvas.clientWidth);
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
    draw.onClick(e.clientX, e.clientY, transformed, view, canvas.clientWidth, canvas.clientHeight);
    visualAdapter.logAction('draw', `Placed ${draw.getTool()} at (${e.clientX}, ${e.clientY})`);
    return;
  }
  if (e.clientX > chartRight(canvas.clientWidth)) {
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
    draw.onMove(e.clientX, e.clientY, transformed, view, canvas.clientWidth, canvas.clientHeight);
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
      // Shift-drag = free 2D pan: grab any part of the chart and drag it
      // anywhere (time + price together, slightly amplified). Plain drag
      // stays time-only so normal browsing can't lose the price axis.
      view.scrollX += (dx / view.barSpacing) * 1.4;
      view.offsetY += dy * 1.4;
      const maxScrollPast = -Math.floor(getBarsThatFit() * 0.8);
      view.scrollX = Math.max(maxScrollPast, Math.min(bars.length - 1, view.scrollX));
      view.offsetY = Math.max(-canvas.clientHeight, Math.min(canvas.clientHeight, view.offsetY));
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
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // The only way to change which bars are in view while chart 3D mode is
    // active (pane="3d" indicators like ChronoSphere) — its canvas claims
    // mouse drag/wheel entirely for orbit-camera controls (see
    // enableOrbitMain in three-indicators.ts), so view.scrollX otherwise
    // never moves once that mode is entered and the 3D bar geometry has
    // nothing to resync to. Bound on window like the numpad hotkeys above,
    // so it isn't gated behind canvas focus/z-order either.
    e.preventDefault();
    const step = Math.max(5, Math.round(getBarsThatFit() * 0.2));
    view.scrollX += e.key === 'ArrowLeft' ? step : -step;
    const maxScrollPast = -Math.floor(getBarsThatFit() * 0.8);
    view.scrollX = Math.max(maxScrollPast, Math.min(bars.length - 1, view.scrollX));
    visualAdapter.logAction('pan', `Pan ${e.key === 'ArrowLeft' ? 'back' : 'forward'} ${step} bars`);
  }
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
  // Reset regime hysteresis — a stale label from the PREVIOUS symbol must
  // never linger under the dwell timer onto a newly-switched symbol/timeframe.
  regimeState.displayed = null;
  regimeState.lastChangeAt = 0;

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
      visibleBars: visibleBarCount(view, canvas.clientWidth),
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
  // The snapshot only feeds the Trade Advisor, which captures on demand
  // (updateAdvisorContext falls back to captureChartSnapshot()). Building it
  // every ~60 frames while the panel is closed is pure waste on weak machines.
  if (!advisorOpen) return;
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
      appendAdvisorMessage('assistant', reply, currentAdvisorAgent === 'trade_advisor' ? 'Trade Advisor' : currentAdvisorAgent === 'market_intel' ? 'Market Intel' : 'Model Tuner', data.thinking || undefined);
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
  title.textContent = `Active Signal Models (${active.length})`;
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
      inputsPanel.update(inst.inputs, inst.name, dashboardToggleFor(inst.id));
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

    // Per-model auto-execution arming — the OTHER gate the paper
    // auto-trader checks (see the onLiveSignal consumer near broker setup),
    // independent of the Trading panel's master switch. Session-only,
    // starts false, and resets to false on every source edit.
    const autoBtn = document.createElement('button');
    autoBtn.textContent = '🤖';
    const autoStyle = (on: boolean) => {
      autoBtn.title = on
        ? 'Auto-execution ARMED for this model — its new entry/exit signals will paper-trade when the Trading panel\'s master switch is also on. Click to disarm.'
        : 'Auto-execution off for this model. Click to arm (also requires the Trading panel\'s master switch).';
      autoBtn.style.opacity = on ? '1' : '0.3';
      autoBtn.style.borderColor = on ? 'rgba(255,209,102,0.6)' : 'rgba(255,255,255,0.15)';
      autoBtn.style.background = on ? 'rgba(255,209,102,0.12)' : 'none';
    };
    Object.assign(autoBtn.style, {
      border: '1px solid rgba(255,209,102,0.4)',
      cursor: 'pointer', borderRadius: '4px',
      width: '20px', height: '20px', fontSize: '9px', padding: '0',
    });
    autoStyle(inst.autoTradeArmed);
    autoBtn.onclick = () => {
      const next = !inst.autoTradeArmed;
      setInstanceAutoTradeArmed(inst.id, next);
      autoStyle(next);
      visualAdapter.logAction('auto-trade', `${inst.name} ${next ? 'armed' : 'disarmed'} for auto-execution`);
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
    item.appendChild(autoBtn);
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

    // Blast-Radius Isolation: the circuit breaker in indicator-manager.ts
    // already disabled this instance (inst.enabled === false) — surface
    // *why*, distinctly from a plain per-bar error, with the only way to
    // bring it back (there was previously no "re-enable" control at all
    // once something set enabled=false).
    if (inst.autoDisabledReason) {
      const disabledDiv = document.createElement('div');
      Object.assign(disabledDiv.style, {
        display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap',
        color: '#ff4477', fontSize: '9px', padding: '2px 0 0 10px',
      });
      const msg = document.createElement('span');
      msg.textContent = `⛔ Auto-disabled: ${inst.autoDisabledReason}`;
      disabledDiv.appendChild(msg);
      const reEnableBtn = document.createElement('button');
      reEnableBtn.textContent = '↻ Re-enable';
      Object.assign(reEnableBtn.style, {
        background: 'none', border: '1px solid rgba(255,68,119,0.3)', color: '#ff4477',
        cursor: 'pointer', borderRadius: '3px', fontSize: '9px', padding: '1px 4px',
      });
      reEnableBtn.onclick = () => {
        setInstanceEnabled(inst.id, true);
        runAllIndicators();
        updateUI();
      };
      disabledDiv.appendChild(reEnableBtn);
      section.appendChild(disabledDiv);
    } else if (inst.errors.length > 0) {
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
    bt.title = lock3D ? 'Bar type is locked while a 3D main-chart signal model is active' : '';
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

  // Every VP setting change must: (1) invalidate the VP cache, (2) mark the
  // 3D scene dirty so Three.js rebuilds, (3) invalidate the theme cache when
  // the color theme changes, and (4) refresh the UI. Previously most of these
  // only cleared vpCacheKey — the 3D scene never rebuilt and the theme never
  // propagated to candles/grid/background.
  const invalidateAll = () => {
    vpCacheKey = '';
    mark3DSceneDirty();
    updateUI();
  };
  modeSel?.addEventListener('change', () => { vpSettings.mode = modeSel.value as VolumeProfileMode; volumeEnabled = true; invalidateAll(); });
  engineSel?.addEventListener('change', () => { vpSettings.visualEngine = engineSel.value as any; invalidateAll(); });
  widthIn?.addEventListener('input', () => { vpSettings.profileWidth = parseInt(widthIn.value, 10); invalidateAll(); });
  binsIn?.addEventListener('input', () => { vpSettings.binCount = parseInt(binsIn.value, 10); invalidateAll(); });
  lbIn?.addEventListener('input', () => { vpSettings.lookbackBars = parseInt(lbIn.value, 10); invalidateAll(); });
  vaIn?.addEventListener('input', () => { vpSettings.valueAreaPct = parseInt(vaIn.value, 10); invalidateAll(); });
  themeSel?.addEventListener('change', () => { vpSettings.colorTheme = themeSel.value as any; invalidateThemeCache(); invalidateAll(); });
  showVA?.addEventListener('change', () => { vpSettings.showValueArea = showVA.checked; invalidateAll(); });
  showDelta?.addEventListener('change', () => { vpSettings.showDelta = showDelta.checked; invalidateAll(); });
  showNodes?.addEventListener('change', () => { vpSettings.showNodes = showNodes.checked; invalidateAll(); });

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
broker.onFill((fill) => {
  void appendLedgerEntry('trade.fill', {
    orderId: fill.orderId, symbol: fill.symbol, side: fill.side,
    qty: fill.qty, price: fill.price, commission: fill.commission,
    slippage: fill.slippage, timestamp: fill.timestamp,
  });
  playTone(fill.side === 'buy' ? 'buy' : 'sell');
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

// ─── Signal Engine → Paper Trader (Live Automation, paper only) ─────
// Consumes the live-edge signal stream (see signal-engine.ts). TWO
// independent gates must both be open for a signal to execute: the
// Trading panel's master switch (autoTradeEnabled), and the emitting
// model's own arming toggle in the Active Signal Models list
// (getInstance(id).autoTradeArmed) — so arming one model can never
// silently arm every other active model too. Entry direction picks the
// side (model.shortEntry opens short); exit direction, when the script
// set one (model.longExit/shortExit), only flattens a position already on
// that side, otherwise flattens whichever side is open. Strictly opt-in
// and session-only — both gates always start OFF and neither is
// persisted, so auto-trading can never be something the user discovers
// already running. Paper broker only; fills flow through the existing
// onFill hooks (chart markers, Glass Ledger entry, sound cue).
// Real-brokerage routing is intentionally NOT wired here.
let autoTradeEnabled = false;
let autoTradeQty = 1;
let autoTradeStatusEl: HTMLElement | null = null;
function setAutoTradeStatus(text: string): void {
  if (autoTradeStatusEl) autoTradeStatusEl.textContent = text;
}
onLiveSignal((e) => {
  if (!autoTradeEnabled) return;
  if (!getInstance(e.instanceId)?.autoTradeArmed) return;
  const pos = broker.getPositions().find(p => p.symbol === currentSymbol && p.qty !== 0);
  const confNote = typeof e.signal.confidence === 'number' ? ` (confidence ${e.signal.confidence.toFixed(2)})` : '';
  if (e.signal.kind === 'entry' && !pos) {
    const side = e.signal.direction === 'short' ? 'sell' : 'buy';
    broker.placeOrder({ symbol: currentSymbol, side, type: 'market', qty: autoTradeQty });
    setAutoTradeStatus(`⚡ ${e.indicatorName} ${side === 'sell' ? 'short' : 'long'} entry → ${autoTradeQty} ${currentSymbol} (paper)${confNote}`);
  } else if (e.signal.kind === 'exit' && pos) {
    // Direction-conditional exit: a shortExit signal must not flatten a
    // long position a DIFFERENT armed model opened, and vice versa.
    if (e.signal.direction === 'long' && pos.qty <= 0) return;
    if (e.signal.direction === 'short' && pos.qty >= 0) return;
    broker.placeOrder({ symbol: currentSymbol, side: pos.qty > 0 ? 'sell' : 'buy', type: 'market', qty: Math.abs(pos.qty) });
    setAutoTradeStatus(`⚡ ${e.indicatorName} exit → flattened ${currentSymbol} (paper)${confNote}`);
  } else {
    return;
  }
  renderTradePositions();
  visualAdapter.logAction('auto-trade', `${e.indicatorName} ${e.signal.kind} signal executed (paper)`);
});

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
    const plColor = unreal >= 0 ? signalColors().bull : signalColors().bear;
    return `<div class="trade-list-row"><span class="pos-info">${escapeHtml(p.symbol)} ${p.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)} @ ${p.avgPrice.toFixed(2)}<button class="close-position" data-close-symbol="${escapeHtml(p.symbol)}">Close</button></span><span class="${unreal >= 0 ? 'pos' : 'neg'}" style="color:${plColor}">${unreal >= 0 ? '+' : ''}${unreal.toFixed(2)}</span></div>`;
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
  mountOakGuardLauncher();
  mountVisualEditor();
  // Demo/testing deep-link: ?indicator=<built-in name> applies that model
  // on load (e.g. ?indicator=CCI%20Manifold%20Sheet for screenshots/demos).
  const deepIndicator = new URLSearchParams(window.location.search).get('indicator');
  if (deepIndicator) {
    try { applyIndicatorByName(deepIndicator); } catch { /* unknown name — ignore */ }
  }
  refreshProviderCapabilities();
  syncLlmConfigFromSettings();
  // Resolve the saved image-asset library once at startup so early script
  // runs can already reference saved names; re-runs active indicators once
  // ready since the initial runAllIndicators() calls above may have already
  // fired with an empty cache.
  getAllAssetsAsMap().then(map => {
    imageAssetsCache = map;
    if (hasActiveIndicators()) { runAllIndicators(); updateUI(); }
  }).catch(() => {});

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

  // ── Signal Engine automation section (Trading panel) ──
  // Injected instead of hand-edited into index.html's large panel markup;
  // see the onLiveSignal consumer above for the actual trading logic.
  const tradingBody = document.getElementById('tradingPanelBody');
  if (tradingBody) {
    const section = document.createElement('div');
    Object.assign(section.style, { padding: '8px 12px', borderTop: '1px solid rgba(180,140,255,0.12)' });
    const title = document.createElement('div');
    title.textContent = 'AUTOMATION';
    Object.assign(title.style, { fontSize: '9px', letterSpacing: '1px', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' });
    section.appendChild(title);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'auto-trade-toggle';
    const toggleLabel = document.createElement('label');
    toggleLabel.htmlFor = 'auto-trade-toggle';
    toggleLabel.textContent = '🤖 Master arm (paper)';
    toggleLabel.title = 'Master switch — required, but not sufficient alone: each Signal Analysis Model also needs its own 🤖 toggle armed in the Active Signal Models list before its signals place paper trades. Paper broker only — never sends real orders. Always starts off; neither this nor any per-model arming is remembered across reloads.';
    Object.assign(toggleLabel.style, { fontSize: '10px', color: 'rgba(255,255,255,0.7)', cursor: 'pointer' });
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number'; qtyInput.min = '1'; qtyInput.step = '1'; qtyInput.value = '1';
    Object.assign(qtyInput.style, {
      width: '52px', padding: '2px 5px', fontSize: '10px', background: 'rgba(12,12,28,0.9)',
      color: 'rgba(255,255,255,0.75)', border: '1px solid rgba(180,140,255,0.2)', borderRadius: '4px',
    });
    qtyInput.title = 'Quantity per auto entry';
    row.appendChild(toggle);
    row.appendChild(toggleLabel);
    row.appendChild(qtyInput);
    section.appendChild(row);

    const status = document.createElement('div');
    status.textContent = 'Off — master switch is disarmed, no model can auto-trade regardless of its own toggle.';
    Object.assign(status.style, { fontSize: '9px', color: 'rgba(255,255,255,0.35)', marginTop: '5px' });
    section.appendChild(status);
    autoTradeStatusEl = status;

    toggle.addEventListener('change', () => {
      autoTradeEnabled = toggle.checked;
      autoTradeQty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
      setAutoTradeStatus(autoTradeEnabled
        ? `Master armed (qty ${autoTradeQty}) — also arm 🤖 on individual models in the Active Signal Models list to actually trade them.`
        : 'Off — master switch is disarmed, no model can auto-trade regardless of its own toggle.');
      visualAdapter.logAction('auto-trade', `Auto-trade master ${autoTradeEnabled ? 'armed' : 'disarmed'}`);
    });
    qtyInput.addEventListener('change', () => {
      autoTradeQty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    });
    tradingBody.appendChild(section);
  }

  // Chart controls
  document.getElementById('vp-toggle')?.addEventListener('click', () => {
    document.getElementById('vp-settings-panel')?.classList.toggle('active');
    visualAdapter.logAction('toggle', 'Volume profile settings panel');
  });
  document.getElementById('regime-toggle')?.addEventListener('click', () => {
    setRegimeRibbonEnabled(!regimeRibbonEnabled);
  });
  document.getElementById('regime-toggle')?.classList.toggle('active', regimeRibbonEnabled);
  // onclick (property) rather than addEventListener: assignment is
  // idempotent, so this control can never end up double-bound — a double
  // toggle per click reads exactly like "the button won't disengage".
  const liveBtn = document.getElementById('live-tick-toggle') as HTMLButtonElement | null;
  if (liveBtn) liveBtn.onclick = () => setLiveTicks(!liveTicksEnabled);
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
    // Chart widgets first — non-OakScript overlays toggled from the same
    // menu so they're discoverable next to the indicators themselves.
    const REGIME_TOGGLE_VALUE = '__regime_ribbon__';
    const widgetGroup = document.createElement('optgroup');
    widgetGroup.label = 'Chart Widgets';
    const regimeOpt = document.createElement('option');
    regimeOpt.value = REGIME_TOGGLE_VALUE;
    regimeOpt.textContent = 'Regime Ribbon (show/hide)';
    widgetGroup.appendChild(regimeOpt);
    indSelect.appendChild(widgetGroup);

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
      if (name === REGIME_TOGGLE_VALUE) {
        setRegimeRibbonEnabled(!regimeRibbonEnabled);
      } else if (name) {
        applyIndicatorByName(name);
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
          description: 'User-edited signal model',
        });
      }
    } else {
      updateInstanceSource(inst.id, source);
    }
    activeInputsId = inst.id;
    // Keep the inputs panel in sync with the edited script — re-detecting
    // inputs (above) means newly-added input() params now appear instead of a
    // blank/stale panel.
    inputsPanel.update(inst.inputs, inst.name, dashboardToggleFor(inst.id));
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
      if (errs.length === 0) {
        const src = document.getElementById('os-textarea') as HTMLTextAreaElement;
        if (src && src.value.trim() !== getDefaultScript().trim()) {
          try {
            const { validate, formatValidationIssues } = await import('./oakscript/validator');
            const vResult = validate(src.value);
            if (!vResult.valid) {
              const vErrs = formatValidationIssues(vResult.issues);
              appendChat('agent', `Validation found issues — sending to advisor:\n${vErrs}`);
              await agentDiagnoseErrors((reply: string) => {
                appendChat('agent', reply.slice(0, 200));
              });
              return;
            }
          } catch {}
        }
        appendChat('agent', 'No errors to fix.'); return;
      }
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
      if (getActiveInstances().length === 0) { appendChat('agent', 'No active signal models.'); return; }
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
    // Fresh-create intent ("create a NEW indicator…") must not be routed
    // through the edit path — preservation instructions there made the
    // model keep the previous script's machinery (EMA ribbon) inside an
    // unrelated RSI request. Explicit create → phased generation.
    const wantsFreshCreate = /\b(create|generate|build|make)\b[^.\n]{0,70}\b(new|indicator|script|model)\b/i.test(msg)
      && !/\b(edit|modify|change|add|remove|keep|preserve|delete)\b/i.test(msg);
    if (wantsFreshCreate && hasRealEditorScript()) {
      appendChat('agent', 'Creating a new indicator from scratch (not editing the current script)…');
      await agentGenerateIndicatorPhased(msg, undefined, (t) => appendChat('agent', t.slice(0, 300)));
      return;
    }
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
        stateInfo = 'No active signal model.';
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
- DYNAMIC price levels (fibs, pivots, moving S/R that follow new swings) MUST use plot(level, "Title", "#hex", 1, "stepline") — the line then moves when the level changes. hline() is ONLY for constants that never change (e.g. RSI 70/30); an hline whose value changes leaves a NEW permanent line each time and buries the chart. hline(price, color?, pane?) is 3 args MAX — not Pine's hline(price, title, color, linestyle, linewidth); there is no title/linestyle/linewidth slot. In 3D, levels MUST use plot3d(level, ..., "line3d", ...) — line3d draws exact straight segments; "ribbon"/"surface" spline-smooth step-shaped level series into spike blades that look nothing like fib lines. Give EACH level line a DISTINCT z_level (0, 1, 2, …) so they render as cleanly separated parallel planes — putting multiple level lines on the SAME z_level overlaps them into a twisted rope.
- label3d is for RARE, meaningful moments only (a breakout, the latest signal) — never label every signal bar; dense repeats stack into unreadable towers (the engine declutters duplicates, but the script should be selective in the first place).
- 3D: Full plot3d/plotshape_3d docs are in the coder system prompt. Key: 2D plot()/plotshape() do NOT render in 3D mode — use plot3d()/plotshape_3d(). MANDATORY: plotshape_3d() must pair with at least one plot3d() using the EXACT SAME pane argument (both "3d", or both "separate") — a plotshape_3d(..., "3d") next to a plot3d(..., "separate") puts them in DIFFERENT scenes and one of them renders nowhere.
- VISUAL FOCUS (this outranks everything about visuals): render ONLY what the request needs. Maximum 2-3 plot3d layers, and every single visual element must trace directly back to something the user asked for — no decorative extras, no "bonus" derivatives, no piling styles on. One excellent, readable visual beats five cluttered ones.
- You are EDITING: do NOT add any new plot3d/plotshape_3d/label3d call the user did not ask for in THIS request. If the user asks to remove or simplify visuals, removing them IS the task — obey immediately and completely.
- 3D cone signals: expose markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1) and multiply the cone size by it so users can tune marker scale from the inputs panel.${signalRule}${dimensionRule}
- SELF-REVIEW BEFORE OUTPUT: Silently verify (1) mathematical accuracy — is every calculation, crossover, threshold, and indicator relationship correct? (2) visual focus — does every plot/shape/label trace back to the user's request? Remove anything they didn't ask for. If either check fails, fix it before answering.
- DRAWING TOOLKIT: line.new(x1,y1,x2,y2,color?,width?,style?,extend?,id?) / line.delete(id); box.new(left,top,right,bottom,borderColor?,bgColor?,width?,id?) / box.delete(id); circle.new(x1,y1,x2,y2,color?,bgColor?,width?,id?); arrow.new(x1,y1,x2,y2,color?,width?,id?); polyline.new(points,color?,width?,closed?,id?) with points as [bar_index,price] pairs; linefill.new(lineId1,lineId2,color) fills the band between two existing line.new ids; table.new(position,columns,rows,bgColor?,id?) returns a handle and table.cell(handle,col,row,text,bgColor?,textColor?) fills it (position: top_left/top_right/top_center/middle_left/middle_center/middle_right/bottom_left/bottom_right/bottom_center); barcolor(color,pane?) recolors the current bar's candle; fibretracement.new(x1,y1,x2,y2,levels?,colorUp?,colorDown?,id?) and gannfan.new(x1,y1,angleUnit?,color?,id?) draw analyst overlays as real line objects; text.new(x,y,text,color?,size?,id?) is unboxed label sugar, label.new(x,y,text,color?,size?,boxed?,align?) is the boxed form.
- OBJECT ID IDIOM: line.new/box.new/polyline.new/circle.new/arrow.new/table.new/image.new all take a trailing id — pass the SAME literal id string across multiple bars to UPDATE that object in place (a moving trendline, a growing zone) instead of stacking a new one every bar; omit the id for a fresh object per firing (e.g. one marker per pivot) — omitted-id objects are auto-capped on a rolling basis.
- IMAGES: image.new(x,y,source,width?,height?,anchor?,opacity?,rotation?,id?) places a 2D image, plotimage(bar_index,price,source,width?,height?,pane?,id?) is a per-bar signal-marker form, plotimage_3d(bar_index,price,source,size?,z_level?,pane?,rx?,ry?,rz?) is the 3D billboard form; source is EITHER an inline data:image/png;base64,... or data:image/jpeg;base64,... string OR the exact name of an asset already saved via the editor's Images panel — never invent an asset name you weren't given.
- COORDINATES: x/x1/x2 mean bar_index and y/y1/y2 mean price on every drawing builtin, but width/height on image.new and width/height/size on plotimage/plotimage_3d are PIXELS (screen-space), not price units.
- regression.channel(source,length,mult?) returns {mid,upper,lower} per bar as a CALCULATION ONLY — it does not draw itself; the script must plot all three series (three plot() calls) and use fill() between upper and lower for the shaded channel.
- CAPABILITY MINDSET: You now have a full drawing toolkit — lines, boxes, polylines, circles, arrows, tables/dashboards, text/labels, fills between lines, fibonacci/gann overlays, and image import (inline or a saved asset by name), in both 2D and 3D. When a request has no single dedicated builtin (a supply/demand zone, a custom diagram, a labeled channel), DECOMPOSE it into these primitives instead of saying it isn't possible — e.g. 'mark a supply zone' = box.new anchored to the swing high/low; 'label the golden pocket' = fibretracement.new; 'put my logo in the corner' = image.new with a saved asset name. This does NOT relax VISUAL FOCUS: decomposing into primitives still means using the FEWEST objects that faithfully render exactly what was asked — never add drawing calls beyond what the request needs.
- When adding a drawing object or image to this EXISTING script, follow the id idiom above: reuse an object's existing id only if you intend to update/move it, and do NOT change or drop an existing line/box/polyline/circle/arrow/table/image's id unless the user explicitly asked to replace that object — changing its id orphans the old one on the chart.
- BACKTESTING (Time Machine): strategy.entry(direction, id?, qty?) / strategy.exit(id?) are order-EVENT builtins consumed ONLY by the backtest panel — they render nothing and have zero effect on the live chart. Position-level not id-level: entry no-ops if already in a position (no pyramiding), exit always closes the WHOLE position (no partial exits, no bracket stop/take-profit). Only ADD strategy.entry/strategy.exit calls when the user explicitly asks to backtest/test a strategy in THIS request — a plain signal-marker request should stay on plotshape. If this existing script already has strategy.entry/strategy.exit calls, preserve them like any other existing logic unless asked to change them.
- MULTI-TIMEFRAME: security(timeframe, source) — bare, not dotted — returns the last CONFIRMED (fully closed) higher-timeframe value of source, from bars already loaded (no new fetch). NEVER the still-forming bucket: NaN until the first bucket closes, then flat until the next one closes, so it never repaints. timeframe is one of "1s"/"5s"/"10s"/"30s"/"1m"/"5m"/"15m"/"30m"/"1h"/"4h"/"1d"/"1w" and must be COARSER than the chart's own loaded resolution (same/finer = NaN for every bar). Reach for this when a request implies cross-timeframe agreement instead of claiming it isn't possible.
- Goal: the most accurate, focused, and polished version of exactly what the user asked for.`;
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
            const { checkRequestCoverage } = await import('./trade-advisor/request-coverage');
            const coverageFn = (c: string) => checkRequestCoverage(msg, c, { prefer3D, previousSource: source });
            const coverageProblems = coverageFn(code);
            if (!validate(code).valid || coverageProblems.length > 0) {
              appendChat('agent', coverageProblems.length > 0
                ? `⏳ Draft failed request-coverage (${coverageProblems.length} problem(s)) — auto-fixing…`
                : '⏳ Draft failed validation — auto-fixing…');
              const iter = await advisor.validateAndIterate(code, 3, snapshot, undefined, msg, coverageFn);
              code = iter.finalCode;
              appendChat('agent', iter.valid
                ? '✓ Auto-fix passed validation and request-coverage.'
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
        // FULL teardown of every visual surface this instance owned — the
        // pane="3d" unified scene AND the lower-pane 3D AND the overlay viz.
        // Previously only the overlay was disposed, so a hidden pane-3d or
        // lower-pane-3d script kept rendering with no owner (the reported
        // "leftover visuals stuck on the chart with nothing to remove them").
        if (isChart3DMode()) dispose3DScene();
        hide3D();
        disposeViz();
        oakPathKey = '';
        oakPathCache = null;
        chart3DSig = '';
        runAllIndicators();
        updateUI();
      } else {
        runAllIndicators();
        updateUI();
      }
    }
  });

  // ── Wire Images-panel asset changes back into the cached asset map ──
  setImageAssetsChangedCallback(() => refreshImageAssetsCache());

  // ── Let the Backtest panel pre-fill from the live chart's current state ──
  setChartContextCallback(() => ({
    symbol: currentSymbol,
    timeframe,
    baseUrl: (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788',
    // The chart's own timeframe options — the backtest TF dropdown mirrors
    // this list exactly so it can never hold a value the data layer doesn't
    // understand (the old free-text field let e.g. "1" persist forever and
    // fail every fetch).
    timeframes: Array.from(document.querySelectorAll<HTMLOptionElement>('#tf-select option')).map(o => o.value),
    // Same symbol universe the toolbar's search dropdown uses (set below in
    // the securities-combo init) — datalist suggestions, not a hard limit.
    symbols: ((window as any).__dafeSymbolUniverse as string[] | undefined) ?? [],
    provider: dataProviderLabel,
    // Live bars currently on the chart — lets the backtester run against
    // exactly what the user is looking at (incl. synthetic data offline).
    getChartBars: () => transformed.slice(),
  }));

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
        const t = prompt('Describe the signal analysis model:');
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
  // Published for the backtest panel's symbol datalist (see
  // setChartContextCallback above) — the list lives inside this
  // DOMContentLoaded closure, the context callback registers at module init.
  (window as any).__dafeSymbolUniverse = securitiesCache.map(s => s.symbol);
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
  if (window.location.search.includes('settings=1')) settingsToggle?.click();
  settingsClose?.addEventListener('click', () => settingsPanel?.classList.remove('active'));

  // Settings: Open OakScript Editor button
  document.getElementById('set-open-editor')?.addEventListener('click', () => {
    const vis2 = toggleEditor();
    oakScriptEnabled = vis2;
    settingsPanel?.classList.remove('active');
    updateUI();
  });

  document.getElementById('set-open-ledger')?.addEventListener('click', () => {
    settingsPanel?.classList.remove('active');
    showLedgerModal();
  });

  document.getElementById('set-open-storyboard')?.addEventListener('click', () => {
    settingsPanel?.classList.remove('active');
    showStoryboardModal(() => currentSymbol);
  });

  const paletteEl = document.getElementById('set-accessible-palette') as HTMLInputElement | null;
  if (paletteEl) {
    paletteEl.checked = isAccessiblePaletteEnabled();
    paletteEl.addEventListener('change', () => {
      setAccessiblePaletteEnabled(paletteEl.checked);
      // The accessible palette now reaches candles/grid/background via the
      // theme engine — invalidate its cache so the next frame re-resolves.
      invalidateThemeCache();
      vpCacheKey = '';
      mark3DSceneDirty();
      renderTradePositions();
    });
  }
  const sonificationEl = document.getElementById('set-sonification') as HTMLInputElement | null;
  if (sonificationEl) {
    sonificationEl.checked = isSonificationEnabled();
    sonificationEl.addEventListener('change', () => {
      setSonificationEnabled(sonificationEl.checked);
      // The checkbox click IS the user gesture Web Audio needs before it
      // will produce sound — confirm the toggle actually works right away
      // rather than the user only finding out on their next alert/fill.
      if (sonificationEl.checked) playTone('alert');
    });
  }

  // Interface Glow sync — one color for toolbar (main menu), OakGuard
  // launcher, advisor bubble and advisor chat box (see index.html CSS).
  const glowEnabledEl = document.getElementById('set-glow-enabled') as HTMLInputElement | null;
  const glowColorEl = document.getElementById('set-glow-color') as HTMLInputElement | null;
  const glowBrightEl = document.getElementById('set-glow-brightness') as HTMLInputElement | null;
  const applyGlow = () => {
    const enabled = glowEnabledEl ? glowEnabledEl.checked : true;
    const color = glowColorEl?.value || '#2dffb3';
    const brightness = Math.max(20, Math.min(160, parseFloat(glowBrightEl?.value || '100') || 100));
    document.body.classList.toggle('glow-sync', enabled);
    document.documentElement.style.setProperty('--dafe-glow', color);
    document.documentElement.style.setProperty('--glow-vis', String(brightness / 100));
    const valEl = document.getElementById('glow-brightness-val');
    if (valEl) valEl.textContent = `${Math.round(brightness)}%`;
    try { localStorage.setItem('dafe_glow', JSON.stringify({ enabled, color, brightness })); } catch {}
  };
  try {
    const saved = JSON.parse(localStorage.getItem('dafe_glow') || 'null');
    if (saved) {
      if (glowEnabledEl) glowEnabledEl.checked = !!saved.enabled;
      if (glowColorEl && typeof saved.color === 'string') glowColorEl.value = saved.color;
      if (glowBrightEl && typeof saved.brightness === 'number') glowBrightEl.value = String(saved.brightness);
    }
  } catch {}
  applyGlow();
  glowEnabledEl?.addEventListener('change', applyGlow);
  glowColorEl?.addEventListener('input', applyGlow);
  glowBrightEl?.addEventListener('input', applyGlow);


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
    resize();
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
      void loadProviderKeys();
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
      } else if (HOSTED_PROVIDERS.has(advisorProvider)) {
        await loadHostedModels(advisorProvider, 'set-advisor-model-hosted',
          data.llm_trade_advisor_model && data.llm_trade_advisor_model !== 'auto' ? data.llm_trade_advisor_model : undefined);
      } else if (data.llm_trade_advisor_model) {
        sel('set-advisor-model').value = data.llm_trade_advisor_model;
      }
      applyAdvisorProviderUI(advisorProvider);
      // Coder: restore its model into the field matching its provider.
      if (coderProvider.startsWith('ollama')) {
        sel('set-coder-model-cloud').value = data.llm_coder_model && data.llm_coder_model !== 'auto' ? data.llm_coder_model : '';
      } else if (HOSTED_PROVIDERS.has(coderProvider)) {
        await loadHostedModels(coderProvider, 'set-coder-model-hosted',
          data.llm_coder_model && data.llm_coder_model !== 'auto' ? data.llm_coder_model : undefined);
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
        // The dropdown displays the LIVE background (stars baseline on
        // first load). A stale backend-saved value must not flip the
        // display away from what's actually rendering — the change
        // handler below is what moves bgViz, immediately.
        bgSel.value = bgViz;
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
    // Hosted model rows are rebuilt from the live provider catalogue on every
    // panel open; a cached snapshot would restore a stale pick over the
    // saved one (e.g. showing the advisor's model on the coder row).
    'set-advisor-model-hosted', 'set-coder-model-hosted',
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

  // ── Provider API keys (hosted models) ────────────────────────────
  // Mirrors the mobile app's AI card — provider, base URL, key, live model
  // list, real connection test — but stores the key encrypted on the backend
  // and proxies every completion, so the browser never holds a secret.
  type ProviderInfo = {
    id: string; label: string; base_url: string; configured: boolean;
    masked_key: string; note: string; doc: string; default_model: string; model: string;
  };
  let providerCatalog: ProviderInfo[] = [];

  const pk = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

  function pkStatus(text: string, kind: '' | 'ok' | 'err' | 'wait' = ''): void {
    const el = pk('pk-status');
    if (!el) return;
    el.className = 'pk-status' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  // Long masks (a 70-char NVIDIA key) would wrap the card header, so the row
  // shows an abbreviated mask and keeps the full one in the tooltip.
  function compactMask(masked: string): string {
    if (!masked || masked.length <= 18) return masked;
    return masked.slice(0, 8) + '…' + masked.slice(-4);
  }

  function renderProviderCard(): void {
    const id = pk<HTMLSelectElement>('pk-provider')?.value || '';
    const p = providerCatalog.find(x => x.id === id);
    if (!p) return;
    const label = pk('pk-label'); if (label) label.textContent = p.label;
    const dot = pk('pk-dot'); if (dot) dot.className = 'pk-dot' + (p.configured ? ' on' : '');
    const card = pk('pk-card'); if (card) card.className = 'pk-card' + (p.configured ? ' connected' : '');
    const masked = pk('pk-masked');
    if (masked) {
      masked.textContent = p.configured ? compactMask(p.masked_key) : 'no key';
      masked.title = p.configured ? p.masked_key : '';
    }
    const key = pk<HTMLInputElement>('pk-key');
    if (key) { key.value = ''; key.placeholder = p.configured ? 'Paste a new key to replace' : 'Paste API key'; }
    const url = pk<HTMLInputElement>('pk-url'); if (url) url.value = p.base_url || '';
    const note = pk('pk-note');
    if (note) note.textContent = [p.note, p.doc].filter(Boolean).join(' · ');
    pkStatus('');
  }

  async function loadProviderKeys(preselect?: string): Promise<void> {
    const dd = pk<HTMLSelectElement>('pk-provider');
    if (!dd) return;
    try {
      const r = await fetch(`${BACKEND_URL}/api/llm/providers`);
      const d = await r.json();
      providerCatalog = (d.providers || []) as ProviderInfo[];
      const count = pk('pk-count');
      if (count) count.textContent = String(providerCatalog.filter(p => p.configured).length);
      const prev = preselect || dd.value;
      dd.innerHTML = '';
      for (const p of providerCatalog) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label + (p.configured ? ' · connected' : '');
        dd.appendChild(o);
      }
      if (prev && providerCatalog.some(p => p.id === prev)) dd.value = prev;
      renderProviderCard();
    } catch {
      pkStatus('Backend unreachable — provider list unavailable.', 'err');
    }
  }

  async function refreshHostedModelsFor(id: string): Promise<void> {
    delete hostedModelCache[id];
    const adv = (document.getElementById('set-llm-provider') as HTMLSelectElement)?.value;
    const cod = (document.getElementById('set-coder-provider') as HTMLSelectElement)?.value;
    if (adv === id) await loadHostedModels(id, 'set-advisor-model-hosted');
    if (cod === id) await loadHostedModels(id, 'set-coder-model-hosted');
  }

  pk('pk-provider')?.addEventListener('change', renderProviderCard);
  pk('pk-refresh')?.addEventListener('click', () => void loadProviderKeys());

  pk('pk-save')?.addEventListener('click', async () => {
    const id = pk<HTMLSelectElement>('pk-provider')?.value || '';
    if (!id) return;
    const key = pk<HTMLInputElement>('pk-key')?.value.trim() || '';
    const url = pk<HTMLInputElement>('pk-url')?.value.trim() || '';
    pkStatus('Saving…', 'wait');
    try {
      const r = await fetch(`${BACKEND_URL}/api/llm/providers/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, base_url: url }),
      });
      const d = await r.json();
      if (!d.ok) { pkStatus(d.detail || 'Save failed.', 'err'); return; }
      await loadProviderKeys(id);
      pkStatus('Saved · key encrypted on this machine', 'ok');
      await refreshHostedModelsFor(id);
    } catch (e: any) {
      pkStatus('Save failed — ' + (e?.message || 'network error'), 'err');
    }
  });

  pk('pk-test')?.addEventListener('click', async () => {
    const id = pk<HTMLSelectElement>('pk-provider')?.value || '';
    if (!id) return;
    const btn = pk<HTMLButtonElement>('pk-test');
    if (btn) btn.disabled = true;
    pkStatus('Testing key, model list and a live completion…', 'wait');
    try {
      const r = await fetch(`${BACKEND_URL}/api/llm/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        pkStatus(`Connected · ${d.models} models · chat verified`, 'ok');
        await refreshHostedModelsFor(id);
      } else {
        pkStatus('Test failed — ' + (d.error || 'unknown error'), 'err');
      }
    } catch (e: any) {
      pkStatus('Test failed — ' + (e?.message || 'network error'), 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  pk('pk-clear')?.addEventListener('click', async () => {
    const id = pk<HTMLSelectElement>('pk-provider')?.value || '';
    if (!id) return;
    if (!confirm('Remove the saved key for this provider?')) return;
    try {
      await fetch(`${BACKEND_URL}/api/llm/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadProviderKeys(id);
      pkStatus('Key removed.', '');
      await refreshHostedModelsFor(id);
    } catch {
      pkStatus('Could not remove the key.', 'err');
    }
  });

  // ─── Universal Data Providers ─────────────────────────────────────
  type DataProviderInfo = {
    id: string; label: string; needs_key: boolean; configured: boolean;
    masked_key: string; base_url: string; note: string;
    url_template: string; bars_path: string; fields: Record<string, string>;
  };
  let dataCatalog: DataProviderInfo[] = [];
  function dpStatus(text: string, kind: '' | 'ok' | 'err' | 'wait' = ''): void {
    const el = pk('dp-status');
    if (!el) return;
    el.className = 'pk-status' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }
  function renderDataCard(): void {
    const id = pk<HTMLSelectElement>('dp-provider')?.value || '';
    const p = dataCatalog.find(x => x.id === id);
    if (!p) return;
    const label = pk('dp-label'); if (label) label.textContent = p.label;
    const dot = pk('dp-dot'); if (dot) dot.className = 'pk-dot' + (p.configured ? ' on' : '');
    const masked = pk('dp-masked');
    if (masked) masked.textContent = p.needs_key ? (p.configured ? compactMask(p.masked_key) : 'no key') : 'no key needed';
    const keyEl = pk<HTMLInputElement>('dp-key');
    if (keyEl) { keyEl.value = ''; keyEl.placeholder = p.configured ? 'Paste a new key to replace' : 'Paste API key (Alpaca: KEY_ID:SECRET)'; keyEl.style.display = p.needs_key ? '' : 'none'; }
    const urlEl = pk<HTMLInputElement>('dp-url'); if (urlEl) urlEl.value = p.base_url || '';
    const tplEl = pk<HTMLInputElement>('dp-template'); if (tplEl) { tplEl.value = p.url_template || ''; tplEl.style.display = p.id === 'custom' ? '' : 'none'; }
    const pathEl = pk<HTMLInputElement>('dp-bars-path'); if (pathEl) { pathEl.value = p.bars_path || ''; pathEl.style.display = p.id === 'custom' ? '' : 'none'; }
    const fieldsEl = pk<HTMLInputElement>('dp-fields'); if (fieldsEl) { fieldsEl.value = p.id === 'custom' ? JSON.stringify(p.fields || {}) : ''; fieldsEl.style.display = p.id === 'custom' ? '' : 'none'; }
    const note = pk('dp-note'); if (note) note.textContent = p.note || '';
    dpStatus('');
  }
  async function loadDataProviders(preselect?: string): Promise<void> {
    const dd = pk<HTMLSelectElement>('dp-provider');
    if (!dd) return;
    try {
      const r = await fetch(`${BACKEND_URL}/api/data/providers`);
      const d = await r.json();
      dataCatalog = (d.providers || []) as DataProviderInfo[];
      const count = pk('dp-count');
      if (count) count.textContent = String(dataCatalog.filter(p => p.configured).length);
      const prev = preselect || dd.value;
      dd.innerHTML = '';
      for (const p of dataCatalog) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label + (p.configured && p.needs_key ? ' · connected' : '');
        dd.appendChild(o);
      }
      if (prev && dataCatalog.some(p => p.id === prev)) dd.value = prev;
      renderDataCard();
    } catch {
      dpStatus('Backend unreachable — data provider list unavailable.', 'err');
    }
  }
  pk('dp-provider')?.addEventListener('change', renderDataCard);
  pk('dp-refresh')?.addEventListener('click', () => void loadDataProviders());
  pk('dp-save')?.addEventListener('click', async () => {
    const id = pk<HTMLSelectElement>('dp-provider')?.value || '';
    if (!id) return;
    let fields: Record<string, string> | undefined;
    const fieldsRaw = pk<HTMLInputElement>('dp-fields')?.value.trim() || '';
    if (fieldsRaw) {
      try { fields = JSON.parse(fieldsRaw); } catch { dpStatus('Field map is not valid JSON.', 'err'); return; }
    }
    dpStatus('Saving…', 'wait');
    try {
      const r = await fetch(`${BACKEND_URL}/api/data/providers/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: pk<HTMLInputElement>('dp-key')?.value.trim() || '',
          base_url: pk<HTMLInputElement>('dp-url')?.value.trim() || '',
          url_template: pk<HTMLInputElement>('dp-template')?.value.trim() || '',
          bars_path: pk<HTMLInputElement>('dp-bars-path')?.value.trim() || 'results',
          fields,
        }),
      });
      const d = await r.json();
      if (!d.ok) { dpStatus(d.detail || 'Save failed.', 'err'); return; }
      await loadDataProviders(id);
      dpStatus('Saved · key encrypted on this machine', 'ok');
    } catch (e: any) {
      dpStatus('Save failed — ' + (e?.message || 'network error'), 'err');
    }
  });
  pk('dp-test')?.addEventListener('click', async () => {
    const id = pk<HTMLSelectElement>('dp-provider')?.value || '';
    if (!id) return;
    const btn = pk<HTMLButtonElement>('dp-test');
    if (btn) btn.disabled = true;
    dpStatus('Testing — fetching real SPY bars through the adapter…', 'wait');
    try {
      const r = await fetch(`${BACKEND_URL}/api/data/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
      const d = await r.json();
      dpStatus(d.ok ? `Connected · ${d.detail}` : 'Test failed — ' + (d.detail || 'unknown error'), d.ok ? 'ok' : 'err');
    } catch (e: any) {
      dpStatus('Test failed — ' + (e?.message || 'network error'), 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  pk('dp-clear')?.addEventListener('click', async () => {
    const id = pk<HTMLSelectElement>('dp-provider')?.value || '';
    if (!id) return;
    if (!confirm('Remove the saved key for this data provider?')) return;
    try {
      await fetch(`${BACKEND_URL}/api/data/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadDataProviders(id);
      dpStatus('Key removed.', '');
    } catch {
      dpStatus('Could not remove the key.', 'err');
    }
  });
  void loadDataProviders();

  document.getElementById('set-llm-provider')?.addEventListener('change', (e) => {
    applyAdvisorProviderUI((e.target as HTMLSelectElement).value);
  });
  document.getElementById('set-coder-provider')?.addEventListener('change', (e) => {
    applyCoderProviderUI((e.target as HTMLSelectElement).value);
  });

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
        : (HOSTED_PROVIDERS.has(sel('set-llm-provider'))
            ? (sel('set-advisor-model-hosted') || 'auto')
            : sel('set-advisor-model')),
      llm_coder_provider: sel('set-coder-provider'),
      // Coder model comes from the Ollama dropdown when provider is ollama*.
      llm_coder_model: sel('set-coder-provider').startsWith('ollama')
        ? (g('set-coder-model-cloud').trim() || 'auto')
        : (HOSTED_PROVIDERS.has(sel('set-coder-provider'))
            ? (sel('set-coder-model-hosted') || 'auto')
            : sel('set-coder-model')),
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

  // OakGuard now lives under LLM Configuration (moved off the chart).
  document.getElementById('set-open-oakguard')?.addEventListener('click', () => {
    settingsPanel?.classList.remove('active');
    openOakGuard();
  });

  document.getElementById('set-voice')?.addEventListener('change', () => {
    const val = (document.getElementById('set-voice') as HTMLSelectElement)?.value || 'auto';
    voice.setVoicePreference(val as any);
  });

  // Background applies IMMEDIATELY when the dropdown changes (and the
  // dropdown is initialized to the live value above, stars by default).
  const bgSelInit = document.getElementById('set-bg-viz') as HTMLSelectElement | null;
  if (bgSelInit) bgSelInit.value = bgViz;
  document.getElementById('set-bg-viz')?.addEventListener('change', () => {
    const val = (document.getElementById('set-bg-viz') as HTMLSelectElement)?.value;
    if (val === 'stars' || val === 'particles' || val === 'graph' || val === 'plain') {
      bgViz = val;
      try { localStorage.setItem('dafe_bg_viz', val); } catch { /* unavailable */ }
    }
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

  // Pane dominance control
  const domSel = document.getElementById('pane-dominance') as HTMLSelectElement | null;
  if(domSel){ domSel.value = paneDominance; domSel.addEventListener('change', (e)=>{
    paneDominance = (e.target as HTMLSelectElement).value as any;
    try{ localStorage.setItem('dafe_pane_dominance', paneDominance); }catch{}
    applyPaneDominance(); resize();
  }); applyPaneDominance(); }

  // Resizable chart divider handler — percentage-aware, shows live split
  if (splitter) {
    let sY = 0;
    splitter.addEventListener('mousedown', (e) => {
      if(paneDominance!=='both') return;
      sY = e.clientY; splitter.classList.add('dragging');
      const onMove = (ev: MouseEvent) => {
        const avail = Math.max(200, window.innerHeight - (document.getElementById('toolbar')?.getBoundingClientRect().top ?? window.innerHeight) + 8);
        lowerHeight = Math.max(avail*0.1, Math.min(avail*0.9, lowerHeight + (sY - ev.clientY)));
        sY = ev.clientY;
        const pctLower = Math.round(lowerHeight/avail*100);
        splitter.title = `Lower ${pctLower}% — Main ${100-pctLower}% — drag to adjust`;
        resize();
      };
      const onUp = () => { splitter.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
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

// Idle frame-rate cap: a static 2D chart does not need the display's full
// refresh rate. When nothing is live, orbiting, or being interacted with,
// render at 20fps (10fps on the low tier) — the starfield twinkle and regime
// ribbon stay smooth, but CPU/GPU use drops by ~2/3 on idle machines.
// The perf governor is only sampled on frames we actually render, so the
// cap itself is never mistaken for low FPS.
let lastActivityAt = performance.now();
let lastRenderedAt = 0;
for (const evt of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) {
  window.addEventListener(evt, () => { lastActivityAt = performance.now(); }, { passive: true });
}
window.addEventListener('pointermove', () => {
  const t = performance.now();
  if (t - lastActivityAt > 250) lastActivityAt = t;
}, { passive: true });

function frame(now: number) {
  // A throw anywhere in frameBody() must not kill the recursive rAF chain —
  // otherwise one bad render (e.g. NaN/Infinity from a buggy indicator
  // reaching the 3D builders) permanently freezes the canvas with no
  // visible error, which looks exactly like a browser crash to the user.
  // OakGuard Observatory is a fullscreen takeover — don't render the chart behind it.
  if ((window as any).__dafeOakGuardOpen) { requestAnimationFrame(frame); return; }
  const interacting = liveTicksEnabled || mouseDown || (now - lastActivityAt) < 1500;
  // Full rate while interacting/live; 30fps for idle 3D scenes (orbit
  // inertia/atmosphere stay smooth); 20fps (10fps low tier) for idle 2D.
  const minInterval = interacting ? 0 : is3DMode ? 33 : (perfMode === 'low' ? 100 : 50);
  if (!document.hidden && now - lastRenderedAt >= minInterval) {
    lastRenderedAt = now;
    perfGovernor.sample(now);
    try {
      frameBody(now);
    } catch (e) {
      console.error('[DAFE] frame() error — render loop recovering:', e);
    }
  }
  requestAnimationFrame(frame);
}

function frameBody(now: number) {
  time = now;
  const width = canvas.clientWidth, height = canvas.clientHeight;

  updateSnapshotEveryNthFrame();

  // Regime Ribbon — throttled internally, safe to call every frame.
  updateRegimeRibbon(now);

  // Compute visible range once per frame — shared by all drawing functions
  const { start: visStart, end: visEnd } = getVisibleRange(view, canvas.clientWidth, transformed.length);

  // Volume profile with cache — the key MUST include every setting that
  // affects the computed profile or its rendering. Previously missing:
  // colorTheme, visualEngine, showValueArea, showDelta, showNodes. Without
  // them, toggling any of those returned stale cached data.
  const vpKey = `${visStart}_${visEnd}_${vpSettings.lookbackBars}_${vpSettings.binCount}_${vpSettings.valueAreaPct}_${vpSettings.mode}_${vpSettings.profileWidth}_${vpSettings.colorTheme}_${vpSettings.visualEngine}_${vpSettings.showValueArea}_${vpSettings.showDelta}_${vpSettings.showNodes}`;
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
  // The 2D/3D mode toggle is authoritative: in 2D mode a pane="3d" script
  // degrades to the lower 3D pane + 2D main plots instead of forcing the
  // unified takeover (the "chose 2D but it stayed 3D" bug).
  const hasPane3d = is3DMode && combined3d ? combined3d.plot3d.some(p => p.pane === '3d') : false;
  if (!hasPane3d && isChart3DMode()) dispose3DScene();

  // barcolor() plots recolor candles directly (not drawn via
  // drawOakScriptPlots) — scan the combined main-pane plots for 'barcolor'
  // entries and build a bar-index -> color map for drawBars. Iteration order
  // matches indicator/bar execution order, so a later entry for the same
  // bar index naturally overwrites an earlier one (last-write-wins).
  const barColorOverrides = new Map<number, string>();
  if (combined3d) {
    for (const p of combined3d.main) {
      if (p.type === 'barcolor' && typeof p.barIdx === 'number' && p.color) {
        barColorOverrides.set(p.barIdx, p.color);
      }
    }
  }

  // Validate the current combination against the rendering matrix — logs a
  // one-time warning if the combination falls back to a different renderer.
  validateCombination({
    barType,
    view: hasPane3d ? '3D-Three' : (is3DMode ? '3D' : '2D'),
    mode: vpSettings.mode,
    engine: vpSettings.visualEngine,
  });

  if (hasPane3d) {
    // 3D indicator mode: render bars + indicator geometry + 3D shapes in Three.js
    const shape3DForMain = combined3d
      ? [...combined3d.main, ...combined3d.sep].filter(p => (p.type === 'plot3d_shape' || p.type === 'plot3d_label') && p.pane === '3d')
      : [];
    renderMain3DScene(transformed, combined3d!.plot3d as OakPlot3D[], view, canvas.clientWidth, canvas.clientHeight, shape3DForMain, bgViz);
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
    drawBars(ctx, transformed, view, time, barType, vpiEnabled ? perBarVols : undefined, barColorOverrides.size > 0 ? barColorOverrides : undefined);
    drawTimeAxis(ctx, transformed, view);
  }

  if (bgViz === 'particles') {
    updateGPUParticles(time);
    drawCPUParticles(ctx, time, width, height, perfMode === 'low' ? 0.4 : perfMode === 'medium' ? 0.7 : 1.0);
  }

  const is2DVolMode = vpSettings.mode === '2D-Side' || vpSettings.mode === '2D-Per-Bar';
  if (volumeEnabled && !hasPane3d && (!is3DMode || is2DVolMode)) {
    const vpAlignSrc = vpComputed && vpComputed.bins.length > 0 ? transformed : null;
    const pr = vpAlignSrc ? getPriceRange(vpAlignSrc, view, width) : null;
    drawVolumeProfile(ctx, volumeBins, vpSettings.mode, time, vpComputed, vpSettings.profileWidth,
      pr ? { minP: pr.minP, pRange: pr.pRange, view } : undefined);
  }

  // OakScript plots — combined from all active indicator instances.
  // Reuses combined3d from above (the comment there already promised
  // compute-once; this second call was doubling the walk over thousands
  // of plot entries on every frame).
  if (hasActiveIndicators()) {
    const combined = combined3d ?? getCombinedPlots();
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
        const sep3D = combined.plot3d.filter(p => p.pane === 'separate' || (!is3DMode && p.pane === '3d')) as OakPlot3D[];
        const shape3DforSep = [...combined.main, ...combined.sep].filter(p => (p.type === 'plot3d_shape' || p.type === 'plot3d_label') && p.pane !== '3d');
        show3D(sep3D, shape3DforSep, transformed.length);
        const main3D = combined.plot3d.filter(p => p.pane !== 'separate') as OakPlot3D[];
        if (main3D.length > 0 && !isViz3DActive()) toggle3DViz(transformed, view, canvas.clientWidth, canvas.clientHeight);
        if (main3D.length === 0 && isViz3DActive()) { disposeViz(); }
      }
    }
    if (filterKey > 0) {
      if (hasPane3d) {
        // 3D indicator active: clear secondary canvas, no 2D plots
        secCtx.fillStyle = '#0a0a18';
        secCtx.fillRect(0, 0, secCanvas.clientWidth, secCanvas.clientHeight);
      } else {
        if (oakPathCache.mainPlots.length > 0 && !isChart3DMode()) {
          drawOakScriptPlots(ctx, oakPathCache.mainPlots, transformed, view);
        }
        if (oakPathCache.sepPlots.length > 0) drawSecondaryChart(secCtx, oakPathCache.sepPlots, transformed, view);
      }
    } else {
      secCtx.fillStyle = '#0a0a18';
      secCtx.fillRect(0, 0, secCanvas.clientWidth, secCanvas.clientHeight);
      if (isViz3DActive()) disposeViz();
      if (isChart3DMode()) dispose3DScene();
      hide3D();
    }
  } else {
    secCtx.fillStyle = '#0a0a18';
    secCtx.fillRect(0, 0, secCanvas.clientWidth, secCanvas.clientHeight);
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
