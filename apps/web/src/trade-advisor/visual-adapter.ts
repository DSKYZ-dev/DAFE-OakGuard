import type { BaseBar } from '@dafe/types';
import type { OakPlot } from '../oakscript';

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

export interface ChartSnapshot {
  bars: BaseBar[];
  transformed: BaseBar[];
  barType: string;
  timeframe: string;
  symbol: string;
  dataProvider: string;
  view: ViewStatus;
  indicators: OakPlot[];
  indicatorPlots: Array<{ name: string; value: number; color: string }>;
  indicatorErrors: string[];
  stats: {
    barCount: number;
    high: number;
    low: number;
    open: number;
    lastClose: number;
    change: number;
    changePct: number;
    volume: number;
    avgVolume: number;
    vwap?: number;
  };
  canvasDataUrl?: string;
  secondaryCanvasDataUrl?: string;
  timestamp: number;
  recentActions: UserAction[];
  drawings: number;
  is3DMode: boolean;
}

export class VisualAdapter {
  private lastSnapshot: ChartSnapshot | null = null;
  private actionLog: UserAction[] = [];
  private maxActionLog = 50;
  private captureInterval: number | null = null;
  private captureCallback: ((snapshot: ChartSnapshot) => void) | null = null;
  private frameCount = 0;

  logAction(type: string, detail: string): void {
    this.actionLog.push({ type, detail, ts: Date.now() });
    if (this.actionLog.length > this.maxActionLog) {
      this.actionLog = this.actionLog.slice(-this.maxActionLog);
    }
  }

  getRecentActions(count: number = 10): UserAction[] {
    return this.actionLog.slice(-count);
  }

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
    canvas?: HTMLCanvasElement,
    secCanvas?: HTMLCanvasElement,
  ): ChartSnapshot {
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const opens = bars.map(b => b.open);
    const volumes = bars.map(b => b.volume);
    const lastClose = closes[closes.length - 1] || 0;
    const lastOpen = opens[opens.length - 1] || 0;
    const prevClose = closes.length > 1 ? closes[closes.length - 2] : lastClose;
    const change = lastClose - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    const cumVol = volumes.reduce((a, b) => a + b, 0);
    const cumVolPrice = closes.reduce((sum, c, i) => sum + c * volumes[i], 0);

    const plotValues = indicatorPlots
      .filter(p => p.name)
      .map(p => ({
        name: p.name,
        value: p.series && p.series.length > 0 ? p.series[p.series.length - 1] : NaN,
        color: p.color || '#b48cff',
      }));

    const snapshot: ChartSnapshot = {
      bars,
      transformed,
      barType,
      timeframe,
      symbol,
      dataProvider,
      view: { ...viewStatus },
      indicators: indicatorPlots,
      indicatorPlots: plotValues,
      indicatorErrors,
      stats: {
        barCount: bars.length,
        high: Math.max(...highs),
        low: Math.min(...lows),
        open: opens[0] || 0,
        lastClose,
        change,
        changePct,
        volume: cumVol,
        avgVolume: bars.length > 0 ? cumVol / bars.length : 0,
        vwap: cumVol > 0 ? cumVolPrice / cumVol : undefined,
      },
      canvasDataUrl: undefined,
      secondaryCanvasDataUrl: undefined,
      timestamp: Date.now(),
      recentActions: this.getRecentActions(8),
      drawings,
      is3DMode,
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  getLastSnapshot(): ChartSnapshot | null {
    return this.lastSnapshot;
  }

  startAutoCapture(
    callback: (snapshot: ChartSnapshot) => void,
    intervalMs: number = 2000,
  ): void {
    this.captureCallback = callback;
    this.captureInterval = window.setInterval(() => {
      this.frameCount++;
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

  buildChartContext(snapshot: ChartSnapshot): string {
    const { stats, barType, timeframe, symbol, bars } = snapshot;

    const recentBars = bars.slice(-5).map((b, i) => {
      const idx = bars.length - 5 + i;
      return `  [${idx}] O:${b.open.toFixed(2)} H:${b.high.toFixed(2)} L:${b.low.toFixed(2)} C:${b.close.toFixed(2)} V:${Math.round(b.volume)}`;
    }).join('\n');

    const dir = stats.change >= 0 ? '+' : '';
    const changeStr = `${dir}${stats.change.toFixed(2)} (${dir}${stats.changePct.toFixed(2)}%)`;

    const indicators = snapshot.indicatorPlots
      .filter(p => !isNaN(p.value))
      .map(p => `${p.name}=${p.value.toFixed(2)}`).join(', ');

    const context = [
      `${symbol} ${barType} ${timeframe} | Close: ${stats.lastClose.toFixed(2)} ${changeStr}`,
      `Range: ${stats.low.toFixed(2)}-${stats.high.toFixed(2)} | Vol: ${Math.round(stats.volume).toLocaleString()}`,
      indicators ? `Indicators: ${indicators}` : '',
      '--- Recent bars ---',
      recentBars,
    ];

    return context.filter(l => l).join('\n');
  }

  buildActionSummary(snapshot: ChartSnapshot): string {
    const lines: string[] = [
      `User viewing ${snapshot.symbol} on ${snapshot.timeframe} ${snapshot.barType} chart (${snapshot.view.mode})`,
      `Price $${snapshot.stats.lastClose.toFixed(2)} (${snapshot.stats.changePct >= 0 ? '+' : ''}${snapshot.stats.changePct.toFixed(2)}%)`,
    ];
    if (snapshot.view.drawingTool !== 'none') {
      lines.push(`Using ${snapshot.view.drawingTool} drawing tool`);
    }
    if (snapshot.drawings > 0) {
      lines.push(`${snapshot.drawings} drawing(s) on chart`);
    }
    if (snapshot.indicatorPlots.length > 0) {
      lines.push(`Active indicators: ${snapshot.indicatorPlots.map(p => p.name).join(', ')}`);
    }
    return lines.join(' | ');
  }
}
