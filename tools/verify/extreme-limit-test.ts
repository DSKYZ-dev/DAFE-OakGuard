/**
 * Extreme-Limitation Verification Suite
 *
 * Tests every boundary condition and architectural upgrade added during the
 * final hardening pass:
 *   1. Realized volatility `stdev(...) * sqrt(len) * 100` never false-positives
 *      as Bollinger Bands, while true unrequested `basis + 2 * stdev(close)` does.
 *   2. Mixed price + volatility 3D scripts (e.g. `upperBreak`/`lowerBreak` on
 *      `pane="3d"` + `vol = stdev(...)` on `pane="3d"`) are deterministically
 *      repaired so non-price layers route to `pane="separate"` with 0 LLM rounds.
 *   3. Multi-layer 3D caps respect request structure: 3 default, 4 for Fibonacci
 *      (23.6/38.2/50/61.8), 6 for 5-channel cylinder arrays + spline, and
 *      terrain-preserving cap when `line3d` rails precede a `manifold` surface.
 *   4. Static constant `plot3d` walls are caught by `gradeCode`'s 220-bar
 *      synthetic runtime probe; bar-modulated domain models pass cleanly.
 *   5. Boundary-pushing 3D models (5-Channel Cellular Cylinder Array, 3D Wind
 *      Velocity Vector with Pitch/Yaw/Roll, 3D Pressure Valve with Shockwave
 *      Torus & OVERPRESSURE label3d, 3D Spot-Vol Term Structure & Skew
 *      Reliquary, and Short-Prompt Volatility & Momentum Breakout) all validate,
 *      pass coverage, and execute cleanly with sparse bar-aligned signals.
 *   6. Interpreter flexible `pane` argument slots on `plotshape_3d` / `label3d`
 *      and `varHistory` boolean/numeric lookbacks (`bull[1]`, `isCompressed[1]`).
 *   7. Signal clustering: a state marker (close > upper and mom > thr) fails the
 *      random-walk / up-trend / down-trend probe; edge-triggered rewrites pass;
 *      every built-in reference pattern passes.
 *   8. Optional `--live` flag runs the boundary prompts live through the
 *      configured Meta `muse-spark-1.3` pipeline.
 */
import { validate } from '../../apps/web/src/oakscript/validator';
import { parse } from '../../apps/web/src/oakscript/parser';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { checkRequestCoverage } from '../../apps/web/src/trade-advisor/request-coverage';
import {
  max3DLayersForRequest,
  repairMechanicalViolations,
  repairOscillatorPane3D,
} from '../../apps/web/src/trade-advisor/mechanical-repair';
import {
  generateIndicatorWithGates,
  gradeCode,
  probeConstantLines,
  probeSignalClustering,
  type PipelineRole,
} from '../../apps/web/src/trade-advisor/generation-pipeline';
import { allExemplarSources } from '../../apps/web/src/trade-advisor/exemplars';
import { EXTREME_LIMIT_PROMPTS } from './extreme-limit-prompts';

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 220) : ''}`);
  if (cond) passed++;
  else failed++;
}

const BARS = syntheticBars(220);

async function main(): Promise<void> {
  console.log('=== EXTREME-LIMITATION DETERMINISTIC SUITE ===\n');

  // ── 1. Realized volatility stdev() vs Bollinger Bands ──────────────
  {
    const spotVolPrompt = 'Create a 3D Spot-Vol Term Structure & Skew Reliquary model across three horizons (fast 10-bar, medium 30-bar, and slow 60-bar realized volatility of returns, plus directional skew from price position in the rolling range). Render the term structure as a 3D manifold surface with a front ribbon spine and an impulse bars3d layer in the separate pane, plot the 2D term-structure spread and skew in the lower pane, and fire sparse buy/sell signals on the main chart only when fast volatility expands out of compression while skew flips bullish or bearish.';
    const spotVolCode = `fastLen = input(10, "Fast Vol Length", 5, 30, 1)
medLen = input(30, "Medium Vol Length", 15, 60, 1)
slowLen = input(60, "Slow Vol Length", 30, 120, 1)
skewLen = input(60, "Skew Range Length", 20, 120, 1)
compressThresh = input(0.85, "Compression Threshold", 0.3, 0.98, 0.05)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)

