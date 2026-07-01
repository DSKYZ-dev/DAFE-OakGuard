/**
 * DAFE Dynamic Token Optimizer — Adaptive token reduction system.
 *
 * Dynamically queries the backend for the actual running model's context
 * size so optimization adapts to real hardware limits, not assumptions.
 *
 * Supports dual-model operation (trade advisor + coder running concurrently).
 */

// ─── Model profiles (fallback defaults when backend is unreachable) ──
export interface ModelProfile {
  name: string;
  ctxLimit: number;
  reserveTokens: number;
  isThinkingModel: boolean;
  speed: 'fast' | 'medium' | 'slow';
}

// Realistic defaults for modern setups (8GB+ GPU) — overridden by /api/model/status
const FALLBACK_PROFILE: ModelProfile = {
  name: 'default', ctxLimit: 32768, reserveTokens: 512, isThinkingModel: false, speed: 'medium',
};

const CACHED_PROFILES = new Map<string, ModelProfile>();

// The backend hot-swaps a single llama-server (one port), so exactly one model
// is live at a time and its real context size is effectively global. We cache
// it here so the SYNC resolveProfile() uses the true limit for any model name,
// not just the one prefetch happened to key on.
let RUNNING_CTX = 0;

export function setRunningContext(ctx: number): void {
  if (ctx > 0) RUNNING_CTX = ctx;
}

// The context size only changes on a model switch, so polling /api/model/status
// on every profile lookup wastes requests (the backend log showed hundreds of
// rapid status calls). Throttle to once per CTX_TTL and de-dupe concurrent calls.
let _lastCtxFetch = 0;
let _ctxInFlight: Promise<number> | null = null;
const CTX_TTL = 20_000;

