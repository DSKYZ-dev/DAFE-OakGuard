/**
 * Shared OakScript generation pipeline.
 *
 * The editor UI, the bridge auto-fix path, and the live final-limit harness
 * all generate through this module. Keeping one pipeline is the only way a
 * live result can prove anything about the app: previously the harness
 * re-implemented Phase 1/2 and skipped the app's mechanical repairs, so it
 * graded a different system than the one users run.
 *
 * Pipeline:
 *   1. Concept brief (deterministic family gate, regenerated up to 2 times).
 *   2. Draft generation with binding constraints + few-shot exemplars.
 *   3. Best-of-2 drafts; early-stop when the first is already clean.
 *   4. Mechanical repair (tables / forbidden 3D / duplicate 3D layers).
 *   5. Validator + request-coverage fix loop with deletion-list escalation.
 *
 * Every model call is injected as a `PipelineChat`, so the whole pipeline is
 * deterministic under test.
 */
import { validate } from '../oakscript/validator';
import { parse } from '../oakscript/parser';
import { executeScript } from '../oakscript/interpreter';
import { syntheticBars, syntheticTrendBars } from '../oakguard/mutants';
import {
  buildBindingBrief,
  checkConceptBrief,
  checkRequestCoverage,
  classifyRequestFamilies,
  familyCodeLines,
  familyIdFromLabel,
  getFamilyLabel,
} from './request-coverage';
import { repairMechanicalViolations } from './mechanical-repair';
import { findExemplars, formatExemplarBlock } from './exemplars';

const PROBE_BARS = syntheticBars(220);
const PROBE_BAR_ARR = PROBE_BARS.close.map((c, i) => ({
  open: PROBE_BARS.open[i],
  high: PROBE_BARS.high[i],
  low: PROBE_BARS.low[i],
  close: c,
}));

/** Regimes for the signal-clustering probe. A condition that is only a state
 *  (close > upperBreak and mom > momThresh) stays true across a whole trend and
 *  paints a wall of markers; a random walk alone cannot show that. */
const CLUSTER_PROBE_REGIMES = [
  { label: 'random-walk', bars: PROBE_BARS },
  { label: 'up-trend', bars: syntheticTrendBars(220, 0.003, 0.02, 7) },
  { label: 'down-trend', bars: syntheticTrendBars(220, -0.003, 0.02, 13) },
];

export type PipelineRole = 'brief' | 'code';
export type PipelineChat = (prompt: string, role: PipelineRole) => Promise<string>;

export interface GradeOptions {
  prefer3D?: boolean;
  previousSource?: string;
}

export interface CodeGrade {
  valid: boolean;
  errors: string[];
  warnings: string[];
  coverage: string[];
  problems: string[];
}

/**
 * Robust code extraction: closed fence, truncated fence salvage, or a bare
 * reply that is clearly code. A closed-fence-only match turns good
 * generations into "Agent did not produce code" whenever the model skips or
 * truncates the fence.
 */
