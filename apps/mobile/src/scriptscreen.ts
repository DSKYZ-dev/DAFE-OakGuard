import { getIndicators, parse, executeScript, validate, formatValidationIssues } from '../../web/src/oakscript';
import { barsToRuntimeBarData } from '../../web/src/backtest/data';
import { runBacktestOnBars } from '../../web/src/backtest/engine';
import { generateBars, type Timeframe } from '../../web/src/data-generator';
import type { BaseBar } from '@dafe/types';
import { fetchYahooBars } from './yahoo';
import { fetchMassiveBars } from './massive';
import { state, persistSettings, type ActiveIndicator } from './state';
import type { ChartScreen } from './chartscreen';

export interface ScriptScreen { dispose: () => void; }

const CUSTOM_SOURCE_KEY = 'dafe_mobile_custom_script';
const SIGNAL_MODE_KEY = 'dafe_mobile_signal_mode';

function llmConfig(): any { try { return JSON.parse(localStorage.getItem('dafe_mobile_llm') || '{}'); } catch { return {}; } }
async function callLLM(system: string, user: string): Promise<string> {
  const cfg = llmConfig();
  const { llmChat } = await import('./native-http');
  const r = await llmChat(cfg, system, user, { maxTokens: 8192, temperature: 0.7 });
  if (!r.ok) throw new Error(r.error || 'LLM request failed');
  return r.text;
}

