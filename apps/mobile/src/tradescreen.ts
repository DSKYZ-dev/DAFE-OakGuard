import type { OrderType, OrderRequest } from '../../web/src/trading/broker-port';
import { state, loadBroker, persistBroker, qtyUnit } from './state';

export interface TradeScreenCallbacks {
  onFill: () => void;
}

export interface TradeScreen {
  refresh: () => void;
  dispose: () => void;
}

export function createTradeScreen(container: HTMLDivElement, cb: TradeScreenCallbacks): TradeScreen {
  let disposed = false;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let activeSubTab: 'positions' | 'orders' | 'history' = 'positions';
  let innerRefresh: (() => void) | null = null;

  function lastPrice(): { bid: number; ask: number; close: number } {
    const b = state.bars;
    if (b.length === 0) return { bid: 0, ask: 0, close: 0 };
    const close = b[b.length - 1].close;
    const spread = Math.max(close * 0.0002, 0.01);
    return { bid: close - spread / 2, ask: close + spread / 2, close };
  }

  function build(): void {
    container.replaceChildren();
    const scroll = document.createElement('div');
    scroll.className = 'scrollable';

    // ── Big buy/sell ──────────────────────────────────────────────
    const big = document.createElement('div');
    big.className = 'trade-big-btns';
    const sellBtn = document.createElement('button');
    sellBtn.className = 'trade-big sell';
    const sellPrice = document.createElement('span');
    sellPrice.className = 't-price';
    const sellLabel = document.createElement('span');
    sellLabel.className = 't-label';
    sellLabel.textContent = 'SELL';
    sellBtn.appendChild(sellPrice);
    sellBtn.appendChild(sellLabel);
    const buyBtn = document.createElement('button');
    buyBtn.className = 'trade-big buy';
    const buyPrice = document.createElement('span');
    buyPrice.className = 't-price';
    const buyLabel = document.createElement('span');
    buyLabel.className = 't-label';
    buyLabel.textContent = 'BUY';
    buyBtn.appendChild(buyPrice);
    buyBtn.appendChild(buyLabel);
    big.appendChild(sellBtn);
    big.appendChild(buyBtn);
    scroll.appendChild(big);

    // ── Quantity ──────────────────────────────────────────────────
    const qtyCard = document.createElement('div');
    qtyCard.className = 'trade-card';
    const qtyTitle = document.createElement('div');
    qtyTitle.className = 'trade-card-title';
    qtyTitle.textContent = 'Quantity';
    const qtyLine = document.createElement('div');
    qtyLine.className = 'qty-line';
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.value = '1';
    const unitSpan = document.createElement('span');
    unitSpan.className = 'unit';
    qtyLine.appendChild(qtyInput);
    qtyLine.appendChild(unitSpan);
    qtyCard.appendChild(qtyTitle);
    qtyCard.appendChild(qtyLine);
    scroll.appendChild(qtyCard);

    // ── Order type ────────────────────────────────────────────────
    const orderCard = document.createElement('div');
    orderCard.className = 'trade-card';
    const orderTitle = document.createElement('div');
    orderTitle.className = 'trade-card-title';
    orderTitle.textContent = 'Order';
    const typeRow = document.createElement('div');
    typeRow.className = 'trade-row';
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type';
    const typeSel = document.createElement('select');
    (['market', 'limit', 'stop', 'stop-limit', 'trailing-stop'] as OrderType[]).forEach((t) => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t.replace('-', ' ').replace(/(^|\s)(\w)/g, (m) => m.toUpperCase());
      typeSel.appendChild(o);
    });
    typeRow.appendChild(typeLabel);
    typeRow.appendChild(typeSel);

    const limitRow = document.createElement('div');
    limitRow.className = 'trade-row';
    limitRow.style.display = 'none';
    const limitLabel = document.createElement('label');
    limitLabel.textContent = 'Limit';
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.step = '0.01';
    limitInput.placeholder = 'Limit price';
    limitRow.appendChild(limitLabel);
    limitRow.appendChild(limitInput);

    const stopRow = document.createElement('div');
    stopRow.className = 'trade-row';
    stopRow.style.display = 'none';
    const stopLabel = document.createElement('label');
    stopLabel.textContent = 'Stop';
    const stopInput = document.createElement('input');
    stopInput.type = 'number';
    stopInput.step = '0.01';
    stopInput.placeholder = 'Stop price';
    stopRow.appendChild(stopLabel);
    stopRow.appendChild(stopInput);

    const trailRow = document.createElement('div');
    trailRow.className = 'trade-row';
    trailRow.style.display = 'none';
    const trailLabel = document.createElement('label');
    trailLabel.textContent = 'Trail';
    const trailInput = document.createElement('input');
    trailInput.type = 'number';
    trailInput.step = '0.01';
    trailInput.placeholder = 'Amount';
    const trailUnit = document.createElement('select');
    const optAbs = document.createElement('option');
    optAbs.value = 'abs';
    optAbs.textContent = '$';
    const optPct = document.createElement('option');
    optPct.value = 'pct';
    optPct.textContent = '%';
    trailUnit.appendChild(optAbs);
    trailUnit.appendChild(optPct);
    trailRow.appendChild(trailLabel);
    trailRow.appendChild(trailInput);
    trailRow.appendChild(trailUnit);

    orderCard.appendChild(orderTitle);
    orderCard.appendChild(typeRow);
    orderCard.appendChild(limitRow);
    orderCard.appendChild(stopRow);
    orderCard.appendChild(trailRow);
    scroll.appendChild(orderCard);

    // ── Account ───────────────────────────────────────────────────
    const acctCard = document.createElement('div');
    acctCard.className = 'trade-card';
    const acctTitle = document.createElement('div');
    acctTitle.className = 'trade-card-title';
    acctTitle.textContent = 'Account';
    acctCard.appendChild(acctTitle);
    const accLines: HTMLElement[] = [];
    ['Cash', 'Equity', 'Realized P&L', 'Unrealized P&L'].forEach((label) => {
      const row = document.createElement('div');
      row.className = 'account-line';
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'val';
      row.appendChild(l);
      row.appendChild(v);
      accLines.push(row);
      acctCard.appendChild(row);
    });
    scroll.appendChild(acctCard);

    // ── Tab bar: Positions / Open Orders / History ──────────────────
    const tabBar = document.createElement('div');
    tabBar.className = 'trade-tabbar';
    tabBar.style.display = 'flex'; tabBar.style.gap = '6px'; tabBar.style.margin = '8px 0';
    const tabBtn = (id: typeof activeSubTab, label: string) => {
      const b = document.createElement('button');
      b.textContent = label; b.className = 'trade-tab'; b.dataset.tab = id;
      if (id === activeSubTab) b.classList.add('active');
      b.addEventListener('click', () => { activeSubTab = id; syncTabs(); refresh(); });
      return b;
    };
    const btnPos = tabBtn('positions', 'Positions');
    const btnOrd = tabBtn('orders', 'Open Orders');
    const btnHist = tabBtn('history', 'History');
    tabBar.appendChild(btnPos); tabBar.appendChild(btnOrd); tabBar.appendChild(btnHist);
    scroll.appendChild(tabBar);

    const posCard = document.createElement('div');
    posCard.className = 'trade-card'; posCard.dataset.panel = 'positions';
    const posList = document.createElement('div');
    const posTitle = document.createElement('div'); posTitle.className = 'trade-card-title'; posTitle.textContent = 'Positions';
    posCard.appendChild(posTitle); posCard.appendChild(posList);

    const ordCard = document.createElement('div');
    ordCard.className = 'trade-card'; ordCard.dataset.panel = 'orders';
    const ordList = document.createElement('div');
    const ordTitle = document.createElement('div'); ordTitle.className = 'trade-card-title'; ordTitle.textContent = 'Open Orders';
    ordCard.appendChild(ordTitle); ordCard.appendChild(ordList);

    const histCard = document.createElement('div');
    histCard.className = 'trade-card'; histCard.dataset.panel = 'history';
    const histTitle = document.createElement('div'); histTitle.className = 'trade-card-title'; histTitle.textContent = 'Trade History';
    const histList = document.createElement('div');
    histCard.appendChild(histTitle); histCard.appendChild(histList);

    scroll.appendChild(posCard); scroll.appendChild(ordCard); scroll.appendChild(histCard);

    function syncTabs(): void {
      for (const b of [btnPos, btnOrd, btnHist]) b.classList.toggle('active', b.dataset.tab === activeSubTab);
      posCard.style.display = activeSubTab === 'positions' ? '' : 'none';
      ordCard.style.display = activeSubTab === 'orders' ? '' : 'none';
      histCard.style.display = activeSubTab === 'history' ? '' : 'none';
    }
    syncTabs();

    const fillNote = document.createElement('div');
    fillNote.className = 'fill-note';
    scroll.appendChild(fillNote);

    container.appendChild(scroll);

    // ── Logic ─────────────────────────────────────────────────────
    function updateRows(): void {
      const show = (sel: HTMLSelectElement, row: HTMLDivElement, need: 'limit' | 'stop' | 'trail') => {
        const v = sel.value;
        row.style.display = (v === 'limit' || v === 'stop-limit' || v === 'trailing-stop') && need === 'limit' ? 'flex'
          : (v === 'stop' || v === 'stop-limit') && need === 'stop' ? 'flex'
          : v === 'trailing-stop' && need === 'trail' ? 'flex'
          : 'none';
      };
      show(typeSel, limitRow, 'limit');
      show(typeSel, stopRow, 'stop');
      show(typeSel, trailRow, 'trail');
    }
    typeSel.addEventListener('change', updateRows);

    function refresh(): void {
      if (disposed) return;
      const p = lastPrice();
      sellPrice.textContent = p.bid > 0 ? p.bid.toFixed(2) : '--';
      buyPrice.textContent = p.ask > 0 ? p.ask.toFixed(2) : '--';
      unitSpan.textContent = qtyUnit(state.symbol);

      const broker = loadBroker();
      broker.tick(state.symbol, p.close, state.bars.length ? state.bars[state.bars.length - 1].timestamp : Date.now());
      const acc = broker.getAccount();
      const fmt = (n: number, dec = 2) => n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
      // Compute fees total from fills to show net PnL (user reported fees not deducted from displayed PnL)
      const fillsAll: any[] = (broker as any).getFills ? (broker as any).getFills() : [];
      const totalFees = fillsAll.reduce((a:any,f:any)=>a+(f.commission||0)+(f.slippage||0),0);
      const netRealized = acc.realizedPnL - totalFees;
      // Also include fee estimate for open position close: use commission per-trade flat * 1
      const estCloseFee = broker.getPositions().length>0 ? 1 : 0;
      const netUnrealized = acc.unrealizedPnL - estCloseFee;
      const vals = accLines;
      vals[0].textContent = fmt(acc.cash);
      vals[1].textContent = fmt(acc.equity);
      vals[2].textContent = (netRealized >= 0 ? '+' : '') + fmt(netRealized);
      vals[2].className = 'val ' + (netRealized >= 0 ? 'pos' : 'neg');
      vals[2].parentElement!.title = `Gross ${fmt(acc.realizedPnL)} · Fees $${fmt(totalFees)}`;
      vals[3].textContent = (netUnrealized >= 0 ? '+' : '') + fmt(netUnrealized);
      vals[3].className = 'val ' + (netUnrealized >= 0 ? 'pos' : 'neg');

      const positions = broker.getPositions();
      posList.replaceChildren();
      if (positions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = 'No open positions';
        posList.appendChild(empty);
      } else {
        for (const p of positions) {
          const row = document.createElement('div');
          row.className = 'pos-row';
          const info = document.createElement('div');
          info.style.display = 'flex';
          info.style.flexDirection = 'column';
          const sym = document.createElement('span');
          sym.className = 'pos-sym';
          sym.textContent = `${p.symbol} ${p.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)}`;
          const sub = document.createElement('span');
          sub.textContent = `@ ${p.avgPrice.toFixed(2)}`;
          info.appendChild(sym);
          info.appendChild(sub);
          const current = lastPrice().close;
          const upnl = (current - p.avgPrice) * p.qty;
          const pnl = document.createElement('span');
          pnl.className = 'pos-pnl ' + (upnl >= 0 ? 'pos' : 'neg');
          pnl.textContent = (upnl >= 0 ? '+' : '') + upnl.toFixed(2);
          const closeBtn = document.createElement('button');
          closeBtn.className = 'pos-close';
          closeBtn.textContent = 'Close';
          closeBtn.addEventListener('click', () => {
            const side = p.qty > 0 ? 'sell' : 'buy';
            broker.placeOrder({ symbol: p.symbol, side, type: 'market', qty: Math.abs(p.qty) });
            fillNote.textContent = `Closed ${p.symbol} ${side} ${Math.abs(p.qty)} @ market`;
            navigator.vibrate?.(20);
            persistBroker();
            cb.onFill();
            refresh();
          });
          row.appendChild(info);
          row.appendChild(pnl);
          row.appendChild(closeBtn);
          posList.appendChild(row);
        }
      }

      const orders = broker.getOrders().filter((o) => o.status === 'working');
      ordList.replaceChildren();
      if (orders.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = 'No open orders';
        ordList.appendChild(empty);
      } else {
        for (const o of orders) {
          const row = document.createElement('div');
          row.className = 'pos-row';
          const info = document.createElement('div');
          const sym = document.createElement('span');
          sym.className = 'pos-sym';
          sym.textContent = `${o.side.toUpperCase()} ${o.qty} ${o.symbol} ${o.type}`;
          const sub = document.createElement('span');
          sub.textContent = o.limitPrice ? `limit ${o.limitPrice}` : o.stopPrice ? `stop ${o.stopPrice}` : '';
          info.appendChild(sym);
          info.appendChild(sub);
          const cancel = document.createElement('button');
          cancel.className = 'pos-close';
          cancel.textContent = 'Cancel';
          cancel.addEventListener('click', () => {
            broker.cancelOrder(o.id);
            fillNote.textContent = `Cancelled order ${o.id}`;
            persistBroker();
            refresh();
          });
          row.appendChild(info);
          row.appendChild(cancel);
          ordList.appendChild(row);
        }
      }

      // ── History ───────────────────────────────────────────────────
      const fills = (broker as any).getFills ? (broker as any).getFills() : [];
      histList.replaceChildren();
      if (!fills || fills.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = 'No trade history yet';
        histList.appendChild(empty);
      } else {
        for (const f of [...fills].reverse().slice(0, 100)) {
          const row = document.createElement('div');
          row.className = 'pos-row';
          const info = document.createElement('div');
          info.style.display = 'flex'; info.style.flexDirection = 'column';
          const sym = document.createElement('span'); sym.className = 'pos-sym';
          sym.textContent = `${f.side.toUpperCase()} ${f.qty} ${f.symbol} @ ${f.price.toFixed(2)}`;
          const sub = document.createElement('span');
          sub.style.fontSize = '9px'; sub.style.opacity = '0.5';
          sub.textContent = new Date(f.timestamp).toLocaleString() + (f.commission ? `  fee $${f.commission.toFixed(2)}` : '');
          info.appendChild(sym); info.appendChild(sub);
          row.appendChild(info);
          histList.appendChild(row);
        }
      }
    }

    function place(side: 'buy' | 'sell'): void {
      const broker = loadBroker();
      const qty = Math.max(1, Math.round(parseFloat(qtyInput.value) || 1));
      const type = typeSel.value as OrderType;
      const p = lastPrice();
      const order: OrderRequest = {
        symbol: state.symbol,
        side,
        type,
        qty,
        limitPrice: limitInput.value ? parseFloat(limitInput.value) : undefined,
        stopPrice: stopInput.value ? parseFloat(stopInput.value) : undefined,
        trailAmount: trailInput.value ? parseFloat(trailInput.value) : undefined,
        trailIsPercent: trailUnit.value === 'pct',
      };
      const res = broker.placeOrder(order);
      navigator.vibrate?.(25);
      if (res.status === 'filled') {
        fillNote.textContent = `${side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${qtyUnit(state.symbol)} of ${state.symbol} @ ${(res.avgFillPrice ?? res.fillPrice ?? p.close).toFixed(2)}`;
      } else if (res.status === 'rejected') {
        fillNote.textContent = `Order rejected: ${res.rejectReason || 'unknown'}`;
      } else {
        fillNote.textContent = `${order.type} order ${res.id} working — fills when price touches it`;
      }
      persistBroker();
      cb.onFill();
      refresh();
    }

    buyBtn.addEventListener('click', () => place('buy'));
    sellBtn.addEventListener('click', () => place('sell'));

    innerRefresh = refresh;
    refresh();
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (disposed || document.hidden) return;
      const p = lastPrice();
      if (state.bars.length) loadBroker().tick(state.symbol, p.close, state.bars[state.bars.length - 1].timestamp);
      if (innerRefresh) innerRefresh();
    }, 900);
  }

  build();

  return {
    refresh: () => {
      const p = lastPrice();
      if (state.bars.length) loadBroker().tick(state.symbol, p.close, state.bars[state.bars.length - 1].timestamp);
      if (innerRefresh) innerRefresh(); else build();
    },
    dispose: () => { disposed = true; if (liveTimer) clearInterval(liveTimer); container.replaceChildren(); },
  };
}