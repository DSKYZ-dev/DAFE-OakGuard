import { state } from './state';
import { findBackend, backendHeaders } from './backend';
import { nativeGetWithHeaders, nativePost, llmChat as directChat, fetchLlmModels as directModels, type LlmTurn } from './native-http';

// Routing: the PC backend holds keys for hosted providers. When it is reachable
// and reports a saved key for the selected provider, the phone sends messages
// to the backend and holds no key. Otherwise the call goes straight from the
// device with the device key (Ollama always goes direct).

export interface LlmConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  [k: string]: any;
}

export type LlmVia = 'backend' | 'direct';

export interface LlmChatOpts {
  system?: string;
  messages: LlmTurn[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmChatResult {
  ok: boolean;
  text?: string;
  error?: string;
  via: LlmVia;
}

export interface LlmModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
  via: LlmVia;
}

export interface LlmRoute {
  via: LlmVia;
  backendUrl: string | null;
}

const LLM_KEY = 'dafe_mobile_llm';
const PROVIDERS_TTL_MS = 20_000;
let providersCache: { url: string; at: number; configured: Set<string> } | null = null;

export function savedLlmConfig(): LlmConfig {
  try { return JSON.parse(localStorage.getItem(LLM_KEY) || '{}'); } catch { return {}; }
}

function providerOf(cfg: LlmConfig): string {
  return (cfg?.provider || '').toLowerCase();
}

function deviceKeyOf(cfg: LlmConfig): string {
  return (cfg?.apiKey || '').trim();
}

function parseJson(v: any): any {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

function noKeyError(provider: string): string {
  return `No API key for ${provider || 'this provider'} on this device. Add one in Settings, or save it on the PC backend.`;
}

async function backendConfiguredProviders(url: string): Promise<Set<string> | null> {
  if (providersCache && providersCache.url === url && Date.now() - providersCache.at < PROVIDERS_TTL_MS) {
    return providersCache.configured;
  }
  const res = await nativeGetWithHeaders(`${url}/api/llm/providers`, backendHeaders(), 4000);
  if (!res || res.status < 200 || res.status >= 300) return null;
  const data = parseJson(res.data);
  if (!data?.ok || !Array.isArray(data.providers)) return null;
  const configured = new Set<string>(
    data.providers.filter((p: any) => p?.configured === true).map((p: any) => String(p.id)),
  );
  providersCache = { url, at: Date.now(), configured };
  return configured;
}

export async function llmRoute(cfg: LlmConfig = savedLlmConfig()): Promise<LlmRoute> {
  const provider = providerOf(cfg);
  if (provider === 'ollama' || state.backendMode === 'offline') return { via: 'direct', backendUrl: null };
  const url = await findBackend();
  if (!url) return { via: 'direct', backendUrl: null };
  const configured = await backendConfiguredProviders(url);
  if (configured?.has(provider)) return { via: 'backend', backendUrl: url };
  return { via: 'direct', backendUrl: null };
}

// True when a chat call can succeed: Ollama, a device key, or a PC-held key.
export async function llmReady(): Promise<boolean> {
  const cfg = savedLlmConfig();
  if (providerOf(cfg) === 'ollama' || deviceKeyOf(cfg)) return true;
  return (await llmRoute(cfg)).via === 'backend';
}

export async function llmChat(opts: LlmChatOpts): Promise<LlmChatResult> {
  const cfg = savedLlmConfig();
  const route = await llmRoute(cfg);
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.7;

  if (route.via === 'backend' && route.backendUrl) {
    const provider = providerOf(cfg);
    const body = {
      provider,
      model: cfg.model || undefined,
      system: opts.system || undefined,
      messages: opts.messages,
      max_tokens: maxTokens,
      temperature,
    };
    const res = await nativePost(`${route.backendUrl}/api/llm/hosted-chat`, body, backendHeaders(), 180_000, 15_000);
    if (!res) return { ok: false, via: 'backend', error: 'No response from the PC backend' };
    const data = parseJson(res.data);
    if (res.status < 200 || res.status >= 300 || !data?.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
      return { ok: false, via: 'backend', error: data?.detail || `PC backend HTTP ${res.status}` };
    }
    return { ok: true, text: data.reply.trim(), via: 'backend' };
  }

  if (providerOf(cfg) !== 'ollama' && !deviceKeyOf(cfg)) {
    return { ok: false, via: 'direct', error: noKeyError(providerOf(cfg)) };
  }
  const r = await directChat(cfg, opts.system ?? '', opts.messages, { maxTokens, temperature });
  return { ok: r.ok, text: r.text, error: r.error, via: 'direct' };
}

export async function llmProbe(cfg: LlmConfig = savedLlmConfig()): Promise<LlmChatResult> {
  const route = await llmRoute(cfg);
  if (route.via === 'backend' && route.backendUrl) {
    const provider = providerOf(cfg);
    const res = await nativePost(`${route.backendUrl}/api/llm/providers/${encodeURIComponent(provider)}/test`, {}, backendHeaders(), 60_000, 15_000);
    if (!res) return { ok: false, via: 'backend', error: 'No response from the PC backend' };
    const data = parseJson(res.data);
    if (res.status < 200 || res.status >= 300 || !data?.ok) {
      return { ok: false, via: 'backend', error: data?.error || `PC backend HTTP ${res.status}` };
    }
    return { ok: true, text: typeof data.reply === 'string' ? data.reply : '', via: 'backend' };
  }
  if (providerOf(cfg) !== 'ollama' && !deviceKeyOf(cfg)) {
    return { ok: false, via: 'direct', error: noKeyError(providerOf(cfg)) };
  }
  const r = await directChat(cfg, 'Reply with the single word: OK', [{ role: 'user', content: 'ping' }], { maxTokens: 8, temperature: 0 });
  return { ok: r.ok, text: r.text, error: r.error, via: 'direct' };
}

export async function llmListModels(cfg: LlmConfig = savedLlmConfig()): Promise<LlmModelsResult> {
  const route = await llmRoute(cfg);
  if (route.via === 'backend' && route.backendUrl) {
    const provider = providerOf(cfg);
    const res = await nativeGetWithHeaders(`${route.backendUrl}/api/llm/models?provider=${encodeURIComponent(provider)}`, backendHeaders(), 20_000);
    if (!res) return { ok: false, models: [], error: 'No response from the PC backend', via: 'backend' };
    const data = parseJson(res.data);
    if (res.status < 200 || res.status >= 300 || !data?.ok) {
      return { ok: false, models: [], error: data?.error || `PC backend HTTP ${res.status}`, via: 'backend' };
    }
    const models: string[] = (Array.isArray(data.models) ? data.models : [])
      .map((m: any) => (typeof m === 'string' ? m : m?.id))
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
    return { ok: true, models: Array.from(new Set(models)), via: 'backend' };
  }
  if (providerOf(cfg) !== 'ollama' && !deviceKeyOf(cfg)) {
    return { ok: false, models: [], error: noKeyError(providerOf(cfg)), via: 'direct' };
  }
  const r = await directModels(cfg);
  return { ok: r.ok, models: r.models, error: r.error, via: 'direct' };
}
