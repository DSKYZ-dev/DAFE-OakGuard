/**
 * DAFE Visual Adapter — Model-aware chart-to-text bridge.
 *
 * Captures chart state into compact snapshots and builds adaptive
 * context strings tuned to the active model's token budget.
 *
 * Features:
 * - Three detail tiers: terse / normal / detailed
 * - Model-aware auto-selection via token optimizer profiles
 * - Single-pass stats (no full-array materialization)
 * - Deterministic snapshot identity for dedup across frames
 * - Compact bar encoding for the most recent bars only
 */

import type { BaseBar } from '@dafe/types';
import type { OakPlot } from '../oakscript';
import { getModelContextLimit, estimateTokens } from './token-optimizer';

// ─── Types ───────────────────────────────────────────────────────────

export interface UserAction {
  type: string;
  detail: string;
  ts: number;
}

export interface ViewStatus {
  mode: '2D' | '3D';
  zoom: number;
  scrollOffset: number;
  visibleBars: number;
  volumeProfile: string;
  volumeEngine: string;
  vpiEnabled: boolean;
  oaktScriptEnabled: boolean;
  drawingTool: string;
}

export interface IndicatorMetrics {
  name: string;
  category: string;
  source: string;
  values: Array<{ name: string; value: number; color: string }>;
  errors: string[];
  inputs: Array<{ name: string; title: string; value: any }>;
  barValues: Array<{ bar: number; values: Record<string, number> }>;
}

export type DetailLevel = 'terse' | 'normal' | 'detailed';

/** Compact bar tuple — 5 numbers, 40 bytes fixed */
export type CompactBar = [number, number, number, number, number]; // [open, high, low, close, volume]

export interface ChartStats {
  barCount: number;
  firstOpen: number;
  high: number;
  low: number;
  lastClose: number;
  change: number;
  changePct: number;
  totalVolume: number;
  avgVolume: number;
  lastVolume: number;
  vwap: number;
  support: number;
  resistance: number;
}

export interface IndicatorSummary {
  name: string;
  values: string;          // "RSI=54.2, MACD=-0.12"
  signalsActive: number;   // count of active shapes
  has3D: boolean;
  errorCount: number;
  firstError: string;
}

export interface ChartSnapshot {
  symbol: string;
  barType: string;
  timeframe: string;
  dataProvider: string;
  view: ViewStatus;
  stats: ChartStats;
  recentBars: CompactBar[];   // last 10 bars max
  indicators: IndicatorSummary[];
  indicatorErrors: string[];
  drawings: number;
  timestamp: number;
  identity: string;           // dedup hash
}

// ─── Constants ────────────────────────────────────────────────────────

const MAX_RECENT_BARS = 10;
const MAX_ACTIONS = 30;
const DEDUP_WINDOW_MS = 500;
const DETAIL_LEVELS: Record<DetailLevel, number> = {
  terse: 120, normal: 350, detailed: 800,
};

// ─── VisualAdapter ───────────────────────────────────────────────────

export class VisualAdapter {
  private lastSnapshot: ChartSnapshot | null = null;
  private actionLog: UserAction[] = [];
  private captureInterval: number | null = null;
  private captureCallback: ((snapshot: ChartSnapshot) => void) | null = null;

  // ── Action logging (capped, deduplicated) ─────────────────────────

  logAction(type: string, detail: string): void {
    const now = Date.now();
    const last = this.actionLog[this.actionLog.length - 1];
    // Dedup rapid repeats of same action
    if (last && last.type === type && last.detail === detail && now - last.ts < DEDUP_WINDOW_MS) {
      last.ts = now;
      return;
    }
    this.actionLog.push({ type, detail, ts: now });
    // Front-trim to the last MAX_ACTIONS. The previous version set
    // `.length = 0` and then looped using that same (now zero) length as
    // its own bound, so the "rebuild" loop never ran — every time the cap
    // was hit the log was silently wiped to empty instead of keeping a
    // rolling window of recent actions.
    if (this.actionLog.length > MAX_ACTIONS) {
      this.actionLog.splice(0, this.actionLog.length - MAX_ACTIONS);
    }
  }

  getRecentActions(count: number = 8): UserAction[] {
    return this.actionLog.slice(-count);
  }

  // ── Snapshot capture (lightweight — no full bar arrays stored) ────

