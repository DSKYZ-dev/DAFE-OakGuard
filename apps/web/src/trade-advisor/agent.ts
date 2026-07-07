import type { ChartSnapshot } from './visual-adapter';
import { VisualAdapter } from './visual-adapter';
import { LocalMemory, RemoteMemory } from './memory';
import { WebSearch } from './web-search';
import { optimizePrompt, resetBudget, estimateTokens, getModelContextLimit } from './token-optimizer';

// ─── Lean system prompts (fit in 4096 token context) ────────────────

export const TRADE_ADVISOR_PROMPT = `You are the DAFE Trade Advisor — expert trading analyst. You analyze OHLCV charts, identify patterns (S/R, trend lines, candlestick patterns, divergences), evaluate risk/reward, and research markets. Be concise, data-driven, reference specific price levels and indicator values. Provide actionable insights with clear rationale.`;

// Dedicated coder persona. Coder requests previously reused the ADVISOR
// prompt above (and the backend appended an advisor identity on top), so the
// code-generation model was never actually told it was a coder — a major
// cause of structurally broken scripts. Keep this in sync with
// AGENT_SYSTEM_PROMPTS["oakscript_coder"] in backend/main.py.
export const OAKSCRIPT_CODER_PROMPT =
  'You are the DAFE OakScript Coder, an expert at the OakScript indicator language. ' +
  'OakScript is NOT PineScript — never use: ta./math./str. namespaces (functions are bare: rsi(), sma(), abs()); ' +
  'input.int/input.float (use input(default, "Title", min?, max?, step?)); named arguments (ALL arguments are positional); ' +
  'indicator()/study()/strategy() declarations (scripts start directly with code); shape.*/location.*/plot.style_* constants; ' +
  'color.red-style constants (colors are quoted hex strings like "#22cc88"); request.security/nz()/na() do not exist. ' +
  'ALWAYS structure every script in this exact order: ' +
  '(1) input() declarations. ' +
  '(2) Indicator calculations — plain assignments (NO var keyword), recomputed every bar: fastMa = ema(close, 9). Every variable must be assigned BEFORE the line that uses it; an undefined name silently reads as 0/false with NO error. ' +
  '(3) Persistent state ONLY: var x = 0.0 with a LITERAL initial value, updated inside logic with :=. CRITICAL: a var initializer runs ONCE on bar 0 and the value persists — `var lvl = highest(high, 20)` FREEZES at the first bar forever. NEVER put calculations, conditions, or series expressions in a var initializer. ' +
  '(4) Signal conditions as plain booleans: buySig = crossover(fastMa, slowMa) and r < 70. ' +
  '(5) Signal markers INSIDE conditionals: if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") } / if sellSig { plotshape(bar_index, high, "Sell", "triangledown", "#ff4477") } — signature plotshape(bar_index, price, title, style, color, pane?), buy markers at low, sell markers at high. ' +
  '(6) Unconditional rendering LAST at top level: plot()/hline()/fill()/plot3d() must NEVER be inside if-blocks or they render nothing (bgcolor is the exception — it may be conditional). ' +
  'DYNAMIC price levels (fibs, pivots, moving S/R) = plot(level, "Title", "#hex", 1, "stepline") so the line follows the level; hline() is ONLY for constants that never change (RSI 70/30) — an hline whose value changes leaves a new permanent line each time. ' +
  'Previous-bar access works via history indexing: close[1], myVar[1]; change(x) = x - x[1]. ' +
  'Output COMPLETE oakscript code inside ```oakscript fences — every line, start to finish, never partial or truncated. ' +
  'When EDITING an existing script, preserve ALL its logic, calculations, variables, loops, and signals; only add or modify what was asked. NEVER simplify, summarize, remove, or rename existing logic. ' +
  'Block syntax: use { } braces around multi-statement bodies under if/else/for/while (single statements may follow without braces) — braces have no indentation requirement and can\'t misparse. Prefer braces for anything beyond a single-line body. ' +
  '== not =. Strings quoted: "#22cc88" not green. MACD: m.macd/m.signal/m.hist. Use input() for params. ' +
  'The engine has a full 3D renderer: plot3d(series, name, style, color, pane, z_level?) with 15 styles: surface/ribbon/scatter/bars3d/wireframe/mesh/line3d/helix/vortex/manifold/nebula/constellation/torus/trail/ridgeline (ridgeline = temporal distribution joyplot: the series is sliced into time windows and each window\'s value histogram stacks in depth — ideal for price/volume profiles over time; needs 24+ bars). z_level (number) stacks multiple plot3d calls at different depths — same value = same Z layer, different values = spaced apart. Omit for auto-spacing. ' +
  'pane="3d" is the flagship mode: an exclusive full-chart takeover where the geometry renders unified WITH the 3D price bars — while active, NO 2D plots or separate-pane 3D render from any indicator, and only one pane="3d" indicator can be active at a time. ' +
  'pane="separate" renders in the lower 3D pane instead (multiple calls stack together there; also exclusive, one at a time). Default/pane="main" is a lighter legacy overlay mode — prefer pane="3d" or pane="separate" explicitly. ' +
  'CRITICAL 3D RULE: When the chart pane is in 3D mode, 2D plot() and plotshape() do NOT render — only plot3d() and plotshape_3d() execute. plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?) places geometric shapes at exact bar/price/Z coordinates. pane="separate" (default) renders in lower 3D pane; pane="3d" renders in the main 3D chart scene alongside the 3D bars. Shapes: cube, sphere, pyramid, torus, diamond, coneup, conedown. Size: 0.2-3.0. STANDARD SIGNAL MARKERS: buy = "coneup" green (#22cc88) at low (auto-offsets BELOW the bar, tip pointing up at it); sell = "conedown" red (#ff4477) at high (flipped upside down, auto-offsets ABOVE the bar, tip pointing down). Derive size from signal strength (e.g. spread/ATR clamped to 0.6-2.2) so cones are proportional to signal quality. rx/ry/rz (optional, DEGREES) rotate any shape on top of its built-in orientation — pose shapes freely for custom scenes. PANE MATCHING: in a pane="3d" script, EVERY plotshape_3d/label3d must pass "3d" as its pane argument — omitting it defaults the marker to the (hidden) separate pane and it renders nowhere. ' +
  'label3d(bar_index, price, text, color?, size?, z_level?, pane?) places a billboard TEXT label at exact 3D coordinates — use it to NAME peaks, levels, zones, and signals ("POC", "Breakout"). Keep text short and use it for RARE, meaningful moments only — never label every signal bar (dense repeats stack into unreadable towers); the cones already mark the signals, a label should call out at most the standout events. ' +
  'Price LEVELS in 3D (fibs, pivots, S/R): use style "line3d" — it draws exact straight segments. NEVER render a level series with "ribbon"/"surface": their spline smoothing turns the steps into spike blades that look nothing like level lines. Give EACH level line a DISTINCT z_level (0, 1, 2, …) so they render as cleanly separated parallel planes — putting multiple level lines on the SAME z_level overlaps them into a twisted rope. ' +
  'MANDATORY: Whenever you use plotshape_3d() or label3d(), you MUST ALSO include at least one plot3d() call (surface/ribbon/bars3d/etc. style, with matching pane) so the 3D scene has actual geometry for context — shapes alone won\'t fill the scene. For pane="separate" use a plot3d("separate"); for pane="3d" use a plot3d("3d"). ' +
  'Give each plot3d call a genuinely DIFFERENT source value — look for other already-computed values in the script (a stdev, a count, a raw vs. smoothed version, a margin) so each 3D layer answers a different question. ' +
  'VISUAL FOCUS (this outranks every other visual instruction): render ONLY what the request needs. Maximum 2-3 plot3d layers per script, and EVERY visual element — each plot3d, plotshape_3d, label3d — must trace directly back to something the user asked for. NO decorative extras, NO bonus derivative layers, NO piling on styles to show off. One excellent, readable visual beats five cluttered ones. A request for "an RSI indicator that signals extremes" needs the RSI and its extreme signals — not velocity, acceleration, jerk, and a vortex. ' +
  'When EDITING an existing script, do NOT add any new visual the user did not ask for in THIS request; when the user asks to remove or simplify visuals, removing them IS the task. ' +
  'When emitting 3D cone signals, expose markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1) and multiply the cone size by it so users can tune marker scale. ' +
  'Before finishing, double-check every variable name against its actual input()/declaration — a typo silently reads as 0/false with no error. ' +
  'SELF-REVIEW BEFORE OUTPUT: Silently verify (1) mathematical accuracy — is every calculation, crossover, threshold, and indicator relationship correct? (2) visual focus — does every plot/shape/label trace back to the user\'s request? Remove anything they didn\'t ask for. If either check fails, fix it before answering. ' +
  'Your goal: the most accurate, focused, and polished version of exactly what the user asked for.';

