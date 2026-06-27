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
  drawSecondaryChart,
  updateParticles, drawParticles,
  getVisibleRange, visibleBarCount,
  DEFAULT_BAR_SPACING, MIN_BAR_SPACING, MAX_BAR_SPACING, chartRight,
  setPerfMode,
  type ViewState,
} from './chart-renderer';
import {
  createEditor, runScript, getCurrentResult, showErrors, showResults, toggleEditor, isEditorVisible, getStoredOverrides,
  getIndicators, type OakPlot,
} from './oakscript';
import * as draw from './drawings';
import type { DrawTool } from './drawings';
import { draw3DScene } from './iso3d';
import { TradeAdvisorAgent, VisualAdapter, WebSearch } from './trade-advisor';
import { AdvisorVoice } from './trade-advisor/voice';
import { LiveDataStream } from './data-stream';
import { getMarketStatus, marketStatusLabel } from './market-hours';
import { render3DViz, toggle3DViz, disposeViz, isViz3DActive } from './three-indicators';
import { show3D, hide3D } from './three-lower-pane';
import type { OakPlot3D } from './oakscript/runtime';

// ─── URL-based hard reset ──────────────────────────────────────────
if (window.location.search.includes('reset=1')) {
  const keys = ['oakscript_source', 'oakscript_persist', 'oakscript_webhook', 'oakscript_overrides'];
  keys.forEach(k => localStorage.removeItem(k));
  window.location.replace(window.location.pathname);
}
// One-time purge of stale conversation memory that may contain old image references
if (!localStorage.getItem('dafe_v2_clean')) {
  try { indexedDB.deleteDatabase('dafe-trade-advisor'); } catch {}
  localStorage.setItem('dafe_v2_clean', '1');
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
let perfMode: 'low' | 'medium' | 'high' | 'ultra' = 'high';
let bgViz: 'particles' | 'stars' | 'graph' | 'plain' = 'stars';

// ─── Live Tick Simulator ──────────────────────────────────────────
let liveTicksEnabled = false;
let liveTickTimer: ReturnType<typeof setInterval> | null = null;

const TIMEFRAMES_SEC: Record<Timeframe, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

function startLiveTicks(): void {
  if (liveTickTimer) return;
  const status = getMarketStatus(currentSymbol);
  if (status === 'closed') {
    appendAdvisorMessage('system', `Live ticks disabled — ${marketStatusLabel(status)} for ${currentSymbol}`);
    return;
  }
  liveTicksEnabled = true;
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
    if (now - last.timestamp >= intervalMs) {
      const newBar: BaseBar = {
        timestamp: last.timestamp + intervalMs,
        open: last.close, high: last.close, low: last.close, close: last.close, volume: 0,
      };
      transformed.push(newBar);
      bars.push({ ...newBar });
      return;
    }
    const volatility = last.close * 0.0003;
    const change = (Math.random() - 0.5) * volatility * 2;
    last.close = Math.max(0.01, last.close + change);
    if (last.close > last.high) last.high = last.close;
    if (last.close < last.low) last.low = last.close;
    last.volume += Math.round(Math.abs(change * 10000) + Math.random() * 50);
  }, tickMs);
}

function stopLiveTicks(): void {
  if (liveTickTimer) { clearInterval(liveTickTimer); liveTickTimer = null; }
  liveTicksEnabled = false;
}

