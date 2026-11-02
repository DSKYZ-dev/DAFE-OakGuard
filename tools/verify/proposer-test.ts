/**
 * OakGuard proposer, referee and oracles — headless checks, no API key needed.
 * Run: npm run verify:proposer
 *
 *   1. The recorded Muse Wonder run, re-graded by today's referee.
 *   2. Referee self-test: deliberately flawed specs must all be rejected,
 *      whatever a model happens to propose on a given day.
 *   3. Information hygiene: the proposer only ever sees visible variants.
 *   4. Runtime oracles: escapes are broken, the corpus is clean, every
 *      impossible-breakout variant is silent and its [1] fix fires.
 *   5. Engine regressions found by the oracles (crossover cache, NaN-poisoned
 *      sma/ema) and by Muse Spark drafts (scientific notation).
 */
import { validate } from '../../apps/web/src/oakscript/validator';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { StdLib } from '../../apps/web/src/oakscript/runtime';
import { evaluateCandidate } from '../../apps/web/src/oakguard/evaluator';
import { runOracles } from '../../apps/web/src/oakguard/oracles';
import { SEED_ESCAPES } from '../../apps/web/src/oakguard/escapes';
import { CONTRAST_SCRIPTS } from '../../apps/web/src/oakguard/contrast';
import { BREAKOUT_MARKERS, generateBreakoutMutants, generateMutantsForClass, knownGoodCorpus, syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { parseProposal, replayTransport, buildProposerUser, type RecordedRun } from '../../apps/web/src/oakguard/proposer';
import { runOakGuard } from '../../apps/web/src/oakguard/pipeline';
import { setPlaybookOverride } from '../../apps/web/src/oakguard/store';
import { getIndicators } from '../../apps/web/src/oakscript/indicators';
import recorded from '../../apps/web/src/oakguard/recorded-run.json';
import type { PlaybookState, RuleSpec } from '../../apps/web/src/oakguard/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 240) : ''}`);
  if (!cond) failures++;
}
const fresh = (): PlaybookState => ({ version: 1, activeRuleIds: [], promotions: [], emeritus: [], learnedRules: [] });
const run = recorded as unknown as RecordedRun;

// ─── 1. Recorded Muse Wonder run ────────────────────────────────────
console.log(`1 · Recorded run: ${run.model}, ${run.exchanges.length} exchange(s), recorded ${run.recordedAt}\n`);
check('the recorded run was written by a Meta model', /^muse-/.test(run.model) && run.exchanges.every(e => /^muse-/.test(e.model)), run.exchanges.map(e => e.model));
check('every recorded exchange has real token use and cost', run.exchanges.every(e => e.inputTokens > 0 && e.outputTokens > 0 && e.costUsd > 0));
const replay = await runOakGuard({
  state: fresh(),
  scripts: getIndicators().map(i => ({ name: i.name, source: i.source })),
  mode: 'replay',
  transport: replayTransport(run),
  model: run.model,
  recordedAt: run.recordedAt,
  escapes: SEED_ESCAPES,
});
for (const c of replay.candidates) {
  console.log(`  ${c.escapeId} r${c.round}: ${c.rule.family} ${c.rule.issueCode} → ${c.outcome} (variants ${c.report.mutantCaught}/${c.report.mutantTotal}, held-out ${c.report.heldOutCaught}/${c.report.heldOutTotal}, FP ${c.report.falsePositiveCount}/${c.report.goodTotal})`);
}
check('re-graded today, every escape gets a promoted rule', SEED_ESCAPES.every(e => replay.escapes.find(x => x.escape.id === e.id)?.promotedRuleId), replay.escapes.map(e => [e.escape.id, e.promotedRuleId ?? null]));
check('every escape is flagged before it runs after the replay', replay.escapes.every(e => e.caughtAfter.length > 0));
const promoted = replay.candidates.filter(c => c.outcome === 'promoted');
check('promoted rules catch every held-out variant', promoted.every(c => c.report.heldOutCaught === c.report.heldOutTotal && c.report.heldOutTotal > 0));
check('promoted rules raise zero false alarms on the known-good corpus', promoted.every(c => c.report.falsePositiveCount === 0));
check('promoted rules are attributed to the Meta model', promoted.every(c => /^muse-/.test(c.rule.proposal?.model ?? '')));
check('the replay is labelled as a replay, with the recorded cost', replay.proposer.mode === 'replay' && replay.proposer.costUsd > 0, replay.proposer);
setPlaybookOverride(replay.playbook);
const enforced = validate(SEED_ESCAPES[2].source);
setPlaybookOverride(null);
check('the learned playbook makes the validator of record reject the breakout escape', !enforced.valid && enforced.issues.some(i => i.message.includes('OakGuard playbook')), enforced.issues.map(i => i.code));
check('without the learned playbook the same escape is accepted', validate(SEED_ESCAPES[2].source).valid);

