/**
 * OakGuard pipeline and report — headless checks.
 * Run: npm run verify:oakguard (chained after the evaluator checks)
 *
 * Drives the same runOakGuard() the Crucible window uses, here with the
 * hand-written catalogue as the proposer (no model, fully deterministic),
 * then checks the outcomes, that a second run changes nothing, and that the
 * report is complete, honest and escaped. The recorded Muse Wonder run is
 * checked by npm run verify:proposer.
 */
import { runOakGuard, STEP_TITLES } from '../../apps/web/src/oakguard/pipeline';
import { buildOakGuardReport, escapeHtml } from '../../apps/web/src/oakguard/report';
import { ASSISTANT_RULES } from '../../apps/web/src/oakguard/assistant';
import { SEED_ESCAPES } from '../../apps/web/src/oakguard/escapes';
import { getIndicators } from '../../apps/web/src/oakscript/indicators';
import type { PlaybookState } from '../../apps/web/src/oakguard/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : ''}`);
  if (!cond) failures++;
}

const fresh: PlaybookState = { version: 1, activeRuleIds: [], promotions: [], emeritus: [], learnedRules: [] };
const scripts = getIndicators().map(i => ({ name: i.name, source: i.source }));
console.log('OakGuard pipeline and report (catalogue proposer)\n');

// 1. One full run from a clean playbook.
const first = await runOakGuard({ state: fresh, scripts, escapes: SEED_ESCAPES });
check('all eight steps finish', first.steps.length === STEP_TITLES.length && first.steps.every(s => s.status === 'done'), first.steps.map(s => s.status));
check('every escape passes the validator', first.escapes.every(e => e.validatorValid));
check('every escape is broken at runtime', first.escapes.every(e => e.evidence !== 'no runtime defect found'), first.escapes.map(e => e.evidence));
const byId = new Map(first.candidates.map(c => [c.rule.issueCode + '#' + c.round, c]));
check('length rule is promoted in round 1', byId.get('INVALID_LENGTH_ARG#1')?.outcome === 'promoted');
check('naive dotted rule is rejected in round 1', byId.get('UNKNOWN_DOTTED_FUNCTION#1')?.outcome === 'rejected');
check('the rejection carries a counterexample', !!byId.get('UNKNOWN_DOTTED_FUNCTION#1')?.report.counterexampleLine);
check('refined dotted rule is promoted in round 2', byId.get('UNKNOWN_DOTTED_FUNCTION#2')?.outcome === 'promoted');
check('playbook advanced to v3 (two promotions)', first.playbook.version === 3, first.playbook.version);
const caught = first.escapes.filter(e => e.caughtAfter.length > 0).map(e => e.escape.id);
check('the length and dotted escapes are caught after the run', caught.includes('esc-dead-length') && caught.includes('esc-silent-call'), caught);
check('the breakout escape stays uncaught without a model (no catalogue rule)', !caught.includes('esc-impossible-breakout'));
check('no model was paid for', first.proposer.costUsd === 0 && first.proposer.mode === 'catalogue');
check('dependents return to probation when the playbook changes', first.assistant.invalidated.length === 2, first.assistant.invalidated);
check('every assistant rule is re-certified', first.assistant.certified === ASSISTANT_RULES.length, first.assistant.certified);
check('the library scan raises no flags', first.library.flagged.length === 0, first.library.flagged.slice(0, 2));

// 2. A second run from the resulting playbook must change nothing.
const second = await runOakGuard({ state: first.playbook, scripts, escapes: SEED_ESCAPES });
check('second run does not change the playbook version', second.playbook.version === first.playbook.version, second.playbook.version);
check('second run skips escapes the playbook already catches', second.escapes.filter(e => e.alreadyCaughtBy.length > 0).length === 2);
check('second run promotes nothing new', second.candidates.every(c => c.outcome !== 'promoted'));
check('second run archives no duplicate', second.playbook.emeritus.length === first.playbook.emeritus.length);
check('no dependents are invalidated when nothing was promoted', second.assistant.invalidated.length === 0);

// 3. The report is complete, labelled and honest.
const html = buildOakGuardReport(first, new Date('2026-10-30T12:00:00Z'));
check('report is a complete HTML document', html.startsWith('<!doctype html>') && html.trimEnd().endsWith('</html>'));
check('report carries the corpus fingerprint', html.includes(first.manifest.manifestHash));
check('report names every candidate', first.candidates.every(c => html.includes(escapeHtml(c.rule.name))));
check('report shows every escape', first.escapes.every(e => html.includes(escapeHtml(e.escape.title))));
check('report keeps its method and limits section', html.includes('Method and limits'));
check('report states the not-financial-advice disclaimer', html.includes('not financial advice'));

// 4. Escaping: hostile text in a rule name cannot become markup.
const hostile = { ...first, candidates: first.candidates.map((c, i) => (i === 0 ? { ...c, rule: { ...c.rule, name: '<img src=x onerror=alert(1)>' } } : c)) };
const hostileHtml = buildOakGuardReport(hostile, new Date());
check('hostile rule name is escaped, not injected', !hostileHtml.includes('<img src=x') && hostileHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
check('escapeHtml covers the reserved characters', escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');

console.log(failures === 0
  ? '\nALL OAKGUARD PIPELINE AND REPORT CHECKS PASS'
  : `\n${failures} OAKGUARD PIPELINE/REPORT CHECK(S) FAILED`);
if (failures > 0) process.exit(1);
