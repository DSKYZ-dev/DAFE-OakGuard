/**
 * Auto-switch Data Adapter — security → source
 * Futures (=F) → Massive/Polygon WS (fallback Yahoo), Crypto (-USD Binance spot) → Binance WS, FX/Equities → Yahoo
 * Validated: 10s floor int(ts//10)*10, OHLC high=max low=min close=last volume=sum(delta)
 */
import { state } from './state';

export type DataSource = 'polygon' | 'binance' | 'yahoo' | 'massive';

const BINANCE_CRYPTO = new Set(['BTC','ETH','SOL','BNB','ADA','XRP','DOGE','AVAX','DOT','MATIC','LTC','LINK','UNI','ATOM','ETC','FIL','TRX','APT','ARB']);

export function getDataSourceForSymbol(symbol: string): DataSource {
  const s = symbol.trim().toUpperCase();
  // Futures: anything ending =F or -F → Polygon/Massive (Massive provides all futures)
  if (s.endsWith('=F') || s.endsWith('-F') || s==='BTC=F') {
    // If Massive key configured, prefer Massive REST (accurate), else Polygon WS, else Yahoo
    if (state.massiveApiKey?.trim()) return 'massive';
    return 'polygon';
  }
  if (s.endsWith('-USD')) {
    const base = s.split('-')[0];
    if (BINANCE_CRYPTO.has(base)) return 'binance';
    return 'yahoo';
  }
  if (s.includes('=X')) return 'yahoo';
  // Equities/ETFs default Yahoo, but Massive can serve if key present and user selects Massive source
  return 'yahoo';
}

const RENDER_RELAY = "wss://dafe-relay.onrender.com";
export function getWsUrlForSymbol(symbol: string, relayBase?: string): string {
  const stored = (()=>{ try{ return localStorage.getItem("dafe_tick_ws_url") || ""; }catch{return ""}})();
  const base = relayBase || stored || (state.backendUrl ? state.backendUrl.replace(/^http/, 'ws') : "") || RENDER_RELAY || 'ws://localhost:8000';
  const src = getDataSourceForSymbol(symbol);
  return `${base.replace(/\/$/,'')}/ws?symbol=${encodeURIComponent(symbol)}&source=${src}`;
}

export function binanceSymbolFor(usdSymbol: string): string {
  // BTC-USD → btcusdt
  const base = usdSymbol.split('-')[0].toLowerCase();
  return `${base}usdt`;
}

export function polygonTickerFor(futuresSymbol: string): string {
  // ES=F → ES, NQ=F → NQ, 6E=F → C:EURUSD? Polygon uses ES, NQ, etc. For futures, use ES, NQ, etc.
  return futuresSymbol.replace('=F','').replace('-F','').replace('DX-Y.NYB','DX');
}
