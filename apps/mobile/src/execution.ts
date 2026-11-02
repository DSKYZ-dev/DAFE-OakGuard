import type { BaseBar } from '@dafe/types';
import type { RiskSettings } from './broker-store';
import type { OrderRequest, Fill } from '../../web/src/trading/broker-port';
import { loadBroker } from './state';
import { currentCostModel, SLIPPAGE_STORE, sessionOf, type FeeBreakdown, type VolRegime } from './cost-engine';
import { sealFill } from './ledger';

export type ExecType =
  | 'market'
  | 'limit'
  | 'stop'
  | 'stop-limit'
  | 'trailing-dist'
  | 'trailing-pct'
  | 'chandelier'
  | 'adaptive'
  | 'bracket';

export type ExecStatus = 'working' | 'filled' | 'cancelled' | 'rejected';

export interface TradeRecord {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnl: number;
  rMultiple: number;
  mae: number;
  mfe: number;
  durationMs: number;
  fees: FeeBreakdown;
  slippageObs: number;
  session: string;
  regime: VolRegime;
  orderType: string;
}

const LS_TRADES = 'dafe_mobile_trades';

function loadTrades(): TradeRecord[] {
  try {
    const raw = localStorage.getItem(LS_TRADES);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTrades(t: TradeRecord[]): void {
  try {
    localStorage.setItem(LS_TRADES, JSON.stringify(t.slice(-300)));
  } catch { /* storage full */ }
}

export interface ExecOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type: ExecType;
  status: ExecStatus;
  triggerPrice?: number;
  limitPrice?: number;
  dist?: number;
  distPct?: number;
  atrMult?: number;
  riskAmount?: number;
  ocoId?: string;
  stopPrice?: number;
  targetPrice?: number;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
  stopState?: number;
  rejectReason?: string;
}

export interface NewExecOrder {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type: ExecType;
  triggerPrice?: number;
  limitPrice?: number;
  dist?: number;
  distPct?: number;
  atrMult?: number;
  stopPrice?: number;
  targetPrice?: number;
  riskAmount?: number;
}

export interface EngineStatus {
  halted: boolean;
  dayPnl: number;
  suggestedQty: number;
  atr: number;
  regime: VolRegime;
}

export function pointValue(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.startsWith('NQ') || s.startsWith('MNQ')) return 20;
  if (s.startsWith('ES') || s.startsWith('MES')) return 50;
  if (s.startsWith('YM') || s.startsWith('MYM')) return 5;
  if (s.startsWith('RTY') || s.startsWith('M2K')) return 50;
  if (s.startsWith('CL') || s.startsWith('MCL')) return 1000;
  if (s.startsWith('GC') || s.startsWith('MGC')) return 100;
  if (s.startsWith('SI') || s.startsWith('SIL')) return 5000;
  if (s.startsWith('NG')) return 10000;
  if (s.startsWith('BTC') || s.startsWith('ETH')) return 1;
  return 1;
}

function atrOf(bars: BaseBar[], period: number): number {
  if (bars.length < 2) return 0;
  const start = Math.max(1, bars.length - period);
  let sum = 0;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    sum += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  }
  return sum / (bars.length - start);
}

export class ExecutionEngine {
  private orders: ExecOrder[] = [];
  private bars: BaseBar[] = [];
  private atr = 0;
  private halted = false;
  private dayKey = '';
  private dayStartPnl = 0;
  private onRisk: (msg: string, level: 'warn' | 'halt') => void = () => {};
  private trades: TradeRecord[] = loadTrades();
  private legs = new Map<string, { qty: number; entryPrice: number; entryTime: number; mae: number; mfe: number; fees: FeeBreakdown; risk: number; side: 'buy' | 'sell' }>();

  constructor(private risk: () => RiskSettings) {
    loadBroker().onFill((f: Fill) => this.trackFill(f));
  }

  setBars(bars: BaseBar[]): void {
    this.bars = bars;
    this.atr = atrOf(bars, 14);
    this.rollDay();
  }

  onRiskEvent(cb: (msg: string, level: 'warn' | 'halt') => void): void {
    this.onRisk = cb;
  }

