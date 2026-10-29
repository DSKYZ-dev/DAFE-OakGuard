/**
 * Editor Agent test suite — 20 prompts.
 * Run: npx tsx tools/verify/editor-agent-test.ts
 *
 * For each prompt there are two fixtures:
 *  - badDraft: the failure mode models actually produce (EMA substitution,
 *    unrequested ATR, tautological signals, oscillator in the price scene,
 *    table duplication, locked input bounds, ...). The request-coverage
 *    gate MUST flag it.
 *  - goodDraft: what a correct response looks like. It MUST pass the
 *    validator + coverage with zero problems, execute without errors,
 *    and satisfy signal-density / bar-alignment / pane-law assertions.
 *
 * This tests the SYSTEM around the model (the gates the agent answers
 * to), deterministically, so model swaps can be compared against the
 * same bar: run the 20 prompts live, paste outputs as fixtures, re-run.
 * The final 5 limit prompts are at the bottom (FINAL_LIMIT_PROMPTS).
 */
import { validate } from '../../apps/web/src/oakscript/validator';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { checkRequestCoverage } from '../../apps/web/src/trade-advisor/request-coverage';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';

interface AgentTest {
  id: number;
  name: string;
  prompt: string;
  prefer3D: boolean;
  badDraft: string;
  badExpect: string; // substring the coverage report must contain
  goodDraft: string;
  expectSignals?: boolean;
  expect3D?: boolean;
}

