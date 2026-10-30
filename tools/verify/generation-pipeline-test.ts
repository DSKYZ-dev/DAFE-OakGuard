/**
 * Deterministic tests for the shared generation pipeline.
 * Run: npx tsx tools/verify/generation-pipeline-test.ts
 *
 * No network and no model: every chat call is injected, so these tests pin
 * the pipeline CONTRACT (brief gate, exemplar/binding injection, best-of-2,
 * mechanical stripping, deletion-list escalation, empty-reply retry) rather
 * than a provider's mood.
 */
import {
  editScriptWithGates,
  extractOakCode,
  generateIndicatorWithGates,
  gradeCode,
  removalLinesFor,
  repairScriptWithGates,
  type PipelineChat,
  type PipelineRole,
} from '../../apps/web/src/trade-advisor/generation-pipeline';
import { checkRequestCoverage } from '../../apps/web/src/trade-advisor/request-coverage';
import { findExemplars } from '../../apps/web/src/trade-advisor/exemplars';
import { validate } from '../../apps/web/src/oakscript/validator';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { FINAL_LIMIT_PROMPTS } from './editor-agent-test';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : ''}`);
  if (!cond) failures++;
}

const RSI_REQUEST = 'Create an RSI indicator with an adjustable length and oversold bounce signals.';
const RSI_GOOD = `len = input(14, "RSI Length", 2, 50, 1)
r = rsi(close, len)
plot(r, "RSI", "#b48cff", 2, "separate")
hline(70, "#ff4477", "separate")
hline(30, "#22cc88", "separate")
if crossover(r, 30) { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }`;

const SESSION_REQUEST = 'I want an indicator that displays the session highs and lows and signals when a divergence in the opposite direction is occurring. Do not use moving averages.';
const SESSION_GOOD = `len = input(78, "Session Lookback", 10, 500, 1)
sessHigh = highest(high, len)
sessLow = lowest(low, len)
rng = sessHigh - sessLow
dev = rng > 0 ? (close - sessLow) / rng : 0.5
plot(sessHigh, "Session High", "#ff4477", 1, "stepline")
plot(sessLow, "Session Low", "#22cc88", 1, "stepline")
newHigh = high >= sessHigh[1]
newLow = low <= sessLow[1]
if newLow and dev > dev[3] { plotshape(bar_index, low, "Buy Div", "triangleup", "#22cc88") }
if newHigh and dev < dev[3] { plotshape(bar_index, high, "Sell Div", "triangledown", "#ff4477") }
plot3d(dev, "Deviation", "surface", "#22aaff", "separate", 0)`;
const SESSION_BAD = `fastMa = sma(close, 9)
slowMa = sma(close, 21)
plot(fastMa, "F", "#22cc88", 2)
if crossover(fastMa, slowMa) { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }`;

const RSI_BRIEF = `1. Indicator Name: RSI Bounce
2. USES: RSI
3. EXCLUDES: NONE
4. Input Parameters: Length 14
5. Calculation Logic: rsi(close, length)
6. Signal Rules: crossover(rsi, 30)
7. Visual Plan: separate-pane RSI line + main-chart markers`;
const SESSION_BRIEF = `1. Indicator Name: Session Divergence
2. USES: NONE
3. EXCLUDES: SMA / moving average
4. Input Parameters: Lookback 78
5. Calculation Logic: highest(high, N), lowest(low, N), deviation in range
6. Signal Rules: new low while deviation rises / new high while deviation falls
7. Visual Plan: stepline session levels + divergence markers + deviation surface`;
const EMA_BRIEF = `1. Indicator Name: EMA Ribbon
2. USES: EMA
3. EXCLUDES: NONE
4. Input Parameters: 9, 21
5. Calculation Logic: ema(close, 9), ema(close, 21)
6. Signal Rules: full bull / full bear flip
7. Visual Plan: two lines + flip markers`;

function codeBlock(code: string): string {
  return `Here is the code:\n\`\`\`oakscript\n${code}\n\`\`\``;
}