// Minimal inline reference — fallback if doc search fails.
// The agent should call /api/oak/search for detailed docs.
const OAKSCRIPT_FALLBACK_REF = `OakScript: use { } braces for multi-statement if/else/for/while blocks — no indentation requirement, can't misparse (brace-less indentation blocks also work but every statement must share the exact same column or it silently falls outside the block, which for a while loop can strand the counter update and freeze the page). == not =. Strings quoted. MACD: m.macd/m.signal/m.hist. Fns: sma,ema,wma,hma,rma,vwma,macd,rsi,cci,adx,atr,roc,mom,stoch,mfi,obv,cmf,vwap,stdev,median,crossover,crossunder,highest,lowest,pivothigh,pivotlow,barssince,cum,change,linreg,correlation,trueRange. Math: abs,min,max,floor,ceil,round,sqrt,log,log10,exp,pow,sign,avg,sin,cos,tan. Colors: color.new,color.rgb,color.from_gradient. Input: input(14,"Title"). 2D: plot(val,title,color,lw,style?,pane?). plotshape(bar,price,title,style,color,pane). hline,fill,bgcolor. 3D: plot3d(series,name,style,color,pane,z_level?) z_level=number stacks at Z depth. plotshape_3d(bar_index,price,title,shape,color,size,z_level?,pane?) shapes: cube,sphere,pyramid,torus,diamond. label3d(bar_index,price,text,color?,size?,z_level?,pane?) billboard text label — short text, inside a condition. Styles (15): surface,ribbon,scatter,bars3d,wireframe,mesh,line3d,helix,vortex,manifold,nebula,constellation,torus,trail,ridgeline (temporal distribution joyplot, 24+ bars). pane="3d" = exclusive full-chart takeover unified with the 3D bars (only one active at a time, no 2D/separate content renders alongside it); pane="separate" = lower 3D pane (also exclusive, one at a time); give each plot3d call a genuinely different source value, not the same number under multiple style names. CRITICAL: 2D plot/shape do NOT render in 3D mode — use plot3d/plotshape_3d instead. Pitfalls: a misspelled/undefined variable silently reads as 0/false with no error — double-check names against input() declarations. Use /api/oak/search?q=<query> for details.`;

