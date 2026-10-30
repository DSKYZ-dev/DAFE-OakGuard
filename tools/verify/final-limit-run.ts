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
 *
 *   final    the 5 original limit prompts (default)
 *   extreme  the 6 extreme-limit prompts (extreme-limit-prompts.ts)
 *   all      both sets, 11 prompts per run
 *
 * Writes:
 *   tools/verify/final-limit-results-<label>-run-<n>.json
 *   tools/verify/final-limit-results-<label>-summary.json
 */
import { writeFileSync } from 'node:fs';
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

const BASE = process.env.DAFE_BACKEND || 'http://127.0.0.1:8788';

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}
let label = 'run';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--repeat' || a === '--set') { i++; continue; }
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

async function chatAs(agent: string, message: string): Promise<string> {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, message }),
  });
  const d: any = await r.json();
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
const PROMPT_SET: PromptSpec[] = [
  ...(SET === 'extreme' ? [] : FINAL_LIMIT_PROMPTS.map((prompt, i) => ({ id: i + 1, prompt, asserts: ASSERTS[i] }))),
  ...(SET === 'final' ? [] : EXTREME_LIMIT_PROMPTS.map((prompt, i) => ({ id: 6 + i, prompt, asserts: (): Record<string, boolean> => ({}) }))),
];

interface RunRecord {
  run: number;
  at: string;
  pass: boolean;
  ms: number;
  results: Grade[];
}

interface Summary {
  label: string;
  set: string;
  at: string;
  modelNote: string;
  repeat: number;
  runsCompleted: number;
  allPassRuns: number;
  currentStreak: number;
  bestStreak: number;
  perPrompt: Array<{ id: number; passes: number; runs: number; failures: number }>;
  runPasses: boolean[];
}

function summarize(labelName: string, runs: RunRecord[]): Summary {
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
    modelNote: 'live Meta / muse-spark-1.3 via configured backend roles',
    repeat: REPEAT,
    runsCompleted: runs.length,
    allPassRuns: runs.filter(r => r.pass).length,
    currentStreak: current,
    bestStreak: best,
    perPrompt: PROMPT_SET.map(spec => {
      const passes = runs.filter(r => r.results.find(x => x.id === spec.id)?.pass).length;
      return { id: spec.id, passes, runs: runs.length, failures: runs.length - passes };
    }),
    runPasses: runs.map(r => r.pass),
  };
}

async function main(): Promise<void> {
  console.log(`[${label}] live acceptance · set=${SET} (${PROMPT_SET.length} prompts) · repeat=${REPEAT} · backend=${BASE}${FAIL_FAST ? ' · fail-fast' : ''}`);
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
    const record: RunRecord = { run: runNo, at: new Date().toISOString(), pass, ms: Date.now() - runStarted, results };
    runs.push(record);
    const file = `tools/verify/final-limit-results-${label}-run-${runNo}.json`;
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(`[${label}] run ${runNo}: ${pass ? `PASS ${PROMPT_SET.length}/${PROMPT_SET.length}` : `FAIL ${results.filter(r => r.pass).length}/${PROMPT_SET.length}`} · ${(record.ms / 1000).toFixed(1)}s · → ${file}`);

    if (FAIL_FAST && !pass) {
      console.log(`[${label}] fail-fast: stopping after failed run ${runNo}.`);
      break;
    }
  }

  const summary = summarize(label, runs);
  const summaryFile = `tools/verify/final-limit-results-${label}-summary.json`;
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`\n[${label}] all-pass runs ${summary.allPassRuns}/${summary.runsCompleted} · current streak ${summary.currentStreak} · best ${summary.bestStreak}`);
  console.log(`[${label}] per-prompt: ${summary.perPrompt.map(p => `#${p.id} ${p.passes}/${p.runs}`).join(' · ')}`);
  console.log(`[${label}] summary → ${summaryFile}`);
  process.exit(summary.currentStreak >= REPEAT && summary.allPassRuns === REPEAT ? 0 : 1);
}

void main();