async function main(): Promise<void> {
  // ── extraction ──
  check('extract: closed oakscript fence', extractOakCode('x\n```oakscript\nplot(close, "C", "#fff", 1)\n```\ny') === 'plot(close, "C", "#fff", 1)');
  check('extract: truncated fence salvaged', extractOakCode('```oakscript\nplot(close, "C", "#fff", 1)').includes('plot(close'));
  check('extract: bare code salvaged', extractOakCode('Here:\nplot(close, "C", "#fff", 1)').includes('plot(close'));
  check('extract: prose is not code', extractOakCode('Sure, I can help with that.') === '');

  // ── grade gate ──
  const cleanRsi = gradeCode(RSI_GOOD, RSI_REQUEST, { prefer3D: false });
  check('grade: clean RSI passes', cleanRsi.valid, cleanRsi.problems);
  const wrongFamily = gradeCode(SESSION_BAD, SESSION_REQUEST, { prefer3D: false });
  check('grade: EMA substitution flagged', !wrongFamily.valid && wrongFamily.problems.some(p => /explicitly rejected/.test(p)), wrongFamily.problems);

  // ── brief retry ──
  {
    const calls: Array<{ role: PipelineRole; prompt: string }> = [];
    let briefCall = 0;
    const chat: PipelineChat = async (prompt, role) => {
      calls.push({ role, prompt });
      if (role === 'brief') {
        briefCall++;
        return briefCall === 1
          ? 'USES: EMA, RSI\nEXCLUDES: NONE\nSignal: crossover(rsi, 30)'
          : RSI_BRIEF;
      }
      return codeBlock(RSI_GOOD);
    };
    const result = await generateIndicatorWithGates({ request: RSI_REQUEST, chat, prefer3D: false, bestOf: 1 });
    check('brief: poisoned brief regenerated', result.briefAttempts === 2 && !result.briefFallback, { attempts: result.briefAttempts, fallback: result.briefFallback });
    check('brief: retry prompt carries the failed check', calls.filter(c => c.role === 'brief')[1]?.prompt.includes('failed the binding-constraint check') === true);
    check('brief: clean RSI code accepted without fix rounds', result.rounds === 0 && result.finalCode.includes('rsi('), { rounds: result.rounds, drafts: result.drafts });
  }

  // ── brief fallback → binding constraints ──
  {
    const calls: Array<{ role: PipelineRole; prompt: string }> = [];
    const chat: PipelineChat = async (prompt, role) => {
      calls.push({ role, prompt });
      if (role === 'brief') return 'USES: EMA\nEXCLUDES: NONE'; // always wrong for an RSI request
      return codeBlock(RSI_GOOD);
    };
    const result = await generateIndicatorWithGates({ request: RSI_REQUEST, chat, prefer3D: false, bestOf: 1 });
    const codePrompt = calls.find(c => c.role === 'code')?.prompt || '';
    check('brief: three failed briefs fall back', result.briefFallback && result.briefAttempts === 3);
    check('brief: binding constraints still reach code prompt', codePrompt.includes('BINDING CONSTRAINTS') && /USES: RSI/.test(codePrompt));
  }

  // ── best-of-2 ──
  {
    const calls: Array<{ role: PipelineRole; prompt: string }> = [];
    const chat: PipelineChat = async (prompt, role) => {
      calls.push({ role, prompt });
      if (role === 'brief') return SESSION_BRIEF;
      if (prompt.includes('A previous attempt at this request failed')) return codeBlock(SESSION_GOOD);
      return codeBlock(SESSION_BAD);
    };
    const result = await generateIndicatorWithGates({ request: SESSION_REQUEST, chat, prefer3D: true, bestOf: 2 });
    check('best-of-2: second draft replaces wrong family', result.drafts === 2 && result.finalCode.includes('sessHigh') && !/\bsma\s*\(\s*close/.test(result.finalCode), { drafts: result.drafts });
    check('best-of-2: alternate prompt gets the first draft problems', (calls.find(c => c.role === 'code' && c.prompt.includes('A previous attempt'))?.prompt || '').includes('explicitly rejected'));
    check('best-of-2: winner is clean and needs no repair', result.rounds === 0 && result.grade.valid, result.grade.problems);
  }

  // ── early stop ──
  {
    let codeCalls = 0;
    const chat: PipelineChat = async (_prompt, role) => {
      if (role === 'brief') return RSI_BRIEF;
      codeCalls++;
      return codeBlock(RSI_GOOD);
    };
    const result = await generateIndicatorWithGates({ request: RSI_REQUEST, chat, prefer3D: false, bestOf: 2 });
    check('best-of-2: clean first draft early-stops', result.drafts === 1 && codeCalls === 1, { drafts: result.drafts, codeCalls });
  }

  // ── mechanical table strip ──
  {
    const withTable = `${RSI_GOOD}
tbl = table.new("top_right", 2, 1, "#111", "d")
table.cell(tbl, 0, 0, "RSI", "", "#fff")`;
    const chat: PipelineChat = async (_prompt, role) => role === 'brief' ? RSI_BRIEF : codeBlock(withTable);
    const result = await generateIndicatorWithGates({ request: RSI_REQUEST, chat, prefer3D: false, bestOf: 1, maxRounds: 1 });
    check('mechanical: unrequested table stripped before model fix', !/table\.(?:new|cell)/.test(result.finalCode) && result.rounds === 0, { rounds: result.rounds, repairs: result.repairs });
    check('mechanical: strip is reported', result.repairs.some(r => /table dashboard/.test(r)));
  }

  // ── mechanical 3D strip + duplicate dedupe ──
  {
    const with3d = `${RSI_GOOD}
plot3d(r, "RSI Surface", "surface", "#b48cff", "3d", 0)
plot3d(r, "RSI Restyle", "ribbon", "#b48cff", "3d", 1)`;
    const request2d = 'Create an RSI divergence indicator for the main chart only. Put RSI in the lower pane and do not use any 3D rendering.';
    const chat: PipelineChat = async (_prompt, role) => {
      if (role === 'brief') return `USES: RSI\nEXCLUDES: NONE\nMain-chart signals, lower-pane RSI.`;
      return codeBlock(with3d);
    };
    const result = await generateIndicatorWithGates({ request: request2d, chat, prefer3D: true, bestOf: 1, maxRounds: 1 });
    check('mechanical: forbidden 3D stripped for 2D-only request', !/plot3d\s*\(/.test(result.finalCode) && result.rounds === 0, { rounds: result.rounds, problems: result.grade.problems });
  }

  // ── mechanical 3D layer cap ──
  {
    const layers = `r = rsi(close, 14)
plot(r, "RSI", "#b48cff", 2, "separate")
plot3d(r, "L1", "ribbon", "#22aaff", "separate", 0)
plot3d(sma(r, 3), "L2", "surface", "#ffd43b", "separate", 1)
plot3d(r * 2, "L3", "bars3d", "#22cc88", "separate", 2)
plot3d(r * 3, "L4", "scatter", "#ff4477", "separate", 3)`;
    const chat: PipelineChat = async (_prompt, role) => role === 'brief' ? RSI_BRIEF : codeBlock(layers);
    const result = await generateIndicatorWithGates({
      request: 'Create an RSI indicator with 3D ribbons in the separate pane.',
      chat, prefer3D: true, bestOf: 1, maxRounds: 1,
    });
    const count = (result.finalCode.match(/plot3d\s*\(/g) || []).length;
    check('mechanical: extra 3D layers capped at three', count === 3 && result.repairs.some(r => /extra 3D layer/.test(r)), { count, repairs: result.repairs });
  }

  // ── deletion-list escalation ──
  {
    const withAtr = `e9 = ema(close, 9)
e21 = ema(close, 21)
plot(e9, "EMA9", "#22cc88", 1)
plot(e21, "EMA21", "#ff4477", 1)
bull = e9 > e21
if bull and not bull[1] { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }
a = atr(high, low, close, 14)
plot(a, "ATR", "#ffd43b", 1, "separate")`;
    const cleaned = withAtr.split('\n').filter(l => !/atr\s*\(/.test(l) && !/plot\(a,/.test(l)).join('\n');
    const calls: Array<{ role: PipelineRole; prompt: string }> = [];
    const chat: PipelineChat = async (prompt, role) => {
      calls.push({ role, prompt });
      if (role === 'brief') return EMA_BRIEF;
      if (prompt.includes('MANDATORY DELETIONS')) return codeBlock(cleaned);
      return codeBlock(withAtr);
    };
    const request = 'Create an EMA ribbon using 9 and 21-period EMAs. Signal only when the ribbon becomes fully bullish.';
    const result = await generateIndicatorWithGates({ request, chat, prefer3D: false, bestOf: 1, maxRounds: 2 });
    const fixPrompt = calls.find(c => c.role === 'code' && c.prompt.includes('MANDATORY DELETIONS'))?.prompt || '';
    check('escalation: fix prompt names the exact ATR line', fixPrompt.includes('a = atr(high, low, close, 14)'));
    check('escalation: cleaned code passes', result.rounds === 1 && result.grade.valid && !/\batr\s*\(/.test(result.finalCode), { rounds: result.rounds, problems: result.grade.problems });
  }

  // ── removal list extraction ──
  {
    const problems = checkRequestCoverage('Create an EMA ribbon.', 'a = atr(high, low, close, 14)\ne9 = ema(close, 9)', {});
    const lines = removalLinesFor('a = atr(high, low, close, 14)\ne9 = ema(close, 9)', problems);
    check('removal lines: unrequested ATR mapped to source line', lines.includes('a = atr(high, low, close, 14)'), { problems, lines });
  }

  // ── exemplar retrieval for every live limit prompt that generates code ──
  {
    for (let i = 0; i < 4; i++) {
      const exemplars = findExemplars(FINAL_LIMIT_PROMPTS[i], { max: 2 });
      check(`exemplars: limit prompt ${i + 1} resolves a reference`, exemplars.length >= 1, exemplars.map(e => e.name));
    }
    const vp = findExemplars(FINAL_LIMIT_PROMPTS[3], { max: 1 })[0];
    check('exemplars: volume-profile reference is a real POC engine',
      /pocBin|pocPrice/.test(vp?.source || '') && /plot3d\s*\([^)]*"manifold"/.test(vp?.source || ''), vp?.name);
  }

  // ── exemplar references must themselves validate + execute ──
  {
    const bars = syntheticBars(220);
    const barData = { ...bars };
    for (let i = 0; i < 4; i++) {
      const ex = findExemplars(FINAL_LIMIT_PROMPTS[i], { max: 1 })[0];
      if (!ex) { check(`exemplar ${i + 1}: resolves`, false); continue; }
      const v = validate(ex.source);
      check(`exemplar ${i + 1}: validates (${ex.name})`, v.valid, v.issues.filter(x => x.severity === 'error').map(x => x.code));
      try {
        const res = executeScript(parse(ex.source), barData as any, new Map());
        check(`exemplar ${i + 1}: executes clean`, res.errors.length === 0, res.errors.slice(0, 2));
      } catch (e: any) {
        check(`exemplar ${i + 1}: executes clean`, false, String(e?.message || e).slice(0, 160));
      }
    }
  }

  // ── empty reply retry ──
  {
    let codeCalls = 0;
    const chat: PipelineChat = async (_prompt, role) => {
      if (role === 'brief') return RSI_BRIEF;
      codeCalls++;
      return codeCalls === 1 ? '' : codeBlock(RSI_GOOD);
    };
    const result = await generateIndicatorWithGates({ request: RSI_REQUEST, chat, prefer3D: false, bestOf: 1 });
    check('empty reply: one code-only retry', codeCalls === 2 && result.finalCode.includes('rsi(') && result.rounds === 0, { codeCalls });
  }

  // ── empty-reply failover: compact design-summary recovery after 2 empty drafts ──
  {
    const codePrompts: string[] = [];
    const chat: PipelineChat = async (prompt, role) => {
      if (role === 'brief') return RSI_BRIEF;
      codePrompts.push(prompt);
      if (prompt.includes('DESIGN SUMMARY:')) return codeBlock(RSI_GOOD);
      return '';
    };
    const result = await generateIndicatorWithGates({ request: RSI_REQUEST, chat, prefer3D: false, bestOf: 1 });
    check('empty failover: compact design-summary prompt recovers after empty draft + retry',
      result.finalCode.includes('rsi(')
      && result.notes.some(n => n.includes('compact design-summary recovery prompt'))
      && codePrompts.some(p => p.includes('DESIGN SUMMARY:') && !p.includes('REFERENCE PATTERN')),
      { codeCalls: codePrompts.length, notes: result.notes });
  }

  // ── broken-script repair (final limit prompt 5) ──
  {
    const broken = `var lvl = highest(high, 20)
r = rsi(close, 14)
buySig = close[-1] > lvl
if buySig { plotshape(true, low, "Buy", shape.triangleup, color.green) }
plot3d(r, "RSI", "surface", "#b48cff", "3d")
if crossover(r, 30) { plotshape(bar_index, low, "OS", "triangleup", "#22cc88") }`;
    const fixed = `lookback = input(20, "Lookback", 5, 100, 1)
lvl = highest(high, lookback)
r = rsi(close, 14)
buySig = crossover(close, lvl)
if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") }
if crossover(r, 30) { plotshape(bar_index, low, "OS", "triangleup", "#22cc88") }
plot(lvl, "Level", "#22ff88", 1, "stepline")
plot(r, "RSI", "#b48cff", 2, "separate")
plot3d(r, "RSI Surface", "surface", "#b48cff", "separate", 0)`;
    const chat: PipelineChat = async () => codeBlock(fixed);
    const request = `${FINAL_LIMIT_PROMPTS[4]}\n\nBROKEN SCRIPT:\n\`\`\`oakscript\n${broken}\n\`\`\``;
    const result = await repairScriptWithGates({
      request, code: broken, chat, prefer3D: true, previousSource: broken, maxRounds: 2,
    });
    check('repair: broken script becomes valid + coverage-clean', result.valid, result.grade.problems);
    check('repair: future index, frozen var, Pine signature, price-scene oscillator gone',
      !/\[\s*-\d/.test(result.finalCode)
      && !/var\s+\w+\s*=\s*(highest|lowest|sma|ema|rsi)\s*\(/.test(result.finalCode)
      && !/plotshape\s*\(\s*(true|false)\b/.test(result.finalCode)
      && !/shape\./.test(result.finalCode)
      && !/plot3d\s*\([^)]*"3d"/.test(result.finalCode),
      result.finalCode.split('\n').slice(0, 4));
  }

  // ── edit entry point falls back to repairing the source ──
  {
    const chat: PipelineChat = async (prompt) => {
      if (prompt.includes('current OakScript model source')) return '';
      return codeBlock(RSI_GOOD);
    };
    const result = await editScriptWithGates({
      request: 'Fix the signal logic without changing the RSI calculation.',
      source: RSI_GOOD,
      chat,
      prefer3D: false,
      maxRounds: 1,
    });
    check('edit: empty draft falls back to source, remains valid', !result.generated && result.valid && result.finalCode.includes('rsi('), { generated: result.generated });
  }

  console.log(failures === 0 ? '\nALL GENERATION-PIPELINE TESTS PASS' : `\n${failures} GENERATION-PIPELINE CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
