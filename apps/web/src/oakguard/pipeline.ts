/**
 * OakGuard pipeline — the whole rule-learning loop as one pass.
 *
 *   1. Find escapes        scripts the validator accepts that the runtime oracles prove broken
 *   2. Model proposes      a Meta model writes one declarative rule per escape
 *   3. Referee tests       broken variants (some held out) + known-good corpus
 *   4. Revise              rejected rules go back with the reason and a counterexample
 *   5. Promote             only rules that pass every gate join the playbook
 *   6. Re-check            the escapes and the script library, now caught statically
 *   7. Measure             held-out Muse Spark drafts the proposer never saw
 *   8. Re-certify          advice that depends on a re-checked tool returns to probation
 *
 * Pure logic with no DOM: the Crucible window drives it and animates from the
 * same partial result the report is later built from, so the screen, the
 * report and the headless checks all read one set of numbers.
 */
import { CANDIDATE_CATALOGUE, failureSignature } from './rules';
import { corpusManifest } from './evaluator';
import {
  activeRules, archiveRejection, invalidateDependents,
  promoteRule, setAssistantStatus, validateWithPlaybook,
} from './store';
import { ASSISTANT_RULES, buildScenarios, gradeAssistantRule } from './assistant';
import { runOracles, describeFindings } from './oracles';
import { SEED_ESCAPES, type EscapeCase } from './escapes';
import { MINED_ESCAPES } from './mined-escapes';
import { runProposalLoop, type ProposerTransport, type RoundRecord, type TransportRequest } from './proposer';
import { measureCurve, type CurveMeasure } from './curve';
import { validate } from '../oakscript/validator';
import type { AssistantGrade, ScenarioResult } from './assistant';
import type { AssistantRule, EvalReport, PlaybookState, RuleSpec } from './types';

/** The tool whose dependents are re-certified when the playbook changes (step 8). */
export const DEMO_TOOL = 'CCI Manifold Sheet';

export const STEP_TITLES = [
  'Find escapes',
  'Model proposes rules',
  'Referee tests each rule',
  'Revise on counterexamples',
  'Promote proven rules',
  'Re-check escapes and library',
  'Measure on unseen drafts',
  'Re-certify dependent advice',
] as const;

export const STEP_HINTS = [
  'Scripts the validator accepts that are broken when they run.',
  'A Meta model writes one declarative rule per escape. Never code.',
  'Broken variants (some held out) and known-good scripts.',
  'A rejected rule goes back with the reason and a counterexample.',
  'Only rules that pass every gate join the playbook.',
  'The escapes are now flagged before they run.',
  'Muse Spark drafts the proposer never saw.',
  'Advice that depends on a re-checked tool returns to probation.',
] as const;

export const STEP_GROUPS = [
  { label: 'Learn', from: 0, to: 4 },
  { label: 'Prove', from: 5, to: 7 },
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
  escapeId?: string;
  round?: number;
}

export interface EscapeOutcome {
  escape: EscapeCase;
  validatorValid: boolean;
  evidence: string;
  /** Issue codes the playbook already raised before this run proposed anything. */
  alreadyCaughtBy: string[];
  rounds: RoundRecord[];
  promotedRuleId?: string;
  /** Issue codes the playbook raises on the escape after the run. */
  caughtAfter: string[];
}

export interface ScriptRef {
  name: string;
  source: string;
}

export type ProposerMode = 'live' | 'replay' | 'catalogue';

