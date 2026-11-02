import type { BaseBar } from '@dafe/types';
import { state } from './state';

const PING_TIMEOUT_MS = 1500;
const DATA_TIMEOUT_MS = 15000;
const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 15_000;

export const BACKEND_TOKEN_KEY = 'dafe_mobile_backend_token';

let cache: { url: string | null; key: string; at: number } | null = null;
let inFlight: Promise<string | null> | null = null;

export function backendHeaders(): Record<string, string> {
  try {
    const token = (localStorage.getItem(BACKEND_TOKEN_KEY) || '').trim();
    return token ? { 'X-DAFE-Token': token } : {};
  } catch {
    return {};
  }
}

export async function pingBackend(url: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { nativeGetWithHeaders } = await import('./native-http');
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PING_TIMEOUT_MS); });
    const res = await Promise.race([
      nativeGetWithHeaders(`${url.replace(/\/$/, '')}/api/ping`, backendHeaders(), PING_TIMEOUT_MS),
      timeout,
    ]);
    return !!res && res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function candidates(): string[] {
  const list: string[] = [];
  if (state.backendUrl) list.push(state.backendUrl);
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (host && host !== 'localhost' && host !== '127.0.0.1') list.push(`http://${host}:8788`);
  if (!list.includes('http://localhost:8788')) list.push('http://localhost:8788');
  if (!list.includes('http://127.0.0.1:8788')) list.push('http://127.0.0.1:8788');
  return list;
}

async function discover(list: string[]): Promise<string | null> {
  // Every candidate is pinged at once; the first reachable one in priority order wins.
  const results = await Promise.all(list.map((url) => pingBackend(url)));
  const found = list.find((_, i) => results[i]) ?? null;
  cache = { url: found, key: list.join('|'), at: Date.now() };
  return found;
}

export async function findBackend(force = false): Promise<string | null> {
  const list = candidates();
  const key = list.join('|');
  if (!force && cache && cache.key === key) {
    const ttl = cache.url ? OK_TTL_MS : FAIL_TTL_MS;
    if (Date.now() - cache.at < ttl) return cache.url;
  }
  if (!inFlight) {
    inFlight = discover(list).finally(() => { inFlight = null; });
  }
  return inFlight;
}

export interface BackendBars {
  bars: BaseBar[];
  provider: string;
}

export async function fetchBackendBars(symbol: string, timeframe: string, barCount: number, baseUrl: string): Promise<BackendBars | null> {
  try {
    const { nativeGetWithHeaders } = await import('./native-http');
    const query = new URLSearchParams({ timeframe, period: String(barCount) }).toString();
    const res = await nativeGetWithHeaders(`${baseUrl.replace(/\/$/, '')}/api/market-data/${encodeURIComponent(symbol)}?${query}`, backendHeaders(), DATA_TIMEOUT_MS);
    if (!res || res.status < 200 || res.status >= 300) return null;
    const data: any = res.data;
    if (!data?.ok || !data.bars || data.bars.length === 0) return null;
    const bars: BaseBar[] = data.bars.map((b: any) => ({
      timestamp: b.ts * 1000,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    return { bars, provider: data.provider || 'backend' };
  } catch {
    return null;
  }
}

export function providerLabel(p: string): string {
  if (p === 'synthetic') return 'SYNTH';
  if (p === 'massive') return 'MASSIVE';
  if (p === 'yahoo') return 'YAHOO';
  return 'LIVE';
}
