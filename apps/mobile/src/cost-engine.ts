import { state } from './state';

export type VolRegime = 'calm' | 'normal' | 'high';

export interface FeeBreakdown {
  commission: number;
  exchange: number;
  nfa: number;
  clearing: number;
  brokerage: number;
  routing: number;
  ip: number;
  currency: string;
  source: 'tradovate' | 'generic';
}

export interface SlippageObservation {
  symbol: string;
  orderType: string;
  side: 'buy' | 'sell';
  expected: number;
  actual: number;
  slippage: number;
  regime: VolRegime;
  session: string;
  hour: number;
  timestamp: number;
}

export interface SlippageStats {
  median: number;
  mean: number;
  p90: number;
  p95: number;
  count: number;
}

export interface CostModel {
  fees(symbol: string, qty: number): FeeBreakdown;
  expectedSpread(symbol: string, price: number, regime: VolRegime): number;
  estimateSlippage(symbol: string, regime: VolRegime): number;
}

export interface ProviderProfile {
  id: string;
  name: string;
  getFees(): Promise<FeeBreakdown | null>;
  getContracts?(pattern: string): Promise<unknown[]>;
  getMarketData?(symbol: string): Promise<unknown>;
  getAccount?(): Promise<unknown>;
  getExecutionData?(): Promise<unknown>;
}

const LS_SLIP = 'dafe_mobile_slippage_obs';
const LS_FEES = 'dafe_mobile_fee_profile';
const MAX_OBS = 800;

export class SlippageStore {
  private obs: SlippageObservation[] = [];

  constructor() {
    try {
      const raw = localStorage.getItem(LS_SLIP);
      if (raw) this.obs = JSON.parse(raw);
    } catch { this.obs = []; }
  }

  record(o: SlippageObservation): void {
    this.obs.push(o);
    if (this.obs.length > MAX_OBS) this.obs = this.obs.slice(-MAX_OBS);
    localStorage.setItem(LS_SLIP, JSON.stringify(this.obs));
  }

  all(): SlippageObservation[] { return this.obs; }

  private stats(list: number[]): SlippageStats {
    if (list.length === 0) return { median: 0, mean: 0, p90: 0, p95: 0, count: 0 };
    const sorted = [...list].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return {
      median: q(0.5),
      mean: list.reduce((a, b) => a + b, 0) / list.length,
      p90: q(0.9),
      p95: q(0.95),
      count: list.length,
    };
  }

  forSymbol(symbol: string): SlippageStats {
    return this.stats(this.obs.filter((o) => o.symbol === symbol).map((o) => o.slippage));
  }

  byOrderType(symbol: string): Record<string, SlippageStats> {
    const out: Record<string, SlippageStats> = {};
    for (const t of new Set(this.obs.filter((o) => o.symbol === symbol).map((o) => o.orderType))) {
      out[t] = this.stats(this.obs.filter((o) => o.symbol === symbol && o.orderType === t).map((o) => o.slippage));
    }
    return out;
  }

  byRegime(symbol: string): Record<string, SlippageStats> {
    const out: Record<string, SlippageStats> = {};
    for (const r of ['calm', 'normal', 'high'] as VolRegime[]) {
      const list = this.obs.filter((o) => o.symbol === symbol && o.regime === r).map((o) => o.slippage);
      if (list.length) out[r] = this.stats(list);
    }
    return out;
  }

  bySession(symbol: string): Record<string, SlippageStats> {
    const out: Record<string, SlippageStats> = {};
    for (const s of new Set(this.obs.filter((o) => o.symbol === symbol).map((o) => o.session))) {
      out[s] = this.stats(this.obs.filter((o) => o.symbol === symbol && o.session === s).map((o) => o.slippage));
    }
    return out;
  }
}

export function sessionOf(ts: number): string {
  const d = new Date(ts);
  const h = d.getUTCHours();
  if (h >= 23 || h < 7) return 'asias';
  if (h < 13) return 'london';
  return 'newyork';
}

export const SLIPPAGE_STORE = new SlippageStore();

// ─── Fee profiles ─────────────────────────────────────────────

const GENERIC_FUTURES_FEES: FeeBreakdown = {
  commission: 2.49, exchange: 0.4, nfa: 0.02, clearing: 0.09, brokerage: 0, routing: 0.1, ip: 0,
  currency: 'USD',
  source: 'generic',
};

