import { CapacitorHttp } from '@capacitor/core';
import { DEMO_MODE } from './state';

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export interface NativeGetResult {
  status: number;
  data: any;
}

export async function nativeGet(url: string, params: Record<string, string>, timeoutMs = 15_000): Promise<NativeGetResult | null> {
  // DEMO MODE: the public web demo is fully local — every outbound request is
  // cut here at the transport so no feed, key or backend is ever contacted.
  if (DEMO_MODE) return null;
  try {
    const res = await CapacitorHttp.get({
      url,
      params,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) return { status: res.status, data: null };
    return { status: res.status, data: res.data };
  } catch {
    return null;
  }
}

export interface NativePostResult {
  status: number;
  data: any;
}

export async function nativePost(url: string, body: any, headers: Record<string, string> = {}, timeoutMs = 25_000, connectMs?: number): Promise<NativePostResult | null> {
  // DEMO MODE: no outbound POSTs from the public demo build.
  if (DEMO_MODE) return null;
  try {
    const res = await CapacitorHttp.post({
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': BROWSER_UA,
        ...headers,
      },
      data: body,
      connectTimeout: connectMs ?? timeoutMs,
      readTimeout: timeoutMs,
    });
    // Return even on 4xx/5xx so caller can read error; null only on network failure
    return { status: res.status, data: res.data };
  } catch {
    return null;
  }
}