export interface AgentConfig {
  baseUrl: string;
  model: string;
  agentId: string;
  agentName: string;
  agentIcon: string;
  systemPrompt: string;
}

export type AgentRole = 'trade_advisor' | 'orchestrator' | 'market_intel' | 'strategy_tuner';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentResponse {
  ok: boolean;
  reply: string;
  agent: string;
  model: string;
  searchResults?: any[];
  ts: number;
  thinking?: string;
}

export class TradeAdvisorAgent {
  public config: AgentConfig;
  public localMemory: LocalMemory;
  public remoteMemory: RemoteMemory;
  public webSearch: WebSearch;
  private conversationHistory: ChatMessage[] = [];
  private listeners: Array<(msg: ChatMessage) => void> = [];
  private baseUrl: string;

  constructor(
    config: Partial<AgentConfig> = {},
    baseUrl: string = 'http://localhost:8788',
  ) {
    this.baseUrl = baseUrl;
    this.config = {
      baseUrl,
      model: 'meta-llama-3.1-8b-instruct',
      agentId: 'trade_advisor',
      agentName: 'Trade Advisor',
      agentIcon: '◆',
      systemPrompt: TRADE_ADVISOR_PROMPT,
      ...config,
    };
    this.localMemory = new LocalMemory();
    this.remoteMemory = new RemoteMemory(baseUrl);
    this.webSearch = new WebSearch(baseUrl);
  }

