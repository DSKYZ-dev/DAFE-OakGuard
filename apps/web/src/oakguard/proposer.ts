/**
 * OakGuard proposer — a Meta model writes candidate rules; the referee grades them.
 *
 * The model sees one escape (a script the validator accepted that the runtime
 * oracles prove broken) and answers with ONE rule spec, constrained by a JSON
 * schema to the fixed rule language. It never sees the held-out variants or
 * the known-good corpus. When the referee rejects a spec, the model gets the
 * reasons, the visible variants it missed and the false-positive line, and may
 * revise it. Every exchange is recorded: model, prompt hash, tokens, cost.
 *
 * The transport is injected, so the same loop runs live against the backend,
 * from a recorded run (judge mode, headless tests) or from Node tooling.
 */
import { validate } from '../oakscript/validator';
import { evaluateCandidate } from './evaluator';
import { runOracles, describeFindings } from './oracles';
import { knownGoodCorpus } from './mutants';
import { LENGTH_ARG_POSITIONS, RULE_FAMILIES, WINDOW_OPERATORS } from './rules';
import type { EscapeCase } from './escapes';
import type { EvalReport, ProposalMeta, RuleParams, RuleSpec, WindowOperator } from './types';

export const DEFAULT_PROPOSER_MODEL = 'muse-wonder-1.0';

export interface TransportRequest {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  /** Identifies the exchange for replay: escape id + round. */
  key: string;
}

export interface TransportReply {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  source: 'live' | 'replay';
  recordedAt?: string;
}

export type ProposerTransport = (req: TransportRequest) => Promise<TransportReply>;

export const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'family', 'issueCode', 'description', 'rationale', 'fixHint', 'params'],
  properties: {
    name: { type: 'string', description: 'Short human name for the rule.' },
    family: { type: 'string', enum: RULE_FAMILIES },
    issueCode: { type: 'string', description: 'New UPPER_SNAKE_CASE issue code.' },
    description: { type: 'string', description: 'What the rule flags, in one sentence.' },
    rationale: { type: 'string', description: 'Why code matching the rule is broken.' },
    fixHint: { type: 'string', description: 'One sentence telling a coder how to fix flagged code.' },
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['functions', 'windowFunctions', 'operators', 'followVariables', 'allowObjectMethods'],
      properties: {
        functions: { type: 'array', items: { type: 'string' } },
        windowFunctions: { type: 'array', items: { type: 'string', enum: ['highest', 'lowest'] } },
        operators: { type: 'array', items: { type: 'string', enum: WINDOW_OPERATORS } },
        followVariables: { type: 'boolean' },
        allowObjectMethods: { type: 'boolean' },
      },
    },
  },
} as const;

export function buildProposerSystem(): string {
  return `You are the rule proposer in OakGuard, a verification system for AI-written OakScript trading indicators.

You do not write code. You write ONE declarative rule in a fixed rule language, as JSON. An independent referee then tests the rule against broken variants of the bug (some of them are held out and never shown to you) and against ${knownGoodCorpus().length} known-good scripts. The rule is promoted into the validator only if it flags every broken variant and none of the good scripts. If it is rejected you will see why, and you may revise it.

The rule language has three families. Each one is a fixed checker; you choose the family and fill in its parameters.

1. positive-int-length
   Flags a builtin call whose length argument is a numeric literal that is not a positive integer (0, -3, 2.5).
   params.functions: the builtins to check. Length builtins: ${Object.keys(LENGTH_ARG_POSITIONS).join(', ')}. Empty array = all of them.

2. unknown-dotted-call
   Flags a dotted call name.method(...) that is not a registered builtin (array.*, line.new, table.cell, color.new, model.*, ...).
   params.allowObjectMethods: when true, method names that runtime objects expose (push, get, set, sum, avg, size, ...) are allowed after any variable, because OakRing, Matrix and table handles have methods that are not registry builtins.

3. self-inclusive-window
   Flags a comparison between a price series (open, high, low, close) and a highest()/lowest() window over a price series evaluated on the same bar, with no [k] history offset on the window.
   params.windowFunctions: highest and/or lowest. Empty = both.
   params.operators: which forms to flag, from >, <, >=, <=, ==, crossover, crossunder. Empty = >, <, crossover, crossunder.
   params.followVariables: when true, a variable assigned from a window (hh = highest(high, 20)) is tracked into later comparisons that use it.

Send parameters a family does not use as an empty array or false.
issueCode must be a new UPPER_SNAKE_CASE code. fixHint must tell a coder exactly how to repair flagged code.

Think about every way the same bug can be written, and about the legitimate code that looks similar. A rule that is too narrow misses held-out variants; a rule that is too broad flags good scripts.`;
}