export function extractOakCode(text: string): string {
  if (!text) return '';
  const closed = text.match(/```(?:oakscript|js|javascript)?\s*\n([\s\S]*?)```/);
  if (closed && closed[1].trim().length > 10) return closed[1].trim();
  const open = text.match(/```(?:oakscript|js|javascript)?\s*\n([\s\S]*)$/);
  if (open && open[1].trim().length > 40) return open[1].trim();
  if (/\binput\s*\(|\bplot\w*\s*\(/.test(text)) {
    const lines = text.split('\n');
    const startIdx = lines.findIndex(l => /\binput\s*\(|=|plot\w*\s*\(|var |if |for /.test(l));
    if (startIdx >= 0) return lines.slice(startIdx).join('\n').trim();
    return text.trim();
  }
  return '';
}

/** Signal-clustering probe. Runs the script on a random walk, an up-trend and a
 *  down-trend, and flags any signal that repeats on back-to-back bars or fires
 *  on more than a third of bars. Signals must be events; a state paints a wall. */
export function probeSignalClustering(code: string): string[] {
  const problems: string[] = [];
  const reported = new Set<string>();
  for (const regime of CLUSTER_PROBE_REGIMES) {
    const plots = executeScript(parse(code), regime.bars as any, new Map()).plots as any[];
    const barsByName = new Map<string, Set<number>>();
    for (const p of plots) {
      if ((p.type !== 'shape' && p.type !== 'plot3d_shape') || typeof p.barIdx !== 'number') continue;
      const name = p.name || 'signal';
      const set = barsByName.get(name) ?? new Set<number>();
      set.add(p.barIdx);
      barsByName.set(name, set);
    }
    for (const [name, set] of barsByName) {
      if (reported.has(name)) continue;
      const bars = [...set].sort((a, b) => a - b);
      const n = bars.length;
      let adjacent = 0;
      for (let i = 1; i < n; i++) if (bars[i] - bars[i - 1] === 1) adjacent++;
      if (n >= 6 && adjacent / (n - 1) >= 0.5) {
        reported.add(name);
        problems.push(`COVERAGE: signal "${name}" repeats on back-to-back bars in the ${regime.label} regime (${adjacent} of ${n - 1} marker pairs are adjacent). A condition that stays true across bars paints a cluster. Make it an EVENT: store the state in a variable (state = close > upperBreak and mom > momThresh) and fire on its first bar only (buySig = state and not state[1]), or use crossover/crossunder.`);
      } else if (n / regime.bars.count > 0.35) {
        reported.add(name);
        problems.push(`COVERAGE: signal "${name}" fires on ${Math.round((100 * n) / regime.bars.count)}% of bars in the ${regime.label} regime (limit 35%). Signals must be events, not states: use buySig = state and not state[1], crossover/crossunder, or a bar cooldown.`);
      }
    }
  }
  return problems;
}

/** A 2D line that holds one value on every bar renders as a flat wall. It usually
 *  means an input scalar was plotted directly, or an array read came back empty. */
export function probeConstantLines(plots: any[]): string[] {
  const series = new Map<string, { name: string; values: number[] }>();
  for (const p of plots) {
    if (p.type !== 'line' || typeof p.value !== 'number' || !isFinite(p.value) || typeof p.barIdx !== 'number') continue;
    const key = `${p.name || 'Series'}|${p.pane || 'main'}`;
    const entry = series.get(key) ?? { name: p.name || 'Series', values: [] as number[] };
    entry.values.push(p.value);
    series.set(key, entry);
  }
  const problems: string[] = [];
  for (const { name, values } of series.values()) {
    if (values.length < 50) continue;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    if (hi - lo < 1e-9) {
      problems.push(`COVERAGE: plot "${name}" holds the constant ${lo} on every bar (renders as a flat line). Derive it from bar data, and check that every array or series it reads is actually filled.`);
    }
  }
  return problems;
}

/** Grade syntax + request coverage + 220-bar synthetic execution in one place. */
export function gradeCode(code: string, request: string, opts: GradeOptions = {}): CodeGrade {
  const result = validate(code);
  const errorIssues = result.issues.filter(i => i.severity === 'error');
  const fallbackIssues = result.valid ? [] : result.issues.filter(i => i.severity !== 'error');
  const errors = (errorIssues.length > 0 ? errorIssues : fallbackIssues).map(
    i => `L${i.line} [${i.code}] ${i.message}${i.fix ? ` FIX: ${i.fix}` : ''}`,
  );
  const warnings = result.issues
    .filter(i => i.severity !== 'error')
    .map(i => `L${i.line} [${i.code}] ${i.message}`);
  const coverage = checkRequestCoverage(request, code, {
    prefer3D: opts.prefer3D,
    previousSource: opts.previousSource,
  });
  if (result.valid && code.trim().length > 0) {
    try {
      const exec = executeScript(parse(code), PROBE_BARS as any, new Map());
      if (exec.errors.length > 0) {
        errors.push(`RUNTIME: ${exec.errors.slice(0, 2).join('; ')}`);
      }
      const shapes = exec.plots.filter(p => p.type === 'shape');
      if (shapes.length > 60) {
        coverage.push(`COVERAGE: signal markers fired ${shapes.length} times across 220 bars (limit 60) — signals are too frequent. Gate signals with crossover/crossunder, a state transition (sig and not sig[1]), or a bar cooldown.`);
      }
      const unaligned = shapes.some(s => {
        const b = typeof s.barIdx === 'number' ? PROBE_BAR_ARR[s.barIdx] : undefined;
        return !b || typeof s.price !== 'number' || s.price < b.low - 1e-9 || s.price > b.high + 1e-9;
      });
      if (unaligned) {
        coverage.push('COVERAGE: 2D plotshape() marker price falls outside the bar\'s [low, high] range — anchor 2D plotshape markers directly to low or high.');
      }
      const p3ds = exec.plots.filter(p => p.type === 'plot3d' && Array.isArray((p as any).series));
      if (p3ds.length > 0) {
        const anyVarying = p3ds.some(p => {
          const fin = ((p as any).series as number[]).filter(v => isFinite(v) && !isNaN(v));
          return fin.length >= 2 && Math.max(...fin) - Math.min(...fin) > 1e-9;
        });
        if (!anyVarying) {
          coverage.push('COVERAGE: every plot3d() series in the script is a static constant across all bars (renders as a flat wall/line). Modulate input baselines with bar data (close, open, high, low, volume) so the 3D series varies dynamically bar-by-bar.');
        }
      }
      coverage.push(...probeConstantLines(exec.plots as any[]));
      coverage.push(...probeSignalClustering(code));
    } catch (e: any) {
      errors.push(`RUNTIME: ${String(e?.message || e).slice(0, 140)}`);
    }
  }
  const problems = [...errors, ...coverage];
  return {
    valid: result.valid && errors.length === 0 && coverage.length === 0,
    errors,
    warnings,
    coverage,
    problems,
  };
}

function gradeScore(grade: CodeGrade): number {
  // Syntax errors are fatal; coverage errors mean the script is the wrong
  // indicator and are equally fatal to the user. Warnings do not count.
  return grade.errors.length * 2 + grade.coverage.length * 2;
}

interface MechanicalResult {
  code: string;
  removed: string[];
  grade: CodeGrade;
}

/** Apply mechanical repairs, keeping them only when the result is no worse. */
function applyMechanical(code: string, request: string, opts: GradeOptions): MechanicalResult {
  const before = gradeCode(code, request, opts);
  const clustered = before.problems.some(p => /repeats on back-to-back bars|fires on \d+% of bars/.test(p));
  const repaired = repairMechanicalViolations(code, request, { prefer3D: opts.prefer3D, eventMarkers: clustered });
  if (repaired.removed.length === 0) return { code, removed: [], grade: before };
  const after = gradeCode(repaired.code, request, opts);
  if (gradeScore(after) > gradeScore(before)) {
    return { code, removed: [], grade: before };
  }
  return { code: repaired.code, removed: repaired.removed, grade: after };
}

// ─── Concept brief ──────────────────────────────────────────────────

export interface BriefResult {
  brief: string;
  attempts: number;
  problems: string[];
  /** True when the brief never passed and deterministic constraints are the
   *  only thing protecting code generation. */
  fallback: boolean;
}

export function buildConceptPrompt(request: string): string {
  const { requested, excluded } = classifyRequestFamilies(request);
  const named = requested.length > 0 ? requested.map(getFamilyLabel).join(', ') : 'NONE';
  const rejected = excluded.length > 0 ? excluded.map(getFamilyLabel).join(', ') : 'NONE';
  return `Design a technical indicator based on this description:

"${request}"

DETERMINISTIC FAMILY EXTRACTION (checked against your brief):
- Request explicitly names: ${named}
- Request explicitly rejects: ${rejected}

HARD CONSTRAINTS:
- Design ONLY from concepts named in the description. Do NOT introduce moving averages (EMA/SMA), MACD, RSI, ATR, Bollinger or any other indicator family unless the description explicitly asks for it.
- If the description forbids a family, the design must not use it anywhere.
- Signal conditions must not be near-tautological (e.g. low < close fires on most bars).

Respond with ONLY the algorithm design (no code yet), in this exact shape:
1. Indicator Name
2. USES: comma-separated concept families the design will use
3. EXCLUDES: comma-separated concept families the request forbids (write NONE if none)
4. Input Parameters (each with default value)
5. Calculation Logic (step-by-step plain math, using ONLY the requested concepts)
6. Signal Rules (when to trigger buy/sell/alert)
7. Visual Plan (what to plot and how — lines, shapes, 3D?)

Keep it concise. The next phase will generate code from this design.`;
}

/** Generate the pre-code brief and gate it before any code is written. A
 *  poisoned brief is regenerated; after three failed attempts the pipeline
 *  proceeds with deterministic binding constraints instead. */
export async function generateConceptBrief(
  request: string,
  chat: PipelineChat,
  onStatus?: (message: string) => void,
): Promise<BriefResult> {
  let brief = '';
  let problems: string[] = [];
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retry = attempt === 1
      ? ''
      : `\n\nYour previous brief failed the binding-constraint check:\n${problems.map(p => `- ${p}`).join('\n')}\n\nRewrite the design so it satisfies every requested concept and uses nothing the request did not name. Repeat the USES:/EXCLUDES: lines exactly.`;
    brief = await chat(buildConceptPrompt(request) + retry, 'brief');
    problems = checkConceptBrief(request, brief);
    if (problems.length === 0) {
      return { brief, attempts: attempt, problems: [], fallback: false };
    }
    onStatus?.(`Concept brief rejected (attempt ${attempt}/${maxAttempts}): ${problems[0]}`);
  }
  onStatus?.('Concept brief still imperfect — injecting deterministic binding constraints into code generation.');
  return { brief, attempts: maxAttempts, problems, fallback: true };
}

// ─── Draft generation ───────────────────────────────────────────────

export function buildCodePrompt(
  request: string,
  brief: string,
  opts: { variant?: number; previousProblems?: string[] } = {},
): string {
  const variant = opts.variant ?? 1;
  const exemplars = findExemplars(request, { max: 2 });
  const exemplarBlock = formatExemplarBlock(exemplars);
  const alternate = variant > 1
    ? `\n\nA previous attempt at this request failed these checks:\n${(opts.previousProblems || []).map(p => `- ${p}`).join('\n')}\nWrite a DIFFERENT approach that fixes them. Do not patch the failed draft — rebuild from the design.`
    : '';
  return `Based on this indicator design, generate the COMPLETE OakScript code.

ORIGINAL REQUEST (the code must satisfy this, not a nearby generic indicator):
"${request}"

DESIGN:
${brief}

${buildBindingBrief(request)}
${alternate}${exemplarBlock}
Rules:
- Implement the DESIGN faithfully. Do not add any indicator family that is not in the design.
- Declare every parameter with input(); give length inputs a usable range around the default.
- Arrays: build a list of values with a literal, e.g. arr = [ch1, ch2, ch3]. array(n) only pre-allocates n empty slots, and array(a, b, c) returns an EMPTY array, so every average over it reads 0.
- Use { } braces for any if/else/for/while block with more than one statement or with nesting.
- OakScript signatures are positional and exact: atr(high, low, close, length) — never atr(length); plot(value, "Title", "#hex", linewidth, pane?) — never color=/linewidth= named args; plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") — style is a quoted string, never shape.*.
- Use plot() for lines, hline() only for constants, plotshape() for signal markers inside if-blocks. Dynamic levels use plot(..., "stepline"), never hline.
- Always emit 2D plot() / plotshape() alongside any 3D plot3d() / plotshape_3d() calls so the model renders completely in both 2D and 3D modes.
- Every plotted series must vary dynamically across bars (modulated by close, open, high, low, volume, or bar_index around any input() baseline) — never pass a constant input() scalar directly to plot() or plot3d().
- Signals are EVENTS, not states. A compound condition such as close > upperBreak and mom > momThresh stays true across a whole trend and paints a cluster of markers. Fire on the first bar only: crossover/crossunder, or store the state in a variable and fire on its edge (buySig = state and not state[1]), or add a bar cooldown. A marker must never fire on more than about a third of bars.
- Do NOT build a table.new dashboard unless the request explicitly asks for an on-chart table; the app renders its own metrics dashboard.
- 3D: pane "3d" is for price-denominated series (price EMAs, levels); oscillator/non-price series (RSI/CCI/MACD/Stoch/ADX/dBm/PSI/knots) use pane "separate" in both plot() and plot3d(). Do not plot the same source under multiple 3D styles. Use markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1) for cone size — never introduce atr() just to scale cone size.
- Keep visuals to what the request needs — no decorative layers.
- Output ONLY the complete code inside \`\`\`oakscript fences. No explanation.`;
}

