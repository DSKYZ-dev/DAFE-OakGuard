/**
 * OakGuard — a constrained verification playbook for OakScript.
 *
 * Candidate rules are DECLARATIVE specs (never arbitrary code); a live model may propose them later.
 * An independent evaluator scores each candidate against a frozen corpus
 * of known-good scripts and generated mutants. Candidates that pass every
 * gate are promoted into the active playbook; rejected candidates are
 * preserved in the Emeritus archive with their counterexamples.
 */

export type RuleFamily = 'positive-int-length' | 'unknown-dotted-call';

export interface RuleSpec {
  id: string;
  name: string;
  /** Which agent role this rule serves. One engine, two policy packs. */
  role?: 'editor' | 'assistant';
  /** Tools/rules this artifact depends on — when a dependency changes
   * state, dependents are invalidated back to probation (needs recert). */
  dependsOn?: string[];
  family: RuleFamily;
  /** ValidationIssue.code emitted when this rule fires. */
  issueCode: string;
  severity: 'error' | 'warning';
  description: string;
  rationale: string;
  proposedBy: string;
  /** For unknown-dotted-call: allow known runtime-object method names (OakRing/Matrix/handles). */
  allowObjectMethods?: boolean;
}

export interface RuleIssue {
  line: number;
  code: string;
  severity: 'error' | 'warning';
  message: string;
  fix?: string;
  ruleId: string;
}

export interface MutantCase {
  id: string;
  family: RuleFamily;
  baseIndicator: string;
  /** Mutated OakScript source. */
  source: string;
  /** Human-readable description of the injected defect. */
  defect: string;
  /** Deterministic split: held-out mutants are never shown in agent-facing reports. */
  heldOut: boolean;
}

export interface CorpusEntry {
  name: string;
  category: string;
  source: string;
}

export interface EvalReport {
  ruleId: string;
  mutantTotal: number;
  mutantCaught: number;
  heldOutTotal: number;
  heldOutCaught: number;
  goodTotal: number;
  falsePositiveCount: number;
  /** Names of known-good scripts the candidate incorrectly flagged (first counterexample kept). */
  falsePositiveNames: string[];
  counterexample?: string;
  baselineExecErrors: number;
  candidateExecErrors: number;
  durationMs: number;
  manifestHash: string;
  verdict: 'promoted' | 'rejected';
  reasons: string[];
}

export interface PromotionRecord {
  ruleId: string;
  issueCode: string;
  playbookVersion: number;
  manifestHash: string;
  modelId: string;
  promotedAt: number;
  report: EvalReport;
}

export interface EmeritusRecord {
  ruleId: string;
  name: string;
  failureSignature: string;
  rejectedAt: number;
  reasons: string[];
  counterexample?: string;
  report: EvalReport;
}

export interface PlaybookState {
  version: number;
  activeRuleIds: string[];
  promotions: PromotionRecord[];
  emeritus: EmeritusRecord[];
  /** Assistant-rule status by id: certified rules whose dependencies
   * changed drop to 'needs_recert' until re-graded. */
  assistantStatus?: Record<string, 'active' | 'needs_recert'>;
}

/** Trade Assistant rule — graded on process compliance + correct
 * abstention over point-in-time replayed scenarios, never on P&L alone. */
export interface AssistantRule {
  id: string;
  name: string;
  description: string;
  dependsOn: string[];
  /** Deterministic policy over a regime read. */
  decide: (regime: string, atrRatio: number) => 'trade' | 'reduce' | 'abstain';
  rationale: string;
}
