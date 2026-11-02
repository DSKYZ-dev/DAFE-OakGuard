import type { ExecutionEngine, TradeRecord } from './execution';
import { SLIPPAGE_STORE, currentCostModel, costSourceLabel } from './cost-engine';
import { state, persistSettings } from './state';
import { submitReport } from './reports';
import { llmChat } from './llm-router';

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
  // Always start at the origin (first trade's entry) so even a SINGLE trade
  // produces a two-point line — the curve evolves as more trades land.
  if (records.length > 0) {
    x.push(records[0].entryTime);
    y.push(0);
  }
  for (const t of records) {
    eq += t.pnl - (t.fees.commission + t.fees.exchange + t.fees.nfa + t.fees.clearing + t.fees.brokerage + t.fees.routing + t.fees.ip);
    x.push(t.exitTime);
    y.push(eq);
  }
  return { x, y };
}

function svgLine(x: number[], y: number[], w: number, h: number, stroke: string): string {
  if (x.length === 0) {
    // Zero trades: draw the baseline so the section isn't blank.
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#0c0c1e;border-radius:10px">
<line x1="8" y1="${h / 2}" x2="${w - 8}" y2="${h / 2}" stroke="${stroke}" stroke-width="2" stroke-dasharray="6 4" opacity="0.5"/>
<text x="${w / 2}" y="${h / 2 - 10}" fill="#9a9ab8" font-size="11" text-anchor="middle" font-family="Segoe UI,sans-serif">No closed trades yet</text>
</svg>`;
  }
  // Single point (or all-identical times): pad to a visible flat line.
  while (x.length < 2) { x.push(x[0] + 1); y.push(y[0]); }
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
  const area = `8,${h - 8} ${pts} ${w - 8},${h - 8}`;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#0c0c1e;border-radius:10px">
<polygon points="${area}" fill="${stroke}" opacity="0.08"/>
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
    const pnlCls = t.pnl >= 0 ? 'pos' : 'neg';
    return `<tr><td>${new Date(t.exitTime).toLocaleString()}</td><td>${t.symbol}</td><td>${t.side.toUpperCase()}</td><td>${t.qty}</td><td>${fmt(t.entryPrice)}</td><td>${fmt(t.exitPrice)}</td><td class="${pnlCls}">${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}</td><td>${fmt(t.rMultiple, 2)}R</td><td>${fmt(t.mae)}</td><td>${fmt(t.mfe)}</td><td>${(t.durationMs / 60000).toFixed(0)}m</td><td>$${fmt(f.commission + f.exchange + f.nfa + f.clearing + f.brokerage + f.routing + f.ip)}</td><td>${t.session}</td></tr>`;
  }).join('');
  const advice = advisorReview(recs, s).map((a) => `<div class="adv ${a.severity}"><span class="adv-badge">${a.severity === 'danger' ? '⚠ RISK' : a.severity === 'warn' ? '▲ WATCH' : '✓ GOOD'}</span>${a.text}</div>`).join('');
  const slipStats = SLIPPAGE_STORE.forSymbol(state.symbol);
  const pfTxt = s.profitFactor === Infinity ? '∞' : fmt(s.profitFactor);
  const stat = (label: string, val: string, cls = '') => `<div class="stat ${cls}">${label}<b>${val}</b></div>`;
  const pnlCls = s.netPnl >= 0 ? 'good' : 'bad';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DAFE Charts — Performance Report</title>
<style>
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a18;color:#e8e8ff;margin:0;padding:0}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 40px}
.hero{background:linear-gradient(135deg,#17123a 0%,#0d0a24 100%);border:1px solid rgba(180,140,255,.35);border-radius:16px;padding:22px;margin-bottom:22px}
.hero h1{color:#fff;font-size:19px;margin:0 0 6px;letter-spacing:.5px}
.hero .sub{color:#b48cff;font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
.hero .meta{color:#9a9ab8;font-size:10px;margin-top:8px}
h2{color:#00ff88;font-size:13px;margin:26px 0 10px;letter-spacing:1px;text-transform:uppercase}
.stat{display:inline-block;background:#10101f;border:1px solid #1c1c3a;border-radius:12px;padding:12px 16px;margin:4px;font-size:11px;color:#9a9ab8}
.stat b{display:block;font-size:19px;color:#fff;margin-top:3px;font-weight:800}
.stat.good b{color:#00ff88}.stat.bad b{color:#ff4477}
svg{width:100%;height:auto;display:block}
.adv{background:#10101f;border:1px solid #1c1c3a;border-radius:10px;padding:10px 12px;margin:6px 0;font-size:11px;color:#c9c9e8;line-height:1.5}
.adv.danger{border-color:rgba(255,68,119,.4)}
.adv.warn{border-color:rgba(255,184,0,.4)}
.adv-badge{display:inline-block;font-size:8px;font-weight:800;letter-spacing:1px;padding:2px 7px;border-radius:7px;margin-right:8px}
.adv.danger .adv-badge{background:rgba(255,68,119,.15);color:#ff4477}
.adv.warn .adv-badge{background:rgba(255,184,0,.15);color:#ffb800}
.adv:not(.danger):not(.warn) .adv-badge{background:rgba(0,255,136,.12);color:#00ff88}
table{border-collapse:collapse;width:100%;font-size:10px;margin-top:10px}
th,td{border:1px solid #1c1c3a;padding:5px 7px;text-align:left}
th{color:#9a9ab8;text-transform:uppercase;font-size:8px;background:#0c0c1e}
tr:nth-child(even) td{background:#0a0a18}
td.pos{color:#00ff88;font-weight:700}td.neg{color:#ff4477;font-weight:700}
.muted{color:#9a9ab8;font-size:10px;line-height:1.6}
.foot{color:#6a6a8a;font-size:9px;margin-top:28px;border-top:1px solid #1c1c3a;padding-top:12px}
</style></head><body><div class="wrap">
<div class="hero"><h1>📈 DAFE Charts — Performance Report</h1><div class="sub">Trading performance analytics · ${state.symbol}</div><div class="meta">Generated ${new Date().toLocaleString()} · Cost model: ${costSourceLabel()} · Fee source: ${fees.source} · ${recs.length} closed trades</div></div>
<h2>Summary</h2>
${stat('Trades', String(s.trades))}
${stat('Win rate', s.winRate.toFixed(1) + '%', s.winRate >= 50 ? 'good' : 'bad')}
${stat('Net P&L', '$' + fmt(s.netPnl), pnlCls)}
${stat('Profit factor', pfTxt, s.profitFactor >= 1 ? 'good' : 'bad')}
${stat('Expectancy', '$' + fmt(s.expectancy), s.expectancy >= 0 ? 'good' : 'bad')}
${stat('Max drawdown', '$' + fmt(s.maxDrawdown), 'bad')}
${stat('Avg R', fmt(s.avgR, 2) + 'R')}
${stat('Avg win', '$' + fmt(s.avgWin), 'good')}
${stat('Avg loss', '$' + fmt(s.avgLoss), 'bad')}
${stat('Fees paid', '$' + fmt(s.feesTotal))}
<h2>Equity curve</h2>${svgLine(eq.x, eq.y, 900, 240, '#00ff88')}
<h2>Advisor review</h2>${advice || '<div class="muted">No advisor notes — keep trading to build a review history.</div>'}
<h2>Trade diagnostics (last 40)</h2>
<table><tr><th>Exit time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th><th>MAE</th><th>MFE</th><th>Duration</th><th>Fees</th><th>Session</th></tr>${rows}</table>
<h2>Slippage — ${state.symbol}</h2>
<div class="muted">Median ${fmt(slipStats.median, 3)} · Mean ${fmt(slipStats.mean, 3)} · 90th ${fmt(slipStats.p90, 3)} · 95th ${fmt(slipStats.p95, 3)} · ${slipStats.count} observations</div>
<div class="muted">Slippage is measured from your own fills — expected signal price vs actual simulated fill.</div>
<div class="foot">DAFE Charts · self-contained report — no network required · Trading involves substantial risk. DAFE Charts is not investment advice.</div>
</div></body></html>`;
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
      const r = await llmChat({ system: 'You are the DAFE Trade Advisor — concise, specific, actionable.', messages: [{ role: 'user', content: prompt }], maxTokens: 2048, temperature: 0.7 });
      if (!r.ok) throw new Error(r.error || 'LLM request failed');
      return r.text ?? '';
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
  // ONE consolidated report button — the old pair (EXPORT REPORT + EMAIL
  // RESULTS) did overlapping jobs and neither reliably delivered on Android.
  const exportBtn = document.createElement('button');
  exportBtn.className = 'editor-run';
  exportBtn.textContent = 'EMAIL / SHARE REPORT';
  actions.appendChild(exportBtn);
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


  // Consolidated report button — native Filesystem + Share (real file in the
  // Android share sheet), web fallback otherwise. One button, one behavior.
  exportBtn.addEventListener('click', async () => {
    const recs = engine.getTrades();
    const s = summarize(recs, () => 1);
    exportReport(recs, s, engine, true);
  });

  build();

  return {
    dispose: () => { disposed = true; container.replaceChildren(); },
  };
}