/**
 * Last-chance compact prompt used after normal drafts return no usable code.
 * Drops the exemplar block and keeps only the request, compact design summary,
 * and deterministic binding constraints so models that exhausted their output
 * budget on hidden reasoning still emit complete code.
 */
export function buildRecoveryPrompt(request: string, brief: string): string {
  const compactBrief = (brief || '').trim().slice(0, 900);
  return `Your previous replies contained NO usable OakScript code. Output ONLY the complete OakScript code inside \`\`\`oakscript fences — no prose, no explanation.

REQUEST: "${request}"
${compactBrief ? `\nDESIGN SUMMARY:\n${compactBrief}\n` : ''}
${buildBindingBrief(request)}

Rules:
- Start directly with input() declarations, then calculations, signal booleans, if-gated plotshape() markers, and top-level plot()/plot3d() calls.
- Positional signatures only: atr(high, low, close, length), plot(value, "Title", "#hex", linewidth, pane?), plotshape(bar_index, low, "Buy", "triangleup", "#22cc88").
- No table.new unless explicitly requested. Oscillators use pane "separate", never "3d".`;
}

function summarizeNoCode(label: string, reply: string): string {
  const clean = (reply || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean === '(empty response)') return `${label}: empty reply`;
  return `${label}: no extractable code (${clean.length} chars: "${clean.slice(0, 120)}")`;
}

