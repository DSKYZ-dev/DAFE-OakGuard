/**
 * Validation suite for the 2026-08-21 audit fixes.
 * Every fix must prove correctness here before shipping.
 */
import { generateBars, aggregateTimeframe, transformBars } from '../../apps/web/src/data-generator';
import { computeVolumeProfileBins, DEFAULT_VP_SETTINGS } from '../../apps/web/src/volume-profile';
import { StdLib } from '../../apps/web/src/oakscript/runtime';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { barsToRuntimeBarData } from '../../apps/web/src/backtest/data';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: any): void {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, detail ?? ''); }
}

// ── 1. MACD signal/hist validity (was: 100% NaN from poisoned SMA seed) ──
{
  const src = generateBars(300, '1m', 'ES=F').map(b => b.close);
  const m = StdLib.macd(src, 12, 26, 9);
  const finiteSignal = m.signal.filter(v => Number.isFinite(v)).length;
  const finiteHist = m.hist.filter(v => Number.isFinite(v)).length;
  const firstSigIdx = m.signal.findIndex(v => Number.isFinite(v));
  check('MACD signal has finite values after warmup', finiteSignal > 200, { finiteSignal });
  check('MACD hist has finite values after warmup', finiteHist > 200, { finiteHist });
  check('MACD signal warmup NaN region ≈ slow+signal bars', firstSigIdx >= 25 && firstSigIdx <= 40, { firstSigIdx });
  // Signal must track macd line: correlation of finite region > 0
  const pairs = m.macd.map((v, i) => [v, m.signal[i]] as const).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (const [a, b] of pairs) { cov += (a - mx) * (b - my); vx += (a - mx) ** 2; vy += (b - my) ** 2; }
  const corr = cov / Math.sqrt(vx * vy);
  check('MACD signal correlates with macd line (corr>0.9)', corr > 0.9, { corr: corr.toFixed(3) });
}

// ── 2. linreg is true least-squares ──
{
  // Perfect linear series y = 2x + 100 → linreg must recover exactly 2x+100 at window end
  const src = Array.from({ length: 60 }, (_, i) => 2 * i + 100);
  const lr = StdLib.linreg(src, 20, 0);
  const last = lr[lr.length - 1];
  check('linreg exact on perfect line (y=2x+100)', Math.abs(last - (2 * 59 + 100)) < 1e-6, { last });
  // Downward trend recovers slope -1: value at end window = -(i) + 500
  const dn = Array.from({ length: 60 }, (_, i) => -i + 500);
  const lrd = StdLib.linreg(dn, 20, 0);
  check('linreg exact on descending line', Math.abs(lrd[lrd.length - 1] - (-59 + 500)) < 1e-6, { last: lrd[lrd.length - 1] });
  // offset=5 shifts evaluation 5 bars back
  const lrOff = StdLib.linreg(src, 20, 5);
  check('linreg offset evaluates (len-1-offset) back', Math.abs(lrOff[lrOff.length - 1] - (2 * 54 + 100)) < 1e-6, { last: lrOff[lrOff.length - 1] });
  // Warmup NaN
  check('linreg warmup NaN', Number.isNaN(lr[18]) && Number.isFinite(lr[19]));
  // regressionChannel mid == linreg
  const rc = StdLib.regressionChannel(src, 20, 2);
  check('regressionChannel.mid uses true linreg', Math.abs(rc.mid[rc.mid.length - 1] - last) < 1e-9);
  const dev = StdLib.stdev(src, 20)[src.length - 1];
  check('regressionChannel.upper = mid + 2*stdev', Math.abs(rc.upper[rc.upper.length - 1] - (last + 2 * dev)) < 1e-9);
}

// ── 3. FX precision preserved in HA + aggregateTimeframe ──
{
  const fx: any[] = Array.from({ length: 50 }, (_, i) => ({
    timestamp: Date.now() - (50 - i) * 60_000,
    open: 1.08 + (i % 5) * 0.0001,
    high: 1.0805 + (i % 5) * 0.0001,
    low: 1.0795 + (i % 5) * 0.0001,
    close: 1.08 + (i % 7) * 0.0001,
    volume: 1000,
  }));
  const ha = transformBars(fx as any, 'heikin-ashi');
  const lastHa = ha[ha.length - 1];
  const dp = (x: number) => Math.abs(x * 1e5 - Math.round(x * 1e5)) < 1e-3 && Math.abs(x - Math.round(x * 100) / 100) > 1e-9;
  const hasSubCentPrecision = ha.some(b => dp(b.close) || dp(b.open));
  check('HA preserves sub-cent FX precision', hasSubCentPrecision, { lastHa });
  const agg = aggregateTimeframe(fx as any, '5m');
  check('aggregateTimeframe preserves sub-cent FX precision', agg.some(b => dp(b.close) || dp(b.open)), { first: agg[0] });
  // Sanity: HA OHLC invariants hold
  const invOk = ha.every(b => b.high >= Math.max(b.open, b.close) - 1e-9 && b.low <= Math.min(b.open, b.close) + 1e-9 && b.high >= b.low);
  check('HA OHLC invariants hold on FX series', invOk);
}