function numbered(source: string): string {
  return source.split('\n').map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
}

export interface RoundRecord {
  round: number;
  rule?: RuleSpec;
  report?: EvalReport;
  /** Parse or transport failure for this round. */
  error?: string;
  meta?: ProposalMeta;
}

function describeRound(r: RoundRecord): string {
  if (r.error) return `Round ${r.round}: your reply could not be used: ${r.error}`;
  if (!r.rule || !r.report) return `Round ${r.round}: no result.`;
  const spec = JSON.stringify({ family: r.rule.family, issueCode: r.rule.issueCode, params: r.rule.params ?? {}, allowObjectMethods: r.rule.allowObjectMethods ?? false });
  const lines = [`Round ${r.round}: ${spec}`, `  Verdict: ${r.report.verdict.toUpperCase()}`];
  for (const reason of r.report.reasons) lines.push(`  - ${reason}`);
  if (r.report.missedVisible?.length) lines.push(`  Visible variants it missed: ${r.report.missedVisible.join(' | ')}`);
  if (r.report.heldOutTotal > r.report.heldOutCaught) lines.push(`  Held-out variants missed: ${r.report.heldOutTotal - r.report.heldOutCaught} (not shown).`);
  if (r.report.counterexample) lines.push(`  False positive: ${r.report.counterexample.split(':')[0]}, line: ${r.report.counterexampleLine ?? ''}`);
  return lines.join('\n');
}

