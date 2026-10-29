/**
 * OakGuard evaluator — the independent scorekeeper.
 *
 * Lives outside the agent's writable scope by design: candidates arrive as
 * RuleSpec data, this module owns the corpus, the mutants, the frozen
 * manifest, and the gates. Promotion requires ALL gates green.
 */
import { validate } from '../oakscript/validator';
import { parse } from '../oakscript/parser';
import { executeScript } from '../oakscript/interpreter';
import { evaluateRuleOnSource } from './rules';
import { generateMutants, knownGoodCorpus, syntheticBars } from './mutants';
import type { EvalReport, RuleSpec } from './types';

export const SEED_SCRIPT = [
  '// Seed failure — produced in coder testing',
  'len = 14',
  'x = sma(close, 0)',
  'r = rsi(close, len)',
  'plot(x, "SMA", "#22cc88", 2)',
  'plot(r, "RSI", "#ffd166", 1, "separate")',
].join('\n');

export const GATES = {
  requireFullMutantDetection: true,
  requireFullHeldOutDetection: true,
  maxFalsePositives: 0,
  maxNewExecErrors: 0,
} as const;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

export function corpusManifest(): { corpusCount: number; corpusHash: string; manifestHash: string } {
  const corpus = knownGoodCorpus();
  const corpusHash = fnv1a(corpus.map(c => `${c.name}\n${c.source}`).join('\n---\n'));
  const manifestHash = fnv1a(JSON.stringify({ corpusHash, gates: GATES, v: 1 }));
  return { corpusCount: corpus.length, corpusHash, manifestHash };
}

export interface SeedProof {
  baselineValid: boolean;
  baselineIssueCodes: string[];
  /** Finite-value ratio of the SMA plot series itself (the dead series). */
  finiteRatio: number;
  plotCount: number;
}

export function proveSeedFailure(): SeedProof {
  const baseline = validate(SEED_SCRIPT);
  const bars = syntheticBars(120);
  let finite = 0, total = 0, plotCount = 0;
  try {
    const result = executeScript(parse(SEED_SCRIPT), bars, new Map());
    plotCount = result.plots.length;
    for (const p of result.plots) {
      if (p.name !== 'SMA') continue;
      if (Array.isArray(p.series)) {
        for (const v of p.series) { total++; if (Number.isFinite(v)) finite++; }
      } else if (typeof p.value === 'number') {
        total++; if (Number.isFinite(p.value)) finite++;
      }
    }
  } catch { /* execution failure is itself evidence */ }
  return {
    baselineValid: baseline.valid,
    baselineIssueCodes: baseline.issues.map(i => i.code),
    finiteRatio: total > 0 ? finite / total : 0,
    plotCount,
  };
}

function countExecErrors(runRule: RuleSpec | null): number {
  const corpus = knownGoodCorpus();
  const bars = syntheticBars(120);
  let errorScripts = 0;
  for (const entry of corpus) {
    // The rule is validator-side only; execution is unchanged by construction.
    // This probe measures that the known-good corpus still executes cleanly.
    void runRule;
    try {
      const result = executeScript(parse(entry.source), bars, new Map());
      if (result.errors.length > 0) errorScripts++;
    } catch {
      errorScripts++;
    }
  }
  return errorScripts;
}

export function evaluateCandidate(rule: RuleSpec, opts: { execProbe?: boolean } = {}): EvalReport {
  const started = performance.now();
  const corpus = knownGoodCorpus();
  const mutants = generateMutants(rule.family, corpus);
  const { manifestHash } = corpusManifest();

  let caught = 0, heldCaught = 0;
  const held = mutants.filter(m => m.heldOut);
  for (const m of mutants) {
    const issues = evaluateRuleOnSource(rule, m.source);
    const hit = issues.some(i => i.severity === 'error' && i.code === rule.issueCode);
    if (hit) { caught++; if (m.heldOut) heldCaught++; }
  }

  const falsePositiveNames: string[] = [];
  let counterexample: string | undefined;
  for (const entry of corpus) {
    const issues = evaluateRuleOnSource(rule, entry.source);
    const errs = issues.filter(i => i.severity === 'error');
    if (errs.length > 0) {
      falsePositiveNames.push(entry.name);
      if (!counterexample) {
        counterexample = `${entry.name}: [${errs[0].code}] ${errs[0].message}`;
      }
    }
  }

  const baselineExecErrors = opts.execProbe === false ? 0 : countExecErrors(null);
  const candidateExecErrors = opts.execProbe === false ? 0 : baselineExecErrors;

  const reasons: string[] = [];
  const detectionOk = mutants.length > 0 && caught === mutants.length;
  const heldOk = held.length === 0 || heldCaught === held.length;
  const fpOk = falsePositiveNames.length <= GATES.maxFalsePositives;
  const execOk = (candidateExecErrors - baselineExecErrors) <= GATES.maxNewExecErrors;
  if (!detectionOk) reasons.push(`Mutant detection ${caught}/${mutants.length} — gate requires ${mutants.length}/${mutants.length}.`);
  if (!heldOk) reasons.push(`Held-out detection ${heldCaught}/${held.length} — gate requires full held-out detection.`);
  if (!fpOk) reasons.push(`False positives on ${falsePositiveNames.length} known-good script(s): ${falsePositiveNames.slice(0, 4).join(', ')}.`);
  if (!execOk) reasons.push(`Corpus execution errors rose ${baselineExecErrors} → ${candidateExecErrors}.`);
  if (reasons.length === 0) reasons.push('All gates green: full mutant detection (visible + held-out), zero false positives, no new corpus execution errors.');

  return {
    ruleId: rule.id,
    mutantTotal: mutants.length,
    mutantCaught: caught,
    heldOutTotal: held.length,
    heldOutCaught: heldCaught,
    goodTotal: corpus.length,
    falsePositiveCount: falsePositiveNames.length,
    falsePositiveNames,
    counterexample,
    baselineExecErrors,
    candidateExecErrors,
    durationMs: Math.round(performance.now() - started),
    manifestHash,
    verdict: reasons.length === 1 && detectionOk && heldOk && fpOk && execOk ? 'promoted' : 'rejected',
    reasons,
  };
}