export async function nativeGetWithHeaders(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<NativeGetResult | null> {
  // DEMO MODE: no outbound requests from the public demo build.
  if (DEMO_MODE) return null;
  try {
    const res = await CapacitorHttp.get({
      url,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    return { status: res.status, data: res.data };
  } catch {
    return null;
  }
}

export const LLM_PRESETS: Record<string, { label: string; baseUrl: string; model: string }> = {
  meta: { label: 'Meta', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' },
  nvidia: { label: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'minimaxai/minimax-m3.1-flash' },
  opencode: { label: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-pro' },
};

export function resolveLlmBase(cfg: any): string {
  if (cfg?.baseUrl?.trim()) return cfg.baseUrl.trim().replace(/\/$/, '');
  const p = (cfg?.provider || '').toLowerCase();
  if (LLM_PRESETS[p]) return LLM_PRESETS[p].baseUrl;
  if (p === 'openai') return 'https://api.openai.com/v1';
  if (p === 'openrouter') return 'https://openrouter.ai/api/v1';
  if (p === 'orcarouter') return 'https://orcarouter.com/api/v1';
  if (p === 'anthropic') return 'https://api.anthropic.com/v1';
  // ollama / custom / empty
  return 'http://localhost:11434/v1';
}

// ─── Unified LLM chat transport ─────────────────────────────────────────────
// Generation runs 30–120+s against big prompts; a single shared read timeout
// was killing completions mid-stream while the fast GET /models "test" kept
// passing — making the app LOOK online but never answer. This transport:
//   • splits connect (15s) from read (default 180s) timeouts
//   • routes Anthropic natively (/messages + x-api-key) instead of forcing
//     the OpenAI shape onto it
//   • forces stream:false and an explicit max_tokens
//   • tolerates providers that return JSON as a raw string
export interface LlmChatResult {
  ok: boolean;
  text: string;
  error?: string;
  status?: number;
}

/** Fetch every model id the configured provider will serve this key.
 *  Handles OpenAI-compatible ({data:[{id}]}) and Anthropic shapes, tolerates
 *  raw-string JSON bodies, and ranks ids so free tiers surface first
 *  (":free"/"free" markers, then everything else alphabetically). */
export async function fetchLlmModels(cfg: any, timeoutMs = 12_000): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const provider = (cfg?.provider || '').toLowerCase();
  const base = resolveLlmBase(cfg);
  const key = (cfg?.apiKey || '').trim();
  const headers: Record<string, string> = {};
  if (provider === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  try {
    const res = await nativeGetWithHeaders(`${base}/models`, headers, timeoutMs);
    if (!res) return { ok: false, models: [], error: 'No response — check Base URL / network' };
    if (res.status < 200 || res.status >= 300) {
      const detail = typeof res.data === 'string' ? res.data.slice(0, 160) : JSON.stringify(res.data ?? '').slice(0, 160);
      return { ok: false, models: [], error: `HTTP ${res.status} — ${detail}` };
    }
    let j = res.data;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch { /* keep */ } }
    const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const ids = arr
      .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name))
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
    const unique: string[] = Array.from(new Set(ids));
    const isFree = (id: string): boolean => /[:\-_/]free\b|(^|\/)free[-_:]/i.test(id) || /\bfree\b/i.test(id.split('/').pop() || '');
    unique.sort((a, b) => {
      const fa = isFree(a) ? 0 : 1;
      const fb = isFree(b) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return a.localeCompare(b);
    });
    return { ok: true, models: unique };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function extractLlmText(data: any): string {
  // CapacitorHttp usually parses JSON bodies, but some providers/proxies
  // deliver text/plain or charset-mangled content types — handle both.
  let j = data;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch { return j.trim(); }
  }
  const choice = j?.choices?.[0]?.message?.content;
  if (typeof choice === 'string' && choice.trim()) return choice.trim();
  if (Array.isArray(choice)) {
    const joined = choice.map((c: any) => c?.text ?? '').join('').trim();
    if (joined) return joined;
  }
  const anthropic = j?.content?.[0]?.text;
  if (typeof anthropic === 'string' && anthropic.trim()) return anthropic.trim();
  if (typeof j?.reply === 'string' && j.reply.trim()) return j.reply.trim();
  if (typeof j?.response === 'string' && j.response.trim()) return j.response.trim(); // ollama native
  return '';
}

export interface LlmTurn { role: 'user' | 'assistant'; content: string; }

export async function llmChat(
  cfg: any,
  system: string,
  user: string | LlmTurn[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<LlmChatResult> {
  const provider = (cfg?.provider || '').toLowerCase();
  const base = resolveLlmBase(cfg);
  const key = (cfg?.apiKey || '').trim();
  const maxTokens = opts?.maxTokens ?? 4096;
  const temperature = opts?.temperature ?? 0.7;
  const readMs = opts?.timeoutMs ?? 180_000;
  const turns: LlmTurn[] = typeof user === 'string' ? [{ role: 'user', content: user }] : user;

  try {
    let res: NativePostResult | null;

    if (provider === 'anthropic') {
      // Native Messages API — different path, auth header, and payload.
      const body = {
        model: cfg.model || 'claude-3-5-sonnet-latest',
        max_tokens: maxTokens,
        temperature,
        system,
        messages: turns,
      };
      res = await nativePost(`${base}/messages`, body, {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      }, readMs, 15_000);
    } else {
      const headers: Record<string, string> = {};
      if (key) headers['Authorization'] = `Bearer ${key}`;
      if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://dafecharts.app';
        headers['X-Title'] = 'DAFE Charts';
      }
      // Provider-sane fallbacks — sending 'gpt-4o' as the model id to a
      // non-OpenAI provider guarantees a 404 on every completion.
      const DEFAULT_MODELS: Record<string, string> = {
        opencode: 'deepseek-v4-pro',
        openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
        orcarouter: 'gpt-4o-mini',
        ollama: 'llama3',
        openai: 'gpt-4o',
        meta: LLM_PRESETS.meta.model,
        nvidia: LLM_PRESETS.nvidia.model,
      };
      const body = {
        model: cfg.model || DEFAULT_MODELS[provider] || 'gpt-4o',
        stream: false,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: 'system', content: system },
          ...turns,
        ],
      };
      res = await nativePost(`${base}/chat/completions`, body, headers, readMs, 15_000);
    }

    if (!res) {
      return { ok: false, text: '', error: `No response after ${Math.round(readMs / 1000)}s — provider unreachable or timed out` };
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = typeof res.data === 'string'
        ? res.data.slice(0, 300)
        : JSON.stringify(res.data ?? '').slice(0, 300);
      return { ok: false, text: '', status: res.status, error: `HTTP ${res.status} — ${detail || 'no detail'}` };
    }
    const text = extractLlmText(res.data);
    if (!text) {
      return { ok: false, text: '', status: res.status, error: 'Provider returned 200 but no message content — check the model name' };
    }
    return { ok: true, text, status: res.status };
  } catch (e) {
    return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) };
  }
}