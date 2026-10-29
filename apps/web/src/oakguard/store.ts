/**
 * OakGuard playbook store — persistence + promotion ledger.
 * Session/local only: this is the demo playbook, not a server authority.
 */
import { evaluateRuleOnSource, failureSignature, CANDIDATE_CATALOGUE } from './rules';
import type { PlaybookState, PromotionRecord, EmeritusRecord, RuleIssue, RuleSpec } from './types';

const KEY = 'dafe_oakguard_playbook_v1';

const DEFAULT_STATE: PlaybookState = { version: 1, activeRuleIds: [], promotions: [], emeritus: [] };

export function loadPlaybook(): PlaybookState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version !== 'number' || !Array.isArray(parsed.activeRuleIds)) return { ...DEFAULT_STATE };
    return parsed as PlaybookState;
  } catch { return { ...DEFAULT_STATE }; }
}

export function savePlaybook(state: PlaybookState): void {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

export function resetPlaybook(): PlaybookState {
  const fresh = { ...DEFAULT_STATE };
  savePlaybook(fresh);
  return fresh;
}

export function getRuleById(id: string): RuleSpec | undefined {
  return CANDIDATE_CATALOGUE.find(r => r.id === id);
}

export function activeRules(state: PlaybookState): RuleSpec[] {
  return state.activeRuleIds.map(getRuleById).filter((r): r is RuleSpec => !!r);
}

/** Validate a source with the ACTIVE playbook rules (on top of the baseline validator's job). */
export function validateWithPlaybook(state: PlaybookState, source: string): RuleIssue[] {
  const out: RuleIssue[] = [];
  for (const rule of activeRules(state)) out.push(...evaluateRuleOnSource(rule, source));
  return out;
}

export function promoteRule(state: PlaybookState, record: PromotionRecord): PlaybookState {
  const next: PlaybookState = {
    version: state.version + 1,
    activeRuleIds: [...new Set([...state.activeRuleIds, record.ruleId])],
    promotions: [...state.promotions, record],
    emeritus: state.emeritus,
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