async function requestCode(
  chat: PipelineChat,
  prompt: string,
  onNoCode?: (reply: string, attempt: number) => void,
): Promise<string> {
  const reply = await chat(prompt, 'code');
  let code = extractOakCode(reply);
  if (code) return code;
  onNoCode?.(reply, 1);
  // Empty/truncated reply: one code-only retry, exactly as the app did.
  const retry = await chat(
    `Output ONLY the complete OakScript code inside \`\`\`oakscript fences. No prose, no explanation. Every line, start to finish.\n\n${prompt}`,
    'code',
  );
  code = extractOakCode(retry);
  if (!code) onNoCode?.(retry, 2);
  return code;
}

async function generateDraft(
  request: string,
  brief: string,
  chat: PipelineChat,
  variant: number,
  previousProblems?: string[],
  onNoCode?: (reply: string, attempt: number) => void,
): Promise<string> {
  return requestCode(chat, buildCodePrompt(request, brief, { variant, previousProblems }), onNoCode);
}

// ─── Repair loop ────────────────────────────────────────────────────

export interface RepairOptions {
  request: string;
  code: string;
  chat: PipelineChat;
  prefer3D?: boolean;
  previousSource?: string;
  maxRounds?: number;
  onIteration?: (round: number, problems: string[], code: string) => void;
  onStatus?: (message: string) => void;
}

