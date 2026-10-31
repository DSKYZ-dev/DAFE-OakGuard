/**
 * OakGuard pipeline — the whole rule-promotion loop as one pass.
 *
 * Pure logic with no DOM: the Crucible window drives it and animates from the
 * same partial result the report is later built from, so the screen, the
 * report and the headless checks all read one set of numbers.
 */
import { CANDIDATE_CATALOGUE, failureSignature } from './rules';
import { corpusManifest, evaluateCandidate, finitePlotRatio, proveSeedFailure, SEED_SCRIPT } from './evaluator';
import {
  activeRules, archiveRejection, findEmeritusBySignature, invalidateDependents,
  promoteRule, setAssistantStatus, validateWithPlaybook,
} from './store';
import { ASSISTANT_RULES, buildScenarios, gradeAssistantRule } from './assistant';
import type { AssistantGrade, ScenarioResult } from './assistant';
import type { AssistantRule, EvalReport, PlaybookState, RuleSpec } from './types';

/** The tool whose upgrade the demo simulates (step 7). */
export const DEMO_TOOL = 'CCI Manifold Sheet';

export const STEP_TITLES = [
  'Find a real failure',
  'Load candidate rules',
  'Test every rule',
  'Keep only proven rules',
  'Re-run the failing task',
  'Scan the script library',
  'Upgrade a tool',
  'Re-certify assistant rules',
] as const;

export const STEP_HINTS = [
  'Replays a real bug that the shipped validator misses.',
  'Candidate rules are declarative specs, never code.',
  'Each rule is scored on broken variants and known-good scripts.',
  'Only rules that pass every gate are promoted. The rest are archived with evidence.',
  'The same broken script is checked again with the new rules.',
  'Every shipped and saved script is checked against the active rules.',
  'Assistant advice that depends on the tool loses certification.',
  'Assistant rules are graded on abstention and process, not profit.',
] as const;

export const STEP_GROUPS = [
  { label: 'Editor checks', from: 0, to: 5 },
  { label: 'Trade assistant', from: 6, to: 7 },
] as const;

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepRecord {
  title: string;
  status: StepStatus;
  summary: string;
}

/**
 * active: already in the playbook · promoted: added by this run ·
 * rejected: archived by this run · archived: archived by an earlier run.
 */
export type CandidateStatus = 'active' | 'promoted' | 'rejected' | 'archived';

export interface CandidateOutcome {
  rule: RuleSpec;
  report: EvalReport;
  outcome: CandidateStatus;
}

export interface ScriptRef {
  name: string;
  source: string;
}

export interface OakGuardRun {
  startedAt: number;
  durationMs: number;
  playbookVersionBefore: number;
  playbook: PlaybookState;
  manifest: ReturnType<typeof corpusManifest>;
  steps: StepRecord[];
  seed: { validatorValid: boolean; validatorIssueCodes: string[]; finiteRatio: number; plotCount: number };
  candidates: CandidateOutcome[];
  reRun: { caughtBy: string[]; remainingIssues: number; fixedFiniteRatio: number };
  library: { scanned: number; activeRuleCount: number; flagged: Array<{ name: string; code: string; message: string }> };
  assistant: {
    tool: string;
    dependents: number;
    invalidated: string[];
    scenarios: ScenarioResult[];
    grades: Array<{ rule: AssistantRule; grade: AssistantGrade }>;
    certified: number;
  };
  log: string[];
}

export interface RunOptions {
  state: PlaybookState;
  scripts: ScriptRef[];
  /** Fired when a step starts (`running`) and when it ends. `run` is the partial result so far. */
  onStep?: (index: number, status: StepStatus, run: OakGuardRun) => void;
  /** Optional UI pacing between steps. The default waits for nothing. */
  pause?: () => Promise<void>;
}

const noPause = async (): Promise<void> => {};