// ─── Trade Advisor state ──────────────────────────────────────────
let currentSymbol = 'SPY';
let advisorOpen = false;
const advisor = new TradeAdvisorAgent({
  agentId: 'trade_advisor',
  agentName: 'Trade Advisor',
  agentIcon: '◆',
  model: 'qwythos-9b:latest',
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
let lastChartSnapshot: any = null;
let advisorMessages: Array<{ role: string; content: string }> = [];
let advisorStreaming = false;
let dataProviderLabel = 'synthetic';

// ─── OakScript state ───────────────────────────────────────────────
let oakScriptEnabled = false;
let oakScriptErrors: string[] = [];

function runOakScript(): void {
  const source = (document.getElementById('os-textarea') as HTMLTextAreaElement)?.value || '';
  const overrides = getStoredOverrides();
  const result = runScript(
    source,
    {
      close: transformed.map(b => b.close),
      open: transformed.map(b => b.open),
      high: transformed.map(b => b.high),
      low: transformed.map(b => b.low),
      volume: transformed.map(b => b.volume),
      time: transformed.map(b => b.timestamp),
    },
    overrides.size > 0 ? overrides : undefined,
  );
  oakScriptErrors = result.errors;
  showResults(result.errors, result.inputs || []);
  buildIndicatorList();
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
  if (oakScriptEnabled) { runOakScript(); }
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
      view.scaleY = Math.max(0.2, Math.min(5, view.scaleY + dy * 0.02));
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
      case '2': view.scrollX = 0; view.barSpacing = DEFAULT_BAR_SPACING; view.offsetY = 0; visualAdapter.logAction('frame', 'Frame all'); break;
      case '3': e.preventDefault(); const vis = toggleEditor(); oakScriptEnabled = vis; if (vis) runOakScript(); visualAdapter.logAction('indicator', `OakScript ${vis ? 'opened' : 'closed'}`); updateUI(); break;
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
    if (ta) runOakScript();
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
      if (oakScriptEnabled) runOakScript();

      if (statusEl) {
        statusEl.textContent = `${sym} (${result.provider})`;
        statusEl.className = 'loaded';
      }

      updateUI();
      updateAdvisorContext();
      updateTradingPanel();
    } else {
      if (statusEl) {
        statusEl.textContent = 'No data - using synthetic';
        statusEl.className = 'error';
      }
      dataProviderLabel = 'synthetic';
    }
  } catch (err: any) {
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'error';
    }
    dataProviderLabel = 'synthetic';
  }
}

// ─── Advisor UI ────────────────────────────────────────────────────
let currentAdvisorAgent = 'trade_advisor';

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
  const chartCtx = visualAdapter.buildChartContext(snapshot);
  if (transformed.length > 0) {
    // Replace any previous context message to avoid spamming
    const lastMsg = advisorMessages[advisorMessages.length - 1];
    if (!lastMsg || lastMsg.role !== 'system-context' || lastMsg.content !== chartCtx) {
      // Only push if different from last context
      advisorMessages.push({ role: 'system-context', content: chartCtx });
    }
  }
}

function captureChartSnapshot(): any {
  const result = getCurrentResult();
  const errors: string[] = [];
  if (result && result.errors) {
    result.errors.forEach((e: any) => errors.push(typeof e === 'string' ? e : String(e)));
  }
  return visualAdapter.captureSnapshot(
    bars,
    transformed,
    barType,
    timeframe,
    currentSymbol,
    dataProviderLabel,
    result?.plots || [],
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
  );
}

let snapshotFrameCount = 0;
function updateSnapshotEveryNthFrame(): void {
  snapshotFrameCount++;
  if (snapshotFrameCount % 15 === 0) {
    captureChartSnapshot();
  }
}

