import type { BaseBar } from '@dafe/types';
import type { Timeframe } from '../../web/src/data-generator';
import { nativeGet } from './native-http';

const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YF2 = 'https://query2.finance.yahoo.com/v8/finance/chart/';
interface IntervalSpec { interval: string; range: string; }
const INTERVALS: Record<string, IntervalSpec> = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '10m': { interval: '10m', range: '10d' },
  '15m': { interval: '15m', range: '15d' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '1h', range: '3mo' },
  '4h': { interval: '1h', range: '3mo' },
  '1d': { interval: '1d', range: '2y' },
  '1w': { interval: '1wk', range: '5y' },
};

async function chartOnce(base: string, symbol: string, interval: string, range: string): Promise<BaseBar[] | null> {
  const url = `${base}${encodeURIComponent(symbol)}`;
  const res = await nativeGet(url, { interval, range, includePrePost: 'false', events: 'div,split' }, 15_000);
  if (!res || res.status < 200 || res.status >= 300) return null;
  const data = res.data;
  const result = data?.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) return null;
  const ts = result.timestamp as number[];
  const q = result.indicators.quote[0];
  const bars: BaseBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open[i];
    const high = q.high[i];
    const low = q.low[i];
    const close = q.close[i];
    if (open == null || high == null || low == null || close == null) continue;
    bars.push({
      timestamp: ts[i] * 1000,
      open,
      high,
      low,
      close,
      volume: Math.round(q.volume[i] ?? 0),
    });
  }
  return bars.length === 0 ? null : bars;
}

function isValidBar(b: BaseBar): boolean {
  if (!Number.isFinite(b.timestamp) || !Number.isFinite(b.open) || !Number.isFinite(b.high) || !Number.isFinite(b.low) || !Number.isFinite(b.close)) return false;
  if (b.open <= 0 && b.close <= 0 && b.high <= 0 && b.low <= 0) return false;
  if (b.timestamp > Date.now() + 86_400_000) return false;
  return true;
}

function validateBars(bars: BaseBar[]): BaseBar[] {
  const out: BaseBar[] = [];
  for (const b of bars) {
    if (!isValidBar(b)) continue;
    const high = Math.max(b.high, b.open, b.close);
    const low = Math.min(b.low, b.open, b.close);
    out.push({
      timestamp: b.timestamp,
      open: b.open,
      high,
      low,
      close: b.close,
      volume: Number.isFinite(b.volume) ? Math.max(0, b.volume) : 0,
    });
  }
  if (out.length === 0) return out;
  out.sort((a, b) => a.timestamp - b.timestamp);
  // Deduplicate timestamps
  const deduped: BaseBar[] = [out[0]];
  for (let i = 1; i < out.length; i++) {
    if (out[i].timestamp !== deduped[deduped.length - 1].timestamp) {
      deduped.push(out[i]);
    } else {
      deduped[deduped.length - 1] = out[i];
    }
  }
  return deduped;
}

export async function fetchYahooBars(symbol: string, tf: Timeframe): Promise<BaseBar[] | null> {
  try {
    const spec = INTERVALS[tf];
    if (!spec) return null;
    let bars = await chartOnce(YF, symbol, spec.interval, spec.range);
    if (!bars) bars = await chartOnce(YF2, symbol, spec.interval, spec.range);
    if (!bars) return null;
    bars = validateBars(bars);
    if (!bars || bars.length === 0) return null;
    if (tf === '4h') return validateBars(aggregateTo(bars, 4));
    return bars;
  } catch {
    return null;
  }
}

function aggregateTo(bars: BaseBar[], hours: number): BaseBar[] {
  const tfMs = hours * 3600_000;
  const out: BaseBar[] = [];
  let cur: BaseBar | null = null;
  for (const b of bars) {
    const bucket = Math.floor(b.timestamp / tfMs) * tfMs;
    if (!cur || bucket !== cur.timestamp) {
      cur = { ...b, timestamp: bucket, volume: b.volume };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return out;
}