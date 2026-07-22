/**
 * ML / RL client — talks to the backend's /api/ml/* and /api/rl/* endpoints
 * (see backend/ml_engine.py). Two integration paths, matching how the two
 * consumers actually run:
 *
 *  1. Live chart / paper-trading (ml.predict()/rl.action() evaluated inside
 *     the synchronous per-bar interpreter, same problem image-cache.ts's
 *     resolveImage() already solved for async image decodes): resolveMl*()
 *     always returns synchronously — the cached array on a hit, or null on
 *     a miss while a fetch runs in the background; once it lands, a redraw
 *     callback fires so the next render pass picks up the real values.
 *  2. Backtesting (one-shot, non-interactive — there's no "next render pass"
 *     to retry on): fetchMl*Map() is awaited up front, before the replay
 *     starts, exactly like Time Machine already awaits historical bars
 *     before running a script.
 */
import type { RuntimeBarData } from './oakscript/interpreter';

export const ML_API_BASE = 'http://localhost:8788';

export interface MlModelMeta {
  id: string; symbol: string; timeframe: string; horizon: number;
  targetType: 'direction' | 'return'; modelType: 'gbm' | 'mlp' | 'logistic';
  trainPct: number; trainRows: number; valRows: number; warmupBars: number; createdAt: number;
  metrics: Record<string, number | string>;
  featureImportances: { feature: string; importance: number }[];
}

export interface RlRunStats { totalReturn: number; winRate: number; steps: number; }
export interface RlPolicyMeta {
  id: string; symbol: string; timeframe: string; episodes: number; trainPct: number;
  trainRows: number; valRows: number; warmupBars: number; createdAt: number;
  stateFeatures: string[]; binsPerFeature: number; stateSpaceSize: number;
  episodeRewards: number[];
  validation: { policy: RlRunStats; alwaysLong: RlRunStats; alwaysFlat: RlRunStats };
}

function barsToApiRows(bars: RuntimeBarData): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const rows = new Array(bars.count);
  for (let i = 0; i < bars.count; i++) {
    rows[i] = { ts: bars.time[i], open: bars.open[i], high: bars.high[i], low: bars.low[i], close: bars.close[i], volume: bars.volume[i] };
  }
  return rows;
}

/** Cheap content signature — invalidates the live-chart cache when the bar
 * range materially changes (new symbol/timeframe, regenerated synthetic
 * data, more bars loaded) instead of silently serving stale predictions. */
function barsSignature(bars: RuntimeBarData): string {
  const n = bars.count;
  if (n === 0) return '0';
  return `${n}|${bars.time[0]}|${bars.time[n - 1]}|${bars.close[n - 1].toFixed(4)}`;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `${path} failed (${res.status})`);
  return data as T;
}

// ─── Live-chart path: sync read, background fetch-on-miss ──────────────
type CacheEntry = number[] | 'loading' | 'error';
const mlCache = new Map<string, CacheEntry>();
const rlCache = new Map<string, CacheEntry>();
let redrawCallback: (() => void) | undefined;

export function setMlRedrawCallback(fn: () => void): void { redrawCallback = fn; }

function resolveGeneric(cache: Map<string, CacheEntry>, key: string, fetcher: () => Promise<number[]>): number[] | null {
  const entry = cache.get(key);
  if (entry && entry !== 'loading' && entry !== 'error') return entry;
  if (entry === 'loading' || entry === 'error') return null;
  cache.set(key, 'loading');
  fetcher()
    .then((result) => { cache.set(key, result); redrawCallback?.(); })
    .catch(() => { cache.set(key, 'error'); });
  return null;
}

export function resolveMlPrediction(modelId: string, bars: RuntimeBarData, baseUrl = ML_API_BASE): number[] | null {
  return resolveGeneric(mlCache, `${modelId}|${barsSignature(bars)}`, async () => {
    const data = await postJson<{ predictions: number[] }>(baseUrl, '/api/ml/predict', { modelId, bars: barsToApiRows(bars) });
    return data.predictions;
  });
}

export function resolveRlAction(policyId: string, bars: RuntimeBarData, baseUrl = ML_API_BASE): number[] | null {
  return resolveGeneric(rlCache, `${policyId}|${barsSignature(bars)}`, async () => {
    const data = await postJson<{ actions: number[] }>(baseUrl, '/api/rl/action', { policyId, bars: barsToApiRows(bars) });
    return data.actions;
  });
}