async function fetchModelCtx(_modelName: string): Promise<number> {
  const now = Date.now();
  // Throttle by time-since-last-ATTEMPT (not since-last-success). If the model
  // reports running:false the ctx stays 0 — without this we'd poll forever.
  if (_lastCtxFetch > 0 && now - _lastCtxFetch < CTX_TTL) return RUNNING_CTX;
  if (_ctxInFlight) return _ctxInFlight;
  const backendUrl = (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788';
  _ctxInFlight = (async () => {
    try {
      const resp = await fetch(`${backendUrl}/api/model/status`);
      const data = await resp.json();
      if (data.ok && data.running && data.ctx > 0) RUNNING_CTX = data.ctx;
    } catch {}
    _lastCtxFetch = Date.now();
    return RUNNING_CTX;
  })();
  try { return await _ctxInFlight; } finally { _ctxInFlight = null; }
}

/** Force the next status fetch to hit the backend (call right after a switch). */
export function invalidateModelCtx(): void { _lastCtxFetch = 0; }

function buildProfile(modelName: string, ctx: number): ModelProfile {
  const key = modelName.toLowerCase();
  return {
    name: modelName,
    ctxLimit: ctx > 0 ? ctx : (RUNNING_CTX > 0 ? RUNNING_CTX : FALLBACK_PROFILE.ctxLimit),
    // Reserve scales with context so big-context models keep real headroom.
    reserveTokens: Math.max(384, Math.round((ctx || RUNNING_CTX || FALLBACK_PROFILE.ctxLimit) * 0.05)),
    isThinkingModel: key.includes('qwen') || key.includes('vibethinker') || key.includes('think'),
    speed: key.includes('3b') || key.includes('1b') ? 'fast' : key.includes('12b') || key.includes('14b') ? 'slow' : 'medium',
  };
}

async function resolveProfileAsync(modelName: string): Promise<ModelProfile> {
  const key = modelName.toLowerCase();
  const ctx = await fetchModelCtx(modelName);
  const profile = buildProfile(modelName, ctx);
  CACHED_PROFILES.set(key, profile);
  return profile;
}

// Sync version for non-async callers — always uses the freshest RUNNING_CTX.
// Stale cached profiles are rebuilt when RUNNING_CTX changes.
function resolveProfile(modelName: string): ModelProfile {
  const key = modelName.toLowerCase();
  const cached = CACHED_PROFILES.get(key);
  // Always use the freshest RUNNING_CTX — if it changed, rebuild.
  if (cached && RUNNING_CTX > 0 && cached.ctxLimit === RUNNING_CTX) return cached;
  if (cached && RUNNING_CTX === 0) return cached;  // no better info available
  // Kick off async refresh, but return a profile using the real running ctx now.
  if (RUNNING_CTX > 0) {
    // Synchronously rebuild with the freshest value so callers get correct limits.
    const profile = buildProfile(modelName, RUNNING_CTX);
    CACHED_PROFILES.set(key, profile);
    return profile;
  }
  resolveProfileAsync(modelName);
  return cached || buildProfile(modelName, 0);
}

export function getModelContextLimit(modelName: string): number {
  return resolveProfile(modelName).ctxLimit;
}

export function isThinkingModel(modelName: string): boolean {
  return resolveProfile(modelName).isThinkingModel;
}

// ─── Per-model token budget state ──────────────────────────────────
interface ModelBudget {
  profile: ModelProfile;
  usedTokens: number;
  lastReset: number;
  compressionLevel: number; // 0=none, 1=light, 2=moderate, 3=aggressive
}

const budgets = new Map<string, ModelBudget>();

function getBudget(agentType: string, modelName: string): ModelBudget {
  const id = `${agentType}:${modelName}`;
  let b = budgets.get(id);
  const profile = resolveProfile(modelName);
  if (!b) {
    b = {
      profile,
      usedTokens: 0,
      lastReset: Date.now(),
      compressionLevel: 0,
    };
    budgets.set(id, b);
  } else if (b.profile.ctxLimit !== profile.ctxLimit) {
    // Context changed (model switched or real ctx arrived) — rebuild budget.
    b.profile = profile;
  }
  return b;
}

// ─── Adaptive compression level from budget pressure ──────────────
export function getCompressionLevel(agentType: string, modelName: string = 'auto'): number {
  return getBudget(agentType, modelName).compressionLevel;
}

function adjustCompression(budget: ModelBudget, estimatedTokens: number): void {
  const pct = estimatedTokens / Math.max(1, budget.profile.ctxLimit - budget.profile.reserveTokens);
  if (pct > 0.8) budget.compressionLevel = 3;
  else if (pct > 0.6) budget.compressionLevel = 2;
  else if (pct > 0.4) budget.compressionLevel = 1;
  else budget.compressionLevel = 0;
}

// ─── Token estimation (fast, no external dep) ─────────────────────
// ~2.5 chars/token for English prose; code is denser so we treat it as the
// average. Both helpers MUST agree so budget maths stay consistent.
const CHARS_PER_TOKEN = 2.5;

export function tokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export function estimateTokens(text: string): number {
  return tokensFromChars(text.length);
}

// ─── TECHNIQUE 1: Redundancy Pruning ──────────────────────────────
const FILLER_PATTERNS = [
  /(?:\b(?:certainly|absolutely|of course|indeed|obviously|basically|essentially|actually)\b[,.!]?\s*)/gi,
  /(?:\b(?:I would say that|let me explain|just to clarify|to be clear|it's worth noting that)\b[,.!]?\s*)/gi,
  /(?:\b(?:please note that|kindly note that|you should know that)\b[,.!]?\s*)/gi,
  /\n{3,}/g,
];

export function pruneRedundancy(text: string): string {
  let out = text;
  for (const p of FILLER_PATTERNS) out = out.replace(p, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

// ─── TECHNIQUE 2: Semantic Deduplication ──────────────────────────
export function deduplicateMessages(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  const seen = new Set<string>();
  const out: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    const sig = (m.role + ':' + m.content.slice(0, 80)).toLowerCase().trim();
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(m);
    }
  }
  return out;
}

// ─── TECHNIQUE 3: Chart Context Clustering ────────────────────────
export function compressChartBars(
  bars: Array<{ open: number; high: number; low: number; close: number; volume: number }>,
  level: number = 1,
): string {
  if (bars.length === 0) return '';

  if (level >= 3) {
    // Aggressive: only OHLC summary of the block
    const o = bars[0].open;
    const c = bars[bars.length - 1].close;
    const h = Math.max(...bars.map(b => b.high));
    const l = Math.min(...bars.map(b => b.low));
    const v = bars.reduce((s, b) => s + b.volume, 0);
    return `[${bars.length} bars] O:${o.toFixed(1)} H:${h.toFixed(1)} L:${l.toFixed(1)} C:${c.toFixed(1)} V:${Math.round(v)}`;
  }

  if (level >= 2) {
    // Moderate: cluster into groups of ~5 bars and average
    const clusters: string[] = [];
    const sz = Math.max(1, Math.ceil(bars.length / 6));
    for (let i = 0; i < bars.length; i += sz) {
      const chunk = bars.slice(i, i + sz);
      const o = chunk[0].open;
      const c = chunk[chunk.length - 1].close;
      const h = Math.max(...chunk.map(b => b.high));
      const l = Math.min(...chunk.map(b => b.low));
      const v = chunk.reduce((s, b) => s + b.volume, 0);
      clusters.push(`[${i}-${i + chunk.length - 1}] O:${o.toFixed(1)} H:${h.toFixed(1)} L:${l.toFixed(1)} C:${c.toFixed(1)} V:${Math.round(v)}`);
    }
    return clusters.join('\n');
  }

  // Light: keep last 8 bars verbatim, summarize earlier
  const recent = bars.slice(-8).map((b, i) =>
    `[${bars.length - 8 + i}] O:${b.open.toFixed(2)} H:${b.high.toFixed(2)} L:${b.low.toFixed(2)} C:${b.close.toFixed(2)} V:${Math.round(b.volume)}`
  ).join('\n');

  if (bars.length <= 10) return recent;
  const early = bars.slice(0, bars.length - 8);
  const eo = early[0].open, ec = early[early.length - 1].close;
  const eh = Math.max(...early.map(b => b.high)), el = Math.min(...early.map(b => b.low));
  return `[0-${bars.length - 9}] O:${eo.toFixed(1)} H:${eh.toFixed(1)} L:${el.toFixed(1)} C:${ec.toFixed(1)}\n${recent}`;
}

// ─── TECHNIQUE 4: OakScript Code Minification ─────────────────────
export function minifyOakScript(source: string, level: number = 1): string {
  if (!source) return '';
  const lines = source.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    let trimmed = line.trimEnd();
    if (!trimmed) continue;

    // Strip comments
    if (level >= 1) {
      const commentStart = trimmed.indexOf('//');
      if (commentStart === 0) continue;
      if (commentStart > 0) {
        // Check not inside string
        let inStr = false, strCh = '';
        let actualComment = -1;
        for (let i = 0; i < trimmed.length; i++) {
          if (!inStr && (trimmed[i] === '"' || trimmed[i] === "'")) { inStr = true; strCh = trimmed[i]; }
          else if (inStr && trimmed[i] === strCh) { inStr = false; }
          else if (!inStr && trimmed[i] === '/' && trimmed[i + 1] === '/') { actualComment = i; break; }
        }
        if (actualComment >= 0) trimmed = trimmed.substring(0, actualComment).trimEnd();
      }
    }

    // Remove trailing spaces
    trimmed = trimmed.trimEnd();
    if (!trimmed) continue;

    // Aggressive: collapse indentation
    if (level >= 3) {
      trimmed = trimmed.trimStart();
    }

    out.push(trimmed);
  }

  let result = out.join('\n');

  // Level 2+: collapse blank line runs
  if (level >= 2) result = result.replace(/\n{2,}/g, '\n');

  return result;
}

// ─── TECHNIQUE 5: Conversation History Compression ────────────────
export function compressConversation(
  messages: Array<{ role: string; content: string }>,
  keepRecent: number = 4,
  agentType: string = 'trade_advisor',
): Array<{ role: string; content: string }> {
  if (messages.length <= keepRecent + 2) return [...messages];

  const recent = messages.slice(-keepRecent);
  const older = messages.slice(0, -keepRecent);

  // Cluster older messages by summarizing each exchange
  const summaryParts: string[] = [];
  let i = 0;
  while (i < older.length) {
    const m = older[i];
    if (m.role === 'user') {
      const snippet = m.content.replace(/\n/g, ' ').slice(0, 80);
      summaryParts.push(`User asked: "${snippet}..."`);
    } else if (m.role === 'assistant') {
      const brief = m.content.replace(/\n/g, ' ').slice(0, 100).replace(/```[\s\S]*?```/g, '[code]');
      summaryParts.push(`Agent replied: "${brief}..."`);
    }
    i++;
  }

  const summary = `[${older.length} earlier messages summarized]:\n${summaryParts.join('\n')}`;
  return [
    { role: 'system', content: summary },
    ...recent,
  ];
}

// ─── TECHNIQUE 6: Token Budget Injection ─────────────────────────
export function injectTokenBudget(
  messages: Array<{ role: string; content: string }>,
  agentType: string,
  modelName: string,
): { messages: Array<{ role: string; content: string }>; budget: number } {
  const budget = getBudget(agentType, modelName);
  const profile = budget.profile;
  const totalChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const estimatedTokens = tokensFromChars(totalChars);
  const available = profile.ctxLimit - profile.reserveTokens - 300; // 300 for response headroom
  // Max budget: scale with context — small models get a floor, large models get proportional room.
  // Cap at roughly 50% of available context so the model always has headroom for reasoning.
  const cap = Math.max(800, Math.round(available * 0.5));
  const maxBudget = Math.max(500, cap - estimatedTokens);

  adjustCompression(budget, estimatedTokens + maxBudget);

  // Inject budget hint only if pressure exists
  const level = budget.compressionLevel;
  let budgetMsg = '';
  if (level >= 2) {
    budgetMsg = ` [Token budget: ${maxBudget}. Be VERY concise. Short responses only.]`;
  } else if (level >= 1) {
    budgetMsg = ` [Token budget: ${maxBudget}. Be concise. Prefer code over explanation.]`;
  }

  const system = messages.find(m => m.role === 'system');
  if (system && budgetMsg) {
    system.content = String(system.content) + budgetMsg;
  }

  budget.usedTokens = estimatedTokens;
  budget.lastReset = Date.now();
  budgets.set(`${agentType}:${modelName}`, budget);

  return { messages, budget: maxBudget };
}

// ─── Full optimization pipeline ───────────────────────────────────
export interface OptimizeOptions {
  agentType: string;
  modelName: string;
  messages: Array<{ role: string; content: string }>;
  chartBars?: Array<{ open: number; high: number; low: number; close: number; volume: number }>;
  oakscriptSource?: string;
  keepRecentMessages?: number;
}

export interface OptimizeResult {
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  stats: {
    originalChars: number;
    optimizedChars: number;
    savedChars: number;
    savedPercent: number;
    compressionLevel: number;
  };
}

export function optimizePrompt(opts: OptimizeOptions): OptimizeResult {
  const { agentType, modelName, messages, chartBars, oakscriptSource, keepRecentMessages = 4 } = opts;

  const originalChars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);

  // Step 1: Determine compression level
  const budget = getBudget(agentType, modelName);
  const estTokens = tokensFromChars(originalChars);
  adjustCompression(budget, estTokens);
  const level = budget.compressionLevel;

  let optimized = [...messages];

  // Step 2: Deduplicate messages
  optimized = deduplicateMessages(optimized);

  // Step 3: Compress conversation history (adaptive threshold based on context size)
  const convThreshold = Math.max(10, Math.round(budget.profile.ctxLimit / 2048));
  if (level >= 2 || optimized.length > convThreshold) {
    optimized = compressConversation(optimized, keepRecentMessages, agentType);
  }

  // Step 4: Compress chart data in system-context messages
  if (chartBars && chartBars.length > 5 && level >= 1) {
    const compressedBars = compressChartBars(chartBars, level);
    for (const m of optimized) {
      if (m.role === 'system-context' || m.role === 'system') {
        m.content = String(m.content).replace(
          /\[Current Chart State\][\s\S]*?(?=\n\n|$)/,
          `[Current Chart State]\n${compressedBars}`,
        );
      }
    }
  }

  // Step 5: Minify OakScript code in messages
  if (oakscriptSource && level >= 1) {
    const minified = minifyOakScript(oakscriptSource, level);
    for (const m of optimized) {
      if (typeof m.content === 'string' && m.content.includes('```oakscript')) {
        m.content = m.content.replace(
          /```oakscript\n[\s\S]*?```/g,
          `\`\`\`oakscript\n${minified}\n\`\`\``,
        );
      }
    }
  }

  // Step 6: Prune redundancy from all messages
  if (level >= 2) {
    for (const m of optimized) {
      if (m.role !== 'system') {
        m.content = pruneRedundancy(String(m.content));
      }
    }
  }

  // Step 7: Inject token budget
  const { messages: finalMessages, budget: maxTokens } = injectTokenBudget(optimized, agentType, modelName);

  const optimizedChars = finalMessages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);

  // Step 8: Final safety cap — if still too large for model, trim proportionally
  const effectiveLimit = budget.profile.ctxLimit - budget.profile.reserveTokens - maxTokens - 500;
  let result = finalMessages;
  if (optimizedChars > 0 && tokensFromChars(optimizedChars) > effectiveLimit) {
    // Keep system messages + recent exchanges proportional to context size
    const keepCount = Math.max(2, Math.min(8, Math.floor(budget.profile.ctxLimit / 4096)));
    const sys = result.filter(m => m.role === 'system');
    const recent = result.filter(m => m.role !== 'system').slice(-keepCount);
    result = [...sys, ...recent];
  }

  return {
    messages: result,
    maxTokens,
    stats: {
      originalChars,
      optimizedChars,
      savedChars: originalChars - optimizedChars,
      savedPercent: originalChars > 0 ? Math.round(((originalChars - optimizedChars) / originalChars) * 100) : 0,
      compressionLevel: level,
    },
  };
}

