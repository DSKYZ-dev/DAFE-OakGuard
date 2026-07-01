import type { BaseBar } from '@dafe/types';

export interface LiveDataConfig {
  baseUrl: string;
  symbol: string;
  timeframe: string;
  barCount: number;
}

export interface ProviderStatus {
  name: string;
  available: boolean;
  needsApiKey: boolean;
  hasApiKey: boolean;
  subMinuteTimeframes?: string[];
}

export class LiveDataStream {
  private config: LiveDataConfig;
  private onDataCallback: ((bars: BaseBar[], provider: string) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;

  constructor(config: Partial<LiveDataConfig> = {}) {
    this.config = {
      baseUrl: 'http://localhost:8788',
      symbol: 'SPY',
      timeframe: '1h',
      barCount: 200,
      ...config,
    };
  }

  setSymbol(symbol: string): void {
    this.config.symbol = symbol;
  }

  setTimeframe(timeframe: string): void {
    this.config.timeframe = timeframe;
  }

  setBarCount(count: number): void {
    this.config.barCount = count;
  }

  onData(callback: (bars: BaseBar[], provider: string) => void): void {
    this.onDataCallback = callback;
  }

  onError(callback: (errMsg: string) => void): void {
    this.onErrorCallback = callback;
  }

  async fetchBars(): Promise<{ bars: BaseBar[]; provider: string } | null> {
    const { baseUrl, symbol, timeframe, barCount } = this.config;

    try {
      const resp = await fetch(
        `${baseUrl}/api/market-data/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&period=${barCount}`,
      );
      const data = await resp.json();

      if (!data.ok || !data.bars || data.bars.length === 0) {
        throw new Error(data.detail || 'No data returned');
      }

      const bars: BaseBar[] = data.bars.map((b: any) => ({
        timestamp: b.ts * 1000,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

      if (this.onDataCallback) {
        this.onDataCallback(bars, data.provider);
      }

      return { bars, provider: data.provider };
    } catch (err: any) {
      if (this.onErrorCallback) {
        this.onErrorCallback(err.message);
      }
      return null;
    }
  }

  async getProviders(): Promise<ProviderStatus[]> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/api/market-data/providers`);
      const data = await resp.json();
      return data.providers || [];
    } catch {
      return [];
    }
  }

  static async fetchHistorical(
    symbol: string,
    timeframe: string = '1h',
    barCount: number = 200,
    baseUrl: string = 'http://localhost:8788',
  ): Promise<BaseBar[] | null> {
    const stream = new LiveDataStream({ baseUrl, symbol, timeframe, barCount });
    const result = await stream.fetchBars();
    return result?.bars ?? null;
  }
}