function appendAdvisorMessage(role: string, content: string, agentLabel?: string): HTMLDivElement {
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
    div.appendChild(document.createTextNode(content));
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
    const chartCtx = visualAdapter.buildChartContext(snapshot);
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
      appendAdvisorMessage('assistant', reply, currentAdvisorAgent === 'trade_advisor' ? 'Trade Advisor' : currentAdvisorAgent === 'market_intel' ? 'Market Intel' : 'Strategy Tuner');
      advisorMessages.push({ role: 'assistant', content: reply });
      voice.speak(reply.slice(0, 300));

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
    const chartCtx = visualAdapter.buildChartContext(snapshot);
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
      appendAdvisorMessage('assistant', reply, 'Trade Advisor');
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
  if (!oakScriptEnabled) return;
  indicatorListEl = document.createElement('div');
  indicatorListEl.id = 'indicator-list';
  Object.assign(indicatorListEl.style, {
    position: 'fixed', top: '12px', left: '12px', zIndex: '90',
    background: 'rgba(8, 8, 20, 0.85)', border: '1px solid rgba(180, 140, 255, 0.15)',
    borderRadius: '8px', padding: '8px 10px', backdropFilter: 'blur(12px)',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: '180px', maxWidth: '260px',
    fontSize: '11px', color: 'rgba(255,255,255,0.7)',
  });

  const title = document.createElement('div');
  Object.assign(title.style, {
    color: 'rgba(180,140,255,0.5)', fontSize: '9px', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px',
  });
  title.textContent = 'Active Indicators';
  indicatorListEl.appendChild(title);

  // Determine indicator name from the loaded script
  const source = (document.getElementById('os-textarea') as HTMLTextAreaElement)?.value || '';
  let name = localStorage.getItem('oakscript_active_name') || 'Custom Script';
  
  // Attempt exact match of the loaded source code to get the official name
  const exactMatch = getIndicators().find(ind => source.trim() === ind.source.trim());
  if (exactMatch) {
    name = exactMatch.name;
    localStorage.setItem('oakscript_active_name', name);
  } else {
    // If we have a saved active name, let's see if the source has been modified from its original
    const savedName = localStorage.getItem('oakscript_active_name');
    if (savedName) {
      const origInd = getIndicators().find(ind => ind.name === savedName);
      if (origInd && source.trim() !== origInd.source.trim()) {
        name = `${savedName} (Modified)`;
      } else if (!origInd) {
        name = 'Custom Script';
      }
    } else {
      name = 'Custom Script';
    }
  }

  // 1. OakScript Indicator
  if (oakScriptEnabled) {
    const item = document.createElement('div');
    Object.assign(item.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '4px 0', gap: '6px',
    });
    const label = document.createElement('span');
    label.textContent = name;
    label.style.flex = '1';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    item.appendChild(label);

    const settingsBtn = document.createElement('button');
    settingsBtn.textContent = '⚙';
    settingsBtn.title = 'Open input settings';
    Object.assign(settingsBtn.style, {
      background: 'none', border: '1px solid rgba(180, 140, 255, 0.2)',
      color: 'rgba(180, 140, 255, 0.5)', cursor: 'pointer', borderRadius: '4px',
      width: '22px', height: '22px', fontSize: '12px', padding: '0',
    });
    settingsBtn.onclick = () => {
      const vis = toggleEditor();
      if (!vis) toggleEditor();
      const ed = document.getElementById('oakscript-editor');
      if (ed) (ed.querySelector('[data-section="inputs"]') as HTMLElement)?.scrollIntoView({ behavior: 'smooth' });
    };

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Remove indicator';
    Object.assign(closeBtn.style, {
      background: 'none', border: '1px solid rgba(255,68,119,0.2)',
      color: 'rgba(255,68,119,0.5)', cursor: 'pointer', borderRadius: '4px',
      width: '22px', height: '22px', fontSize: '11px', padding: '0',
    });
    closeBtn.onclick = () => {
      oakScriptEnabled = false;
      if (isEditorVisible()) toggleEditor();
      updateUI();
    };

    item.appendChild(settingsBtn);
    item.appendChild(closeBtn);
    indicatorListEl.appendChild(item);

    // Enumerate the indicator's sub-plots (incl. secondary-pane series)
    const res = getCurrentResult();
    if (res && res.plots.length > 0) {
      const seen = new Set<string>();
      const subPlots: Array<{ name: string; color: string; pane?: string }> = [];
      for (const p of res.plots) {
        const n = (p.name || '').trim();
        if (n && !seen.has(n)) {
          seen.add(n);
          subPlots.push({ name: n, color: p.color || '#b48cff', pane: p.pane || 'main' });
        }
      }
      if (subPlots.length > 0) {
        const sub = document.createElement('div');
        Object.assign(sub.style, {
          padding: '2px 0 4px 14px', fontSize: '10px',
          color: 'rgba(255,255,255,0.45)', lineHeight: '1.7',
        });
        for (const sp of subPlots) {
          const row = document.createElement('div');
          Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '5px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          });
          const dot = document.createElement('span');
          dot.style.width = '6px'; dot.style.height = '6px';
          dot.style.borderRadius = '50%'; dot.style.background = sp.color;
          dot.style.flexShrink = '0';
          row.appendChild(dot);
          const txt = document.createElement('span');
          txt.textContent = sp.name + (sp.pane === 'separate' ? ' (osc)' : '');
          row.appendChild(txt);
          sub.appendChild(row);
        }
        indicatorListEl.appendChild(sub);
      }
    }
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
  if (bt) bt.value = barType;
  const tfSelect = document.getElementById('tf-select') as HTMLSelectElement;
  if (tfSelect) tfSelect.value = timeframe;
  document.getElementById('oakscript-toggle')?.classList.toggle('active', oakScriptEnabled);
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
}

