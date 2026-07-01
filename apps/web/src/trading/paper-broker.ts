import type {
  IBroker, Order, OrderRequest, Position, AccountSnapshot, Fill,
} from './broker-port';

export type CommissionMode = 'per-trade' | 'per-share' | 'per-contract';
export interface CommissionConfig {
  mode: CommissionMode;
  value: number; // $ amount — per trade (flat), or per share/contract
}

export type SlippageMode = 'fixed-ticks' | 'percent';
export interface SlippageConfig {
  mode: SlippageMode;
  value: number;   // ticks (fixed-ticks) or percent points (percent, e.g. 0.02 = 0.02%)
  tickSize: number; // $ value of one tick, used only when mode === 'fixed-ticks'
}

export interface PaperBrokerConfig {
  currency: string;
  startingCash: number;
  commission: CommissionConfig;
  slippage: SlippageConfig;
}

export const DEFAULT_COMMISSION: CommissionConfig = { mode: 'per-trade', value: 1.0 };
export const DEFAULT_SLIPPAGE: SlippageConfig = { mode: 'fixed-ticks', value: 1, tickSize: 0.01 };

let _idSeq = 1;

/** Describes exactly how a fill's cost was derived — surfaced in the UI so the
 * user can see the $ math instead of a black-box number. */
export function describeCommission(cfg: CommissionConfig, qty: number): { amount: number; formula: string } {
  switch (cfg.mode) {
    case 'per-trade': return { amount: cfg.value, formula: `$${cfg.value.toFixed(2)} flat per trade` };
    case 'per-share': return { amount: cfg.value * qty, formula: `$${cfg.value.toFixed(4)} × ${qty} shares = $${(cfg.value * qty).toFixed(2)}` };
    case 'per-contract': return { amount: cfg.value * qty, formula: `$${cfg.value.toFixed(2)} × ${qty} contracts = $${(cfg.value * qty).toFixed(2)}` };
  }
}

export function describeSlippage(cfg: SlippageConfig, price: number): { perUnit: number; formula: string } {
  if (cfg.mode === 'fixed-ticks') {
    const perUnit = cfg.value * cfg.tickSize;
    return { perUnit, formula: `${cfg.value} tick(s) × $${cfg.tickSize} = $${perUnit.toFixed(4)}/unit` };
  }
  const perUnit = price * (cfg.value / 100);
  return { perUnit, formula: `${cfg.value}% of $${price.toFixed(2)} = $${perUnit.toFixed(4)}/unit` };
}

export class PaperBroker implements IBroker {
  private orders = new Map<string, Order>();
  private positions = new Map<string, Position>();
  private lastPrice = new Map<string, number>();
  private cash: number;
  private realizedPnL = 0;
  private fillCbs: ((f: Fill) => void)[] = [];
  private orderCbs: ((o: Order) => void)[] = [];

  constructor(private config: PaperBrokerConfig) {
    this.cash = config.startingCash;
  }

  updateConfig(patch: Partial<PaperBrokerConfig>): void {
    this.config = { ...this.config, ...patch };
  }
  getConfig(): PaperBrokerConfig { return this.config; }

  /** Wipe orders/positions/P&L back to a fresh account — does not touch
   * lastPrice (still needed to price the next market order) or any chart
   * history the caller may be keeping (e.g. execution markers) separately. */
  reset(): void {
    this.orders.clear();
    this.positions.clear();
    this.cash = this.config.startingCash;
    this.realizedPnL = 0;
  }

  onFill(cb: (fill: Fill) => void): void { this.fillCbs.push(cb); }
  onOrderUpdate(cb: (order: Order) => void): void { this.orderCbs.push(cb); }

  placeOrder(req: OrderRequest): Order {
    const id = `paper-${_idSeq++}`;
    const order: Order = {
      ...req,
      id,
      status: 'pending',
      createdAt: Date.now(),
      filledQty: 0,
      timeInForce: req.timeInForce || 'GTC',
    };

    if (req.type === 'market') {
      const px = this.lastPrice.get(req.symbol);
      if (px === undefined) {
        order.status = 'rejected';
        order.rejectReason = 'No price available yet';
        this.orders.set(id, order);
        this.emitOrder(order);
        return order;
      }
      this.fill(order, px);
      this.orders.set(id, order);
      this.emitOrder(order);
      return order;
    }

    // Limit / stop / stop-limit / trailing-stop start out working and get
    // evaluated on every subsequent tick() for this symbol.
    if (req.type === 'trailing-stop') {
      const px = this.lastPrice.get(req.symbol);
      order.trailReference = px;
    }
    order.status = 'working';
    this.orders.set(id, order);
    this.emitOrder(order);
    return order;
  }

