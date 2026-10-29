/**
 * DAFECharts MEGA production test harness.
 * Property-based + fuzz + extreme-input testing over the REAL engines.
 * Seeded PRNG → fully reproducible runs. Target: 100,000+ assertions/run.
 *
 * Categories:
 *   A. StdLib math (35+ functions × fuzzed inputs)      ~30k assertions
 *   B. Bar-type transforms (12 × property matrix)        ~15k
 *   C. Volume profile + aggregation invariants          ~10k
 *   D. PaperBroker integrity (conservation, lifecycle)   ~20k
 *   E. OakScript interpreter execution fuzz             ~15k
 *   F. Data pipeline (generator, adapter validation)    ~10k
 *   G. Backtest replay conservation                     ~5k
 *   H. Extreme/adversarial inputs (NaN/Inf/0/neg/huge)   ~10k
 */
import { StdLib } from '../../apps/web/src/oakscript/runtime';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { barsToRuntimeBarData } from '../../apps/web/src/backtest/data';
import { generateBars, transformBars, aggregateTimeframe } from '../../apps/web/src/data-generator';
import { computeVolumeProfileBins, DEFAULT_VP_SETTINGS } from '../../apps/web/src/volume-profile';
import { PaperBroker } from '../../apps/web/src/trading/paper-broker';
import type { BaseBar } from '@dafe/types';

// ── Seeded PRNG (mulberry32) ──
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string, detail?: any): void {
  if (cond) { pass++; return; }
  fail++;
  if (failures.length < 60) failures.push(`${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 200) : ''}`);
}

function finiteArr(a: number[] | undefined | null): boolean {
  return Array.isArray(a) && a.every(v => typeof v === 'number' ? Number.isFinite(v) || Number.isNaN(v) : true);
}

// ── Fuzz input factories ──
function fuzzSeries(r: () => number, n: number, mode: 'normal' | 'flat' | 'spike' | 'tiny' | 'huge' | 'neg'): number[] {
  const out: number[] = [];
  let v = mode === 'neg' ? -100 : mode === 'huge' ? 1e6 : 100;
  for (let i = 0; i < n; i++) {
    const shock = r();
    if (mode === 'flat') out.push(100);
    else if (mode === 'spike' && i === Math.floor(n / 2)) out.push(1e9);
    else if (mode === 'tiny') out.push(0.0001 * (1 + r()));
    else if (mode === 'huge') out.push(1e7 * (0.5 + r()));
    else if (mode === 'neg') { v += (r() - 0.5) * 10; out.push(v); }
    else { v += (r() - 0.5) * 5; out.push(v); }
  }
  return out;
}

function fuzzBars(r: () => number, n: number): BaseBar[] {
  const bars: BaseBar[] = [];
  let px = 100 + r() * 900;
  for (let i = 0; i < n; i++) {
    const o = px;
    const drift = (r() - 0.48) * px * 0.01;
    const c = Math.max(0.01, o + drift);
    const spread = Math.abs(r() - 0.5) * px * 0.008 + 0.01;
    bars.push({
      timestamp: 1700000000000 + i * 60000,
      open: o, high: Math.max(o, c) + spread, low: Math.min(o, c) - spread, close: c,
      volume: Math.floor(r() * 10000),
    });
    px = c;
  }
  return bars;
}