// ─── Backtest path: explicit await-up-front pre-fetch ───────────────────
export async function fetchMlPredictionsMap(modelIds: string[], bars: RuntimeBarData, baseUrl = ML_API_BASE): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  await Promise.all(modelIds.map(async (id) => {
    try {
      const data = await postJson<{ predictions: number[] }>(baseUrl, '/api/ml/predict', { modelId: id, bars: barsToApiRows(bars) });
      out.set(id, data.predictions);
    } catch { /* left unset — interpreter falls back to a neutral default */ }
  }));
  return out;
}

export async function fetchRlActionsMap(policyIds: string[], bars: RuntimeBarData, baseUrl = ML_API_BASE): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  await Promise.all(policyIds.map(async (id) => {
    try {
      const data = await postJson<{ actions: number[] }>(baseUrl, '/api/rl/action', { policyId: id, bars: barsToApiRows(bars) });
      out.set(id, data.actions);
    } catch { /* left unset — interpreter falls back to flat (0) */ }
  }));
  return out;
}

/** Static scan for ml.predict("id")/rl.action("id") literal-string calls —
 * same spirit as detectInputs()'s AST walk, but a plain regex is enough
 * here since only literal string args need to resolve before a run (a
 * script computing the id dynamically can't be pre-fetched anyway, and
 * would just see the neutral default for that call). */
export function detectMlRefs(source: string): { modelIds: string[]; policyIds: string[] } {
  const modelIds = new Set<string>();
  const policyIds = new Set<string>();
  const mlRe = /\bml\.predict\s*\(\s*["']([^"']+)["']/g;
  const rlRe = /\brl\.action\s*\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = mlRe.exec(source))) modelIds.add(m[1]);
  while ((m = rlRe.exec(source))) policyIds.add(m[1]);
  return { modelIds: Array.from(modelIds), policyIds: Array.from(policyIds) };
}

// ─── ML Lab panel: train / list / delete ────────────────────────────────
export interface MlTrainParams {
  bars: RuntimeBarData; horizon: number; targetType: 'direction' | 'return';
  modelType: 'gbm' | 'mlp' | 'logistic'; trainPct: number; symbol: string; timeframe: string; baseUrl?: string;
}
export async function trainMlModel(p: MlTrainParams): Promise<MlModelMeta> {
  const data = await postJson<{ model: MlModelMeta }>(p.baseUrl ?? ML_API_BASE, '/api/ml/train', {
    bars: barsToApiRows(p.bars), horizon: p.horizon, targetType: p.targetType,
    modelType: p.modelType, trainPct: p.trainPct, symbol: p.symbol, timeframe: p.timeframe,
  });
  return data.model;
}
export async function listMlModels(baseUrl = ML_API_BASE): Promise<MlModelMeta[]> {
  const res = await fetch(`${baseUrl}/api/ml/models`);
  if (!res.ok) throw new Error(`ml/models failed (${res.status})`);
  return (await res.json()).models;
}
export async function deleteMlModel(id: string, baseUrl = ML_API_BASE): Promise<void> {
  const res = await fetch(`${baseUrl}/api/ml/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete model failed (${res.status})`);
}

export interface RlTrainParams {
  bars: RuntimeBarData; episodes: number; trainPct: number; symbol: string; timeframe: string; baseUrl?: string;
}
export async function trainRlPolicy(p: RlTrainParams): Promise<RlPolicyMeta> {
  const data = await postJson<{ policy: RlPolicyMeta }>(p.baseUrl ?? ML_API_BASE, '/api/rl/train', {
    bars: barsToApiRows(p.bars), episodes: p.episodes, trainPct: p.trainPct, symbol: p.symbol, timeframe: p.timeframe,
  });
  return data.policy;
}
export async function listRlPolicies(baseUrl = ML_API_BASE): Promise<RlPolicyMeta[]> {
  const res = await fetch(`${baseUrl}/api/rl/policies`);
  if (!res.ok) throw new Error(`rl/policies failed (${res.status})`);
  return (await res.json()).policies;
}
export async function deleteRlPolicy(id: string, baseUrl = ML_API_BASE): Promise<void> {
  const res = await fetch(`${baseUrl}/api/rl/policies/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete policy failed (${res.status})`);
}
