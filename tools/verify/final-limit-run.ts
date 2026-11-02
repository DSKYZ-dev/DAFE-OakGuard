/**
 * Final limit-test runner — runs the selected limit prompts LIVE against the
 * currently-configured OakScript Coder model (Settings), through the SAME
 * backend chat route and the SAME shared generation pipeline the app uses:
 *
 *   concept brief → best-of-2 drafts → mechanical repair → gated fix loop
 *
 * Every result is independently re-graded with the validator + request-
 * coverage + interpreter after generation, so a pipeline bug cannot mark
 * itself green.
 *
 * Usage:
 *   npx tsx tools/verify/final-limit-run.ts [label] [--set final|extreme|all] [--repeat N] [--fail-fast]
 *       [--base <url>] [--coder-provider <id> [--coder-model <m>]] [--advisor-provider <id> [--advisor-model <m>]]
 *
 *   final    the 5 original limit prompts (default)
 *   extreme  the 6 extreme-limit prompts (extreme-limit-prompts.ts)
 *   all      both sets, 11 prompts per run
 *
 *   Overrides apply to this run only (hosted providers with a saved key); saved
 *   roles are never changed. Without them the saved Settings roles are used.
 *
 * Writes:
 *   tools/verify/final-limit-results-<label>-run-<n>.json
 *   tools/verify/final-limit-results-<label>-summary.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { validate } from '../../apps/web/src/oakscript/validator';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { checkRequestCoverage } from '../../apps/web/src/trade-advisor/request-coverage';
import {
  editScriptWithGates,
  generateIndicatorWithGates,
  probeSignalClustering,
  type PipelineChat,
  type PipelineRole,
} from '../../apps/web/src/trade-advisor/generation-pipeline';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { FINAL_LIMIT_PROMPTS } from './editor-agent-test';
import { EXTREME_LIMIT_PROMPTS } from './extreme-limit-prompts';

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}
const BASE = flagValue('--base') || process.env.DAFE_BACKEND || 'http://127.0.0.1:8788';
const CODER_PROVIDER = flagValue('--coder-provider');
const CODER_MODEL = flagValue('--coder-model');
const ADVISOR_PROVIDER = flagValue('--advisor-provider');
const ADVISOR_MODEL = flagValue('--advisor-model');
if (CODER_MODEL && !CODER_PROVIDER) throw new Error('--coder-model needs --coder-provider');
if (ADVISOR_MODEL && !ADVISOR_PROVIDER) throw new Error('--advisor-model needs --advisor-provider');
const VALUE_FLAGS = ['--repeat', '--set', '--base', '--coder-provider', '--coder-model', '--advisor-provider', '--advisor-model'];
let label = 'run';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.includes(a)) { i++; continue; }
  if (a.startsWith('--')) continue;
  label = a;
  break;
}
const REPEAT = Math.max(1, Number(flagValue('--repeat')) || 1);
const FAIL_FAST = argv.includes('--fail-fast');
const SET = flagValue('--set') ?? 'final';
if (!['final', 'extreme', 'all'].includes(SET)) throw new Error(`--set must be final, extreme or all (got ${SET})`);

const BROKEN_SCRIPT = [
  'var lvl = highest(high, 20)',
  'r = rsi(close, 14)',
  'buySig = close[-1] > lvl',
  'if buySig { plotshape(true, low, "Buy", shape.triangleup, color.green) }',
  'plot3d(r, "RSI", "surface", "#b48cff", "3d")',
  'if crossover(r, 30) { plotshape(bar_index, low, "OS", "triangleup", "#22cc88") }',
].join('\n');

/**
 * POST with node:http/https instead of fetch. Node's fetch (undici) has a
 * default headers timeout that expired before the backend's own provider
 * timeout (300s at the time, now 600s), which turned a slow reasoning model
 * into a bogus "fetch failed". The backend is the authority on how long a
 * completion may take.
 */
