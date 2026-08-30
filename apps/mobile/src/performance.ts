import type { ExecutionEngine, TradeRecord } from './execution';
import { SLIPPAGE_STORE, currentCostModel, costSourceLabel } from './cost-engine';
import { state, persistSettings } from './state';
import { submitReport } from './reports';

export interface PerformanceScreen {
  dispose: () => void;
}

interface Summary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  feesTotal: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  avgR: number;
  bestR: number;
  worstR: number;
  avgDurationMin: number;
}

function summarize(records: TradeRecord[], pv: (s: string) => number): Summary {
  const s: Summary = {
    trades: records.length,
    wins: 0,
    losses: 0,
    winRate: 0,
    netPnl: 0,
    feesTotal: 0,
    profitFactor: 0,
    expectancy: 0,
    avgWin: 0,
    avgLoss: 0,
    maxDrawdown: 0,
    avgR: 0,
    bestR: -Infinity,
    worstR: Infinity,
    avgDurationMin: 0,
  };
  if (records.length === 0) { s.bestR = 0; s.worstR = 0; return s; }
  let grossWin = 0;
  let grossLoss = 0;
  let peak = 0;
  let dd = 0;
  let equity = 0;
  const rList: number[] = [];
  for (const t of records) {
    const pnl = t.pnl - (t.fees.commission + t.fees.exchange + t.fees.nfa + t.fees.clearing + t.fees.brokerage + t.fees.routing + t.fees.ip);
    s.netPnl += pnl;
    s.feesTotal += t.fees.commission + t.fees.exchange + t.fees.nfa + t.fees.clearing + t.fees.brokerage + t.fees.routing + t.fees.ip;
    if (pnl >= 0) { s.wins++; grossWin += pnl; } else { s.losses++; grossLoss += Math.abs(pnl); }
    equity += pnl;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
    s.avgDurationMin += t.durationMs / 60000;
    if (Number.isFinite(t.rMultiple)) rList.push(t.rMultiple);
  }
  s.maxDrawdown = dd;
  s.winRate = (s.wins / s.trades) * 100;
  s.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  s.expectancy = s.netPnl / s.trades;
  s.avgWin = s.wins ? grossWin / s.wins : 0;
  s.avgLoss = s.losses ? grossLoss / s.losses : 0;
  s.avgR = rList.length ? rList.reduce((a, b) => a + b, 0) / rList.length : 0;
  s.bestR = rList.length ? Math.max(...rList) : 0;
  s.worstR = rList.length ? Math.min(...rList) : 0;
  s.avgDurationMin = s.avgDurationMin / s.trades;
  return s;
}

function equitySeries(records: TradeRecord[]): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  let eq = 0;
  for (const t of records) {
    eq += t.pnl - (t.fees.commission + t.fees.exchange + t.fees.nfa + t.fees.clearing + t.fees.brokerage + t.fees.routing + t.fees.ip);
    x.push(t.exitTime);
    y.push(eq);
  }
  return { x, y };
}