ret1 = (close - close[1]) / max(close[1], 0.0001)
fastVol = stdev(ret1, fastLen) * sqrt(fastLen) * 100
medVol = stdev(ret1, medLen) * sqrt(medLen) * 100
slowVol = stdev(ret1, slowLen) * sqrt(slowLen) * 100
rollHigh = highest(high, skewLen)
rollLow = lowest(low, skewLen)
rng = max(rollHigh - rollLow, 0.0001)
skew = ((close - rollLow) / rng - 0.5) * 2.0
spreadFS = fastVol - slowVol
avgTerm = (fastVol + medVol + slowVol) / 3.0
isCompressed = fastVol < slowVol * compressThresh
impulse = max(fastVol - slowVol, 0.0)
buySig = isCompressed[1] and not isCompressed and skew > 0
sellSig = isCompressed[1] and not isCompressed and skew < 0
if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") }
if sellSig { plotshape(bar_index, high, "Sell", "triangledown", "#ff4477") }
plot(spreadFS, "Spread F-S", "#22cc88", 1, "separate")
plot(skew, "Skew", "#b48cff", 1, "separate")
plot3d(avgTerm, "Term Surface", "manifold", "#00e5ff", "separate", 0)
plot3d(fastVol, "Fast Spine", "ribbon", "#ffd43b", "separate", 1)
plot3d(impulse, "Vol Impulse", "bars3d", "#22cc88", "separate", 2)`;

    const grade = gradeCode(spotVolCode, spotVolPrompt, { prefer3D: true });
    check('1a. Spot-Vol stdev()*sqrt()*100 is NOT falsely flagged as Bollinger Bands', grade.valid, grade.problems);

    const unrequestedBB = `basis = sma(close, 20)
upper = basis + 2.0 * stdev(close, 20)
lower = basis - 2.0 * stdev(close, 20)
plot(upper, "U", "#fff", 1)
if crossover(close, upper) { plotshape(bar_index, low, "B", "triangleup", "#22cc88") }`;
    const bbProblems = checkRequestCoverage('Create a momentum breakout indicator.', unrequestedBB, { prefer3D: false });
    check('1b. True unrequested Bollinger Bands (basis +- mult*stdev(close)) IS flagged',
      bbProblems.some(p => /Bollinger Bands|SMA/.test(p)), bbProblems);
  }

  // ── 2. Mixed price + volatility 3D script auto-routes volatility to "separate" ──
  {
    const userPrompt = 'Create a volatility and momentum breakout model with buy and sell signals.';
    const mixedPaneScript = `volLen = input(20, "Vol Length", 2, 100, 1)
momLen = input(12, "Mom Length", 2, 60, 1)
breakLen = input(50, "Breakout Length", 10, 200, 1)
vol = stdev(close, volLen)
momVal = mom(close, momLen)
upperBreak = highest(high, breakLen)[1]
lowerBreak = lowest(low, breakLen)[1]
rawBuy = close > upperBreak and momVal > vol
rawSell = close < lowerBreak and momVal < 0 - vol
buySig = rawBuy and not rawBuy[1]
sellSig = rawSell and not rawSell[1]
if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") }
if sellSig { plotshape(bar_index, high, "Sell", "triangledown", "#ff4477") }
plot(upperBreak, "Upper Break", "#22cc88", 1, "stepline")
plot(lowerBreak, "Lower Break", "#ff4477", 1, "stepline")
plot(vol, "Volatility", "#b48cff", 1, "separate")
plot3d(upperBreak, "Upper Break", "line3d", "#22cc88", "3d", 0)
plot3d(lowerBreak, "Lower Break", "line3d", "#ff4477", "3d", 1)
plot3d(vol, "Volatility", "ribbon", "#b48cff", "3d", 2)`;

    const beforeCoverage = checkRequestCoverage(userPrompt, mixedPaneScript, { prefer3D: true });
    check('2a. Non-price stdev variable in pane="3d" is caught by checkRequestCoverage',
      beforeCoverage.some(p => /oscillator series rendered with pane "3d"/.test(p)), beforeCoverage);

    const repaired = repairMechanicalViolations(mixedPaneScript, userPrompt, { prefer3D: true });
    check('2b. repairOscillatorPane3D rewrites plot3d(vol, ..., "3d") -> "separate"',
      repaired.code.includes('plot3d(vol, "Volatility", "ribbon", "#b48cff", "separate", 2)')
      && repaired.code.includes('plot3d(upperBreak, "Upper Break", "line3d", "#22cc88", "3d", 0)'),
      repaired.removed);

    const afterGrade = gradeCode(repaired.code, userPrompt, { prefer3D: true });
    check('2c. Repaired mixed breakout script passes gradeCode with 0 errors', afterGrade.valid, afterGrade.problems);

    // 2d–2i. Pane law is judged per series. 2d is the exact script that failed
    // acceptance run 3 (a price level on "3d" beside an RSI on "separate").
    const paneRequest = 'Compile an RSI breakout indicator with a 3D breakout level.';
    const paneIssue = (code: string) => checkRequestCoverage(paneRequest, code, { prefer3D: true })
      .filter(p => /oscillator series rendered with pane "3d"/.test(p));
    const runThreeFinal = `// Fix 1: var lvl = highest(high, 20) froze the level at bar 0 — changed to plain assignment so it recomputes every bar.
