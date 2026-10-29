/**
 * Final limit-test runner — runs the 5 limit prompts LIVE against the
 * currently-configured OakScript Coder model (Settings), through the
 * same backend chat route the app uses, then grades each result with
 * the validator + request-coverage + interpreter.
 *
 * Usage: npx tsx tools/verify/final-limit-run.ts [label]
 * Writes tools/verify/final-limit-results-<label>.json
 */
import { writeFileSync } from 'node:fs';
import { validate } from '../../apps/web/src/oakscript/validator';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { checkRequestCoverage } from '../../apps/web/src/trade-advisor/request-coverage';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { FINAL_LIMIT_PROMPTS } from './editor-agent-test';

const BASE = process.env.DAFE_BACKEND || 'http://127.0.0.1:8788';
const label = process.argv[2] || 'run';

const BROKEN_SCRIPT = [
  'var lvl = highest(high, 20)',
  'r = rsi(close, 14)',
  'buySig = close[-1] > lvl',
  'if buySig { plotshape(true, low, "Buy", shape.triangleup, color.green) }',
  'plot3d(r, "RSI", "surface", "#b48cff", "3d")',
  'if crossover(r, 30) { plotshape(bar_index, low, "OS", "triangleup", "#22cc88") }',
].join('\n');

async function chatAs(agent: string, message: string): Promise<string> {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, message }),
  });
  const d: any = await r.json();
  if (!d.ok) throw new Error(d.detail || d.error || 'chat failed');
  return d.reply || '';
}

async function chat(message: string): Promise<string> {
  return chatAs('oakscript_coder', message);
}

/** Mirror the app's phased generation: design (advisor) → code (coder). */
async function phasedGenerate(prompt: string): Promise<string> {
  const design = await chatAs('trade_advisor',
    `Design a technical indicator based on this description:\n\n"${prompt}"\n\nHARD CONSTRAINT: design ONLY from concepts named in the description. Do NOT introduce moving averages (EMA/SMA), MACD, RSI, ATR, Bollinger or any other indicator family unless the description explicitly asks for it.\n\nRespond with ONLY the algorithm design (no code yet):\n1. Indicator Name\n2. Input Parameters\n3. Calculation Logic (step-by-step, plain math, ONLY requested concepts)\n4. Signal Rules\n5. Visual Plan\n\nKeep it concise.`);
  const codeReply = await chat(
    `Based on this indicator design, generate the COMPLETE OakScript code:\n\nDESIGN:\n${design.slice(0, 2500)}\n\nRules:\n- Implement the DESIGN faithfully; no indicator family that is not in the design.\n- OakScript signatures are exact: atr(high, low, close, length); plot(value, "Title", "#hex", linewidth) positional only; plotshape(bar_index, low, "Buy", "triangleup", "#22cc88").\n- Output ONLY the code inside \`\`\`oakscript fences.`);
  return extractCode(codeReply);
}