function svgLine(x: number[], y: number[], w: number, h: number, stroke: string): string {
  if (x.length < 2) return '';
  const minX = Math.min(...x);
  const maxX = Math.max(...x);
  const minY = Math.min(...y, 0);
  const maxY = Math.max(...y, 0);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const pts = x.map((xi, i) => {
    const px = 8 + ((xi - minX) / spanX) * (w - 16);
    const py = h - 8 - ((y[i] - minY) / spanY) * (h - 16);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#0c0c1e;border-radius:10px">
<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2"/>
<line x1="8" y1="${h - 8}" x2="${w - 8}" y2="${h - 8}" stroke="#1c1c3a"/>
</svg>`;
}

function fmt(n: number, d = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function advisorReview(recs: TradeRecord[], s: Summary): { severity: 'info' | 'warn' | 'danger'; text: string }[] {
  const out: { severity: 'info' | 'warn' | 'danger'; text: string }[] = [];
  if (recs.length === 0) return [{ severity: 'info', text: 'No trades yet — open the chart, enable the DOM panel and start paper trading.' }];
  if (s.winRate < 40) out.push({ severity: 'warn', text: `Win rate ${s.winRate.toFixed(0)}% is below 40% — review your entry criteria; consider waiting for higher-conviction setups.` });
  else if (s.winRate > 60) out.push({ severity: 'info', text: `Strong win rate (${s.winRate.toFixed(0)}%) — guard it with a tighter stop policy to avoid giving back profits.` });
  if (s.avgLoss > s.avgWin) out.push({ severity: 'danger', text: `Average loss ($${fmt(s.avgLoss)}) exceeds average win ($${fmt(s.avgWin)}) — you're fighting negative asymmetry. Let winners run or cut losers faster.` });
  else out.push({ severity: 'info', text: `Risk/reward is positive (avg win $${fmt(s.avgWin)} vs avg loss $${fmt(s.avgLoss)}) — protect it.` });
  if (s.maxDrawdown > 0 && s.maxDrawdown > s.trades * Math.max(s.avgWin, s.avgLoss) * 0.5) out.push({ severity: 'warn', text: `Max drawdown $${fmt(s.maxDrawdown)} is large relative to average trade — reduce position size or add a session drawdown cap.` });
  if (s.feesTotal > 0 && s.netPnl !== 0 && Math.abs(s.feesTotal / s.netPnl) > 0.2) out.push({ severity: 'warn', text: `Fees ($${fmt(s.feesTotal)}) consume over 20% of your net result — consider fewer, larger trades or cheaper execution.` });
  const bySym = new Map<string, { n: number; pnl: number }>();
  for (const t of recs) {
    const e = bySym.get(t.symbol) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += t.pnl;
    bySym.set(t.symbol, e);
  }
  const bestSym = [...bySym.entries()].sort((a, b) => b[1].pnl - a[1].pnl)[0];
  if (bestSym && bestSym[1].n >= 3) out.push({ severity: 'info', text: `Your best market is ${bestSym[0]} ($${fmt(bestSym[1].pnl)} across ${bestSym[1].n} trades) — consider concentrating where you're profitable.` });
  const session = new Map<string, { n: number; pnl: number }>();
  for (const t of recs) {
    const e = session.get(t.session) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += t.pnl;
    session.set(t.session, e);
  }
  const worst = [...session.entries()].sort((a, b) => a[1].pnl - b[1].pnl)[0];
  if (worst && worst[1].n >= 3 && worst[1].pnl < 0) out.push({ severity: 'warn', text: `${worst[0].toUpperCase()} session is your weakest ($${fmt(worst[1].pnl)} over ${worst[1].n} trades) — consider not trading that window.` });
  return out;
}

function exportReport(recs: TradeRecord[], s: Summary, engine: ExecutionEngine, share = false): void {
  const eq = equitySeries(recs);
  const fees = currentCostModel().fees(state.symbol, 1);
  const rows = recs.slice(-40).reverse().map((t) => {
    const f = t.fees;
    return `<tr><td>${new Date(t.exitTime).toLocaleString()}</td><td>${t.symbol}</td><td>${t.side.toUpperCase()}</td>
<td>${t.qty}</td><td>${fmt(t.entryPrice)}</td><td>${fmt(t.exitPrice)}</td><td>${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}</td>
<td>${fmt(t.rMultiple, 2)}R</td><td>${fmt(t.mae)}</td><td>${fmt(t.mfe)}</td><td>${(t.durationMs / 60000).toFixed(0)}m</td>
<td>$${fmt(f.commission + f.exchange + f.nfa + f.clearing + f.brokerage + f.routing + f.ip)}</td><td>${t.session}</td></tr>`;
  }).join('');
  const advice = advisorReview(recs, s).map((a) => `<li style="color:${a.severity === 'danger' ? '#ff4477' : a.severity === 'warn' ? '#ffb800' : '#9fe8ff'}">${a.text}</li>`).join('');
  const slipStats = SLIPPAGE_STORE.forSymbol(state.symbol);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DAFE Charts Performance Report</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#05050f;color:#e8e8ff;padding:24px}
h1{color:#b48cff}h2{margin-top:28px;color:#00ff88}table{border-collapse:collapse;width:100%;font-size:11px;margin-top:10px}
th,td{border:1px solid #1c1c3a;padding:6px 8px;text-align:left}th{color:#9a9ab8;text-transform:uppercase;font-size:9px}
.stat{display:inline-block;background:#0c0c1e;border:1px solid #1c1c3a;border-radius:10px;padding:10px 14px;margin:6px;font-size:12px}
.stat b{display:block;font-size:18px;color:#00ff88}.muted{color:#9a9ab8;font-size:11px}</style></head><body>
<h1>DAFE Charts — Performance Report</h1>
<div class="muted">Generated ${new Date().toLocaleString()} · Cost model: ${costSourceLabel()} · Fee source: ${fees.source}</div>
<h2>Summary</h2>
<div class="stat">Trades<b>${s.trades}</b></div>
<div class="stat">Win rate<b>${s.winRate.toFixed(1)}%</b></div>
<div class="stat">Net P&L<b>$${fmt(s.netPnl)}</b></div>
<div class="stat">Profit factor<b>${s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor)}</b></div>
<div class="stat">Expectancy<b>$${fmt(s.expectancy)}</b></div>
<div class="stat">Max DD<b>$${fmt(s.maxDrawdown)}</b></div>
<div class="stat">Avg R<b>${fmt(s.avgR, 2)}</b></div>
<div class="stat">Avg win<b>$${fmt(s.avgWin)}</b></div>
<div class="stat">Avg loss<b>$${fmt(s.avgLoss)}</b></div>
<div class="stat">Fees paid<b>$${fmt(s.feesTotal)}</b></div>
<h2>Equity curve</h2>${svgLine(eq.x, eq.y, 900, 240, '#00ff88')}
<h2>Advisor review</h2><ul>${advice}</ul>
<h2>Trade diagnostics (last 40)</h2>
<table><tr><th>Exit time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th><th>MAE</th><th>MFE</th><th>Duration</th><th>Fees</th><th>Session</th></tr>${rows}</table>
<h2>Slippage (${state.symbol})</h2>
<div class="muted">Median ${fmt(slipStats.median, 3)} · Mean ${fmt(slipStats.mean, 3)} · 90th ${fmt(slipStats.p90, 3)} · 95th ${fmt(slipStats.p95, 3)} · ${slipStats.count} observations</div>
<div class="muted">Slippage is measured from your own fills — expected signal price vs actual simulated fill.</div>
<p style="margin-top:30px;font-size:10px;color:#9a9ab8">Trading involves substantial risk. DAFE Charts is not investment advice.</p>
</body></html>`;
  const text = [
    `DAFE Charts — Performance Report (${new Date().toLocaleString()})`,
    `Trades ${s.trades} · Win rate ${s.winRate.toFixed(1)}% · Net P&L $${fmt(s.netPnl)}`,
    `PF ${s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor)} · Expectancy $${fmt(s.expectancy)} · Max DD $${fmt(s.maxDrawdown)} · Fees $${fmt(s.feesTotal)}`,
    '',
    'Advisor review:',
    advisorReview(recs, s).map((a) => '• ' + a.text).join('\n'),
  ].join('\n');
  if (share) {
    submitReport({
      subject: 'DAFE Charts Performance Report',
      filename: `dafe-performance-${new Date().toISOString().slice(0, 10)}.html`,
      html,
      text,
    });
    return;
  }
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dafe-performance-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function createPerformanceScreen(container: HTMLDivElement, engine: ExecutionEngine): PerformanceScreen {
  const scroll = document.createElement('div');
  scroll.className = 'scrollable';
  const header = document.createElement('div');
  header.className = 'perf-header';
  const title = document.createElement('div');
  title.className = 'perf-title';
  title.textContent = 'Performance';
  const sub = document.createElement('div');
  sub.className = 'perf-sub';
  sub.textContent = `Cost model: ${costSourceLabel()} · feed: ${state.dataProvider}`;
  header.appendChild(title);
  header.appendChild(sub);
  scroll.appendChild(header);

  const statsRow = document.createElement('div');
  statsRow.className = 'perf-stats';
  scroll.appendChild(statsRow);

  const chartBox = document.createElement('div');
  chartBox.className = 'perf-chart';
  const chartTitle = document.createElement('div');
  chartTitle.className = 'perf-chart-title';
  chartTitle.textContent = 'Equity curve (2D)';
  const canvas = document.createElement('canvas');
  chartBox.appendChild(chartTitle);
  chartBox.appendChild(canvas);
  scroll.appendChild(chartBox);

  const adviceBox = document.createElement('div');
  adviceBox.className = 'perf-advice';
  const adviceActions = document.createElement('div');
  adviceActions.style.display = 'flex'; adviceActions.style.gap = '8px'; adviceActions.style.margin = '8px 0';
  const advisorRecBtn = document.createElement('button');
  advisorRecBtn.className = 'editor-run'; advisorRecBtn.textContent = 'Advisor Recommendations';
  const clearRecBtn = document.createElement('button');
  clearRecBtn.className = 'editor-clear'; clearRecBtn.textContent = 'Clear Recommendations';
  adviceActions.appendChild(advisorRecBtn); adviceActions.appendChild(clearRecBtn);
  const recPersistKey = 'dafe_mobile_perf_recs';
  const recBox = document.createElement('div');
  recBox.className = 'perf-recs';
  // restore persisted recs
  try {
    const saved = JSON.parse(localStorage.getItem(recPersistKey) || '[]');
    for (const r of saved) {
      const row = document.createElement('div'); row.className = 'advice-row info';
      row.textContent = r; recBox.appendChild(row);
    }
  } catch {}
  scroll.appendChild(adviceBox);
  scroll.appendChild(adviceActions);
  scroll.appendChild(recBox);

  async function callAdvisorLLM(prompt: string): Promise<string> {
    try {
      const cfg = JSON.parse(localStorage.getItem('dafe_mobile_llm') || '{}');
      const { llmChat } = await import('./native-http');
      const r = await llmChat(cfg, 'You are the DAFE Trade Advisor — concise, specific, actionable.', prompt, { maxTokens: 2048, temperature: 0.7 });
      if (!r.ok) throw new Error(r.error || 'LLM request failed');
      return r.text;
    } catch (e: any) { return `LLM error: ${e?.message || e}`; }
  }
  advisorRecBtn.addEventListener('click', async () => {
    const recs = engine.getTrades();
    const s = summarize(recs, () => 1);
    const prompt = `You are the DAFE Trade Advisor. Analyze this performance: Trades ${s.trades}, Win rate ${s.winRate.toFixed(1)}%, Net P&L $${fmt(s.netPnl)}, PF ${s.profitFactor}, Expectancy $${fmt(s.expectancy)}, MaxDD $${fmt(s.maxDrawdown)}, AvgR ${fmt(s.avgR,2)}, Fees $${fmt(s.feesTotal)}. Symbol ${state.symbol}. Give 3-5 concise actionable recommendations to improve. Be the best advisor on the planet.`;
    advisorRecBtn.textContent = 'Thinking...'; (advisorRecBtn as HTMLButtonElement).disabled = true;
    const ans = await callAdvisorLLM(prompt);
    const row = document.createElement('div'); row.className = 'advice-row info';
    row.textContent = `[${new Date().toLocaleString()}] ${ans}`;
    recBox.appendChild(row);
    try {
      const cur = JSON.parse(localStorage.getItem(recPersistKey) || '[]');
      cur.push(row.textContent); localStorage.setItem(recPersistKey, JSON.stringify(cur.slice(-50)));
    } catch {}
    advisorRecBtn.textContent = 'Advisor Recommendations'; (advisorRecBtn as HTMLButtonElement).disabled = false;
  });
  clearRecBtn.addEventListener('click', () => {
    recBox.replaceChildren(); try { localStorage.removeItem(recPersistKey); } catch {}
  });

  const slipBox = document.createElement('div');
  slipBox.className = 'perf-slip';
  scroll.appendChild(slipBox);

  const tradesBox = document.createElement('div');
  tradesBox.className = 'perf-trades';
  scroll.appendChild(tradesBox);

  const actions = document.createElement('div');
  actions.className = 'perf-actions';
  const exportBtn = document.createElement('button');
  exportBtn.className = 'editor-run';
  exportBtn.textContent = 'EXPORT REPORT (EMAIL-READY HTML)';
  const emailBtn = document.createElement('button');
  emailBtn.className = 'editor-clear';
  emailBtn.textContent = 'EMAIL RESULTS';
  actions.appendChild(exportBtn);
  actions.appendChild(emailBtn);
  scroll.appendChild(actions);

  container.appendChild(scroll);

  let disposed = false;

  function drawEquity(recs: TradeRecord[]): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = chartBox.clientWidth;
    const h = 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0c0c1e';
    ctx.fillRect(0, 0, w, h);
    const eq = equitySeries(recs);
    if (eq.x.length < 2) {
      ctx.fillStyle = '#9a9ab8';
      ctx.font = '12px sans-serif';
      ctx.fillText('No closed trades yet — trade from the chart DOM panel.', 16, h / 2);
      return;
    }
    const minY = Math.min(...eq.y, 0);
    const maxY = Math.max(...eq.y, 0);
    const spanY = Math.max(maxY - minY, 1);
    const pts = eq.y.map((y, i) => {
      const px = 6 + (i / (eq.y.length - 1)) * (w - 12);
      const py = h - 10 - ((y - minY) / spanY) * (h - 20);
      return [px, py] as const;
    });
    ctx.beginPath();
    pts.forEach(([px, py], i) => i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py));
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#9a9ab8';
    ctx.font = '10px sans-serif';
    ctx.fillText(`$${fmt(maxY)}`, 6, 12);
    ctx.fillText(`$${fmt(minY)}`, 6, h - 4);
  }

  function build(): void {
    if (disposed) return;
    const recs = engine.getTrades();
    const s = summarize(recs, () => 1);

    statsRow.replaceChildren();
    const stat = (label: string, value: string, color = '') => {
      const d = document.createElement('div');
      d.className = 'stat';
      const l = document.createElement('span');
      l.className = 'stat-label';
      l.textContent = label;
      const v = document.createElement('b');
      v.textContent = value;
      v.style.color = color;
      d.appendChild(l);
      d.appendChild(v);
      statsRow.appendChild(d);
    };
    stat('Trades', String(s.trades));
    stat('Win rate', s.winRate.toFixed(1) + '%', s.winRate >= 50 ? 'var(--green)' : 'var(--red)');
    stat('Net P&L', '$' + fmt(s.netPnl), s.netPnl >= 0 ? 'var(--green)' : 'var(--red)');
    stat('Profit factor', s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor));
    stat('Expectancy', '$' + fmt(s.expectancy));
    stat('Max DD', '$' + fmt(s.maxDrawdown), 'var(--red)');
    stat('Avg R', fmt(s.avgR, 2) + 'R');
    stat('Fees', '$' + fmt(s.feesTotal));

    drawEquity(recs);

    adviceBox.replaceChildren();
    const adviceTitle = document.createElement('div');
    adviceTitle.className = 'perf-chart-title';
    adviceTitle.textContent = 'Advisor review';
    adviceBox.appendChild(adviceTitle);
    for (const a of advisorReview(recs, s)) {
      const row = document.createElement('div');
      row.className = 'advice-row ' + a.severity;
      row.textContent = a.text;
      adviceBox.appendChild(row);
    }

    slipBox.replaceChildren();
    const slipTitle = document.createElement('div');
    slipTitle.className = 'perf-chart-title';
    slipTitle.textContent = `Slippage analytics — ${state.symbol}`;
    slipBox.appendChild(slipTitle);
    const slipStats = SLIPPAGE_STORE.forSymbol(state.symbol);
    const line = document.createElement('div');
    line.className = 'advice-row info';
    line.textContent = slipStats.count
      ? `Measured from your fills: median ${fmt(slipStats.median, 3)} pts · mean ${fmt(slipStats.mean, 3)} · 90th ${fmt(slipStats.p90, 3)} · 95th ${fmt(slipStats.p95, 3)} (${slipStats.count} observations)`
      : 'No observations yet — slippage is measured live from each of your fills.';
    slipBox.appendChild(line);
    for (const [k, v] of Object.entries(SLIPPAGE_STORE.byOrderType(state.symbol))) {
      const r = document.createElement('div');
      r.className = 'advice-row info';
      r.textContent = `${k}: median ${fmt(v.median, 3)} · p95 ${fmt(v.p95, 3)} (${v.count})`;
      slipBox.appendChild(r);
    }

    tradesBox.replaceChildren();
    const tradesTitle = document.createElement('div');
    tradesTitle.className = 'perf-chart-title';
    tradesTitle.textContent = `Trade diagnostics (${recs.length})`;
    tradesBox.appendChild(tradesTitle);
    const rows = recs.slice().reverse().slice(0, 30);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'No closed trades yet';
      tradesBox.appendChild(empty);
    } else {
      for (const t of rows) {
        const f = t.fees;
        const feeTotal = f.commission + f.exchange + f.nfa + f.clearing + f.brokerage + f.routing + f.ip;
        const row = document.createElement('div');
        row.className = 'trade-diag';
        const top = document.createElement('div');
        top.className = 'td-top';
        const who = document.createElement('span');
        who.className = 'td-who';
        who.textContent = `${t.side.toUpperCase()} ${t.qty} ${t.symbol} · ${new Date(t.exitTime).toLocaleString()}`;
        const pnl = document.createElement('span');
        pnl.className = 'td-pnl ' + (t.pnl >= 0 ? 'pos' : 'neg');
        pnl.textContent = (t.pnl >= 0 ? '+' : '') + '$' + fmt(t.pnl) + ` · ${fmt(t.rMultiple, 2)}R`;
        top.appendChild(who);
        top.appendChild(pnl);
        const mid = document.createElement('div');
        mid.className = 'td-mid';
        mid.textContent = `Entry ${fmt(t.entryPrice)} → Exit ${fmt(t.exitPrice)} · ${(t.durationMs / 60000).toFixed(0)}m · ${t.session}`;
        const bottom = document.createElement('div');
        bottom.className = 'td-bottom';
        bottom.textContent = `MAE ${fmt(t.mae)} · MFE ${fmt(t.mfe)} · Fees $${fmt(feeTotal)} (comm ${fmt(f.commission)} · exch ${fmt(f.exchange)} · NFA ${fmt(f.nfa)} · clear ${fmt(f.clearing)} · route ${fmt(f.routing)})`;
        row.appendChild(top);
        row.appendChild(mid);
        row.appendChild(bottom);
        tradesBox.appendChild(row);
      }
    }
  }

  exportBtn.addEventListener('click', async () => {
    const recs = engine.getTrades();
    const s = summarize(recs, () => 1);
    try {
      // Try Capacitor Filesystem + Share if available, else Blob fallback
      const html = (() => {
        // Reuse exportReport's html generation but capture string
        const eq = equitySeries(recs);
        const fees = currentCostModel().fees(state.symbol, 1);
        const rows = recs.slice(-40).reverse().map((t) => {
          const f = t.fees;
          return `<tr><td>${new Date(t.exitTime).toLocaleString()}</td><td>${t.symbol}</td><td>${t.side.toUpperCase()}</td><td>${t.qty}</td><td>${fmt(t.entryPrice)}</td><td>${fmt(t.exitPrice)}</td><td>${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}</td><td>${fmt(t.rMultiple, 2)}R</td><td>${fmt(t.mae)}</td><td>${fmt(t.mfe)}</td><td>${(t.durationMs / 60000).toFixed(0)}m</td><td>$${fmt(f.commission + f.exchange + f.nfa + f.clearing + f.brokerage + f.routing + f.ip)}</td><td>${t.session}</td></tr>`;
        }).join('');
        const advice = advisorReview(recs, s).map((a) => `<li style="color:${a.severity === 'danger' ? '#ff4477' : a.severity === 'warn' ? '#ffb800' : '#9fe8ff'}">${a.text}</li>`).join('');
        const slipStats = SLIPPAGE_STORE.forSymbol(state.symbol);
        const svg = svgLine(eq.x, eq.y, 900, 240, '#00ff88');
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DAFE Charts Performance Report</title><style>body{font-family:Segoe UI,system-ui,sans-serif;background:#05050f;color:#e8e8ff;padding:24px}h1{color:#b48cff}h2{margin-top:28px;color:#00ff88}table{border-collapse:collapse;width:100%;font-size:11px;margin-top:10px}th,td{border:1px solid #1c1c3a;padding:6px 8px;text-align:left}th{color:#9a9ab8;text-transform:uppercase;font-size:9px}.stat{display:inline-block;background:#0c0c1e;border:1px solid #1c1c3a;border-radius:10px;padding:10px 14px;margin:6px;font-size:12px}.stat b{display:block;font-size:18px;color:#00ff88}.muted{color:#9a9ab8;font-size:11px}</style></head><body><h1>DAFE Charts — Performance Report</h1><div class="muted">Generated ${new Date().toLocaleString()} · Cost model: ${costSourceLabel()} · Fee source: ${fees.source}</div><h2>Summary</h2><div class="stat">Trades<b>${s.trades}</b></div><div class="stat">Win rate<b>${s.winRate.toFixed(1)}%</b></div><div class="stat">Net P&L<b>$${fmt(s.netPnl)}</b></div><div class="stat">Profit factor<b>${s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor)}</b></div><div class="stat">Expectancy<b>$${fmt(s.expectancy)}</b></div><div class="stat">Max DD<b>$${fmt(s.maxDrawdown)}</b></div><div class="stat">Avg R<b>${fmt(s.avgR, 2)}</b></div><div class="stat">Avg win<b>$${fmt(s.avgWin)}</b></div><div class="stat">Avg loss<b>$${fmt(s.avgLoss)}</b></div><div class="stat">Fees paid<b>$${fmt(s.feesTotal)}</b></div><h2>Equity curve</h2>${svg}<h2>Advisor review</h2><ul>${advice}</ul><h2>Trade diagnostics (last 40)</h2><table><tr><th>Exit time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th><th>MAE</th><th>MFE</th><th>Duration</th><th>Fees</th><th>Session</th></tr>${rows}</table><h2>Slippage (${state.symbol})</h2><div class="muted">Median ${fmt(slipStats.median, 3)} · Mean ${fmt(slipStats.mean, 3)} · 90th ${fmt(slipStats.p90, 3)} · 95th ${fmt(slipStats.p95, 3)} · ${slipStats.count} observations</div><p style="margin-top:30px;font-size:10px;color:#9a9ab8">Trading involves substantial risk. DAFE Charts is not investment advice.</p></body></html>`;
      })();
      // Try to use Capacitor Share / Filesystem if available
      const canShare = !!(navigator as any).share;
      // Always try Blob download first (works in PWA/WebView with download attribute sometimes blocked)
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `dafe-performance-${new Date().toISOString().slice(0,10)}.html`;
      document.body.appendChild(a);
      let clicked = false;
      try { a.click(); clicked = true; } catch {}
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 30000);
      // Fallback: open in new tab / share
      const t = document.createElement('div'); t.className='toast ok'; t.textContent=clicked?'Report downloaded — check Downloads folder':'Report generated — opening...'; document.body.appendChild(t); setTimeout(()=>t.remove(), 3500);
      if (!clicked || /Android|iPhone/i.test(navigator.userAgent)) {
        // Also offer to share if possible
        setTimeout(async ()=>{
          try {
            if (canShare && blob.size < 800000) {
              const file = new File([blob], `dafe-performance-${new Date().toISOString().slice(0,10)}.html`, { type: 'text/html' });
              if ((navigator as any).canShare?.({ files: [file] })) {
                await (navigator as any).share({ title: 'DAFE Performance Report', files: [file] });
              } else {
                // Fallback: mailto with summary + open html in tab
                window.open(url, '_blank');
              }
            }
          } catch {}
        }, 800);
      }
    } catch (e:any) {
      const recs2 = engine.getTrades();
      const s2 = summarize(recs2, () => 1);
      exportReport(recs2, s2, engine);
    }
  });
  emailBtn.addEventListener('click', () => {
    const recs = engine.getTrades();
    const s = summarize(recs, () => 1);
    const advice = advisorReview(recs, s).map((a) => '• ' + a.text).join('\n');
    const text = [
      'DAFE Charts Mobile — performance summary',
      '',
      `Trades: ${s.trades} · Win rate: ${s.winRate.toFixed(1)}% · Net P&L: $${fmt(s.netPnl)}`,
      `Profit factor: ${s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor)} · Expectancy: $${fmt(s.expectancy)} · Max DD: $${fmt(s.maxDrawdown)}`,
      `Fees paid: $${fmt(s.feesTotal)}`,
      '',
      'Advisor review:',
      advice,
    ].join('\n');
    // Reuse the self-contained HTML report so EMAIL RESULTS shares the real
    // document (no mailto dead-link; native share-sheet + download fallback).
    exportReport(recs, s, engine, true);
    const toast = document.createElement('div'); toast.className = 'toast ok';
    toast.textContent = 'Report generated — share sheet should open with the HTML attached.';
    document.body.appendChild(toast); setTimeout(() => toast.remove(), 4000);
  });

  build();

  return {
    dispose: () => { disposed = true; container.replaceChildren(); },
  };
}