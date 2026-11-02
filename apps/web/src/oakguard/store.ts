/**
 * OakGuard playbook store — persistence + promotion ledger.
 * Session/local only: this is the demo playbook, not a server authority.
 */
import { evaluateRuleOnSource, failureSignature, CANDIDATE_CATALOGUE } from './rules';
import type { PlaybookState, PromotionRecord, EmeritusRecord, RuleIssue, RuleSpec } from './types';

const KEY = 'dafe_oakguard_playbook_v1';

const DEFAULT_STATE: PlaybookState = { version: 1, activeRuleIds: [], promotions: [], emeritus: [], learnedRules: [] };

/** Tools that run outside the browser (the learning-curve harness) pin a playbook here. */
let override: PlaybookState | null = null;

export function setPlaybookOverride(state: PlaybookState | null): void {
  override = state;
}

export function loadPlaybook(): PlaybookState {
  if (override) return override;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version !== 'number' || !Array.isArray(parsed.activeRuleIds)) return { ...DEFAULT_STATE };
    return parsed as PlaybookState;
  } catch { return { ...DEFAULT_STATE }; }
}

export function savePlaybook(state: PlaybookState): void {
  if (override) { override = state; return; }
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

export function resetPlaybook(): PlaybookState {
  const fresh = { ...DEFAULT_STATE, learnedRules: [] };
  savePlaybook(fresh);
  return fresh;
}

export function getRuleById(id: string, state?: PlaybookState): RuleSpec | undefined {
  return CANDIDATE_CATALOGUE.find(r => r.id === id) ?? state?.learnedRules?.find(r => r.id === id);
}

export function activeRules(state: PlaybookState): RuleSpec[] {
  return state.activeRuleIds.map(id => getRuleById(id, state)).filter((r): r is RuleSpec => !!r);
}

/** Validate a source with the ACTIVE playbook rules (on top of the baseline validator's job). */
export function validateWithPlaybook(state: PlaybookState, source: string): RuleIssue[] {
  const out: RuleIssue[] = [];
  for (const rule of activeRules(state)) out.push(...evaluateRuleOnSource(rule, source));
  return out;
}

export function promoteRule(state: PlaybookState, record: PromotionRecord, spec?: RuleSpec): PlaybookState {
  const learned = state.learnedRules ?? [];
  const keepSpec = spec && !CANDIDATE_CATALOGUE.some(r => r.id === spec.id);
  const next: PlaybookState = {
    ...state,
    version: state.version + 1,
    activeRuleIds: [...new Set([...state.activeRuleIds, record.ruleId])],
    promotions: [...state.promotions, record],
    emeritus: state.emeritus,
    learnedRules: keepSpec ? [...learned.filter(r => r.id !== spec!.id), spec!] : learned,
  };
  savePlaybook(next);
  return next;
}

export function archiveRejection(state: PlaybookState, record: EmeritusRecord): PlaybookState {
  // Resurrection guard: never archive the same failure signature twice.
  if (state.emeritus.some(e => e.failureSignature === record.failureSignature)) return state;
  const next: PlaybookState = { ...state, emeritus: [...state.emeritus, record] };
  savePlaybook(next);
  return next;
}

/** Resurrection lookup: has this exact rule shape been rejected before? */
export function findEmeritusBySignature(state: PlaybookState, rule: RuleSpec): EmeritusRecord | undefined {
  const sig = failureSignature(rule);
  return state.emeritus.find(e => e.failureSignature === sig);
}

/**
 * Cross-role dependency invalidation. The Assistant's rules depend on
 * Editor-certified tools (indicators by name). When a tool changes state
 * (upgraded, superseded, re-certified), every dependent Assistant rule
 * drops to needs_recert until it re-earns its seat via the grader.
 * Returns the invalidated rule ids.
 */
export function invalidateDependents(state: PlaybookState, changedTool: string, assistantRules: Array<{ id: string; dependsOn: string[] }>): { state: PlaybookState; invalidated: string[] } {
  const status: Record<string, 'active' | 'needs_recert'> = { ...(state.assistantStatus || {}) };
  const invalidated: string[] = [];
  // Breadth-first: a rule may also depend on another assistant rule id.
  const queue = [changedTool];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const rule of assistantRules) {
      if (rule.dependsOn.includes(cur) && status[rule.id] !== 'needs_recert') {
        status[rule.id] = 'needs_recert';
        invalidated.push(rule.id);
        queue.push(rule.id);
      }
    }
  }
  const next: PlaybookState = { ...state, assistantStatus: status };
  savePlaybook(next);
  return { state: next, invalidated };
}

export function setAssistantStatus(state: PlaybookState, ruleId: string, statusValue: 'active' | 'needs_recert'): PlaybookState {
  const next: PlaybookState = { ...state, assistantStatus: { ...(state.assistantStatus || {}), [ruleId]: statusValue } };
  savePlaybook(next);
  return next;
}