// Fix 2: close[-1] peeked one bar into the future (repaint/lookahead) — changed to close vs lvl[1] for a confirmed breakout.
// Fix 3: plotshape(true, low, "Buy", shape.triangleup, color.green) used Pine constants — changed to OakScript positional strings and hex colors.
// Fix 4: oscillator forced into pane 3d rendered as spiky forest over candles — kept RSI in 2D + separate 3D pane, price level in 3d pane.
len = input(20, "High Length", 1, 100, 1)
rsiLen = input(14, "RSI Length", 2, 50, 1)
osLvl = input(30, "Oversold Level", 2, 50, 1)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
lvl = highest(high, len)
r = rsi(close, rsiLen)
state = close > lvl[1]
buySig = state and not state[1]
osSig = crossover(r, osLvl)
if buySig {
    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")
}
if osSig {
    plotshape(bar_index, low, "OS", "triangleup", "#22cc88")
}
plot(lvl, "Breakout Level", "#ffcc33", 1, "stepline")
plot(r, "RSI", "#b48cff", 1, "line")
hline(osLvl, "#22cc8855")
plot3d(lvl, "Level 3D", "line3d", "#ffcc33", "3d", 0)
plot3d(r, "RSI 3D", "ribbon", "#b48cff", "separate", 1)`;
    const d2d = paneIssue(runThreeFinal);
    check('2d. Price level on pane "3d" beside an RSI on "separate" is not flagged (acceptance run-3 case)', d2d.length === 0, d2d);
    const d2e = paneIssue('m = macd(close, 12, 26, 9)\nplot3d(m.macd, "M", "ribbon", "#fff", "3d", 0)');
    check('2e. MACD routed through a variable onto pane "3d" is flagged', d2e.length > 0, d2e);
    const d2f = paneIssue('plot(close, "Close", "#fff", 1)\nplot3d(rsi(close, 14), "R", "ribbon", "#fff", "3d", 0)');
    check('2f. Inline RSI on pane "3d" is flagged', d2f.length > 0, d2f);
    const d2g = paneIssue('stop = low - atr(high, low, close, 14) * 2\nplot3d(stop, "Stop", "line3d", "#ff4477", "3d", 0)');
    check('2g. ATR-offset price stop on pane "3d" is a price level and is not flagged', d2g.length === 0, d2g);
    const repairedLevel = repairOscillatorPane3D(runThreeFinal);
    check('2h. Repair leaves the price level on "3d" and the RSI layer on "separate" untouched',
      repairedLevel.removed.length === 0 && repairedLevel.code === runThreeFinal, repairedLevel.removed);
    const repairedMacd = repairOscillatorPane3D('m = macd(close, 12, 26, 9)\nplot3d(m.macd, "M", "ribbon", "#fff", "3d", 0)');
    check('2i. Repair moves a MACD layer routed through a variable to "separate"',
      repairedMacd.code.includes('plot3d(m.macd, "M", "ribbon", "#fff", "separate", 0)') && repairedMacd.removed.length === 1, repairedMacd.removed);
  }

  // ── 3. Request-aware 3D layer caps (3 default, 4 Fib, 6 5-channel) ──
  {
    const stdReq = 'Create an RSI 3D model.';
    const fibReq = 'Create a Fibonacci retracement indicator showing the 23.6%, 38.2%, 50%, and 61.8% levels in 3D.';
    const fiveChReq = 'Create a 3D cellular signal array indicator that reads an array of 5 distinct channel strengths [ch1, ch2, ch3, ch4, ch5] mapped to 5 parallel vertical cylinders plus a spline curve.';
    check('3a. Default max 3D layers = 3', max3DLayersForRequest(stdReq) === 3);
    check('3b. Fibonacci max 3D layers = 4', max3DLayersForRequest(fibReq) === 4);
    check('3c. 5-channel cylinder array max 3D layers = 6', max3DLayersForRequest(fiveChReq) === 6);
  }

  // ── 4. Static constant plot3d wall detection vs dynamic modulation ──
  {
    const req = 'Compile a 3D wind velocity vector indicator.';
    const staticScript = `wx = input(1.0, "Wind X", -5.0, 5.0, 0.1)
