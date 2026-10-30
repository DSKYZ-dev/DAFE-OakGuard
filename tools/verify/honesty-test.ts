/**
 * OakGuard honesty suite: controls for the forming-bar semantics and the
 * open-bar stability check, then the replay and stability checks across the
 * shipped library. Usage: npx tsx tools/verify/honesty-test.ts
 */
import { getIndicators } from '../../apps/web/src/oakscript/indicators';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { backtestCertificate, openBarStability, replayCheck } from '../../apps/web/src/oakguard/honesty';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
};

const BARS: any = syntheticBars(400);
const LIVE: any = { ...BARS, live: true };
const HISTORY: any = { ...BARS, live: false };
const markers = (src: string, bars: any) =>
  (executeScript(parse(src), bars, new Map()).plots as any[]).filter(p => p.type === 'shape').length;

const BARSTATE = 'if barstate.isconfirmed {\n    plotshape(bar_index, low, "C", "triangleup", "#22cc88")\n}';
check('barstate: every history bar is confirmed', markers(BARSTATE, HISTORY) === BARS.count,
  `${markers(BARSTATE, HISTORY)} of ${BARS.count} bars`);
check('barstate: the forming bar of a live feed is not confirmed', markers(BARSTATE, LIVE) === BARS.count - 1,
  `${markers(BARSTATE, LIVE)} of ${BARS.count} bars (last bar excluded)`);

const FLICKER = 'if close > open {\n    plotshape(bar_index, low, "Up", "triangleup", "#22cc88")\n}';
const GATED = 'if barstate.isconfirmed and close > open {\n    plotshape(bar_index, low, "Up", "triangleup", "#22cc88")\n}';
const flicker = openBarStability(FLICKER, BARS);
check('control: a bar-close condition flickers on the forming bar', !flicker.passed, flicker.detail);
const gated = openBarStability(GATED, BARS);
check('control: the same condition gated by barstate.isconfirmed is stable', gated.passed, gated.detail);

const defs = getIndicators();
let replayPass = 0;
let stablePass = 0;
const flickering: string[] = [];
for (const d of defs) {
  if (replayCheck(d.source, BARS).passed) replayPass++;
  if (openBarStability(d.source, BARS).passed) stablePass++;
  else flickering.push(d.name);
}
check(`library: history replay holds for all ${defs.length} shipped scripts`, replayPass === defs.length,
  `${replayPass}/${defs.length} identical with later bars removed`);
console.log(`INFO  library: ${stablePass}/${defs.length} keep their forming-bar markers stable; ${flickering.length} flicker before close`);
if (flickering.length) console.log(`      e.g. ${flickering.slice(0, 5).join('; ')}`);

// The engine runs its script in a browser Worker, so these controls use
// hand-built results that exercise each rule of the certificate.
const RSI = defs.find(d => d.name === 'RSI')!.source;
const SPLIT = 280;
const stat = (label: 'in-sample' | 'out-of-sample', start: number, end: number, trades: number, pct: number): any => ({
  label, startBarIdx: start, endBarIdx: end, startEquity: 100000, endEquity: 100000 * (1 + pct / 100),
  netPnL: 1000 * pct, netPnLPct: pct, maxDrawdown: 0, maxDrawdownPct: 0, sharpePerBar: 0,
  winRate: 0.5, totalTrades: trades, avgWin: 0, avgLoss: 0,
});
const tradesAt = (count: number, priceOf: (i: number) => number): any[] => Array.from({ length: count }, (_, k) => {
  const entry = 10 + k * 8;
  const exit = entry + 3;
  return {
    barIdx: exit, pnl: 0, side: 'long', qty: 1, entryBarIdx: entry, entryTime: BARS.time[entry],
    entryPrice: priceOf(entry), exitBarIdx: exit, exitTime: BARS.time[exit], exitPrice: BARS.open[exit], exitReason: 'signal',
  };
});
const resultWith = (trades: any[], oosTrades = 22, splitBarIdx = SPLIT): any => ({
  config: {}, equityCurve: [], trades,
  inSample: stat('in-sample', 0, splitBarIdx, 18, 2.5),
  outOfSample: stat('out-of-sample', splitBarIdx + 1, 399, oosTrades, 1.1),
  scriptErrors: [], scriptAlertCount: 0, splitBarIdx, totalBars: 400, signalSourceUsed: 'strategy', orderCount: trades.length,
});
const certify = (r: any, extra: Partial<Parameters<typeof backtestCertificate>[0]> = {}) =>
  backtestCertificate({ source: RSI, bars: BARS, result: r, ...extra });
const rulesFailed = (c: ReturnType<typeof backtestCertificate>) => c.checks.filter(x => !x.passed).map(x => x.name.split(':')[0]);

const good = certify(resultWith(tradesAt(40, e => BARS.open[e])));
check('backtest: fills at the open, a reserved holdout, and no selection certify', good.honest,
  rulesFailed(good).join(', ') || 'all historical checks pass');
const withinTick = certify(resultWith(tradesAt(40, e => BARS.open[e] + 0.005)));
check('backtest: a fill within one tick of the open still certifies', withinTick.honest,
  rulesFailed(withinTick).join(', ') || 'within tolerance');
const atClose = certify(resultWith(tradesAt(40, e => BARS.close[e])));
check('control: fills at the signal bar close are rejected', rulesFailed(atClose).includes('fills'), rulesFailed(atClose).join(', ') || 'not rejected');
const fiveTicks = certify(resultWith(tradesAt(40, e => BARS.open[e] + 0.05)));
check('control: a fill five ticks from the open is rejected', rulesFailed(fiveTicks).includes('fills'), rulesFailed(fiveTicks).join(', ') || 'not rejected');
const fewOos = certify(resultWith(tradesAt(40, e => BARS.open[e]), 5));
check('control: five out-of-sample trades are rejected', rulesFailed(fewOos).includes('sample'), rulesFailed(fewOos).join(', ') || 'not rejected');
const noHoldout = certify(resultWith(tradesAt(40, e => BARS.open[e]), 0, 0));
check('control: no reserved holdout is rejected', rulesFailed(noHoldout).includes('holdout'), rulesFailed(noHoldout).join(', ') || 'not rejected');
const oosSelected = certify(resultWith(tradesAt(40, e => BARS.open[e])), { trials: 12, selectedOn: 'out-of-sample' });
check('control: parameters chosen on the out-of-sample period are rejected', rulesFailed(oosSelected).includes('selection'),
  rulesFailed(oosSelected).join(', ') || 'not rejected');
const bestOfTwelve = certify(resultWith(tradesAt(40, e => BARS.open[e])), { trials: 12, selectedOn: 'in-sample' });
check('backtest: best of 12 ranked on in-sample certifies, with the selection penalty shown', bestOfTwelve.honest,
  bestOfTwelve.checks.find(c => c.name.startsWith('selection'))?.detail ?? '');
const flickerCert = backtestCertificate({ source: FLICKER, bars: BARS, result: resultWith(tradesAt(40, e => BARS.open[e])) });
check('backtest: an honest history can still flicker live, reported separately', flickerCert.honest && !flickerCert.live.passed,
  flickerCert.live.detail);

console.log(`\nHONESTY TESTS: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