export interface RepairResult {
  valid: boolean;
  finalCode: string;
  rounds: number;
  grade: CodeGrade;
  repairs: string[];
}

/** Pull the exact lines that must be deleted from the current coverage
 *  report. The model gets this list from round 2 onward; on the final round
 *  deletion is mandatory rather than advisory. */
export function removalLinesFor(code: string, problems: string[]): string[] {
  const ids = new Set<string>();
  for (const problem of problems) {
    const introduced = /introduces (.+?), which/i.exec(problem);
    const rejected = /explicitly rejected (.+?) \(/i.exec(problem);
    for (const label of [introduced?.[1], rejected?.[1]]) {
      if (!label) continue;
      const id = familyIdFromLabel(label);
      if (id) ids.add(id);
    }
  }
  const lines: string[] = [];
  for (const id of ids) {
    for (const line of familyCodeLines(code, id)) {
      if (line && !lines.includes(line)) lines.push(line);
    }
  }
  // Structural violations may survive mechanical repair (multi-line calls,
  // conditional tables). Name the exact lines so the fix is unambiguous.
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const tableProblem = problems.some(p => /table\.new dashboard/i.test(p));
    const threeDProblem = problems.some(p => /3D calls|plot3d|3D rendering/i.test(p));
    if (tableProblem && /\btable\.(?:new|cell|clear|delete)\s*\(/.test(t) && !lines.includes(t)) lines.push(t);
    if (threeDProblem && /\b(?:plot3d|plotshape_3d|label3d)\s*\(/.test(t) && !lines.includes(t)) lines.push(t);
  }
  return lines;
}

export function buildFixPrompt(
  request: string,
  code: string,
  problems: string[],
  opts: { round: number; maxRounds: number; removalLines?: string[] } = { round: 1, maxRounds: 3 },
): string {
  const removals = opts.removalLines || [];
  const escalation = removals.length === 0
    ? ''
    : opts.round >= opts.maxRounds
      ? `\n\nFINAL REPAIR ROUND — MANDATORY DELETIONS. Your previous repairs failed to remove the offending logic. DELETE these exact lines entirely (do not rename, restyle, comment-out, or replace them with another family):\n${removals.map(l => `  - ${l}`).join('\n')}\nIf a deleted line was the only use of a variable, remove that variable too. The corrected script must not contain these calls at all.`
      : `\n\nMANDATORY DELETIONS from this round onward — delete these exact lines entirely (do not rename, restyle, or replace them with another indicator family):\n${removals.map(l => `  - ${l}`).join('\n')}`;
  return `ORIGINAL REQUEST (what this script is supposed to do): "${request}"

The following OakScript code has validation / request-coverage issues. Fix ALL of them AND make sure the code actually satisfies the original request above.

CODE:
\`\`\`oakscript
${code}
\`\`\`

ISSUES:
${problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

${buildBindingBrief(request)}${escalation}

Rules:
- Fix every issue listed above.
- If the code does not implement the original request, rebuild that logic — do not just patch syntax on the wrong indicator.
- If an issue says a family was not requested, DELETE every line that computes or plots it. Do not substitute a different unrequested family.
- Keep the rest of the script intact; output the COMPLETE corrected code.
- Output ONLY the code inside \`\`\`oakscript fences. No explanation.`;
}

/** Repair an existing/drafted script until validator + coverage are clean,
 *  or until the round budget is exhausted. Returns the best-scoring version,
 *  never a regression from the input. */
export async function repairScriptWithGates(opts: RepairOptions): Promise<RepairResult> {
  const maxRounds = opts.maxRounds ?? 5;
  const gradeOpts: GradeOptions = {
    prefer3D: opts.prefer3D,
    previousSource: opts.previousSource,
  };
  const repairs: string[] = [];
  let current = opts.code;
  let rounds = 0;

  let mechanical = applyMechanical(current, opts.request, gradeOpts);
  if (mechanical.removed.length > 0) {
    current = mechanical.code;
    repairs.push(...mechanical.removed);
    opts.onStatus?.(`Mechanically removed: ${mechanical.removed.join('; ')}`);
  }
  let grade = mechanical.grade;
  if (grade.valid) return { valid: true, finalCode: current, rounds, grade, repairs };

  let best = current;
  let bestGrade = grade;
  let bestScore = gradeScore(grade);

  while (rounds < maxRounds) {
    rounds++;
    const removalLines = removalLinesFor(current, grade.problems);
    const prompt = buildFixPrompt(opts.request, current, grade.problems, {
      round: rounds,
      maxRounds,
      removalLines,
    });
    opts.onIteration?.(rounds, grade.problems, '');
    const reply = await opts.chat(prompt, 'code');
    let next = extractOakCode(reply);
    if (!next) {
      const retry = await opts.chat(
        `Output ONLY the complete corrected OakScript code inside \`\`\`oakscript fences. No prose.\n\nISSUES TO FIX:\n${grade.problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nCODE:\n\`\`\`oakscript\n${current}\n\`\`\``,
        'code',
      );
      next = extractOakCode(retry);
    }
    if (!next) break;

    current = next;
    mechanical = applyMechanical(current, opts.request, gradeOpts);
    if (mechanical.removed.length > 0) {
      current = mechanical.code;
      repairs.push(...mechanical.removed);
    }
    grade = mechanical.grade;
    opts.onIteration?.(rounds, grade.problems, current);

    const score = gradeScore(grade);
    if (score < bestScore) {
      best = current;
      bestGrade = grade;
      bestScore = score;
    }
    if (grade.valid) {
      return { valid: true, finalCode: current, rounds, grade, repairs };
    }
  }

  return { valid: bestGrade.valid, finalCode: best, rounds, grade: bestGrade, repairs };
}

// ─── Create / edit entry points ─────────────────────────────────────

export interface GenerateOptions {
  request: string;
  chat: PipelineChat;
  prefer3D?: boolean;
  maxRounds?: number;
  /** 1 disables best-of-2. Default 2. */
  bestOf?: number;
  onPhase?: (phase: number, result: string) => void;
  onStatus?: (message: string) => void;
  onIteration?: (round: number, problems: string[], code: string) => void;
}

export interface GenerateResult {
  finalCode: string;
  brief: string;
  briefAttempts: number;
  briefFallback: boolean;
  drafts: number;
  rounds: number;
  grade: CodeGrade;
  repairs: string[];
  phases: string[];
  /** Diagnostics for failed runs: empty replies, fallbacks, recovery. */
  notes: string[];
}

/** Full create pipeline: gated brief → best-of-N drafts → gated repair. */
export async function generateIndicatorWithGates(opts: GenerateOptions): Promise<GenerateResult> {
  const phases: string[] = [];
  const notes: string[] = [];
  const briefResult = await generateConceptBrief(opts.request, opts.chat, opts.onStatus);
  phases.push(briefResult.brief);
  opts.onPhase?.(1, briefResult.brief);
  if (briefResult.fallback) {
    notes.push(`brief fallback after ${briefResult.attempts} attempts (${briefResult.problems[0] || 'imperfect brief'})`);
  }

  const bestOf = Math.max(1, opts.bestOf ?? 2);
  let chosenCode = '';
  let chosenGrade: CodeGrade | null = null;
  let drafts = 0;
  let previousProblems: string[] = [];
  const draftRepairs: string[] = [];

  for (let draft = 1; draft <= bestOf; draft++) {
    drafts = draft;
    const code = await generateDraft(
      opts.request,
      briefResult.brief,
      opts.chat,
      draft,
      previousProblems,
      (reply, attempt) => notes.push(summarizeNoCode(`draft ${draft} attempt ${attempt}`, reply)),
    );
    if (!code) {
      previousProblems = ['The previous reply contained no usable OakScript code.'];
      continue;
    }
    const mechanical = applyMechanical(code, opts.request, { prefer3D: opts.prefer3D });
    const grade = mechanical.grade;
    if (mechanical.removed.length > 0) draftRepairs.push(...mechanical.removed);
    if (!chosenGrade || gradeScore(grade) < gradeScore(chosenGrade)) {
      chosenCode = mechanical.code;
      chosenGrade = grade;
    }
    if (grade.valid) break;
    previousProblems = grade.problems;
    // Early-stop only when draft 1 is clean. Otherwise a second draft gives
    // the repair loop a better starting point when the model's first idea
    // was the wrong indicator family.
  }

  // Empty-reply failover: if every normal draft came back empty/prose, shrink
  // the prompt to the request + compact design summary + binding constraints
  // (dropping the exemplar block) and make one recovery attempt.
  if (!chosenCode) {
    opts.onStatus?.('Drafts returned no code — retrying with compact design-summary prompt.');
    notes.push('empty-reply failover: compact design-summary recovery prompt');
    const recovered = await requestCode(
      opts.chat,
      buildRecoveryPrompt(opts.request, briefResult.brief),
      (reply, attempt) => notes.push(summarizeNoCode(`recovery attempt ${attempt}`, reply)),
    );
    if (recovered) {
      const mechanical = applyMechanical(recovered, opts.request, { prefer3D: opts.prefer3D });
      chosenCode = mechanical.code;
      chosenGrade = mechanical.grade;
      if (mechanical.removed.length > 0) draftRepairs.push(...mechanical.removed);
    }
  }

  opts.onPhase?.(2, chosenCode);
  phases.push(chosenCode);

  if (!chosenCode) {
    const empty = gradeCode('', opts.request, { prefer3D: opts.prefer3D });
    return {
      finalCode: '',
      brief: briefResult.brief,
      briefAttempts: briefResult.attempts,
      briefFallback: briefResult.fallback,
      drafts,
      rounds: 0,
      grade: empty,
      repairs: [],
      phases,
      notes,
    };
  }

  const repaired = await repairScriptWithGates({
    request: opts.request,
    code: chosenCode,
    chat: opts.chat,
    prefer3D: opts.prefer3D,
    maxRounds: opts.maxRounds ?? 5,
    onStatus: opts.onStatus,
    onIteration: opts.onIteration,
  });
  phases.push(repaired.finalCode);
  opts.onPhase?.(3, repaired.finalCode);

  return {
    finalCode: repaired.finalCode,
    brief: briefResult.brief,
    briefAttempts: briefResult.attempts,
    briefFallback: briefResult.fallback,
    drafts,
    rounds: repaired.rounds,
    grade: repaired.grade,
    repairs: [...new Set([...draftRepairs, ...repaired.repairs])],
    phases,
    notes,
  };
}

export interface EditOptions {
  request: string;
  source: string;
  chat: PipelineChat;
  prefer3D?: boolean;
  maxRounds?: number;
  onPhase?: (phase: number, result: string) => void;
  onStatus?: (message: string) => void;
  onIteration?: (round: number, problems: string[], code: string) => void;
}

export interface EditResult extends RepairResult {
  generated: boolean;
}

/** Edit an existing script: generate the complete modified version, then run
 *  it through the same gated repair loop. Falls back to repairing the source
 *  when the model returns no code. */
export async function editScriptWithGates(opts: EditOptions): Promise<EditResult> {
  const prompt = `Here is the current OakScript model source code:

\`\`\`oakscript
${opts.source}
\`\`\`

Make the following changes to this model:
"${opts.request}"

${buildBindingBrief(opts.request)}

Rules:
- You are EDITING the script above, not generating a different indicator. Preserve ALL existing logic, calculations, variables, loops, and signals except where the request requires a real change; fixing what was asked takes priority over pure preservation.
- Output the COMPLETE modified script (every line, start to finish) inside \`\`\`oakscript fences. No prose.
- Never simplify, summarize, remove, or rename existing logic unless the request asks for it.
- Keep the same style and valid OakScript signatures.`;
  const generated = await requestCode(opts.chat, prompt);
  const base = generated || opts.source;
  opts.onPhase?.(2, base);

  const repaired = await repairScriptWithGates({
    request: opts.request,
    code: base,
    chat: opts.chat,
    prefer3D: opts.prefer3D,
    previousSource: opts.source,
    maxRounds: opts.maxRounds ?? 5,
    onStatus: opts.onStatus,
    onIteration: opts.onIteration,
  });
  opts.onPhase?.(3, repaired.finalCode);
  return { ...repaired, generated: !!generated };
}
