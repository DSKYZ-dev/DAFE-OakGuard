import type { BaseBar } from '@dafe/types';
import type { BarType, Timeframe } from '../../web/src/data-generator';
import type { ViewState, PerfMode, TradeMarker } from '../../web/src/chart-renderer';
import type { OakPlot, OakStrategyOrder } from '../../web/src/oakscript/runtime';
import { PaperBroker } from '../../web/src/trading/paper-broker';
import { DEFAULT_COMMISSION, DEFAULT_SLIPPAGE } from '../../web/src/trading/paper-broker';
import { detectCurrency } from '../../web/src/trading/currency';
import { getIndicators, getUserIndicators } from '../../web/src/oakscript';

export interface ActiveIndicator {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  plots: OakPlot[];
  // Explicit model.*/strategy.* order events from the last run. Not persisted.
  strategyOrders?: OakStrategyOrder[];
  errors: string[];
}

export const TIMEFRAMES: Timeframe[] = ['1s', '5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

export const BAR_TYPES: { id: BarType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'heikin-ashi', label: 'Heikin-Ashi' },
  { id: 'renko', label: 'Renko' },
  { id: 'range-bar', label: 'Range' },
  { id: 'volume-bar', label: 'Volume' },
  { id: 'tick-bar', label: 'Tick' },
  { id: 'kagi', label: 'Kagi' },
  { id: 'footprint', label: 'Footprint' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'dollar-bar', label: 'Dollar' },
  { id: 'imbalance-bar', label: 'Imbalance' },
];