wy = input(0.5, "Wind Y", -5.0, 5.0, 0.1)
spd = sqrt(wx * wx + wy * wy)
plot(spd, "Speed", "#38d0ff", 1, "separate")
plot3d(spd, "Speed 3D", "ribbon", "#38d0ff", "separate", 0)`;
    const staticGrade = gradeCode(staticScript, req, { prefer3D: true });
    check('4a. Static constant plot3d series is flagged by gradeCode runtime probe',
      !staticGrade.valid && staticGrade.problems.some(p => /static constant across all bars/.test(p)),
      staticGrade.problems);

    const dynamicWindScript = `wx = input(1.0, "Wind X", -5.0, 5.0, 0.1)
wy = input(0.5, "Wind Y", -5.0, 5.0, 0.1)
wz = input(0.2, "Wind Z", -5.0, 5.0, 0.1)
baseKnots = input(15.0, "Base Knots", 1.0, 60.0, 0.5)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
vx = wx + (close - open)
vy = wy + (high - low)
vz = wz + (close - close[1])
mag = sqrt(vx * vx + vy * vy + vz * vz) + 0.0001
windSpeed = baseKnots + mag * 4.0
tailLen = windSpeed * 0.35
pitch = (vy / mag) * 45.0
yaw = (vx / mag) * 60.0
roll = (vz / mag) * 30.0
gust = crossover(windSpeed, 22.0)
if gust {
    plotshape(bar_index, low, "Gust", "triangleup", "#ff8800")
    plotshape_3d(bar_index, windSpeed, "Vector", "coneup", "#ff8800", markerSize, 0, "separate", pitch, yaw, roll)
}
plot(windSpeed, "Wind Speed", "#38d0ff", 2, "separate")
plot(tailLen, "Tail Length", "#ff8800", 1, "separate")
plot3d(windSpeed, "Wind Velocity", "ribbon", "#38d0ff", "separate", 0)
plot3d(tailLen, "Vector Tail", "trail", "#ff8800", "separate", 1)`;
    const dynGrade = gradeCode(dynamicWindScript, req, { prefer3D: true });
    check('4b. Dynamic 3D Wind Velocity Vector passes gradeCode + executes clean', dynGrade.valid, dynGrade.problems);
  }

  // ── 5. 5-Channel Cellular Cylinder Array + Spline Curve ────────────
  {
    const req = 'Create a 3D cellular signal array indicator that reads an array of 5 distinct channel strengths [ch1, ch2, ch3, ch4, ch5] mapped to 5 parallel vertical cylinders plus a dynamic 3D spline curve.';
    const fiveChScript = `b1 = input(25.0, "Ch1 Base dBm", 0.0, 100.0, 1.0)