  onMessage(callback: (msg: ChatMessage) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private emit(msg: ChatMessage): void {
    for (const listener of this.listeners) {
      listener(msg);
    }
  }

  async sendMessage(
    text: string,
    chartSnapshot?: ChartSnapshot,
    searchResults?: any[],
    agentOverride?: string,
  ): Promise<AgentResponse> {
    const modelName = this.config.model;
    const ctxChars = getModelContextLimit(modelName) * 2.5;

    this.conversationHistory.push({ role: 'user', content: text });
    this.emit({ role: 'user', content: text });

    // Detect OakScript requests and fetch relevant docs dynamically.
    // This replaces the old static OAKSCRIPT_REFERENCE injection.
    const isOakScriptRequest = agentOverride === 'oakscript_coder'
      || text.includes('[OakScript Expert]')
      || text.includes('indicator')
      || text.includes('OakScript');

    const agentType = agentOverride || this.config.agentId;
    const isCoder = agentType === 'oakscript_coder';

    // The CODER works on SOURCE + docs — it does NOT need the chart snapshot
    // (500 bars of OHLC). Feeding it the chart state ballooned the prompt to
    // ~29k tokens, forcing truncation that cut off the generated code mid-fence
    // (the "buttons do nothing" symptom). Keep its context lean.
    // It also gets its OWN persona: reusing the advisor's system prompt told
    // the model it was a trading analyst, not a code generator.
    let systemPrompt = isCoder
      ? OAKSCRIPT_CODER_PROMPT
      : this.buildSystemPrompt(chartSnapshot, searchResults);
    if (isOakScriptRequest) {
      // The coder needs to be a genuine "resource master" of the language for
      // one-shot generation/edits — 2200 chars was only enough for a few
      // matched function signatures. The advisor's lighter Q&A keeps the
      // smaller budget. The local path's own prompt-fit safety net (backend
      // main.py) still trims this further if the model's real context can't
      // fit it, so this is safe to raise unconditionally.
      const oakDocs = await this.searchOakDocs(text, isCoder ? 4500 : 2200);
      systemPrompt += oakDocs;
    }

    // Build messages array for the optimizer
    const systemMsgs: Array<{ role: string; content: string }> = [];
    if (systemPrompt) systemMsgs.push({ role: 'system', content: systemPrompt });

    // Coder keeps only the last couple of turns (the current request + its source);
    // a long advisor chat history isn't relevant to editing the script.
    const msgCharLimit = Math.max(400, Math.round(ctxChars * 0.06)); // per-message cap ~6% of context
    // The coder's FINAL message embeds the full editor script + edit rules —
    // capping it at 6% chopped the script mid-fence, so the model never saw
    // the code it was told to edit and regurgitated a stale/invented draft
    // (observed: identical truncated replies to different edit requests, then
    // "No code block found"). Give that one message a large budget (~50% of
    // context) and drop OLDER turns to pay for it instead.
    const coderFinalLimit = Math.max(4000, Math.round(ctxChars * 0.5));
    const recentSlice = this.conversationHistory.slice(isCoder ? -2 : -6);
    const recentMsgs = recentSlice.map((m, i) => {
      const cap = isCoder && i === recentSlice.length - 1 ? coderFinalLimit : msgCharLimit;
      return { role: m.role, content: m.content.length > cap ? m.content.slice(0, cap) : m.content };
    });

    // Chart bars are for the advisor only.
    const chartBars = isCoder ? undefined : chartSnapshot?.recentBars?.map(b => ({
      open: b[0], high: b[1], low: b[2], close: b[3], volume: b[4],
    }));

    // Run the full token optimization pipeline
    const optimized = optimizePrompt({
      agentType,
      modelName,
      messages: [...systemMsgs, ...recentMsgs],
      chartBars: chartBars && chartBars.length > 0 ? chartBars : undefined,
      keepRecentMessages: 4,
    });

    try {
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agentType,
          model: modelName,
          messages: optimized.messages,
          message: text,
          system_prompt: systemPrompt,
          max_tokens: optimized.maxTokens,
        }),
      });

      const data = await resp.json();

      if (data.ok) {
        const reply = data.reply || '(empty response)';
        const replyLimit = Math.max(600, Math.round(ctxChars * 0.12));
        this.conversationHistory.push({ role: 'assistant', content: reply.length > replyLimit ? reply.slice(0, replyLimit) : reply });
        this.emit({ role: 'assistant', content: reply });

        try {
          await this.localMemory.store({
            content: `User: ${text}\nAgent: ${reply.slice(0, 500)}`,
            type: 'conversation',
            agent: this.config.agentId,
            tags: ['chat'],
          });
        } catch {}

        return {
          ok: true,
          reply,
          thinking: data.thinking || undefined,
          agent: this.config.agentId,
          model: this.config.model,
          ts: Date.now(),
        };
      } else {
        const errorMsg = data.detail || 'Request failed';
        this.emit({ role: 'assistant', content: `Error: ${errorMsg}` });
        return { ok: false, reply: errorMsg, agent: this.config.agentId, model: this.config.model, ts: Date.now() };
      }
    } catch (err: any) {
      const errorMsg = `Connection error: ${err.message}`;
      this.emit({ role: 'assistant', content: `Error: ${errorMsg}` });
      return { ok: false, reply: errorMsg, agent: this.config.agentId, model: this.config.model, ts: Date.now() };
    }
  }

  private buildSystemPrompt(chartSnapshot?: ChartSnapshot, searchResults?: any[]): string {
    let prompt = this.config.systemPrompt;

    if (chartSnapshot) {
      const adapter = new VisualAdapter();
      const context = adapter.buildChartContext(chartSnapshot, 'auto', this.config.model);
      prompt += `\n\n## Current Chart\n${context}`;
    }

    if (searchResults && searchResults.length > 0) {
      prompt += `\n\n## Web Search Results\n`;
      for (const r of searchResults.slice(0, 5)) {
        prompt += `- ${r.title}\n  ${r.url}\n`;
        if (r.snippet) prompt += `  ${r.snippet}\n`;
      }
    }

    return prompt;
  }

  /** Query the OakScript knowledge base for documentation relevant to the user's request. */
  private async searchOakDocs(query: string, budget = 2200): Promise<string> {
    // Use the budget-bounded retrieval bundle: only the docs relevant to THIS
    // request (function signatures + top sections + one example + syntax rules),
    // packed to a token budget instead of carrying the whole reference.
    try {
      const resp = await fetch(
        `${this.config.baseUrl}/api/oak/retrieve?q=${encodeURIComponent(query)}&budget=${budget}`);
      const data = await resp.json();
      if (data.ok && data.bundle) {
        return `\n\n## Relevant OakScript Documentation\n${data.bundle}`;
      }
    } catch { /* fall through */ }
    return OAKSCRIPT_FALLBACK_REF;
  }

  async autoAnalyze(
    chartSnapshot: ChartSnapshot,
    symbol: string,
  ): Promise<{ analysis: string; searchResults: any[] }> {
    const newsResults = await this.webSearch.searchNews(symbol);
    const earningsResults = await this.webSearch.searchEarnings(symbol);
    const riskResults = await this.webSearch.searchRisks(symbol);
    const allResults = [...newsResults, ...earningsResults, ...riskResults];

    const resp = await this.sendMessage(
      `Analyze ${symbol} based on the current chart data and any available news. Provide a concise market analysis including trend direction, key support/resistance levels, notable patterns, and risk assessment.`,
      chartSnapshot,
      allResults,
    );

    try {
      await this.remoteMemory.store(
        `Auto-analysis for ${symbol}: ${resp.reply.slice(0, 500)}`,
        'decision',
        this.config.agentId,
        [symbol, 'auto-analysis'],
      );
    } catch {}

    return {
      analysis: resp.reply,
      searchResults: allResults,
    };
  }

  async tuneIndicators(
    chartSnapshot: ChartSnapshot,
    indicatorName: string,
    currentParams: Record<string, unknown>,
  ): Promise<{ suggestions: string; params?: Record<string, unknown> }> {
    const context = `Current indicator: ${indicatorName}\nParams: ${JSON.stringify(currentParams, null, 2)}`;

    const resp = await this.sendMessage(
      `Given the current market conditions visible in the chart, suggest optimizations for the ${indicatorName} indicator parameters. Current params: ${JSON.stringify(currentParams)}. Explain your reasoning for each suggested change.`,
      chartSnapshot,
    );

    return {
      suggestions: resp.reply,
    };
  }

  /**
   * Generate a new OakScript indicator from a natural-language description.
   * Returns the agent's response containing the OakScript code block.
   */
  async generateIndicator(
    description: string,
    chartSnapshot?: ChartSnapshot,
  ): Promise<AgentResponse> {
    const prompt = `Generate a complete OakScript indicator: "${description}".\n\nRequirements:\n- Include input() declarations with sensible defaults.\n- Use distinct hex colors (#22cc88, #ff4477, #b48cff, #22aaff, #ffd43b, #ff6b6b).\n- Add plotshape() markers for signals.\n- Use { } braces for multi-statement if/else/for/while blocks — they have no indentation requirement and can't misparse (brace-less indentation blocks also work but every statement in the block must share the exact same column or it silently falls outside the block).\n- MACD: access .macd, .signal, .hist from result.\n- Add 1-3 plot3d() calls that DIRECTLY visualize the requested indicator (choose the style that fits the data: surface, ribbon, bars3d, scatter, wireframe, mesh, line3d, helix, vortex, manifold, nebula, constellation, torus, trail, ridgeline) — pane="3d" for the full-chart 3D takeover, pane="separate" for the lower 3D pane. No decorative extra layers.
- Where a named level or signal matters, add label3d()/plotshape_3d() inside the signal conditions.\n- Output COMPLETE code inside \`\`\`oakscript fences.`;

    return await this.sendMessage(prompt, chartSnapshot, undefined, 'oakscript_coder');
  }

  /**
   * Edit an existing indicator's source code with specific changes.
   * Returns the agent's response with the modified code.
   */
  async editIndicator(
    currentSource: string,
    editDescription: string,
    chartSnapshot?: ChartSnapshot,
  ): Promise<AgentResponse> {
    const prompt = `Here is the current OakScript indicator source code:

\`\`\`oakscript
${currentSource}
\`\`\`

Make the following changes to this indicator:
"${editDescription}"

Rules:
- Output the COMPLETE modified script (not just the changed parts) inside \`\`\`oakscript fences.
- Before the code, briefly explain each change you made and why.
- Preserve ALL existing functionality that is not being changed.
- Ensure the modified code will parse and execute without errors.
- Keep the same indentation style as the original.`;

    return await this.sendMessage(prompt, chartSnapshot, undefined, 'oakscript_coder');
  }

  /**
   * Brainstorm indicator ideas based on current chart conditions.
   * Returns the agent's creative suggestions.
   */
  async brainstormIndicator(
    chartSnapshot: ChartSnapshot,
    focus?: string,
  ): Promise<AgentResponse> {
    const adapter = new VisualAdapter();
    const chartCtx = adapter.buildChartContext(chartSnapshot);
    const indicatorInfo = chartSnapshot.indicators
      .map(i => i.values)
      .filter(Boolean).join(', ');

    const prompt = `Brainstorm 2-3 unique OakScript indicator ideas for ${chartSnapshot.symbol} on the ${chartSnapshot.timeframe} chart (${chartSnapshot.barType}).

Current market:
${chartCtx}
${indicatorInfo ? `Active indicators: ${indicatorInfo}` : 'No active indicators.'}
${focus ? `Focus area: ${focus}` : 'Focus on the most useful indicator for current price action.'}

For each idea, describe:
1. Name & Concept — what it detects and why it's useful
2. Signal Logic — the mathematical/comparison logic in plain terms
3. Visual Style — 2D lines/shapes or 3D surface/ribbon/bars
4. Best Use Case — timeframe/market condition where it shines

Keep each idea to 3-4 sentences. Be creative but practical. The user can ask you to generate the full code for any idea.`;

    return await this.sendMessage(prompt, chartSnapshot, undefined, 'oakscript_coder');
  }

  /**
   * Diagnose errors in an indicator script and suggest fixes.
   * Accepts either a source string with errors or an error list.
   */
  async diagnoseErrors(
    source: string,
    errors: string[],
    chartSnapshot?: ChartSnapshot,
  ): Promise<AgentResponse> {
    const errorList = errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');

    const prompt = `This OakScript indicator has errors that need to be fixed:

SOURCE CODE:
\`\`\`oakscript
${source}
\`\`\`

ERRORS (${errors.length} total):
${errorList}

Diagnose each error:
1. Identify the root cause (syntax, undefined variable, logic, function misuse, etc.)
2. Explain what went wrong in plain language
3. Show the corrected line(s)
4. Output the COMPLETE corrected script inside \`\`\`oakscript fences

Important: Fix ALL errors. The corrected code must parse and execute without any errors. Check:
- if/else/for/while blocks: prefer { } braces for any block with more than
  one statement or with nesting — they have no indentation requirement and
  cannot misparse. If using brace-less indentation style, every statement in
  that block must share the exact same column, or later statements (e.g. a
  loop counter update) silently fall outside the block — for a while loop
  this can leave the counter never updated, causing an infinite loop.
- Variable names — are they declared before use? var/varip for persistent state?
- Function signatures — are parameters correct? (sma(source, length), rsi(source, length), etc.)
- MACD access — use m.macd, m.signal, m.hist from the result object
- Plot call syntax — plot(value, title, color, linewidth, pane?)
- Equality/comparison operators — use == not = for comparison`;

    return await this.sendMessage(prompt, chartSnapshot, undefined, 'oakscript_coder');
  }

  /**
   * Analyze indicator output metrics and suggest performance improvements.
   */
  async analyzeMetrics(
    indicatorName: string,
    indicatorValues: Array<{ name: string; value: number; color: string }>,
    chartSnapshot: ChartSnapshot,
  ): Promise<AgentResponse> {
    const valuesText = indicatorValues
      .slice(0, 10)
      .map(v => `${v.name}=${v.value.toFixed(2)}`)
      .join(', ');

    const prompt = `Analyze ${indicatorName} on ${chartSnapshot.symbol} ${chartSnapshot.timeframe} @ ${chartSnapshot.stats.lastClose.toFixed(2)}. Values: ${valuesText}. Concisely: are values normal? Parameters need tuning? Issues? Complementing indicators? Be brief.`;

    return await this.sendMessage(prompt, chartSnapshot, undefined, 'oakscript_coder');
  }

  // ─── Section-by-Section Indicator Generation ──────────────────────

  /**
   * Generate an indicator in phases to stay within model context limits.
   * Phase 1: Concept → Phase 2: Code skeleton → Phase 3: Plot & polish.
   * Each phase builds on the prior, stored in short-term code memory.
   */
  async generateIndicatorPhased(
    description: string,
    chartSnapshot?: ChartSnapshot,
    onPhase?: (phase: number, result: string) => void,
  ): Promise<{ finalCode: string; phases: string[] }> {
    const phases: string[] = [];
    let accumulatedCode = '';
    let accumulatedLogic = '';

    // ── Phase 1: Concept & Algorithm Design ──
    const phase1Prompt = `Design a technical indicator based on this description:

"${description}"

Respond with ONLY the algorithm design (no code yet):
1. Indicator Name (short, descriptive)
2. Input Parameters (list each with default value and description)
3. Calculation Logic (step-by-step, plain math)
4. Signal Rules (when to trigger buy/sell/alert)
5. Visual Plan (what to plot and how — lines, colors, shapes, 3D?)

Keep it concise. The next phase will generate the actual code from this design.`;

    const r1 = await this.sendMessage(phase1Prompt, chartSnapshot);
    phases.push(r1.reply);
    accumulatedLogic = r1.reply;
    onPhase?.(1, r1.reply);

    // Store design in memory for context
    try {
      await this.localMemory.store({
        content: `Indicator Design Phase 1: ${r1.reply.slice(0, 1000)}`,
        type: 'note',
        agent: this.config.agentId,
        tags: ['indicator-design', 'phase1'],
      });
    } catch {}

    // ── Phase 2: Code Generation from Design ──
    const phase2Prompt = `Based on this indicator design, generate the COMPLETE OakScript code:

DESIGN:
${accumulatedLogic}

Write the code following these rules:
- Use { } braces for any if/else/for/while block with more than one
  statement or with nesting — they have no indentation requirement and
  cannot misparse. Brace-less indentation style is fine for a single-line
  body, but every statement in such a block must share the exact same
  column or it silently falls outside the block.
- Declare all parameters with input().
- Compute indicators using the standard library functions (sma, ema, rsi, macd, etc.).
- Use plot() for lines, hline() for reference lines, plotshape() for signal markers.
- Use distinct hex colors: sma=#22cc88, ema=#ff4477, signals=#22cc88/#ff4477, reference=#ff4477/#22cc88.
- Add brief // comments for each logical section.
- Output ONLY the code inside \`\`\`oakscript fences. No explanation needed.`;

    const r2 = await this.sendMessage(phase2Prompt, chartSnapshot);
    phases.push(r2.reply);

    // Extract code block
    const codeMatch = r2.reply.match(/```(?:oakscript)?\s*\n([\s\S]*?)```/);
    accumulatedCode = codeMatch ? codeMatch[1].trim() : '';
    onPhase?.(2, r2.reply);

    // Store code in memory
    try {
      await this.localMemory.store({
        content: `Indicator Code Phase 2:\n\`\`\`oakscript\n${accumulatedCode.slice(0, 2000)}\n\`\`\``,
        type: 'note',
        agent: this.config.agentId,
        tags: ['indicator-code', 'phase2'],
      });
    } catch {}

    // ── Phase 3: Validation & Self-Correction ──
    if (accumulatedCode) {
      const phase3Prompt = `Review and validate this OakScript code. Fix ANY issues you find:

\`\`\`oakscript
${accumulatedCode}
\`\`\`

Self-check:
1. Does every if/else/for/while block with more than one statement (or any
   nesting) use { } braces? Brace-less indentation blocks require every
   statement to share the exact same column — if any line in such a block
   is misaligned, it silently falls outside the block, which for a while
   loop can strand the counter update and cause an infinite loop.
2. Are all variables declared before use?
3. Do all function calls have the correct number of arguments? (sma(source,length) not sma(source,length,offset))
4. Are == and != used for comparisons (not =)?
5. Is MACD accessed as m.macd, m.signal, m.hist?
6. Are plotshape styles valid? (triangleup, triangledown, circle, cross, etc.)
7. Will this compile and run without errors?

Output the FINAL corrected code inside \`\`\`oakscript fences. Before the code, list any fixes you applied.`;

      const r3 = await this.sendMessage(phase3Prompt, chartSnapshot);
      phases.push(r3.reply);
      onPhase?.(3, r3.reply);

      // Use corrected code if available, otherwise keep phase 2 code
      const fixedMatch = r3.reply.match(/```(?:oakscript)?\s*\n([\s\S]*?)```/);
      if (fixedMatch && fixedMatch[1].trim().length > 10) {
        accumulatedCode = fixedMatch[1].trim();
      }

      // Store final code in memory
      try {
        await this.localMemory.store({
          content: `Final Indicator:\n\`\`\`oakscript\n${accumulatedCode.slice(0, 3000)}\n\`\`\``,
          type: 'note',
          agent: this.config.agentId,
          tags: ['indicator-final', description.split(' ').slice(0, 3).join('-').toLowerCase()],
        });
      } catch {}
    }

    return { finalCode: accumulatedCode, phases };
  }

  /**
   * Validate code and iterate with the agent until all issues are resolved.
   * Feeds validation results back to the LLM for self-correction.
   */
  async validateAndIterate(
    code: string,
    maxIterations: number = 3,
    chartSnapshot?: ChartSnapshot,
    onIteration?: (iteration: number, issues: string[], fixed: string) => void,
    originalRequest?: string,
  ): Promise<{ valid: boolean; finalCode: string; iterations: number }> {
    let currentCode = code;
    let iterations = 0;

    for (let i = 0; i < maxIterations; i++) {
      iterations = i + 1;

      // Run the validator
      let issues: string[];
      try {
        // Dynamic import to avoid circular deps
        const { validate, formatValidationIssues } = await import('../oakscript/validator');
        const result = validate(currentCode);
        if (result.valid) {
          onIteration?.(iterations, [], currentCode);
          return { valid: true, finalCode: currentCode, iterations };
        }
        // Include the line number and the targeted fix, not just the message —
        // the fix text is what lets the model correct Pine idioms / undefined
        // vars in ONE iteration instead of guessing.
        issues = result.issues.map(is =>
          `L${is.line} [${is.code}] ${is.message}${is.fix ? ` FIX: ${is.fix}` : ''}`);
      } catch {
        // If validator itself fails, try parse directly
        try {
          const { parse } = await import('../oakscript/parser');
          parse(currentCode);
          return { valid: true, finalCode: currentCode, iterations };
        } catch (e: any) {
          issues = [e.message || 'Unknown parse error'];
        }
      }

      onIteration?.(iterations, issues, '');

      // Ask the agent to fix. Re-state the ORIGINAL request every iteration —
      // without it, once this loop starts the model only ever sees "here's
      // some code, here are lint errors, fix them" with no idea what the
      // code was supposed to accomplish. Observed failure mode: a user asks
      // for a Fibonacci-levels-with-rejection-signals indicator, the model's
      // first draft comes out wrong (e.g. an unrelated oscillator), and
      // every subsequent "fix" iteration just patches syntax on that wrong
      // draft forever because the original intent was never repeated.
      const fixPrompt = `${originalRequest ? `ORIGINAL REQUEST (what this script is supposed to do): "${originalRequest}"\n\n` : ''}The following OakScript code has validation issues. Fix ALL of them AND make sure the code actually satisfies the original request above — output the corrected code.

CODE:
\`\`\`oakscript
${currentCode}
\`\`\`

ISSUES:
${issues.map((s, idx) => `  ${idx + 1}. ${s}`).join('\n')}

Rules:
- Fix every issue listed above.
- If the code doesn't actually implement the original request, fix that too — don't just patch syntax on the wrong indicator.
- Output ONLY the complete corrected code inside \`\`\`oakscript fences.
- No explanation — just the fixed code.`;

      const resp = await this.sendMessage(fixPrompt, chartSnapshot);
      const codeMatch = resp.reply.match(/```(?:oakscript)?\s*\n([\s\S]*?)```/);
      if (codeMatch && codeMatch[1].trim().length > 10) {
        currentCode = codeMatch[1].trim();
        onIteration?.(iterations, issues, currentCode);
      } else {
        // Agent didn't produce code — try to extract anyway
        break;
      }
    }

    // Final check
    try {
      const { validate } = await import('../oakscript/validator');
      const finalResult = validate(currentCode);
      return { valid: finalResult.valid, finalCode: currentCode, iterations };
    } catch {
      return { valid: false, finalCode: currentCode, iterations };
    }
  }

  // ─── Memory-based User Preferences ────────────────────────────────

  /**
   * Store a user preference in persistent memory for cross-session recall.
   */
  async storeUserPreference(key: string, value: string): Promise<void> {
    try {
      await this.localMemory.store({
        content: `PREF:${key}=${value}`,
        type: 'note',
        agent: this.config.agentId,
        tags: ['user-preference', key],
      });
    } catch {}
  }

  /**
   * Recall user preferences from memory. Returns map of pref key → value.
   */
  async recallUserPreferences(): Promise<Map<string, string>> {
    const prefs = new Map<string, string>();
    try {
      const entries = await this.localMemory.recall('user-preference');
      for (const entry of entries) {
        const match = entry.content.match(/^PREF:(\w+)=(.+)$/m);
        if (match) {
          prefs.set(match[1], match[2]);
        }
      }
    } catch {}
    return prefs;
  }

  /**
   * Store a completed code section for later reference during multi-step generation.
   */
  async storeCodeSection(section: string, code: string, phase: number): Promise<void> {
    try {
      await this.localMemory.store({
        content: `CODE_SECTION:${section}:phase${phase}\n\`\`\`oakscript\n${code.slice(0, 3000)}\n\`\`\``,
        type: 'note',
        agent: this.config.agentId,
        tags: ['code-section', section, `phase${phase}`],
      });
    } catch {}
  }

  /**
   * Build a prompt suffix with user preferences for personalized code generation.
   */
  async buildUserContext(): Promise<string> {
    const prefs = await this.recallUserPreferences();
    if (prefs.size === 0) return '';

    const lines: string[] = ['\n## User Preferences (from memory)'];
    for (const [k, v] of prefs) {
      lines.push(`- ${k}: ${v}`);
    }
    lines.push('Incorporate these preferences into your work when applicable.');
    return lines.join('\n');
  }

  /**
   * Compress conversation history older than the last 4 exchanges into a
   * single-line summary. Keeps context while staying under token limits.
   */
  private buildConversationSummary(): string {
    const history = this.conversationHistory;
    if (history.length <= 6) return ''; // Not enough to need compression

    const older = history.slice(0, -4);
    const parts: string[] = [];

    // Extract key facts: what indicator, what errors, what fixes, any preferences
    const indicatorMatch = older.map(m => m.content).join(' ').match(/indicator[:\s]+(\w[\w\s-]+)/i);
    if (indicatorMatch) parts.push(`Working on: ${indicatorMatch[1].trim().slice(0, 60)}`);

    const errorCount = older.filter(m => m.content.includes('Error') || m.content.includes('error')).length;
    if (errorCount > 0) parts.push(`Previously encountered errors`);

    const fixAttempts = older.filter(m => m.content.includes('Fix') || m.content.includes('fix') || m.content.includes('```oakscript')).length;
    if (fixAttempts > 0) parts.push(`Code fixes attempted: ${fixAttempts}`);

    // Extract user preferences
    const prefMatch = older.map(m => m.content).join(' ').match(/prefer[:\s]+(\w+)/i);
    if (prefMatch) parts.push(`User prefers: ${prefMatch[1]}`);

    if (parts.length === 0) parts.push(`${older.length} prior exchanges`);

    return parts.join('. ') + '.';
  }

  getHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  setSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }
}
