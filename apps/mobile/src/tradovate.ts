import type { BaseBar } from '@dafe/types';
import type { FeeBreakdown } from './cost-engine';
import { registerProvider, setFeeProfile } from './cost-engine';
import { state, persistSettings } from './state';

const API = 'https://api.tradovate.com';
const MD = 'https://md.tradovate.com';
const MD_WS = 'wss://md.tradovate.com/v2';

export interface TradovateAuth {
  accessToken: string;
  expirationTime: number;
  userId?: number;
  name?: string;
  cid?: number;
}

export interface TradovateContract {
  id: number;
  name: string;
  symbol: string;
  underlyingType: string;
  description?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
  tradeVolume?: number;
  bidSize?: number;
  askSize?: number;
}

export interface TvOrderRequest {
  accountId: number;
  symbol: string;
  action: 'Buy' | 'Sell';
  orderQty: number;
  orderType: 'Market' | 'Limit' | 'Stop' | 'TrailingStop';
  price?: number;
  stopPrice?: number;
  trailingStopDistance?: number;
  trailingStopDistanceType?: 'Ticks' | 'Percent';
}

let _auth: TradovateAuth | null = null;

export function isAuthed(): boolean {
  return !!_auth && Date.now() < _auth.expirationTime - 60_000;
}

async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tradovate ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(host: string, path: string, token: string): Promise<T> {
  const res = await fetch(host + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tradovate GET ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function tradovateLogin(opts: { name: string; password: string; appId: string; appSecret: string; cid?: string }): Promise<TradovateAuth> {
  const body: Record<string, string> = {
    name: opts.name,
    password: opts.password,
    appId: opts.appId,
    appVersion: '1.0',
  };
  if (opts.cid) body.cid = opts.cid;
  if (opts.appSecret) body.secret = opts.appSecret;
  const auth = await apiPost<TradovateAuth>('/auth/accesstoken', body);
  if (!auth.accessToken) {
    const err = (auth as unknown as { errorText?: string }).errorText;
    throw new Error(err || 'Tradovate login failed — check credentials and app ID');
  }
  _auth = auth;
  return auth;
}

export interface TradovateFillFee {
  commission: number;
  commissionCurrency: string;
  exchangeFee: number;
  exchangeFeeCurrency: string;
  nfaFee: number;
  nfaFeeCurrency: string;
  clearingFee: number;
  clearingFeeCurrency: string;
  brokerageFee: number;
  brokerageFeeCurrency: string;
  ipFee: number;
  ipFeeCurrency: string;
  routingFee: number;
  routingFeeCurrency: string;
}

export async function fetchTradovateFillFees(count = 60): Promise<FeeBreakdown | null> {
  const token = await requireAuth();
  let items: TradovateFillFee[] = [];
  try {
    const list = await apiGet<{ items?: TradovateFillFee[] }>('/v1/fillFee/list', API, token);
    items = list.items ?? [];
  } catch {
    try {
      const list = await apiGet<{ items?: TradovateFillFee[] }>('/v1/fillFee/items', API, token);
      items = list.items ?? [];
    } catch {
      return null;
    }
  }
  if (items.length === 0) return null;
  const recent = items.slice(-count);
  const avg = (pick: (f: TradovateFillFee) => number) => recent.reduce((a, f) => a + (pick(f) || 0), 0) / recent.length;
  const cur = recent[recent.length - 1]?.commissionCurrency || 'USD';
  return {
    commission: avg((f) => f.commission),
    exchange: avg((f) => f.exchangeFee),
    nfa: avg((f) => f.nfaFee),
    clearing: avg((f) => f.clearingFee),
    brokerage: avg((f) => f.brokerageFee),
    routing: avg((f) => f.routingFee),
    ip: avg((f) => f.ipFee),
    currency: cur,
    source: 'tradovate',
  };
}

export interface MarketDataSubscription {
  id: number;
  name?: string;
  startDate?: string;
  endDate?: string;
}

export async function fetchMarketDataSubscriptions(): Promise<MarketDataSubscription[]> {
  const token = await requireAuth();
  try {
    const res = await apiGet<{ items?: MarketDataSubscription[] }>('/v1/marketDataSubscription/list', API, token);
    return res.items ?? [];
  } catch {
    return [];
  }
}

registerProvider({
  id: 'tradovate',
  name: 'Tradovate (fees pulled from your account)',
  getFees: () => fetchTradovateFillFees(),
  getContracts: (pattern: string) => findTradovateContracts(pattern),
  getMarketData: (symbol: string) => getTradovateQuote(symbol),
  getAccount: () => getTradovateAccounts(),
  getExecutionData: () => fetchTradovateFillFees(200),
});

export async function syncTradovateProfile(): Promise<boolean> {
  try {
    const fees = await fetchTradovateFillFees();
    if (fees) {
      setFeeProfile(fees);
      state.tradovateConnected = true;
      persistSettings();
      return true;
    }
  } catch { /* not connected */ }
  return false;
}

export async function requireAuth(): Promise<string> {
  if (isAuthed() && _auth) return _auth.accessToken;
  throw new Error('Not connected to Tradovate — run setup first');
}

export async function getTradovateAccounts(): Promise<{ id: number; name: string }[]> {
  const token = await requireAuth();
  const list = await apiGet<{ id: number; name: string }[]>('/api/account/list', API, token);
  return list;
}

export async function findTradovateContracts(pattern: string): Promise<TradovateContract[]> {
  const token = await requireAuth();
  try {
    const res = await apiPost<{ contracts?: TradovateContract[] }>('/contract/findMatchingContracts', { name: pattern }, token);
    return res.contracts ?? [];
  } catch {
    const list = await apiGet<TradovateContract[]>('/contract/list', API, token);
    const p = pattern.toUpperCase();
    return list.filter((c) => c.name.includes(p) || c.symbol.includes(p)).slice(0, 25);
  }
}

export async function getTradovateQuote(symbol: string): Promise<Quote | null> {
  const token = await requireAuth();
  const res = await apiGet<{ quotes: Quote[] }>(`/v2/quote?symbol=${encodeURIComponent(symbol)}`, MD, token);
  const q = res.quotes?.[0];
  return q ?? null;
}

export interface QuoteStreamCallbacks {
  onQuote: (q: Quote) => void;
  onStatus: (s: 'connecting' | 'open' | 'closed' | 'error', msg?: string) => void;
}

export class TradovateQuoteStream {
  private ws: WebSocket | null = null;
  private symbol = '';
  private closedByUser = false;
  private reconnectDelay = 2000;
  private token: string | null = null;

  constructor(private cb: QuoteStreamCallbacks) {}

  async connect(symbol: string, token: string): Promise<void> {
    this.symbol = symbol;
    this.token = token;
    this.closedByUser = false;
    this.reconnectDelay = 2000;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private open(): void {
    if (this.closedByUser || !this.token) return;
    this.cb.onStatus('connecting');
    try {
      const url = `${MD_WS}?deviceId=${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}&accessToken=${encodeURIComponent(this.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.cb.onStatus('open');
        ws.send(JSON.stringify({ subscribeQuote: [{ symbol: this.symbol }] }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.d) {
            const d = msg.d;
            this.cb.onQuote({
              symbol: d.symbol ?? this.symbol,
              bid: d.bid ?? 0,
              ask: d.ask ?? 0,
              last: d.last ?? 0,
              timestamp: d.timestamp ?? Date.now(),
              tradeVolume: d.totalTradeVolume,
              bidSize: d.bidSize,
              askSize: d.askSize,
            });
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onerror = () => this.cb.onStatus('error', 'stream error');
      ws.onclose = () => {
        this.ws = null;
        this.cb.onStatus('closed');
        if (!this.closedByUser) {
          setTimeout(() => this.open(), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 30_000);
        }
      };
    } catch (err) {
      this.cb.onStatus('error', err instanceof Error ? err.message : String(err));
      if (!this.closedByUser) setTimeout(() => this.open(), this.reconnectDelay);
    }
  }
}

export async function placeTradovateOrder(req: TvOrderRequest): Promise<{ id: number; orderId: number }> {
  const token = await requireAuth();
  const res = await apiPost<{ orderId: number }>('/order/placeOrder', req, token);
  return { id: res.orderId, orderId: res.orderId };
}

export async function placeTradovateBracket(req: TvOrderRequest & { stopPrice?: number; targetPrice?: number }): Promise<{ id: number }> {
  const token = await requireAuth();
  const body: Record<string, unknown> = {
    accountId: req.accountId,
    symbol: req.symbol,
    orderQty: req.orderQty,
    bracket1: { action: req.action === 'Buy' ? 'Sell' : 'Buy', orderType: 'Stop', stopPrice: req.stopPrice },
    bracket2: { action: req.action === 'Buy' ? 'Sell' : 'Buy', orderType: 'Limit', price: req.targetPrice },
  };
  const res = await apiPost<{ id: number }>('/order/placeBracketOrder', body, token);
  return res;
}

export async function cancelTradovateOrder(orderId: number): Promise<void> {
  const token = await requireAuth();
  await apiPost<unknown>('/order/cancelOrder', { orderId }, token);
}

export function mapYahooToTradovate(symbol: string): string {
  const s = symbol.toUpperCase();
  if (['ES=F', 'ES', 'ESM6'].includes(s)) return 'ES';
  if (['NQ=F', 'NQ'].includes(s)) return 'NQ';
  if (['YM=F', 'YM'].includes(s)) return 'YM';
  if (['RTY=F', 'RTY'].includes(s)) return 'RTY';
  if (['CL=F', 'CL'].includes(s)) return 'CL';
  if (['GC=F', 'GC'].includes(s)) return 'GC';
  if (['SI=F', 'SI'].includes(s)) return 'SI';
  if (['NG=F', 'NG'].includes(s)) return 'NG';
  return s.replace(/=F$/, '');
}

export function barsFromQuotes(symbol: string, tfMs: number, quotes: Quote[]): BaseBar[] {
  const bars: BaseBar[] = [];
  let cur: BaseBar | null = null;
  for (const q of quotes) {
    const bucket = Math.floor(q.timestamp / tfMs) * tfMs;
    if (!cur || bucket !== cur.timestamp) {
      cur = { timestamp: bucket, open: q.last, high: q.last, low: q.last, close: q.last, volume: 0 };
      bars.push(cur);
    }
    cur.high = Math.max(cur.high, q.last);
    cur.low = Math.min(cur.low, q.last);
    cur.close = q.last;
    cur.volume += 1;
  }
  return bars;
}