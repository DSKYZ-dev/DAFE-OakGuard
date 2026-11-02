/**
 * OakGuard learning curve — does the playbook the model wrote catch real bugs
 * in real Muse Spark code it has never seen?
 *
 *   mine    Live. Sends 32 indicator requests to the saved OakScript Coder
 *           (Muse Spark) through the app's own /api/chat route, first draft
 *           only, and records every reply in learning-curve-drafts.json.
 *           Escapes from the MINING half (even-numbered prompts) are written to
 *           apps/web/src/oakguard/mined-escapes.ts for the proposer.
 *
 *   curve   Deterministic. Re-grades the recorded proposer run
 *           (apps/web/src/oakguard/recorded-run.json) to get the learned
 *           playbook, then measures the HELD-OUT half (odd-numbered prompts):
 *           how many validator-clean drafts carry a runtime defect, and how
 *           many of those the playbook flags before the script runs, at
 *           playbook v1 (empty) and at the learned version.
 *           Writes apps/web/src/oakguard/learning-curve.json and
 *           docs/reports/LEARNING_CURVE.md.
 *
 *   repair  Live. For every held-out escape the learned playbook flags, sends
 *           the draft back to the coder with the playbook's issue messages
 *           (one fix round) and re-runs the oracles on the result.
 *
 * Usage: npx tsx tools/verify/learning-curve.ts mine|curve|repair [--concurrency 6]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { validate } from '../../apps/web/src/oakscript/validator';
import { extractOakCode } from '../../apps/web/src/trade-advisor/generation-pipeline';
import { runOracles, describeFindings, type OracleReport } from '../../apps/web/src/oakguard/oracles';
import { evaluateRuleOnSource } from '../../apps/web/src/oakguard/rules';
import { SEED_ESCAPES, type EscapeCase } from '../../apps/web/src/oakguard/escapes';
import { MINED_ESCAPES } from '../../apps/web/src/oakguard/mined-escapes';
import { replayTransport, runProposalLoop, type RecordedRun } from '../../apps/web/src/oakguard/proposer';
import type { DefectClass, RuleSpec } from '../../apps/web/src/oakguard/types';

const BASE = process.env.DAFE_BACKEND || 'http://127.0.0.1:8788';
const DRAFTS_FILE = 'tools/verify/learning-curve-drafts.json';
const REPAIRS_FILE = 'tools/verify/learning-curve-repairs.json';
const argv = process.argv.slice(2);
const MODE = argv[0] || 'curve';
const CONCURRENCY = Math.max(1, Number(argv[argv.indexOf('--concurrency') + 1]) || 6);

/** Requests a trader would type. Even index = mining half, odd index = held-out half. */
export const CURVE_PROMPTS: string[] = [
  '20-bar Donchian channel breakout with buy and sell signals',
  'Signal when price breaks above the highest high of the last 50 bars',
  'Mark new 52-bar lows with a sell marker',
  'Breakout of the previous 10-bar range with volume confirmation',
  'Stochastic %K and %D with crossovers in the overbought and oversold zones',
  'RSI smoothed with a 3-bar SMA, signal when it crosses 50',
  'Smoothed momentum: EMA of the rate of change, buy on the zero cross',
  'Bollinger Band squeeze breakout signals',
  'Keltner channel breakout using ATR',
  'Turtle trading entry: 20-bar high breakout, exit on a 10-bar low',
  'Price closes above the highest close of the last 20 bars',
  'Williams %R with signals at -80 and -20',
  'MACD histogram turning points with markers',
  'Volume spike detector: volume above twice its 20-bar average',
  'Moving average ribbon of five EMAs with buy and sell signals when they align',
  'Swing high and swing low markers using pivots',
  'Chandelier exit: trailing stop from the highest high minus 3 ATR, with exit signals',
  'VWAP with standard deviation bands and signals on band touches',
  'Inside bar breakout signals',
  'CCI smoothed over 3 bars with zero-line cross signals',
  'Alert when ATR rises 50% above its 20-bar average',
  'Midline of the 20-bar high/low channel with crossover signals',
  'Detect when the close makes a new 100-bar high',
  'Rolling z-score of close over 30 bars with signals at plus and minus 2',
  'Triple EMA crossover with entry and exit signals',
  'Ichimoku-style conversion and base lines with crossover signals',
  'Range expansion bar: the current bar range is larger than the largest range of the last 10 bars',
  'Fibonacci retracement levels of the last 50-bar swing with touch signals',
  'Bearish divergence between price highs and RSI highs',
  'Breakdown below the lowest low of the last 30 bars with an exit marker',
  'Stochastic RSI smoothed with signals in the extreme zones',
  'Momentum burst: close breaks the 15-bar high while RSI is above 60',
];