// ─── 2. Referee self-test ───────────────────────────────────────────
console.log('\n2 · Referee self-test: flawed specs must be rejected\n');
const base = (over: Partial<RuleSpec>): RuleSpec => ({
  id: `flawed-${Math.random().toString(36).slice(2, 7)}`, name: 'flawed', family: 'self-inclusive-window', issueCode: 'FLAWED_RULE',
  severity: 'error', description: '', rationale: '', proposedBy: 'self-test', defectClass: 'impossible-breakout', ...over,
});
const flawed: Array<[string, RuleSpec, (r: ReturnType<typeof evaluateCandidate>) => boolean]> = [
  ['too narrow: does not follow variables', base({ params: { operators: ['>', '<', 'crossover', 'crossunder'] } }), r => r.mutantCaught < r.mutantTotal && (r.missedVisible?.length ?? 0) > 0],
  ['too narrow: highest() only', base({ params: { windowFunctions: ['highest'], followVariables: true } }), r => r.mutantCaught < r.mutantTotal],
  ['too broad: flags >= and <= (a new N-bar high is legitimate)', base({ params: { operators: ['>', '<', '>=', '<=', 'crossover', 'crossunder'], followVariables: true } }), r => r.falsePositiveNames.some(n => n.startsWith('Contrast'))],
  ['too broad: flags == (the highest close of a window is legitimate)', base({ params: { operators: ['>', '<', '==', 'crossover', 'crossunder'], followVariables: true } }), r => r.falsePositiveNames.some(n => n.startsWith('Contrast'))],
  ['too broad: dotted calls without the object-method allowance', base({ family: 'unknown-dotted-call', defectClass: 'silent-call' }), r => r.falsePositiveCount > 0],
  ['too narrow: length rule for sma() only', base({ family: 'positive-int-length', defectClass: 'dead-length', params: { functions: ['sma'] } }), r => r.mutantCaught < r.mutantTotal],
  ['wrong family for the bug class', base({ family: 'positive-int-length', params: {} }), r => r.mutantCaught < r.mutantTotal],
  ['malformed: reuses a baseline issue code', base({ issueCode: 'FUTURE_INDEX', params: { followVariables: true } }), r => r.reasons.some(x => x.startsWith('Malformed'))],
  ['malformed: unknown builtin in params', base({ family: 'positive-int-length', defectClass: 'dead-length', params: { functions: ['smaa'] } }), r => r.reasons.some(x => x.startsWith('Malformed'))],
];
for (const [label, rule, expectWhy] of flawed) {
  const r = evaluateCandidate(rule);
  check(`rejected · ${label}`, r.verdict === 'rejected' && expectWhy(r), { caught: `${r.mutantCaught}/${r.mutantTotal}`, fp: r.falsePositiveNames.slice(0, 2), reason: r.reasons[0] });
}
const good = evaluateCandidate(base({ params: { operators: ['>', '<', 'crossover', 'crossunder'], followVariables: true } }));
check('promoted · the correct breakout rule', good.verdict === 'promoted', good.reasons[0]);

// ─── 3. Information hygiene ─────────────────────────────────────────
console.log('\n3 · What the proposer is shown\n');
const narrow = evaluateCandidate(flawed[0][1]);
const mutants = generateMutantsForClass('impossible-breakout', knownGoodCorpus());
const visibleDefects = new Set(mutants.filter(m => !m.heldOut).map(m => m.defect));
check('feedback lists only visible variants', (narrow.missedVisible ?? []).every(d => visibleDefects.has(d)), narrow.missedVisible);
const prompt = buildProposerUser(SEED_ESCAPES[2], 'evidence', [{ round: 1, rule: flawed[0][1], report: narrow }]);
check('the revision prompt never contains a held-out variant\'s source', mutants.filter(m => m.heldOut).every(m => !prompt.includes(m.source.slice(-120))));
check('the revision prompt reports held-out misses as a count only', /Held-out variants missed: \d+ \(not shown\)/.test(prompt));
const meta = { model: 'test', round: 1, promptHash: 'x', latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'replay' as const, raw: '' };
check('a non-JSON reply is rejected as unusable', !!parseProposal('not json', { escape: SEED_ESCAPES[0], round: 1, meta }).error);