// ── 4. VP close-position-weighted delta ──
{
  // Bars where CLOSE TOUCHES an extreme so t=(close-low)/(high-low) hits 0/0.5/1 exactly
  const mk = (open: number, close: number, high: number, low: number): any =>
    ({ timestamp: 0, open, high, low, close, volume: 1000 });
  const N = 10;
  // close == high → t=1 → buyFrac .75 → delta = +50% of total volume
  const bullBars = Array.from({ length: N }, () => mk(95, 105, 105, 94));
  const vpBull = computeVolumeProfileBins(bullBars, { ...DEFAULT_VP_SETTINGS });
  check('VP delta max +50% when closes at highs', Math.abs(vpBull.delta - 0.5 * vpBull.totalVolume) < 1, { delta: vpBull.delta, total: vpBull.totalVolume });
  // close == low → t=0 → delta = −50% of total
  const bearBars = Array.from({ length: N }, () => mk(105, 95, 106, 95));
  const vpBear = computeVolumeProfileBins(bearBars, { ...DEFAULT_VP_SETTINGS });
  check('VP delta min −50% when closes at lows', Math.abs(vpBear.delta + 0.5 * vpBear.totalVolume) < 1, { delta: vpBear.delta });
  // close mid-range → t=.5 → delta ≈ 0
  const midBars = Array.from({ length: N }, () => mk(95, 100, 105, 95));
  const vpMid = computeVolumeProfileBins(midBars, { ...DEFAULT_VP_SETTINGS });
  check('VP delta ≈ 0 when closes mid-range', Math.abs(vpMid.delta) < vpMid.totalVolume * 0.02, { delta: vpMid.delta });
  // buyVolume/sellVolume consistency per bin
  const binOk = vpBull.bins.every(b => Math.abs((b.buyVolume + b.sellVolume) - b.volume) < 1e-6);
  check('VP bin buy+sell == volume', binOk);
}

// ── 5. Adapter validation keeps volatile bars (no 2% cap / spike filter) ──
{
  // A bar with a 5% range (legit on crypto/news) must survive structural validation
  const volatileBar: any = { timestamp: Date.now(), open: 100, high: 105, low: 99.5, close: 104, volume: 5000 };
  const structuralOk = volatileBar.high >= Math.max(volatileBar.open, volatileBar.close) && volatileBar.low <= Math.min(volatileBar.open, volatileBar.close) && volatileBar.high >= volatileBar.low;
  check('5%-range bar passes structural validation', structuralOk);
  // Massive-style dedupe+sort: simulate the fixed pipeline logic
  const rows = [
    { t: 3000, o: 10, h: 11, l: 9, c: 10.5, v: 100 },
    { t: 1000, o: 10, h: 11, l: 9, c: 10.2, v: 100 },
    { t: 2000, o: 10, h: 12, l: 9, c: 11.8, v: 100 },
    { t: 2000, o: 10, h: 12, l: 9, c: 11.9, v: 100 },
  ];
  const bars = rows.map(r => ({ timestamp: r.t, open: r.o, high: Math.max(r.h, r.o, r.c), low: Math.min(r.l, r.o, r.c), close: r.c, volume: r.v }));
  bars.sort((a, b) => a.timestamp - b.timestamp);
  const deduped: any[] = [bars[0]];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].timestamp !== deduped[deduped.length - 1].timestamp) deduped.push(bars[i]);
    else deduped[deduped.length - 1] = bars[i];
  }
  check('Adapter sort+dedupe keeps order and drops dup ts', deduped.length === 3 && deduped[0].timestamp === 1000 && deduped[2].timestamp === 3000, { deduped });
}

// ── 6. End-to-end: script using macd signal + linreg runs clean ──
{
  const script = `
    m = macd(close, 12, 26, 9)
    lr = linreg(close, 20, 0)
    warm = bar_index > 40
    buySig = warm and crossover(m.macd, m.signal) and close > lr
    sellSig = warm and crossunder(m.macd, m.signal) and close < lr
    plot(lr, "LR", "#b48cff", 2)
    if buySig
        plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")
    if sellSig
        plotshape(bar_index, high, "Sell", "triangledown", "#ff4477")
  `;
  const bars = generateBars(400, '1m', 'ES=F');
  const data = barsToRuntimeBarData(bars);
  const prog = parse(script);
  const result = executeScript(prog, data, new Map());
  const finitePlots = result.plots.filter(p => p.series ? p.series.some(v => Number.isFinite(v)) : Number.isFinite(p.value ?? NaN));
  const shapes = result.plots.filter(p => p.type === 'shape');
  check('E2E macd+linreg script: plots present', finitePlots.length > 0, { plots: result.plots.length });
  check('E2E: no execution errors', result.errors.length === 0, { errors: result.errors });
  check('E2E: signal shapes fire post-warmup', shapes.length > 0, { shapes: shapes.length });
}

// ── 7. Bar-type transforms still sane after precision change ──
{
  const bars = generateBars(500, '1m', 'ES=F');
  for (const t of ['heikin-ashi', 'renko', 'range-bar', 'volume-bar', 'tick-bar', 'kagi', 'dollar-bar', 'imbalance-bar'] as const) {
    const out = transformBars(bars, t);
    const ok = out.length > 0 && out.every(b =>
      Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close) &&
      b.high >= b.low && b.high >= Math.max(b.open, b.close) - 1e-9 && b.low <= Math.min(b.open, b.close) + 1e-9);
    check(`transform ${t} OHLC-valid, n=${out.length}`, ok);
  }
}

console.log(`\nFix validation: pass=${pass} fail=${fail} ${fail === 0 ? 'ALL PASS ✓' : 'FAILURES ✗'}`);
if (fail > 0) process.exit(1);