  captureSnapshot(
    bars: BaseBar[],
    transformed: BaseBar[],
    barType: string,
    timeframe: string,
    symbol: string,
    dataProvider: string,
    indicatorPlots: OakPlot[],
    indicatorErrors: string[],
    viewStatus: ViewStatus,
    drawings: number,
    is3DMode: boolean,
    indicatorMetrics?: IndicatorMetrics[],
  ): ChartSnapshot {
    const n = bars.length;
    if (n === 0) {
      return this.lastSnapshot || this.emptySnapshot(symbol, barType, timeframe);
    }

    // ── Single-pass stats ──────────────────────────────────────────
    let hi = -Infinity, lo = Infinity, sumV = 0, sumVP = 0;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
      sumV += b.volume;
      sumVP += b.close * b.volume;
    }

    const firstOpen = bars[0].open;
    const lastClose = bars[n - 1].close;
    const lastVolume = bars[n - 1].volume;
    const prevClose = n > 1 ? bars[n - 2].close : lastClose;
    const change = lastClose - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    const avgVolume = sumV / n;
    const vwap = sumV > 0 ? sumVP / sumV : lastClose;

    // ── Real support/resistance from the recent swing window ────────────
    // The model was inventing levels (support == current price); give it the
    // actual recent high (resistance) and low (support) so it has real data.
    const swStart = Math.max(0, n - 60);
    let rHigh = -Infinity, sLow = Infinity;
    for (let i = swStart; i < n; i++) {
      if (bars[i].high > rHigh) rHigh = bars[i].high;
      if (bars[i].low < sLow) sLow = bars[i].low;
    }
    const resistance = rHigh;
    const support = sLow;

    // ── Compact recent bars (last 10 as tuples) ─────────────────────
    const start = Math.max(0, n - MAX_RECENT_BARS);
    const recentBars: CompactBar[] = [];
    for (let i = start; i < n; i++) {
      const b = bars[i];
      recentBars.push([b.open, b.high, b.low, b.close, b.volume]);
    }

    // ── Indicator summary ───────────────────────────────────────────
    const indicatorSummaries = this.buildIndicatorSummaries(indicatorPlots, indicatorMetrics);

    // ── Dense identity hash for dedup ────────────────────────────────
    const identity = [
      symbol, barType, timeframe, n,
      hi.toFixed(0), lo.toFixed(0), lastClose.toFixed(2), changePct.toFixed(2),
      indicatorSummaries.length,
      viewStatus.zoom.toFixed(1),
      drawings,
    ].join('|');