b2 = input(40.0, "Ch2 Base dBm", 0.0, 100.0, 1.0)
b3 = input(55.0, "Ch3 Base dBm", 0.0, 100.0, 1.0)
b4 = input(70.0, "Ch4 Base dBm", 0.0, 100.0, 1.0)
b5 = input(85.0, "Ch5 Base dBm", 0.0, 100.0, 1.0)
mod = (close - lowest(low, 20)) / max(highest(high, 20) - lowest(low, 20), 0.0001) * 15.0
ch1 = min(100.0, max(0.0, b1 + mod * 0.6))
ch2 = min(100.0, max(0.0, b2 + mod * 0.8))
ch3 = min(100.0, max(0.0, b3 + mod * 1.0))
ch4 = min(100.0, max(0.0, b4 + mod * 1.1))
ch5 = min(100.0, max(0.0, b5 + mod * 0.9))
arr = array(ch1, ch2, ch3, ch4, ch5)
avgDbm = array.avg(arr)
if crossover(avgDbm, 60.0) { plotshape(bar_index, low, "Gain Peak", "triangleup", "#22cc88") }
plot(avgDbm, "Array Avg dBm", "#ffd43b", 2, "separate")
plot3d(ch1, "Ch1 Cylinder", "bars3d", "#22aaff", "separate", 0)
plot3d(ch2, "Ch2 Cylinder", "bars3d", "#00e5ff", "separate", 1)
plot3d(ch3, "Ch3 Cylinder", "bars3d", "#22cc88", "separate", 2)
plot3d(ch4, "Ch4 Cylinder", "bars3d", "#ffd43b", "separate", 3)
plot3d(ch5, "Ch5 Cylinder", "bars3d", "#ff8800", "separate", 4)
plot3d(avgDbm, "Top Spline", "ribbon", "#b48cff", "separate", 5)`;
    const repaired = repairMechanicalViolations(fiveChScript, req, { prefer3D: true });
    const p3dCount = (repaired.code.match(/\bplot3d\s*\(/g) || []).length;
    const grade = gradeCode(repaired.code, req, { prefer3D: true });
    check('5a. 5-Channel Cylinder Array preserves all 6 layers (5 cylinders + 1 spline)', p3dCount === 6, { p3dCount });
    check('5b. 5-Channel Cylinder Array passes gradeCode + executes clean', grade.valid, grade.problems);
  }

  // ── 6. 3D Pressure Valve with Torus Disc, Shockwave & OVERPRESSURE label3d ──
  {
    const req = 'Design a 3D pressure valve indicator that displays a flat circular disc spinning on the Y-axis at a speed proportional to flow_psi. When flow_psi exceeds a critical threshold of 150, radiate shockwave rings and instantiate OVERPRESSURE above it.';
    const valveScript = `basePsi = input(110.0, "Base Flow PSI", 20.0, 250.0, 5.0)
critPsi = input(150.0, "Critical PSI", 80.0, 260.0, 5.0)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
rng = max(highest(high, 20) - lowest(low, 20), 0.0001)
flow_psi = basePsi + ((close - lowest(low, 20)) / rng) * 70.0
over = flow_psi > critPsi
lockEvt = over and not over[1]
shockwave = over ? flow_psi : 0.0
if lockEvt {
    plotshape(bar_index, high, "OVERPRESSURE", "triangledown", "#ff4477")
    plotshape_3d(bar_index, flow_psi, "Valve Lock", "torus", "#ff4477", markerSize, 1, "separate")
    label3d(bar_index, flow_psi, "OVERPRESSURE", "#ff4477", 1.0, 1, "separate")
}
plot(flow_psi, "Flow PSI", "#00e5ff", 2, "separate")
hline(150, "#ff4477", "separate")
plot3d(flow_psi, "Valve Disc", "torus", "#00e5ff", "separate", 0)
plot3d(shockwave, "Shockwave Rings", "torus", "#ff4477", "separate", 1)`;
    const grade = gradeCode(valveScript, req, { prefer3D: true });
    check('6a. 3D Pressure Valve passes gradeCode + executes clean', grade.valid, grade.problems);
  }

  // ── 7. Interpreter flexible pane slot on plotshape_3d / label3d + varHistory ──
  {
    const script = `cond = close > open
