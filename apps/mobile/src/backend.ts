import type { BaseBar } from '@dafe/types';
import { state } from './state';

const PING_TIMEOUT_MS = 3000;
const DATA_TIMEOUT_MS = 15000;
let lastProbe = 0;
let probeResult: string | null = null;

export async function pingBackend(url: string): Promise<boolean> {
  try {
    const { nativeGet } = await import('./native-http');
    const res = await nativeGet(`${url.replace(/\/$/, '')}/api/ping`, {}, PING_TIMEOUT_MS);
    return !!res && res.status >= 200 && res.status < 300;
  } catch {
    return false;
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

export async function findBackend(force = false): Promise<string | null> {
  const now = Date.now();
  if (!force && now - lastProbe < 30_000 && probeResult !== undefined) return probeResult;
  for (const url of candidates()) {
    if (await pingBackend(url)) {
      probeResult = url;
      lastProbe = now;
      return url;
    }
  }
  probeResult = null;
  lastProbe = now;
  return null;
}

export interface BackendBars {
  bars: BaseBar[];
  provider: string;
}

export async function fetchBackendBars(symbol: string, timeframe: string, barCount: number, baseUrl: string): Promise<BackendBars | null> {
  try {
    const { nativeGet } = await import('./native-http');
    const res = await nativeGet(`${baseUrl.replace(/\/$/, '')}/api/market-data/${encodeURIComponent(symbol)}`, { timeframe, period: String(barCount) }, DATA_TIMEOUT_MS);
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