const GENERIC_EQUITY_FEES: FeeBreakdown = {
  commission: 0.005, exchange: 0, nfa: 0, clearing: 0, brokerage: 0, routing: 0.004, ip: 0,
  currency: 'USD',
  source: 'generic',
};

export class GenericCostModel implements CostModel {
  fees(symbol: string, _qty: number): FeeBreakdown {
    const s = symbol.toUpperCase();
    if (/^(ES|NQ|YM|RTY|CL|GC|SI|NG|MES|MNQ|MYM|M2K|MGC|MCL|ZB|ZN|ZS|ZC|ZW)/.test(s)) {
      return { ...GENERIC_FUTURES_FEES };
    }
    return { ...GENERIC_EQUITY_FEES };
  }

  expectedSpread(symbol: string, price: number, regime: VolRegime): number {
    const s = symbol.toUpperCase();
    let ticks: number;
    if (/^(ES|MES)/.test(s)) ticks = 0.25;
    else if (/^(NQ|MNQ)/.test(s)) ticks = 0.25;
    else if (/^(CL|MCL)/.test(s)) ticks = 0.01;
    else if (/^(GC|MGC)/.test(s)) ticks = 0.1;
    else if (/^(SI)/.test(s)) ticks = 0.005;
    else if (/^(NG)/.test(s)) ticks = 0.001;
    else ticks = price * 0.0001;
    const mult = regime === 'high' ? 2.5 : regime === 'calm' ? 0.7 : 1;
    return ticks * mult;
  }

  estimateSlippage(symbol: string, regime: VolRegime): number {
    const stats = SLIPPAGE_STORE.forSymbol(symbol);
    if (stats.count > 0) return stats.median;
    const spread = this.expectedSpread(symbol, 100, regime);
    const mult = regime === 'high' ? 2 : regime === 'calm' ? 0.5 : 1;
    return Math.max(spread * 0.35 * mult, spread * 0.1);
  }
}

export const GENERIC_COST = new GenericCostModel();

let feeProfile: FeeBreakdown | null = null;
let feeProfileAt = 0;
export const FEE_PROFILE_TTL = 10 * 60_000;

export function cachedFeeProfile(): FeeBreakdown | null {
  if (feeProfile && Date.now() - feeProfileAt < FEE_PROFILE_TTL) return feeProfile;
  try {
    const raw = localStorage.getItem(LS_FEES);
    if (raw) {
      const saved = JSON.parse(raw) as { fees: FeeBreakdown; at: number };
      if (Date.now() - saved.at < FEE_PROFILE_TTL) {
        feeProfile = saved.fees;
        feeProfileAt = saved.at;
        return feeProfile;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function setFeeProfile(f: FeeBreakdown): void {
  feeProfile = f;
  feeProfileAt = Date.now();
  localStorage.setItem(LS_FEES, JSON.stringify({ fees: f, at: feeProfileAt }));
}

export function currentCostModel(): CostModel {
  const prof = cachedFeeProfile();
  if (prof) {
    return {
      fees: (symbol, qty) => ({ ...prof, commission: prof.commission * qty, exchange: prof.exchange * qty, nfa: prof.nfa * qty, clearing: prof.clearing * qty, brokerage: prof.brokerage * qty, routing: prof.routing * qty, ip: prof.ip * qty }),
      expectedSpread: GENERIC_COST.expectedSpread.bind(GENERIC_COST),
      estimateSlippage: GENERIC_COST.estimateSlippage.bind(GENERIC_COST),
    };
  }
  return GENERIC_COST;
}

// ─── Provider profiles ────────────────────────────────────────

export const PROVIDER_REGISTRY: Record<string, ProviderProfile> = {
  generic: { id: 'generic', name: 'Generic defaults (clearly labeled)', getFees: async () => null },
};

export function registerProvider(p: ProviderProfile): void {
  PROVIDER_REGISTRY[p.id] = p;
}

export function activeProviderId(): string {
  return state.tradovateConnected ? 'tradovate' : 'generic';
}

export function costSourceLabel(): string {
  const p = PROVIDER_REGISTRY[activeProviderId()];
  return p ? p.name : 'Generic defaults (clearly labeled)';
}