edge = cond and not cond[1]
if edge {
    plotshape_3d(bar_index, low, "Up", "coneup", "#22cc88", 1.0, "3d")
    label3d(bar_index, high, "EDGE", "#ffd43b", "3d")
}
plot3d(close, "Price", "line3d", "#22cc88", "3d", 0)`;
    const res = executeScript(parse(script), BARS as any, new Map());
    const shapes3d = res.plots.filter(p => p.type === 'plot3d_shape');
    const labels3d = res.plots.filter(p => p.type === 'plot3d_label');
    check('7a. 7-arg plotshape_3d(..., "3d") resolves pane="3d"', shapes3d.length > 0 && shapes3d.every(s => s.pane === '3d'), { count: shapes3d.length });
    check('7b. 5-arg label3d(..., "3d") resolves pane="3d"', labels3d.length > 0 && labels3d.every(l => l.pane === '3d'), { count: labels3d.length });
    check('7c. Boolean lookback (cond and not cond[1]) never fires on consecutive bars',
      shapes3d.every((s, i) => i === 0 || (s.barIdx ?? 0) > (shapes3d[i - 1].barIdx ?? 0) + 1));
  }

  // ── 9. Signal clustering: states paint walls, events mark once ─────
  {
    const breakoutPrompt = 'Create a volatility and momentum breakout model with buy and sell signals.';
    const breakoutSource = `volLen = input(20, "Vol Length", 2, 100, 1)
momLen = input(12, "Mom Length", 2, 60, 1)
breakLen = input(50, "Breakout Length", 10, 200, 1)
volMult = input(1.0, "Vol Mult", 0.1, 5.0, 0.1)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)

vol = stdev(close, volLen)
mom = mom(close, momLen)
momThresh = vol * volMult
upperBreak = highest(high, breakLen)[1]
lowerBreak = lowest(low, breakLen)[1]
volSafe = max(vol, 0.0001)
strength = min(abs(mom) / volSafe, 3.0)
coneSz = min(max(strength, 0.2), 3.0) * markerSize
coneSzC = min(max(coneSz, 0.2), 3.0)

var lastLbl = 0.0

buySig = close > upperBreak and mom > momThresh
sellSig = close < lowerBreak and mom < -momThresh
buyStrong = buySig and strength > 2.0 and bar_index - lastLbl > 20
sellStrong = sellSig and strength > 2.0 and bar_index - lastLbl > 20

if buySig {
    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")
}
if sellSig {
    plotshape(bar_index, high, "Sell", "triangledown", "#ff4477")
}
if buySig {
    plotshape_3d(bar_index, low, "Buy", "coneup", "#22cc88", coneSzC, 0, "3d")
}
if sellSig {
    plotshape_3d(bar_index, high, "Sell", "conedown", "#ff4477", coneSzC, 1, "3d")
}
if buyStrong {
    label3d(bar_index, low, "BREAKOUT", "#22cc88", 1.1, 0, "3d")
    lastLbl := bar_index
}
if sellStrong {
    label3d(bar_index, high, "BREAKDOWN", "#ff4477", 1.1, 1, "3d")
    lastLbl := bar_index
}