export function buildProposerUser(escape: EscapeCase, evidence: string, history: RoundRecord[]): string {
  const v = validate(escape.source);
  const verdict = v.valid ? `valid, ${v.issues.length} warning(s)` : `invalid (${v.issues.filter(i => i.severity === 'error').map(i => i.code).join(', ')})`;
  const parts = [
    'ESCAPE: the baseline validator accepted this script, but running it shows a defect.',
    '',
    '```oakscript',
    numbered(escape.source),
    '```',
    '',
    `RUNTIME EVIDENCE: ${evidence}`,
    `BASELINE VALIDATOR: ${verdict}`,
    '',
    'Write one rule that would have flagged this script before it ran, and every other way of writing the same bug.',
  ];
  if (history.length) {
    parts.push('', 'YOUR EARLIER ATTEMPTS AND THE REFEREE\'S VERDICTS:', ...history.map(describeRound), '', 'Revise the rule so it passes every gate.');
  }
  return parts.join('\n');
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

/** Turn the model's JSON into a RuleSpec. Shape errors become a reason the model can act on. */
export function parseProposal(content: string, ctx: { escape: EscapeCase; round: number; meta: ProposalMeta }): { rule?: RuleSpec; error?: string } {
  let obj: any;
  try {
    obj = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    return { error: 'the reply was not valid JSON' };
  }
  if (!obj || typeof obj !== 'object') return { error: 'the reply was not a JSON object' };
  const p = obj.params || {};
  const params: RuleParams = {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  if (strings(p.functions).length) params.functions = strings(p.functions);
  if (strings(p.windowFunctions).length) params.windowFunctions = strings(p.windowFunctions) as RuleParams['windowFunctions'];
  if (strings(p.operators).length) params.operators = strings(p.operators) as WindowOperator[];
  if (p.followVariables === true) params.followVariables = true;
  const rule: RuleSpec = {
    id: `${ctx.meta.model.replace(/[^a-z0-9]+/gi, '-')}-${ctx.escape.defectClass}-r${ctx.round}-${ctx.meta.promptHash}`,
    name: String(obj.name || 'Unnamed rule').slice(0, 80),
    family: obj.family,
    issueCode: String(obj.issueCode || ''),
    severity: 'error',
    description: String(obj.description || '').slice(0, 400),
    rationale: String(obj.rationale || '').slice(0, 600),
    fixHint: String(obj.fixHint || '').slice(0, 300) || undefined,
    proposedBy: ctx.meta.model,
    allowObjectMethods: p.allowObjectMethods === true ? true : undefined,
    params,
    defectClass: ctx.escape.defectClass,
    proposal: ctx.meta,
  };
  return { rule };
}

export interface LoopResult {
  escape: EscapeCase;
  evidence: string;
  rounds: RoundRecord[];
  promoted?: RuleSpec;
  totalCostUsd: number;
  totalLatencyMs: number;
}

export interface LoopOptions {
  escape: EscapeCase;
  transport: ProposerTransport;
  model?: string;
  maxRounds?: number;
  onRound?: (round: RoundRecord, phase: 'proposed' | 'graded') => void;
}

/** Propose → referee → (revise) until promoted or out of rounds. */
export async function runProposalLoop(opts: LoopOptions): Promise<LoopResult> {
  const model = opts.model ?? DEFAULT_PROPOSER_MODEL;
  const maxRounds = opts.maxRounds ?? 3;
  const evidence = describeFindings(runOracles(opts.escape.source));
  const system = buildProposerSystem();
  const rounds: RoundRecord[] = [];
  let promoted: RuleSpec | undefined;
  let cost = 0;
  let latency = 0;

  for (let round = 1; round <= maxRounds && !promoted; round++) {
    const user = buildProposerUser(opts.escape, evidence, rounds);
    const promptHash = hash(system + '\n' + user);
    const record: RoundRecord = { round };
    let reply: TransportReply;
    try {
      reply = await opts.transport({ model, system, user, schema: PROPOSAL_SCHEMA as any, schemaName: 'oakguard_rule', key: `${opts.escape.id}#${round}` });
    } catch (e: any) {
      record.error = `transport failed: ${String(e?.message || e).slice(0, 200)}`;
      rounds.push(record);
      opts.onRound?.(record, 'graded');
      break;
    }
    cost += reply.costUsd;
    latency += reply.latencyMs;
    record.meta = {
      model: reply.model || model,
      round,
      promptHash,
      latencyMs: reply.latencyMs,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      costUsd: reply.costUsd,
      source: reply.source,
      recordedAt: reply.recordedAt,
      raw: reply.content.slice(0, 4000),
    };
    const parsed = parseProposal(reply.content, { escape: opts.escape, round, meta: record.meta });
    if (parsed.error || !parsed.rule) {
      record.error = parsed.error;
      rounds.push(record);
      opts.onRound?.(record, 'graded');
      continue;
    }
    record.rule = parsed.rule;
    opts.onRound?.(record, 'proposed');
    record.report = evaluateCandidate(parsed.rule);
    rounds.push(record);
    opts.onRound?.(record, 'graded');
    if (record.report.verdict === 'promoted') promoted = parsed.rule;
  }
  return { escape: opts.escape, evidence, rounds, promoted, totalCostUsd: cost, totalLatencyMs: latency };
}

// ─── Transports ─────────────────────────────────────────────────────

/** Live: the backend holds the Meta key and enforces the schema. */
export function backendTransport(baseUrl: string, post?: (url: string, body: unknown) => Promise<any>): ProposerTransport {
  const send = post ?? (async (url: string, body: unknown) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  });
  return async (req) => {
    const d = await send(`${baseUrl}/api/meta/structured`, {
      model: req.model,
      system: req.system,
      user: req.user,
      schema: req.schema,
      schema_name: req.schemaName,
      reasoning_effort: 'medium',
      max_tokens: 8000,
    });
    if (!d?.ok) throw new Error(d?.detail || 'Meta Model API call failed');
    return {
      content: String(d.content || ''),
      model: String(d.model || req.model),
      inputTokens: Number(d.usage?.input_tokens || 0),
      outputTokens: Number(d.usage?.output_tokens || 0),
      latencyMs: Number(d.latency_ms || 0),
      costUsd: Number(d.cost_usd || 0),
      source: 'live',
    };
  };
}

export interface RecordedExchange {
  key: string;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  promptHash: string;
}

export interface RecordedRun {
  recordedAt: string;
  model: string;
  note: string;
  exchanges: RecordedExchange[];
}

/** Replay: the model's recorded text is re-graded by today's referee; verdicts are never replayed. */
export function replayTransport(run: RecordedRun): ProposerTransport {
  return async (req) => {
    const hit = run.exchanges.find(e => e.key === req.key);
    if (!hit) throw new Error(`no recorded reply for ${req.key}`);
    return {
      content: hit.content,
      model: hit.model,
      inputTokens: hit.inputTokens,
      outputTokens: hit.outputTokens,
      latencyMs: hit.latencyMs,
      costUsd: hit.costUsd,
      source: 'replay',
      recordedAt: run.recordedAt,
    };
  };
}

/** Wrap a live transport so every exchange is captured for a recorded run. */
export function recordingTransport(inner: ProposerTransport, sink: RecordedExchange[]): ProposerTransport {
  return async (req) => {
    const reply = await inner(req);
    sink.push({
      key: req.key,
      model: reply.model,
      content: reply.content,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      latencyMs: reply.latencyMs,
      costUsd: reply.costUsd,
      promptHash: hash(req.system + '\n' + req.user),
    });
    return reply;
  };
}