export function createScriptScreen(container: HTMLDivElement, chart: ChartScreen): ScriptScreen {
  let page: 'code' | 'backtest' = 'code';

  const pageSel = document.createElement('select');
  pageSel.style.width = '100%'; pageSel.style.marginBottom = '8px';
  for (const [v,l] of [['code','Code Editing'],['backtest','Backtesting / Optimizer']] as const) {
    const o=document.createElement('option'); o.value=v; o.textContent=l; pageSel.appendChild(o);
  }

  const docsBtn = document.createElement('button'); docsBtn.className='editor-clear'; docsBtn.textContent='📖 Docs';
  docsBtn.addEventListener('click', async () => {
    const overlay=document.createElement('div'); overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px;';
    const dlg=document.createElement('div'); dlg.style.cssText='width:100%;max-width:600px;max-height:85vh;background:var(--bg-panel, #10101f);border:1px solid var(--border, rgba(180,140,255,0.3));border-radius:14px;display:flex;flex-direction:column;overflow:hidden;';
    const head=document.createElement('div'); head.style.cssText='padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);flex-shrink:0;';
    head.innerHTML='<b style="color:var(--accent,#b48cff)">OakScript Docs — Complete Reference</b>';
    const close=document.createElement('button'); close.textContent='✕'; close.style.cssText='background:none;border:none;color:rgba(255,255,255,0.7);font-size:18px;cursor:pointer;padding:4px 8px;'; close.addEventListener('click',()=>overlay.remove());
    head.appendChild(close); dlg.appendChild(head);
    const tabBar=document.createElement('div'); tabBar.style.cssText='display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0;';
    const body=document.createElement('div'); body.style.cssText='padding:0;overflow:auto;flex:1;display:flex;flex-direction:column;';
    const foot=document.createElement('div'); foot.style.cssText='padding:8px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    const search=document.createElement('input'); search.placeholder='Search docs...'; search.style.cssText='flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-raised);color:var(--text);font-size:12px;';
    const ok=document.createElement('button'); ok.textContent='Close'; ok.style.cssText='padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-raised);color:var(--text);cursor:pointer;margin-left:8px;'; ok.addEventListener('click',()=>overlay.remove());
    foot.appendChild(search); foot.appendChild(ok);
    try {
      const mod:any = await import('../../web/src/oakscript/docs');
      const docs: {title:string;content:string}[] = mod.getDocumentation ? mod.getDocumentation() : [];
      if (!docs || docs.length === 0) throw new Error('No docs');
      const catOf = (t:string):string => {
        if (/Overview|Comments|Literals|Variables|Operators|Control/.test(t)) return 'Basics';
        if (/Array|OakRing|Matrix/.test(t)) return 'Data Types';
        if (/Input|Plotting|Combining|Shapes|Drawing|Table|Image|Analyst/.test(t)) return 'Plotting';
        if (/3D|Visual|Kinematic/.test(t)) return '3D';
        if (/Standard Library|Math/.test(t)) return 'Library';
        if (/Model Execution|ML \/ RL|Confirmed/.test(t)) return 'Strategy';
        if (/Execution|Alerts|Consensus/.test(t)) return 'Engine';
        if (/Pitfalls|Example/.test(t)) return 'Examples';
        if (/Agent/.test(t)) return 'Agent';
        return 'Other';
      };
      const cats = new Map<string, typeof docs>();
      for (const d of docs) {
        const cat = catOf(d.title);
        if (!cats.has(cat)) cats.set(cat, []);
        cats.get(cat)!.push(d);
      }
      const order = ['Basics','Data Types','Plotting','3D','Library','Strategy','Engine','Examples','Agent','Other'];
      const sortedCats = Array.from(cats.keys()).sort((a,b)=>order.indexOf(a)-order.indexOf(b));
      let activeCat = sortedCats[0];
      const tabBtns: HTMLButtonElement[] = [];
      const renderCat = (cat:string) => {
        activeCat = cat;
        tabBtns.forEach(b=>{ b.style.background=b.textContent===cat?'var(--accent)':'var(--bg-raised)'; b.style.color=b.textContent===cat?'var(--bg)':'var(--text-dim)'; b.style.borderColor=b.textContent===cat?'var(--accent)':'var(--border)'; });
        body.replaceChildren();
        const sections = cats.get(cat) || [];
        for (const sec of sections) {
          const secEl=document.createElement('div'); secEl.style.cssText='padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);';
          const title=document.createElement('div'); title.textContent=sec.title; title.style.cssText='font-size:12px;font-weight:800;color:var(--accent);margin-bottom:6px;';
          const content=document.createElement('div'); content.textContent=sec.content; content.style.cssText='font-size:11px;line-height:1.65;color:rgba(255,255,255,0.85);white-space:pre-wrap;word-break:break-word;';
          secEl.appendChild(title); secEl.appendChild(content); body.appendChild(secEl);
        }
        if (sections.length===0) {
          const empty=document.createElement('div'); empty.textContent='No docs in this category'; empty.style.cssText='padding:24px;text-align:center;color:var(--text-faint);'; body.appendChild(empty);
        }
      };
      for (const cat of sortedCats) {
        const btn=document.createElement('button'); btn.textContent=cat; btn.style.cssText='flex-shrink:0;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-raised);color:var(--text-dim);font-size:11px;font-weight:700;cursor:pointer;';
        btn.addEventListener('click',()=>renderCat(cat)); tabBar.appendChild(btn); tabBtns.push(btn);
      }
      const doSearch = () => {
        const q=search.value.trim().toLowerCase();
        if (!q) { renderCat(activeCat); return; }
        body.replaceChildren();
        let found=0;
        for (const d of docs) {
          if (d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)) {
            const secEl=document.createElement('div'); secEl.style.cssText='padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);';
            const title=document.createElement('div'); title.textContent=d.title; title.style.cssText='font-size:12px;font-weight:800;color:var(--accent);margin-bottom:6px;';
            const content=document.createElement('div'); content.textContent=d.content; content.style.cssText='font-size:11px;line-height:1.65;color:rgba(255,255,255,0.85);white-space:pre-wrap;';
            secEl.appendChild(title); secEl.appendChild(content); body.appendChild(secEl); found++;
            if (found>=20) break;
          }
        }
        if (found===0) { const e=document.createElement('div'); e.textContent='No results for "'+q+'"'; e.style.cssText='padding:24px;text-align:center;color:var(--text-faint);'; body.appendChild(e); }
      };
      search.addEventListener('input', doSearch);
      dlg.appendChild(tabBar);
      dlg.appendChild(body);
      renderCat(activeCat);
    } catch(e:any){
      const err=document.createElement('div'); err.textContent='Docs unavailable: '+(e?.message||e); err.style.cssText='padding:16px;color:var(--red);font-size:11px;white-space:pre-wrap;'; body.appendChild(err);
      dlg.appendChild(body);
    }
    dlg.appendChild(foot);
    overlay.appendChild(dlg); overlay.addEventListener('click',(ev)=>{ if(ev.target===overlay) overlay.remove(); }); document.body.appendChild(overlay);
  });

  // LLM Chat (present on both pages) — floating panel with close + minimize
  const chatBox = document.createElement('div');
  chatBox.id = 'editor-chat-panel';
  chatBox.className = 'editor-chat-panel';
  const chatHeader = document.createElement('div');
  chatHeader.className = 'editor-chat-header';
  const chatHeaderTitle = document.createElement('div');
  chatHeaderTitle.className = 'editor-chat-title';
  chatHeaderTitle.textContent = 'OakScript Editor — Chat';
  const chatHeaderBtns = document.createElement('div');
  chatHeaderBtns.className = 'editor-chat-btns';
  const minBtn = document.createElement('button');
  minBtn.className = 'editor-chat-iconbtn';
  minBtn.textContent = '—';
  minBtn.title = 'Minimize';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'editor-chat-iconbtn';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  chatHeaderBtns.appendChild(minBtn);
  chatHeaderBtns.appendChild(closeBtn);
  chatHeader.appendChild(chatHeaderTitle);
  chatHeader.appendChild(chatHeaderBtns);
  const chatBody = document.createElement('div');
  chatBody.className = 'editor-chat-body';
  const chatLog = document.createElement('div'); chatLog.className = 'editor-chat-log';
  const chatInput = document.createElement('textarea'); chatInput.className = 'editor-chat-input'; chatInput.placeholder='Describe the indicator you want... e.g. "RSI divergence with buy/sell triangles"';
  const chatInputRow = document.createElement('div');
  chatInputRow.className = 'editor-chat-inputrow';
  const chatSend = document.createElement('button'); chatSend.className = 'editor-run'; chatSend.textContent='Ask Editor';
  const chatStatus = document.createElement('div'); chatStatus.className = 'set-status editor-chat-status';
  chatInputRow.appendChild(chatInput);
  chatInputRow.appendChild(chatSend);
  chatBody.appendChild(chatLog);
  chatBody.appendChild(chatInputRow);
  chatBody.appendChild(chatStatus);
  chatBox.appendChild(chatHeader);
  chatBox.appendChild(chatBody);

  function setChatMinimized(min: boolean): void {
    if (min) { chatBox.classList.add('minimized'); minBtn.textContent = '+'; minBtn.title = 'Restore'; }
    else { chatBox.classList.remove('minimized'); minBtn.textContent = '—'; minBtn.title = 'Minimize'; }
  }
  minBtn.addEventListener('click', () => setChatMinimized(!chatBox.classList.contains('minimized')));
  // Close HIDES the panel (never remove() — the node must stay reusable).
  closeBtn.addEventListener('click', () => {
    chatBox.style.display = 'none';
    reopenBtn.style.display = '';
  });
  // Reopen affordance — a small pill that appears whenever chat is closed.
  const reopenBtn = document.createElement('button');
  reopenBtn.className = 'chat-reopen-pill';
  reopenBtn.textContent = '💬 Editor';
  reopenBtn.title = 'Reopen editor chat';
  reopenBtn.style.display = 'none';
  reopenBtn.addEventListener('click', () => {
    chatBox.style.display = '';
    reopenBtn.style.display = 'none';
    setChatMinimized(false);
  });

  // ── Editor memory bank ─────────────────────────────────────────
  // Full position awareness across turns AND app restarts: conversation
  // history, the agent's own last generated script, and the live error log
  // are persisted and re-injected into EVERY call so the agent never treats
  // a correction as a fresh conversation or as a user-provided script.
  const MEM_KEY = 'dafe_editor_memory';
  interface MemBank { history: { role: 'user' | 'editor'; text: string }[]; lastScript: string; errors: string[]; }
  function loadMem(): MemBank {
    try {
      const m = JSON.parse(localStorage.getItem(MEM_KEY) || '{}');
      return {
        history: Array.isArray(m.history) ? m.history.slice(-12) : [],
        lastScript: typeof m.lastScript === 'string' ? m.lastScript : '',
        errors: Array.isArray(m.errors) ? m.errors.slice(-10) : [],
      };
    } catch { return { history: [], lastScript: '', errors: [] }; }
  }
  function saveMem(m: MemBank): void {
    try { localStorage.setItem(MEM_KEY, JSON.stringify({ history: m.history.slice(-12), lastScript: m.lastScript, errors: m.errors.slice(-10) })); } catch {}
  }
  let mem: MemBank = loadMem();

  // Errors pushed from the chart now LAND IN THE MEMORY BANK too.
  (window as any).__dafeEditorChat = (kind: 'info' | 'error' | 'user', text: string) => {
    if (!chatBox.isConnected) return;
    const el = document.createElement('div');
    const tag = kind === 'user' ? 'You' : kind === 'error' ? 'Chart' : 'Editor';
    el.textContent = `${tag}: ${text}`;
    el.style.color = kind === 'error' ? 'var(--red)' : kind === 'user' ? 'var(--accent)' : 'var(--cyan)';
    el.style.opacity = kind === 'info' ? '0.7' : '1';
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
    if (kind === 'error') { mem.errors.push(text.slice(0, 400)); saveMem(mem); }
    if (chatBox.classList.contains('minimized')) setChatMinimized(false);
  };

  // Replay persisted memory into the visible log so the human also sees it.
  (function replayMemory(): void {
    for (const h of mem.history) {
      const el = document.createElement('div');
      el.textContent = `${h.role === 'user' ? 'You' : 'Editor'}: ${h.text.slice(0, 400)}`;
      el.style.color = h.role === 'user' ? 'var(--accent)' : 'var(--cyan)';
      chatLog.appendChild(el);
    }
    for (const e of mem.errors.slice(-3)) {
      const el = document.createElement('div');
      el.textContent = `Chart: ${e}`;
      el.style.color = 'var(--red)';
      chatLog.appendChild(el);
    }
    if (mem.history.length > 0 || mem.errors.length > 0) chatLog.scrollTop = chatLog.scrollHeight;
  })();

  async function sendChat() {
    const prompt = chatInput.value.trim(); if (!prompt) return;
    const entry = document.createElement('div'); entry.textContent='You: '+prompt; entry.style.opacity='0.8'; chatLog.appendChild(entry);
    chatSend.textContent='Thinking...'; (chatSend as HTMLButtonElement).disabled=true;
    chatInput.value='';
    // Safeguards — domain only
    const offTopic = /^(who should i date|what'?s the weather|dating|weather|politics|recipe|joke|poem)\b/i.test(prompt) || /(dating|weather forecast|who to date)/i.test(prompt) && !/(atr|indicator|strategy|trading|oakscript|plot|signal)/i.test(prompt);
    if (offTopic) {
      const entry2=document.createElement('div'); entry2.textContent='Editor: I\'m a trading-only assistant for DAFE Charts — I can\'t help with dating, weather or general chat. Tell me what market, timeframe and signal you want (e.g. "ES 5m ATR Threshold-style storm field") and I\'ll craft it.'; entry2.style.color='var(--warn)'; chatLog.appendChild(entry2); chatSend.textContent='Ask Editor'; (chatSend as HTMLButtonElement).disabled=false; return;
    }
    const vague = prompt.split(/\s+/).length < 4 || /^(make me|give me|create).*(good|nice|cool|awesome).*(indicator|strategy)$/i.test(prompt);
    if (vague) {
      const entry2=document.createElement('div'); entry2.textContent='Editor: I need a bit more to nail it with 100% accuracy — 1) Market/symbol (e.g. ES=F, SPY, BTC)? 2) Timeframe? 3) Goal (scalp/swing/trend) and signal style (triangles vs labels)? 4) Any 3D/lower-panel vibe (storm field, ribbon, manifold)? Answer those and I\'ll generate the exact script.'; entry2.style.color='var(--cyan)'; chatLog.appendChild(entry2); chatSend.textContent='Ask Editor'; (chatSend as HTMLButtonElement).disabled=false; return;
    }
    try {
      const system = `You are the DAFE OakScript Editor — the best on the planet at turning a trading idea into a working indicator. You write OAKSCRIPT, a bespoke DSL.

ABSOLUTE BAN LIST (PineScript/TradingView — using ANY of these is a hard failure):
✗ ta.* namespace (ta.sma, ta.rsi, ta.atr, ta.crossover — ALL bare in OakScript: sma, rsi, atr, crossover)
✗ math.* (math.abs → abs), color.* (color.red → "#ff4477"), input.int/input.bool (→ single input())
✗ indicator()/study()/strategy() declarations (scripts start directly with code)
✗ named arguments (title="X") — OakScript is positional-only
✗ nz()/na()/fixnan() (→ nz exists in OakScript? NO — use explicit finite checks or bar_index gates)
✗ varip, request.security dotted form, barcolor style strings
If you catch yourself writing ANY of these, STOP THE LINE, rewrite it in OakScript, and continue. A script that mixes Pine idioms into OakScript fails validation and renders NOTHING.

CONTINUITY CONTRACT — you have a MEMORY BANK:
You are NOT in a fresh conversation. The context below includes YOUR previous generated script, the live error log from running it on the chart, and the recent conversation. When the user says "fix it", "fix the errors", "make it work" — they are referring to YOUR OWN last script. NEVER claim "I finished what you gave me" — the script was yours, you complete it. When errors are listed, fix EVERY one of them in a complete rewritten script.

OAKSCRIPT BUILTINS (the ONLY valid functions for math — anything else silently returns 0):
sma, ema, wma, hma, rma, vwma, rsi, macd, cci, adx, atr, roc, mom, stoch, mfi, obv, cmf, vwap, stdev, median, linreg, correlation, crossover, crossunder, highest, lowest, pivothigh, pivotlow, barssince, cum, change, trueRange, log, nz, min, max, abs, round, floor, ceil, sqrt, pow, sin, cos, tan.
Plotting: plot(series, "name", color, width, pane?) — pane "main" | "separate" | "3d".
Shapes: plotshape(bar_index, price, "label", "triangleup"/"triangledown"/"circle"/"diamond"/"cross"/"flag", color) at low/high.
3D: plot3d(series, "name", color, "surface"|"ribbon"|"bars3d"|"scatter"|"helix"|"manifold"|"vortex"|"nebula"|"constellation"|"torus"|"trail", pane="3d", z_level?). plotshape_3d(bar_index, price, "label", "coneup"/"conedown"/"cube"/"sphere"/"pyramid"/"torus", color, pane).
Lines/fill: hline(price, "label", color, width), fill(seriesA, seriesB, color), bgcolor(color), barcolor(color).
Inputs: input(default, "title", min, max, step) — becomes a user-facing knob. opt()/tt() add adaptive presets. Declare inputs FIRST as variables: len = input(14, "Length", 2, 100, 1).
Execution: model.entry("Long", +1) / model.exit("Exit") for strategy mode; model.stopLoss()/model.takeProfit() for brackets.

NEVER PRETEND COMPLETION — hard honesty rules:
1. If the user corrects you, re-run the WHOLE self-audit below and deliver a complete, corrected script — never say you "finished what was given" when a prior turn was cut off or incomplete. A partial script is a failure, not a deliverable.
2. Always emit the ENTIRE runnable script in one \`\`\`oakscript block. No ellipses (…), no "and continue", no placeholder comments. If you run out of room, complete the script, never truncate.
3. Do not freeze mid-build: keep every script short enough to finish (≤ ~120 lines). Favor one clean signal over ten half-built layers. If a request is huge, build a focused core that RUNS, then note what can be added next.

UNIVERSAL LOWER-MANIFOLD ADAPTER AWARENESS (hardcoded, never user-exposed):
PANEL_GEOMETRY registry auto-maps 26+ lower-panel modes to G1..G9: Pulse→G1_RIBBON, Spike Raster→G2_RASTER, Force Graph→G3_NETWORK, Living Lattice→G4_LATTICE, Phase-Space→G5_PHASE, Potential Well→G6_FIELD, Advanced Dynamic Field→G7_SCENE, KNN Constellation→G8_RADIAL, Upgraded Classic→G9_TEXT. CLOCK wallMs=Date.now()||n*1000, barMod12/8/16, hashRand, seededPhase. Engines: G1 glint+breathing, G2 ghost-flicker (Poisson 0.04) + shockwave, G3 jitter + edge current, G4 ripple + shimmer, G5 comet, G6 ridge-light, G7 parallax 0.4× + micro-tilt, G8 orbital creep, G9 gauge drift. Cross-cutting: lightning jitter (3-5 segs /150ms), chromatic drift, swarm orbit, depth-of-field, lensing, heartbeat. Your lower-panel code should declare modeName and let the adapter auto-animate — do NOT hand-code animation timers.

ENGINE MATH CONTRACT (current, verified — generate AGAINST these exact semantics):
- macd(s,f,sig).signal/.hist are NaN until BOTH EMAs warm up (~slow bars) AND signal EMA seed completes (~slow+sig bars). Guard: use crossover(m.macd, m.signal) only after bar_index > f+sig+5 or wrap operands in nz(x, 0).
- linreg(src,len,off) is TRUE least-squares slope/intercept — use it for channel midlines, slope filters, projected levels. Do NOT emulate with sma.
- atr() is Wilder RMA of trueRange (not EMA). adx()/rsi() use Wilder smoothing. stdev() is population (÷len). cci() uses mean deviation ×0.015.
- Prices keep full instrument precision (forex 1.08543 stays 1.08543). NEVER hand-round to 2 decimals with Math.round(x*100)/100-style math inside scripts for sub-$10 instruments — scale rounding to magnitude (2dp ≥1000, 4dp ≥10, 5dp <10).
- Volume delta convention: buy fraction = 0.25 + 0.5×(close−low)/(high−low) clamped [0,1] — mirror this in any custom buy/sell split so visuals match the Volume Profile panel.
- rsi/stdev/wma/rma/hma/mom/median return NaN during warmup by design. NaN comparisons are false — but do NOT rely on that for signals; explicitly gate with bar_index > warmup.
- crossover/crossunder require both prior values finite; a NaN neighbor silently disables detection.

MATHEMATICAL AUDIT MISSION — YOUR PRIMARY GOAL (do not rush, brilliant > adequate):
1. Decompose request into building blocks (which MA? which ATR variant? which zero-lag? Chandelier vs Keltner? storm field spin?).
2. For each block, audit for old/inaccurate math: EMA-vs-RMA drift (EMA-ATR is ~30% too reactive), stdev-vs-meanDev CCI compression (~20%), SMA-based ADX, source[0]-seeded EMA bias, RSI filled with 50 instead of NaN during warmup, O(n·len) sliding windows where O(n) suffices, unclamped divisions (range||1, vol>0 guards), lookahead leaks (using current-bar close to decide entries filled same bar). Flag every flaw you inherit from the request's framing too ("RSI 14 with EMA smoothing" → propose Wilder).
3. Propose the modern solution, then STRESS it mentally against three synthetic regimes: monotonic trend (no whipsaw churn?), flat noise (signal drought, not machine-gun?), single violent spike (one-shot entry, no repainting cascade?). If a regime breaks the logic, redesign before writing code.
4. SELF-AUDIT LOOP BEFORE PRESENTING (mandatory, silent): mentally execute your draft over a 100-bar synthetic through parse → execute. Gate checks — G1: plots>0 and errors==0. G2: zero non-warmup NaN reaching plot()/signals. G3: ≥1 signal fires per regime above, none fire during warmup. G4: no lookahead — every entry condition uses data available at decision bar. G5: 3D/separate-pane coherence if used. ANY gate fails → fix and re-run all gates (max 3 revisions). Only present after 3 consecutive clean passes.
5. Present the final script with inline comments marking audited math ('// ATR: Wilder RMA — validated vs TradingView', '// MACD signal gated past slow+sig warmup'). It is your mission to find flaws, audit building blocks, and produce a brilliant mathematical solution to even a simplistic request.

RULES — 100% accuracy is PASS:
- Input groups with opt()/tt() tooltips, rangeOpts(), clamp(), auto-config maps (ZLT_MAP/SB_MAP etc.) tied to tuning modes.
- 3D: choose pane/style coherently, not abstract. Main chart pane="3d" ribbon/surface for trend, pane="separate" manifold/ridgeline for lower oscillator, plotshape_3d coneup at low / conedown at high with correct pane="3d" or "separate". Storm field = concentric rings + wind spiral + halo + stop radius ring via 3D manifold datasets, spin via Date.now()*rotationRate+spinOffset, not random. Lower panel = line/area/histogram with fill/bgcolor, never 3D for oscillator unless pane="separate".
- Signals: if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") } at low, sell at high, inside if; add model.entry/model.exit when signalAsStrategy toggle is on (user signals toggle). Provide Test on Chart / Save Signal Generator / Delete inventory.
- Ask 2-3 clarification Qs when vague; refuse off-topic (dating/weather) politely and redirect to trading. Current bars: ${state.bars.length}, symbol ${state.symbol}, timeframe ${state.timeframe}, draft length ${customEditor.value.length}. Return ONE complete, runnable \`\`\`oakscript block (never truncated, no ellipses, no "continue from here").`;
      // ── Memory-bank context injection ──
      // The agent gets: its OWN last script (explicitly marked as ITS work),
      // the live error log, the recent conversation, SAVED-SIGNAL knowledge,
      // and the current draft. This kills the "new conversation" amnesia.
      const histBlock = mem.history.length
        ? '\n\nCONVERSATION SO FAR (most recent last, condensed):\n' + mem.history.map(h => `${h.role === 'user' ? 'USER' : 'YOU (EDITOR)'}: ${h.text.slice(0, 300)}`).join('\n')
        : '';
      const errBlock = mem.errors.length
        ? '\n\nLIVE ERROR LOG (from running YOUR script on the chart — these are runtime/validation failures of the script YOU wrote; fix them):\n' + mem.errors.map(e => '- ' + e).join('\n')
        : '';
      let kbBlock = '';
      try {
        const kb = JSON.parse(localStorage.getItem('dafe_editor_kb') || '[]');
        if (Array.isArray(kb) && kb.length > 0) {
          kbBlock = '\n\nSAVED-SIGNAL KNOWLEDGE BASE (past builds the user accepted — match this style/quality):\n'
            + kb.slice(-5).map((k: any) => `- "${k.name}" :: request: ${String(k.request || '').slice(0, 120)} :: ${k.fixesApplied}`).join('\n');
        }
      } catch {}
      const ownBlock = mem.lastScript
        ? `\n\nYOUR LAST GENERATED SCRIPT (you wrote this in a previous turn — it is NOT user-provided; when the user asks for fixes or says "fix the errors", they mean THIS script. Either fix it or fully rewrite it, but never disown it):\n\`\`\`oakscript\n${mem.lastScript.slice(0, 3000)}\n\`\`\``
        : '';
      const userBlock = `\n\nUSER REQUEST: ${prompt}\n\nCURRENT DRAFT IN EDITOR:\n${(customEditor.value || '').slice(0, 3000)}`;
      const ans = await callLLM(system, userBlock + ownBlock + errBlock + histBlock + kbBlock);
      const m = ans.match(/```(?:oakscript)?\s*([\s\S]*?)```/i);
      const code = m ? m[1].trim() : ans.trim();
      const entry2=document.createElement('div'); entry2.textContent='Editor: '+ ans.slice(0,600); entry2.style.color='var(--cyan)'; chatLog.appendChild(entry2);
      if (code && code.includes('plot')) {
        // ── AUTONOMOUS VERIFY-AND-FIX LOOP ──
        // The editor's JOB is delivering working scripts: run the draft
        // locally (validate + execute against real bars), and if it fails,
        // feed the errors back and regenerate — silently, up to N rounds —
        // BEFORE anything is shown or put on the chart. The user never has
        // to ask "fix the errors"; the loop already did.
        let working = code;
        let round = 0;
        const MAX_FIX_ROUNDS = 3;
        while (round < MAX_FIX_ROUNDS) {
          const check = verifyScript(working);
          if (check.ok) break;
          round++;
          const step = document.createElement('div');
          step.textContent = `Editor: self-check round ${round} failed — ${check.errors.slice(0, 2).join(' | ').slice(0, 300)}`;
          step.style.color = 'var(--warn)';
          chatLog.appendChild(step);
          chatLog.scrollTop = chatLog.scrollHeight;
          try {
            const fixPrompt = `Your previous OakScript draft failed local verification. Fix EVERY issue and return the complete corrected script in one \`\`\`oakscript block (no Pine, no truncation, no ellipses).

FAILURES:
${check.errors.map(e => '- ' + e).join('\n')}

YOUR PREVIOUS DRAFT (you wrote this — fix it, do not disown it):
\`\`\`oakscript
${working.slice(0, 3500)}
\`\`\``;
            const fixAns = await callLLM(system, fixPrompt);
            const fixMatch = fixAns.match(/```(?:oakscript)?\s*([\s\S]*?)```/i);
            if (!fixMatch || !fixMatch[1].includes('plot')) throw new Error('fix round returned no script');
            working = fixMatch[1].trim();
          } catch (fixErr: any) {
            const fe = document.createElement('div');
            fe.textContent = 'Fix round error: ' + (fixErr?.message || fixErr);
            fe.style.color = 'var(--red)';
            chatLog.appendChild(fe);
            break;
          }
        }
        const finalCheck = verifyScript(working);
        customEditor.value = working; localStorage.setItem(CUSTOM_SOURCE_KEY, working);
        mem.lastScript = working;
        mem.errors = finalCheck.ok ? [] : finalCheck.errors.slice(0, 10);
        saveMem(mem);
        if (finalCheck.ok) {
          chatStatus.textContent = `✓ Script verified${round > 0 ? ` after ${round} self-fix round${round > 1 ? 's' : ''}` : ''} — Test on chart or Save`;
        } else {
          chatStatus.textContent = `⚠ ${mem.errors.length} issue(s) remain after ${MAX_FIX_ROUNDS} self-fix rounds — errors are in memory; ask the editor to fix them`;
        }
        showGeneratedScriptDialog(working);
      }
      // Record this exchange (condensed) for the next turn.
      mem.history.push({ role: 'user', text: prompt.slice(0, 300) });
      mem.history.push({ role: 'editor', text: ans.slice(0, 300) });
      saveMem(mem);
      chatLog.scrollTop=chatLog.scrollHeight;
    } catch (e:any) { const er=document.createElement('div'); er.textContent='Error: '+(e?.message||e); er.style.color='var(--red)'; chatLog.appendChild(er); }
    chatSend.textContent='Ask Editor'; (chatSend as HTMLButtonElement).disabled=false;
  }
  chatSend.addEventListener('click', sendChat);

  // Code page elements
  const listEl = document.createElement('div'); listEl.className='script-list';
  const customEditor = document.createElement('textarea'); customEditor.id='custom-editor'; customEditor.spellcheck=false; customEditor.placeholder='// OakScript code…';
  customEditor.style.width='100%'; customEditor.style.minHeight='160px'; customEditor.style.display='none';
  const editorBar = document.createElement('div'); editorBar.className='editor-bar'; editorBar.style.display='none';
  const runBtn = document.createElement('button'); runBtn.className='editor-run'; runBtn.textContent='Test on Chart';
  const saveBtn = document.createElement('button'); saveBtn.className='editor-run'; saveBtn.textContent='Save Signal'; saveBtn.style.background='var(--green)'; saveBtn.style.color='var(--bg)'; saveBtn.style.borderColor='var(--green)';
  const delBtn = document.createElement('button'); delBtn.className='editor-clear'; delBtn.textContent='Delete';
  const signalToggle = document.createElement('button'); signalToggle.className='toggle-wide'; signalToggle.textContent='Signals: Indicator';
  let signalAsStrategy = localStorage.getItem(SIGNAL_MODE_KEY)==='strategy';
  function syncSignalToggle(){ signalToggle.textContent = signalAsStrategy ? 'Signals: Strategy' : 'Signals: Indicator'; signalToggle.classList.toggle('on', signalAsStrategy); }
  syncSignalToggle();
  signalToggle.addEventListener('click', ()=>{ signalAsStrategy=!signalAsStrategy; localStorage.setItem(SIGNAL_MODE_KEY, signalAsStrategy?'strategy':'indicator'); syncSignalToggle(); });
  editorBar.appendChild(runBtn); editorBar.appendChild(saveBtn); editorBar.appendChild(delBtn); editorBar.appendChild(signalToggle);
  const status = document.createElement('div'); status.id='editor-status';

  // Backtest / Optimizer page
  const btBox = document.createElement('div'); btBox.className='trade-card'; btBox.style.display='none';
  const btTitle = document.createElement('div'); btTitle.className='trade-card-title'; btTitle.textContent='Backtest & Optimizer';
  const engineSel = document.createElement('select'); engineSel.style.width='100%';
  const btSymbol = document.createElement('input'); btSymbol.type='text'; btSymbol.placeholder='Symbol (default current)'; btSymbol.value=state.symbol;
  const btTf = document.createElement('select'); (['1m','5m','15m','1h','4h','1d'] as const).forEach(v=>{const o=document.createElement('option'); o.value=v; o.textContent=v; if(v===state.timeframe) o.selected=true; btTf.appendChild(o);});
  const btBars = document.createElement('input'); btBars.type='number'; btBars.value='500'; btBars.placeholder='Bars';
  const focSel = document.createElement('select'); [['netPnl','Net P&L'],['winRate','Win Rate'],['profitFactor','Profit Factor'],['expectancy','Expectancy']] .forEach(([v,l])=>{const o=document.createElement('option'); o.value=v; o.textContent=l; focSel.appendChild(o);});
  const runBtBtn = document.createElement('button'); runBtBtn.className='editor-run'; runBtBtn.textContent='Run Backtest';
  const runOptBtn = document.createElement('button'); runOptBtn.className='editor-run'; runOptBtn.textContent='Run Optimizer';
  const btInputs = document.createElement('div'); btInputs.style.fontSize='11px';
  const saveSettingsBtn = document.createElement('button'); saveSettingsBtn.className='editor-run'; saveSettingsBtn.textContent='Save Script Settings'; saveSettingsBtn.style.display='none';
  const btResult = document.createElement('div'); btResult.style.fontSize='11px'; btResult.style.whiteSpace='pre-wrap';
  btBox.appendChild(btTitle);
  btBox.appendChild(Object.assign(document.createElement('div'),{textContent:'Signal Engine',style:'font-size:10px;opacity:0.6'})); btBox.appendChild(engineSel);
  btBox.appendChild(Object.assign(document.createElement('div'),{textContent:'Backtest Inputs',style:'font-size:10px;opacity:0.6;margin-top:6px'}));
  const btRow1=document.createElement('div'); btRow1.style.display='flex'; btRow1.style.gap='6px'; btRow1.appendChild(btSymbol); btRow1.appendChild(btTf); btRow1.appendChild(btBars); btBox.appendChild(btRow1);
  const btRow2=document.createElement('div'); btRow2.style.display='flex'; btRow2.style.gap='6px'; btRow2.appendChild(focSel); btRow2.appendChild(runBtBtn); btRow2.appendChild(runOptBtn); btBox.appendChild(btRow2);
  btBox.appendChild(btInputs); btBox.appendChild(saveSettingsBtn); btBox.appendChild(btResult);

  container.appendChild(pageSel); container.appendChild(docsBtn); container.appendChild(chatBox); container.appendChild(reopenBtn);
  container.appendChild(listEl); container.appendChild(customEditor); container.appendChild(editorBar); container.appendChild(status);
  container.appendChild(btBox);

  function refreshEngineList(){
    engineSel.replaceChildren();
    const defs = getIndicators();
    // All available indicators (library) + saved enabled customs
    for (const d of defs) {
      const o=document.createElement('option'); o.value='lib:'+d.name; o.textContent=d.name + ' — ' + d.category; (o as any).dataset.source=d.source; engineSel.appendChild(o);
    }
    const saved = state.indicators.filter(i=>i.enabled);
    for (const s of saved){ const o=document.createElement('option'); o.value=s.id; o.textContent='★ '+s.name + ' (saved)'; engineSel.appendChild(o); }
    if (saved.length===0 && customEditor.value.trim()) { const o=document.createElement('option'); o.value='__custom'; o.textContent='Custom Editor (unsaved)'; engineSel.appendChild(o); }
    // Default select first saved if any
    if (saved.length>0) engineSel.value=saved[0].id;
  }

  function buildPresets(){
    listEl.replaceChildren();
    const defs = getIndicators();
    const cats = new Map<string, typeof defs>();
    for (const d of defs){ if(!cats.has(d.category)) cats.set(d.category, []); cats.get(d.category)!.push(d); }
    for (const [cat, items] of cats){
      const title=document.createElement('div'); title.className='sheet-section-title'; title.textContent=cat; listEl.appendChild(title);
      for (const item of items){
        const card=document.createElement('div'); card.className='script-card';
        const info=document.createElement('div'); info.className='sc-info';
        const name=document.createElement('div'); name.className='sc-name'; name.textContent=item.name;
        const desc=document.createElement('div'); desc.className='sc-desc'; desc.textContent=item.description;
        info.appendChild(name); info.appendChild(desc);
        const curExisting=state.indicators.find(i=>i.name===item.name);
        const toggle=document.createElement('button'); toggle.className='toggle'+(curExisting?.enabled?' on':'');
        toggle.addEventListener('click',()=>{
          const existingNow=state.indicators.find(i=>i.name===item.name);
          if(existingNow){
            existingNow.enabled=!existingNow.enabled;
            toggle.classList.toggle('on', existingNow.enabled);
            if(existingNow.enabled) runIndicator(existingNow);
            else { existingNow.plots=[]; existingNow.errors=[]; }
            status.textContent=existingNow.enabled? `✓ ${item.name} plotted` : `${item.name} hidden`;
            status.className=existingNow.enabled?'':'';
          } else {
            const ind={ id:`ind-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name:item.name, source:item.source, enabled:true, plots:[], errors:[]} as ActiveIndicator;
            state.indicators.push(ind); runIndicator(ind); toggle.classList.add('on');
            status.textContent=`✓ ${item.name} plotted`; status.className='';
          }
          persistSettings(); refreshEngineList();
          // Force chart redraw to clear stale plots
          try{ (window as any).__dafeChartRefresh?.(); }catch{}
        });
        card.appendChild(info); card.appendChild(toggle); listEl.appendChild(card);
      }
    }
  }

  function runIndicator(ind: ActiveIndicator){
    try{
      const v=validate(ind.source); if(!v.valid){ ind.errors=formatValidationIssues(v.issues).split('\n'); status.textContent=`Validation: ${ind.errors[0]}`; status.className='error'; pushIndicatorErrors(ind); return; }
      const program=parse(ind.source); const result=executeScript(program, barsToRuntimeBarData(state.bars), new Map()); ind.plots=result.plots; ind.errors=result.errors;
      status.textContent=result.errors.length? `Ran with ${result.errors.length} warning(s)`: `✓ ${ind.name} on chart`; status.className=result.errors.length?'error':'';
      pushIndicatorErrors(ind);
    }catch(err){ ind.errors=[err instanceof Error?err.message:String(err)]; status.textContent=`Failed: ${ind.errors[0]}`; status.className='error'; pushIndicatorErrors(ind); }
  }

  // Feed an indicator's errors back to the editor chat so the agent sees them.
  function pushIndicatorErrors(ind: ActiveIndicator): void {
    if (!ind.errors || ind.errors.length === 0) return;
    const push = (window as any).__dafeEditorChat;
    if (typeof push === 'function') {
      push('error', `[${ind.name}] ` + ind.errors.join(' | ').slice(0, 600));
    }
  }

  // Local verification for the editor's autonomous fix loop — the SAME
  // pipeline the chart uses (validate → parse → execute on real bars), so
  // "verified" here means "will actually run on the chart".
  function verifyScript(source: string): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    try {
      const v = validate(source);
      if (!v.valid) errors.push(...formatValidationIssues(v.issues).split('\n').filter(Boolean));
      const program = parse(source);
      const result = executeScript(program, barsToRuntimeBarData(state.bars), new Map());
      if (result.errors && result.errors.length > 0) errors.push(...result.errors);
      const hasPlots = result.plots.some((p: any) => p.type === 'line' || p.type === 'shape' || p.type === 'hline' || p.type === 'plot3d' || p.type === 'plot3d_shape');
      if (!hasPlots) errors.push('No visible plots produced — every script must call plot()/plotshape()/hline()/plot3d()');
    } catch (e: any) {
      errors.push(String(e?.message || e));
    }
    return { ok: errors.length === 0, errors: errors.slice(0, 12) };
  }

  function runCustom(){
    const source=customEditor.value; localStorage.setItem(CUSTOM_SOURCE_KEY, source);
    let ind=state.indicators.find(i=>i.id==='custom');
    if(!ind){ ind={ id:'custom', name:'Custom Script', source, enabled:true, plots:[], errors:[]} as ActiveIndicator; state.indicators.push(ind); }
    else { ind.source=source; ind.enabled=true; }
    runIndicator(ind); persistSettings(); refreshEngineList();
    setRunLive(ind.errors.length === 0);
  }

  // "Test on Chart" glows green when the custom script is live on the chart.
  function setRunLive(on: boolean): void {
    if (on) {
      runBtn.style.background = 'var(--green)';
      runBtn.style.color = 'var(--bg)';
      runBtn.style.borderColor = 'var(--green)';
      runBtn.textContent = '● Live on Chart';
    } else {
      runBtn.style.background = '';
      runBtn.style.color = '';
      runBtn.style.borderColor = '';
      runBtn.textContent = 'Test on Chart';
    }
  }

  runBtn.addEventListener('click', runCustom);
  saveBtn.addEventListener('click', ()=>{
    const source=customEditor.value; if(!source.trim()){ status.textContent='Nothing to save'; return; }
    const name=`Signal ${new Date().toLocaleTimeString()}`;
    const ind={ id:`sig-${Date.now()}`, name, source, enabled:true, plots:[], errors:[]} as ActiveIndicator;
    state.indicators.push(ind); runIndicator(ind); persistSettings(); refreshEngineList(); status.textContent=`✓ Saved ${name} to inventory`;
    // ── SNAPSHOT-ON-SAVE: distill the session into durable memory, then
    // wipe the volatile conversation. The user can return to this signal
    // later with full context of WHAT it is and WHY, without the agent
    // dragging stale back-and-forth from this build session around.
    try {
      const KB_KEY = 'dafe_editor_kb';
      const kb = JSON.parse(localStorage.getItem(KB_KEY) || '[]');
      const userAsks = mem.history.filter(h => h.role === 'user').map(h => h.text);
      kb.push({
        savedAt: Date.now(),
        name,
        script: source.slice(0, 4000),
        request: userAsks[0] || '',
        iterations: mem.history.filter(h => h.role === 'editor').length,
        fixesApplied: mem.errors.length === 0 ? 'verified-clean-at-save' : `${mem.errors.length} open issues at save`,
      });
      localStorage.setItem(KB_KEY, JSON.stringify(kb.slice(-30)));
    } catch {}
    mem.history = [];   // conversation wiped — distilled essence persists
    mem.errors = [];    // a saved signal is the user's accepted endpoint
    saveMem(mem);
    chatLog.replaceChildren();
    const wiped = document.createElement('div');
    wiped.textContent = 'Editor: session snapshot saved to memory — conversation cleared.';
    wiped.style.color = 'var(--cyan)';
    chatLog.appendChild(wiped);
  });
  delBtn.addEventListener('click', ()=>{
    if(!confirm('Delete this Signal Generator from inventory?')) return;
    const idx=state.indicators.findIndex(i=>i.id==='custom'); if(idx>=0){ state.indicators.splice(idx,1); persistSettings(); status.textContent='Deleted'; refreshEngineList(); }
    customEditor.value=''; localStorage.removeItem(CUSTOM_SOURCE_KEY);
  });

  // ── Generated script dialog (closable) ───────────────────────────
  function showGeneratedScriptDialog(code: string): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const panel = document.createElement('div');
    panel.className = 'modal gen-script-modal';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    const title = document.createElement('div');
    title.textContent = '✓ Script ready';
    title.style.cssText = 'font-size:14px;font-weight:800;color:var(--green);';
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'background:var(--bg-raised);border:1px solid var(--border);color:var(--text);width:32px;height:32px;border-radius:8px;font-size:18px;cursor:pointer;';
    close.addEventListener('click', () => backdrop.remove());
    head.appendChild(title); head.appendChild(close);

    const preview = document.createElement('pre');
    preview.textContent = code.slice(0, 1200) + (code.length > 1200 ? '\n…' : '');
    preview.style.cssText = 'max-height:200px;overflow:auto;font-size:10px;font-family:monospace;white-space:pre-wrap;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text-dim);';

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
    const testBtn = document.createElement('button');
    testBtn.className = 'editor-run';
    testBtn.textContent = 'Test on Chart';
    testBtn.style.background = 'var(--green)'; testBtn.style.color = 'var(--bg)'; testBtn.style.borderColor = 'var(--green)'; testBtn.style.flex = '1';
    testBtn.addEventListener('click', () => { backdrop.remove(); runCustom(); });
    const laterBtn = document.createElement('button');
    laterBtn.className = 'btn-ghost';
    laterBtn.textContent = 'Later';
    laterBtn.style.flex = '1';
    laterBtn.addEventListener('click', () => backdrop.remove());
    btns.appendChild(testBtn); btns.appendChild(laterBtn);

    panel.appendChild(head); panel.appendChild(preview); panel.appendChild(btns);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  }

  // Backtest / Optimizer logic
  // Real DSL signature is input(default, "title", min, max, step) — the title
  // is the SECOND arg, not the first. The old code matched input("title"...),
  // so it found zero inputs and every optimizer combo was identical.
  function parseInputDefs(source: string): { title: string; def: string; isBool: boolean }[] {
    const out: { title: string; def: string; isBool: boolean }[] = [];
    const re = /input\s*\(\s*([^,\s][^,]*?)\s*,\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const def = m[1].trim();
      out.push({ title: m[2], def, isBool: /^(true|false)$/i.test(def) });
    }
    return out;
  }

  async function resolveBacktestBars(sym: string, tf: string, n: number) {
    const sameChart = sym.toUpperCase() === state.symbol.toUpperCase() && tf === state.timeframe && state.bars.length >= n;
    if (sameChart) return barsToRuntimeBarData(state.bars.slice(-n));
    let bars: BaseBar[] | null = null;
    if (state.massiveApiKey?.trim()) { try { bars = await fetchMassiveBars(sym, tf as Timeframe); } catch { bars = null; } }
    if (!bars || bars.length === 0) { try { bars = await fetchYahooBars(sym, tf as Timeframe); } catch { bars = null; } }
    if (!bars || bars.length === 0) bars = generateBars(n, tf as Timeframe, sym);
    return barsToRuntimeBarData(bars.slice(-n));
  }

  function collectInputs(): Record<string, number>{
    const out: Record<string, number>={};
    for (const el of Array.from(btInputs.querySelectorAll('input'))) {
      const k=(el as HTMLInputElement).dataset.key; if(k) out[k]=parseFloat((el as HTMLInputElement).value);
    }
    return out;
  }
  function renderInputsForSource(source: string){
    btInputs.replaceChildren(); saveSettingsBtn.style.display='none';
    const defs = parseInputDefs(source);
    if(defs.length===0){ btInputs.textContent='No tunable inputs detected — optimizer will run baseline only.'; return; }
    for(const d of defs){
      const row=document.createElement('div'); row.style.display='flex'; row.style.gap='6px'; row.style.alignItems='center';
      const lab=document.createElement('span'); lab.textContent=d.title; lab.style.minWidth='90px';
      const inp=document.createElement('input'); inp.type='number'; inp.dataset.key=d.title;
      if(d.isBool){ inp.type='checkbox'; inp.checked = d.def==='true'; inp.dataset.key=d.title; }
      else { inp.type='number'; inp.step='any'; inp.value = String(d.def.replace(/["']/g,'')|| '0'); }
      inp.style.flex='1';
      inp.addEventListener('input', ()=>{ saveSettingsBtn.style.display=''; });
      row.appendChild(lab); row.appendChild(inp); btInputs.appendChild(row);
    }
    saveSettingsBtn.style.display='';
  }
  pageSel.addEventListener('change', ()=>{
    page=pageSel.value as any;
    const isCode=page==='code';
    listEl.style.display=isCode?'':'none';
    customEditor.style.display=isCode?'':'none';
    editorBar.style.display=isCode?'':'none';
    btBox.style.display=isCode?'none':'';
    if(!isCode){ refreshEngineList(); renderInputsForSource(customEditor.value || state.indicators.find(i=>i.id===engineSel.value)?.source || ''); }
  });
  engineSel.addEventListener('change', ()=>{
    let src = state.indicators.find(i=>i.id===engineSel.value)?.source || customEditor.value;
    if (engineSel.value.startsWith('lib:')) {
      const name = engineSel.value.slice(4);
      const def = getIndicators().find(d=>d.name===name);
      src = def?.source || src;
    }
    renderInputsForSource(src || '');
  });
  saveSettingsBtn.addEventListener('click', ()=>{
    const overrides=collectInputs();
    (state.indicators.find(i=>i.id===engineSel.value) as any).inputOverrides=overrides; persistSettings();
    status.textContent=`✓ Saved settings: ${JSON.stringify(overrides)}`; status.className='';
  });

  function resolveEngine(): { src: string; overrides: Map<string, number> } | null {
    let src = state.indicators.find(i=>i.id===engineSel.value)?.source || customEditor.value;
    if (engineSel.value.startsWith('lib:')) {
      const def = getIndicators().find(d=>d.name===engineSel.value.slice(4));
      src = def?.source || src;
    }
    if(!src){ btResult.textContent='No engine selected — pick a saved Signal Engine'; return null; }
    const overrides = new Map<string, number>();
    for (const [k,v] of Object.entries(collectInputs())) overrides.set(k, v);
    return { src, overrides };
  }

  function summarizeResult(res: any, sym: string, tf: string): string {
    const trades = res.trades || [];
    const inS = res.inSample; const outS = res.outOfSample;
    if (inS && outS) {
      const net = inS.netPnL + outS.netPnL;
      return `${sym} ${tf}: ${trades.length} trades · net $${net.toFixed(2)} · in-sample $${inS.netPnL.toFixed(2)} / OOS $${outS.netPnL.toFixed(2)}`;
    }
    const net = trades.reduce((a:any,t:any)=>a+(t.pnl||0),0);
    return `${sym} ${tf}: ${trades.length} trades · net $${net.toFixed(2)}`;
  }

  runBtBtn.addEventListener('click', async ()=>{
    const engine = resolveEngine(); if(!engine) return;
    const sym=(btSymbol.value||state.symbol).toUpperCase(); const tf=btTf.value as any; const barsN=parseInt(btBars.value,10)||500;
    btResult.textContent='Running backtest...';
    try{
      const barsData = await resolveBacktestBars(sym, tf, barsN);
      const cfg: any = {
        symbol: sym, timeframe: tf, barCount: barsN,
        qtyPerTrade: 1, startingCash: 100000, inSamplePct: 70,
        stopLossMode: 'none', stopLossValue: 0, takeProfitMode: 'none', takeProfitValue: 0,
        signalSource: 'auto', entryMatch: 'buy|long|bull', exitMatch: 'sell|short|bear|close',
      };
      const res: any = await runBacktestOnBars(cfg, engine.src, barsData as any, { inputOverrides: engine.overrides.size ? engine.overrides : undefined });
      btResult.textContent = summarizeResult(res, sym, tf);
      if(llmConfig().apiKey || llmConfig().provider==='ollama'){
        const prompt=`Backtest result for ${sym} ${tf}: ${btResult.textContent}. Focus ${focSel.value}. Advise how to tune.`;
        callLLM('You are the optimizer advisor. Give 2-3 specific tuning suggestions.', prompt).then(a=>{
          const d=document.createElement('div'); d.style.color='var(--cyan)'; d.style.marginTop='6px'; d.textContent='Advisor: '+a.slice(0,600); btResult.appendChild(d);
        }).catch(()=>{});
      }
    }catch(e:any){ btResult.textContent='Backtest failed: '+(e?.message||e); }
  });
  runOptBtn.addEventListener('click', async ()=>{
    const engine = resolveEngine(); if(!engine) return;
    const sym=(btSymbol.value||state.symbol).toUpperCase(); const tf=btTf.value as any; const barsN=parseInt(btBars.value,10)||500;
    const inputDefs = parseInputDefs(engine.src);
    const numeric = inputDefs.filter(d=>!d.isBool);
    if(numeric.length===0){ btResult.textContent='No numeric inputs to optimize — add input(14, "Name") to the script.'; return; }
    btResult.textContent='Optimizer: sweeping inputs...';
    const base = Object.fromEntries(numeric.map(d=>[d.title, parseFloat(d.def)||14]));
    // 3 points per input → cartesian product, capped at 30 runs.
    const axes = numeric.map(d=>{ const v=base[d.title]||14; return { key:d.title, vals:[Math.max(1,Math.round(v*0.7)), Math.round(v), Math.round(v*1.3)] }; });
    let combos: Record<string,number>[]=[{}];
    for(const ax of axes){ const next: Record<string,number>[]=[]; for(const c of combos) for(const val of ax.vals) next.push({...c, [ax.key]:val}); combos=next; }
    const focus=focSel.value;
    let best:any=null; let bestScore=-Infinity;
    const runs = combos.slice(0,30);
    for(const combo of runs){
      try{
        const overrides=new Map<string,number>(); for(const [k,v] of Object.entries(combo)) overrides.set(k,v);
        const cfg:any = {
          symbol: sym, timeframe: tf, barCount: barsN,
          qtyPerTrade: 1, startingCash: 100000, inSamplePct: 70,
          stopLossMode:'none', stopLossValue:0, takeProfitMode:'none', takeProfitValue:0,
          signalSource:'auto', entryMatch:'buy|long|bull', exitMatch:'sell|short|bear|close',
        };
        const barsData = await resolveBacktestBars(sym, tf, barsN);
        const res:any = await runBacktestOnBars(cfg, engine.src, barsData as any, { inputOverrides: overrides });
        const trades = res.trades || [];
        const net = res.inSample ? res.inSample.netPnL + res.outOfSample.netPnL : trades.reduce((a:any,t:any)=>a+(t.pnl||0),0);
        const wins = trades.filter((t:any)=>t.pnl>0).length;
        const winR = trades.length? wins/trades.length*100 : 0;
        const grossW = trades.filter((t:any)=>t.pnl>0).reduce((a:any,t:any)=>a+t.pnl,0);
        const grossL = Math.abs(trades.filter((t:any)=>t.pnl<0).reduce((a:any,t:any)=>a+t.pnl,0));
        const pf = grossL>0? grossW/grossL : grossW>0? 99:0;
        const score = focus==='netPnl'? net : focus==='winRate'? winR : focus==='profitFactor'? pf : net/(trades.length||1);
        if(score>bestScore){ bestScore=score; best={ combo, net, pf, trades: trades.length }; }
      }catch{}
    }
    if(best) btResult.textContent=`Optimizer best (${focus}): ${JSON.stringify(best.combo)} → Net $${best.net.toFixed(2)} PF ${best.pf.toFixed(2)} · ${best.trades} trades (${runs.length} runs)`;
    else btResult.textContent='Optimizer found no improvement';
  });

  // Page init
  customEditor.value=localStorage.getItem(CUSTOM_SOURCE_KEY) || `// DAFE — describe what you want in chat, then Test on Chart
sma20 = sma(close, 20)
sma50 = sma(close, 50)
plot(sma20, "SMA 20", "#b48cff")
plot(sma50, "SMA 50", "#00ff88")
plotshape(crossover(sma20,sma50), "Buy", "▲", "#00ff88")
plotshape(crossover(sma50,sma20), "Sell", "▼", "#ff4477")
`;
  buildPresets(); refreshEngineList();

  return { dispose: () => container.replaceChildren() };
}