plot(upperBreak, "Upper Break", "#22cc88", 1, "stepline")
plot(lowerBreak, "Lower Break", "#ff4477", 1, "stepline")
plot(vol, "Volatility", "#b48cff", 1, "line", "separate")
plot3d(upperBreak, "Upper Break", "line3d", "#22cc88", "3d", 0)
plot3d(lowerBreak, "Lower Break", "line3d", "#ff4477", "3d", 1)
plot3d(vol, "Volatility", "ribbon", "#b48cff", "3d", 2)`;

    const userGrade = gradeCode(breakoutSource, breakoutPrompt, { prefer3D: true });
    check('9a. User breakout (state: close > upperBreak and mom > momThresh) is flagged as clustered',
      userGrade.problems.some(p => /back-to-back bars|of bars/.test(p)), userGrade.problems);

    const edgeSource = breakoutSource
      .replace('buySig = close > upperBreak and mom > momThresh', 'buyState = close > upperBreak and mom > momThresh\nbuySig = buyState and not buyState[1]')
      .replace('sellSig = close < lowerBreak and mom < -momThresh', 'sellState = close < lowerBreak and mom < -momThresh\nsellSig = sellState and not sellState[1]');
    const edgeGrade = gradeCode(repairMechanicalViolations(edgeSource, breakoutPrompt, { prefer3D: true }).code, breakoutPrompt, { prefer3D: true });
    check('9b. Edge-triggered breakout (state variable + first-bar edge) is clean', edgeGrade.valid, edgeGrade.problems);

    const inlineSource = breakoutSource
      .replace('buySig = close > upperBreak and mom > momThresh', 'buySig = (close > upperBreak and mom > momThresh) and not (close[1] > upperBreak[1] and mom[1] > momThresh[1])')
      .replace('sellSig = close < lowerBreak and mom < -momThresh', 'sellSig = (close < lowerBreak and mom < -momThresh) and not (close[1] < lowerBreak[1] and mom[1] < 0 - momThresh[1])');
    const inlineGrade = gradeCode(repairMechanicalViolations(inlineSource, breakoutPrompt, { prefer3D: true }).code, breakoutPrompt, { prefer3D: true });
    check('9c. Inline transition gate (every series shifted by [1]) is clean', inlineGrade.valid, inlineGrade.problems);

    const paintProblems = probeSignalClustering(`up = close > open
if up {
    plotshape(bar_index, low, "Up", "triangleup", "#22cc88")
}
plot(close, "Close", "#38d0ff", 1)`);
    check('9d. Marker that fires on half of all bars is flagged', paintProblems.some(p => /of bars|back-to-back/.test(p)), paintProblems);

    const crossProblems = probeSignalClustering(`brk = highest(high, 20)[1]
if crossover(close, brk) {
    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")
}
plot(brk, "Breakout", "#22cc88", 1, "stepline")`);
    check('9e. Crossover breakout event is not flagged', crossProblems.length === 0, crossProblems);

    const exemplars = allExemplarSources();
    const exemplarFlags = exemplars.filter(ex => probeSignalClustering(ex.source).length > 0).map(ex => ex.id);
    check(`9f. Every built-in reference pattern passes the clustering probe (${exemplars.length} sources)`,
      exemplars.length > 0 && exemplarFlags.length === 0, exemplarFlags);
  }

  // ── 10. Silent-zero arrays: array(a, b, c) is empty; flat lines are caught ──
  {
    const req = 'Create a 3D cellular signal array indicator that reads an array of 5 distinct channel strengths [ch1, ch2, ch3, ch4, ch5] mapped to 5 parallel vertical cylinders plus a dynamic 3D spline curve.';
    const buggy = `b1 = input(25.0, "Ch1 Base dBm", 0.0, 100.0, 1.0)