export async function runOakGuard(options: RunOptions): Promise<OakGuardRun> {
  const pause = options.pause ?? noPause;
  const started = Date.now();
  let state = options.state;

  const run: OakGuardRun = {
    startedAt: started,
    durationMs: 0,
    playbookVersionBefore: state.version,
    playbook: state,
    manifest: corpusManifest(),
    steps: STEP_TITLES.map((title): StepRecord => ({ title, status: 'pending', summary: '' })),
    seed: { validatorValid: false, validatorIssueCodes: [], finiteRatio: 0, plotCount: 0 },
    candidates: [],
    reRun: { caughtBy: [], remainingIssues: 0, fixedFiniteRatio: 0 },
    library: { scanned: 0, activeRuleCount: 0, flagged: [] },
    assistant: { tool: DEMO_TOOL, dependents: 0, invalidated: [], scenarios: [], grades: [], certified: 0 },
    log: [],
  };

  const say = (line: string): void => { run.log.push(line); };
  const begin = async (i: number): Promise<void> => {
    run.steps[i].status = 'running';
    run.playbook = state;
    options.onStep?.(i, 'running', run);
    await pause();
  };
  const end = (i: number, status: StepStatus, summary: string): void => {
    run.steps[i].status = status;
    run.steps[i].summary = summary;
    run.playbook = state;
    options.onStep?.(i, status, run);
  };

  // 1 · Find a real failure
  await begin(0);
  const proof = proveSeedFailure();
  run.seed = {
    validatorValid: proof.baselineValid,
    validatorIssueCodes: proof.baselineIssueCodes,
    finiteRatio: proof.finiteRatio,
    plotCount: proof.plotCount,
  };
  const deadPct = Math.round(proof.finiteRatio * 100);
  say(`SEED: baseline validator ${proof.baselineValid ? 'accepts' : 'rejects'} the seed (${proof.baselineIssueCodes.join(', ') || 'no issues'}).`);
  say(`SEED: execution shows its SMA series is ${deadPct}% finite. The indicator is dead but passes validation.`);
  end(0, 'done', `The validator ${proof.baselineValid ? 'accepts' : 'rejects'} the seed, yet its SMA series is only ${deadPct}% finite.`);

  // 2 · Load candidate rules
  await begin(1);
  for (const rule of CANDIDATE_CATALOGUE) {
    const dead = findEmeritusBySignature(state, rule);
    say(dead
      ? `CANDIDATE ${rule.id}: matches archived rule "${dead.name}", so a refined successor is listed instead.`
      : `CANDIDATE ${rule.id}: ${rule.name} → ${rule.issueCode}`);
  }
  end(1, 'done', `${CANDIDATE_CATALOGUE.length} candidate rules loaded as declarative specs. None of them is code.`);

  // 3 · Test every rule
  await begin(2);
  let variants = 0;
  for (const rule of CANDIDATE_CATALOGUE) {
    const report = evaluateCandidate(rule);
    variants += report.mutantTotal;
    run.candidates.push({
      rule,
      report,
      outcome: state.activeRuleIds.includes(rule.id) ? 'active' : report.verdict === 'promoted' ? 'promoted' : 'rejected',
    });
    say(`[${rule.id}] broken variants ${report.mutantCaught}/${report.mutantTotal} (held-out ${report.heldOutCaught}/${report.heldOutTotal}) · false alarms ${report.falsePositiveCount}/${report.goodTotal} · ${report.durationMs} ms → ${report.verdict.toUpperCase()}`);
    for (const reason of report.reasons) say(`  - ${reason}`);
    await pause();
  }
  end(2, 'done', `${variants} broken variants and ${run.manifest.corpusCount} known-good scripts were used to score each rule.`);

  // 4 · Keep only proven rules
  await begin(3);
  let promotedNow = 0;
  let archivedNow = 0;
  for (const c of run.candidates) {
    if (c.outcome === 'active') continue;
    if (c.outcome === 'promoted') {
      state = promoteRule(state, {
        ruleId: c.rule.id,
        issueCode: c.rule.issueCode,
        playbookVersion: state.version + 1,
        manifestHash: c.report.manifestHash,
        modelId: 'hand-written candidate catalogue',
        promotedAt: Date.now(),
        report: c.report,
      });
      promotedNow++;
      say(`PROMOTED ${c.rule.issueCode} → playbook v${state.version}. The editor enforces it from now on.`);
      continue;
    }
    const signature = failureSignature(c.rule);
    if (state.emeritus.some(e => e.failureSignature === signature)) {
      c.outcome = 'archived';
      say(`ARCHIVED (earlier): ${c.rule.name}. The same failure signature is already on record.`);
      continue;
    }
    state = archiveRejection(state, {
      ruleId: c.rule.id,
      name: c.rule.name,
      failureSignature: signature,
      rejectedAt: Date.now(),
      reasons: c.report.reasons,
      counterexample: c.report.counterexample,
      report: c.report,
    });
    c.outcome = 'rejected';
    archivedNow++;
    say(`ARCHIVED to Emeritus: ${c.rule.name}. Kept with its counterexample.`);
  }
  end(3, 'done', promotedNow || archivedNow
    ? `${promotedNow} promoted, ${archivedNow} archived with their counterexamples.`
    : 'No new verdicts. The playbook is unchanged.');

  // 5 · Re-run the failing task
  await begin(4);
  const caught = validateWithPlaybook(state, SEED_SCRIPT);
  const fixed = SEED_SCRIPT.replace('sma(close, 0)', 'sma(close, 14)');
  run.reRun = {
    caughtBy: [...new Set(caught.map(i => i.code))],
    remainingIssues: validateWithPlaybook(state, fixed).length,
    fixedFiniteRatio: finitePlotRatio(fixed, 'SMA').ratio,
  };
  const fixedPct = Math.round(run.reRun.fixedFiniteRatio * 100);
  if (caught.length) {
    say(`RE-RUN: the playbook catches the seed (${run.reRun.caughtBy.join(', ')}).`);
    say(`RE-RUN: auto-fix sma(close, 0) → sma(close, 14). The SMA series is now ${fixedPct}% finite.`);
    end(4, 'done', `The playbook catches the seed. The auto-fix repaired it, and the SMA series is now ${fixedPct}% finite.`);
  } else {
    say('RE-RUN: no active rule catches the seed yet.');
    end(4, 'done', 'No active rule catches the seed yet, so nothing was promoted for it.');
  }

  // 6 · Scan the script library
  await begin(5);
  const rules = activeRules(state);
  run.library = { scanned: options.scripts.length, activeRuleCount: rules.length, flagged: [] };
  for (const script of options.scripts) {
    const issues = validateWithPlaybook(state, script.source);
    if (issues.length) run.library.flagged.push({ name: script.name, code: issues[0].code, message: issues[0].message });
  }
  for (const f of run.library.flagged) say(`SCAN: ${f.name} → [${f.code}] ${f.message.slice(0, 110)}`);
  say(`SCAN: ${run.library.scanned} scripts checked with ${rules.length} active rule(s); ${run.library.flagged.length} flagged.`);
  end(5, 'done', rules.length === 0
    ? 'The playbook has no active rules yet, so there is nothing to enforce.'
    : `${run.library.scanned} scripts checked against ${rules.length} active rule(s). ${run.library.flagged.length} flagged.`);

  // 7 · Upgrade a tool
  await begin(6);
  const dependents = ASSISTANT_RULES.filter(r => r.dependsOn.includes(DEMO_TOOL)).length;
  const upgrade = invalidateDependents(state, DEMO_TOOL, ASSISTANT_RULES);
  state = upgrade.state;
  run.assistant.dependents = dependents;
  run.assistant.invalidated = upgrade.invalidated;
  say(upgrade.invalidated.length
    ? `DEPENDENCY: ${DEMO_TOOL} changed. ${upgrade.invalidated.length} advice rule(s) returned to probation: ${upgrade.invalidated.join(', ')}.`
    : `DEPENDENCY: no certified advice depends on ${DEMO_TOOL} right now.`);
  end(6, 'done', upgrade.invalidated.length
    ? `${DEMO_TOOL} changed. ${upgrade.invalidated.length} advice rule(s) went back to probation until re-graded.`
    : `No certified advice depends on ${DEMO_TOOL} right now.`);

  // 8 · Re-certify assistant rules
  await begin(7);
  run.assistant.scenarios = buildScenarios();
  for (const rule of ASSISTANT_RULES) {
    const grade = gradeAssistantRule(rule);
    const pass = grade.verdict === 'promoted';
    state = setAssistantStatus(state, rule.id, pass ? 'active' : 'needs_recert');
    run.assistant.grades.push({ rule, grade });
    say(`ASSISTANT [${rule.id}] ${grade.reasons[0]} → ${pass ? 'CERTIFIED' : 'stays in probation'}.`);
  }
  run.assistant.certified = run.assistant.grades.filter(g => g.grade.verdict === 'promoted').length;
  end(7, 'done', `${run.assistant.certified} of ${ASSISTANT_RULES.length} assistant rules certified on ${run.assistant.scenarios.length} point-in-time scenarios.`);

  run.playbook = state;
  run.durationMs = Date.now() - started;
  return run;
}