function extractCode(text: string): string {
  const closed = text.match(/```(?:oakscript|js|javascript)?\s*\n([\s\S]*?)```/);
  if (closed && closed[1].trim().length > 10) return closed[1].trim();
  const open = text.match(/```(?:oakscript|js|javascript)?\s*\n([\s\S]*)$/);
  if (open && open[1].trim().length > 40) return open[1].trim();
  if (/\binput\s*\(|\bplot\w*\s*\(/.test(text)) return text.trim();
  return '';
}

const barsObj = syntheticBars(220);
const barsArr = barsObj.close.map((c, i) => ({ open: barsObj.open[i], high: barsObj.high[i], low: barsObj.low[i], close: c }));

interface Grade { id: number; pass: boolean; rounds: number; checks: Record<string, boolean>; problems: string[]; codeLen: number; code?: string; replyHead?: string }

async function runOne(id: number, prompt: string, asserts: (code: string) => Record<string, boolean>): Promise<Grade> {
  const fullPrompt = id === 5 ? `${prompt}\n\nBROKEN SCRIPT:\n\`\`\`oakscript\n${BROKEN_SCRIPT}\n\`\`\`` : prompt;
  let reply = '';
  let code = id === 5 ? extractCode(await chat(fullPrompt)) : await phasedGenerate(prompt);
  if (!code) {
    // Same salvage the app performs: demand code only, once.
    reply = await chat(`Output ONLY the complete OakScript code for this request inside \`\`\`oakscript fences. No prose.\n\nREQUEST: "${prompt}"`);
    code = extractCode(reply);
  }
  let rounds = 0;
  const problemsOf = (c: string) => [
    ...validate(c).issues.filter(i => i.severity === 'error').map(i => `[${i.code}] ${i.message}`),
    ...checkRequestCoverage(prompt, c, { prefer3D: id !== 3 }),
  ];
  let problems = code ? problemsOf(code) : ['NO_CODE'];
  while (problems.length && rounds < 3) {
    rounds++;
    reply = await chat(`ORIGINAL REQUEST: "${prompt}"\n\nThe following OakScript code has issues. Fix ALL of them AND satisfy the original request. Output ONLY the complete corrected code inside \`\`\`oakscript fences.\n\nCODE:\n\`\`\`oakscript\n${code}\n\`\`\`\n\nISSUES:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
    const next = extractCode(reply);
    if (!next) break;
    code = next;
    problems = problemsOf(code);
  }

  const checks: Record<string, boolean> = { hasCode: !!code, validAndCoverageClean: problems.length === 0 };
  // Asserts run on comment-stripped code — a model explaining the defect
  // it fixed ("// was: close[-1]") must not trip the defect detectors.
  const stripped = code.split('\n').map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; }).join('\n');
  Object.assign(checks, code ? asserts(stripped) : {});
  if (code) {
    try {
      const res = executeScript(parse(code), barsObj as any, new Map());
      checks.executesClean = res.errors.length === 0;
      const shapes = res.plots.filter(p => p.type === 'shape');
      checks.shapesSparse = shapes.length <= 60;
      checks.shapesAligned = shapes.every(s => {
        const b = typeof s.barIdx === 'number' ? barsArr[s.barIdx] : undefined;
        return !!b && typeof s.price === 'number' && s.price >= b.low - 1e-9 && s.price <= b.high + 1e-9;
      });
    } catch (e: any) {
      checks.executesClean = false;
      problems.push('EXEC: ' + String(e?.message || e).slice(0, 120));
    }
  }
  const pass = Object.values(checks).every(Boolean);
  return { id, pass, rounds, checks, problems: problems.slice(0, 6), codeLen: code.length, code, replyHead: code ? undefined : reply.slice(0, 600) };
}

const distinctSources = (code: string) => new Set([...code.matchAll(/plot3d\s*\(\s*([^,]+),/g)].map(m => m[1].trim())).size;
const plot3dCount = (code: string) => (code.match(/plot3d\s*\(/g) || []).length;

const ASSERTS: Array<(code: string) => Record<string, boolean>> = [
  (code) => ({
    twoIndependentReadings: distinctSources(code) >= 2,
    hasMainSignals: /(?<![\w.])plotshape\s*\(/.test(code),
    layersSane: plot3dCount(code) >= 1 && plot3dCount(code) <= 3,
    noTable: !/table\.new\s*\(/.test(code),
    releaseGated: /crossover|crossunder|barssince|var\s/.test(code),
  }),
  (code) => ({
    marginAndDisagreement: distinctSources(code) >= 2 || (code.match(/plot\s*\(/g) || []).length >= 2,
    agreementGate: /\band\b/.test(code),
    hasMainSignals: /(?<![\w.])plotshape\s*\(/.test(code),
    noTable: !/table\.new\s*\(/.test(code),
  }),
  (code) => ({
    modelExecution: /model\.(longEntry|entry|shortEntry)\s*\(/.test(code) && /model\.(longExit|exit|shortExit)\s*\(/.test(code),
    hardStop: /model\.stopLoss\s*\(/.test(code),
    confirmedHTF: /security\s*\(\s*"1h"/.test(code),
    noDecorative3D: plot3dCount(code) === 0,
    hasMainSignals: /(?<![\w.])plotshape\s*\(/.test(code),
  }),
  (code) => ({
    pocAndValue: /poc|median\s*\(|highest\s*\(|lowest\s*\(/i.test(code),
    terrain3D: /plot3d\s*\([^)]*"(ridgeline|surface|manifold)"/.test(code),
    twoDTwin: /(?<![\w.])plot\s*\(/.test(code),
    layersSane: plot3dCount(code) <= 3,
  }),
  (code) => ({
    noFutureIndex: !/\[\s*-\d/.test(code),
    noFrozenVar: !/var\s+\w+\s*=\s*(highest|lowest|sma|ema|rsi)\s*\(/.test(code),
    noPineSignature: !/plotshape\s*\(\s*(true|false)\b/.test(code) && !/shape\./.test(code),
    oscillatorNotInPriceScene: !/plot3d\s*\([^)]*"3d"/.test(code) || !/\b(rsi|cci|macd)\s*\(/.test(code),
  }),
];

const results: Grade[] = [];
for (let i = 0; i < FINAL_LIMIT_PROMPTS.length; i++) {
  process.stdout.write(`[${label}] prompt ${i + 1}/5 … `);
  try {
    const g = await runOne(i + 1, FINAL_LIMIT_PROMPTS[i], ASSERTS[i]);
    results.push(g);
    console.log(`${g.pass ? 'PASS' : 'FAIL'} (rounds=${g.rounds}) ${JSON.stringify(g.checks)}`);
    if (!g.pass) g.problems.forEach(p => console.log(`   - ${p.slice(0, 160)}`));
  } catch (e: any) {
    console.log('ERROR ' + String(e?.message || e).slice(0, 160));
    results.push({ id: i + 1, pass: false, rounds: 0, checks: { transport: false }, problems: [String(e?.message || e)], codeLen: 0 });
  }
}
const file = `tools/verify/final-limit-results-${label}.json`;
writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.filter(r => r.pass).length}/5 passed · results → ${file}`);
process.exit(results.every(r => r.pass) ? 0 : 1);
