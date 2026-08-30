export interface TradovateCreds {
  name: string;
  password: string;
  appId: string;
  appSecret: string;
  cid?: string;
}

export interface RiskSettings {
  dailyLossLimit: number;
  maxLossPerTrade: number;
  maxContracts: number;
  defaultQty: number;
  volAwareSizing: boolean;
  autoFlattenOnDailyLoss: boolean;
}

export const PAPER_SIZES = [25000, 50000, 100000, 200000, 300000] as const;
export type PaperSize = typeof PAPER_SIZES[number];

export interface BrokerSettings {
  mode: 'paper' | 'tradovate';
  tradovate: TradovateCreds;
  risk: RiskSettings;
  oneClick: boolean;
  domEnabled: boolean;
  paperSize: PaperSize;
}

export const DEFAULT_RISK: RiskSettings = {
  dailyLossLimit: 500,
  maxLossPerTrade: 150,
  maxContracts: 5,
  defaultQty: 1,
  volAwareSizing: true,
  autoFlattenOnDailyLoss: true,
};

export const DEFAULT_BROKER: BrokerSettings = {
  mode: 'paper',
  tradovate: { name: '', password: '', appId: '', appSecret: '', cid: '' },
  risk: { ...DEFAULT_RISK },
  oneClick: false,
  domEnabled: true,
  paperSize: 100000,
};

const LS_KEY = 'dafe_mobile_broker_settings';

export function loadBrokerSettings(): BrokerSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_BROKER, risk: { ...DEFAULT_RISK } };
    const saved = JSON.parse(raw) as Partial<BrokerSettings>;
    return {
      ...DEFAULT_BROKER,
      ...saved,
      risk: { ...DEFAULT_RISK, ...(saved.risk ?? {}) },
      tradovate: { ...DEFAULT_BROKER.tradovate, ...(saved.tradovate ?? {}) },
    };
  } catch {
    return { ...DEFAULT_BROKER, risk: { ...DEFAULT_RISK } };
  }
}

export function saveBrokerSettings(s: BrokerSettings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

export function getTradovateCreds(): TradovateCreds {
  return loadBrokerSettings().tradovate;
}