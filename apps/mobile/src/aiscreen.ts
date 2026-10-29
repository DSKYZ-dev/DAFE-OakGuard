import type { BaseBar } from '@dafe/types';
import { state } from './state';
import { llmChat, nativePost } from './native-http';

export interface AiScreen {
  dispose: () => void;
}

interface ChatMsg { role: 'user' | 'assistant'; content: string; }

function sma(closes: number[], n: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    out.push(i >= n - 1 ? sum / n : NaN);
  }
  return out;
}

function rsi(closes: number[], n: number): number[] {
  const out: number[] = [];
  let gain = 0, loss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { out.push(NaN); continue; }
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) {
        gain /= n; loss /= n;
        out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
      } else out.push(NaN);
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    }
  }
  return out;
}

function formatPx(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (n >= 10) return n.toFixed(2);
  return n.toFixed(4);
}

function chartSummary(): string {
  const b = state.bars;
  if (b.length === 0) return `${state.symbol}: no bars loaded.`;
  const closes = b.map((x) => x.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const win = 20;
  const recent = b.slice(-win);
  const hi = Math.max(...recent.map((x) => x.high));
  const lo = Math.min(...recent.map((x) => x.low));
  const avgVol = b.slice(-50).reduce((a, x) => a + x.volume, 0) / Math.min(50, b.length);
  const lastVol = b[b.length - 1].volume;
  return [
    `Symbol: ${state.symbol} on ${state.timeframe}.`,
    `Last close: ${formatPx(last)} (${((last - prev) / prev * 100).toFixed(2)}% vs previous bar).`,
    `SMA20: ${isNaN(s20[s20.length - 1]) ? 'n/a' : formatPx(s20[s20.length - 1])}, SMA50: ${isNaN(s50[s50.length - 1]) ? 'n/a' : formatPx(s50[s50.length - 1])}.`,
    `RSI14: ${isNaN(r[r.length - 1]) ? 'n/a' : r[r.length - 1].toFixed(1)}.`,
    `${win}-bar range: ${formatPx(lo)} – ${formatPx(hi)}.`,
    `Last bar volume ${lastVol.toFixed(0)} vs ${avgVol.toFixed(0)} average (${(lastVol / Math.max(1, avgVol) * 100).toFixed(0)}%).`,
  ].join('\n');
}

function localAnalysis(question: string): string {
  const closes = state.bars.map((x) => x.close);
  if (closes.length === 0) return 'No chart data loaded yet — pick a symbol first.';
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const s20v = s20[s20.length - 1];
  const s50v = s50[s50.length - 1];
  const rv = r[r.length - 1];
  const q = question.toLowerCase();
  const lines: string[] = [];
  const avgVol = state.bars.slice(-50).reduce((a, x) => a + x.volume, 0) / Math.min(50, state.bars.length);
  const lastVol = state.bars[state.bars.length - 1].volume;

  const trend = last > s20v && s20v > s50v ? 'UPTREND' : last < s20v && s20v < s50v ? 'DOWNTREND' : 'RANGE / MIXED';
  const momentum = !isNaN(rv) ? (rv >= 70 ? 'overbought' : rv <= 30 ? 'oversold' : 'neutral') : 'unknown';

  if (q.includes('trend') || q.includes('direction') || q.includes('trend?')) {
    lines.push(`Trend analysis (${state.symbol}, ${state.timeframe}): ${trend}.`);
    lines.push(`Price vs SMA20: ${last > s20v ? 'above' : 'below'} (SMA20 ${formatPx(s20v)}), SMA50 ${formatPx(s50v)}.`);
    lines.push(`RSI14 is ${rv.toFixed(1)} — ${momentum}.`);
    if (trend === 'UPTREND') lines.push('Higher closes above both MAs suggest buyers are in control; watch for a close below SMA20 as early weakness.');
    else if (trend === 'DOWNTREND') lines.push('Lower closes below both MAs suggest sellers are in control; watch for reclaim of SMA20 as a bounce signal.');
    else lines.push('MAs are entangled — expect chop. Trade the range edges or wait for a breakout.');
  }
  if (q.includes('level') || q.includes('support') || q.includes('resistance') || q.includes('where')) {
    const recent = state.bars.slice(-30);
    const hi = Math.max(...recent.map((x) => x.high));
    const lo = Math.min(...recent.map((x) => x.low));
    lines.push(`Key levels (${state.symbol}, ${state.timeframe}, last 30 bars):`);
    lines.push(`• Resistance: ${formatPx(hi)} (recent high)`);
    lines.push(`• Support: ${formatPx(lo)} (recent low)`);
    lines.push(`• Midpoint: ${formatPx((hi + lo) / 2)} — a break-and-hold of the midpoint often flips it into support/resistance.`);
  }
  if (q.includes('risk') || q.includes('reward') || q.includes('stop')) {
    const recent = state.bars.slice(-30);
    const hi = Math.max(...recent.map((x) => x.high));
    const lo = Math.min(...recent.map((x) => x.low));
    const dir = last > (hi + lo) / 2 ? 'long' : 'short';
    const entry = last;
    const stop = dir === 'long' ? lo : hi;
    const target = dir === 'long' ? hi : lo;
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    const rr = reward / Math.max(0.0001, risk);
    lines.push(`Risk/reward sketch (${dir.toUpperCase()} setup):`);
    lines.push(`• Entry ${formatPx(entry)}, stop ${formatPx(stop)} (risk ${formatPx(risk)}), target ${formatPx(target)} (reward ${formatPx(reward)})`);
    lines.push(`• R:R ≈ ${rr.toFixed(2)} — ${rr >= 2 ? 'decent; size accordingly' : 'tight; consider skipping or trimming size'}.`);
    lines.push('This is a quick local estimate — not financial advice.');
  }
  if (q.includes('volume') || q.includes('volatility') || q.includes('vpi')) {
    const range = state.bars.slice(-20).map((x) => x.high - x.low);
    const atr = range.reduce((a, x) => a + x, 0) / range.length;
    lines.push(`Volume (${state.symbol}, ${state.timeframe}):`);
    lines.push(`• Last bar ${lastVol.toFixed(0)} vs ${avgVol.toFixed(0)} average — ${(lastVol / Math.max(1, avgVol) * 100).toFixed(0)}% of normal.`);
    lines.push(`• ${lastVol > avgVol * 1.5 ? 'Elevated volume — the move is being participated in (more conviction).' : lastVol < avgVol * 0.5 ? 'Below-average volume — moves may be low conviction.' : 'Normal participation.'}`);
    lines.push(`• Average range (ATR-20): ${formatPx(atr)} — ${atr / Math.max(0.0001, last) * 100 < 0.5 ? 'low volatility regime' : atr / Math.max(0.0001, last) * 100 > 2 ? 'high volatility regime' : 'moderate volatility regime'}.`);
  }
  if (q.includes('analy') || q.includes('overall') || q.includes('summary')) {
    const chg = (last - prev) / Math.max(0.0001, prev) * 100;
    lines.push(`Quick read on ${state.symbol} (${state.timeframe}): ${trend}.`);
    lines.push(`Last bar ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% to ${formatPx(last)}; RSI ${rv.toFixed(1)} (${momentum}).`);
    lines.push(`Volume is ${lastVol.toFixed(0)} vs ${avgVol.toFixed(0)} average (${(lastVol / Math.max(1, avgVol) * 100).toFixed(0)}%).`);
  }
  if (lines.length === 0) {
    lines.push(`Here's the current state of ${state.symbol} on ${state.timeframe}:`);
    lines.push(`• Trend: ${trend}, RSI14: ${rv.toFixed(1)} (${momentum}).`);
    lines.push(`• Last close: ${formatPx(last)} (${((last - prev) / prev * 100).toFixed(2)}% vs prior bar).`);
    lines.push(`• Quick tips: ask about "trend", "key levels", "risk/reward", "volume", or "analyze" for focused reads.`);
    lines.push('(Running in offline mode — connect a backend server in Settings to unlock the full AI advisor.)');
  }
  return lines.join('\n');
}

export function createAiScreen(container: HTMLDivElement): AiScreen {
  const messages: ChatMsg[] = [];

  const pillsBar = document.createElement('div');
  pillsBar.className = 'ai-pills';
  ['Trend?', 'Key levels', 'Risk/reward', 'Volume check', 'Full analysis'].forEach((p) => {
    const pill = document.createElement('button');
    pill.className = 'ai-pill';
    pill.textContent = p;
    pill.addEventListener('click', () => send(p));
    pillsBar.appendChild(pill);
  });

  const context = document.createElement('div');
  context.className = 'ai-context';
  context.innerHTML = '<span>Symbol: <span class="ctx-val" id="aiCtxSymbol">-</span></span>' +
    '<span>TF: <span class="ctx-val" id="aiCtxTf">-</span></span>' +
    '<span>Close: <span class="ctx-val" id="aiCtxClose">-</span></span>';

  const msgEl = document.createElement('div');
  msgEl.id = 'ai-messages';

  const inputRow = document.createElement('div');
  inputRow.className = 'ai-input-row';
  const input = document.createElement('textarea');
  input.id = 'ai-input';
  input.rows = 1;
  input.placeholder = 'Ask about the chart...';
  const sendBtn = document.createElement('button');
  sendBtn.id = 'ai-send';
  sendBtn.textContent = '↑';
  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);

  container.appendChild(pillsBar);
  container.appendChild(context);
  container.appendChild(msgEl);
  container.appendChild(inputRow);

  function appendMsg(role: 'user' | 'assistant' | 'error', content: string, tag?: string): void {
    const div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    if (tag) {
      const t = document.createElement('span');
      t.className = 'ai-tag';
      t.textContent = tag;
      div.appendChild(t);
    }
    div.appendChild(document.createTextNode(content));
    msgEl.appendChild(div);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  function showTyping(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'ai-msg assistant';
    const typing = document.createElement('span');
    typing.className = 'ai-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    div.appendChild(typing);
    msgEl.appendChild(div);
    msgEl.scrollTop = msgEl.scrollHeight;
    return div;
  }

  function llmConfig(): any { try { return JSON.parse(localStorage.getItem('dafe_mobile_llm') || '{}'); } catch { return {}; } }

  async function tryLlmAdvisor(userMsg: string): Promise<{ reply: string; ok: boolean }> {
    const cfg = llmConfig();
    const hasKey = !!cfg.apiKey?.trim();
    const provider = (cfg.provider || '').toLowerCase();
    // If no LLM configured, don't attempt — fall back to offline immediately
    if (!hasKey && provider !== 'ollama') return { reply: '', ok: false };
    const system = `You are DAFE Trade Advisor — the best on the planet. You give concise, actionable trading advice grounded in the chart summary. Always reference the provided SMA/RSI/level context. Be specific, not generic. If asked about volume/VPI/ATR, use the supplied stats.`;
    const user = `${userMsg}\n\nChart context:\n${chartSummary()}`;
    const r = await llmChat(cfg, system, user, { maxTokens: 2048, temperature: 0.55 });
    return r.ok ? { reply: r.text, ok: true } : { reply: r.error || 'LLM unavailable', ok: false };
  }

  async function send(q: string): Promise<void> {
    const text = q.trim();
    if (!text) return;
    messages.push({ role: 'user', content: text });
    appendMsg('user', text);
    input.value = '';
    input.style.height = 'auto';
    const typing = showTyping();
    try {
      let reply: string;
      let tag: string | undefined;
      // 1) Try unified LLM (Advisor + Editor) via CapacitorHttp — this is what Settings tests
      const llm = await tryLlmAdvisor(text);
      if (llm.ok) {
        reply = llm.reply;
        tag = 'AI Advisor';
      } else if (state.backendUrl) {
        // 2) Fallback: backend proxy (/api/chat) — only if user has a backend configured
        try {
          const res = await nativePost(`${state.backendUrl.replace(/\/$/, '')}/api/chat`, {
            agent: 'trade_advisor',
            message: text,
            messages: [{ role: 'system-context', content: chartSummary() }],
          }, {}, 12000);
          if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res?.status ?? 'no response'}`);
          const data: any = res.data;
          if (data?.ok && data?.reply) {
            reply = data.reply;
            tag = 'AI Advisor (backend)';
          } else {
            throw new Error(data?.detail || 'Backend returned an error');
          }
        } catch (err) {
          typing.remove();
          appendMsg('error', `LLM ${llm.reply ? `(${llm.reply})` : 'unreachable'} and backend unreachable (${err instanceof Error ? err.message : err}). Showing offline analysis.`);
          reply = localAnalysis(text);
          tag = 'Offline Analysis';
        }
      } else {
        if (llm.reply) {
          typing.remove();
          appendMsg('error', `LLM unreachable (${llm.reply}). Showing offline analysis — check API key / Base URL in Settings.`);
        }
        reply = localAnalysis(text);
        tag = 'Offline Analysis';
      }
      messages.push({ role: 'assistant', content: reply });
      typing.remove();
      appendMsg('assistant', reply, tag);
    } catch (err) {
      typing.remove();
      appendMsg('error', err instanceof Error ? err.message : String(err));
    }
  }

  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(90, input.scrollHeight) + 'px';
  });

  function updateContext(): void {
    const b = state.bars;
    const close = b.length ? b[b.length - 1].close : 0;
    (context.querySelector('#aiCtxSymbol') as HTMLElement).textContent = state.symbol;
    (context.querySelector('#aiCtxTf') as HTMLElement).textContent = state.timeframe;
    (context.querySelector('#aiCtxClose') as HTMLElement).textContent = close.toFixed(2);
  }

  appendMsg('assistant', "Hi, I'm your Trade Advisor. Ask about trend, key levels, risk/reward, volume — or tap a suggestion above.", 'DAFE Advisor');
  updateContext();
  const interval = setInterval(updateContext, 2000);

  return {
    dispose: () => { clearInterval(interval); container.replaceChildren(); },
  };
}