b2 = input(40.0, "Ch2 Base dBm", 0.0, 100.0, 1.0)
b3 = input(55.0, "Ch3 Base dBm", 0.0, 100.0, 1.0)
b4 = input(70.0, "Ch4 Base dBm", 0.0, 100.0, 1.0)
b5 = input(85.0, "Ch5 Base dBm", 0.0, 100.0, 1.0)
mod = (close - lowest(low, 20)) / max(highest(high, 20) - lowest(low, 20), 0.0001) * 15.0
ch1 = min(100.0, max(0.0, b1 + mod * 0.6))
ch2 = min(100.0, max(0.0, b2 + mod * 0.8))
ch3 = min(100.0, max(0.0, b3 + mod * 1.0))
ch4 = min(100.0, max(0.0, b4 + mod * 1.1))
ch5 = min(100.0, max(0.0, b5 + mod * 0.9))
arr = array(ch1, ch2, ch3, ch4, ch5)
avgDbm = array.avg(arr)
if crossover(avgDbm, 60.0) { plotshape(bar_index, low, "Gain Peak", "triangleup", "#22cc88") }
plot(avgDbm, "Array Avg dBm", "#ffd43b", 2, "separate")
plot3d(ch1, "Ch1 Cylinder", "bars3d", "#22aaff", "separate", 0)
plot3d(ch2, "Ch2 Cylinder", "bars3d", "#00e5ff", "separate", 1)
plot3d(ch3, "Ch3 Cylinder", "bars3d", "#22cc88", "separate", 2)
plot3d(ch4, "Ch4 Cylinder", "bars3d", "#ffd43b", "separate", 3)
plot3d(ch5, "Ch5 Cylinder", "bars3d", "#ff8800", "separate", 4)
plot3d(avgDbm, "Top Spline", "ribbon", "#b48cff", "separate", 5)`;

    const buggyGrade = gradeCode(buggy, req, { prefer3D: true });
    check('10a. array(ch1, ch2, ch3, ch4, ch5) is rejected (ARRAY_CTOR_VALUES) instead of silently reading 0',
      !buggyGrade.valid && buggyGrade.errors.some(e => /ARRAY_CTOR_VALUES/.test(e)), buggyGrade.errors);

    const fixed = repairMechanicalViolations(buggy, req, { prefer3D: true });
    const fixedGrade = gradeCode(fixed.code, req, { prefer3D: true });
    check('10b. Mechanical repair rewrites array(...) to [ch1, ch2, ch3, ch4, ch5] and the script grades clean',
      fixed.code.includes('arr = [ch1, ch2, ch3, ch4, ch5]') && fixedGrade.valid, { removed: fixed.removed, problems: fixedGrade.problems });

    const avgPlot = executeScript(parse(fixed.code), BARS as any, new Map()).plots
      .filter((p: any) => p.type === 'line' && p.name === 'Array Avg dBm' && typeof p.value === 'number' && isFinite(p.value)) as any[];
    const avgValues = avgPlot.map(p => p.value as number);
    const avgSpan = avgValues.length ? Math.max(...avgValues) - Math.min(...avgValues) : 0;
    check('10c. Repaired array average varies bar to bar and sits near the channel band (not 0)',
      avgValues.length >= 100 && Math.min(...avgValues) > 30 && avgSpan > 1, { bars: avgValues.length, min: Math.min(...avgValues), max: Math.max(...avgValues) });

    const flatGrade = gradeCode(`body = close - open
plot(body, "Body", "#38d0ff", 1, "separate")
plot(0.0, "Zero Baseline", "#888888", 1, "separate")`, 'Create a candle body indicator.', { prefer3D: false });
    check('10d. A line holding one constant value on every bar is flagged (flat wall)',
      flatGrade.problems.some(p => /constant/.test(p)), flatGrade.problems);

    const exemplars = allExemplarSources();
    const flatExemplars = exemplars.filter(ex => probeConstantLines(executeScript(parse(ex.source), BARS as any, new Map()).plots as any[]).length > 0).map(ex => ex.id);
    check(`10e. Every built-in reference pattern passes the constant-line probe (${exemplars.length} sources)`,
      exemplars.length > 0 && flatExemplars.length === 0, flatExemplars);
  }

  // ── 8. Optional live run on boundary prompts ───────────────────────
  if (process.argv.includes('--live')) {
    console.log('\n=== LIVE BOUNDARY GENERATION CHECK (Meta muse-spark-1.3) ===\n');
    const BASE = process.env.DAFE_BACKEND || 'http://127.0.0.1:8788';
    const chat = async (prompt: string, role: PipelineRole): Promise<string> => {
      const r = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: role === 'code' ? 'oakscript_coder' : 'trade_advisor', message: prompt }),
      });
      const d: any = await r.json();
      if (!d.ok) throw new Error(d.detail || d.error || 'chat failed');
      return d.reply || '';
    };
    const prompts = EXTREME_LIMIT_PROMPTS;
    for (let i = 0; i < prompts.length; i++) {
      const res = await generateIndicatorWithGates({
        request: prompts[i],
        chat,
        prefer3D: true,
        maxRounds: 3,
        bestOf: 2,
      });
      check(`8.${i + 1} Live boundary prompt #${i + 1} valid + coverage-clean`, res.grade.valid, {
        drafts: res.drafts,
        rounds: res.rounds,
        repairs: res.repairs,
        problems: res.grade.problems,
      });
    }
  }

  console.log(`\nEXTREME-LIMITATION SUMMARY: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
