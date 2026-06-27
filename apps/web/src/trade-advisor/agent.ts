import type { ChartSnapshot } from './visual-adapter';
import { VisualAdapter } from './visual-adapter';
import { LocalMemory, RemoteMemory } from './memory';
import { WebSearch } from './web-search';

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
      model: 'qwythos-9b',
      agentId: 'trade_advisor',
      agentName: 'Trade Advisor',
      agentIcon: '◆',
      systemPrompt: `You are the DAFE Trade Advisor, an expert trading assistant. You specialize in:

1. **Chart Analysis**: Read OHLCV data, identify patterns (support/resistance, trend lines, candlestick patterns)
2. **Indicator Tuning**: Analyze technical indicators and suggest parameter optimizations
3. **Market Research**: Search the web for earnings, news, and risk factors to inform decisions
4. **Risk Assessment**: Evaluate trade setups for risk/reward, position sizing, and market regime

You have access to:
- Real-time chart data and indicators via the Visual Adapter
- Persistent memory of past conversations and decisions
- Web search for earnings reports, news, and risk analysis

Be concise, data-driven, and use proper trading terminology. When analyzing charts, reference specific price levels, patterns, and indicator values. Provide actionable insights with clear rationale.`,
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
  ): Promise<AgentResponse> {
    this.conversationHistory.push({ role: 'user', content: text });
    this.emit({ role: 'user', content: text });

    const systemPrompt = this.buildSystemPrompt(chartSnapshot, searchResults);

    const contextMessages = this.conversationHistory.slice(-30);
    const ollamaMessages = [
      { role: 'system', content: systemPrompt },
      ...contextMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];

    try {
      const resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: this.config.agentId,
          model: this.config.model,
          messages: ollamaMessages,
          message: text,
          system_prompt: systemPrompt,
        }),
      });

      const data = await resp.json();

      if (data.ok) {
        const reply = data.reply || '(empty response)';
        this.conversationHistory.push({ role: 'assistant', content: reply });
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
      const context = adapter.buildChartContext(chartSnapshot);
      prompt += `\n\n## Current Chart Context\n${context}`;
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