// ─── Startup ─────────────────────────────────────────────────────
const BACKEND_URL = (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788';

async function startupChecks(): Promise<void> {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/ping`);
    if (resp.ok) {
      const statusEl = document.getElementById('data-status');
      if (statusEl) { statusEl.textContent = 'Backend OK'; statusEl.className = 'loaded'; }
    }
  } catch {
    const statusEl = document.getElementById('data-status');
    if (statusEl) { statusEl.textContent = 'Backend offline'; statusEl.className = 'error'; }
  }
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
}

document.addEventListener('DOMContentLoaded', () => {
  startupChecks();

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
  document.getElementById('mode-toggle')?.addEventListener('click', () => {
    is3DMode = !is3DMode;
    visualAdapter.logAction('mode', `Switched to ${is3DMode ? '3D' : '2D'} mode`);
    updateUI();
  });
  document.getElementById('btn-frame')?.addEventListener('click', () => {
    view.scrollX = 0; view.barSpacing = DEFAULT_BAR_SPACING; view.offsetY = 0;
    visualAdapter.logAction('frame', 'Reset chart view');
  });
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

  // OakScript editor
  const { textarea } = createEditor(document.body, (source: string) => {
    runOakScript();
    updateUI();
  });
  textarea.id = 'os-textarea';

  // OakScript toggle button
  document.getElementById('oakscript-toggle')?.addEventListener('click', () => {
    const vis = toggleEditor();
    oakScriptEnabled = vis;
    if (vis) runOakScript();
    updateUI();
  });

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
      symbolDropdown.innerHTML = `<div style="padding:6px 10px;color:rgba(255,255,255,0.3)">No match — press Enter for "${filter}"</div>`;
      symbolDropdown.style.display = 'block';
      return;
    }
    symbolDropdown.innerHTML = filtered.map((s, i) =>
      `<div class="sym-item" data-idx="${i}" data-sym="${s.symbol}" style="padding:5px 10px;cursor:pointer;display:flex;justify-content:space-between;color:rgba(255,255,255,0.7);border-bottom:1px solid rgba(255,255,255,0.03);background:${i === selectedIdx ? 'rgba(0,204,255,0.12)' : 'transparent'}">
        <span>${s.symbol}</span>
        <span style="color:rgba(255,255,255,0.25);font-size:9px">${s.name}</span>
      </div>`
    ).join('') + `<div class="sym-item" data-sym="${filter}" style="padding:4px 10px;cursor:pointer;color:rgba(0,204,255,0.4);font-size:9px;border-top:1px solid rgba(255,255,255,0.05)">↩ Use "${filter}" as custom symbol</div>`;
    symbolDropdown.style.display = 'block';
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

  document.getElementById('perf-select')?.addEventListener('change', () => {
    const val = (document.getElementById('perf-select') as HTMLSelectElement)?.value;
    if (val === 'low' || val === 'medium' || val === 'high' || val === 'ultra') {
      perfMode = val;
      setPerfMode(val);
    }
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
      const s = (s: string) => (document.getElementById(s) as HTMLInputElement);
      if (data.massive_api_key_masked) s('set-massive-key').value = data.massive_api_key_masked;
      if (data.serpapi_api_key_masked) s('set-serp-key').value = data.serpapi_api_key_masked;
      if (data.tradovate_password_masked) s('set-tradovate-pass').value = data.tradovate_password_masked;
      if (data.tradovate_username) s('set-tradovate-user').value = data.tradovate_username;
      if (data.tradovate_environment) (document.getElementById('set-tradovate-env') as HTMLSelectElement).value = data.tradovate_environment;
      if (data.llm_provider) (document.getElementById('set-llm-provider') as HTMLSelectElement).value = data.llm_provider;
      if (data.ollama_base_url) s('set-ollama-url').value = data.ollama_base_url;
      if (data.llm_trade_advisor_model) s('set-advisor-model').value = data.llm_trade_advisor_model;
      const voicePref = localStorage.getItem('dafe_voice_pref') || 'auto';
      const voiceSel = document.getElementById('set-voice') as HTMLSelectElement;
      if (voiceSel) voiceSel.value = voicePref;

      const bgSel = document.getElementById('set-bg-viz') as HTMLSelectElement;
      if (bgSel) bgSel.value = bgViz;
      if (data.market_data_source) (document.getElementById('set-data-source') as HTMLSelectElement).value = data.market_data_source;
      const hkMap: Record<string, string> = {hk3d:'hotkey_3d',hkvp:'hotkey_vp',hkframe:'hotkey_frame',hkoak:'hotkey_oak',hktrend:'hotkey_trend',hkhline:'hotkey_hline',hkray:'hotkey_ray',hkrect:'hotkey_rect',hkfib:'hotkey_fib',hkchannel:'hotkey_channel',hktext:'hotkey_text',hkundo:'hotkey_undo',hkclear:'hotkey_clear',hkdeselect:'hotkey_deselect'};
      for (const [id, key] of Object.entries(hkMap)) {
        const el = document.getElementById('hk-' + id.replace('hk','')) as HTMLInputElement;
        if (el && data[key]) el.value = data[key];
      }
    } catch { /* silent */ }
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
      ollama_base_url: g('set-ollama-url'),
      llm_trade_advisor_model: g('set-advisor-model'),
      market_data_source: sel('set-data-source'),
      hotkey_3d: g('hk-3d'), hotkey_vp: g('hk-vp'), hotkey_frame: g('hk-frame'),
      hotkey_oak: g('hk-oak'), hotkey_trend: g('hk-trend'), hotkey_hline: g('hk-hline'),
      hotkey_ray: g('hk-ray'), hotkey_rect: g('hk-rect'), hotkey_fib: g('hk-fib'),
      hotkey_channel: g('hk-channel'), hotkey_text: g('hk-text'), hotkey_undo: g('hk-undo'),
      hotkey_clear: g('hk-clear'), hotkey_deselect: g('hk-deselect'),
    };
    try {
      const resp = await fetch(`${BACKEND_URL}/api/settings`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
      });
      const data = await resp.json();
      const status = document.getElementById('settings-status');
      if (status) { status.textContent = data.ok ? 'Saved!' : 'Error saving'; status.style.display = ''; setTimeout(() => status.style.display = 'none', 3000); }
    } catch { /* silent */ }
  });

  document.getElementById('set-voice')?.addEventListener('change', () => {
    const val = (document.getElementById('set-voice') as HTMLSelectElement)?.value || 'auto';
    voice.setVoicePreference(val as any);
  });

  document.getElementById('set-bg-viz')?.addEventListener('change', () => {
    bgViz = (document.getElementById('set-bg-viz') as HTMLSelectElement)?.value as any || 'particles';
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

  // Fetch news periodically — silent refreshes so no flash
  setTimeout(() => fetchNews(), 3000);
  setInterval(() => fetchNews({ silent: true }), 120000);

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
  document.getElementById('advisorClear')?.addEventListener('click', () => {
    advisorMessages = [];
    const container = document.getElementById('advisorMessages');
    if (container) {
      container.innerHTML = '<div class="advisor-msg system">Hi, I\'m your Trade Advisor and assistant, how can I help you today?</div>';
    }
  });

  // ─── Trading Panel ─────────────────────────────────────────────
  const tradingPanel = document.getElementById('trading-panel');
  const tradingPanelHeader = document.getElementById('tradingPanelHeader');
  const tradingPanelCollapse = document.getElementById('tradingPanelCollapse');
  const tradingPanelBody = document.getElementById('tradingPanelBody');

  if (tradingPanelCollapse && tradingPanel) {
    tradingPanelCollapse.addEventListener('click', () => {
      tradingPanel.classList.toggle('collapsed');
      tradingPanelCollapse.textContent = tradingPanel.classList.contains('collapsed') ? '+' : '−';
    });
  }

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

  document.getElementById('tradeSell')?.addEventListener('click', () => {
    const qty = (document.getElementById('tradeQuantity') as HTMLInputElement)?.value || '1';
    appendAdvisorMessage('system', `SELL ${qty} ${getQtyUnit(currentSymbol)} of ${currentSymbol} at market`);
  });

  document.getElementById('tradeBuy')?.addEventListener('click', () => {
    const qty = (document.getElementById('tradeQuantity') as HTMLInputElement)?.value || '1';
    appendAdvisorMessage('system', `BUY ${qty} ${getQtyUnit(currentSymbol)} of ${currentSymbol} at market`);
  });

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

function frame(now: number) {
  time = now;
  const { width, height } = canvas;

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

  if (is3DMode) {
    draw3DScene(ctx, transformed, view, {
      barType, perBarVols: vpiEnabled ? perBarVols : undefined,
      volumeBins, volumeMode: vpSettings.mode, visualEngine: vpSettings.visualEngine,
      volumeEnabled, vpiEnabled, time, profileWidth: vpSettings.profileWidth, vpComputed,
    });
    drawTimeAxis(ctx, transformed, view);
  } else {
    // 2D mode — background layer based on bgViz
    if (bgViz === 'stars') drawBackground(ctx, time);
    else { ctx.fillStyle = '#0a0a18'; ctx.fillRect(0, 0, width, height); }
    drawGrid(ctx, transformed, view, time);
    drawBars(ctx, transformed, view, time, barType, vpiEnabled ? perBarVols : undefined);
    drawTimeAxis(ctx, transformed, view);
  }

  if (bgViz === 'particles') { updateParticles(time, width, height); drawParticles(ctx); }

  if (bgViz === 'particles') { updateParticles(time, width, height); drawParticles(ctx); }

  const is2DVolMode = vpSettings.mode === '2D-Side' || vpSettings.mode === '2D-Per-Bar';
  if (volumeEnabled && (!is3DMode || is2DVolMode)) {
    drawVolumeProfile(ctx, volumeBins, vpSettings.mode, time, vpComputed, vpSettings.profileWidth);
  }

  // OakScript plots — cache filtered arrays to avoid re-filtering every frame
  if (oakScriptEnabled) {
    const result = getCurrentResult();
    if (result && result.plots.length > 0) {
      const filterKey = result.plots.length + (result.plots[0]?.type || '');
      if (filterKey !== oakPathKey || !oakPathCache) {
        oakPathKey = filterKey;
        oakPathCache = {
          mainPlots: result.plots.filter(p => p.pane !== 'separate' && p.type !== 'plot3d'),
          sepPlots: result.plots.filter(p => p.pane === 'separate' && p.type !== 'plot3d'),
        };
        // Extract 3D plots — separate pane goes to lower, main pane goes to chart overlay
        const all3D = result.plots.filter(p => p.type === 'plot3d') as OakPlot3D[];
        const sep3D = all3D.filter(p => p.pane === 'separate');
        const main3D = all3D.filter(p => p.pane !== 'separate');
        show3D(sep3D);
        if (main3D.length > 0 && !isViz3DActive()) toggle3DViz(transformed, view, canvas.width, canvas.height);
        if (main3D.length === 0 && isViz3DActive()) { disposeViz(); }
      }
      if (oakPathCache.mainPlots.length > 0) drawOakScriptPlots(ctx, oakPathCache.mainPlots, transformed, view);
      if (oakPathCache.sepPlots.length > 0) drawSecondaryChart(secCtx, oakPathCache.sepPlots, transformed, view);
      // renderLowerPane();
    } else {
      secCtx.fillStyle = '#0a0a18';
      secCtx.fillRect(0, 0, secCanvas.width, secCanvas.height);
    }
  } else {
    secCtx.fillStyle = '#0a0a18';
    secCtx.fillRect(0, 0, secCanvas.width, secCanvas.height);
    if (isViz3DActive()) disposeViz();
    hide3D();
  }

  if (!is3DMode) draw.drawAll(ctx, transformed, view);

  if (mouseX >= 0 && mouseY >= 0) {
    drawCrosshair(ctx, mouseX, mouseY);
    if (showTooltip) drawOHLCTooltip(ctx, transformed, view, mouseX, mouseY, barType);
  }

  // Status bar — only rebuild string when content changes (not every frame)
  const poc = vpComputed?.poc || null;
  const osCount = oakPathCache ? oakPathCache.mainPlots.length + oakPathCache.sepPlots.length : 0;
  const osErr = oakScriptErrors.length;
  const statusKey = `${currentSymbol}|${dataProviderLabel}|${is3DMode ? 3 : 2}|${barType}|${timeframe}|${vpiEnabled}|${oakScriptEnabled}|${osCount}|${osErr}|${volumeEnabled}|${vpSettings.mode}|${volumeBins.length}|${view.barSpacing.toFixed(1)}`;
  if (statusKey !== vpCacheKey + '_status') {
    (window as any).__dafeStatusKey = statusKey;
    const status = [
      `DAFE ${currentSymbol}`, `Data: ${dataProviderLabel}`, `Mode: ${is3DMode ? '3D' : '2D'}`,
      `Type: ${barType}`, `TF: ${timeframe}`, `VPI: ${vpiEnabled ? 'ON' : 'OFF'}`,
      `Live: ${liveTicksEnabled ? '◆' : '-'}`,
      getMarketStatus(currentSymbol) === 'open' ? '●' : '○',
      `Oak: ${oakScriptEnabled ? osCount + ' plots' + (osErr ? ` (${osErr} err)` : '') : 'OFF'}`,
      `Vol: ${vpSettings.mode}${volumeEnabled ? '' : ' OFF'}`, `Zoom: ${view.barSpacing.toFixed(1)}px`,
    ].join('  │  ');
    drawStatusBar(ctx, status);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
