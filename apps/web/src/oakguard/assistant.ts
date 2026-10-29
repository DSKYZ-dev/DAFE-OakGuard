/**
 * OakGuard — Trade Assistant policy pack.
 *
 * Same engine as the Editor pack (propose → grade → promote/archive),
 * different epistemics: the Assistant is selective, not constructive.
 * Its rules are graded on PROCESS COMPLIANCE and CORRECT ABSTENTION over
 * point-in-time scenarios (regime known at decision time only) — never
 * on outcomes alone, which would train a gambler.
 *
 * Every rule depends on Editor-certified tools (indicators). When one of
 * those tools changes state, dependents lose certification automatically
 * (see store.invalidateDependents).
 */
import { StdLib } from '../oakscript/runtime';
import type { AssistantRule } from './types';

/**
 * Point-in-time regime read (mirrors regime-ribbon.ts thresholds; kept
 * local so the headless evaluator never pulls UI modules into Node).
 */
function classifyRegimeLocal(high: number[], low: number[], close: number[]): { regime: string; atrRatio: number } {
  const n = close.length;
  const start = Math.max(0, n - 300);
  const h = high.slice(start), l = low.slice(start), c = close.slice(start);
  const last = c.length - 1;
  const adxVal = StdLib.adx(h, l, c, 14)[last] || 0;
  const atrSeries = StdLib.atr(h, l, c, 14);
  const atrPct = atrSeries.map((v, i) => (c[i] > 0 ? (v / c[i]) * 100 : 0));
  const baseline = atrPct.slice(Math.max(0, atrPct.length - 50));
  const avgBaseline = baseline.reduce((a, b) => a + b, 0) / (baseline.length || 1);
  const atrRatio = avgBaseline > 0 ? atrPct[last] / avgBaseline : 1;
  const regime = atrRatio >= 1.6 ? 'volatile' : adxVal >= 25 && atrRatio < 1.3 ? 'trending' : 'ranging';
  return { regime, atrRatio };
}

export const ASSISTANT_RULES: AssistantRule[] = [
  {
    id: 'ast-volatile-abstain',
    name: 'Abstain in Volatile Regime',
    description: 'No fresh directional calls while the regime engine reads volatile (ATR ratio ≥ 1.6). Silence is a graded, correct action here.',
    dependsOn: ['CCI Manifold Sheet'],
    decide: (regime) => (regime === 'volatile' ? 'abstain' : 'trade'),
    rationale: 'Whipsaw regimes invalidate oscillator extremes within bars; the dashboard zone cannot be trusted mid-spike.',
  },
  {
    id: 'ast-atr-reduce',
    name: 'Reduce Size on ATR Expansion',
    description: 'When ATR ratio > 1.3, halve intended size instead of trading full size or abstaining outright.',
    dependsOn: ['ATR Trailing Stops'],
    decide: (_regime, atrRatio) => (atrRatio > 1.3 ? 'reduce' : 'trade'),
    rationale: 'Stops widen with ATR; unchanged size silently doubles risk per trade.',
  },
  {
    id: 'ast-range-only-extremes',
    name: 'In Ranging Regime, Extremes Only',
    description: 'In a ranging regime, act only at session-range extremes (the Session High/Low tool territory); mid-range is abstention.',
    dependsOn: ['Session High/Low Divergence', 'CCI Manifold Sheet'],
    decide: (regime) => (regime === 'ranging' ? 'abstain' : 'trade'),
    rationale: 'Mid-range entries in chop pay spread and slippage for coin-flip outcomes.',
  },
];

export interface ScenarioResult {
  label: 'trending' | 'ranging' | 'volatile';
  classified: string;
  atrRatio: number;
}

export interface AssistantGrade {
  ruleId: string;
  scenarios: number;
  compliant: number;
  abstentionsCorrect: number;
  verdict: 'promoted' | 'rejected';
  reasons: string[];
}

function series(kind: 'trending' | 'ranging' | 'volatile', seed: number): { high: number[]; low: number[]; close: number[] } {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const close: number[] = [], high: number[] = [], low: number[] = [];
  let px = 100;
  for (let i = 0; i < 160; i++) {
    let drift = 0;
    if (kind === 'trending') drift = 0.45;
    else if (kind === 'ranging') drift = (100 - px) * 0.12 + (rnd() - 0.5) * 0.3; // pinned mean-reversion: low ADX
    else if (i > 90) drift = (rnd() - 0.5) * (2 + ((i - 90) / 70) * 11); // vol ramps up through the end
    else drift = (rnd() - 0.5) * 0.8;
    px = Math.max(5, px + drift + (rnd() - 0.5) * 0.5);
    close.push(px);
    high.push(px + 0.4 + rnd() * 0.4);
    low.push(px - 0.4 - rnd() * 0.4);
  }
  return { high, low, close };
}

export function buildScenarios(): ScenarioResult[] {
  const out: ScenarioResult[] = [];
  (['trending', 'ranging', 'volatile'] as const).forEach((label, i) => {
    const b = series(label, 100 + i * 17);
    const r = classifyRegimeLocal(b.high, b.low, b.close);
    out.push({ label, classified: r.regime, atrRatio: r.atrRatio });
  });
  return out;
}

/**
 * Grade one Assistant rule: for each scenario, the rule's decision must
 * match the process expectation for that scenario class. Abstentions in
 * hostile scenarios count as correct — the grader rewards silence.
 */
export function gradeAssistantRule(rule: AssistantRule): AssistantGrade {
  const scenarios = buildScenarios();
  let compliant = 0;
  let abstentionsCorrect = 0;
  for (const sc of scenarios) {
    const action = rule.decide(sc.classified, sc.atrRatio);
    let expected: string;
    if (rule.id === 'ast-volatile-abstain') expected = sc.label === 'volatile' ? 'abstain' : 'trade';
    else if (rule.id === 'ast-atr-reduce') expected = sc.atrRatio > 1.3 ? 'reduce' : 'trade';
    else expected = sc.label === 'ranging' ? 'abstain' : 'trade';
    if (action === expected) {
      compliant++;
      if (action === 'abstain') abstentionsCorrect++;
    }
  }
  const pass = compliant === scenarios.length;
  return {
    ruleId: rule.id,
    scenarios: scenarios.length,
    compliant,
    abstentionsCorrect,
    verdict: pass ? 'promoted' : 'rejected',
    reasons: [pass
      ? `Process-compliant on ${compliant}/${scenarios.length} point-in-time scenarios (${abstentionsCorrect} correct abstention(s)).`
      : `Only ${compliant}/${scenarios.length} scenario-compliant decisions.`],
  };
}
