import type { ExecOrder, ExecutionEngine, NewExecOrder } from './execution';
import { loadBrokerSettings, saveBrokerSettings } from './broker-store';

export interface ChartDomOptions {
  getSymbol: () => string;
  getPrice: () => number;
  onRequest: (o: NewExecOrder) => ExecOrder;
}

export interface ChartDom {
  setOneClick(on: boolean): void;
  openExecSheet(side: 'buy' | 'sell'): void;
  refresh(): void;
  destroy(): void;
}

function describe(o: ExecOrder): string {
  const s = `${o.side.toUpperCase()} ${o.qty} ${o.symbol} ${o.type.replace(/-/g, ' ')}`;
  if (o.triggerPrice != null) return `${s} @ ${o.triggerPrice.toFixed(2)}`;
  return s;
}

const EXEC_TYPES: { id: ExecOrder['type']; label: string }[] = [
  { id: 'market', label: 'Market' },
  { id: 'limit', label: 'Limit' },
  { id: 'stop', label: 'Stop' },
  { id: 'trailing-dist', label: 'Trailing $' },
  { id: 'chandelier', label: 'Chandelier' },
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'bracket', label: 'Bracket' },
];

export function createChartDom(container: HTMLElement, engine: ExecutionEngine, opts: ChartDomOptions): ChartDom {
  let settings = loadBrokerSettings();

  const root = document.createElement('div');
  root.id = 'chart-dom';

  // ── On-screen trading menu ─────────────────────────────────────
  const oneClickBtn = document.createElement('button');
  oneClickBtn.id = 'dom-oc';
  oneClickBtn.textContent = 'OST';
  oneClickBtn.title = 'On-screen trading menu';
  oneClickBtn.addEventListener('click', () => openExecSheet('buy'));

  // ── Buy / Sell zones ───────────────────────────────────────────
  const buy = document.createElement('div');
  buy.className = 'dom-zone buy';
  const sell = document.createElement('div');
  sell.className = 'dom-zone sell';

  const buyLabel = document.createElement('span');
  buyLabel.className = 'dom-label';
  buyLabel.textContent = 'BUY';
  const sellLabel = document.createElement('span');
  sellLabel.className = 'dom-label';
  sellLabel.textContent = 'SELL';
  buy.appendChild(buyLabel);
  sell.appendChild(sellLabel);

  const dragPrice = document.createElement('div');
  dragPrice.className = 'dom-drag-price';
  dragPrice.style.display = 'none';
  root.appendChild(dragPrice);

  const status = document.createElement('div');
  status.className = 'dom-status';
  status.textContent = '';
  const pnl = document.createElement('div');
  pnl.className = 'dom-pnl';
  pnl.textContent = '';

  function setStatus(msg: string): void {
    status.textContent = msg;
    setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 4000);
  }

  // ── Execution settings sheet ───────────────────────────────────
  function openExecSheet(side: 'buy' | 'sell'): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const panel = document.createElement('div');
    panel.className = 'modal';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = `${side === 'buy' ? 'BUY' : 'SELL'} — Execution Settings`;
    panel.appendChild(title);

    const typeSel = document.createElement('select');
    EXEC_TYPES.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      typeSel.appendChild(o);
    });
    typeSel.value = settings.mode === 'tradovate' ? 'market' : 'adaptive';

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.value = String(settings.risk.defaultQty);

    const stopInput = document.createElement('input');
    stopInput.type = 'number';
    stopInput.step = '0.01';
    stopInput.placeholder = 'Stop dist / $ risk';

    const atrInput = document.createElement('input');
    atrInput.type = 'number';
    atrInput.step = '0.1';
    atrInput.value = '2';
    atrInput.placeholder = 'ATR mult';

    const targetInput = document.createElement('input');
    targetInput.type = 'number';
    targetInput.step = '0.01';
    targetInput.placeholder = 'Target price';

    function fieldRow(label: string, el: HTMLInputElement | HTMLSelectElement): HTMLElement {
      const r = document.createElement('div');
      r.className = 'set-row';
      const l = document.createElement('label');
      l.textContent = label;
      r.appendChild(l);
      r.appendChild(el);
      return r;
    }

    panel.appendChild(fieldRow('Type', typeSel));
    panel.appendChild(fieldRow('Quantity', qtyInput));
    panel.appendChild(fieldRow('Stop ($ or pts)', stopInput));
    panel.appendChild(fieldRow('ATR mult', atrInput));
    panel.appendChild(fieldRow('Target', targetInput));

    const riskNote = document.createElement('div');
    riskNote.className = 'dom-risk-note';
    riskNote.textContent = `Suggested qty ${engine.status(opts.getSymbol()).suggestedQty} · regime ${engine.status(opts.getSymbol()).regime.toUpperCase()} · day P&L $${Math.round(engine.status(opts.getSymbol()).dayPnl)}`;
    panel.appendChild(riskNote);

    const buttons = document.createElement('div');
    buttons.className = 'modal-btns';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = 'CANCEL';
    const sendBtn = document.createElement('button');
    sendBtn.className = side === 'buy' ? 'btn-buy' : 'btn-sell';
    sendBtn.textContent = side === 'buy' ? 'SEND BUY' : 'SEND SELL';
    const exitAllBtn = document.createElement('button');
    exitAllBtn.className = 'btn-ghost';
    exitAllBtn.textContent = 'EXIT ALL';
    buttons.appendChild(cancelBtn);
    buttons.appendChild(exitAllBtn);
    buttons.appendChild(sendBtn);
    panel.appendChild(buttons);

    backdrop.appendChild(panel);
    container.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    cancelBtn.addEventListener('click', () => backdrop.remove());
    exitAllBtn.addEventListener('click', () => {
      engine.flattenAll();
      backdrop.remove();
      setStatus('All positions exited and working orders cancelled');
    });
    sendBtn.addEventListener('click', () => {
      backdrop.remove();
      const qty = Math.max(1, Math.round(parseFloat(qtyInput.value) || 1));
      const type = typeSel.value as ExecOrder['type'];
      const price = opts.getPrice();
      const order = opts.onRequest({
        symbol: opts.getSymbol(),
        side,
        qty,
        type,
        dist: stopInput.value ? parseFloat(stopInput.value) : undefined,
        atrMult: atrInput.value ? parseFloat(atrInput.value) : undefined,
        stopPrice: stopInput.value && type === 'bracket' ? parseFloat(stopInput.value) : undefined,
        targetPrice: targetInput.value ? parseFloat(targetInput.value) : undefined,
      });
      if (order.status === 'rejected') setStatus(`Rejected: ${order.rejectReason || 'risk check failed'}`);
      else if (order.status === 'filled') setStatus(`Filled ${describe(order)}`);
      else setStatus(`Working: ${describe(order)}`);
    });

    backdrop.querySelectorAll('input,select').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
    panel.addEventListener('click', (e) => e.stopPropagation());
  }

  // ── Drag-to-price on zones ─────────────────────────────────────
  let drag = { active: false, side: 'buy' as 'buy' | 'sell', startY: 0, startPrice: 0, dist: 0 };

  function zoneDown(side: 'buy' | 'sell', e: PointerEvent): void {
    const startPrice = opts.getPrice();
    if (startPrice <= 0) return;
    drag = { active: true, side, startY: e.clientY, startPrice, dist: 0 };
    dragPrice.style.display = 'block';
    dragPrice.classList.toggle('buy', side === 'buy');
    dragPrice.classList.toggle('sell', side === 'sell');
    e.preventDefault();
  }

  function zoneMove(e: PointerEvent): void {
    if (!drag.active) return;
    const zoneHeight = e.currentTarget as HTMLElement;
    const rect = zoneHeight.getBoundingClientRect();
    drag.dist = (e.clientY - drag.startY) / rect.height;
    const trigger = drag.startPrice + drag.dist * drag.startPrice * 0.5;
    dragPrice.textContent = trigger.toFixed(2);
  }

  function zoneUp(e: PointerEvent): void {
    if (!drag.active) return;
    const moved = drag.dist !== 0;
    drag.active = false;
    dragPrice.style.display = 'none';
    if (!moved) return;
    const price = opts.getPrice();
    const trigger = price + drag.dist * price * 0.5;
    const buySide = drag.side === 'buy';
    const type = buySide
      ? (trigger <= price ? 'limit' : 'stop')
      : (trigger >= price ? 'limit' : 'stop');
    const order = opts.onRequest({
      symbol: opts.getSymbol(),
      side: drag.side,
      qty: settings.risk.defaultQty,
      type,
      triggerPrice: trigger,
      dist: settings.risk.maxLossPerTrade / settings.risk.defaultQty,
    });
    if (order.status === 'rejected') setStatus(`Rejected: ${order.rejectReason || 'risk check failed'}`);
    else if (order.status === 'filled') setStatus(`Filled ${describe(order)}`);
    else setStatus(`Working: ${describe(order)}`);
  }

  buy.addEventListener('pointerdown', (e) => zoneDown('buy', e));
  sell.addEventListener('pointerdown', (e) => zoneDown('sell', e));
  buy.addEventListener('pointermove', zoneMove);
  sell.addEventListener('pointermove', zoneMove);
  buy.addEventListener('pointerup', zoneUp);
  sell.addEventListener('pointerup', zoneUp);
  buy.addEventListener('pointerleave', (e) => { if (drag.active && drag.side === 'buy') zoneUp(e); });
  sell.addEventListener('pointerleave', (e) => { if (drag.active && drag.side === 'sell') zoneUp(e); });

  buy.addEventListener('click', () => {
    if (drag.dist !== 0 || opts.getPrice() <= 0) return;
    const order = opts.onRequest({ symbol: opts.getSymbol(), side: 'buy', qty: settings.risk.defaultQty, type: 'market' });
    if (order.status === 'rejected') setStatus(`Rejected: ${order.rejectReason || 'risk check failed'}`);
    else if (order.status === 'filled') setStatus(`Filled ${describe(order)}`);
    else setStatus(`Working: ${describe(order)}`);
  });
  sell.addEventListener('click', () => {
    if (drag.dist !== 0 || opts.getPrice() <= 0) return;
    const order = opts.onRequest({ symbol: opts.getSymbol(), side: 'sell', qty: settings.risk.defaultQty, type: 'market' });
    if (order.status === 'rejected') setStatus(`Rejected: ${order.rejectReason || 'risk check failed'}`);
    else if (order.status === 'filled') setStatus(`Filled ${describe(order)}`);
    else setStatus(`Working: ${describe(order)}`);
  });

  buy.addEventListener('contextmenu', (e) => { e.preventDefault(); openExecSheet('buy'); });
  sell.addEventListener('contextmenu', (e) => { e.preventDefault(); openExecSheet('sell'); });
  buy.addEventListener('dblclick', () => openExecSheet('buy'));
  sell.addEventListener('dblclick', () => openExecSheet('sell'));

  // ── Layout ─────────────────────────────────────────────────────
  const rail = document.createElement('div');
  rail.id = 'dom-rail';
  rail.appendChild(oneClickBtn);
  rail.appendChild(buy);
  rail.appendChild(status);
  rail.appendChild(pnl);
  rail.appendChild(sell);
  root.appendChild(rail);
  container.appendChild(root);

  function refresh(): void {
    const st = engine.status(opts.getSymbol());
    pnl.textContent = `DAY ${st.dayPnl >= 0 ? '+' : ''}$${Math.round(st.dayPnl)} · ${st.regime.toUpperCase()}${st.halted ? ' · HALTED' : ''}`;
    pnl.classList.toggle('halted', st.halted);
  }

  return {
    setOneClick: (on: boolean) => {
      settings.oneClick = on;
      oneClickBtn.classList.toggle('on', on);
      saveBrokerSettings(settings);
    },
    openExecSheet,
    refresh,
    destroy: () => root.remove(),
  };
}

export function confirmExec(cb: (confirmed: boolean) => void, summary: string): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const panel = document.createElement('div');
  panel.className = 'modal';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Confirm Order';
  const body = document.createElement('div');
  body.className = 'modal-body';
  body.textContent = summary;
  const buttons = document.createElement('div');
  buttons.className = 'modal-btns';
  const no = document.createElement('button');
  no.className = 'btn-ghost';
  no.textContent = 'CANCEL';
  const yes = document.createElement('button');
  yes.className = 'btn-buy';
  yes.textContent = 'SEND';
  buttons.appendChild(no);
  buttons.appendChild(yes);
  panel.appendChild(title);
  panel.appendChild(body);
  panel.appendChild(buttons);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  const close = (v: boolean) => { backdrop.remove(); cb(v); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
  no.addEventListener('click', () => close(false));
  yes.addEventListener('click', () => close(true));
}