  private rollDay(): void {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayStartPnl = 0;
      this.halted = false;
    }
  }

  regime(): VolRegime {
    const last = this.bars[this.bars.length - 1]?.close ?? 0;
    if (!this.atr || !last) return 'normal';
    const pct = (this.atr / last) * 100;
    if (pct < 0.25) return 'calm';
    if (pct > 0.7) return 'high';
    return 'normal';
  }

  private dayPnl(): number {
    const broker = loadBroker();
    const acc = broker.getAccount();
    let pnl = acc.realizedPnL + this.dayStartPnl;
    const last = this.bars[this.bars.length - 1]?.close ?? 0;
    for (const p of broker.getPositions()) {
      pnl += (last - p.avgPrice) * p.qty * pointValue(p.symbol);
    }
    return pnl;
  }

  status(symbol: string): EngineStatus {
    const risk = this.risk();
    const last = this.bars[this.bars.length - 1]?.close ?? 0;
    let suggestedQty = risk.defaultQty;
    if (risk.volAwareSizing && this.atr > 0 && last > 0) {
      const pv = pointValue(symbol);
      suggestedQty = Math.max(1, Math.floor(risk.maxLossPerTrade / (this.atr * pv)));
    }
    return {
      halted: this.halted,
      dayPnl: this.dayPnl(),
      suggestedQty: Math.min(suggestedQty, risk.maxContracts),
      atr: this.atr,
      regime: this.regime(),
    };
  }

  private checkRisk(o: NewExecOrder, price: number): string | null {
    const risk = this.risk();
    if (this.halted) return 'Trading halted — daily loss limit reached. Resets tomorrow.';
    if (o.qty > risk.maxContracts) return `Order exceeds max contracts (${risk.maxContracts}).`;
    if (this.dayPnl() <= -risk.dailyLossLimit) {
      this.halted = true;
      return 'Daily loss limit reached — trading halted for today.';
    }
    const pv = pointValue(o.symbol);
    let riskAmt = o.riskAmount;
    if (riskAmt == null) {
      const stop = o.stopPrice ?? o.triggerPrice;
      if (stop != null && o.type !== 'limit') {
        riskAmt = Math.abs(price - stop) * o.qty * pv;
      } else if (o.dist != null) {
        riskAmt = o.dist * o.qty * pv;
      } else if (o.type === 'market') {
        riskAmt = (this.atr || price * 0.002) * o.qty * pv;
      }
    }
    if (riskAmt != null && riskAmt > risk.maxLossPerTrade) {
      return `Risk $${Math.round(riskAmt)} exceeds max per-trade $${risk.maxLossPerTrade}. Reduce qty or move stop.`;
    }
    return null;
  }

  private fill(o: ExecOrder, price: number): void {
    const cost = currentCostModel();
    const regime = this.regime();
    let fillPrice = price;
    let slipObs = 0;
    if (o.type === 'market' || o.type === 'stop' || o.type === 'stop-limit') {
      const spread = cost.expectedSpread(o.symbol, price, regime);
      const est = cost.estimateSlippage(o.symbol, regime);
      const dir = o.side === 'buy' ? 1 : -1;
      slipObs = est * (0.6 + Math.random() * 0.8);
      fillPrice = price + dir * (spread / 2 + slipObs);
    }
    o.status = 'filled';
    o.filledAt = Date.now();
    o.fillPrice = fillPrice;
    if (slipObs > 0) {
      SLIPPAGE_STORE.record({
        symbol: o.symbol,
        orderType: o.type,
        side: o.side,
        expected: price,
        actual: fillPrice,
        slippage: slipObs,
        regime,
        session: sessionOf(Date.now()),
        hour: new Date().getHours(),
        timestamp: Date.now(),
      });
    }
    const req: OrderRequest = {
      symbol: o.symbol,
      side: o.side,
      type: 'market',
      qty: o.qty,
    };
    try {
      const broker = loadBroker();
      broker.tick(o.symbol, fillPrice, Date.now());
      const res = broker.placeOrder(req);
      (o as { brokerOrderId?: string }).brokerOrderId = res.id;
    } catch { o.status = 'rejected'; o.rejectReason = 'Broker rejected fill'; }
  }

  private zeroFees(): FeeBreakdown {
    return { commission: 0, exchange: 0, nfa: 0, clearing: 0, brokerage: 0, routing: 0, ip: 0, currency: 'USD', source: 'generic' };
  }

  private trackFill(f: Fill): void {
    const dir = f.side === 'buy' ? 1 : -1;
    const pv = pointValue(f.symbol);
    let leg = this.legs.get(f.symbol);
    if (!leg) {
      leg = {
        qty: 0, entryPrice: f.price, entryTime: f.timestamp, mae: 0, mfe: 0,
        fees: this.zeroFees(),
        risk: (this.atr || f.price * 0.002) * f.qty * pv,
        side: f.side,
      };
      this.legs.set(f.symbol, leg);
    }
    const fees = currentCostModel().fees(f.symbol, f.qty);
    leg.fees.commission += fees.commission;
    leg.fees.exchange += fees.exchange;
    leg.fees.nfa += fees.nfa;
    leg.fees.clearing += fees.clearing;
    leg.fees.brokerage += fees.brokerage;
    leg.fees.routing += fees.routing;
    leg.fees.ip += fees.ip;
    const oldQty = leg.qty;
    leg.qty += dir * f.qty;
    if (oldQty === 0) {
      leg.entryPrice = f.price;
      leg.entryTime = f.timestamp;
      leg.side = f.side;
      leg.risk = (this.atr || f.price * 0.002) * f.qty * pv;
    } else if (leg.qty === 0) {
      this.complete(leg, f, Math.abs(oldQty));
    } else if (Math.sign(leg.qty) !== Math.sign(oldQty)) {
      this.complete(leg, f, Math.abs(oldQty));
      leg.entryPrice = f.price;
      leg.entryTime = f.timestamp;
      leg.side = f.side;
      leg.mae = 0;
      leg.mfe = 0;
      leg.risk = (this.atr || f.price * 0.002) * f.qty * pv;
    }
  }

  private complete(leg: { qty: number; entryPrice: number; entryTime: number; mae: number; mfe: number; fees: FeeBreakdown; risk: number; side: 'buy' | 'sell' }, f: Fill, qty: number): void {
    const pv = pointValue(f.symbol);
    const d = leg.side === 'buy' ? 1 : -1;
    const pnl = (f.price - leg.entryPrice) * d * qty * pv;
    const rec: TradeRecord = {
      id: Math.random().toString(36).slice(2, 10),
      symbol: f.symbol,
      side: leg.side,
      qty,
      entryTime: leg.entryTime,
      entryPrice: leg.entryPrice,
      exitTime: f.timestamp,
      exitPrice: f.price,
      pnl,
      rMultiple: leg.risk > 0 ? pnl / leg.risk : 0,
      mae: leg.mae,
      mfe: leg.mfe,
      durationMs: f.timestamp - leg.entryTime,
      fees: leg.fees,
      slippageObs: 0,
      session: sessionOf(f.timestamp),
      regime: this.regime(),
      orderType: 'paper',
    };
    this.trades.push(rec);
    // Seal before saveTrades trims the window, so no fill can leave unsealed.
    sealFill(rec).catch(() => undefined);
    saveTrades(this.trades);
    this.legs.delete(f.symbol);
  }

  getTrades(): TradeRecord[] { return this.trades; }

  clearTrades(): void {
    this.trades = [];
    saveTrades([]);
  }

  submit(o: NewExecOrder, price: number): ExecOrder {
    const order: ExecOrder = {
      id: Math.random().toString(36).slice(2, 10),
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      type: o.type,
      status: 'working',
      triggerPrice: o.triggerPrice,
      limitPrice: o.limitPrice,
      dist: o.dist,
      distPct: o.distPct,
      atrMult: o.atrMult,
      stopPrice: o.stopPrice,
      targetPrice: o.targetPrice,
      riskAmount: o.riskAmount,
      createdAt: Date.now(),
    };
    const reject = this.checkRisk(o, price);
    if (reject) {
      order.status = 'rejected';
      order.rejectReason = reject;
      this.onRisk(reject, 'halt');
      return order;
    }
    this.orders.push(order);
    this.evaluate(order, price);
    return order;
  }

  cancel(id: string): void {
    const o = this.orders.find((x) => x.id === id);
    if (o && o.status === 'working') {
      o.status = 'cancelled';
      this.cancelOco(o);
    }
  }

  getWorking(symbol?: string): ExecOrder[] {
    return this.orders.filter((o) => o.status === 'working' && (!symbol || o.symbol === symbol));
  }

  all(): ExecOrder[] {
    return this.orders;
  }

  private cancelOco(o: ExecOrder): void {
    if (!o.ocoId) return;
    const sib = this.orders.find((x) => x.id === o.ocoId && x.status === 'working');
    if (sib) {
      sib.status = 'cancelled';
      this.cancelOco(sib);
    }
  }

  flattenAll(): void {
    const broker = loadBroker();
    for (const p of broker.getPositions()) {
      broker.placeOrder({ symbol: p.symbol, side: p.qty > 0 ? 'sell' : 'buy', type: 'market', qty: Math.abs(p.qty) });
    }
    for (const o of this.orders) if (o.status === 'working') o.status = 'cancelled';
  }

  onTick(price: number, ts: number): void {
    this.rollDay();
    for (const leg of this.legs.values()) {
      const dir = leg.qty > 0 ? 1 : -1;
      const adv = dir > 0 ? leg.entryPrice - price : price - leg.entryPrice;
      const fav = dir > 0 ? price - leg.entryPrice : leg.entryPrice - price;
      leg.mae = Math.max(leg.mae, adv);
      leg.mfe = Math.max(leg.mfe, fav);
    }
    if (!this.halted && this.dayPnl() <= -this.risk().dailyLossLimit) {
      this.halted = true;
      this.onRisk('Daily loss limit reached — trading halted and positions flattened.', 'halt');
      this.flattenAll();
    }
    for (const o of this.orders) {
      if (o.status === 'working') this.evaluate(o, price);
    }
  }

  private stopDistance(o: ExecOrder, price: number): number {
    if (o.type === 'trailing-pct' && o.distPct != null) return price * o.distPct;
    if (o.type === 'trailing-dist' && o.dist != null) return o.dist;
    if ((o.type === 'chandelier' || o.type === 'adaptive') && o.atrMult != null && this.atr > 0) {
      let d = o.atrMult * this.atr;
      if (o.type === 'adaptive') {
        const r = this.regime();
        if (r === 'high') d *= 1.5;
        else if (r === 'calm') d *= 0.85;
      }
      if (o.dist != null) d = Math.max(d, o.dist);
      return d;
    }
    return 0;
  }

  private evaluate(o: ExecOrder, price: number): void {
    const prevState = o.stopState ?? (o.side === 'buy' ? price : price);
    if (o.type === 'bracket') {
      if (o.stopPrice == null || o.targetPrice == null) {
        o.status = 'rejected';
        o.rejectReason = 'Bracket needs stop and target';
        return;
      }
      this.fill(o, price);
      this.orders.push(this.child(o, 'stop', o.side === 'buy' ? 'sell' : 'buy', o.stopPrice, o));
      this.orders.push(this.child(o, 'limit', o.side === 'buy' ? 'sell' : 'buy', o.targetPrice, o));
      return;
    }
    switch (o.type) {
      case 'market':
        this.fill(o, price);
        return;
      case 'limit':
        if (o.side === 'buy' ? price <= o.triggerPrice! : price >= o.triggerPrice!) this.fill(o, price);
        return;
      case 'stop':
      case 'stop-limit':
        if (o.side === 'buy' ? price >= o.triggerPrice! : price <= o.triggerPrice!) {
          if (o.type === 'stop-limit') {
            if (o.side === 'buy' ? price <= o.limitPrice! : price >= o.limitPrice!) this.fill(o, o.limitPrice!);
          } else this.fill(o, price);
        }
        return;
      case 'trailing-dist':
      case 'trailing-pct':
      case 'chandelier':
      case 'adaptive': {
        const extreme = o.side === 'buy' ? Math.max(prevState, price) : Math.min(prevState, price);
        o.stopState = extreme;
        const dist = this.stopDistance(o, price);
        const stop = o.side === 'buy' ? extreme - dist : extreme + dist;
        const hit = o.side === 'buy' ? price <= stop : price >= stop;
        if (hit) this.fill(o, price);
        return;
      }
    }
  }

  private child(parent: ExecOrder, type: 'stop' | 'limit', side: 'buy' | 'sell', price: number, oco: ExecOrder): ExecOrder {
    const c: ExecOrder = {
      id: Math.random().toString(36).slice(2, 10),
      symbol: parent.symbol,
      side,
      qty: parent.qty,
      type,
      status: 'working',
      triggerPrice: price,
      createdAt: Date.now(),
      ocoId: oco.id,
    };
    oco.ocoId = c.id;
    return c;
  }
}