// ─── 4. Oracles ─────────────────────────────────────────────────────
console.log('\n4 · Runtime oracles\n');
for (const e of SEED_ESCAPES) {
  const o = runOracles(e.source);
  check(`escape ${e.id}: validator accepts it, oracles prove it broken`, validate(e.source).valid && o.findings.length > 0, o.findings.map(f => f.detail));
}
const corpusFindings = knownGoodCorpus().map(c => ({ name: c.name, n: runOracles(c.source).findings.length })).filter(x => x.n > 0);
check('the known-good corpus has no runtime defect', corpusFindings.length === 0, corpusFindings);
for (const c of CONTRAST_SCRIPTS) {
  const o = runOracles(c.source);
  check(`contrast script fires its signals: ${c.name}`, validate(c.source).valid && Object.values(o.markers).every(v => v.some(n => n > 0)), o.markers);
}
const sample = generateBreakoutMutants(knownGoodCorpus()).filter((_, i) => i % 7 === 0);
const silent = sample.filter(m => {
  const o = runOracles(m.source);
  return [...(o.markers[BREAKOUT_MARKERS.up] ?? []), ...(o.markers[BREAKOUT_MARKERS.down] ?? [])].every(n => n === 0);
});
check(`impossible-breakout variants never fire (${sample.length} sampled)`, silent.length === sample.length, sample.length - silent.length);
const fixedFire = sample.filter(m => {
  const fixed = m.source.replace(/(highest|lowest)\((high|low|close), (\d+)\)(?!\[)/g, '$1($2, $3)[1]');
  const o = runOracles(fixed);
  return [...(o.markers[BREAKOUT_MARKERS.up] ?? []), ...(o.markers[BREAKOUT_MARKERS.down] ?? [])].some(n => n > 0);
});
check('their [1] fix fires', fixedFire.length === sample.length, sample.length - fixedFire.length);

// ─── 5. Engine regressions ──────────────────────────────────────────
console.log('\n5 · Engine fixes\n');
const twoCrosses = [
  'f = ema(close, 5)',
  's = ema(close, 20)',
  'upper = highest(high, 20)',
  'if crossover(f, s) { plotshape(bar_index, low, "MA Cross", "triangleup", "#22cc88") }',
  'if crossover(close, upper) { plotshape(bar_index, low, "Impossible", "triangleup", "#ff4477") }',
].join('\n');
const crossPlots = executeScript(parse(twoCrosses), syntheticBars(400) as any, new Map()).plots as any[];
const maCross = crossPlots.filter(p => p.name === 'MA Cross').length;
const impossible = crossPlots.filter(p => p.name === 'Impossible').length;
check('two crossover() calls with variable arguments no longer share one cached result', maCross > 0 && impossible === 0, { maCross, impossible });
const withLead = [NaN, NaN, NaN, 1, 2, 3, 4, 5, 6];
const sm = StdLib.sma(withLead, 3);
check('sma() recovers after leading NaNs (was NaN forever)', Number.isNaN(sm[4]) && sm[5] === 2 && sm[8] === 5, sm);
const em = StdLib.ema(withLead, 3);
check('ema() seeds after leading NaNs (was NaN forever)', Number.isNaN(em[4]) && Math.abs(em[5] - 2) < 1e-9 && Number.isFinite(em[8]), em);
check('sma() with a zero length is still NaN everywhere', StdLib.sma([1, 2, 3], 0).every(Number.isNaN));
check('scientific notation parses (1e-9, 2.5E+3)', validate('x = close / (high - low + 1e-9)\ny = 2.5E+3\nplot(x * y, "X", "#22cc88", 1)').valid);

console.log(failures === 0 ? '\nALL PROPOSER, REFEREE AND ORACLE CHECKS PASS' : `\n${failures} PROPOSER/REFEREE/ORACLE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