const T: AgentTest[] = [
  {
    id: 1, name: 'Session H/L divergence, no MA', prefer3D: true,
    prompt: 'I want an indicator that displays the session highs and lows and signals when a divergence in the opposite direction is occurring. Do not use moving averages.',
    badDraft: 'fastMa = sma(close, 9)\nslowMa = sma(close, 21)\nplot(fastMa, "F", "#22cc88", 2)\nif crossover(fastMa, slowMa) { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }',
    badExpect: 'explicitly rejected',
    goodDraft: 'len = input(78, "Session Lookback", 10, 500, 1)\nsessHigh = highest(high, len)\nsessLow = lowest(low, len)\nrng = sessHigh - sessLow\ndev = rng > 0 ? (close - sessLow) / rng : 0.5\nplot(sessHigh, "Session High", "#ff4477", 1, "stepline")\nplot(sessLow, "Session Low", "#22cc88", 1, "stepline")\nnewHigh = high >= sessHigh[1]\nnewLow = low <= sessLow[1]\nif newLow and dev > dev[3] { plotshape(bar_index, low, "Buy Div", "triangleup", "#22cc88") }\nif newHigh and dev < dev[3] { plotshape(bar_index, high, "Sell Div", "triangledown", "#ff4477") }\nplot3d(dev, "Deviation", "surface", "#22aaff", "separate", 0)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 2, name: 'EMA ribbon (EMA requested)', prefer3D: true,
    prompt: 'Create an EMA ribbon using 9, 21, 50, and 100-period EMAs. Signal only when the ribbon becomes fully bullish or bearish.',
    badDraft: 'e1 = ema(close, 9)\natrVal = atr(high, low, close, 14)\nplot(e1, "E", "#fff", 1)\nplot3d(atrVal, "ATR", "bars3d", "#fff", "3d")',
    badExpect: 'ATR',
    goodDraft: 'e9 = ema(close, 9)\ne21 = ema(close, 21)\ne50 = ema(close, 50)\ne100 = ema(close, 100)\nplot(e9, "EMA9", "#22cc88", 1)\nplot(e21, "EMA21", "#ffa94d", 1)\nplot(e50, "EMA50", "#ffd43b", 1)\nplot(e100, "EMA100", "#ff6b6b", 1)\nbull = e9 > e21 and e21 > e50 and e50 > e100\nbear = e9 < e21 and e21 < e50 and e50 < e100\nif bull and not bull[1] { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }\nif bear and not bear[1] { plotshape(bar_index, high, "SELL", "triangledown", "#ff4477") }\nplot3d(e9, "Fast", "ribbon", "#22cc88", "3d", 0)\nplot3d(e100, "Slow", "ribbon", "#ff4477", "3d", 1)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 3, name: 'RSI divergence, 2D only', prefer3D: true,
    prompt: 'Create an RSI divergence indicator for the main chart only. Put RSI in the lower pane, signals on the main chart, and do not use any 3D rendering.',
    badDraft: 'r = rsi(close, 14)\nplot3d(r, "RSI", "surface", "#fff", "3d")\nif crossover(r, 30) { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: '2D / main-chart-only',
    goodDraft: 'r = rsi(close, 14)\nplot(r, "RSI", "#b48cff", 2, "separate")\nhline(70, "#ff4477", "separate")\nhline(30, "#22cc88", "separate")\nph = pivothigh(high, 5, 5)\npl = pivotlow(low, 5, 5)\nif pl > 0 and r > r[5] { plotshape(bar_index, low, "Bull Div", "triangleup", "#22cc88") }\nif ph > 0 and r < r[5] { plotshape(bar_index, high, "Bear Div", "triangledown", "#ff4477") }',
    expectSignals: false,
  },
  {
    id: 4, name: 'CCI extremes + dashboard', prefer3D: true,
    prompt: 'Create a CCI indicator that shows extremes and turns back toward neutral. I want a dashboard of CCI value, zone, momentum and last signal. Signals on the main chart; 3D impressive but sparse.',
    badDraft: 'c = cci(high, low, close, 20)\ntbl = table.new("top_right", 2, 4, "#111", "d")\ntable.cell(tbl, 0, 0, "CCI", "", "#fff")\nplot3d(c, "CCI", "manifold", "#fff", "3d", 0)\nif crossover(c, -100) { plotshape_3d(bar_index, c, "B", "coneup", "#22cc88", 1.0, 0, "3d") }',
    badExpect: 'table.new dashboard',
    goodDraft: 'c = cci(high, low, close, 20)\ncSlow = sma(c, 5)\nplot(c, "CCI", "#22aaff", 2, "separate")\nplot(cSlow, "Trend", "#ffd43b", 1, "separate")\nhline(100, "#ff4477", "separate")\nhline(-100, "#22cc88", "separate")\nvar lastCone = -1000\nbuySig = crossover(c, -100)\nsellSig = crossunder(c, 100)\nif buySig { plotshape(bar_index, low, "CCI Reclaim", "triangleup", "#22cc88") }\nif sellSig { plotshape(bar_index, high, "CCI Reject", "triangledown", "#ff4477") }\nif buySig and bar_index - lastCone >= 10 { plotshape_3d(bar_index, c, "Reclaim", "coneup", "#22cc88", 0.8, 0, "separate")\nlastCone := bar_index }\nplot3d(c, "CCI Manifold", "manifold", "#22aaff", "separate", 0)\nplot3d(cSlow, "CCI Trend", "ribbon", "#ffd43b", "separate", 1)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 5, name: 'Fibonacci levels 3D', prefer3D: true,
    prompt: 'Fibonacci retracement from the 80-bar swing. Levels as separate clean 3D lines; signal reclaim 61.8 / lose 38.2; label only the most important recent event.',
    badDraft: 'h = highest(high, 80)\nl = lowest(low, 80)\nf = l + (h - l) * 0.618\nplot3d(f, "Fib", "ribbon", "#fff", "3d", 0)\nplot3d(f, "Fib2", "surface", "#fff", "3d", 0)',
    badExpect: 'COVERAGE',
    goodDraft: 'lb = input(80, "Swing Lookback", 10, 300, 1)\nsh = highest(high, lb)\nsl = lowest(low, lb)\nrng = sh - sl\nf236 = sl + rng * 0.236\nf382 = sl + rng * 0.382\nf50 = sl + rng * 0.5\nf618 = sl + rng * 0.618\nif crossover(close, f618) { plotshape_3d(bar_index, low, "Reclaim 61.8", "coneup", "#22cc88", 1.0, 0, "3d")\nplotshape(bar_index, low, "Reclaim", "triangleup", "#22cc88") }\nif crossunder(close, f382) { plotshape_3d(bar_index, high, "Lost 38.2", "conedown", "#ff4477", 1.0, 2, "3d")\nplotshape(bar_index, high, "Lost", "triangledown", "#ff4477") }\nplot3d(f236, "Fib 23.6", "line3d", "#00ccff", "3d", 0)\nplot3d(f382, "Fib 38.2", "line3d", "#ffcc00", "3d", 1)\nplot3d(f50, "Fib 50", "line3d", "#b48cff", "3d", 2)\nplot3d(f618, "Fib 61.8", "line3d", "#ff8800", "3d", 3)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 6, name: 'ATR trailing stop', prefer3D: false,
    prompt: 'Create an ATR trailing stop that ratchets, flips long/short on cross, and marks flips.',
    badDraft: 'a = atr(14)\nupper = close + a * 2\nplot(upper, "U", "#fff", 1)\nif close > upper { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'expects at least',
    goodDraft: 'atrLen = input(14, "ATR Length", 2, 60, 1)\nmult = input(2.0, "Mult", 0.5, 5.0, 0.5)\na = atr(high, low, close, atrLen)\nvar inLong = false\nvar longStop = 0.0\nvar shortStop = 0.0\nbuySig = false\nsellSig = false\nif bar_index > atrLen {\nif inLong { longStop := max(longStop, close - a * mult)\nif close < longStop { inLong := false\nsellSig := true\nshortStop := close + a * mult } } else { shortStop := shortStop == 0.0 ? close + a * mult : min(shortStop, close + a * mult)\nif close > shortStop { inLong := true\nbuySig := true\nlongStop := close - a * mult } } }\nplot(longStop, "Long Stop", "#22cc88", 1, "stepline")\nplot(shortStop, "Short Stop", "#ff4477", 1, "stepline")\nif buySig { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }\nif sellSig { plotshape(bar_index, high, "SELL", "triangledown", "#ff4477") }',
    expectSignals: false,
  },
  {
    id: 7, name: 'MTF confirmed trend', prefer3D: false,
    prompt: 'On this 1m chart only buy when the confirmed 1h EMA trend is rising. No still-forming higher-timeframe bar.',
    badDraft: 'htf = request.security("1h", close)\nif close > htf { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'PineScript',
    goodDraft: 'trend = security("1h", ema(close, 21))\npullback = close < ema(close, 9) and close > ema(close, 21)\nturnUp = crossover(close, ema(close, 9))\nplot(ema(close, 9), "Fast", "#22cc88", 1)\nplot(ema(close, 21), "Slow", "#ff4477", 1)\nif pullback and turnUp and close < trend * 1.05 { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }',
    expectSignals: false,
  },
  {
    id: 8, name: 'Volume climax sparse', prefer3D: true,
    prompt: 'Relative-volume climaxes above 2.5, cooldown 12 bars, impressive 3D volume, main-chart markers.',
    badDraft: 'if volume > sma(volume, 20) { plotshape(bar_index, low, "V", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'relVol = volume / max(sma(volume, 20), 1)\nvar lastBar = -1000\nclimax = relVol > 2.5 and bar_index - lastBar >= 12\nif climax { lastBar := bar_index\nplotshape(bar_index, low, "Climax", "triangleup", "#ffd43b")\nplotshape_3d(bar_index, volume, "Climax", "coneup", "#22cc88", 0.8, 0, "separate") }\nplot(relVol, "RelVol", "#22aaff", 1, "separate")\nplot3d(volume, "Volume", "bars3d", "#ffd43b", "separate", 0)\nplot3d(relVol * 100, "Rel Ridge", "ridgeline", "#22ccff", "separate", 1)',
    expectSignals: false, expect3D: true,
  },
  {
    id: 9, name: 'Bollinger mean reversion + model execution', prefer3D: false,
    prompt: 'Automated mean-reversion model: buy band reclaim, exit at basis, confidence, stop loss, backtester-ready.',
    badDraft: 'b = sma(close, 20)\nif close < b { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'basis = sma(close, 20)\ndev = stdev(close, 20)\nlower = basis - dev * 2\nplot(basis, "Basis", "#b48cff", 2)\nplot(lower, "Lower", "#ff4477", 1)\nfill(basis, lower, "rgba(180,140,255,0.07)")\nvar inPos = false\nreclaim = crossover(close, lower)\nif reclaim and not inPos { inPos := true\nmodel.confidence(0.7)\nmodel.stopLoss(2.5)\nmodel.longEntry("mr")\nplotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }\nif inPos and close >= basis { inPos := false\nmodel.longExit("mr")\nplotshape(bar_index, high, "EXIT", "triangledown", "#ffd166") }',
    expectSignals: true,
  },
  {
    id: 10, name: 'MACD dashboard-free oscillator', prefer3D: true,
    prompt: 'MACD with histogram, cross signals on the main chart, 3D ribbons in the lower pane.',
    badDraft: 'm = macd(close, 12, 26, 9)\nplot3d(m.macd, "M", "ribbon", "#fff", "3d", 0)\nif crossover(m.macd, m.signal) { plotshape_3d(bar_index, m.macd, "B", "coneup", "#22cc88", 1.0, 0, "3d") }',
    badExpect: 'oscillator series rendered with pane "3d"',
    goodDraft: 'm = macd(close, 12, 26, 9)\nplot(m.macd, "MACD", "#22aaff", 2, "separate")\nplot(m.signal, "Signal", "#ff8800", 2, "separate")\nhline(0, "#888888", "separate")\nif crossover(m.macd, m.signal) { plotshape(bar_index, low, "MACD BUY", "triangleup", "#22cc88")\nplotshape_3d(bar_index, m.macd, "Up", "coneup", "#22cc88", 0.8, 0, "separate") }\nif crossunder(m.macd, m.signal) { plotshape(bar_index, high, "MACD SELL", "triangledown", "#ff4477")\nplotshape_3d(bar_index, m.macd, "Dn", "conedown", "#ff4477", 0.8, 0, "separate") }\nplot3d(m.macd, "MACD", "ribbon", "#22aaff", "separate", 0)\nplot3d(m.hist, "Hist", "bars3d", "#8866ff", "separate", 1)',
    expectSignals: true, expect3D: true,
  },
];

