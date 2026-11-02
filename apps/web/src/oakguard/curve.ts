/**
 * Measure the current playbook on recorded Muse Spark drafts it never learned from.
 *
 * learning-curve.json is written by tools/verify/learning-curve.ts: the
 * held-out half of 32 first drafts, each with the oracle verdict recorded at
 * measurement time. Only the static check is recomputed here, so the panel
 * can re-measure any playbook instantly and offline.
 */
import data from './learning-curve.json';
import { activeRules } from './store';
import { evaluateRuleOnSource } from './rules';
import type { PlaybookState } from './types';

export interface CurveDraft {
  index: number;
  request: string;
  code: string;
  validatorClean: boolean;
  escape: boolean;
  defect: string;
}

export interface CurveFile {
  generatedAt: string;
  draftsRecordedAt: string;
  draftModel: string;
  firstDraftValidity: { drafts: number; validatorClean: number; note: string };
  heldOutDrafts: CurveDraft[];
}

export interface CurveMeasure {
  draftModel: string;
  recordedAt: string;
  drafts: number;
  validatorClean: number;
  escapes: number;
  caughtV1: number;
  caughtNow: number;
  /** Learned-rule flags on validator-clean drafts the oracles found nothing wrong with. */
  falseFlagsNow: number;
  firstDraftValidity: CurveFile['firstDraftValidity'];
}

export function curveFile(): CurveFile | null {
  const f = data as unknown as Partial<CurveFile>;
  return Array.isArray(f?.heldOutDrafts) && f.heldOutDrafts.length > 0 ? (f as CurveFile) : null;
}

export function measureCurve(state: PlaybookState): CurveMeasure | null {
  const f = curveFile();
  if (!f) return null;
  const rules = activeRules(state);
  const flags = (code: string): boolean => rules.some(r => evaluateRuleOnSource(r, code).some(i => i.severity === 'error'));
  const clean = f.heldOutDrafts.filter(d => d.validatorClean);
  const escapes = clean.filter(d => d.escape);
  return {
    draftModel: f.draftModel,
    recordedAt: f.draftsRecordedAt,
    drafts: f.heldOutDrafts.length,
    validatorClean: clean.length,
    escapes: escapes.length,
    caughtV1: 0,
    caughtNow: escapes.filter(d => flags(d.code)).length,
    falseFlagsNow: clean.filter(d => !d.escape && flags(d.code)).length,
    firstDraftValidity: f.firstDraftValidity,
  };
}
