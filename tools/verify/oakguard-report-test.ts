/**
 * OakGuard pipeline and report — headless checks.
 * Run: npm run verify:oakguard (chained after the evaluator checks)
 *
 * Drives the same runOakGuard() the Crucible window uses, then checks the
 * outcomes, that a second run changes nothing, and that the report is
 * complete, honest and escaped.
 */
import { runOakGuard, STEP_TITLES } from '../../apps/web/src/oakguard/pipeline';
import { buildOakGuardReport, escapeHtml } from '../../apps/web/src/oakguard/report';
import { ASSISTANT_RULES } from '../../apps/web/src/oakguard/assistant';
import { getIndicators } from '../../apps/web/src/oakscript/indicators';
import type { PlaybookState } from '../../apps/web/src/oakguard/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : ''}`);
  if (!cond) failures++;
}

const fresh: PlaybookState = { version: 1, activeRuleIds: [], promotions: [], emeritus: [] };
const scripts = getIndicators().map(i => ({ name: i.name, source: i.source }));
console.log('OakGuard pipeline and report\n');

// 1. One full run from a clean playbook.
const first = await runOakGuard({ state: fresh, scripts });
check('all eight steps finish', first.steps.length === STEP_TITLES.length && first.steps.every(s => s.status === 'done'), first.steps.map(s => s.status));
const byId = new Map(first.candidates.map(c => [c.rule.id, c]));
check('length rule is promoted', byId.get('cand-length-v1')?.outcome === 'promoted');
check('naive dotted rule is archived', byId.get('cand-dotted-naive-v1')?.outcome === 'rejected');
check('refined dotted rule is promoted', byId.get('cand-dotted-refined-v1')?.outcome === 'promoted');
check('playbook advanced to v3 (two promotions)', first.playbook.version === 3, first.playbook.version);
check('the new playbook catches the seed', first.reRun.caughtBy.includes('INVALID_LENGTH_ARG'), first.reRun.caughtBy);
check('the auto-fixed seed is finite on most bars (warm-up NaNs included)', first.reRun.fixedFiniteRatio >= 0.8, first.reRun.fixedFiniteRatio);
check('CCI dependents return to probation', first.assistant.invalidated.length === 2, first.assistant.invalidated);
check('every assistant rule is re-certified', first.assistant.certified === ASSISTANT_RULES.length, first.assistant.certified);

// 2. A second run from the resulting playbook must change nothing.
const second = await runOakGuard({ state: first.playbook, scripts });
check('second run does not change the playbook version', second.playbook.version === first.playbook.version, second.playbook.version);
check('second run promotes nothing new', second.candidates.every(c => c.outcome !== 'promoted'));
check('second run archives no duplicate', second.candidates.every(c => c.outcome !== 'rejected') && second.playbook.emeritus.length === first.playbook.emeritus.length);
check('promoted rules stay active', second.candidates.filter(c => c.outcome === 'active').length === 2);

// 3. The report is complete, labelled and honest.
const html = buildOakGuardReport(first, new Date('2026-10-30T12:00:00Z'));
check('report is a complete HTML document', html.startsWith('<!doctype html>') && html.trimEnd().endsWith('</html>'));
check('report carries the corpus fingerprint', html.includes(first.manifest.manifestHash));
check('report names every candidate', first.candidates.every(c => html.includes(escapeHtml(c.rule.name))));
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