T.push(
  {
    id: 11, name: 'VWAP bands cross', prefer3D: false,
    prompt: 'VWAP with deviation bands and cross signals on the main chart.',
    badDraft: 'v = vwap(close, volume)\nif close > v { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'v = vwap(close, volume)\nd = stdev(close, 20)\nup = v + d * 1.5\nlo = v - d * 1.5\nplot(v, "VWAP", "#ffd166", 2)\nplot(up, "Upper", "#22cc88", 1)\nplot(lo, "Lower", "#ff4477", 1)\nfill(up, lo, "rgba(255,209,102,0.07)")\nif crossover(close, v) { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }\nif crossunder(close, v) { plotshape(bar_index, high, "SELL", "triangledown", "#ff4477") }',
    expectSignals: true,
  },
  {
    id: 12, name: 'Stochastic zone-gated', prefer3D: false,
    prompt: 'Stochastic oscillator that only signals on crosses inside the oversold/overbought zones.',
    badDraft: 'k = stoch(high, low, close, 14)\nif k > sma(k, 3) { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'level-triggered',
    goodDraft: 'k = stoch(high, low, close, 14)\nd = sma(k, 3)\nplot(k, "%K", "#22aaff", 2, "separate")\nplot(d, "%D", "#ff8800", 2, "separate")\nhline(80, "#ff4477", "separate")\nhline(20, "#22cc88", "separate")\nif crossover(k, d) and k < 30 { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }\nif crossunder(k, d) and k > 70 { plotshape(bar_index, high, "SELL", "triangledown", "#ff4477") }',
    expectSignals: false,
  },
  {
    id: 13, name: 'Donchian breakout', prefer3D: true,
    prompt: 'Donchian channel breakout: 20-bar high/low channel, breakout signals, channel visible in 3D as price-level lines.',
    badDraft: 'h = highest(high, 20)\nif close > h { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'h = highest(high, 20)\nl = lowest(low, 20)\nmid = (h + l) / 2\nplot(h, "Upper", "#22cc88", 1, "stepline")\nplot(l, "Lower", "#ff4477", 1, "stepline")\nplot(mid, "Mid", "#b48cff", 1)\nfill(h, l, "rgba(76,201,240,0.05)")\nif crossover(close, h[1]) { plotshape(bar_index, low, "Break Up", "triangleup", "#22cc88") }\nif crossunder(close, l[1]) { plotshape(bar_index, high, "Break Dn", "triangledown", "#ff4477") }\nplot3d(h, "Upper Rail", "line3d", "#22cc88", "3d", 0)\nplot3d(l, "Lower Rail", "line3d", "#ff4477", "3d", 1)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 14, name: 'Locked input bounds trap', prefer3D: false,
    prompt: 'RSI indicator with an adjustable length.',
    badDraft: 'len = input(14, "RSI Length", 14, 14, 1)\nr = rsi(close, len)\nplot(r, "RSI", "#fff", 1, "separate")',
    badExpect: 'slider is locked',
    goodDraft: 'len = input(14, "RSI Length", 2, 50, 1)\nr = rsi(close, len)\nplot(r, "RSI", "#b48cff", 2, "separate")\nhline(70, "#ff4477", "separate")\nhline(30, "#22cc88", "separate")\nif crossover(r, 30) { plotshape(bar_index, low, "BUY", "triangleup", "#22cc88") }',
    expectSignals: true,
  },
  {
    id: 15, name: 'Supply zone drawing', prefer3D: false,
    prompt: 'Mark the most recent supply zone from the last swing high with a box and signal a rejection at its edge.',
    badDraft: 'h = highest(high, 40)\nplot(h, "H", "#fff", 1)\nif close >= h { plotshape(bar_index, high, "S", "triangledown", "#ff4477") }',
    badExpect: 'COVERAGE',
    goodDraft: 'ph = pivothigh(high, 5, 5)\nvar zoneTop = 0.0\nvar zoneBot = 0.0\nif ph > 0 { zoneTop := ph\nzoneBot := ph * 0.995 }\nbox.new(bar_index - 30, zoneTop, bar_index, zoneBot, "#ff4477", "rgba(255,68,119,0.10)", 1, "supply")\nif high >= zoneBot and close < zoneBot and zoneTop > 0 { plotshape(bar_index, high, "Reject", "triangledown", "#ff4477") }',
    expectSignals: false,
  },
  {
    id: 16, name: 'Regression channel', prefer3D: false,
    prompt: 'Linear regression channel with bands; signal touches of the lower band in an uptrend.',
    badDraft: 'm = sma(close, 50)\nplot(m, "M", "#fff", 1)\nif close < m { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'ch = regression.channel(close, 50, 2.0)\nplot(ch.mid, "Mid", "#b48cff", 1)\nplot(ch.upper, "Upper", "#22cc88", 1)\nplot(ch.lower, "Lower", "#ff4477", 1)\nfill(ch.upper, ch.lower, "rgba(180,140,255,0.06)")\nif crossover(close, ch.lower) { plotshape(bar_index, low, "Touch", "triangleup", "#22cc88") }',
    expectSignals: false,
  },
  {
    id: 17, name: 'Engulfing pattern sparse', prefer3D: false,
    prompt: 'Bullish and bearish engulfing candle signals, at most a handful, no other indicators.',
    badDraft: 'if close > open { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'bullEng = close > open and close[1] < open[1] and close > open[1] and open < close[1]\nbearEng = close < open and close[1] > open[1] and close < open[1] and open > close[1]\nif bullEng { plotshape(bar_index, low, "Bull Eng", "triangleup", "#22cc88") }\nif bearEng { plotshape(bar_index, high, "Bear Eng", "triangledown", "#ff4477") }',
    expectSignals: false,
  },
  {
    id: 18, name: 'ADX trend birth', prefer3D: true,
    prompt: 'ADX trend-strength indicator: signal when ADX crosses 25, 3D vortex for strength, trend line in 2D pane.',
    badDraft: 'a = adx(high, low, close, 14)\nplot3d(a, "ADX", "vortex", "#fff", "3d", 0)',
    badExpect: 'oscillator series rendered with pane "3d"',
    goodDraft: 'a = adx(high, low, close, 14)\nas = sma(a, 5)\nplot(a, "ADX", "#ff4477", 2, "separate")\nplot(as, "ADX Smooth", "#22ccff", 1, "separate")\nhline(25, "#888888", "separate")\nif crossover(a, 25) { plotshape(bar_index, low, "Trend Birth", "triangleup", "#22cc88")\nplotshape_3d(bar_index, a, "Birth", "coneup", "#22cc88", 0.8, 0, "separate") }\nplot3d(a, "Trend Vortex", "vortex", "#ff4477", "separate", 0)\nplot3d(as, "Strength", "ribbon", "#22ccff", "separate", 1)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 19, name: 'OBV flow trend', prefer3D: true,
    prompt: 'OBV flow indicator with trend line; signal flow crosses; 3D stream in lower pane.',
    badDraft: 'o = obv(close, volume)\nif o > sma(o, 21) { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'o = obv(close, volume)\nt = ema(o, 21)\nplot(o, "OBV", "#22cc88", 1, "separate")\nplot(t, "Trend", "#ff8800", 1, "separate")\nif crossover(o, t) { plotshape(bar_index, low, "Flow Up", "triangleup", "#22cc88")\nplotshape_3d(bar_index, o, "Up", "coneup", "#22cc88", 0.8, 0, "separate") }\nif crossunder(o, t) { plotshape(bar_index, high, "Flow Dn", "triangledown", "#ff4477") }\nplot3d(o, "OBV Trail", "trail", "#22cc88", "separate", 0)\nplot3d(t, "OBV Manifold", "manifold", "#ff8800", "separate", 1)',
    expectSignals: true, expect3D: true,
  },
  {
    id: 20, name: 'No-signals measurement study', prefer3D: false,
    prompt: 'Just measure and plot the ATR-normalized spread between fast and slow EMA. No trading signals at all.',
    badDraft: 's = ema(close, 9) - ema(close, 21)\nplot(s, "S", "#fff", 1, "separate")\nif s > 0 { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }',
    badExpect: 'COVERAGE',
    goodDraft: 'a = atr(high, low, close, 14)\nspread = (ema(close, 9) - ema(close, 21)) / max(a, 0.0001)\nplot(spread, "Norm Spread", "#22aaff", 2, "separate")\nhline(0, "#888888", "separate")\nhline(1, "rgba(255,255,255,0.25)", "separate")\nhline(-1, "rgba(255,255,255,0.25)", "separate")',
    expectSignals: false,
  },
);