function postJson(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    // A hung backend must not hang the harness forever; this is far above the
    // backend's 600s provider timeout and any observed reasoning-model reply.
    req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error('chat request exceeded 20 minutes')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function chatAs(agent: string, message: string): Promise<string> {
  const body: Record<string, string> = { agent, message };
  if (agent === 'oakscript_coder' && CODER_PROVIDER) {
    body.coder_provider = CODER_PROVIDER;
    if (CODER_MODEL) body.coder_model = CODER_MODEL;
  }
  if (agent === 'trade_advisor' && ADVISOR_PROVIDER) {
    body.advisor_provider = ADVISOR_PROVIDER;
    if (ADVISOR_MODEL) body.advisor_model = ADVISOR_MODEL;
  }
  const d: any = await postJson(`${BASE}/api/chat`, body);
  if (!d.ok) throw new Error(d.detail || d.error || 'chat failed');
  return d.reply || '';
}

/** Same personas the app uses: briefs under the advisor, code under the coder. */
async function pipelineChat(prompt: string, role: PipelineRole): Promise<string> {
  return chatAs(role === 'code' ? 'oakscript_coder' : 'trade_advisor', prompt);
}

const barsObj = syntheticBars(220);
const barsArr = barsObj.close.map((c, i) => ({ open: barsObj.open[i], high: barsObj.high[i], low: barsObj.low[i], close: c }));

interface Grade {
  id: number;
  pass: boolean;
  rounds: number;
  drafts: number;
  briefAttempts: number;
  briefFallback: boolean;
  repairs: string[];
  notes?: string[];
  checks: Record<string, boolean>;
  problems: string[];
  codeLen: number;
  code?: string;
  replyHead?: string;
  ms: number;
}

async function runOne(id: number, prompt: string, asserts: (code: string) => Record<string, boolean>): Promise<Grade> {
  const started = Date.now();
  const prefer3D = id !== 3;
  const fullPrompt = id === 5 ? `${prompt}\n\nBROKEN SCRIPT:\n\`\`\`oakscript\n${BROKEN_SCRIPT}\n\`\`\`` : prompt;

  let code = '';
  let rounds = 0;
  let drafts = 0;
  let briefAttempts = 0;
  let briefFallback = false;
  let repairs: string[] = [];
  let notes: string[] = [];
  let pipelineError = '';

  try {
    if (id === 5) {
      const edited = await editScriptWithGates({
        request: prompt,
        source: BROKEN_SCRIPT,
        chat: pipelineChat,
        prefer3D,
        maxRounds: 3,
      });
      code = edited.finalCode;
      rounds = edited.rounds;
      drafts = 1;
      repairs = edited.repairs;
      if (!edited.valid) pipelineError = edited.grade.problems.slice(0, 3).join(' | ');
    } else {
      const generated = await generateIndicatorWithGates({
        request: fullPrompt,
        chat: pipelineChat,
        prefer3D,
        maxRounds: 3,
        bestOf: 2,
      });
      code = generated.finalCode;
      rounds = generated.rounds;
      drafts = generated.drafts;
      briefAttempts = generated.briefAttempts;
      briefFallback = generated.briefFallback;
      repairs = generated.repairs;
      notes = generated.notes;
      if (!generated.grade.valid) pipelineError = generated.grade.problems.slice(0, 3).join(' | ');
    }
  } catch (e: any) {
    pipelineError = String(e?.message || e).slice(0, 500);
  }

  // Independent re-grade: the harness does not trust the pipeline's verdict.
  const clusterProblems = code ? probeSignalClustering(code) : [];
  const problems = code
    ? [
        ...validate(code).issues
          .filter(i => i.severity === 'error')
          .map(i => `[${i.code}] ${i.message}`),
        ...checkRequestCoverage(fullPrompt, code, { prefer3D, previousSource: id === 5 ? BROKEN_SCRIPT : undefined }),
        ...clusterProblems,
      ]
    : ['NO_CODE'];
  if (pipelineError && problems.length === 0) problems.push(`PIPELINE: ${pipelineError}`);

  const checks: Record<string, boolean> = { hasCode: !!code, validAndCoverageClean: problems.length === 0, clusterFree: clusterProblems.length === 0 };
  // Asserts run on comment-stripped code — a model explaining the defect
  // it fixed ("// was: close[-1]") must not trip the defect detectors.
  const stripped = code.split('\n').map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; }).join('\n');
  Object.assign(checks, code ? asserts(stripped) : {});
  if (code) {
    try {
      const res = executeScript(parse(code), barsObj as any, new Map());
      checks.executesClean = res.errors.length === 0;
      const shapes = res.plots.filter(p => p.type === 'shape');
      checks.shapesSparse = shapes.length <= 60;
      checks.shapesAligned = shapes.every(s => {
        const b = typeof s.barIdx === 'number' ? barsArr[s.barIdx] : undefined;
        return !!b && typeof s.price === 'number' && s.price >= b.low - 1e-9 && s.price <= b.high + 1e-9;
      });
    } catch (e: any) {
      checks.executesClean = false;
      problems.push('EXEC: ' + String(e?.message || e).slice(0, 120));
    }
  }
  const pass = Object.values(checks).every(Boolean);
  return {
    id,
    pass,
    rounds,
    drafts,
    briefAttempts,
    briefFallback,
    repairs,
    notes: notes.length > 0 ? notes : undefined,
    checks,
    problems: problems.slice(0, 8),
    codeLen: code.length,
    code,
    replyHead: code ? undefined : pipelineError.slice(0, 600),
    ms: Date.now() - started,
  };
}

