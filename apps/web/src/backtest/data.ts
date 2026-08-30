import type { BaseBar } from '@dafe/types';
import { LiveDataStream } from '../data-stream/live-data';
import { generateBars, type Timeframe } from '../data-generator';
import type { RuntimeBarData } from '../oakscript/interpreter';

/**
 * Hard cap on backtest bar count. The backend's `/api/market-data` `period`
 * query param is ambiguous — "days back" for Massive (which combined with
 * its 50,000-row ascending-sort cap risks silently returning ancient data
 * instead of recent data for large requests) and just a window-size
 * threshold for yfinance — never literally "number of bars." Rather than
 * fix that shared, live-chart-critical endpoint, this cap+slice enforces
 * "most-recent N bars" client-side regardless of what actually comes back.
 */
export const MAX_BACKTEST_BARS = 10_000;

export async function fetchBacktestBars(
  symbol: string,
  timeframe: string,
  barCount: number,
  baseUrl?: string,
): Promise<BaseBar[]> {
  const cappedCount = Math.min(barCount, MAX_BACKTEST_BARS);
  // Backtests are self-contained by default. A backend is only contacted when
  // the caller explicitly supplies one; this avoids hidden localhost coupling.
  const bars = baseUrl
    ? await LiveDataStream.fetchHistorical(symbol, timeframe, cappedCount, baseUrl)
    : generateBars(cappedCount, timeframe as Timeframe, symbol);
  if (!bars || bars.length === 0) {
    throw new Error(`No historical data returned for ${symbol} (${timeframe}).`);
  }
  return bars.slice(-cappedCount);
}

export function barsToRuntimeBarData(bars: BaseBar[]): RuntimeBarData {
  const count = bars.length;
  const close = new Array<number>(count);
  const open = new Array<number>(count);
  const high = new Array<number>(count);
  const low = new Array<number>(count);
  const volume = new Array<number>(count);
  const time = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const b = bars[i];
    close[i] = b.close;
    open[i] = b.open;
    high[i] = b.high;
    low[i] = b.low;
    volume[i] = b.volume;
    time[i] = b.timestamp;
  }
  return { close, open, high, low, volume, time, count };
}