export type SymbolCat = 'Futures' | 'Equities' | 'ETFs' | 'Crypto' | 'FX';
export const SYMBOL_CATS: SymbolCat[] = ['Futures', 'ETFs', 'Equities', 'Crypto', 'FX'];
export const SYMBOLS: { symbol: string; name: string; cat: SymbolCat; yahoo?: boolean }[] = [
  // Futures — first tab, every prop-firm contract (Yahoo tickers where available)
  { symbol: 'ES=F', name: 'E-mini S&P 500', cat: 'Futures', yahoo: true },
  { symbol: 'NQ=F', name: 'E-mini Nasdaq 100', cat: 'Futures', yahoo: true },
  { symbol: 'YM=F', name: 'Mini Dow (YM)', cat: 'Futures', yahoo: true },
  { symbol: 'RTY=F', name: 'E-mini Russell 2000', cat: 'Futures', yahoo: true },
  { symbol: 'MES=F', name: 'Micro E-mini S&P', cat: 'Futures' },
  { symbol: 'MNQ=F', name: 'Micro Nasdaq', cat: 'Futures' },
  { symbol: 'MYM=F', name: 'Micro Dow', cat: 'Futures' },
  { symbol: 'M2K=F', name: 'Micro Russell', cat: 'Futures' },
  { symbol: 'CL=F', name: 'Crude Oil (WTI)', cat: 'Futures', yahoo: true },
  { symbol: 'GC=F', name: 'Gold Futures', cat: 'Futures', yahoo: true },
  { symbol: 'SI=F', name: 'Silver Futures', cat: 'Futures', yahoo: true },
  { symbol: 'NG=F', name: 'Nat Gas Futures', cat: 'Futures', yahoo: true },
  { symbol: 'HG=F', name: 'Copper Futures', cat: 'Futures', yahoo: true },
  { symbol: 'PL=F', name: 'Platinum', cat: 'Futures', yahoo: true },
  { symbol: 'PA=F', name: 'Palladium', cat: 'Futures', yahoo: true },
  { symbol: 'ZB=F', name: '30Y T-Bond', cat: 'Futures', yahoo: true },
  { symbol: 'ZN=F', name: '10Y T-Note', cat: 'Futures', yahoo: true },
  { symbol: 'ZF=F', name: '5Y T-Note', cat: 'Futures', yahoo: true },
  { symbol: 'ZT=F', name: '2Y T-Note', cat: 'Futures', yahoo: true },
  { symbol: 'ZC=F', name: 'Corn', cat: 'Futures', yahoo: true },
  { symbol: 'ZW=F', name: 'Wheat', cat: 'Futures', yahoo: true },
  { symbol: 'ZS=F', name: 'Soybeans', cat: 'Futures', yahoo: true },
  { symbol: 'ZL=F', name: 'Soybean Oil', cat: 'Futures', yahoo: true },
  { symbol: 'ZM=F', name: 'Soybean Meal', cat: 'Futures', yahoo: true },
  { symbol: 'HO=F', name: 'Heating Oil', cat: 'Futures', yahoo: true },
  { symbol: 'RB=F', name: 'RBOB Gasoline', cat: 'Futures', yahoo: true },
  { symbol: 'DX-Y.NYB', name: 'US Dollar Index', cat: 'Futures', yahoo: true },
  { symbol: '6E=F', name: 'Euro FX', cat: 'Futures', yahoo: true },
  { symbol: '6J=F', name: 'Yen FX', cat: 'Futures', yahoo: true },
  { symbol: '6B=F', name: 'GBP FX', cat: 'Futures', yahoo: true },
  { symbol: '6A=F', name: 'AUD FX', cat: 'Futures', yahoo: true },
  { symbol: '6C=F', name: 'CAD FX', cat: 'Futures', yahoo: true },
  { symbol: '6S=F', name: 'CHF FX', cat: 'Futures', yahoo: true },
  // Additional Massive futures (CME/CBOT/NYMEX/COMEX — auto Massive/Polygon, Yahoo fallback where available)
  { symbol: 'UB=F', name: 'Ultra T-Bond', cat: 'Futures', yahoo: true },
  { symbol: 'ZQ=F', name: '30-Day Fed Funds', cat: 'Futures' },
  { symbol: 'ZR=F', name: 'Rough Rice', cat: 'Futures', yahoo: true },
  { symbol: 'ZO=F', name: 'Oats', cat: 'Futures', yahoo: true },
  { symbol: 'HE=F', name: 'Lean Hogs', cat: 'Futures', yahoo: true },
  { symbol: 'LE=F', name: 'Live Cattle', cat: 'Futures', yahoo: true },
  { symbol: 'GF=F', name: 'Feeder Cattle', cat: 'Futures', yahoo: true },
  { symbol: 'BZ=F', name: 'Brent Crude', cat: 'Futures', yahoo: true },
  { symbol: 'BTC=F', name: 'Bitcoin Futures (CME)', cat: 'Futures' },
  // ETFs
  { symbol: 'SPY', name: 'S&P 500 ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'DIA', name: 'Dow Jones ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'IWM', name: 'Russell 2000 ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'VTI', name: 'Total Market ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'VOO', name: 'S&P 500 Vanguard', cat: 'ETFs', yahoo: true },
  { symbol: 'GLD', name: 'Gold ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'SLV', name: 'Silver ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'TLT', name: '20Y Treasury ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'SMH', name: 'Semiconductor ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'IBIT', name: 'Bitcoin ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'ARKK', name: 'Innovation ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'TQQQ', name: '3x Nasdaq ETF', cat: 'ETFs', yahoo: true },
  { symbol: 'SQQQ', name: '-3x Nasdaq ETF', cat: 'ETFs', yahoo: true },
  // Equities
  { symbol: 'AAPL', name: 'Apple Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'MSFT', name: 'Microsoft Corp.', cat: 'Equities', yahoo: true },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'AMZN', name: 'Amazon.com', cat: 'Equities', yahoo: true },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', cat: 'Equities', yahoo: true },
  { symbol: 'META', name: 'Meta Platforms', cat: 'Equities', yahoo: true },
  { symbol: 'TSLA', name: 'Tesla Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'AVGO', name: 'Broadcom Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'AMD', name: 'Advanced Micro Devices', cat: 'Equities', yahoo: true },
  { symbol: 'NFLX', name: 'Netflix Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'ADBE', name: 'Adobe Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'CRM', name: 'Salesforce Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'INTC', name: 'Intel Corp.', cat: 'Equities', yahoo: true },
  { symbol: 'ORCL', name: 'Oracle Corp.', cat: 'Equities', yahoo: true },
  { symbol: 'IBM', name: 'IBM Corp.', cat: 'Equities', yahoo: true },
  { symbol: 'QCOM', name: 'Qualcomm Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'MU', name: 'Micron Technology', cat: 'Equities', yahoo: true },
  { symbol: 'NOW', name: 'ServiceNow', cat: 'Equities', yahoo: true },
  { symbol: 'PANW', name: 'Palo Alto Networks', cat: 'Equities', yahoo: true },
  { symbol: 'SNOW', name: 'Snowflake Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'JPM', name: 'JPMorgan Chase', cat: 'Equities', yahoo: true },
  { symbol: 'BAC', name: 'Bank of America', cat: 'Equities', yahoo: true },
  { symbol: 'GS', name: 'Goldman Sachs', cat: 'Equities', yahoo: true },
  { symbol: 'V', name: 'Visa Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'MA', name: 'Mastercard Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'PYPL', name: 'PayPal Holdings', cat: 'Equities', yahoo: true },
  { symbol: 'COIN', name: 'Coinbase Global', cat: 'Equities', yahoo: true },
  { symbol: 'PLTR', name: 'Palantir Tech', cat: 'Equities', yahoo: true },
  { symbol: 'XOM', name: 'Exxon Mobil', cat: 'Equities', yahoo: true },
  { symbol: 'CVX', name: 'Chevron Corp.', cat: 'Equities', yahoo: true },
  { symbol: 'JNJ', name: 'Johnson & Johnson', cat: 'Equities', yahoo: true },
  { symbol: 'UNH', name: 'UnitedHealth', cat: 'Equities', yahoo: true },
  { symbol: 'PFE', name: 'Pfizer Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'LLY', name: 'Eli Lilly', cat: 'Equities', yahoo: true },
  { symbol: 'WMT', name: 'Walmart Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'COST', name: 'Costco Wholesale', cat: 'Equities', yahoo: true },
  { symbol: 'HD', name: 'Home Depot', cat: 'Equities', yahoo: true },
  { symbol: 'MCD', name: "McDonald's Corp.", cat: 'Equities', yahoo: true },
  { symbol: 'DIS', name: 'Walt Disney Co.', cat: 'Equities', yahoo: true },
  { symbol: 'BA', name: 'Boeing Co.', cat: 'Equities', yahoo: true },
  { symbol: 'CAT', name: 'Caterpillar Inc.', cat: 'Equities', yahoo: true },
  { symbol: 'GE', name: 'GE Aerospace', cat: 'Equities', yahoo: true },
  { symbol: 'LMT', name: 'Lockheed Martin', cat: 'Equities', yahoo: true },
  { symbol: 'NOC', name: 'Northrop Grumman', cat: 'Equities', yahoo: true },
  // Crypto — Binance spot (BTCUSDT etc. → BTC-USD) + Yahoo fallback where available
  { symbol: 'BTC-USD', name: 'Bitcoin', cat: 'Crypto', yahoo: true },
  { symbol: 'ETH-USD', name: 'Ethereum', cat: 'Crypto', yahoo: true },
  { symbol: 'SOL-USD', name: 'Solana', cat: 'Crypto', yahoo: true },
  { symbol: 'BNB-USD', name: 'BNB', cat: 'Crypto', yahoo: true },
  { symbol: 'ADA-USD', name: 'Cardano', cat: 'Crypto', yahoo: true },
  { symbol: 'XRP-USD', name: 'XRP', cat: 'Crypto', yahoo: true },
  { symbol: 'DOGE-USD', name: 'Dogecoin', cat: 'Crypto', yahoo: true },
  { symbol: 'AVAX-USD', name: 'Avalanche', cat: 'Crypto', yahoo: true },
  { symbol: 'DOT-USD', name: 'Polkadot', cat: 'Crypto', yahoo: true },
  { symbol: 'MATIC-USD', name: 'Polygon', cat: 'Crypto', yahoo: true },
  { symbol: 'LTC-USD', name: 'Litecoin', cat: 'Crypto', yahoo: true },
  { symbol: 'LINK-USD', name: 'Chainlink', cat: 'Crypto', yahoo: true },
  { symbol: 'UNI-USD', name: 'Uniswap', cat: 'Crypto', yahoo: true },
  { symbol: 'ATOM-USD', name: 'Cosmos', cat: 'Crypto', yahoo: true },
  { symbol: 'ETC-USD', name: 'Ethereum Classic', cat: 'Crypto', yahoo: true },
  { symbol: 'FIL-USD', name: 'Filecoin', cat: 'Crypto', yahoo: true },
  { symbol: 'TRX-USD', name: 'TRON', cat: 'Crypto', yahoo: true },
  { symbol: 'APT-USD', name: 'Aptos', cat: 'Crypto', yahoo: true },
  { symbol: 'ARB-USD', name: 'Arbitrum', cat: 'Crypto', yahoo: true },
  // FX
  { symbol: 'EURUSD=X', name: 'Euro / USD', cat: 'FX', yahoo: true },
  { symbol: 'GBPUSD=X', name: 'GBP / USD', cat: 'FX', yahoo: true },
  { symbol: 'USDJPY=X', name: 'USD / Yen', cat: 'FX', yahoo: true },
];

export type DataProvider = 'backend' | 'massive' | 'yahoo' | 'cache' | 'synthetic';
// Preferred feed override — set by Settings switches. When 'yahoo' is forced,
// loadBars() skips Massive and Backend and goes straight to Yahoo (and the
// MASSIVE badge disappears from the topbar).
export type PreferredFeed = 'auto' | 'yahoo' | 'massive' | 'backend' | 'synthetic';

export interface AppState {
  symbol: string;
  timeframe: Timeframe;
  barType: BarType;
  bars: BaseBar[];
  transformed: BaseBar[];
  view: ViewState;
  vpEnabled: boolean;
  vpWidth: number;
  is3D: boolean;
  dataSource: 'live' | 'synthetic';
  dataProvider: DataProvider;
  preferredFeed: PreferredFeed;
  backendMode: 'auto' | 'backend' | 'offline';
  crosshair: { x: number; y: number } | null;
  indicators: ActiveIndicator[];
  // Non-persisted review preview (desktop "PREVIEW · not applied"). Runs as an
  // extra chart overlay only; never written to indicators or saved source.
  preview: { source: string; name: string } | null;
  markers: TradeMarker[];
  backendUrl: string;
  massiveApiKey: string;
  perf: PerfMode;
  liveEnabled: boolean;
  onboarded: boolean;
  domEnabled: boolean;
  tradovateConnected: boolean;
  broker: PaperBroker | null;
}

const LS_KEYS = {
  symbol: 'dafe_mobile_symbol',
  timeframe: 'dafe_mobile_tf',
  barType: 'dafe_mobile_bartype',
  backendUrl: 'dafe_mobile_backend',
  massiveApiKey: 'dafe_mobile_massive_key',
  backendMode: 'dafe_mobile_backend_mode',
  preferredFeed: 'dafe_mobile_preferred_feed',
  perf: 'dafe_mobile_perf',
  indicators: 'dafe_mobile_indicators',
  broker: 'dafe_mobile_broker',
  vpEnabled: 'dafe_mobile_vp',
  onboarded: 'dafe_mobile_onboarded',
  dom: 'dafe_mobile_dom',
  tvConnected: 'dafe_mobile_tv_connected',
  trades: 'dafe_mobile_trades',
};

// Public web demo mode — ?demo=1 (and the matching hash form) locks the app
// into synthetic-only data, paper trading, no onboarding and no persistence
// so a visitor on dafetradingsystems.com gets a clean, safe, private session.
export const DEMO_MODE: boolean = (() => {
  try {
    if (typeof location === 'undefined') return false;
    return /[?&]demo=1\b/.test(location.search) || /(^|[?#])demo=1\b/.test(location.hash);
  } catch { return false; }
})();

export const state: AppState = {
  symbol: localStorage.getItem(LS_KEYS.symbol) || 'SPY',
  timeframe: (localStorage.getItem(LS_KEYS.timeframe) as Timeframe) || '5m',
  barType: (localStorage.getItem(LS_KEYS.barType) as BarType) || 'candlestick',
  bars: [],
  transformed: [],
  view: { scrollX: 0, barSpacing: 9, offsetY: 0, scaleY: 1 },
  vpEnabled: localStorage.getItem(LS_KEYS.vpEnabled) !== '0',
  vpWidth: 60,
  is3D: false,
  dataSource: 'synthetic',
  backendMode: (localStorage.getItem(LS_KEYS.backendMode) as 'auto' | 'backend' | 'offline') || 'auto',
  preferredFeed: ((localStorage.getItem('dafe_mobile_preferred_feed') as PreferredFeed) || 'auto'),
  crosshair: null,
  indicators: [],
  preview: null,
  markers: [],
  backendUrl: localStorage.getItem(LS_KEYS.backendUrl) || '',
  // Demo mode must NEVER inherit (or persist) a real visitor's Massive key —
  // the public build ships with data locked to synthetic regardless.
  massiveApiKey: DEMO_MODE ? '' : (localStorage.getItem(LS_KEYS.massiveApiKey) || ''),
  perf: (localStorage.getItem(LS_KEYS.perf) as PerfMode) || 'high',
  liveEnabled: false,
  onboarded: DEMO_MODE ? true : localStorage.getItem(LS_KEYS.onboarded) === '1',
  domEnabled: localStorage.getItem(LS_KEYS.dom) !== '0',
  tradovateConnected: false,
  dataProvider: 'synthetic',
  broker: null,
};

// Demo sessions are ephemeral: writes are dropped (read-only localStorage) so
// every visitor starts from the same clean state and nothing they do on the
// public page can leak into (or read from) a real session on the same browser.
if (DEMO_MODE) {
  try {
    const noop = (): void => {};
    const noopStr = (): string => null as unknown as string;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({
        getItem: noopStr,
        setItem: noop,
        removeItem: noop,
        clear: noop,
        key: noopStr,
        length: 0,
      }),
    });
  } catch { /* Object.defineProperty can throw in older WebViews — demo still works, just persists */ }
}

// Widget visibility flags. '1' = hidden; absent or '0' = shown.
export const WIDGET_KEYS = { dash: 'dafe_mobile_w_dash', regime: 'dafe_mobile_w_regime' } as const;
export type WidgetKey = keyof typeof WIDGET_KEYS;

export function widgetHidden(key: WidgetKey): boolean {
  try { return localStorage.getItem(WIDGET_KEYS[key]) === '1'; } catch { return false; }
}

export function saveWidgetHidden(key: WidgetKey, hidden: boolean): void {
  try { localStorage.setItem(WIDGET_KEYS[key], hidden ? '1' : '0'); } catch { /* storage full */ }
}

export function loadBroker(): PaperBroker {
  if (state.broker) return state.broker;
  // Prefer account size from broker-store (single source); fall back to legacy LS_KEYS.broker
  let paperSize = 100000;
  try { const bs = JSON.parse(localStorage.getItem('dafe_mobile_broker_settings') || '{}'); if (bs.paperSize) paperSize = bs.paperSize; } catch {}
  const saved = localStorage.getItem(LS_KEYS.broker);
  if (saved) {
    try {
      const data = JSON.parse(saved);
      const b = new PaperBroker({
        startingCash: data.cash ?? paperSize,
        currency: data.currency ?? 'USD',
        commission: data.commission ?? DEFAULT_COMMISSION,
        slippage: data.slippage ?? DEFAULT_SLIPPAGE,
      });
      state.broker = b;
      return b;
    } catch { /* fall through to fresh broker */ }
  }
  const b = new PaperBroker({
    startingCash: paperSize,
    currency: 'USD',
    commission: DEFAULT_COMMISSION,
    slippage: DEFAULT_SLIPPAGE,
  });
  state.broker = b;
  return b;
}
export function resetPaperBroker(): void {
  try { localStorage.removeItem(LS_KEYS.broker); localStorage.removeItem('dafe_mobile_trades'); } catch {}
  state.broker = null;
  state.markers = [];
  markersBySymbol.clear();
  loadBroker();
}

const markersBySymbol = new Map<string, TradeMarker[]>();
export function hookFillMarkers(): void {
  const b = loadBroker();
  b.onFill((f) => {
    const key = (f as any).symbol || state.symbol;
    const arr = markersBySymbol.get(key) || [];
    arr.push({ timestamp: f.timestamp, price: f.price, side: f.side, qty: f.qty });
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    markersBySymbol.set(key, arr);
    // Keep state.markers in sync with current symbol for rendering
    if (key === state.symbol) state.markers = [...arr];
  });
}
export function syncMarkersForSymbol(symbol: string): void {
  state.markers = [...(markersBySymbol.get(symbol) || [])];
}
export function clearMarkersForSymbol(symbol: string): void {
  markersBySymbol.delete(symbol);
  if (state.symbol === symbol) state.markers = [];
}

export function persistBroker(): void {
  const b = state.broker;
  if (!b) return;
  const acc = b.getAccount();
  localStorage.setItem(LS_KEYS.broker, JSON.stringify({ cash: acc.cash, currency: acc.currency, commission: b.getConfig().commission, slippage: b.getConfig().slippage }));
}

export function persistSettings(): void {
  localStorage.setItem(LS_KEYS.symbol, state.symbol);
  localStorage.setItem(LS_KEYS.timeframe, state.timeframe);
  localStorage.setItem(LS_KEYS.barType, state.barType);
  localStorage.setItem(LS_KEYS.backendUrl, state.backendUrl);
  localStorage.setItem(LS_KEYS.massiveApiKey, state.massiveApiKey);
  localStorage.setItem(LS_KEYS.backendMode, state.backendMode);
  localStorage.setItem(LS_KEYS.preferredFeed, state.preferredFeed);
  localStorage.setItem(LS_KEYS.perf, state.perf);
  localStorage.setItem(LS_KEYS.vpEnabled, state.vpEnabled ? '1' : '0');
  localStorage.setItem(LS_KEYS.onboarded, state.onboarded ? '1' : '0');
  localStorage.setItem(LS_KEYS.dom, state.domEnabled ? '1' : '0');
  localStorage.setItem(LS_KEYS.tvConnected, state.tradovateConnected ? '1' : '0');
  localStorage.setItem(LS_KEYS.indicators, JSON.stringify(state.indicators.map((i) => ({ id: i.id, name: i.name, source: i.source, enabled: i.enabled }))));
}

export function cacheBars(symbol: string, tf: string, bars: BaseBar[]): void {
  try {
    localStorage.setItem(`dafe_mobile_cache_${symbol}_${tf}`, JSON.stringify({ at: Date.now(), bars: bars.slice(-600) }));
  } catch { /* storage full — ignore */ }
}

export function loadCachedBars(symbol: string, tf: string): BaseBar[] | null {
  try {
    const raw = localStorage.getItem(`dafe_mobile_cache_${symbol}_${tf}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { at: number; bars: BaseBar[] };
    if (!data.bars || data.bars.length === 0) return null;
    return data.bars;
  } catch {
    return null;
  }
}

// Built-in library scripts ship with the app. User-saved scripts never count.
export function isBuiltinIndicator(name: string): boolean {
  return getIndicators().some((d) => d.name === name) && !getUserIndicators().some((d) => d.name === name);
}

// Every built-in library script keeps an entry. One missing after load comes
// back switched off, so turning a built-in off never loses it.
function restoreBuiltinIndicators(): void {
  for (const def of getIndicators()) {
    if (!isBuiltinIndicator(def.name)) continue;
    if (state.indicators.some((i) => i.name === def.name)) continue;
    state.indicators.push({ id: `builtin-${def.name}`, name: def.name, source: def.source, enabled: false, plots: [], errors: [] });
  }
}

export function loadIndicators(): void {
  const saved = localStorage.getItem(LS_KEYS.indicators);
  if (saved) {
    try {
      state.indicators = JSON.parse(saved).map((i: { id: string; name: string; source: string; enabled: boolean }) => ({
        id: i.id, name: i.name, source: i.source, enabled: i.enabled, plots: [], errors: [],
      }));
    } catch { state.indicators = []; }
  }
  restoreBuiltinIndicators();
}

export function resetAll(): void {
  Object.values(LS_KEYS).forEach((k) => localStorage.removeItem(k));
  window.location.reload();
}

export function qtyUnit(symbol: string): string {
  const s = symbol.toUpperCase();
  const cur = detectCurrency(s);
  if (s.endsWith('=X') || cur !== 'USD') return 'lots';
  if (s.endsWith('-USD') || s.startsWith('BTC') || s.startsWith('ETH') || s.startsWith('SOL')) return 'coins';
  if (/^(ES|NQ|YM|RTY|CL|GC|SI|NG|ZB|ZN|MGC|MCL|MNQ|MES|MYM)/.test(s)) return 'contracts';
  return 'shares';
}