export interface ProposerStats {
  mode: ProposerMode;
  model: string;
  recordedAt?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface OakGuardRun {
  startedAt: number;
  durationMs: number;
  playbookVersionBefore: number;
  playbook: PlaybookState;
  manifest: ReturnType<typeof corpusManifest>;
  steps: StepRecord[];
  proposer: ProposerStats;
  escapes: EscapeOutcome[];
  candidates: CandidateOutcome[];
  library: { scanned: number; activeRuleCount: number; flagged: Array<{ name: string; code: string; message: string }> };
  curve: CurveMeasure | null;
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
  /** How candidates are produced. Defaults to the hand-written catalogue (offline, deterministic). */
  mode?: ProposerMode;
  transport?: ProposerTransport;
  model?: string;
  recordedAt?: string;
  escapes?: EscapeCase[];
  maxRounds?: number;
  /** Fired when a step starts (`running`) and when it ends. `run` is the partial result so far. */
  onStep?: (index: number, status: StepStatus, run: OakGuardRun) => void;
  /** Fired for every proposal and every verdict, for live displays. */
  onRound?: (escape: EscapeCase, round: RoundRecord, phase: 'proposed' | 'graded', run: OakGuardRun) => void;
  /** Optional UI pacing between steps. The default waits for nothing. */
  pause?: () => Promise<void>;
}

const noPause = async (): Promise<void> => {};

/** The escapes a run works on: real model drafts first, a seed for any class not mined yet. */
export function defaultEscapes(): EscapeCase[] {
  return [...MINED_ESCAPES, ...SEED_ESCAPES.filter(s => !MINED_ESCAPES.some(m => m.defectClass === s.defectClass))];
}

/**
 * The hand-written catalogue as a transport: the same loop, no model. Round 1
 * for the silent-call class is the naive spec, round 2 the refined one, so the
 * offline path still shows a rejection followed by a revision.
 */
export function catalogueTransport(): ProposerTransport {
  const byClass: Record<string, RuleSpec[]> = {
    'dead-length': [CANDIDATE_CATALOGUE[0]],
    'silent-call': [CANDIDATE_CATALOGUE[1], CANDIDATE_CATALOGUE[2]],
  };
  return async (req: TransportRequest) => {
    const [escapeId, roundText] = req.key.split('#');
    const escape = [...MINED_ESCAPES, ...SEED_ESCAPES].find(e => e.id === escapeId);
    const spec = escape ? byClass[escape.defectClass]?.[Number(roundText) - 1] : undefined;
    if (!spec) throw new Error('the hand-written catalogue has no candidate for this class');
    const content = JSON.stringify({
      name: spec.name, family: spec.family, issueCode: spec.issueCode,
      description: spec.description, rationale: spec.rationale, fixHint: '',
      params: { functions: [], windowFunctions: [], operators: [], followVariables: false, allowObjectMethods: !!spec.allowObjectMethods },
    });
    return { content, model: 'hand-written catalogue', inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0, source: 'replay' };
  };
}

export async function runOakGuard(options: RunOptions): Promise<OakGuardRun> {
  const pause = options.pause ?? noPause;
  const started = Date.now();
  const mode = options.mode ?? 'catalogue';
  const transport = options.transport ?? catalogueTransport();
  const model = options.model ?? (mode === 'catalogue' ? 'hand-written catalogue' : 'muse-wonder-1.0');
  let state = options.state;

  const run: OakGuardRun = {
    startedAt: started,
    durationMs: 0,
    playbookVersionBefore: state.version,
    playbook: state,
    manifest: corpusManifest(),
    steps: STEP_TITLES.map((title): StepRecord => ({ title, status: 'pending', summary: '' })),
    proposer: { mode, model, recordedAt: options.recordedAt, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
    escapes: [],
    candidates: [],
    library: { scanned: 0, activeRuleCount: 0, flagged: [] },
    curve: null,
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

  // 1 · Find escapes
  await begin(0);
  const escapes = options.escapes ?? defaultEscapes();
  for (const escape of escapes) {
    const v = validate(escape.source);
    const evidence = describeFindings(runOracles(escape.source));
    const already = [...new Set(validateWithPlaybook(state, escape.source).filter(i => i.severity === 'error').map(i => i.code))];
    run.escapes.push({ escape, validatorValid: v.valid, evidence, alreadyCaughtBy: already, rounds: [], caughtAfter: [] });
    say(`ESCAPE ${escape.id} (${escape.origin}${escape.model ? `, ${escape.model}` : ''}): validator ${v.valid ? 'accepts it' : 'rejects it'}; runtime: ${evidence}.`);
    if (already.length) say(`  already caught by the playbook (${already.join(', ')}), so no proposal is needed.`);
  }
  const open = run.escapes.filter(e => e.alreadyCaughtBy.length === 0);
  end(0, 'done', `${run.escapes.length} escape(s): accepted by the validator, broken when run. ${open.length} not yet covered by the playbook.`);

  // 2–4 · Propose, test, revise (one loop per open escape)
  await begin(1);
  let proposals = 0;
  let revisions = 0;
  for (const outcome of open) {
    const res = await runProposalLoop({
      escape: outcome.escape,
      transport,
      model,
      maxRounds: options.maxRounds ?? 3,
      onRound: (round, phase) => {
        if (phase === 'proposed') {
          proposals++;
          if (round.round > 1) revisions++;
          if (run.steps[2].status === 'pending') { run.steps[2].status = 'running'; options.onStep?.(2, 'running', run); }
          if (round.round > 1 && run.steps[3].status === 'pending') { run.steps[3].status = 'running'; options.onStep?.(3, 'running', run); }
          say(`PROPOSED by ${round.meta?.model ?? model} for ${outcome.escape.id}, round ${round.round}: ${round.rule?.family} ${round.rule?.issueCode} ${JSON.stringify(round.rule?.params ?? {})}${round.rule?.allowObjectMethods ? ' +objectMethods' : ''}`);
        }
        if (phase === 'graded') {
          if (round.meta) {
            run.proposer.calls++;
            run.proposer.inputTokens += round.meta.inputTokens;
            run.proposer.outputTokens += round.meta.outputTokens;
            run.proposer.costUsd += round.meta.costUsd;
            run.proposer.latencyMs += round.meta.latencyMs;
          }
          if (round.error) say(`  round ${round.round}: ${round.error}`);
          if (round.rule && round.report) {
            const r = round.report;
            run.candidates.push({ rule: round.rule, report: r, outcome: r.verdict === 'promoted' ? 'promoted' : 'rejected', escapeId: outcome.escape.id, round: round.round });
            say(`  referee: variants ${r.mutantCaught}/${r.mutantTotal} (held-out ${r.heldOutCaught}/${r.heldOutTotal}) · false alarms ${r.falsePositiveCount}/${r.goodTotal} → ${r.verdict.toUpperCase()}`);
            if (r.verdict === 'rejected') for (const reason of r.reasons) say(`    - ${reason}`);
          }
        }
        options.onRound?.(outcome.escape, round, phase, run);
      },
    });
    outcome.rounds = res.rounds;
    await pause();
  }
  const graded = run.candidates.length;
  const rejectedCount = run.candidates.filter(c => c.outcome === 'rejected').length;
  end(1, 'done', open.length === 0
    ? 'Every escape is already covered by the playbook. Nothing to propose.'
    : `${proposals} rule(s) proposed by ${model} for ${open.length} escape(s)${run.proposer.costUsd > 0 ? ` · $${run.proposer.costUsd.toFixed(3)}` : ''}.`);
  end(2, 'done', graded === 0
    ? 'No candidate reached the referee.'
    : `${graded} rule(s) scored on ${run.candidates.reduce((n, c) => n + c.report.mutantTotal, 0)} broken variants and ${run.manifest.corpusCount} known-good scripts. ${rejectedCount} rejected.`);
  end(3, 'done', revisions > 0
    ? `${revisions} revision(s) written after a rejection.`
    : 'No revision needed: every graded rule passed or was out of rounds.');

  // 5 · Promote proven rules (and archive the rest)
  await begin(4);
  let promotedNow = 0;
  let archivedNow = 0;
  for (const c of run.candidates) {
    if (c.outcome === 'promoted') {
      state = promoteRule(state, {
        ruleId: c.rule.id,
        issueCode: c.rule.issueCode,
        playbookVersion: state.version + 1,
        manifestHash: c.report.manifestHash,
        modelId: c.rule.proposal?.model ?? c.rule.proposedBy,
        promotedAt: Date.now(),
        report: c.report,
      }, c.rule);
      const outcome = run.escapes.find(e => e.escape.id === c.escapeId);
      if (outcome) outcome.promotedRuleId = c.rule.id;
      promotedNow++;
      say(`PROMOTED ${c.rule.issueCode} (${c.rule.proposal?.model ?? c.rule.proposedBy}) → playbook v${state.version}.`);
      continue;
    }
    const signature = failureSignature(c.rule);
    if (state.emeritus.some(e => e.failureSignature === signature)) {
      c.outcome = 'archived';
      say(`ARCHIVED (earlier): ${c.rule.name}. The same rule shape is already on record.`);
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
    archivedNow++;
    say(`ARCHIVED: ${c.rule.name}. Kept with its counterexample.`);
  }
  end(4, 'done', promotedNow || archivedNow
    ? `${promotedNow} promoted (playbook v${state.version}), ${archivedNow} archived with counterexamples.`
    : 'No new verdicts. The playbook is unchanged.');

  // 6 · Re-check escapes and the script library
  await begin(5);
  for (const e of run.escapes) {
    e.caughtAfter = [...new Set(validateWithPlaybook(state, e.escape.source).filter(i => i.severity === 'error').map(i => i.code))];
  }
  const rules = activeRules(state);
  run.library = { scanned: options.scripts.length, activeRuleCount: rules.length, flagged: [] };
  for (const script of options.scripts) {
    const issues = validateWithPlaybook(state, script.source);
    if (issues.length) run.library.flagged.push({ name: script.name, code: issues[0].code, message: issues[0].message });
  }
  const caughtNow = run.escapes.filter(e => e.caughtAfter.length > 0).length;
  for (const e of run.escapes) say(`RE-CHECK ${e.escape.id}: ${e.caughtAfter.length ? `caught before running (${e.caughtAfter.join(', ')})` : 'still not caught'}.`);
  say(`SCAN: ${run.library.scanned} scripts checked with ${rules.length} active rule(s); ${run.library.flagged.length} flagged.`);
  end(5, 'done', `${caughtNow} of ${run.escapes.length} escapes now caught before they run. Library: ${run.library.scanned} scripts, ${run.library.flagged.length} flagged.`);

  // 7 · Measure on unseen drafts
  await begin(6);
  run.curve = measureCurve(state);
  if (run.curve) {
    const c = run.curve;
    say(`CURVE: ${c.escapes} held-out ${c.draftModel} draft(s) pass the validator but break at runtime. Flagged before running: v1 ${c.caughtV1}, now ${c.caughtNow}. Flags on clean drafts: ${c.falseFlagsNow}.`);
    end(6, 'done', `Unseen ${c.draftModel} drafts: ${c.caughtNow} of ${c.escapes} runtime defects now flagged before running (v1: ${c.caughtV1}).`);
  } else {
    say('CURVE: no recorded drafts in this build.');
    end(6, 'done', 'No recorded drafts in this build. Run tools/verify/learning-curve.ts to measure.');
  }

  // 8 · Re-certify dependent advice
  await begin(7);
  const dependents = ASSISTANT_RULES.filter(r => r.dependsOn.includes(DEMO_TOOL)).length;
  run.assistant.dependents = dependents;
  if (promotedNow > 0) {
    const upgrade = invalidateDependents(state, DEMO_TOOL, ASSISTANT_RULES);
    state = upgrade.state;
    run.assistant.invalidated = upgrade.invalidated;
    say(`DEPENDENCY: the playbook changed, so ${DEMO_TOOL} was re-checked; ${upgrade.invalidated.length} advice rule(s) returned to probation.`);
  }
  run.assistant.scenarios = buildScenarios();
  for (const rule of ASSISTANT_RULES) {
    const grade = gradeAssistantRule(rule);
    const pass = grade.verdict === 'promoted';
    state = setAssistantStatus(state, rule.id, pass ? 'active' : 'needs_recert');
    run.assistant.grades.push({ rule, grade });
    say(`ASSISTANT [${rule.id}] ${grade.reasons[0]} → ${pass ? 'CERTIFIED' : 'stays in probation'}.`);
  }
  run.assistant.certified = run.assistant.grades.filter(g => g.grade.verdict === 'promoted').length;
  end(7, 'done', `${run.assistant.invalidated.length} advice rule(s) re-checked after the playbook change; ${run.assistant.certified} of ${ASSISTANT_RULES.length} certified.`);

  run.playbook = state;
  run.durationMs = Date.now() - started;
  return run;
}