const IS_MAIN = (process.argv[1] || '').includes('editor-agent-test');
let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 180) : ''}`);
  if (!cond) failures++;
}

const bars = syntheticBars(220);
const barData = { ...bars };
const barsArr = bars.close.map((c, i) => ({ open: bars.open[i], high: bars.high[i], low: bars.low[i], close: c }));

if (IS_MAIN) for (const t of T) {
  const badProblems = [
    ...checkRequestCoverage(t.prompt, t.badDraft, { prefer3D: t.prefer3D }),
    ...validate(t.badDraft).issues.map(i => `[${i.code}] ${i.message}`),
  ];
  check(`#${t.id} ${t.name}: bad draft flagged (${t.badExpect})`,
    badProblems.some(p => p.toLowerCase().includes(t.badExpect.toLowerCase().replace('coverage: ', '')) || p.includes(t.badExpect)),
    badProblems.map(p => p.slice(0, 90)));

  const goodProblems = checkRequestCoverage(t.prompt, t.goodDraft, { prefer3D: t.prefer3D });
  check(`#${t.id} ${t.name}: good draft coverage clean`, goodProblems.length === 0, goodProblems);

  const v = validate(t.goodDraft);
  check(`#${t.id} ${t.name}: good draft validates`, v.valid, v.issues.map(i => i.code));

  let execOk = false, shapeCount = 0, aligned = 0, shapesChecked = 0, layers = 0;
  try {
    const res = executeScript(parse(t.goodDraft), barData as any, new Map());
    execOk = res.errors.length === 0;
    const shapes = res.plots.filter(p => p.type === 'shape');
    shapeCount = shapes.length;
    layers = res.plots.filter(p => p.type === 'plot3d').length;
    for (const s of shapes) {
      if (typeof s.barIdx !== 'number') continue;
      shapesChecked++;
      const b = barsArr[s.barIdx];
      if (b && typeof s.price === 'number' && s.price >= b.low - 1e-9 && s.price <= b.high + 1e-9) aligned++;
    }
    check(`#${t.id} ${t.name}: executes clean`, execOk, res.errors.slice(0, 2));
    if (t.expectSignals) check(`#${t.id} ${t.name}: signals sparse (1..90)`, shapeCount >= 1 && shapeCount <= 90, shapeCount);
    check(`#${t.id} ${t.name}: shapes bar-aligned`, shapesChecked === 0 || aligned === shapesChecked, { aligned, shapesChecked });
    if (t.expect3D) check(`#${t.id} ${t.name}: 3D layers <= 4`, layers >= 1 && layers <= 4, layers);
  } catch (e: any) {
    check(`#${t.id} ${t.name}: executes clean`, false, String(e?.message || e).slice(0, 120));
  }
}