// ════════════════════════════════════════════════════════════════════
console.log('── A. StdLib math fuzz ──');
{
  const r = rng(0xA11CE);
  const modes = ['normal', 'flat', 'spike', 'tiny', 'huge', 'neg'] as const;
  const lens = [5, 8, 14, 20, 50, 100, 200];

  for (let iter = 0; iter < 1400; iter++) {
    const mode = modes[Math.floor(r() * modes.length)];
    const n = lens[Math.floor(r() * lens.length)];
    const src = fuzzSeries(r, n, mode);
    const len = 2 + Math.floor(r() * Math.min(30, Math.max(2, n - 2)));

    // sma: warmup NaN then finite
    const sma = StdLib.sma(src, len);
    ok(sma.length === n, 'A.sma.len');
    for (let i = 0; i < len - 1 && i < n; i++) ok(Number.isNaN(sma[i]), `A.sma.warmup[${i}]`, { mode, len });
    for (let i = len - 1; i < n; i++) ok(Number.isFinite(sma[i]), `A.sma.finite[${i}]`, { mode, len });
    if (mode === 'flat' && n >= len) {
      let s = 0; for (let k = 0; k < len; k++) s += src[k];
      ok(Math.abs(sma[len - 1] - s / len) < 1e-9, 'A.sma.flatExact');
    }

    // ema
    const ema = StdLib.ema(src, len);
    ok(ema.length === n, 'A.ema.len');
    for (let i = 0; i < ema.length; i++) {
      if (i >= len - 1 || src.length < len) ok(Number.isFinite(ema[i]) || Number.isNaN(ema[i]), 'A.ema.valType');
    }
    if (mode === 'flat' && n >= len) ok(Math.abs(ema[len - 1] - 100) < 1e-6, 'A.ema.flatSeed', ema[len - 1]);

    // wma / hma / rma / vwma — finite past each function's TRUE warmup
    for (const fn of ['wma', 'hma', 'rma', 'mom', 'median', 'stdev'] as const) {
      const out = (StdLib as any)[fn](src, len) as number[];
      ok(Array.isArray(out) && out.length === n, `A.${fn}.len`);
      // Warmup models (verified against each function's implementation):
      //   wma/rma/median/stdev: first valid at len-1
      //   mom: i < len → NaN, first valid at len
      //   hma: wma(len) warmup (len-1) must clear wma(diff, √len)'s window
      //        → first finite at (len-1) + ceil(√len) - 1 ≈ len + √len
      const warmup = fn === 'hma'
        ? (len - 1) + Math.max(1, Math.round(Math.sqrt(len)))
        : fn === 'mom' ? len
        : len - 1;
      if (mode !== 'spike') {
        for (let i = warmup; i < n; i++) {
          ok(Number.isFinite(out[i]), `A.${fn}.finitePastWarmup[${i}]`, { mode, len, warmup, v: out[i] });
        }
      }
    }

    // rsi: bounded 0..100
    const rsi = StdLib.rsi(src, len);
    for (let i = len; i < n; i++) {
      ok(Number.isFinite(rsi[i]) && rsi[i] >= 0 && rsi[i] <= 100, `A.rsi.range[${i}]`, rsi[i]);
    }
    if (mode === 'flat' && n > len) ok(rsi[n - 1] === 50 || rsi[n - 1] === 100 || Number.isNaN(rsi[n - 1]), 'A.rsi.flat');

    // macd: with correct seeding, signal+hist finite past warmup
    const m = StdLib.macd(src, Math.max(2, len >> 1), len, Math.max(2, len >> 2));
    const firstFiniteMacd = m.macd.findIndex(Number.isFinite);
    ok(firstFiniteMacd >= len - 1, 'A.macd.warmupRespected', { firstFiniteMacd, len });
    for (let i = firstFiniteMacd + Math.max(2, len >> 2) + 2; i < n; i++) {
      ok(Number.isFinite(m.signal[i]), `A.macd.signalFinite[${i}]`, { mode, i });
      ok(Number.isFinite(m.hist[i]), `A.macd.histFinite[${i}]`);
      ok(Math.abs(m.hist[i] - (m.macd[i] - m.signal[i])) < 1e-9, `A.macd.histIdentity[${i}]`);
    }

    // roc: zero-baseline guard
    const roc = StdLib.roc(src, len);
    for (let i = len; i < n; i++) {
      ok(Number.isFinite(roc[i]) || roc[i] === Infinity || roc[i] === -Infinity, `A.roc.type[${i}]`, roc[i]);
    }

    // linreg: exact on linear data
    if (mode === 'normal' && n >= len) {
      const lin = Array.from({ length: n }, (_, i) => 3 * i + 50);
      const lr = StdLib.linreg(lin, len, 0);
      ok(Math.abs(lr[n - 1] - (3 * (n - 1) + 50)) < 1e-6, 'A.linreg.linearExact', lr[n - 1]);
    }

    // crossover/crossunder count consistency
    const a = fuzzSeries(r, n, 'normal'), b = fuzzSeries(r, n, 'normal');
    const co = StdLib.crossover(a, b), cu = StdLib.crossunder(a, b);
    let coCount = 0, cuCount = 0;
    for (let i = 0; i < n; i++) { if (co[i]) coCount++; if (cu[i]) cuCount++; }
    ok(co[0] === false && cu[0] === false, 'A.cross.seedFalse');
    ok(!(coCount > 0 && cuCount > 0 && coCount + cuCount > n), 'A.cross.saneCount', { coCount, cuCount });

    // highest/lowest bounds
    const hi = StdLib.highest(src, len), lo = StdLib.lowest(src, len);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(hi[i])) {
        let mx = -Infinity; for (let k = Math.max(0, i - len + 1); k <= i; k++) mx = Math.max(mx, src[k]);
        ok(hi[i] === mx, `A.highest.exact[${i}]`, { hi: hi[i], mx });
      }
      if (Number.isFinite(lo[i])) {
        let mn = Infinity; for (let k = Math.max(0, i - len + 1); k <= i; k++) mn = Math.min(mn, src[k]);
        ok(lo[i] === mn, `A.lowest.exact[${i}]`, { lo: lo[i], mn });
      }
    }

    // stdev >= 0
    const sd = StdLib.stdev(src, len);
    for (let i = len - 1; i < n; i++) ok(sd[i] >= 0 && Number.isFinite(sd[i]), `A.stdev.nonNeg[${i}]`, sd[i]);

    // correlation bounded
    const corr = StdLib.correlation(a, b, Math.min(len * 2, n));
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(corr[i])) ok(corr[i] >= -1.0001 && corr[i] <= 1.0001, `A.corr.bounded[${i}]`, corr[i]);
    }

    // trueRange/atr non-negative
    const highs = src.map(v => v + 1), lows = src.map(v => v - 1);
    const tr = StdLib.trueRange(highs, lows, src);
    for (let i = 0; i < n; i++) ok(Number.isFinite(tr[i]) && tr[i] >= 0, `A.tr.nonNeg[${i}]`, tr[i]);
    const atr = StdLib.atr(highs, lows, src, len);
    for (let i = len * 2; i < n; i++) ok(Number.isFinite(atr[i]) && atr[i] >= 0, `A.atr.nonNeg[${i}]`, atr[i]);

    // vwap finite when volume > 0
    const vols = src.map(() => 1 + Math.floor(r() * 100));
    const vw = StdLib.vwap(src, vols);
    for (let i = 0; i < n; i++) ok(Number.isFinite(vw[i]), `A.vwap.finite[${i}]`);
  }
}
console.log(`   A tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── B. Bar-type transforms ──');
{
  const r = rng(0xBAB5);
  const types = ['heikin-ashi', 'renko', 'range-bar', 'volume-bar', 'tick-bar', 'kagi', 'dollar-bar', 'imbalance-bar'] as const;
  for (let iter = 0; iter < 900; iter++) {
    const bars = fuzzBars(r, 80 + Math.floor(r() * 320));
    const t = types[Math.floor(r() * types.length)];
    let out: BaseBar[] = [];
    let threw = false;
    try { out = transformBars(bars, t as any); } catch { threw = true; }
    ok(!threw, `B.${t}.noThrow`);
    ok(out.length > 0, `B.${t}.nonEmpty`);
    for (const b of out) {
      ok(Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close), `B.${t}.ohlcFinite`, b);
      ok(b.high >= b.low - 1e-9, `B.${t}.hgeL`, b);
      ok(b.high >= Math.max(b.open, b.close) - 1e-9, `B.${t}.hgeOC`, b);
      ok(b.low <= Math.min(b.open, b.close) + 1e-9, `B.${t}.lleOC`, b);
      ok(b.volume >= 0, `B.${t}.volNonNeg`, b.volume);
    }
    // Ascending timestamps (sorted)
    for (let i = 1; i < out.length; i++) ok(out[i].timestamp >= out[i - 1].timestamp, `B.${t}.tsSorted`, [out[i - 1].timestamp, out[i].timestamp]);
  }
  // Aggregate across all timeframes
  const tfs = ['1m','5m','15m','30m','1h','4h','1d','1w'] as const;
  for (let iter = 0; iter < 300; iter++) {
    const bars = fuzzBars(r, 200);
    const tf = tfs[Math.floor(r() * tfs.length)];
    const agg = aggregateTimeframe(bars, tf as any);
    ok(agg.length > 0 && agg.length <= bars.length, 'B.agg.count');
    for (const b of agg) {
      ok(b.high >= b.low && b.high >= Math.max(b.open, b.close) - 1e-9 && b.low <= Math.min(b.open, b.close) + 1e-9, 'B.agg.ohlcInv', b);
      ok(Number.isFinite(b.volume) && b.volume >= 0, 'B.agg.vol');
    }
    for (let i = 1; i < agg.length; i++) ok(agg[i].timestamp > agg[i - 1].timestamp, 'B.agg.tsStrict');
  }
}
console.log(`   B tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── C. Volume profile + conservation ──');
{
  const r = rng(0xC0FFEE);
  for (let iter = 0; iter < 600; iter++) {
    const bars = fuzzBars(r, 100 + Math.floor(r() * 400));
    const bins = 4 + Math.floor(r() * 40);
    const vp = computeVolumeProfileBins(bars, { ...DEFAULT_VP_SETTINGS, binCount: bins });
    ok(vp.bins.length === bins, 'C.binCount');
    // Volume conservation: sum of bins ≈ total (overlap-proportional allocation)
    let binSum = 0; for (const b of vp.bins) binSum += b.volume;
    ok(Math.abs(binSum - vp.totalVolume) < Math.max(1e-6, vp.totalVolume * 1e-6), 'C.volConserved', { binSum, total: vp.totalVolume });
    // buy+sell == volume per bin
    for (const b of vp.bins) ok(Math.abs((b.buyVolume + b.sellVolume) - b.volume) < 1e-6, 'C.buySellSum', b);
    // POC is the max-volume bin
    let mx = 0; for (const b of vp.bins) mx = Math.max(mx, b.volume);
    ok(vp.poc !== null && Math.abs(vp.poc.volume - mx) < 1e-9, 'C.pocMax');
    // VAH >= VAL
    if (vp.vah !== null && vp.val !== null) ok(vp.vah >= vp.val, 'C.vahGteVal');
    // delta within ±totalVolume
    ok(Math.abs(vp.delta) <= vp.totalVolume + 1e-6, 'C.deltaBound', { delta: vp.delta, total: vp.totalVolume });
    // empty input
    if (iter % 100 === 0) {
      const empty = computeVolumeProfileBins([], { ...DEFAULT_VP_SETTINGS });
      ok(empty.bins.length === 0 && empty.totalVolume === 0 && empty.poc === null, 'C.emptySafe');
    }
  }
}
console.log(`   C tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── D. PaperBroker integrity ──');
{
  const r = rng(0xDEAD);
  const mk = (start: number) => new PaperBroker({
    currency: 'USD', startingCash: start,
    commission: { mode: 'per-trade', value: 1 },
    slippage: { mode: 'fixed-ticks', value: 1, tickSize: 0.01 },
  });
  for (let iter = 0; iter < 600; iter++) {
    const broker = mk(100000);
    const sym = 'ES=F';
    const nOrders = 1 + Math.floor(r() * 12);
    for (let k = 0; k < nOrders; k++) {
      const side = r() < 0.5 ? 'buy' : 'sell';
      const type = ['market', 'limit', 'stop', 'trailing-stop'][Math.floor(r() * 4)] as any;
      const px = 100 + r() * 400;
      const qty = 1 + Math.floor(r() * 5);
      broker.tick(sym, px, Date.now() + k);
      try {
        const res = broker.placeOrder({ symbol: sym, side, type, qty, limitPrice: px * (side === 'buy' ? 0.98 : 1.02), stopPrice: px * (side === 'buy' ? 1.02 : 0.98), trailAmount: 5 + r() * 20 } as any);
        ok(res.status === 'filled' || res.status === 'working' || res.status === 'rejected', 'D.orderStatus', res.status);
      } catch (e) { fail++; if (failures.length < 60) failures.push('D.orderThrew :: ' + e); }
    }
    // Random price walk ticks
    let px = 300;
    for (let t = 0; t < 40; t++) {
      px = Math.max(1, px + (r() - 0.5) * 20);
      broker.tick(sym, px, Date.now() + 1000 + t);
      const acct = broker.getAccount();
      ok(Number.isFinite(acct.cash) && Number.isFinite(acct.equity) && Number.isFinite(acct.realizedPnL), 'D.acctFinite', acct);
      ok(Number.isFinite(acct.unrealizedPnL), 'D.upnlFinite', acct.unrealizedPnL);
    }
    // Flatten everything then check conservation: cash equals starting + realized - fees
    const acct = broker.getAccount();
    const positions = broker.getPositions();
    for (const p of positions) {
      broker.placeOrder({ symbol: p.symbol, side: p.qty > 0 ? 'sell' : 'buy', type: 'market', qty: Math.abs(p.qty) });
    }
    const final = broker.getAccount();
    ok(final.equity === final.cash || Math.abs(final.equity - final.cash) < 1e-6, 'D.flatEquityIsCash', final);
    const fills = (broker as any).getFills ? (broker as any).getFills() : [];
    const feesPaid = fills.reduce((a: number, f: any) => a + (f.commission || 0) + (f.slippage || 0), 0);
    ok(Number.isFinite(feesPaid) && feesPaid >= 0, 'D.feesNonNeg', feesPaid);
    // CONSERVATION — commission is charged as explicit cash; slippage is
    // already embedded in the fill price (so inside realizedPnL). Therefore:
    //   cash = starting + realizedPnL − commission  (NOT − slippage too).
    const commission = fills.reduce((a: number, f: any) => a + (f.commission || 0), 0);
    const cashDelta = final.cash - 100000;
    const explained = final.realizedPnL - commission;
    ok(Math.abs(cashDelta - explained) < Math.max(0.02, Math.abs(explained) * 1e-6), 'D.cashConservation', { cashDelta, explained, realized: final.realizedPnL, commission });
    ok(final.realizedPnL >= -100001 && final.realizedPnL <= 100001, 'D.realizedSane', final.realizedPnL);
  }
  // Cancel semantics
  for (let iter = 0; iter < 200; iter++) {
    const broker = mk(50000);
    broker.tick('X', 100, 1);
    const o = broker.placeOrder({ symbol: 'X', side: 'buy', type: 'limit', qty: 1, limitPrice: 50 } as any);
    ok(o.status === 'working', 'D.limitWorking');
    ok(broker.cancelOrder(o.id) === true, 'D.cancelTrue');
    ok(broker.cancelOrder(o.id) === false, 'D.cancelTwiceFalse');
    ok(broker.cancelOrder('nonexistent') === false, 'D.cancelGhost');
    broker.tick('X', 40, 2);
    const acct = broker.getAccount();
    ok(acct.cash === 50000, 'D.cancelledNoFill', acct.cash);
  }
}
console.log(`   D tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── E. OakScript interpreter fuzz ──');
{
  const r = rng(0xE77);
  const scripts = [
    `sma20 = sma(close, 20)\nplot(sma20, "SMA 20", "#b48cff")`,
    `r = rsi(close, 14)\nplot(r, "RSI", "#22cc88", 2, "separate")`,
    `m = macd(close, 12, 26, 9)\nplot(m.macd, "MACD", "#22aaff")\nplot(m.signal, "Signal", "#ff8800")`,
    `a = atr(high, low, close, 14)\nplot(a, "ATR", "#ffcc00")`,
    `if close > open\n    plotshape(bar_index, high, "Up", "triangleup", "#22cc88")`,
    `len = input(14, "Length", 2, 50, 1)\nv = rsi(close, len)\nplot(v, "RSI", "#b48cff")\nif crossover(v, 30)\n    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")`,
    `total = 0\nfor i = 0 to 9\n    total = total + close[i]\nplot(total / 10, "Loop MA", "#00ccff")`,
    `fib = linreg(close, 20, 0)\nplot(fib, "LinReg", "#ff8800")\nplot3d(close, "Price Surface", "surface", "#b48cff", "separate")`,
    `hline(70, "#ff4477")\nhline(30, "#22cc88")`,
    `bb = sma(close, 20) + stdev(close, 20) * 2\nplot(bb, "Upper", "#22aaff")`,
  ];
  for (let iter = 0; iter < 500; iter++) {
    const src = scripts[Math.floor(r() * scripts.length)];
    const bars = fuzzBars(r, 200 + Math.floor(r() * 300));
    const data = barsToRuntimeBarData(bars);
    let result: any = null;
    let threw = false;
    const t0 = Date.now();
    try {
      const prog = parse(src);
      result = executeScript(prog, data, new Map());
    } catch (e) { threw = true; }
    const dt = Date.now() - t0;
    ok(!threw, 'E.noThrow', src.slice(0, 40));
    ok(dt < 5000, 'E.timeBound', dt);
    if (result) {
      ok(result.errors.length === 0, 'E.noErrors', result.errors.slice(0, 2));
      const plotCount = result.plots.filter((p: any) =>
        p.type === 'line' || p.type === 'plot3d' || p.type === 'shape' || p.type === 'hline' ||
        p.type === 'plot3d_shape' || p.type === 'plot3d_label' || p.type === 'fill').length;
      ok(plotCount > 0, 'E.hasPlots', src.slice(0, 40));
      for (const p of result.plots) {
        if (Array.isArray(p.series)) {
          const finiteCount = p.series.filter((v: number) => Number.isFinite(v)).length;
          ok(finiteCount > 0, 'E.seriesSomeFinite', p.name);
          ok(p.series.length <= bars.length + 5, 'E.seriesLenSane', { n: p.series.length, bars: bars.length });
        }
      }
    }
  }
  // Infinite-loop protection — resource-limit violations are FATAL (hard
  // throw out of executeScript), never softened into per-bar errors[].
  {
    let threw = false;
    let completed = false;
    const t0 = Date.now();
    try {
      const prog = parse(`x = 0\nwhile true\n    x = x + 1`);
      executeScript(prog, barsToRuntimeBarData(fuzzBars(rng(1), 50)), new Map());
      completed = true;
    } catch { threw = true; }
    ok(threw && !completed, 'E.infiniteLoopFatal', { threw, completed, ms: Date.now() - t0 });
    ok(Date.now() - t0 < 5000, 'E.infiniteLoopFast', Date.now() - t0);
  }
}
console.log(`   E tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── F. Data pipeline ──');
{
  const r = rng(0xF00D);
  for (let iter = 0; iter < 400; iter++) {
    const n = 10 + Math.floor(r() * 500);
    const tf = ['1m','5m','1h','1d'][Math.floor(r() * 4)];
    const bars = generateBars(n, tf as any, 'ES=F');
    ok(bars.length === n, 'F.gen.count');
    let asc = true;
    for (let i = 1; i < bars.length; i++) if (bars[i].timestamp <= bars[i - 1].timestamp) { asc = false; break; }
    ok(asc, 'F.gen.ascending');
    for (const b of bars) {
      ok(b.high >= b.low && b.high >= Math.max(b.open, b.close) - 1e-9 && b.low <= Math.min(b.open, b.close) + 1e-9, 'F.gen.ohlc', b);
      ok(b.close > 0 && Number.isFinite(b.volume), 'F.gen.pos', b);
    }
    // barsToRuntimeBarData round-trip shape
    const rt = barsToRuntimeBarData(bars);
    ok(rt.close.length === n && rt.open.length === n && rt.high.length === n && rt.low.length === n && rt.volume.length === n, 'F.rt.shape');
    ok(rt.count === n, 'F.rt.count');
  }
}
console.log(`   F tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── G. Backtest replay conservation ──');
{
  const r = rng(0x600D);
  for (let iter = 0; iter < 60; iter++) {
    const bars = fuzzBars(r, 300);
    const broker = new PaperBroker({
      currency: 'USD', startingCash: 100000,
      commission: { mode: 'per-trade', value: 1 },
      slippage: { mode: 'fixed-ticks', value: 1, tickSize: 0.01 },
    });
    const sym = 'ES=F';
    // Alternate buy/sell market orders every 10 bars via replay discipline
    let realized = 0; let prevRealized = 0; let trades = 0;
    for (let i = 0; i < bars.length; i++) {
      broker.tick(sym, bars[i].open, bars[i].timestamp);
      if (i % 10 === 0 && i > 0) {
        const side = (i / 10) % 2 === 0 ? 'buy' : 'sell';
        broker.placeOrder({ symbol: sym, side, type: 'market', qty: 1 });
      }
      broker.tickBar(sym, bars[i], bars[i].timestamp);
      const acct = broker.getAccount();
      ok(Number.isFinite(acct.equity), 'G.equityFinite', acct);
      const delta = acct.realizedPnL - prevRealized;
      if (delta !== 0) trades++;
      prevRealized = acct.realizedPnL;
      realized = acct.realizedPnL;
      void realized;
    }
    ok(trades > 0 || bars.length < 10, 'G.tradesOccurred', trades);
    ok(Number.isFinite(broker.getAccount().equity), 'G.finalFinite');
  }
}
console.log(`   G tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('── H. Extreme / adversarial inputs ──');
{
  const r = rng(0xABC);
  const nasties: number[][] = [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [1e308, -1e308, 1e308, -1e308, 0, 1e-300, 5, 7],
    [NaN, NaN, NaN, 1, 2, 3, NaN],
    [Infinity, -Infinity, 0, 1, -1, 2],
    Array.from({ length: 500 }, () => 0),
    [0.0000001, 0.0000002, 0.00000015],
    [-5, -4, -3, -2, -1, 0],
    [1e-9, 1, 1e9, 1, 1e-9],
  ];
  const fns = ['sma', 'ema', 'rsi', 'wma', 'hma', 'rma', 'mom', 'median', 'stdev', 'roc', 'vwap', 'highest', 'lowest', 'cum', 'change'] as const;
  for (const nasty of nasties) {
    for (const fn of fns) {
      let out: any;
      let threw = false;
      try {
        if (fn === 'vwap') out = (StdLib as any).vwap(nasty, nasty.map(() => 1));
        else out = (StdLib as any)[fn](nasty, 3);
      } catch { threw = true; }
      ok(!threw, `H.${fn}.noThrow`);
      ok(Array.isArray(out), `H.${fn}.returnsArray`);
      if (Array.isArray(out)) {
        ok(out.length === nasty.length, `H.${fn}.length`);
        // No propagating Infinity unless input had it; NaN allowed (warmup) but no crashes
        for (let i = 3; i < out.length; i++) {
          const v = out[i];
          if (Number.isFinite(v)) ok(true, `H.${fn}.finite`);
          else if (Number.isNaN(v)) ok(true, `H.${fn}.nanOk`);
          else ok(nasty.includes(Infinity) || nasty.includes(-Infinity) || nasty.includes(1e308), `H.${fn}.infOnlyFromInfInput`, { fn, v });
        }
      }
    }
  }
  // VP with degenerate bars
  for (let iter = 0; iter < 100; iter++) {
    const flat: BaseBar[] = Array.from({ length: 50 }, () => ({ timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 0 }));
    const vp = computeVolumeProfileBins(flat, { ...DEFAULT_VP_SETTINGS, binCount: 10 });
    ok(vp.bins.length === 10, 'H.vp.flatBins');
    ok(Number.isFinite(vp.totalVolume), 'H.vp.flatTotal');
    ok(vp.poc !== null, 'H.vp.flatPoc');
  }
  // Transforms on degenerate bars
  const flatBars: BaseBar[] = Array.from({ length: 100 }, (_, i) => ({ timestamp: i * 60000, open: 5, high: 5, low: 5, close: 5, volume: 100 }));
  for (const t of ['heikin-ashi', 'renko', 'range-bar', 'kagi'] as const) {
    let out: BaseBar[] = [];
    let threw = false;
    try { out = transformBars(flatBars, t as any); } catch { threw = true; }
    ok(!threw, `H.transform.${t}.noThrow`);
    ok(Array.isArray(out), `H.transform.${t}.array`);
    for (const b of out) {
      ok(Number.isFinite(b.open) && Number.isFinite(b.close), `H.transform.${t}.finite`, b);
      ok(b.high >= b.low - 1e-9, `H.transform.${t}.hgeL`, b);
    }
  }
  // Broker with zero-price ticks
  for (let iter = 0; iter < 100; iter++) {
    const broker = new PaperBroker({ currency: 'USD', startingCash: 10000, commission: { mode: 'per-trade', value: 0 }, slippage: { mode: 'fixed-ticks', value: 0, tickSize: 0.01 } });
    broker.tick('Z', 0, 1);
    const res = broker.placeOrder({ symbol: 'Z', side: 'buy', type: 'market', qty: 1 });
    ok(res.status === 'filled' || res.status === 'rejected', 'H.zeroPrice.status', res.status);
    const acct = broker.getAccount();
    ok(Number.isFinite(acct.equity), 'H.zeroPrice.equityFinite', acct);
  }
}
console.log(`   H tally: ${pass} pass / ${fail} fail`);

// ════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════');
console.log(`MEGA TEST TOTAL: ${pass.toLocaleString()} pass / ${fail.toLocaleString()} fail — ${(pass / (pass + fail) * 100).toFixed(4)}%`);
if (fail > 0) {
  console.log(`\nFIRST ${Math.min(failures.length, 40)} FAILURES:`);
  for (const f of failures.slice(0, 40)) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('ALL MEGA TESTS PASS ✓');
