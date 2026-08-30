import type { BaseBar } from '@dafe/types';
import type { Timeframe } from '../../web/src/data-generator';
import { nativeGet } from './native-http';
import { state } from './state';

const MASSIVE_AGGS = 'https://api.massive.com/v2/aggs/ticker';

interface TfSpec { multiplier: number; timespan: string; days: number; }
const TF_MASSIVE: Record<string, TfSpec> = {
  '1s': { multiplier: 1, timespan: 'second', days: 1 },
  '5s': { multiplier: 5, timespan: 'second', days: 1 },
  '10s': { multiplier: 10, timespan: 'second', days: 3 },
  '30s': { multiplier: 30, timespan: 'second', days: 7 },
  '1m': { multiplier: 1, timespan: 'minute', days: 7 },
  '5m': { multiplier: 5, timespan: 'minute', days: 30 },
  '15m': { multiplier: 15, timespan: 'minute', days: 60 },
  '30m': { multiplier: 30, timespan: 'minute', days: 90 },
  '1h': { multiplier: 1, timespan: 'hour', days: 180 },
  '4h': { multiplier: 4, timespan: 'hour', days: 365 },
  '1d': { multiplier: 1, timespan: 'day', days: 730 },
  '1w': { multiplier: 1, timespan: 'week', days: 3650 },
};

function fmtDate(tsMs: number): string {
  const d = new Date(tsMs);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function massiveTicker(yahooSym: string): string {
  const s = yahooSym.trim().toUpperCase();
  if (s.endsWith('=F') || s.endsWith('-F')) {
    const base = s.replace('=F','').replace('-F','');
    if (base==='DX-Y.NYB') return 'DX';
    return base;
  }
  if (s.endsWith('-USD')) return `X:${s.split('-')[0]}USD`;
  if (s.endsWith('=X')) return `C:${s.replace('=X','')}`;
  return s;
}

export async function fetchMassiveBars(symbol: string, tf: Timeframe): Promise<BaseBar[] | null> {
  const key = state.massiveApiKey?.trim();
  if (!key) return null;
  const spec = TF_MASSIVE[tf];
  if (!spec) return null;
  const now = Date.now();
  const massiveSym = massiveTicker(symbol);
  const url = `${MASSIVE_AGGS}/${encodeURIComponent(massiveSym)}/range/${spec.multiplier}/${spec.timespan}/${fmtDate(now - spec.days * 86_400_000)}/${fmtDate(now)}`;
  const res = await nativeGet(url, { adjusted: 'true', sort: 'asc', limit: '50000', apiKey: key }, 20_000);
  if (!res || res.status !== 200 || !res.data) return null;
  const results = res.data.results as { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number }[];
  if (!Array.isArray(results) || results.length === 0) return null;
  const bars: BaseBar[] = [];
  for (const row of results) {
    if (row.t == null || row.o == null || row.h == null || row.l == null || row.c == null) continue;
    if (!Number.isFinite(row.t) || !Number.isFinite(row.o) || !Number.isFinite(row.h) || !Number.isFinite(row.l) || !Number.isFinite(row.c)) continue;
    const high = Math.max(row.h, row.o, row.c);
    const low = Math.min(row.l, row.o, row.c);
    const b: BaseBar = {
      timestamp: row.t,
      open: row.o,
      high,
      low,
      close: row.c,
      volume: Number.isFinite(row.v) ? Math.max(0, row.v!) : 0,
    };
    bars.push(b);
  }
  if (bars.length === 0) return null;
  bars.sort((a, b) => a.timestamp - b.timestamp);
  // Deduplicate identical timestamps
  const deduped: BaseBar[] = [bars[0]];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp !== deduped[deduped.length - 1].timestamp) {
      deduped.push(bars[i]);
    } else {
      deduped[deduped.length - 1] = bars[i];
    }
  }
  return deduped.length === 0 ? null : deduped;
}