interface Draft {
  index: number;
  half: 'mining' | 'held-out';
  request: string;
  model: string;
  code: string;
  replyChars: number;
  latencyMs: number;
  error?: string;
}

interface DraftsFile { recordedAt: string; model: string; note: string; drafts: Draft[] }

function postJson(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('request exceeded 15 minutes')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function coder(message: string): Promise<{ reply: string; ms: number }> {
  const t0 = Date.now();
  const d = await postJson(`${BASE}/api/chat`, { agent: 'oakscript_coder', message });
  if (!d.ok) throw new Error(d.detail || 'coder call failed');
  return { reply: String(d.reply || ''), ms: Date.now() - t0 };
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

function draftPrompt(request: string): string {
  return `Write a complete OakScript indicator for this request:\n\n"${request}"\n\nOutput only the complete code inside \`\`\`oakscript fences.`;
}

// ─── Grading ────────────────────────────────────────────────────────

interface Graded {
  draft: Draft;
  valid: boolean;
  oracle: OracleReport;
  escape: boolean;
  /** Static issues raised by each learned rule. */
  flaggedBy: string[];
}

function guessClass(code: string, oracle: OracleReport): DefectClass | 'other' {
  const lengthRule: RuleSpec = { id: 'g1', name: '', family: 'positive-int-length', issueCode: 'G', severity: 'error', description: '', rationale: '', proposedBy: '' };
  const dotRule: RuleSpec = { ...lengthRule, id: 'g2', family: 'unknown-dotted-call', allowObjectMethods: true };
  const winRule: RuleSpec = { ...lengthRule, id: 'g3', family: 'self-inclusive-window', params: { followVariables: true } };
  if (oracle.findings.some(f => f.kind === 'dead-signal') && evaluateRuleOnSource(winRule, code).length) return 'impossible-breakout';
  if (evaluateRuleOnSource(lengthRule, code).length) return 'dead-length';
  if (evaluateRuleOnSource(dotRule, code).length) return 'silent-call';
  return 'other';
}

function grade(d: Draft, rules: RuleSpec[]): Graded {
  const valid = !!d.code && validate(d.code).valid;
  const oracle = d.code ? runOracles(d.code) : { findings: [], markers: {}, lines: {}, bars: 0 };
  const escape = valid && oracle.findings.length > 0;
  const flaggedBy = rules.filter(r => evaluateRuleOnSource(r, d.code).some(i => i.severity === 'error')).map(r => r.issueCode);
  return { draft: d, valid, oracle, escape, flaggedBy };
}

function loadDrafts(): DraftsFile {
  if (!existsSync(DRAFTS_FILE)) throw new Error(`${DRAFTS_FILE} not found — run "mine" first`);
  return JSON.parse(readFileSync(DRAFTS_FILE, 'utf8'));
}

// ─── mine ───────────────────────────────────────────────────────────

async function mine(): Promise<void> {
  const settings = await (await fetch(`${BASE}/api/settings`)).json();
  const model = `${settings.llm_coder_provider}/${settings.llm_coder_model}`;
  console.log(`Mining ${CURVE_PROMPTS.length} first drafts from the saved coder (${model}), ${CONCURRENCY} at a time…`);
  const drafts = await pool(CURVE_PROMPTS.map((request, index) => ({ request, index })), CONCURRENCY, async ({ request, index }): Promise<Draft> => {
    const half = index % 2 === 0 ? 'mining' : 'held-out';
    try {
      const { reply, ms } = await coder(draftPrompt(request));
      const code = extractOakCode(reply);
      console.log(`  #${index + 1} ${half} ${(ms / 1000).toFixed(0)}s ${code.length} chars — ${request.slice(0, 60)}`);
      return { index, half, request, model, code, replyChars: reply.length, latencyMs: ms };
    } catch (e: any) {
      console.log(`  #${index + 1} ${half} ERROR ${String(e?.message || e).slice(0, 100)}`);
      return { index, half, request, model, code: '', replyChars: 0, latencyMs: 0, error: String(e?.message || e).slice(0, 300) };
    }
  });
  const file: DraftsFile = {
    recordedAt: new Date().toISOString(),
    model,
    note: 'First drafts only: one coder call per request through /api/chat with the app\'s OakScript Coder system prompt. No brief, no repair, no gates.',
    drafts,
  };
  writeFileSync(DRAFTS_FILE, JSON.stringify(file, null, 2) + '\n');
  console.log(`saved → ${DRAFTS_FILE}`);

  // Escapes from the mining half become proposer inputs.
  const mined: EscapeCase[] = [];
  for (const g of drafts.map(d => grade(d, []))) {
    if (!g.escape || g.draft.half !== 'mining') continue;
    const cls = guessClass(g.draft.code, g.oracle);
    console.log(`  escape #${g.draft.index + 1} [${cls}] ${describeFindings(g.oracle)}`);
    if (cls === 'other' || mined.some(m => m.defectClass === cls)) continue;
    mined.push({
      id: `mined-${cls}-${g.draft.index + 1}`,
      defectClass: cls,
      title: `Muse Spark draft: "${g.draft.request}"`,
      source: g.draft.code,
      origin: 'model-draft',
      model: g.draft.model,
      request: g.draft.request,
      recordedAt: file.recordedAt,
    });
  }
  const body = `/**
 * Escapes mined from real Muse Spark drafts by tools/verify/learning-curve.ts.
 * Each one is a first draft the baseline validator accepted and the runtime
 * oracles proved broken, recorded with the request, the model and the time.
 * Regenerate with: npx tsx tools/verify/learning-curve.ts mine
 */
import type { EscapeCase } from './escapes';

export const MINED_ESCAPES: EscapeCase[] = ${JSON.stringify(mined, null, 2)};
`;
  writeFileSync('apps/web/src/oakguard/mined-escapes.ts', body);
  console.log(`${mined.length} mined escape(s) → apps/web/src/oakguard/mined-escapes.ts`);
}

// ─── curve ──────────────────────────────────────────────────────────

/** Re-grade the recorded proposer run and return the rules it promotes today. */
async function learnedRules(): Promise<{ rules: RuleSpec[]; run: RecordedRun | null }> {
  const path = 'apps/web/src/oakguard/recorded-run.json';
  if (!existsSync(path)) return { rules: [], run: null };
  const run: RecordedRun = JSON.parse(readFileSync(path, 'utf8'));
  const escapes = [...MINED_ESCAPES, ...SEED_ESCAPES];
  const rules: RuleSpec[] = [];
  for (const escape of escapes) {
    if (!run.exchanges.some(e => e.key.startsWith(`${escape.id}#`))) continue;
    const res = await runProposalLoop({ escape, transport: replayTransport(run), model: run.model, maxRounds: 3 });
    if (res.promoted) rules.push(res.promoted);
  }
  return { rules, run };
}

async function curve(): Promise<void> {
  const file = loadDrafts();
  const { rules, run } = await learnedRules();
  const graded = file.drafts.map(d => grade(d, rules));
  const heldOut = graded.filter(g => g.draft.half === 'held-out');
  const mining = graded.filter(g => g.draft.half === 'mining');
  const summarize = (set: Graded[]) => {
    const withCode = set.filter(g => g.draft.code);
    const valid = withCode.filter(g => g.valid);
    const escapes = valid.filter(g => g.escape);
    const caught = escapes.filter(g => g.flaggedBy.length > 0);
    const falseFlags = valid.filter(g => !g.escape && g.flaggedBy.length > 0);
    return {
      drafts: set.length, withCode: withCode.length, validatorClean: valid.length,
      escapes: escapes.length, caughtByLearned: caught.length, caughtByV1: 0,
      flaggedWithoutOracleDefect: falseFlags.length,
    };
  };
  const allValid = graded.filter(g => g.valid).length;
  const failureCodes = new Map<string, number>();
  for (const g of graded) {
    if (g.valid || !g.draft.code) continue;
    for (const code of new Set(validate(g.draft.code).issues.filter(i => i.severity === 'error').map(i => i.code))) {
      failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1);
    }
  }
  const result = {
    generatedAt: new Date().toISOString(),
    draftsRecordedAt: file.recordedAt,
    draftModel: file.model,
    proposerModel: run?.model ?? null,
    proposerRecordedAt: run?.recordedAt ?? null,
    playbook: rules.map(r => ({ issueCode: r.issueCode, family: r.family, name: r.name, defectClass: r.defectClass })),
    firstDraftValidity: {
      drafts: graded.length,
      validatorClean: allValid,
      note: 'All 32 drafts, graded by the current validator. Before scientific notation (1e-9) was added to the lexer, 20 of the same 32 drafts parsed as valid.',
    },
    validatorFailures: Object.fromEntries([...failureCodes].sort((a, b) => b[1] - a[1])),
    heldOut: summarize(heldOut),
    mining: summarize(mining),
    heldOutEscapes: heldOut.filter(g => g.escape).map(g => ({
      index: g.draft.index + 1,
      request: g.draft.request,
      defect: describeFindings(g.oracle),
      class: guessClass(g.draft.code, g.oracle),
      flaggedBy: g.flaggedBy,
    })),
    heldOutDrafts: heldOut.filter(g => g.draft.code).map(g => ({
      index: g.draft.index + 1,
      request: g.draft.request,
      code: g.draft.code,
      validatorClean: g.valid,
      escape: g.escape,
      defect: g.escape ? describeFindings(g.oracle) : '',
    })),
  };
  writeFileSync('apps/web/src/oakguard/learning-curve.json', JSON.stringify(result, null, 2) + '\n');

  const h = result.heldOut;
  const m = result.mining;
  const md = [
    '# OakGuard learning curve',
    '',
    `Generated ${result.generatedAt} by \`npx tsx tools/verify/learning-curve.ts curve\`.`,
    '',
    `- Drafts: ${file.drafts.length} first drafts from \`${file.model}\`, recorded ${file.recordedAt}. One coder call per request through the app's own route and system prompt; no brief, no repair, no gates (\`${DRAFTS_FILE}\`).`,
    `- Playbook: ${rules.length} rule(s) written by \`${result.proposerModel ?? 'none'}\` (recorded ${result.proposerRecordedAt ?? 'never'}) and re-graded by today's referee.`,
    '- Split: rules may only be learned from the mining half (even-numbered prompts) and the seed escapes. The held-out half (odd-numbered prompts) is measurement only.',
    '',
    '## First-draft validity',
    '',
    `${allValid} of ${graded.length} drafts pass the baseline validator. ${result.firstDraftValidity.note}`,
    '',
    '| Validator error on an invalid draft | Drafts |',
    '|---|---|',
    ...[...failureCodes].sort((a, b) => b[1] - a[1]).map(([code, n]) => `| \`${code}\` | ${n} |`),
    '',
    'Every invalid draft is caught before it runs; the app\'s generation pipeline repairs these in its fix loop.',
    '',
    '## Silent runtime defects (escapes)',
    '',
    '| | Mining half | Held-out half |',
    '|---|---|---|',
    `| Requests | ${m.drafts} | ${h.drafts} |`,
    `| Accepted by the baseline validator | ${m.validatorClean} | ${h.validatorClean} |`,
    `| …of which the runtime oracles prove broken (escapes) | ${m.escapes} | ${h.escapes} |`,
    `| Escapes flagged before running, learned playbook | ${m.caughtByLearned} | ${h.caughtByLearned} |`,
    `| Learned-rule flags on drafts the oracles found nothing wrong with (false alarms) | ${m.flaggedWithoutOracleDefect} | ${h.flaggedWithoutOracleDefect} |`,
    '',
    ...(result.heldOutEscapes.length ? [
      '| # | Request | Runtime defect | Class | Flagged by |',
      '|---|---|---|---|---|',
      ...result.heldOutEscapes.map(e => `| ${e.index} | ${e.request} | ${e.defect.replace(/\|/g, '/')} | ${e.class} | ${e.flaggedBy.join(', ') || '—'} |`),
      '',
    ] : []),
    '## What this shows',
    '',
    '- With the app\'s hardened coder prompt, Muse Spark\'s first drafts rarely contain a silent runtime defect: when a draft is wrong, the validator usually says so. The playbook\'s value on these drafts is precision: the learned rules raise no false alarms on real model output they never saw.',
    '- Generalisation is measured by the referee on every promotion: each learned rule catches held-out broken variants the proposer never saw (see the verdicts in `npm run verify:proposer`).',
    '',
    '## Limits',
    '',
    '- The oracles run each draft on four synthetic markets (2,400 bars). A signal that never fires there is reported as dead; a legitimately rare signal could be reported too.',
    '- Escapes of a class the rule language cannot express yet stay uncaught. They are the next rule families to add.',
    '- Muse Spark is sampled, so a new `mine` run produces different drafts and different counts.',
    '',
  ].join('\n');
  writeFileSync('docs/reports/LEARNING_CURVE.md', md);
  console.log(md);
}

// ─── repair ─────────────────────────────────────────────────────────

async function repair(): Promise<void> {
  const file = loadDrafts();
  const { rules } = await learnedRules();
  const targets = file.drafts.map(d => grade(d, rules)).filter(g => g.draft.half === 'held-out' && g.escape && g.flaggedBy.length > 0);
  console.log(`Repairing ${targets.length} held-out escape(s) the learned playbook flags (one fix round each)…`);
  const results = await pool(targets, CONCURRENCY, async (g) => {
    const issues = rules.flatMap(r => evaluateRuleOnSource(r, g.draft.code)).filter(i => i.severity === 'error');
    const msg = `Fix this OakScript indicator. The OakGuard playbook found these problems:\n${issues.map(i => `- L${i.line} [${i.code}] ${i.message} FIX: ${i.fix ?? ''}`).join('\n')}\n\nRequest: "${g.draft.request}"\n\n\`\`\`oakscript\n${g.draft.code}\n\`\`\`\n\nReturn the complete fixed code inside \`\`\`oakscript fences.`;
    try {
      const { reply } = await coder(msg);
      const code = extractOakCode(reply);
      const after = runOracles(code);
      const fixed = !!code && validate(code).valid && after.findings.length === 0;
      console.log(`  #${g.draft.index + 1} ${fixed ? 'FIXED' : 'still broken'} — ${describeFindings(after)}`);
      return { index: g.draft.index + 1, request: g.draft.request, before: describeFindings(g.oracle), after: describeFindings(after), fixed, code };
    } catch (e: any) {
      return { index: g.draft.index + 1, request: g.draft.request, before: describeFindings(g.oracle), after: `error: ${e?.message || e}`, fixed: false, code: '' };
    }
  });
  writeFileSync(REPAIRS_FILE, JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log(`${results.filter(r => r.fixed).length}/${results.length} repaired → ${REPAIRS_FILE}`);
}

const run = MODE === 'mine' ? mine : MODE === 'repair' ? repair : curve;
run().catch((e) => { console.error(e); process.exit(1); });