// ─── Prefetch model context on startup ────────────────────────────
export async function prefetchModelProfile(): Promise<number> {
  invalidateModelCtx();                      // a switch may have changed the ctx
  const ctx = await fetchModelCtx('auto');   // also sets the shared RUNNING_CTX
  // A model switch changes the live context — clear stale per-name profiles so
  // they get rebuilt against the new RUNNING_CTX on next use.
  CACHED_PROFILES.clear();
  const profile = buildProfile('current', ctx);
  CACHED_PROFILES.set('auto', profile);
  CACHED_PROFILES.set('current', profile);
  // Light periodic safety refresh (throttled internally to one call / CTX_TTL).
  if (!(window as any).__dafeCtxRefresh) {
    (window as any).__dafeCtxRefresh = setInterval(async () => {
      const fresh = await fetchModelCtx('auto');
      if (fresh > 0 && fresh !== RUNNING_CTX) {
        RUNNING_CTX = fresh;
        CACHED_PROFILES.clear();
      }
    }, 30000);
  }
  return profile.ctxLimit;
}

// ─── Reset budget tracking (call when model switches) ────────────
export function resetBudget(agentType: string, modelName: string): void {
  budgets.delete(`${agentType}:${modelName}`);
}

export function resetAllBudgets(): void {
  budgets.clear();
}

// ─── Export for debugging ─────────────────────────────────────────
export function getBudgetReport(): Array<{ agent: string; model: string; usedTokens: number; level: number }> {
  const report: Array<{ agent: string; model: string; usedTokens: number; level: number }> = [];
  for (const [key, b] of budgets) {
    const [agent, model] = key.split(':');
    report.push({ agent, model, usedTokens: b.usedTokens, level: b.compressionLevel });
  }
  return report;
}
