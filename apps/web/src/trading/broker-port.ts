/**
 * Broker port — the contract every execution backend (paper, or a future real
 * broker like Tradovate) implements. UI code talks only to this interface, so
 * swapping paper trading for a real broker later means writing one new class,
 * not touching the widget.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop-limit' | 'trailing-stop';
export type OrderStatus = 'pending' | 'working' | 'filled' | 'cancelled' | 'rejected';
export type TimeInForce = 'GTC' | 'DAY';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  limitPrice?: number;      // required for limit / stop-limit
  stopPrice?: number;       // required for stop / stop-limit
  trailAmount?: number;     // absolute price distance, required for trailing-stop
  trailIsPercent?: boolean; // if true, trailAmount is a percent instead of absolute price
  timeInForce?: TimeInForce;
}

export interface Order extends OrderRequest {
  id: string;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
  avgFillPrice?: number;
  filledQty: number;
  commission?: number;
  slippage?: number;
  rejectReason?: string;
  // Trailing-stop bookkeeping — the best price seen since the order was placed.
  trailReference?: number;
}

export interface Position {
  symbol: string;
  qty: number;          // positive = long, negative = short
  avgPrice: number;
  realizedPnL: number;
  currency: string;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  commission: number;
  slippage: number;
  timestamp: number;
}

export interface AccountSnapshot {
  currency: string;
  cash: number;
  equity: number;
  realizedPnL: number;
  unrealizedPnL: number;
}

export interface IBroker {
  placeOrder(req: OrderRequest): Order;
  cancelOrder(orderId: string): boolean;
  getOrders(): Order[];
  getPositions(): Position[];
  getAccount(): AccountSnapshot;
  onFill(cb: (fill: Fill) => void): void;
  onOrderUpdate(cb: (order: Order) => void): void;
  /** Feed the latest price so working orders (limit/stop/trailing) can be evaluated. */
  tick(symbol: string, price: number, timestamp: number): void;
}