  cancelOrder(orderId: string): boolean {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'working') return false;
    o.status = 'cancelled';
    this.emitOrder(o);
    return true;
  }

  getOrders(): Order[] { return Array.from(this.orders.values()); }
  getPositions(): Position[] { return Array.from(this.positions.values()).filter(p => p.qty !== 0); }

  getAccount(): AccountSnapshot {
    let unrealized = 0;
    for (const p of this.positions.values()) {
      const px = this.lastPrice.get(p.symbol);
      if (px !== undefined && p.qty !== 0) unrealized += (px - p.avgPrice) * p.qty;
    }
    return {
      currency: this.config.currency,
      cash: this.cash,
      equity: this.cash + unrealized,
      realizedPnL: this.realizedPnL,
      unrealizedPnL: unrealized,
    };
  }

  tick(symbol: string, price: number, _timestamp: number): void {
    this.lastPrice.set(symbol, price);
    for (const o of this.orders.values()) {
      if (o.status !== 'working' || o.symbol !== symbol) continue;

      if (o.type === 'trailing-stop') {
        const best = o.trailReference ?? price;
        // Long trailing-stop (protecting a sell): track the highest price seen.
        // Short trailing-stop (protecting a buy): track the lowest price seen.
        if (o.side === 'sell') {
          if (price > best) o.trailReference = price;
          const trail = o.trailIsPercent ? (o.trailReference ?? price) * ((o.trailAmount ?? 0) / 100) : (o.trailAmount ?? 0);
          const stopLevel = (o.trailReference ?? price) - trail;
          if (price <= stopLevel) this.fill(o, price);
        } else {
          if (price < best) o.trailReference = price;
          const trail = o.trailIsPercent ? (o.trailReference ?? price) * ((o.trailAmount ?? 0) / 100) : (o.trailAmount ?? 0);
          const stopLevel = (o.trailReference ?? price) + trail;
          if (price >= stopLevel) this.fill(o, price);
        }
        continue;
      }

      if (o.type === 'limit') {
        const crossed = o.side === 'buy' ? price <= (o.limitPrice ?? -Infinity) : price >= (o.limitPrice ?? Infinity);
        if (crossed) this.fill(o, o.limitPrice ?? price);
        continue;
      }

      if (o.type === 'stop' || o.type === 'stop-limit') {
        const triggered = o.side === 'buy' ? price >= (o.stopPrice ?? Infinity) : price <= (o.stopPrice ?? -Infinity);
        if (!triggered) continue;
        if (o.type === 'stop') { this.fill(o, price); continue; }
        // stop-limit: once triggered, only fills if the limit condition also holds this tick
        const limitOk = o.side === 'buy' ? price <= (o.limitPrice ?? Infinity) : price >= (o.limitPrice ?? -Infinity);
        if (limitOk) this.fill(o, o.limitPrice ?? price);
      }
    }
  }

  private fill(order: Order, marketPrice: number): void {
    const { perUnit: slipPerUnit } = describeSlippage(this.config.slippage, marketPrice);
    const slipSign = order.side === 'buy' ? 1 : -1; // buys pay up, sells receive less
    const fillPrice = marketPrice + slipSign * slipPerUnit;
    const { amount: commission } = describeCommission(this.config.commission, order.qty);

    order.status = 'filled';
    order.filledAt = Date.now();
    order.fillPrice = fillPrice;
    order.avgFillPrice = fillPrice;
    order.filledQty = order.qty;
    order.commission = commission;
    order.slippage = slipPerUnit * order.qty;

    const signedQty = order.side === 'buy' ? order.qty : -order.qty;
    const existing = this.positions.get(order.symbol) || { symbol: order.symbol, qty: 0, avgPrice: 0, realizedPnL: 0, currency: this.config.currency };

    const prevQty = existing.qty;
    const newQty = prevQty + signedQty;
    if (prevQty === 0 || Math.sign(prevQty) === Math.sign(signedQty)) {
      // Adding to (or opening) a position — blend the average price.
      existing.avgPrice = newQty !== 0 ? (existing.avgPrice * prevQty + fillPrice * signedQty) / newQty : fillPrice;
    } else {
      // Reducing or flipping a position — realize P&L on the closed portion.
      const closedQty = Math.min(Math.abs(signedQty), Math.abs(prevQty));
      const pnl = (fillPrice - existing.avgPrice) * closedQty * Math.sign(prevQty);
      existing.realizedPnL += pnl;
      this.realizedPnL += pnl;
      if (Math.abs(signedQty) > Math.abs(prevQty)) {
        // Flipped through zero — remainder opens a new position at the fill price.
        existing.avgPrice = fillPrice;
      }
    }
    existing.qty = newQty;
    this.positions.set(order.symbol, existing);

    this.cash += -signedQty * fillPrice - commission;

    this.emitOrder(order);
    this.emitFill({
      orderId: order.id, symbol: order.symbol, side: order.side, qty: order.qty,
      price: fillPrice, commission, slippage: slipPerUnit * order.qty, timestamp: order.filledAt,
    });
  }

  private emitOrder(o: Order): void { for (const cb of this.orderCbs) cb(o); }
  private emitFill(f: Fill): void { for (const cb of this.fillCbs) cb(f); }
}