if (IS_MAIN) {
  console.log(failures === 0 ? `\nALL ${T.length} EDITOR-AGENT TESTS PASS` : `\n${failures} EDITOR-AGENT CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Final limit prompts — run live against each candidate model after the
 *  20 above pass. A pass = validated + coverage-clean in <= 2 fix rounds,
 *  sparse aligned main-chart signals, correct pane law, no unrequested
 *  families, and a 3D scene a trader can read (layers answer one question
 *  each, legend values match the dashboard). */
export const FINAL_LIMIT_PROMPTS = [
  'Design a volatility-compression release model: ATR and range coiling while vol-of-vol rises. Show how loaded the coil is and whether the tape has been predictable as two separate readings, fire on release, dashboard-free, with a 3D version that makes loaded-but-unpredictable visibly different from loaded-and-predictable.',
  'Build a KNN-style nearest-neighbour vote on next-bar direction (k=7, last 20 bars of features). Show the vote margin and neighbour disagreement as two independently readable channels, only signal when both agree, and give it a 3D form whose shape tells me if the decision is crisp or contested before I read any number.',
  'Create a multi-timeframe siege model: session range extremes on the chart timeframe, only act when the confirmed 1h structure agrees, mark entries/exits for the backtester with model.* calls, confidence from structure quality, and a hard stop. No decorative visuals.',
  'Make a volume-profile-on-chart model: point of control and value area from the visible session, price leaving value is the signal, 3D must show where value sits as terrain with the POC as a labelled rail, 2D must carry the same information when 3D is off.',
  'Fix and upgrade this broken script (I will paste one with a frozen var, a future index, a Pine plotshape signature, and an oscillator forced into pane 3d): explain each defect in one line, return the corrected complete script, and do not change its intended logic.',
];
