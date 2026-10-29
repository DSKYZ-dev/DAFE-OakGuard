/**
 * OakGuard headless evaluator — the independent scorekeeper.
 * Run: npm run verify:oakguard
 *
 * Scores every candidate in the catalogue against the frozen corpus and
 * generated mutants. This file is the evaluator of record: candidates are
 * data (RuleSpec), and no candidate can alter this scoring.
 */
import { CANDIDATE_CATALOGUE } from '../../apps/web/src/oakguard/rules';
import { evaluateCandidate, proveSeedFailure, corpusManifest, SEED_SCRIPT } from '../../apps/web/src/oakguard/evaluator';
import { validateWithPlaybook } from '../../apps/web/src/oakguard/store';
import type { PlaybookState } from '../../apps/web/src/oakguard/types';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : ''}`);
  if (!cond) failures++;
}

const manifest = corpusManifest();
console.log(`OakGuard evaluator — corpus ${manifest.corpusCount} scripts, manifest ${manifest.manifestHash}\n`);

// 1. Seed failure proof: baseline says valid, execution is dead.
const proof = proveSeedFailure();
check('seed: baseline validator reports valid', proof.baselineValid === true, proof.baselineIssueCodes);
check('seed: SMA plot series is effectively dead (finite ratio < 0.5)', proof.finiteRatio < 0.5, { finiteRatio: Number(proof.finiteRatio.toFixed(3)), plots: proof.plotCount });

// 2. Every candidate is scored; the length rule must earn promotion,
//    the naive dotted rule must be rejected, the refined one must pass.
const byId = new Map<string, ReturnType<typeof evaluateCandidate>>();
for (const rule of CANDIDATE_CATALOGUE) {
  const report = evaluateCandidate(rule);
  byId.set(rule.id, report);
  console.log(`\n[${rule.id}] ${rule.name}`);
  console.log(`  mutants ${report.mutantCaught}/${report.mutantTotal} (held-out ${report.heldOutCaught}/${report.heldOutTotal}) · FP ${report.falsePositiveCount}/${report.goodTotal} · exec errors ${report.baselineExecErrors}→${report.candidateExecErrors} · ${report.durationMs}ms · verdict ${report.verdict.toUpperCase()}`);
  for (const r of report.reasons) console.log(`  - ${r}`);
  if (report.counterexample) console.log(`  counterexample: ${report.counterexample}`);
}

const lengthReport = byId.get('cand-length-v1')!;
check('length candidate promoted', lengthReport.verdict === 'promoted');
check('length candidate held-out fully caught', lengthReport.heldOutCaught === lengthReport.heldOutTotal && lengthReport.heldOutTotal > 0);
check('length candidate zero false positives', lengthReport.falsePositiveCount === 0);

const naiveReport = byId.get('cand-dotted-naive-v1')!;
check('naive dotted candidate rejected', naiveReport.verdict === 'rejected');
check('naive dotted candidate has false positives (the probation trap)', naiveReport.falsePositiveCount > 0, naiveReport.falsePositiveNames.slice(0, 3));

const refinedReport = byId.get('cand-dotted-refined-v1')!;
check('refined dotted candidate promoted', refinedReport.verdict === 'promoted');
check('refined dotted candidate zero false positives', refinedReport.falsePositiveCount === 0);

// 3. Promoted playbook catches the original seed.
const v2: PlaybookState = { version: 2, activeRuleIds: ['cand-length-v1'], promotions: [], emeritus: [] };
const seedIssues = validateWithPlaybook(v2, SEED_SCRIPT);
check('playbook v2 catches seed script', seedIssues.some(i => i.code === 'INVALID_LENGTH_ARG'), seedIssues.map(i => i.code));

console.log(failures === 0 ? '\nALL OAKGUARD CHECKS PASS' : `\n${failures} OAKGUARD CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