const distinctSources = (code: string) => new Set([...code.matchAll(/plot3d\s*\(\s*([^,]+),/g)].map(m => m[1].trim())).size;
const plot3dCount = (code: string) => (code.match(/plot3d\s*\(/g) || []).length;

const ASSERTS: Array<(code: string) => Record<string, boolean>> = [
  (code) => ({
    twoIndependentReadings: distinctSources(code) >= 2 || (code.match(/(?<![\w.])plot\s*\(/g) || []).length >= 2,
    hasMainSignals: /(?<![\w.])plotshape\s*\(/.test(code),
    layersSane: plot3dCount(code) >= 1 && plot3dCount(code) <= 3,
    noTable: !/table\.new\s*\(/.test(code),
    releaseGated: /crossover|crossunder|barssince|var\s|release|loaded\[1\]/.test(code),
  }),
  (code) => ({
    marginAndDisagreement: distinctSources(code) >= 2 || (code.match(/plot\s*\(/g) || []).length >= 2,
    agreementGate: /\band\b/.test(code),
    hasMainSignals: /(?<![\w.])plotshape\s*\(/.test(code),
    noTable: !/table\.new\s*\(/.test(code),
  }),
  (code) => ({
    modelExecution: /model\.(longEntry|entry|shortEntry)\s*\(/.test(code) && /model\.(longExit|exit|shortExit)\s*\(/.test(code),
    hardStop: /model\.stopLoss\s*\(/.test(code),
    confirmedHTF: /security\s*\(\s*"1h"/.test(code),
    noDecorative3D: plot3dCount(code) === 0,
    hasMainSignals: /(?<![\w.])plotshape\s*\(/.test(code),
  }),
  (code) => ({
    pocAndValue: /poc|median\s*\(|highest\s*\(|lowest\s*\(/i.test(code),
    terrain3D: /plot3d\s*\([^)]*"(ridgeline|surface|manifold)"/.test(code),
    twoDTwin: /(?<![\w.])plot\s*\(/.test(code),
    layersSane: plot3dCount(code) <= 3,
  }),
  (code) => ({
    noFutureIndex: !/\[\s*-\d/.test(code),
    noFrozenVar: !/var\s+\w+\s*=\s*(highest|lowest|sma|ema|rsi)\s*\(/.test(code),
    noPineSignature: !/plotshape\s*\(\s*(true|false)\b/.test(code) && !/shape\./.test(code),
    oscillatorNotInPriceScene: !/plot3d\s*\([^)]*"3d"/.test(code) || !/\b(rsi|cci|macd)\s*\(/.test(code),
  }),
];

interface PromptSpec {
  id: number;
  prompt: string;
  asserts: (code: string) => Record<string, boolean>;
}

/** Final prompts keep ids 1-5 and their asserts. Extreme prompts use ids 6+ and
 *  only the generic checks (validation, coverage, clustering, execution, sparsity). */
const ONLY = (flagValue('--only') ?? '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isInteger(n) && n > 0);

const PROMPT_SET: PromptSpec[] = [
  ...(SET === 'extreme' ? [] : FINAL_LIMIT_PROMPTS.map((prompt, i) => ({ id: i + 1, prompt, asserts: ASSERTS[i] }))),
  ...(SET === 'final' ? [] : EXTREME_LIMIT_PROMPTS.map((prompt, i) => ({ id: 6 + i, prompt, asserts: (): Record<string, boolean> => ({}) }))),
].filter(p => ONLY.length === 0 || ONLY.includes(p.id));
if (PROMPT_SET.length === 0) throw new Error('--only selected no prompts in this set');

type Role = { provider: string; model: string; source: 'override' | 'saved' };
interface Roles { coder: Role; advisor: Role }
interface SavedRoles {
  llm_coder_provider: string | null;
  llm_coder_model: string | null;
  llm_provider: string | null;
  llm_trade_advisor_model: string | null;
}
interface RunContext { modelNote: string; roles: Roles; savedRoles: SavedRoles }
interface ProviderInfo { id: string; configured: boolean; model: string; default_model: string }

async function getJson(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} failed: HTTP ${r.status}`);
  return r.json();
}

function hostedModel(providers: ProviderInfo[], pid: string, model: string): string {
  if (model && model !== 'auto') return model;
  const p = providers.find(x => x.id === pid);
  return p ? p.model || p.default_model || '' : model;
}

function overrideRole(name: string, provider: string, model: string | undefined, providers: ProviderInfo[]): Role {
  const p = providers.find(x => x.id === provider);
  if (!p) throw new Error(`--${name}-provider must be a hosted provider (got "${provider}")`);
  if (!p.configured) throw new Error(`No API key is saved for "${provider}" on this PC.`);
  return { provider, model: hostedModel(providers, provider, model ?? ''), source: 'override' };
}

function savedRole(provider: string, model: string, providers: ProviderInfo[]): Role {
  return { provider, model: hostedModel(providers, provider, model), source: 'saved' };
}

async function resolveRoles(): Promise<{ roles: Roles; savedRoles: SavedRoles }> {
  const s = await getJson('/api/settings');
  const { providers } = await getJson('/api/llm/providers') as { providers: ProviderInfo[] };
  const roles: Roles = {
    coder: CODER_PROVIDER
      ? overrideRole('coder', CODER_PROVIDER, CODER_MODEL, providers)
      : savedRole(String(s.llm_coder_provider || s.llm_provider || 'local'), String(s.llm_coder_model || 'auto'), providers),
    advisor: ADVISOR_PROVIDER
      ? overrideRole('advisor', ADVISOR_PROVIDER, ADVISOR_MODEL, providers)
      : savedRole(String(s.llm_provider || 'local'), String(s.llm_trade_advisor_model || 'auto'), providers),
  };
  const savedRoles: SavedRoles = {
    llm_coder_provider: s.llm_coder_provider ?? null,
    llm_coder_model: s.llm_coder_model ?? null,
    llm_provider: s.llm_provider ?? null,
    llm_trade_advisor_model: s.llm_trade_advisor_model ?? null,
  };
  return { roles, savedRoles };
}

function describeRoles(roles: Roles): string {
  const d = (name: string, r: Role) => `${name} ${r.provider}/${r.model || 'auto'} (${r.source})`;
  return `${d('coder', roles.coder)} · ${d('advisor', roles.advisor)}`;
}

/** Refuses to overwrite a result file that records a different label. */
function guardFile(file: string): void {
  if (!existsSync(file)) return;
  let prior: any;
  try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} exists and is not valid JSON; refusing to overwrite it.`); }
  if (prior?.label !== undefined && prior.label !== label) {
    throw new Error(`${file} belongs to label "${prior.label}"; refusing to overwrite it with label "${label}".`);
  }
}

function writeResult(file: string, data: unknown): void {
  guardFile(file);
  writeFileSync(file, JSON.stringify(data, null, 2));
}

interface RunRecord extends RunContext {
  label: string;
  run: number;
  at: string;
  pass: boolean;
  ms: number;
  results: Grade[];
}

interface Summary extends RunContext {
  label: string;
  set: string;
  at: string;
  repeat: number;
  runsCompleted: number;
  allPassRuns: number;
  currentStreak: number;
  bestStreak: number;
  perPrompt: Array<{ id: number; passes: number; runs: number; notRun: number; failures: number }>;
  runPasses: boolean[];
}

function summarize(labelName: string, runs: RunRecord[], ctx: RunContext): Summary {
  let current = 0;
  let best = 0;
  for (const run of runs) {
    if (run.pass) {
      current++;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return {
    label: labelName,
    set: SET,
    at: new Date().toISOString(),
    modelNote: ctx.modelNote,
    roles: ctx.roles,
    savedRoles: ctx.savedRoles,
    repeat: REPEAT,
    runsCompleted: runs.length,
    allPassRuns: runs.filter(r => r.pass).length,
    currentStreak: current,
    bestStreak: best,
    perPrompt: PROMPT_SET.map(spec => {
      // Score only runs where this prompt executed. Under --fail-fast later
      // prompts never run, and counting them as failures misreports the suite.
      const executed = runs.filter(r => r.results.some(x => x.id === spec.id)).length;
      const passes = runs.filter(r => r.results.find(x => x.id === spec.id)?.pass).length;
      return { id: spec.id, passes, runs: executed, notRun: runs.length - executed, failures: executed - passes };
    }),
    runPasses: runs.map(r => r.pass),
  };
}

async function main(): Promise<void> {
  const runFile = (n: number) => `tools/verify/final-limit-results-${label}-run-${n}.json`;
  const summaryFile = `tools/verify/final-limit-results-${label}-summary.json`;
  for (let n = 1; n <= REPEAT; n++) guardFile(runFile(n));
  guardFile(summaryFile);

  const { roles, savedRoles } = await resolveRoles();
  const ctx: RunContext = { modelNote: describeRoles(roles), roles, savedRoles };
  console.log(`[${label}] live acceptance · set=${SET} (${PROMPT_SET.length} prompts) · repeat=${REPEAT} · backend=${BASE}${FAIL_FAST ? ' · fail-fast' : ''}`);
  console.log(`[${label}] models: ${ctx.modelNote}`);
  const runs: RunRecord[] = [];

  for (let runNo = 1; runNo <= REPEAT; runNo++) {
    const runStarted = Date.now();
    const results: Grade[] = [];
    console.log(`\n[${label}] ── run ${runNo}/${REPEAT} ──`);
    for (let i = 0; i < PROMPT_SET.length; i++) {
      const spec = PROMPT_SET[i];
      process.stdout.write(`[${label}] run ${runNo} prompt ${i + 1}/${PROMPT_SET.length} … `);
      try {
        const g = await runOne(spec.id, spec.prompt, spec.asserts);
        results.push(g);
        const meta = `brief=${g.briefAttempts}${g.briefFallback ? '!' : ''} drafts=${g.drafts} fixes=${g.rounds}`;
        console.log(`${g.pass ? 'PASS' : 'FAIL'} (${meta}) ${JSON.stringify(g.checks)}`);
        if (!g.pass) g.problems.forEach(p => console.log(`   - ${p.slice(0, 180)}`));
        if (g.repairs.length > 0) console.log(`   ~ mechanical: ${g.repairs.slice(0, 4).join('; ').slice(0, 240)}`);
      } catch (e: any) {
        console.log('ERROR ' + String(e?.message || e).slice(0, 200));
        results.push({
          id: spec.id, pass: false, rounds: 0, drafts: 0, briefAttempts: 0,
          briefFallback: false, repairs: [], checks: { transport: false },
          problems: [String(e?.message || e)], codeLen: 0, ms: 0,
        });
      }
      if (FAIL_FAST && !results[results.length - 1].pass) break;
    }

    const pass = results.length === PROMPT_SET.length && results.every(r => r.pass);
    const record: RunRecord = { ...ctx, label, run: runNo, at: new Date().toISOString(), pass, ms: Date.now() - runStarted, results };
    runs.push(record);
    const file = runFile(runNo);
    writeResult(file, record);
    console.log(`[${label}] run ${runNo}: ${pass ? `PASS ${PROMPT_SET.length}/${PROMPT_SET.length}` : `FAIL ${results.filter(r => r.pass).length}/${PROMPT_SET.length}`} · ${(record.ms / 1000).toFixed(1)}s · → ${file}`);

    if (FAIL_FAST && !pass) {
      console.log(`[${label}] fail-fast: stopping after failed run ${runNo}.`);
      break;
    }
  }

  const summary = summarize(label, runs, ctx);
  writeResult(summaryFile, summary);
  console.log(`\n[${label}] all-pass runs ${summary.allPassRuns}/${summary.runsCompleted} · current streak ${summary.currentStreak} · best ${summary.bestStreak}`);
  console.log(`[${label}] per-prompt: ${summary.perPrompt.map(p => `#${p.id} ${p.passes}/${p.runs}`).join(' · ')}`);
  console.log(`[${label}] summary → ${summaryFile}`);
  process.exit(summary.currentStreak >= REPEAT && summary.allPassRuns === REPEAT ? 0 : 1);
}

void main();