    const snapshot: ChartSnapshot = {
      symbol,
      barType,
      timeframe,
      dataProvider,
      view: { ...viewStatus },
      stats: { barCount: n, firstOpen, high: hi, low: lo, lastClose, change, changePct, totalVolume: sumV, avgVolume, lastVolume, vwap, support, resistance },
      recentBars,
      indicators: indicatorSummaries,
      indicatorErrors,
      drawings,
      timestamp: Date.now(),
      identity,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private emptySnapshot(symbol: string, barType: string, timeframe: string): ChartSnapshot {
    return {
      symbol, barType, timeframe, dataProvider: 'none',
      view: { mode: '2D', zoom: 8, scrollOffset: 0, visibleBars: 0, volumeProfile: 'off', volumeEngine: '3D-Depth', vpiEnabled: false, oaktScriptEnabled: false, drawingTool: 'none' },
      stats: { barCount: 0, firstOpen: 0, high: 0, low: 0, lastClose: 0, change: 0, changePct: 0, totalVolume: 0, avgVolume: 0, lastVolume: 0, vwap: 0, support: 0, resistance: 0 },
      recentBars: [],
      indicators: [],
      indicatorErrors: [],
      drawings: 0,
      timestamp: Date.now(),
      identity: 'empty',
    };
  }

  private buildIndicatorSummaries(
    plots: OakPlot[],
    metrics?: IndicatorMetrics[],
  ): IndicatorSummary[] {
    if (plots.length === 0 && (!metrics || metrics.length === 0)) return [];

    // Group plots by name
    const byName = new Map<string, {
      values: Map<string, number>;
      color: string;
      pane: string;
      shapeCount: number;
      has3D: boolean;
    }>();

    for (const p of plots) {
      const name = p.name || 'unnamed';
      let entry = byName.get(name);
      if (!entry) {
        entry = { values: new Map(), color: p.color || '#b48cff', pane: p.pane || 'main', shapeCount: 0, has3D: false };
        byName.set(name, entry);
      }
      if (p.type === 'shape') entry.shapeCount++;
      if (p.type === 'plot3d') entry.has3D = true;
      if (typeof p.value === 'number' && !isNaN(p.value)) {
        entry.values.set(name, p.value);
      }
    }

    const summaries: IndicatorSummary[] = [];
    for (const [name, e] of byName) {
      const valStr = Array.from(e.values.entries())
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(', ');
      summaries.push({
        name,
        values: valStr,
        signalsActive: e.shapeCount,
        has3D: e.has3D,
        errorCount: 0,
        firstError: '',
      });
    }

    // Attach errors from metrics
    if (metrics) {
      for (const m of metrics) {
        const existing = summaries.find(s => s.name === m.name);
        if (existing) {
          existing.errorCount = m.errors.length;
          existing.firstError = m.errors[0] || '';
        } else if (m.values.length > 0) {
          summaries.push({
            name: m.name,
            values: m.values.map(v => `${v.name}=${v.value.toFixed(2)}`).join(', '),
            signalsActive: 0,
            has3D: false,
            errorCount: m.errors.length,
            firstError: m.errors[0] || '',
          });
        }
      }
    }

    return summaries;
  }

  // ── Snapshot access ────────────────────────────────────────────────

  getLastSnapshot(): ChartSnapshot | null {
    return this.lastSnapshot;
  }

  isSameAsLast(identity: string): boolean {
    return this.lastSnapshot?.identity === identity;
  }

  // ── Auto-capture (lightweight interval) ───────────────────────────

  startAutoCapture(
    callback: (snapshot: ChartSnapshot) => void,
    intervalMs: number = 3000,
  ): void {
    this.captureCallback = callback;
    this.captureInterval = window.setInterval(() => {
      if (this.lastSnapshot && this.captureCallback) {
        this.captureCallback(this.lastSnapshot);
      }
    }, intervalMs);
  }

  stopAutoCapture(): void {
    if (this.captureInterval !== null) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
    this.captureCallback = null;
  }

  // ── Context building (model-aware, 3 detail tiers) ─────────────────

  /**
   * Build chart context string at the requested detail level.
   * Use `auto` to let the adapter pick based on model + budget.
   */
  buildChartContext(
    snapshot: ChartSnapshot,
    level: DetailLevel | 'auto' = 'auto',
    modelName?: string,
    tokenBudget?: number,
  ): string {
    if (snapshot.stats.barCount === 0) return `${snapshot.symbol} — No data loaded.`;

    const resolvedLevel = level === 'auto'
      ? this.resolveDetailLevel(snapshot, modelName, tokenBudget)
      : level;

    switch (resolvedLevel) {
      case 'terse':   return this.buildTerse(snapshot);
      case 'detailed': return this.buildDetailed(snapshot);
      default:         return this.buildNormal(snapshot);
    }
  }

  /**
   * Auto-select detail level based on model context window and current budget.
   * Smaller models / tight budgets → terse. Large models / relaxed budgets → detailed.
   */
  private resolveDetailLevel(
    snapshot: ChartSnapshot,
    modelName?: string,
    tokenBudget?: number,
  ): DetailLevel {
    // If we know the model, use its context window
    const ctxLimit = modelName ? getModelContextLimit(modelName) : 32768;
    // Default budget: half the context window if not explicitly provided
    const budget = tokenBudget ?? Math.max(2000, Math.round(ctxLimit * 0.5));

    // Estimate how many tokens a "normal" context would consume
    const normalEstimate = this.estimateContextTokens(snapshot, 'normal');

    // If normal would take >30% of remaining budget, go terse
    if (normalEstimate > ctxLimit * 0.25 || normalEstimate > budget * 0.5) {
      return 'terse';
    }
    // If we have plenty of room (>50k context), go detailed
    if (ctxLimit >= 32000 && normalEstimate * 2 < budget) {
      return 'detailed';
    }
    return 'normal';
  }

  private estimateContextTokens(snapshot: ChartSnapshot, level: DetailLevel): number {
    const built = this.buildChartContext(snapshot, level);
    return estimateTokens(built);
  }

  // ── Terse (80-150 tokens) ──────────────────────────────────────────

  private buildTerse(s: ChartSnapshot): string {
    const { stats, symbol, barType, timeframe } = s;
    const dir = stats.change >= 0 ? '+' : '';
    const parts = [
      `${symbol} ${barType} ${timeframe} | C:${stats.lastClose.toFixed(2)} ${dir}${stats.changePct.toFixed(2)}%`,
      `H:${stats.high.toFixed(1)} L:${stats.low.toFixed(1)} V:${Math.round(stats.totalVolume).toLocaleString()}`,
    ];
    if (s.indicators.length) {
      parts.push(s.indicators.map(i => i.values).filter(Boolean).join(' '));
    }
    if (s.drawings > 0) parts.push(`drawings:${s.drawings}`);
    return parts.join(' | ');
  }

  // ── Normal (200-400 tokens) ────────────────────────────────────────

  private buildNormal(s: ChartSnapshot): string {
    const { stats, symbol, barType, timeframe } = s;
    const dir = stats.change >= 0 ? '+' : '';
    const changeStr = `${dir}${stats.change.toFixed(2)} (${dir}${stats.changePct.toFixed(2)}%)`;

    // Volume vs its own average tells the model if the current bar is unusual.
    const volX = stats.avgVolume > 0 ? (stats.lastVolume / stats.avgVolume) : 1;
    const trend = stats.lastClose > stats.vwap ? 'above VWAP (bullish bias)' : 'below VWAP (bearish bias)';
    const lines: string[] = [
      `${symbol} ${barType} ${timeframe} | Close: ${stats.lastClose.toFixed(2)} ${changeStr}`,
      `Window range (${stats.barCount} bars): ${stats.low.toFixed(2)} - ${stats.high.toFixed(2)} | VWAP: ${stats.vwap.toFixed(2)} (${trend})`,
      `Support ~${stats.support.toFixed(2)} | Resistance ~${stats.resistance.toFixed(2)} (recent 60-bar swing low/high)`,
      `Current-bar vol: ${Math.round(stats.lastVolume).toLocaleString()} (${volX.toFixed(1)}x the ${Math.round(stats.avgVolume).toLocaleString()} avg/bar)`,
    ];

    // Recent bars (last 5)
    if (s.recentBars.length > 0) {
      const recent = s.recentBars.slice(-5);
      lines.push('Recent bars:');
      for (let i = 0; i < recent.length; i++) {
        const b = recent[i];
        const idx = s.stats.barCount - recent.length + i;
        lines.push(`  [${idx}] O:${b[0].toFixed(2)} H:${b[1].toFixed(2)} L:${b[2].toFixed(2)} C:${b[3].toFixed(2)} V:${Math.round(b[4])}`);
      }
    }

    // Indicators
    if (s.indicators.length) {
      for (const ind of s.indicators) {
        let indLine = `${ind.name}: ${ind.values}`;
        if (ind.signalsActive > 0) indLine += ` (${ind.signalsActive} signals)`;
        if (ind.has3D) indLine += ' [3D]';
        if (ind.errorCount > 0) indLine += ` ⚠ ${ind.errorCount} err`;
        lines.push(indLine);
      }
    }

    // Errors
    for (const ind of s.indicators) {
      if (ind.firstError) lines.push(`${ind.name} error: ${ind.firstError}`);
    }
    if (s.indicatorErrors.length > 0 && !s.indicators.some(i => i.errorCount > 0)) {
      lines.push(`Errors: ${s.indicatorErrors.slice(0, 2).join('; ')}`);
    }

    return lines.join('\n');
  }

  // ── Detailed (400-800 tokens) ──────────────────────────────────────

  private buildDetailed(s: ChartSnapshot): string {
    const { stats, symbol, barType, timeframe } = s;
    const dir = stats.change >= 0 ? '+' : '';
    const changeStr = `${dir}${stats.change.toFixed(2)} (${dir}${stats.changePct.toFixed(2)}%)`;

    const lines: string[] = [
      `=== Chart State ===`,
      `Symbol: ${symbol} | Type: ${barType} | TF: ${timeframe} | Bars: ${s.stats.barCount} | Provider: ${s.dataProvider}`,
      `View: ${s.view.mode} | Zoom: ${s.view.zoom.toFixed(1)}px | Visible: ${s.view.visibleBars}`,
      '',
      `=== Price ===`,
      `Last: ${stats.lastClose.toFixed(4)} | Change: ${changeStr}`,
      `High: ${stats.high.toFixed(4)} | Low: ${stats.low.toFixed(4)}`,
      `Open: ${stats.firstOpen.toFixed(4)} | VWAP: ${stats.vwap.toFixed(4)}`,
      `Volume: ${Math.round(stats.totalVolume).toLocaleString()} | Avg: ${Math.round(stats.avgVolume).toLocaleString()}`,
      '',
      `=== Recent Bars (${s.recentBars.length}) ===`,
    ];

    for (let i = 0; i < s.recentBars.length; i++) {
      const b = s.recentBars[i];
      const idx = s.stats.barCount - s.recentBars.length + i;
      const isBull = b[3] >= b[0];
      lines.push(`  [${idx}] O:${b[0].toFixed(2)} H:${b[1].toFixed(2)} L:${b[2].toFixed(2)} C:${b[3].toFixed(2)} V:${Math.round(b[4])} ${isBull ? '▲' : '▼'}`);
    }

    lines.push('');

    if (s.indicators.length) {
      lines.push('=== Indicators ===');
      for (const ind of s.indicators) {
        lines.push(`  ${ind.name}: ${ind.values || '(no values)'}`);
        if (ind.signalsActive) lines.push(`    Signals: ${ind.signalsActive} active`);
        if (ind.has3D) lines.push(`    3D: enabled`);
        if (ind.errorCount) lines.push(`    Errors: ${ind.errorCount} (${ind.firstError})`);
      }
      lines.push('');
    }

    if (s.drawings > 0) {
      lines.push(`=== Drawings ===`);
      lines.push(`  ${s.drawings} drawing(s) on chart`);
      lines.push(`  Active tool: ${s.view.drawingTool}`);
      lines.push('');
    }

    if (s.view.volumeProfile !== 'off') {
      lines.push(`=== Volume ===`);
      lines.push(`  Profile: ${s.view.volumeProfile} | Engine: ${s.view.volumeEngine} | VPI: ${s.view.vpiEnabled ? 'ON' : 'OFF'}`);
    }

    return lines.join('\n');
  }

  // ── Action summary (compact) ───────────────────────────────────────

  buildActionSummary(snapshot: ChartSnapshot): string {
    const parts = [
      `${snapshot.symbol} ${snapshot.timeframe} ${snapshot.barType} (${snapshot.view.mode})`,
      `Price $${snapshot.stats.lastClose.toFixed(2)} (${snapshot.stats.changePct >= 0 ? '+' : ''}${snapshot.stats.changePct.toFixed(2)}%)`,
    ];
    if (snapshot.view.drawingTool !== 'none') {
      parts.push(`Tool: ${snapshot.view.drawingTool}`);
    }
    if (snapshot.drawings > 0) {
      parts.push(`${snapshot.drawings} drawings`);
    }
    if (snapshot.indicators.length > 0) {
      parts.push(`Indicators: ${snapshot.indicators.map(i => i.name).join(', ')}`);
    }
    return parts.join(' | ');
  }

  // ── Snapshot diff (what changed between two snapshots) ──────────────

  buildDiff(prev: ChartSnapshot, next: ChartSnapshot): string {
    const changes: string[] = [];
    if (prev.symbol !== next.symbol) changes.push(`Symbol: ${prev.symbol} → ${next.symbol}`);
    if (prev.timeframe !== next.timeframe) changes.push(`TF: ${prev.timeframe} → ${next.timeframe}`);
    if (prev.barType !== next.barType) changes.push(`Type: ${prev.barType} → ${next.barType}`);
    if (prev.view.mode !== next.view.mode) changes.push(`Mode: ${prev.view.mode} → ${next.view.mode}`);

    const priceDiff = next.stats.lastClose - prev.stats.lastClose;
    if (Math.abs(priceDiff) > 0.001) {
      changes.push(`Price: ${prev.stats.lastClose.toFixed(2)} → ${next.stats.lastClose.toFixed(2)} (${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(2)})`);
    }

    if (next.drawings !== prev.drawings) changes.push(`Drawings: ${prev.drawings} → ${next.drawings}`);
    if (next.indicators.length !== prev.indicators.length) changes.push(`Indicators: ${prev.indicators.length} → ${next.indicators.length}`);

    return changes.length ? changes.join('; ') : 'No significant changes';
  }

  // ── Dispose ─────────────────────────────────────────────────────────

  dispose(): void {
    this.stopAutoCapture();
    this.lastSnapshot = null;
    this.actionLog.length = 0;
  }
}
