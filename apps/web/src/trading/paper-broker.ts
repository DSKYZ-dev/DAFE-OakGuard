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
  private lastTimestamp = new Map<string, number>();
  private cash: number;
  private realizedPnL = 0;
  private fills: Fill[] = [];
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
    this.fills = [];
    this.cash = this.config.startingCash;
    this.realizedPnL = 0;
  }
  getFills(): Fill[] { return [...this.fills]; }

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
      // Register BEFORE filling — fill() synchronously invokes onFill
      // callbacks, and a callback that looks up this order by id via
      // getOrders() (e.g. the backtest engine's exit-reason classification)
      // must find it already present, not mid-registration.
      this.orders.set(id, order);
      this.fill(order, px, this.lastTimestamp.get(req.symbol));
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

  tick(symbol: string, price: number, timestamp: number): void {
    this.lastPrice.set(symbol, price);
    this.lastTimestamp.set(symbol, timestamp);
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
          if (price <= stopLevel) this.fill(o, price, timestamp);
        } else {
          if (price < best) o.trailReference = price;
          const trail = o.trailIsPercent ? (o.trailReference ?? price) * ((o.trailAmount ?? 0) / 100) : (o.trailAmount ?? 0);
          const stopLevel = (o.trailReference ?? price) + trail;
          if (price >= stopLevel) this.fill(o, price, timestamp);
        }
        continue;
      }

      if (o.type === 'limit') {
        const crossed = o.side === 'buy' ? price <= (o.limitPrice ?? -Infinity) : price >= (o.limitPrice ?? Infinity);
        if (crossed) this.fill(o, o.limitPrice ?? price, timestamp);
        continue;
      }

      if (o.type === 'stop' || o.type === 'stop-limit') {
        const triggered = o.side === 'buy' ? price >= (o.stopPrice ?? Infinity) : price <= (o.stopPrice ?? -Infinity);
        if (!triggered) continue;
        if (o.type === 'stop') { this.fill(o, price, timestamp); continue; }
        // stop-limit: once triggered, only fills if the limit condition also holds this tick
        const limitOk = o.side === 'buy' ? price <= (o.limitPrice ?? Infinity) : price >= (o.limitPrice ?? -Infinity);
        if (limitOk) this.fill(o, o.limitPrice ?? price, timestamp);
      }
    }
  }

  /**
   * Intrabar-aware evaluation for backtest replay — checks every working
   * order against the bar's FULL open/high/low/close range instead of two
   * isolated snapshots (tick() called at just open, then just close), so a
   * stop or limit touched by a wick that reverses before the close still
   * fills. Two things a single-price tick() structurally cannot do:
   *  1. Gap-through pricing — if the bar's open already cleared a level
   *     (a real overnight/session gap), fill at the open, not at a stale
   *     level no real order could have been honored at.
   *  2. A deterministic same-bar ambiguity rule — we don't have true tick
   *     data, so when a bar's range straddles BOTH a stop and a limit for
   *     the same position (which one actually triggered first intrabar is
   *     unknowable from OHLC alone), stop-type orders are evaluated FIRST.
   *     This is the same conservative convention engine.ts's
   *     placeBracketOrders() already documents for the same-tick case
   *     (stop-loss placed before take-profit), extended consistently here
   *     to the whole-bar case.
   * Trailing-stops ratchet continuously in reality; this approximates that
   * with a "high-water mark" pass: extend the trail reference to the bar's
   * most-favorable extreme (what any continuously-updating trail would have
   * reached before a pullback), THEN check whether the bar's unfavorable
   * extreme would have triggered the resulting stop level.
   */
  tickBar(symbol: string, bar: { open: number; high: number; low: number; close: number }, timestamp: number): void {
    for (const o of this.orders.values()) {
      if (o.status !== 'working' || o.symbol !== symbol || o.type !== 'trailing-stop') continue;
      if (o.side === 'sell') {
        if (o.trailReference === undefined || bar.high > o.trailReference) o.trailReference = bar.high;
      } else {
        if (o.trailReference === undefined || bar.low < o.trailReference) o.trailReference = bar.low;
      }
    }

    const rank = (o: Order) => (o.type === 'limit' ? 1 : 0); // stop-type orders resolve first
    const working = Array.from(this.orders.values())
      .filter(o => o.status === 'working' && o.symbol === symbol)
      .sort((a, b) => rank(a) - rank(b));

    for (const o of working) {
      // An earlier fill in this same pass (e.g. a stop) can trigger onFill's
      // sweep-cancel of its sibling bracket — re-check before touching it.
      if (o.status !== 'working') continue;

      if (o.type === 'trailing-stop') {
        const ref = o.trailReference ?? (o.side === 'sell' ? bar.high : bar.low);
        const trail = o.trailIsPercent ? ref * ((o.trailAmount ?? 0) / 100) : (o.trailAmount ?? 0);
        if (o.side === 'sell') {
          const stopLevel = ref - trail;
          if (bar.low <= stopLevel) this.fill(o, bar.open < stopLevel ? bar.open : stopLevel, timestamp);
        } else {
          const stopLevel = ref + trail;
          if (bar.high >= stopLevel) this.fill(o, bar.open > stopLevel ? bar.open : stopLevel, timestamp);
        }
        continue;
      }

      if (o.type === 'stop' || o.type === 'stop-limit') {
        const stopPrice = o.stopPrice ?? (o.side === 'buy' ? Infinity : -Infinity);
        const triggered = o.side === 'buy' ? bar.high >= stopPrice : bar.low <= stopPrice;
        if (!triggered) continue;
        // Gap-through: if the open already cleared the stop, that's the
        // realistic fill — a real order couldn't have been honored at a
        // level the market skipped past overnight.
        const gapped = o.side === 'buy' ? bar.open >= stopPrice : bar.open <= stopPrice;
        const fillPx = gapped ? bar.open : stopPrice;
        if (o.type === 'stop') { this.fill(o, fillPx, timestamp); continue; }
        const limitOk = o.side === 'buy' ? fillPx <= (o.limitPrice ?? Infinity) : fillPx >= (o.limitPrice ?? -Infinity);
        if (limitOk) this.fill(o, o.limitPrice ?? fillPx, timestamp);
        continue;
      }

      if (o.type === 'limit') {
        const limitPrice = o.limitPrice ?? (o.side === 'buy' ? -Infinity : Infinity);
        const triggered = o.side === 'buy' ? bar.low <= limitPrice : bar.high >= limitPrice;
        if (!triggered) continue;
        const gapped = o.side === 'buy' ? bar.open <= limitPrice : bar.open >= limitPrice;
        this.fill(o, gapped ? bar.open : limitPrice, timestamp);
      }
    }

    this.lastPrice.set(symbol, bar.close);
    this.lastTimestamp.set(symbol, timestamp);
  }

  /** timestamp defaults to real wall-clock time for any future caller that
   * doesn't have a simulated one to pass — correct for live paper trading,
   * and what this unconditionally did before backtest replay needed its
   * fills stamped with simulated bar time instead. */
  private fill(order: Order, marketPrice: number, timestamp: number = Date.now()): void {
    const { perUnit: slipPerUnit } = describeSlippage(this.config.slippage, marketPrice);
    const slipSign = order.side === 'buy' ? 1 : -1; // buys pay up, sells receive less
    const fillPrice = marketPrice + slipSign * slipPerUnit;
    const { amount: commission } = describeCommission(this.config.commission, order.qty);

    order.status = 'filled';
    order.filledAt = timestamp;
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

    const fill: Fill = {
      orderId: order.id, symbol: order.symbol, side: order.side, qty: order.qty,
      price: fillPrice, commission, slippage: slipPerUnit * order.qty, timestamp: order.filledAt,
    };
    this.fills.push(fill);
    if (this.fills.length > 500) this.fills.shift();
    this.emitOrder(order);
    this.emitFill(fill);
  }

  private emitOrder(o: Order): void { for (const cb of this.orderCbs) cb(o); }
  private emitFill(f: Fill): void { for (const cb of this.fillCbs) cb(f); }
}
