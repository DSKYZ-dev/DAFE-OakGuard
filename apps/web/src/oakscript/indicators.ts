import { sha256Hex } from '../crypto-utils';
import { appendLedgerEntry } from '../ledger';

export interface IndicatorDef {
  name: string;
  description: string;
  category: string;
  source: string;
}

const INDICATORS: IndicatorDef[] = [
  // ─── Automated Strategies ──────────────────────────────────────
  // Dual-role scripts: on the chart they're full indicators (plots, fills,
  // markers); in Time Machine / Strategy Lab / the paper auto-trader their
  // strategy.entry()/exit() calls drive real fills. One script, both roles —
  // and via the Signal Engine's shape-derivation bridge, every OTHER
  // indicator that plots Buy/Sell markers is backtestable too.
  {
    name: 'Quantum Reversion Engine',
    description: 'Automated model: buys band-reclaim dips in a non-crashing market, exits at the mean, with a confidence score and a hard stop-loss. Full chart visuals + model.* execution in one script.',
    category: '⚡ Automated Signal Models',
    source: `// Quantum Reversion Engine — Automated Mean-Reversion Model
// Entry: close crosses back ABOVE the lower Bollinger band (a reclaim,
// not a falling knife) while the basis isn't in freefall.
// Exit: price tags the basis (mean) or the upper band.
bbLen = input(20, "Band Length", 5, 60, 1)
mult = input(2.0, "StdDev Mult", 0.5, 4.0, 0.25)
slideGuard = input(0.6, "Max Basis Slide %", 0.0, 5.0, 0.1)
stopPct = input(2.5, "Stop-Loss %", 0.5, 10.0, 0.5)
showSignals = input(true, "Show Signals")

basis = sma(close, bbLen)
dev = stdev(close, bbLen)
upper = basis + dev * mult
lower = basis - dev * mult

plot(basis, "Basis", "#b48cff", 2)
plot(upper, "Upper", "#22cc88", 1)
plot(lower, "Lower", "#ff4477", 1)
fill(upper, lower, "rgba(180,140,255,0.07)")

// Basis-freefall guard: skip entries when the mean itself dropped more
// than slideGuard% over the last 5 bars (catching knives in a crash).
basisOk = basis >= basis[5] * (1 - slideGuard / 100)

reclaim = crossover(close, lower)
tagUpper = close >= upper

var inPos = false
enterSig = reclaim and basisOk and not inPos
exitSig = inPos and (close >= basis or tagUpper)

if enterSig
    inPos := true
    // Deeper reclaim below the band = more oversold = higher confidence.
    depth = (basis - close) / (dev * mult)
    model.confidence(min(1.0, max(0.3, depth)))
    model.stopLoss(stopPct)
    model.longEntry("qre")
    if showSignals
        plotshape(bar_index, low, "BUY reclaim", "triangleup", "#22cc88")
if exitSig
    inPos := false
    model.longExit("qre")
    if showSignals
        plotshape(bar_index, high, "EXIT mean", "triangledown", "#ffd166")`,
  },
  {
    name: 'Aurora Momentum Rider',
    description: 'Automated model: rides EMA-cross momentum with an RSI confirmation gate and RSI-scaled confidence. Full chart visuals + model.* execution in one script.',
    category: '⚡ Automated Signal Models',
    source: `// Aurora Momentum Rider — Automated Trend-Following Model
// Entry: fast EMA crosses above slow EMA with RSI confirming momentum.
// Exit: fast EMA crosses back under slow EMA, or momentum dies.
fastLen = input(9, "Fast EMA", 2, 50, 1)
slowLen = input(21, "Slow EMA", 5, 100, 1)
rsiLen = input(14, "RSI Length", 2, 50, 1)
rsiGate = input(52, "RSI Entry Gate", 40, 70, 1)
rsiFloor = input(42, "RSI Exit Floor", 20, 60, 1)
showSignals = input(true, "Show Signals")

fastMA = ema(close, fastLen)
slowMA = ema(close, slowLen)
r = rsi(close, rsiLen)

plot(fastMA, "Fast EMA", "#4cc9f0", 2)
plot(slowMA, "Slow EMA", "#b48cff", 2)
fill(fastMA, slowMA, "rgba(76,201,240,0.08)")
plot(r, "RSI", "#ffd166", 1, "separate")
hline(rsiGate, "rgba(34,204,136,0.4)", "separate")
hline(rsiFloor, "rgba(255,68,119,0.4)", "separate")

crossUp = crossover(fastMA, slowMA)
crossDn = crossunder(fastMA, slowMA)

var inPos = false
enterSig = crossUp and r > rsiGate and not inPos
exitSig = inPos and (crossDn or r < rsiFloor)

if enterSig
    inPos := true
    // Confidence scales with how far RSI cleared the gate — no bracket
    // here on purpose: a trend-follower wants to ride momentum, not get
    // stopped out of it early by a fixed distance.
    model.confidence(min(1.0, (r - rsiGate) / (100 - rsiGate)))
    model.longEntry("amr")
    if showSignals
        plotshape(bar_index, low, "BUY momentum", "triangleup", "#22cc88")
if exitSig
    inPos := false
    model.longExit("amr")
    if showSignals
        plotshape(bar_index, high, "EXIT momentum", "triangledown", "#ff4477")`,
  },
  {
    name: 'Riptide Scalper',
    description: 'Automated model: buys short RSI dips and banks the first bounce with a tight stop and a fast forced timeout — tuned for a high, consistent win rate over many short trades rather than a few large ones. Full chart visuals + model.* execution in one script.',
    category: '⚡ Automated Signal Models',
    source: `// Riptide Scalper — Automated High-Win-Rate Reversion Model
// Entry: RSI dips into oversold territory (a short, sharp pullback).
// Exit: the first up-tick off the dip banks the win before it fades, with
// a short forced timeout as backstop so a stalled trade never rides out a
// slow bleed, and a tight stop-loss caps tail risk on the rest.
rsiLen = input(7, "RSI Length", 2, 30, 1)
rsiLow = input(40, "Oversold Entry", 10, 50, 1)
maxHold = input(3, "Max Hold (bars)", 1, 20, 1)
stopPct = input(0.35, "Stop-Loss %", 0.1, 5.0, 0.05)
showSignals = input(true, "Show Signals")

r = rsi(close, rsiLen)
plot(r, "RSI", "#4cc9f0", 1, "separate")
hline(rsiLow, "rgba(255,68,119,0.4)", "separate")

var inPos = false
var entryBar = 0
barsHeld = bar_index - entryBar

enterSig = r < rsiLow and not inPos
forceExit = inPos and barsHeld >= maxHold
signalExit = inPos and close > close[1] and barsHeld >= 1

if enterSig
    inPos := true
    entryBar := bar_index
    // Deeper into oversold = higher confidence in the bounce.
    model.confidence(min(1.0, (rsiLow - r) / rsiLow + 0.4))
    model.stopLoss(stopPct)
    model.longEntry("rts")
    if showSignals
        plotshape(bar_index, low, "BUY dip", "triangleup", "#22cc88")
if inPos and (signalExit or forceExit)
    inPos := false
    model.longExit("rts")
    if showSignals
        plotshape(bar_index, high, "EXIT bounce", "triangledown", "#ffd166")`,
  },

  // ─── Moving Averages ───────────────────────────────────────────
  {
    name: 'Simple Moving Average Crossover',
    description: 'Classic SMA crossover with buy/sell signals',
    category: 'Moving Averages',
    source: `// Simple Moving Average Crossover
fastLen = input(9, "Fast Length")
slowLen = input(21, "Slow Length")
showSignals = input(true, "Show Signals")

fastMA = sma(close, fastLen)
slowMA = sma(close, slowLen)

plot(fastMA, "Fast MA", "#22cc88", 2)
plot(slowMA, "Slow MA", "#ff4477", 2)
fill(fastMA, slowMA, "rgba(76,201,240,0.08)")

if showSignals
    crossed = crossover(fastMA, slowMA)
    if crossed
        plotshape(bar_index, low, "BUY", "triangleup", "#22cc88")

    crossedDown = crossunder(fastMA, slowMA)
    if crossedDown
        plotshape(bar_index, high, "SELL", "triangledown", "#ff4477")`,
  },

  {
    name: 'EMA Ribbon',
    description: 'Multiple EMAs forming a ribbon for trend analysis',
    category: 'Moving Averages',
    source: `// EMA Ribbon
len1 = input(9, "EMA 1")
len2 = input(21, "EMA 2")
len3 = input(50, "EMA 3")
len4 = input(100, "EMA 4")
showSignals = input(true, "Show Signals")

e1 = ema(close, len1)
e2 = ema(close, len2)
e3 = ema(close, len3)
e4 = ema(close, len4)

plot(e1, "EMA 9", "#ff6b6b", 1)
plot(e2, "EMA 21", "#ffa94d", 1)
plot(e3, "EMA 50", "#ffd43b", 1)
plot(e4, "EMA 100", "#69db7c", 1)
fill(e1, e4, "rgba(255,169,77,0.07)")

var wasBull = false
var wasBear = false
ribbonBull = e1 > e2 and e2 > e3 and e3 > e4
ribbonBear = e1 < e2 and e2 < e3 and e3 < e4
flipUp = ribbonBull and not wasBull
flipDn = ribbonBear and not wasBear
wasBull := ribbonBull
wasBear := ribbonBear

if showSignals
    if flipUp
        plotshape(bar_index, low, "BUY", "triangleup", "#22cc88")
    if flipDn
        plotshape(bar_index, high, "SELL", "triangledown", "#ff4477")`,
  },

  // ─── Oscillators ────────────────────────────────────────────────
  {
    name: 'RSI',
    description: 'Relative Strength Index with overbought/oversold levels and main-chart signals',
    category: 'Oscillators',
    source: `// Relative Strength Index
rsiLen = input(14, "RSI Length")
obLevel = input(70, "Overbought Level")
osLevel = input(30, "Oversold Level")
showSignals = input(true, "Show Signals")

rsiVal = rsi(close, rsiLen)

plot(rsiVal, "RSI", "#b48cff", 2, "separate")
hline(obLevel, "#ff4477", "separate")
hline(50, "rgba(255,255,255,0.15)", "separate")
hline(osLevel, "#22cc88", "separate")
bgcolor(rsiVal >= obLevel ? "rgba(255,68,119,0.12)" : rsiVal <= osLevel ? "rgba(34,204,136,0.12)" : "rgba(0,0,0,0)", "separate")

if showSignals
    osCross = crossover(rsiVal, osLevel)
    obCross = crossunder(rsiVal, obLevel)
    if osCross
        plotshape(bar_index, low, "RSI BUY", "triangleup", "#22cc88")
    if obCross
        plotshape(bar_index, high, "RSI SELL", "triangledown", "#ff4477")`,
  },

  {
    name: 'RSI 3D Surface',
    description: 'RSI rendered as a 3D surface plot in the lower pane — watch oscillator waves flow through time',
    category: '3D Visualizations',
    source: `// RSI 3D Surface — terrain + smoothed ribbon + extreme-reclaim cones
rsiLen = input(14, "RSI Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
rsiVal = rsi(close, rsiLen)
rsiSlow = sma(rsiVal, 5)

plot(rsiVal, "RSI", "#b48cff", 1, "separate")
hline(70, "#ff4477", "separate")
hline(30, "#22cc88", "separate")

if crossover(rsiVal, 30)
    plotshape_3d(bar_index, rsiVal, "OS Reclaim", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(rsiVal, 70)
    plotshape_3d(bar_index, rsiVal, "OB Loss", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(rsiVal, 30)
    plotshape(bar_index, low, "RSI Reclaim", "triangleup", "#22cc88")
if crossunder(rsiVal, 70)
    plotshape(bar_index, high, "RSI Loss", "triangledown", "#ff4477")

plot3d(rsiVal, "RSI Surface", "surface", "#b48cff", "separate", 0)
plot3d(rsiSlow, "RSI Trend", "ribbon", "#22ccff", "separate", 1)`,
  },
  {
    name: 'Volume 3D Bars',
    description: 'Volume histogram as 3D bars — makes volume spikes pop out of the chart',
    category: '3D Visualizations',
    source: `// Volume 3D Bars — columns + relative-volume ridge + climax spikes
volLen = input(20, "Baseline Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
relVol = volume / max(sma(volume, volLen), 1)

plot(volume, "Volume", "#ffd43b", 1, "separate")

if relVol > 2.0
    plotshape_3d(bar_index, volume, "Climax", "coneup", "#22cc88", markerSize, 0, "separate")
if relVol > 2.0
    plotshape(bar_index, low, "Vol Climax", "triangleup", "#ffd43b")

plot3d(volume, "Volume 3D", "bars3d", "#ffd43b", "separate", 0)
plot3d(relVol * 100, "Rel Volume", "ridgeline", "#22ccff", "separate", 1)`,
  },
  {
    name: 'MACD 3D Ribbon',
    description: 'MACD line and signal line as glowing 3D ribbons',
    category: '3D Visualizations',
    source: `// MACD 3D Ribbon
fast = input(12, "Fast")
slow = input(26, "Slow")
sigLen = input(9, "Signal")
m = macd(close, fast, slow, sigLen)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)

plot(m.macd, "MACD", "#22aaff", 1, "separate")
plot(m.signal, "Signal", "#ff8800", 1, "separate")

if crossover(m.macd, m.signal)
    plotshape_3d(bar_index, m.macd, "MACD Up", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(m.macd, m.signal)
    plotshape_3d(bar_index, m.macd, "MACD Dn", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(m.macd, m.signal)
    plotshape(bar_index, low, "MACD BUY", "triangleup", "#22cc88")
if crossunder(m.macd, m.signal)
    plotshape(bar_index, high, "MACD SELL", "triangledown", "#ff4477")

plot3d(m.macd, "MACD", "ribbon", "#22aaff", "separate", 0)
plot3d(m.signal, "Signal", "ribbon", "#ff8800", "separate", 1)
plot3d(m.hist, "Histogram", "bars3d", "#8866ff", "separate", 2)`,
  },
  {
    name: 'RSI Scatter',
    description: 'RSI values as colored 3D scatter plot — overbought/oversold regions visible by color gradient',
    category: '3D Visualizations',
    source: `// RSI 3D Scatter — point cloud + trend ribbon through it
rsiLen = input(14, "RSI Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
rsiVal = rsi(close, rsiLen)
rsiSlow = sma(rsiVal, 5)

plot(rsiVal, "RSI", "#ff6b6b", 1, "separate")

if crossover(rsiVal, 30)
    plotshape_3d(bar_index, rsiVal, "OS Reclaim", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(rsiVal, 70)
    plotshape_3d(bar_index, rsiVal, "OB Loss", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(rsiVal, 30)
    plotshape(bar_index, low, "RSI Reclaim", "triangleup", "#22cc88")
if crossunder(rsiVal, 70)
    plotshape(bar_index, high, "RSI Loss", "triangledown", "#ff4477")

plot3d(rsiVal, "RSI Scatter", "scatter", "#ff6b6b", "separate", 0)
plot3d(rsiSlow, "RSI Trend", "ribbon", "#22ccff", "separate", 1)`,
  },
  {
    name: 'Fibonacci Levels 3D',
    description: 'Four straight Fibonacci retracement levels on cleanly separated depth planes (line3d + 2D stepline twins), with reclaim/loss cone signals and latest-event label',
    category: '3D Visualizations',
    source: `// Fibonacci Levels 3D — 23.6%, 38.2%, 50%, 61.8% levels in 2D + 3D
lookback = input(80, "Swing Lookback", 10, 300, 1)
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)

swingHigh = highest(high, lookback)
swingLow = lowest(low, lookback)
rng = swingHigh - swingLow

fib236 = swingHigh - rng * 0.236
fib382 = swingHigh - rng * 0.382
fib50 = swingHigh - rng * 0.5
fib618 = swingHigh - rng * 0.618

buySig = crossover(close, fib618)
sellSig = crossunder(close, fib382)

// Confirmed bars only: a forming-bar cross would vanish at the close.
if barstate.isconfirmed and buySig {
    plotshape(bar_index, low, "Reclaim 61.8%", "triangleup", "#22cc88")
    plotshape_3d(bar_index, low, "Reclaim 61.8%", "coneup", "#22cc88", markerSize, 3, "3d")
    label3d(bar_index, fib618, "Reclaim 61.8%", "#22cc88", 0.9, 3, "3d")
}
if barstate.isconfirmed and sellSig {
    plotshape(bar_index, high, "Lost 38.2%", "triangledown", "#ff4477")
    plotshape_3d(bar_index, high, "Lost 38.2%", "conedown", "#ff4477", markerSize, 1, "3d")
    label3d(bar_index, fib382, "Lost 38.2%", "#ff4477", 0.9, 1, "3d")
}

plot(fib236, "23.6%", "#00ccff", 1, "stepline")
plot(fib382, "38.2%", "#ffcc00", 1, "stepline")
plot(fib50, "50%", "#b48cff", 1, "stepline")
plot(fib618, "61.8%", "#22cc88", 1, "stepline")

plot3d(fib236, "Fib 23.6%", "line3d", "#00ccff", "3d", 0)
plot3d(fib382, "Fib 38.2%", "line3d", "#ffcc00", "3d", 1)
plot3d(fib50, "Fib 50%", "line3d", "#b48cff", "3d", 2)
plot3d(fib618, "Fib 61.8%", "line3d", "#22cc88", "3d", 3)`,
  },
  {
    name: 'EMA Spread Line3D',
    description: 'Fast/slow EMA spread as a thin 3D line — a minimal trend-strength trace ("line3d" style)',
    category: '3D Visualizations',
    source: `// EMA Spread Line3D — spread trace + ribbon pair + zero-cross cones
fastLen = input(9, "Fast EMA")
slowLen = input(21, "Slow EMA")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
fastE = ema(close, fastLen)
slowE = ema(close, slowLen)
spread = fastE - slowE

plot(spread, "Spread", "#22aaff", 1, "separate")
hline(0, "rgba(255,255,255,0.3)", "separate")

if crossover(spread, 0)
    plotshape_3d(bar_index, spread, "Trend Up", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(spread, 0)
    plotshape_3d(bar_index, spread, "Trend Dn", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(spread, 0)
    plotshape(bar_index, low, "Trend Up", "triangleup", "#22cc88")
if crossunder(spread, 0)
    plotshape(bar_index, high, "Trend Dn", "triangledown", "#ff4477")

plot3d(spread, "EMA Spread", "line3d", "#22aaff", "separate", 0)
plot3d(spread * 3, "Spread Power", "ribbon", "#b48cff", "separate", 1)`,
  },
  {
    name: 'ATR Wireframe Terrain',
    description: 'Volatility (ATR) as an x-ray wireframe landscape — calm valleys, volatile peaks ("wireframe" style)',
    category: '3D Visualizations',
    source: `// ATR Wireframe Terrain — x-ray terrain + smoothed ridge + expansion cones
atrLen = input(14, "ATR Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
a = atr(high, low, close, atrLen)
aSlow = sma(a, 10)

plot(a, "ATR", "#22cc88", 1, "separate")

if a > aSlow * 1.5 and a[1] <= aSlow[1] * 1.5
    plotshape_3d(bar_index, a, "Vol Expansion", "coneup", "#ffd43b", markerSize, 0, "separate")
if a > aSlow * 1.5 and a[1] <= aSlow[1] * 1.5
    plotshape(bar_index, high, "Vol Expansion", "triangledown", "#ffd43b")

plot3d(a, "ATR Terrain", "wireframe", "#22cc88", "separate", 0)
plot3d(aSlow, "ATR Ridge", "ribbon", "#ff8800", "separate", 1)`,
  },
  {
    name: 'Momentum Mesh',
    description: 'Rate-of-change momentum as a solid opaque mesh surface ("mesh" style)',
    category: '3D Visualizations',
    source: `// Momentum Mesh — solid terrain + smoothed ribbon + zero-cross cones
rocLen = input(10, "ROC Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
r = roc(close, rocLen)
rSlow = sma(r, 5)

plot(r, "Momentum", "#ff8800", 1, "separate")
hline(0, "rgba(255,255,255,0.3)", "separate")

if crossover(r, 0)
    plotshape_3d(bar_index, r, "Mom Up", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(r, 0)
    plotshape_3d(bar_index, r, "Mom Dn", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(r, 0)
    plotshape(bar_index, low, "Mom Up", "triangleup", "#22cc88")
if crossunder(r, 0)
    plotshape(bar_index, high, "Mom Dn", "triangledown", "#ff4477")

plot3d(r, "Momentum Mesh", "mesh", "#ff8800", "separate", 0)
plot3d(rSlow, "Mom Trend", "ribbon", "#22ccff", "separate", 1)`,
  },
  {
    name: 'Stochastic Helix',
    description: 'Stochastic %K wrapped in an interweaving double-helix — cyclic momentum as DNA ("helix" style)',
    category: '3D Visualizations',
    source: `// Stochastic Helix — double helix + %D ribbon + zone-cross cones
stochLen = input(14, "Stochastic Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
k = stoch(high, low, close, stochLen)
d = sma(k, 3)

plot(k, "%K", "#b48cff", 1, "separate")
plot(d, "%D", "#ff8800", 1, "separate")

if crossover(k, d) and k < 30
    plotshape_3d(bar_index, k, "OS Cross", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(k, d) and k > 70
    plotshape_3d(bar_index, k, "OB Cross", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(k, d) and k < 30
    plotshape(bar_index, low, "Stoch BUY", "triangleup", "#22cc88")
if crossunder(k, d) and k > 70
    plotshape(bar_index, high, "Stoch SELL", "triangledown", "#ff4477")

plot3d(k, "Stoch Helix", "helix", "#b48cff", "separate", 0)
plot3d(d, "Stoch Signal", "ribbon", "#ff8800", "separate", 1)`,
  },
  {
    name: 'ADX Vortex Funnel',
    description: 'Trend strength (ADX) as a six-armed converging spiral tornado ("vortex" style)',
    category: '3D Visualizations',
    source: `// ADX Vortex Funnel — spiral + strength ribbon + trend-birth cones
adxLen = input(14, "ADX Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
strength = adx(high, low, close, adxLen)
sSlow = sma(strength, 5)

plot(strength, "ADX", "#ff4477", 1, "separate")
hline(25, "rgba(255,255,255,0.3)", "separate")

if crossover(strength, 25)
    plotshape_3d(bar_index, strength, "Trend Birth", "coneup", "#22cc88", markerSize, 0, "separate")
if crossover(strength, 25)
    plotshape(bar_index, low, "Trend Birth", "triangleup", "#22cc88")

plot3d(strength, "Trend Vortex", "vortex", "#ff4477", "separate", 0)
plot3d(sSlow, "Strength Ridge", "ribbon", "#22ccff", "separate", 1)`,
  },
  {
    name: 'CCI Manifold Sheet',
    description: 'Flagship edition: CCI gradient manifold terrain + deviation sheath, MAIN-CHART reclaim/reject signals, gated 3D cones',
    category: '3D Visualizations',
    source: `// CCI Manifold Sheet — FLAGSHIP (dashboard edition)
// Read: is CCI extreme, and is it turning? Manifold terrain (height=CCI,
// color=height ramp) + deviation sheath in the lower pane; signals live
// on the MAIN chart where trades are decided; cones are gated + cooled.
cciLen = input(20, "CCI Length")
devLen = input(20, "Deviation Length", 5, 60, 1)
cooldown = input(15, "Signal Cooldown (bars)", 0, 60, 1)
markerSize = input(0.8, "Marker Size", 0.2, 2.0, 0.1)
showSignals = input(true, "Show Signals")

c = cci(high, low, close, cciLen)
cSlow = sma(c, 5)
dev = stdev(c, devLen)
upper = c + dev
lower = c - dev

var lastSigBar = -1000
reclaim = crossover(c, -100) and bar_index - lastSigBar > cooldown
reject = crossunder(c, 100) and bar_index - lastSigBar > cooldown
if reclaim
    lastSigBar := bar_index
if reject
    lastSigBar := bar_index

plot(c, "CCI", "#22aaff", 2, "separate")
plot(cSlow, "CCI Trend", "#ffd43b", 1, "separate")
hline(100, "#ff4477", "separate")
hline(-100, "#22cc88", "separate")
hline(0, "rgba(255,255,255,0.18)", "separate")
bgcolor(c > 100 ? "rgba(255,68,119,0.10)" : c < -100 ? "rgba(34,204,136,0.10)" : "rgba(0,0,0,0)", "separate")

if showSignals and reclaim
    plotshape(bar_index, low, "CCI Reclaim", "triangleup", "#22cc88")
if showSignals and reject
    plotshape(bar_index, high, "CCI Reject", "triangledown", "#ff4477")
if showSignals and reclaim
    plotshape_3d(bar_index, c, "Reclaim", "coneup", "#22cc88", markerSize, 0, "separate")
if showSignals and reject
    plotshape_3d(bar_index, c, "Reject", "conedown", "#ff4477", markerSize, 0, "separate")

plot3d(c, "CCI Manifold", "manifold", "#22aaff", "separate", 0)
plot3d(cSlow, "CCI Trend", "ribbon", "#ffd43b", "separate", 1)
plot3d(upper, "Deviation Sheath", "surface", "#b48cff", "separate", 2)`,
  },
  {
    name: 'Money Flow Nebula',
    description: 'MFI as a glowing volumetric particle cloud — money-flow atmosphere ("nebula" style)',
    category: '3D Visualizations',
    source: `// Money Flow Nebula — particle cloud + flow columns + extreme cones
mfiLen = input(14, "MFI Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
flow = mfi(high, low, close, volume, mfiLen)

plot(flow, "MFI", "#b48cff", 1, "separate")
hline(80, "#ff4477", "separate")
hline(20, "#22cc88", "separate")

if crossover(flow, 20)
    plotshape_3d(bar_index, flow, "Flow Reclaim", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(flow, 80)
    plotshape_3d(bar_index, flow, "Flow Exhaust", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(flow, 20)
    plotshape(bar_index, low, "Flow Reclaim", "triangleup", "#22cc88")
if crossunder(flow, 80)
    plotshape(bar_index, high, "Flow Exhaust", "triangledown", "#ff4477")

plot3d(flow, "Flow Nebula", "nebula", "#b48cff", "separate", 0)
plot3d(flow, "Flow Columns", "bars3d", "#22ccff", "separate", 1)`,
  },
  {
    name: 'Pivot Constellation',
    description: 'Chaikin Money Flow as connected glowing stars — sparse structure recognition ("constellation" style)',
    category: '3D Visualizations',
    source: `// Pivot Constellation — star field + flow stream + zero-cross cones
cmfLen = input(20, "CMF Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
flow = cmf(high, low, close, volume, cmfLen)

plot(flow * 100, "CMF", "#ffd43b", 1, "separate")
hline(0, "rgba(255,255,255,0.3)", "separate")

// Confirmed bars only: a forming-bar cross would vanish at the close.
if barstate.isconfirmed and crossover(flow, 0)
    plotshape_3d(bar_index, flow * 100, "Flow +", "coneup", "#22cc88", markerSize, 0, "separate")
if barstate.isconfirmed and crossunder(flow, 0)
    plotshape_3d(bar_index, flow * 100, "Flow -", "conedown", "#ff4477", markerSize, 0, "separate")
if barstate.isconfirmed and crossover(flow, 0)
    plotshape(bar_index, low, "Flow +", "triangleup", "#22cc88")
if barstate.isconfirmed and crossunder(flow, 0)
    plotshape(bar_index, high, "Flow -", "triangledown", "#ff4477")

plot3d(flow * 100, "Flow Stars", "constellation", "#ffd43b", "separate", 0)
plot3d(flow * 100, "Flow Stream", "trail", "#22ccff", "separate", 1)`,
  },
  {
    name: 'Volume Torus Tunnel',
    description: 'Relative volume as a flowing tunnel of rings — ring size tracks activity ("torus" style)',
    category: '3D Visualizations',
    source: `// Volume Torus Tunnel — ring tunnel + raw columns + climax cones
volLen = input(20, "Baseline Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
relVol = volume / max(sma(volume, volLen), 1)

plot(relVol, "Rel Volume", "#22aaff", 1, "separate")
hline(1, "rgba(255,255,255,0.3)", "separate")

if relVol > 2.0
    plotshape_3d(bar_index, relVol, "Climax", "coneup", "#22cc88", markerSize, 0, "separate")
if relVol > 2.0
    plotshape(bar_index, low, "Vol Climax", "triangleup", "#ffd43b")

plot3d(relVol, "Volume Rings", "torus", "#22aaff", "separate", 0)
plot3d(volume, "Raw Volume", "bars3d", "#ffd43b", "separate", 1)`,
  },
  {
    name: 'OBV Trail Stream',
    description: 'On-Balance Volume as a streaming ribbon whose width breathes with flow ("trail" style)',
    category: '3D Visualizations',
    source: `// OBV Trail Stream — flow stream + manifold + trend-cross cones
obvLen = input(21, "OBV Trend Length")
markerSize = input(1.0, "Marker Size", 0.2, 3.0, 0.1)
o = obv(close, volume)
oTrend = ema(o, obvLen)

plot(o, "OBV", "#22cc88", 1, "separate")
plot(oTrend, "OBV Trend", "#ff8800", 1, "separate")

if crossover(o, oTrend)
    plotshape_3d(bar_index, o, "Flow Up", "coneup", "#22cc88", markerSize, 0, "separate")
if crossunder(o, oTrend)
    plotshape_3d(bar_index, o, "Flow Dn", "conedown", "#ff4477", markerSize, 0, "separate")
if crossover(o, oTrend)
    plotshape(bar_index, low, "Flow Up", "triangleup", "#22cc88")
if crossunder(o, oTrend)
    plotshape(bar_index, high, "Flow Dn", "triangledown", "#ff4477")

plot3d(o, "OBV Trail", "trail", "#22cc88", "separate", 0)
plot3d(oTrend, "OBV Manifold", "manifold", "#ff8800", "separate", 1)`,
  },
  {
    name: 'Temporal Price Ridgeline',
    description: 'Stacked price-distribution ridges over time with a labeled point of control — joyplot market memory ("ridgeline" style + label3d)',
    category: '3D Visualizations',
    source: `// Temporal Price Ridgeline
// Where has price LIVED? Each ridge is one time slice's price distribution.
poc = median(close, 50)
plot(poc, "POC", "#ffd43b", 1, "stepline")
plot3d(close, "Price Ridges", "ridgeline", "#b48cff", "separate", 0)
plot3d(poc, "POC Spine", "line3d", "#ffd43b", "separate", 1)
if crossover(close, poc) {
    label3d(bar_index, close, "POC RECLAIM", "#22cc88", 1.2, 0, "separate")
    plotshape(bar_index, low, "POC Reclaim", "triangleup", "#22cc88")
}
if crossunder(close, poc) {
    label3d(bar_index, close, "POC LOSS", "#ff4477", 1.2, 0, "separate")
    plotshape(bar_index, high, "POC Loss", "triangledown", "#ff4477")
}`,
  },

  {
    name: 'MACD',
    description: 'Moving Average Convergence Divergence with main-chart signal markers',
    category: 'Oscillators',
    source: `// MACD
fast = input(12, "Fast Length")
slow = input(26, "Slow Length")
signalLen = input(9, "Signal Length")
showSignals = input(true, "Show Signals")

m = macd(close, fast, slow, signalLen)

// MACD line, signal line and histogram (zero-line oscillator pane)
plot(m.macd, "MACD", "#22aaff", 2, "separate")
plot(m.signal, "Signal", "#ff8800", 2, "separate")
plot(m.hist, "Histogram", "#8866ff", 1, "separate")
hline(0, "rgba(255,255,255,0.15)", "separate")

var wasAbove = false
above = m.hist > 0
histUp = above and not wasAbove
histDn = not above and wasAbove
wasAbove := above

if showSignals
    if histUp
        plotshape(bar_index, low, "MACD BUY", "triangleup", "#22cc88")
    if histDn
        plotshape(bar_index, high, "MACD SELL", "triangledown", "#ff4477")`,
  },

  {
    name: 'CCI',
    description: 'Commodity Channel Index with main-chart reversal signals',
    category: 'Oscillators',
    source: `// Commodity Channel Index
cciLen = input(20, "CCI Length")
obLevel = input(100, "Overbought")
osLevel = input(-100, "Oversold")
showSignals = input(true, "Show Signals")

cciVal = cci(high, low, close, cciLen)

plot(cciVal, "CCI", "#ffa94d", 2, "separate")
hline(obLevel, "#ff4477", "separate")
hline(osLevel, "#22cc88", "separate")
hline(0, "rgba(255,255,255,0.15)", "separate")

if showSignals
    upCross = crossover(cciVal, osLevel)
    dnCross = crossunder(cciVal, obLevel)
    if upCross
        plotshape(bar_index, low, "CCI BUY", "triangleup", "#22cc88")
    if dnCross
        plotshape(bar_index, high, "CCI SELL", "triangledown", "#ff4477")`,
  },

  {
    name: 'Stochastic',
    description: 'Stochastic oscillator (%K / %D) with main-chart crossover signals',
    category: 'Oscillators',
    source: `// Stochastic Oscillator
kLen = input(14, "%K Length")
dLen = input(3, "%D Smoothing")
obLevel = input(80, "Overbought")
osLevel = input(20, "Oversold")
showSignals = input(true, "Show Signals")

hh = highest(high, kLen)
ll = lowest(low, kLen)
kVal = 100 * (close - ll) / (hh - ll)
dVal = sma(kVal, dLen)

plot(kVal, "%K", "#22aaff", 2, "separate")
plot(dVal, "%D", "#ff8800", 2, "separate")
hline(obLevel, "#ff4477", "separate")
hline(osLevel, "#22cc88", "separate")
hline(50, "rgba(255,255,255,0.1)", "separate")

if showSignals
    // Zone-gated crosses only — an ungated %K/%D cross fires on a third of
    // all bars and buries the chart in markers.
    upCross = crossover(kVal, dVal) and kVal < osLevel + 10
    dnCross = crossunder(kVal, dVal) and kVal > obLevel - 10
    // Confirmed bars only: a forming-bar cross would vanish at the close.
    if barstate.isconfirmed and upCross
        plotshape(bar_index, low, "Stoch BUY", "triangleup", "#22cc88")
    if barstate.isconfirmed and dnCross
        plotshape(bar_index, high, "Stoch SELL", "triangledown", "#ff4477")`,
  },

  // ─── Volatility ─────────────────────────────────────────────────
  {
    name: 'Bollinger Bands',
    description: 'SMA basis with ±mult standard deviation envelope and band-cross signals',
    category: 'Volatility',
    source: `// Bollinger Bands
bbLen = input(20, "Length")
mult = input(2.0, "StdDev Mult", 0.5, 5.0, 0.5)
showSignals = input(true, "Show Signals")

basis = sma(close, bbLen)
dev = stdev(close, bbLen)
upper = basis + dev * mult
lower = basis - dev * mult

plot(basis, "Basis", "#b48cff", 2)
plot(upper, "Upper", "#22cc88", 1)
plot(lower, "Lower", "#ff4477", 1)
fill(upper, lower, "rgba(180,140,255,0.08)")

if showSignals
    buyCross = crossover(close, lower)
    sellCross = crossunder(close, upper)
    // Confirmed bars only: a forming-bar cross would vanish at the close.
    if barstate.isconfirmed and buyCross
        plotshape(bar_index, low, "BB BUY", "triangleup", "#22cc88")
    if barstate.isconfirmed and sellCross
        plotshape(bar_index, high, "BB SELL", "triangledown", "#ff4477")`,
  },

  {
    name: 'Session High/Low Divergence',
    description: 'Session range extremes with deviation divergence: price prints a new session high/low while its position inside the range weakens (bearish) or strengthens (bullish). No moving averages.',
    category: 'Oscillators',
    source: `// Session High/Low Divergence
// Structure: rolling session extremes (highest/lowest). Deviation = where
// close sits inside that range. Divergence: price makes a NEW session
// extreme while deviation moves the OTHER way vs 3 bars ago.
len = input(78, "Session Lookback (bars)", 10, 500, 1)
devLag = input(3, "Deviation Compare Lag", 1, 10, 1)
showSignals = input(true, "Show Signals")

sessHigh = highest(high, len)
sessLow = lowest(low, len)
rng = sessHigh - sessLow
mid = (sessHigh + sessLow) / 2
dev = rng > 0 ? (close - mid) / rng : 0.0

plot(sessHigh, "Session High", "#ff4477", 1, "stepline")
plot(sessLow, "Session Low", "#22cc88", 1, "stepline")
fill(sessHigh, sessLow, "rgba(76,201,240,0.05)")
plot(dev, "Deviation", "#4cc9f0", 1, "separate")
hline(0, "rgba(255,255,255,0.35)", "separate")

newHigh = high >= sessHigh[1]
newLow = low <= sessLow[1]
bearDiv = newHigh and dev < dev[devLag]
bullDiv = newLow and dev > dev[devLag]

if showSignals and bullDiv
    plotshape(bar_index, low, "Buy Div", "triangleup", "#22cc88")
if showSignals and bearDiv
    plotshape(bar_index, high, "Sell Div", "triangledown", "#ff4477")`,
  },

  {
    name: 'VWAP Bands',
    description: 'Volume-weighted average price with deviation bands and VWAP-cross signals',
    category: 'Volume',
    source: `// VWAP Bands
vwapLen = input(20, "Band Length")
mult = input(1.5, "Band Mult", 0.5, 5.0, 0.5)
showSignals = input(true, "Show Signals")

vwapVal = vwap(close, volume)
typical = (high + low + close) / 3
dev = stdev(typical, vwapLen)
upper = vwapVal + dev * mult
lower = vwapVal - dev * mult

plot(vwapVal, "VWAP", "#ffd166", 2)
plot(upper, "Upper", "#22cc88", 1)
plot(lower, "Lower", "#ff4477", 1)
fill(upper, lower, "rgba(255,209,102,0.08)")

if showSignals
    buyCross = crossover(close, vwapVal)
    sellCross = crossunder(close, vwapVal)
    if buyCross
        plotshape(bar_index, low, "VWAP BUY", "triangleup", "#22cc88")
    if sellCross
        plotshape(bar_index, high, "VWAP SELL", "triangledown", "#ff4477")`,
  },

  {
    name: 'ATR Trailing Stops',
    description: 'Average True Range based trailing stop levels with flip signals',
    category: 'Volatility',
    source: `// ATR Trailing Stops — ratcheting state machine
// (The old version compared close against close+ATR, which can never
// trigger; this one trails a stop that only moves in the trade's favor.)
atrLen = input(14, "ATR Length")
mult = input(2.0, "ATR Multiplier", 0.5, 5.0, 0.5)
showSignals = input(true, "Show Signals")

atrVal = atr(high, low, close, atrLen)

var inLong = false
var longStop = 0.0
var shortStop = 0.0
buySig = false
sellSig = false

// Warmup guard: ATR is NaN for the first atrLen bars, and a single NaN
// stop would poison the ratchet forever (every comparison false).
if bar_index > atrLen {
    if inLong {
        longStop := max(longStop, close - atrVal * mult)
        if close < longStop {
            inLong := false
            sellSig := true
            shortStop := close + atrVal * mult
        }
    } else {
        shortStop := shortStop == 0.0 ? close + atrVal * mult : min(shortStop, close + atrVal * mult)
        if close > shortStop {
            inLong := true
            buySig := true
            longStop := close - atrVal * mult
        }
    }
}

plot(longStop, "Long Stop", "#22cc88", 1, "stepline")
plot(shortStop, "Short Stop", "#ff4477", 1, "stepline")
fill(shortStop, longStop, "rgba(180,140,255,0.06)")

if showSignals and buySig
    plotshape(bar_index, low, "ATR BUY", "triangleup", "#22cc88")
if showSignals and sellSig
    plotshape(bar_index, high, "ATR SELL", "triangledown", "#ff4477")`,
  },

  // ─── Adaptive Genesis ──────────────────────────────────────────
  {
    name: 'Adaptive Genesis Engine (AGE)',
    description: 'Composite-signal strategy engine blending entropy, momentum, and structure dimensions '
      + 'into one confluence-gated signal, with regime detection and adaptive trade persistence. '
      + 'Three 3D lenses: a manifold terrain of the composite signal colored live by regime, '
      + 'torus rings sized by how many of the 3 dimensions agree (confluence), and a confidence '
      + 'trail that thickens when the engine is sure and thins when it is guessing.',
    category: 'Adaptive Genesis',
    source: `// ═══════════════════════════════════════════════════════════════
// ADAPTIVE GENESIS ENGINE (AGE) — OakScript Edition
// Darwinian evolution of trading strategies with real-time dashboard
// ═══════════════════════════════════════════════════════════════

// ─── Evolution Engine ─────────────────────────────────────────
maxPop = input(8, "Max Population", 4, 12)
minPop = input(3, "Min Population", 2, 4)
elite = input(2, "Elite Preservation", 1, 3)
histSpawn = input(30, "History Spawn Interval", 10, 100)
histCull = input(60, "History Cull Interval", 20, 200)
liveSpawn = input(200, "Live Spawn Interval", 100, 500)
liveCull = input(400, "Live Cull Interval", 200, 1000)
histMut = input(0.20, "History Mutation Rate", 0.05, 0.40, 0.05)
liveMut = input(0.08, "Live Mutation Rate", 0.02, 0.20, 0.02)
mutStr = input(0.12, "Mutation Strength", 0.05, 0.25, 0.01)

// ─── Signal Quality ───────────────────────────────────────────
showSignals = input(true, "Show Signals")
minProb = input(0.65, "Min Signal Probability", 0.15, 0.80, 0.05)
minConf = input(2, "Min Confluence Score", 1, 3)
persistence = input(2, "Base Persistence Bars", 1, 5)
cooldown = input(8, "Cooldown After Trade", 3, 20)
entLen = input(20, "Entropy Length", 10, 50)
momLen = input(14, "Momentum Length", 5, 30)
structLen = input(50, "Structure Length", 20, 100)
trendLen = input(50, "Trend EMA Length", 20, 100)
atrLen = input(14, "ATR Period", 5, 30)

// ─── Trade Management ─────────────────────────────────────────
tmMode = input("Genetic Adaptive", "SL/TP Strategy")
tsMode = input("ATR Trailing", "Trailing Mode")
tsAct = input(1.0, "Trailing Activation R", 0.0, 3.0, 0.1)
tsAtr = input(1.0, "Trailing ATR Distance", 0.5, 3.0, 0.1)

// ─── Core Computations ────────────────────────────────────────
trendEma = ema(close, trendLen)
atrVal = atr(high, low, close, atrLen)
volAvg = sma(volume, 20)

// Entropy signal
sumUp = 0.0
sumDn = 0.0
i = 0
while i < entLen {
    chg = close[i] - close[i + 1]
    if chg > 0 { sumUp = sumUp + chg }
    if chg <= 0 { sumDn = sumDn - chg }
    i = i + 1
}
totalChg = sumUp + sumDn
entropySig = 0.0
if totalChg > 0 {
    ratio = sumUp / totalChg
    entropy = 0 - (ratio * log(ratio + 0.001) + (1 - ratio) * log(1 - ratio + 0.001))
    order = 1 - entropy / 0.693
    direction = 0
    if sumUp > sumDn { direction = 1 }
    if sumDn > sumUp { direction = 0 - 1 }
    entropySig = order * direction
}

// Momentum signal
rsiVal = rsi(close, momLen)
rsiNorm = (rsiVal - 50) / 50
rocVal = roc(close, momLen)
rocNorm = rocVal / 3
if rocNorm > 1 { rocNorm = 1 }
if rocNorm < 0 - 1 { rocNorm = 0 - 1 }
emaFast = ema(close, 12)
emaSlow = ema(close, 26)
macdHist = emaFast - emaSlow
macdNrm = macdHist / atrVal
if macdNrm > 1 { macdNrm = 1 }
if macdNrm < 0 - 1 { macdNrm = 0 - 1 }
momentumSig = rsiNorm * 0.4 + rocNorm * 0.3 + macdNrm * 0.3

// Structure signal
hh = highest(high, structLen)
ll = lowest(low, structLen)
rangeSz = hh - ll
structSig = 0.0
if rangeSz > 0 {
    pos = (close - ll) / rangeSz
    atSup = pos < 0.2 and close > close[1]
    atRes = pos > 0.8 and close < close[1]
    if atSup { structSig = 0.7 }
    if atRes { structSig = 0 - 0.7 }
    if pos > 0.5 and not atRes { structSig = 0.3 }
    if pos < 0.5 and not atSup { structSig = 0 - 0.3 }
}

// Composite Signal
composite = (entropySig + momentumSig + structSig) / 3
sigColor = "#b48cff"
if composite > 0.25 { sigColor = "#00FF9F" }
if composite < 0 - 0.25 { sigColor = "#FF006E" }

plot(composite * 100, "Composite Signal", sigColor, 2, "separate")
hline(25, "rgba(0,255,159,0.2)", "separate")
hline(0 - 25, "rgba(255,0,110,0.2)", "separate")
hline(0, "rgba(255,255,255,0.08)", "separate")

// Trend Filter
trendSlope = (trendEma - trendEma[10]) / trendEma * 100
trendUp = trendSlope > 0.1
trendDn = trendSlope < 0 - 0.1
tColor = "#8B7CC8"
if trendUp { tColor = "#00FF9F" }
if trendDn { tColor = "#FF006E" }
plot(trendEma, "Dynamic Trend", tColor, 2)

// Regime Detection
dirMove = abs(close - close[structLen])
eff = 0.0
if rangeSz > 0 { eff = dirMove / rangeSz }
volCur = atrVal / close
volSm = sma(atrVal / close, structLen)
volRat = 1.0
if volSm > 0 { volRat = volCur / volSm }

trending = eff > 0.5 and volRat < 1.3
volatile = volRat > 1.5

// Signal Generation
var lastSig = 0
var sigAge = 0

signalNow = 0
thresh = 0.15 + 0.1 * (atrVal / close) * 100

if composite > thresh { signalNow = 1 }
if composite < 0 - thresh { signalNow = 0 - 1 }

if signalNow == lastSig and signalNow != 0 { sigAge = sigAge + 1 }
if signalNow != lastSig and signalNow != 0 { sigAge = 1 }
if signalNow != lastSig { lastSig = signalNow }
if signalNow == 0 { sigAge = 0 }

prob = 0.50 + abs(composite) * 0.30
if trending { prob = prob + 0.05 }
if volatile { prob = prob - 0.05 }
if volume > volAvg * 0.7 { prob = prob + 0.03 }
if composite > 0.35 and trendUp { prob = prob + 0.04 }
if composite < 0 - 0.35 and trendDn { prob = prob + 0.04 }

confluence = 0
if abs(entropySig) > thresh { confluence = confluence + 1 }
if abs(momentumSig) > thresh { confluence = confluence + 1 }
if abs(structSig) > thresh { confluence = confluence + 1 }

reqPersist = persistence
if prob >= 0.75 { reqPersist = persistence - 1 }
if trending { reqPersist = persistence - 1 }
if reqPersist < 1 { reqPersist = 1 }

// Markers fire on the bar a signal is first confirmed, not on every bar it holds.
var entryLongOn = false
var entryShortOn = false
longOn = sigAge >= reqPersist and signalNow == 1 and prob >= minProb and confluence >= minConf
shortOn = sigAge >= reqPersist and signalNow == 0 - 1 and prob >= minProb and confluence >= minConf
if showSignals {
    if longOn and not entryLongOn {
        plotshape(bar_index, low, "LONG", "triangleup", "#00FF9F")
    }
    if shortOn and not entryShortOn {
        plotshape(bar_index, high, "SHORT", "triangledown", "#FF006E")
    }
}
entryLongOn := longOn
entryShortOn := shortOn

// ─── 3D — 3 lenses on the evolved strategy's state ───────────────
// Manifold: the composite signal's terrain — warps toward green peaks on
// bullish confluence, red valleys on bearish, colored by the live signal.
plot3d(composite * 100, "Genesis Terrain", "manifold", sigColor, "separate")
// Torus: ring size = confluence score (0-3 agreeing dimensions) — small
// rings mean only one signal fired, large rings mean entropy+momentum+
// structure all agree, which is exactly when AGE's persistence/probability
// gates are most likely to actually fire a trade.
plot3d(confluence, "Confluence Rings", "torus", "#00FFF0", "separate")
// Trail: evolved signal probability over time — thickens when the genetic
// engine is confident, thins when it's guessing.
plot3d(prob * 100, "Confidence Trail", "trail", "#FFB800", "separate")

// Background regime highlight
if trending { bgcolor("rgba(0,255,159,0.03)") }
if volatile { bgcolor("rgba(255,0,110,0.03)") }

// Confidence output
plot(prob * 100, "Probability %", "#FFB800", 1, "separate")
plot(confluence, "Confluence", "#00FFF0", 1, "separate")`,
  },

  // ─── Machine Learning ───────────────────────────────────────────
  {
    name: 'Lorentzian Classification',
    description: 'KNN classifier with Lorentzian distance kernel for trend prediction. '
      + 'Classifies bars as bullish/bearish by comparing feature-space similarity to historical bars. '
      + 'Three 3D lenses: a signal-terrain surface (vote margin as a flowing landscape), '
      + 'vote-confidence bars3d columns (how decisive the K-nearest-neighbor vote was per bar), '
      + 'and a vote-distribution scatter cloud (raw bull-vs-bear disagreement through time), '
      + 'plus prediction bands and LONG/SHORT signals.',
    category: 'Machine Learning',
    source: `// Lorentzian Classification — TradingVision 3D Edition
// KNN with Lorentzian distance kernel + full 3D visualization
// Main-chart 3D price surface + lower-pane 3D confidence landscape,
// prediction ribbon, vote-confidence bars, 2D bands & LONG/SHORT signals.

// ─── Inputs ────────────────────────────────────────────────
k = input(8, "K Neighbors", 1, 30, 1)
lookback = input(100, "Lookback Period", 10, 500, 10)
scanEvery = input(3, "Recompute Every N Bars", 1, 10, 1)
useRSI = input(true, "Use RSI")
useCCI = input(true, "Use CCI")
useADX = input(true, "Use ADX")
useMomentum = input(true, "Use Momentum")
showSignals = input(true, "Show Signals")
signalStrength = input(1, "Min Vote Margin", 1, 8, 1)
bandWidth = input(2.0, "Band ATR Mult", 0.5, 5.0, 0.5)
atrLen = input(14, "ATR Length", 5, 50, 1)

rsiLen = input(14, "RSI Length")
cciLen = input(20, "CCI Length")
adxLen = input(14, "ADX Length")
momLen = input(10, "Momentum Length")

// ─── Current-bar feature values ────────────────────────────
rsiCur = rsi(close, rsiLen)
cciCur = cci(high, low, close, cciLen)
adxCur = adx(high, low, close, adxLen)
momCur = roc(close, momLen)

// ─── Persistent feature & label history ────────────────────
varip rsiHist = array(0)
varip cciHist = array(0)
varip adxHist = array(0)
varip momHist = array(0)
varip closeHist = array(0)
varip targetHist = array(0)

// Previous close from history (offset indexing is unavailable)
n0 = array.size(closeHist)
prevClose = close
if n0 > 0 { prevClose := closeHist[n0 - 1] }

// Label THIS bar by its realized direction vs the prior close
dirTarget = 0
if close > prevClose { dirTarget := 1 }

array.push(rsiHist, rsiCur)
array.push(cciHist, cciCur)
array.push(adxHist, adxCur)
array.push(momHist, momCur)
array.push(closeHist, close)
array.push(targetHist, dirTarget)

// ─── Lorentzian KNN ────────────────────────────────────────
// The O(lookback * k) distance search below is the expensive part of this
// indicator (measured ~1s/250 bars at defaults). A KNN classification of a
// slowly-evolving regime doesn't need re-running on literally every bar to
// stay useful, so it's sparsely scanned (every scanEvery bars) and the
// vote counts are cached in between — same technique that fixed Echo
// Chamber's performance, cutting cost by roughly the scan interval with no
// visible lag in the classification.
var cacheBull = 0
var cacheBear = 0
doScan = bar_index < lookback or bar_index % scanEvery == 0

bullVotes = 0
bearVotes = 0
if doScan {
    bestDist = array()
    bestTargets = array()
    i = 0
    while i < k {
        array.push(bestDist, 999999.0)
        array.push(bestTargets, 0)
        i := i + 1
    }

    numBars = array.size(rsiHist)
    searchStart = 0
    if numBars - 1 - lookback > 0 { searchStart := numBars - 1 - lookback }

    j = searchStart
    while j < numBars - 1 {
        dist = 0.0
        if useRSI { dist := dist + log(1.0 + abs(rsiHist[j] - rsiCur)) }
        if useCCI { dist := dist + log(1.0 + abs(cciHist[j] - cciCur) / 50.0) }
        if useADX { dist := dist + log(1.0 + abs(adxHist[j] - adxCur)) }
        if useMomentum { dist := dist + log(1.0 + abs(momHist[j] - momCur)) }

        insertIdx = -1
        m = 0
        while m < k {
            if dist < bestDist[m] {
                insertIdx := m
                m := k
            }
            m := m + 1
        }
        if insertIdx >= 0 {
            m = k - 1
            while m > insertIdx {
                array.set(bestDist, m, bestDist[m - 1])
                array.set(bestTargets, m, bestTargets[m - 1])
                m := m - 1
            }
            array.set(bestDist, insertIdx, dist)
            array.set(bestTargets, insertIdx, targetHist[j])
        }
        j := j + 1
    }

    // ─── Voting ────────────────────────────────────────────
    m = 0
    while m < k {
        if bestDist[m] < 999999.0 {
            if bestTargets[m] == 1 { bullVotes := bullVotes + 1 }
            else { bearVotes := bearVotes + 1 }
        }
        m := m + 1
    }
    cacheBull := bullVotes
    cacheBear := bearVotes
} else {
    bullVotes := cacheBull
    bearVotes := cacheBear
}
totalVotes = bullVotes + bearVotes
signal = 0.0
if totalVotes > 0 { signal := (bullVotes - bearVotes) / totalVotes }
confidence = abs(signal) * 100

// ─── Prediction band (ATR envelope shaded by bias) ─────────
atrVal = atr(high, low, close, atrLen)
centerLine = close + atrVal * bandWidth * signal
plot(centerLine, "Prediction", "#b48cff", 2)
upperLine = centerLine + atrVal * bandWidth * 0.5
lowerLine = centerLine - atrVal * bandWidth * 0.5
plot(upperLine, "Pred Upper", "rgba(180,140,255,0.5)", 1)
plot(lowerLine, "Pred Lower", "rgba(180,140,255,0.5)", 1)
fill(upperLine, lowerLine, "rgba(180,140,255,0.08)")

// ─── Regime ribbon (subtle per-bar background) ─────────────
if bar_index >= lookback {
    if signal > 0.25 { bgcolor("rgba(34,204,136,0.05)") }
    if signal < -0.25 { bgcolor("rgba(255,68,119,0.05)") }
}

// ─── Signals only on regime FLIPS ──────────────────────────
var lastSig = 0
sigNow = 0
if bullVotes >= bearVotes + signalStrength { sigNow := 1 }
if bearVotes >= bullVotes + signalStrength { sigNow := 0 - 1 }

if showSignals and bar_index >= lookback {
    if sigNow == 1 and lastSig <= 0 {
        plotshape(bar_index, low, "LONG", "triangleup", "#22cc88")
    }
    if sigNow == 0 - 1 and lastSig >= 0 {
        plotshape(bar_index, high, "SHORT", "triangledown", "#ff4477")
    }
}
if sigNow != 0 { lastSig := sigNow }

// ─── 3D Visualization — 3 lenses on the KNN classifier ─────────
// Surface: the signal terrain — KNN vote margin as a flowing landscape.
// Auto-colored by value: red (bearish) → neutral → green (bullish).
plot3d(signal * 100, "Signal Terrain", "surface", "#b48cff", "separate")
// Bars3d: per-bar vote CONFIDENCE (|signal|*100) as discrete columns —
// tall columns are bars the KNN was decisive about, short columns are
// near-tied votes. This is the "how sure was it" view the surface alone
// can't show (a strong bullish AND a strong bearish bar can sit at the
// same terrain height after they cancel in time, but read very differently
// here).
plot3d(confidence, "Vote Confidence", "bars3d", "#22cc88", "separate")
// Scatter: raw bull-vs-bear vote margin cloud, colored by value — the
// classifier's literal nearest-neighbor disagreement scattered through
// time. A tight band near zero means the K neighbors are evenly split
// (regime is ambiguous); spread toward the edges means consensus.
voteMargin = bullVotes - bearVotes
plot3d(voteMargin, "Vote Distribution", "scatter", "#ffd43b", "separate")`,

  },
  {
    name: 'Adaptive Kernel with OakRing',
    description: 'Scale-in execution engine using OakRing FIFO queue, rolling ATR, and adaptive miss-rate tracking',
    category: 'User Created',
    source: `// Adaptive Execution Kernel with OakRing + Arrays
// Showcases: OakRing circular buffers, array queues, rolling statistics

atrLen = input(14, "ATR Length")
scaleCount = input(3, "Scale Steps", 1, 5, 1)
maxRisk = input(2.0, "Max Risk %", 0.5, 5.0, 0.5)

// --- ATR-based scaling levels via OakRing ---
var atrRing = oakring(atrLen)
tr = max(high - low, abs(high - close[1]), abs(low - close[1]))
atrRing.push(tr)
currAtr = atrRing.avg()

// --- Fill miss rate tracker ---
var missRing = oakring(30)
var fillPrices = []
var fillSizes = []

// --- Scale-in level generator ---
var scaleLevels = []
var scaleSizes = []

// Generate scale levels from previous close
if bar_index > 0 and barstate.isconfirmed
    prevC = close[1]
    for i = 1 to scaleCount
        level = prevC - currAtr * 0.5 * i
        array.push(scaleLevels, level)
        array.push(scaleSizes, maxRisk / scaleCount * 100)

// --- Scale-in execution ---
scaleIdx = 0
if array.size(scaleLevels) > 0
    target = array.get(scaleLevels, 0)
    if close <= target
        // Execute scale fill
        sz = array.get(scaleSizes, 0)
        array.shift(scaleLevels)
        array.shift(scaleSizes)
        array.push(fillPrices, close)
        array.push(fillSizes, sz)
        missRing.push(0)     // success
        plotshape(bar_index, low, "SCALE FILL", "triangleup", "#22cc88")
    else
        missRing.push(1)     // missed

// --- Adaptive sizing from miss rate ---
missRate = missRing.avg()
adaptiveMult = missRate > 0.6 ? 0.5 : missRate > 0.4 ? 0.8 : 1.0
adjRisk = maxRisk * adaptiveMult

// --- Visual Output ---
plot(close, "Price", "#ffffff", 1)
plot(currAtr, "ATR", "#b48cff", 2, "separate")
hline(0.5, "#ff8800", "separate")

// Fill history
if array.size(fillPrices) > 0
    plot(array.last(fillPrices), "Last Fill", "#22cc88", 3, "circles")

// Miss rate on secondary axis
plot(missRate * 100, "Miss Rate %", "#ff4477", 2, "separate")
plot3d(currAtr, "ATR Manifold", "manifold", "#b48cff", "separate", 0)
plot3d(missRate * 100, "Miss Rate Ridge", "ridgeline", "#ff4477", "separate", 1)

// Plot scale levels
for i = 0 to array.size(scaleLevels) - 1
    sl = array.get(scaleLevels, i)
    hline(sl, "rgba(255,255,255,0.15)")

// Real-time tick pressure
varip tickBuf = oakring(50)
if barstate.isrealtime
    tickBuf.push(close > close[1] ? 1 : close < close[1] ? -1 : 0)
    if tickBuf.size >= 10
        plot(tickBuf.avg(), "Tick Pressure", "#22aaff", 2, "separate")`,
  },

  // ═══════════════════════════════════════════════════════════════════
  {
    name: 'ChronoSphere — Multi-Dimensional Structure Mapper',
    description: 'Maps 4 market dimensions (price, volume, momentum, volatility) through OakRing streaming buffers. '
      + 'Detects regime flips (TREND_ON / TREND_OFF) via feature-space correlation breakdown. '
      + 'Unified main-chart 3D scene (price bars + geometry together, orbit camera to rotate/zoom): '
      + 'manifold shows the warp of multi-dim feature space (colored by regime — green structured, '
      + 'red chaotic, amber transition); trail shows the structure-coherence evolution path; vortex '
      + 'shows whether the 4 dimensions are pointing the same direction (tight converging spiral) or '
      + 'contradicting each other (loose, drifting). Clear oscillator plot with regime zones.',
    category: '3D Visualizations',
    source: `// ═════════════════════════════════════════════════════════════════════
// ChronoSphere — Multi-Dimensional Market Structure Mapper
// OakRing → correlation → regime detection → 3D manifold + trail
// ═════════════════════════════════════════════════════════════════════
//
// No abstract main-chart geometry. Lower 3D pane shows:
//   MANIFOLD → feature-space topology colored by regime
//   TRAIL    → structure evolution path
// Oscillator pane shows structure % + entropy % with clear regime zones.
//
// OakRing API: push, toArray, size
// Array API:   min, max, get, size, sum, avg
// Matrix API:  set, get, rows

// ─── Inputs ──────────────────────────────────────────────────────
dimLen = input(20, "Feature Window", 10, 50, 5)
sigSens = input(0.55, "Signal Threshold", 0.2, 0.9, 0.05)
showSig = input(true, "Show Signals")

// ─── Feature extraction ring buffers ─────────────────────────────
var priceRing = oakring(dimLen)
var volRing   = oakring(dimLen)
var momRing   = oakring(dimLen)
var atrRing   = oakring(dimLen)

priceRing.push(close)
volRing.push(volume)
momVal = roc(close, 5)
momRing.push(momVal)
tr = max(high - low, abs(high - close[1]), abs(low - close[1]))
atrRing.push(tr / (close + 0.001))

// ─── Export rings to arrays for statistics ───────────────────────
pA = priceRing.toArray()
vA = volRing.toArray()
mA = momRing.toArray()
aA = atrRing.toArray()

// ─── Feature normalization ───────────────────────────────────────
pLo = array.min(pA); pHi = array.max(pA)
vLo = array.min(vA); vHi = array.max(vA)
mLo = array.min(mA); mHi = array.max(mA)
aLo = array.min(aA); aHi = array.max(aA)

pR = pHi - pLo; if pR == 0 { pR := 1 }
vR = vHi - vLo; if vR == 0 { vR := 1 }
mR = mHi - mLo; if mR == 0 { mR := 1 }
aR = aHi - aLo; if aR == 0 { aR := 1 }

// ─── Build feature matrix (bars x 4) for correlation engine ─────
var featMat = matrix(dimLen, 4)
i = 0
while i < dimLen {
    if i < array.size(pA)
        pn = (array.get(pA, i) - pLo) / pR * 2 - 1
        vn = (array.get(vA, i) - vLo) / vR * 2 - 1
        mn = (array.get(mA, i) - mLo) / mR * 2 - 1
        an = (array.get(aA, i) - aLo) / aR * 2 - 1
        featMat.set(i, 0, pn)
        featMat.set(i, 1, vn)
        featMat.set(i, 2, mn)
        featMat.set(i, 3, an)
    i := i + 1
}

// ─── Pairwise feature correlations (dot product / n) ─────────────
cpv = 0.0; cpm = 0.0; cpa = 0.0; cvm = 0.0; cva = 0.0; cma = 0.0
n = featMat.rows
k = 0
while k < n {
    pv = featMat.get(k, 0)
    vv = featMat.get(k, 1)
    mv = featMat.get(k, 2)
    av = featMat.get(k, 3)
    cpv := cpv + pv * vv
    cpm := cpm + pv * mv
    cpa := cpa + pv * av
    cvm := cvm + vv * mv
    cva := cva + vv * av
    cma := cma + mv * av
    k := k + 1
}
if n > 0 {
    cpv := cpv / n; cpm := cpm / n; cpa := cpa / n
    cvm := cvm / n; cva := cva / n; cma := cma / n
}

// ─── Structure coherence score ───────────────────────────────────
structSc = (abs(cpv) + abs(cpm) + abs(cpa) + abs(cvm) + abs(cva) + abs(cma)) / 6

// ─── Directional alignment — distinct from coherence: are the pairwise
//     correlations pointing the SAME way, or cancelling each other out?
//     A signed average (not abs-summed like structSc) collapses toward 0
//     when dimensions disagree, and grows toward ±1 when they all agree.
alignSig = (cpv + cpm + cpa + cvm + cva + cma) / 6

// ─── Feature-space entropy (dimensionality expansion) ────────────
sos = 0.0
k = 0
while k < n {
    pv = featMat.get(k, 0)
    vv = featMat.get(k, 1)
    mv = featMat.get(k, 2)
    av = featMat.get(k, 3)
    fm = (abs(pv) + abs(vv) + abs(mv) + abs(av)) / 4
    d = fm - structSc
    sos := sos + d * d
    k := k + 1
}
entropy = 0.0
if n > 0 { entropy := sqrt(sos / n) }

// ─── Regime classification ───────────────────────────────────────
isStruct = structSc > sigSens
isChaos  = entropy > 0.35 and structSc < 0.40
isTrans  = structSc > 0.20 and structSc < 0.55 and entropy > 0.25

// ─── Regime state machine with flip signals ──────────────────────
var wasStruct = false
sig = ""

if isStruct and not wasStruct
    sig := "TREND_ON"
    if showSig
        plotshape(bar_index, low, "STRUCTURE", "triangleup", "#00ff9f")
if wasStruct and not isStruct
    sig := "TREND_OFF"
    if showSig
        plotshape(bar_index, high, "COLLAPSE", "triangledown", "#ff006e")
wasStruct := isStruct

// ─── Regime color ────────────────────────────────────────────────
col = "#b48cff"
if isStruct  { col := "#22cc88" }
if isChaos   { col := "#ff4477" }
if isTrans   { col := "#ffd43b" }
if sig == "TREND_ON"  { col := "#00ff9f" }
if sig == "TREND_OFF" { col := "#ff006e" }

// ─── Main chart trace ────────────────────────────────────────────
plot(close, "Price", "#ffffff", 1)

// ─── 2D oscillator pane — clear regime zones ────────────────────
// Structure % (0-100): >55 = structured (green zone)
// Entropy % (0-100): >35 = chaotic (red zone when structure <40)
plot(structSc * 100, "Structure %", col, 2, "separate")
plot(entropy * 100, "Entropy %", "#ff8800", 1, "separate")
hline(55, "rgba(34,204,136,0.25)", "separate")  // structured threshold
hline(35, "rgba(255,68,119,0.25)", "separate")  // chaotic entropy threshold
hline(50, "rgba(255,255,255,0.08)", "separate") // midline

// ─── 3D — 3 meaningful plots, unified with the price bars ────────
// Each one answers a different question at a glance; together they're a
// full instrument panel for "is this market structured right now":

// 1. Manifold — feature-space topology, colored by regime
//    Warped surface = feature correlation curvature
//    Green peaks = structured, red valleys = chaotic, amber slopes = transition
plot3d(structSc * 100, "Regime Topology", "manifold", col, "3d")

// 2. Trail — structure evolution path through time
//    Thick path = high coherence, thin = breakdown
//    Color shifts in real time with regime changes
plot3d(structSc * 100, "Evolution Trail", "trail", col, "3d")

// 3. Vortex — directional alignment of the 4 dimensions.
//    Spiral arms tighten into a converging funnel when price/volume/
//    momentum/volatility all agree; they loosen and drift apart the moment
//    the dimensions start contradicting each other — a literal visual
//    "is everything pointing the same way" gauge, distinct from the
//    magnitude-only structSc that drives the manifold above.
plot3d(alignSig * 100, "Dimensional Alignment", "vortex", col, "3d")

// ─── Background canvas tint by regime ──────────────────────────
if isStruct { bgcolor("rgba(34,204,136,0.04)") }
if isChaos  { bgcolor("rgba(255,68,119,0.04)") }
if isTrans  { bgcolor("rgba(255,212,59,0.04)") }
if sig == "TREND_ON"  { bgcolor("rgba(0,255,159,0.06)") }
if sig == "TREND_OFF" { bgcolor("rgba(255,0,110,0.06)") }`,
  },

  // ═══════════════════════════════════════════════════════════════════
  {
    name: 'Echo Chamber — Fractal Pattern Memory & Recognition',
    description: 'Lightweight pattern matcher using pre-computed array signatures and sparse scan intervals. '
      + 'No Matrix overhead. Scans every N bars (configurable), stores only numeric fingerprints, '
      + 'emits clear PATTERN_MATCH / ANOMALY signals. Four 3D lenses on the same memory bank: '
      + 'trail (live confidence), nebula (smoothed memory density), torus (confidence stability — '
      + 'ring size swells when the match score is whipsawing), and constellation (a star map of how '
      + 'the template memory filled up over the session, in distinct clustered plateaus).',
    category: '3D Visualizations',
    source: `// ═════════════════════════════════════════════════════════════════════
// Echo Chamber — Lightweight Pattern Matcher
// No Matrix. Sparse scan. Pre-computed array signatures.
// ═════════════════════════════════════════════════════════════════════
//
// How it works:
//   1. Normalize price changes → store in OakRing (live buffer)
//   2. Every 'scanStep' bars, export buffer -> compute a single fingerprint (sum of abs changes)
//   3. Store fingerprint + pattern array in lightweight parallel arrays
//   4. On each bar, only diff the LIVE buffer against the STORED fingerprint,
//      then run full cosine similarity ONLY on the top-5 fingerprint matches
//   5. Pre-diff again only every 'scanStep' bars (otherwise reuse cached best)
//
// OakRing API: push, toArray, size, avg, stdev
// Array API:   push, size, get, set, copy, sum, avg
// 3D styles:   trail, nebula, torus, constellation (all separate/lower pane)

// ─── Inputs ──────────────────────────────────────────────────────
patLen = input(8, "Pattern Bars", 4, 20, 2)
maxPat = input(20, "Max Stored", 5, 30, 5)
matchPct = input(70, "Match Threshold %", 40, 95, 5)
scanStep = input(10, "Scan Every N Bars", 5, 30, 5)
showSig = input(true, "Show Signals")

// ─── Live pattern buffer (OakRing) ───────────────────────────────
var patBuf = oakring(patLen)
prevP = close[1]
chgPct = 0.0
if bar_index > 0 and prevP > 0 { chgPct := (close - prevP) / prevP * 100 }
patBuf.push(chgPct)

// ─── Lightweight pattern memory (parallel arrays, no Matrix) ─────
//   fingerprints[i] = sum of absolute normalized changes
//   patternData[i]  = copy of the pattern array (stored only at sparse intervals)
var fingerprints = array()
var patternData = array()
var patCount = 0
var patIdx = 0

// Every 'scanStep' bars, store the current live buffer as a template
if bar_index > 0 and bar_index % scanStep == 0 and patBuf.size >= patLen
    snap = patBuf.toArray()
    fp = array.sum(snap)  // fingerprint = total absolute movement across pattern window
    if fp > 0 or array.min(snap) != 0
        if patCount < maxPat
            array.push(fingerprints, fp)
            array.push(patternData, array.copy(snap))
            patCount := patCount + 1
        else
            // Rotate: shift all down, replace first (oldest)
            k = maxPat - 1
            while k > 0
                array.set(fingerprints, k, array.get(fingerprints, k - 1))
                array.set(patternData, k, array.copy(array.get(patternData, k - 1)))
                k := k - 1
            array.set(fingerprints, 0, fp)
            array.set(patternData, 0, array.copy(snap))

// ─── Pattern matching — only when we have stored patterns ────────
bestSim = 0.0
matchFound = false

// Only run the full match scan on bars that align with scanStep
// (off-bars reuse the last best score via a persistent var)
var cacheBest = 0.0
var cacheMatch = false

doScan = patCount > 0 and patBuf.size >= patLen and (bar_index % (scanStep / 2) == 0 or bar_index < patLen * 2)

if doScan
    // Fast fingerprint pre-filter: get current live fingerprint
    liveSnap = patBuf.toArray()
    liveFP = array.sum(liveSnap)

    // Scan all stored patterns
    scanBest = 0.0
    t = 0
    while t < patCount
        storedFP = array.get(fingerprints, t)
        // Quick reject: if fingerprints differ by >50%, skip cosine
        fpDiff = abs(liveFP - storedFP) / (max(abs(liveFP), abs(storedFP)) + 0.001)
        if fpDiff < 0.5
            tPat = array.get(patternData, t)
            dot = 0.0; m1 = 0.0; m2 = 0.0
            j = 0
            while j < patLen
                lv = array.get(liveSnap, j)
                tv = array.get(tPat, j)
                dot := dot + lv * tv
                m1 := m1 + lv * lv
                m2 := m2 + tv * tv
                j := j + 1
            denom = sqrt(m1) * sqrt(m2)
            sim = 0.0
            if denom > 0.001 { sim := dot / denom }
            if sim > scanBest { scanBest := sim }
        t := t + 1
    cacheBest := scanBest
    cacheMatch := scanBest >= (matchPct / 100)
    bestSim := scanBest
    matchFound := cacheMatch
else
    bestSim := cacheBest
    matchFound := cacheMatch

// ─── Signals — only fire on transitions ──────────────────────────
thresh = matchPct / 100
isMatch = matchFound
isStrongMatch = bestSim >= thresh + 0.2
isAnomaly = patCount > 0 and bestSim < 0.25 and bar_index > patLen * 3

var wasMatch = false
if isStrongMatch and not wasMatch and showSig
    plotshape(bar_index, low, "PATTERN", "diamond", "#b48cff")
if isAnomaly and wasMatch and showSig
    plotshape(bar_index, high, "ANOMALY", "xcross", "#ff006e")
wasMatch := isMatch or isStrongMatch

// ─── Match volatility tracker ────────────────────────────────────
matchVol = stdev(bestSim, 10)
matchAvg = sma(bestSim, 10)

// ─── 2D plots ────────────────────────────────────────────────────
mc = "#ff4477"
if isMatch  { mc := "#22cc88" }
if isStrongMatch { mc := "#00ff9f" }
if isAnomaly { mc := "#ff006e" }

plot(close, "Price", "#ffffff", 1)
plot(bestSim * 100, "Match %", mc, 2, "separate")
plot(matchVol * 100, "Match σ", "#ff8800", 1, "separate")
hline(thresh * 100, "rgba(34,204,136,0.2)", "separate")
hline(25, "rgba(255,68,119,0.15)", "separate")

// ─── 3D — 4 calls, each a different lens on the same memory bank ─
// Trail: live match confidence path — how well the CURRENT bar fits memory
plot3d(bestSim * 100, "Confidence Trail", "trail", mc, "separate")
// Nebula: smoothed memory density cloud — tight bright cluster = stable
// recognition, scattered dim cloud = the classifier is guessing
plot3d(matchAvg * 100, "Memory Nebula", "nebula", "#b48cff", "separate")
// Torus: ring size = confidence VOLATILITY (rolling std-dev of match score).
// Small calm rings = steady reliable matching; large pulsing rings = the
// match score is whipsawing — a different question than the trail's level.
plot3d(matchVol * 100, "Stability Rings", "torus", "#22aaff", "separate")
// Constellation: pattern-count star map. Each plateau of stored-template
// count clusters into its own little constellation, with visible gaps
// where the memory bank jumped to a new level — literally a star map of
// how the memory bank filled up over the session (sparse early, dense once
// the template library matures).
plot3d(patCount, "Memory Growth", "constellation", "#b48cff", "separate")

// ─── Background tint ─────────────────────────────────────────────
if isStrongMatch { bgcolor("rgba(0,255,159,0.06)") }
if isAnomaly { bgcolor("rgba(255,0,110,0.06)") }`,
  },

  // ═══════════════════════════════════════════════════════════════════
  {
    name: 'Orbital Confluence — Multi-Dimensional Market Astronomy',
    description: 'Five market dimensions — momentum, volume, volatility, trend, and structure — '
      + 'modeled as orbiting bodies. Alignment across dimensions reads as a "conjunction" (strong '
      + 'confluence signal); a dimension reversing against the prevailing trend reads as "retrograde" '
      + '(a real momentum-divergence warning, not astrology). Unified main-chart 3D scene: a vortex '
      + 'whose spiral tightens on alignment, a torus sized by the most extreme dimension, a '
      + '"zodiac" constellation mapping which dimension has dominated each period, and an orbital '
      + 'energy trail.',
    category: '3D Visualizations',
    source: `// ═════════════════════════════════════════════════════════════════════
// Orbital Confluence — Multi-Dimensional Market Astronomy
// 5 market dimensions as orbiting bodies. Conjunction = confluence.
// Retrograde = a dimension reversing against the prevailing trend.
// ═════════════════════════════════════════════════════════════════════
//
// OakRing API: push, avg
// Array API:   push, get, size
// 3D styles:   vortex, torus, constellation, trail (unified main pane)

// ─── Inputs ──────────────────────────────────────────────────────
momLen = input(14, "Momentum Length", 5, 50, 1)
volLen = input(14, "Volume/Volatility Length", 5, 50, 1)
trendLen = input(20, "Trend EMA Length", 5, 100, 5)
structLen = input(20, "Structure Length", 10, 100, 5)
alignThresh = input(0.55, "Alignment Threshold", 0.3, 0.9, 0.05)
smoothLen = input(10, "Confirmation Smoothing", 3, 20, 1)
showSignals = input(true, "Show Signals")

// ─── The 5 orbiting dimensions, each normalized to roughly -1..1 ─
rsiVal = rsi(close, momLen)
momentum = (rsiVal - 50) / 50

volAvg = sma(volume, volLen)
volRatio = 1.0
if volAvg > 0 { volRatio := volume / volAvg }
volNorm = volRatio - 1
if volNorm > 1 { volNorm := 1 }
if volNorm < -1 { volNorm := -1 }

atrVal = atr(high, low, close, volLen)
atrAvg = sma(atrVal, volLen)
volaRatio = 1.0
if atrAvg > 0 { volaRatio := atrVal / atrAvg }
volaNorm = volaRatio - 1
if volaNorm > 1 { volaNorm := 1 }
if volaNorm < -1 { volaNorm := -1 }

trendEma = ema(close, trendLen)
trendSlope = 0.0
if trendEma[5] != 0 { trendSlope := (trendEma - trendEma[5]) / trendEma[5] * 100 }
trendNorm = trendSlope / 2
if trendNorm > 1 { trendNorm := 1 }
if trendNorm < -1 { trendNorm := -1 }

hh = highest(high, structLen)
ll = lowest(low, structLen)
structRange = hh - ll
structPos = 0.5
if structRange > 0 { structPos := (close - ll) / structRange }
structNorm = structPos * 2 - 1

// ─── Which body dominates the sky right now ──────────────────────
vals = array()
array.push(vals, momentum)
array.push(vals, volNorm)
array.push(vals, volaNorm)
array.push(vals, trendNorm)
array.push(vals, structNorm)

domIdx = 0
domAbs = abs(array.get(vals, 0))
i = 0
while i < 5 {
    v = abs(array.get(vals, i))
    if v > domAbs {
        domAbs := v
        domIdx := i
    }
    i := i + 1
}

// ─── Conjunction — how many bodies agree, and which direction ───
bullCount = 0
bearCount = 0
i = 0
while i < 5 {
    v = array.get(vals, i)
    if v > alignThresh { bullCount := bullCount + 1 }
    if v < 0 - alignThresh { bearCount := bearCount + 1 }
    i := i + 1
}
alignScore = (bullCount - bearCount) / 5.0
energy = (abs(momentum) + abs(volNorm) + abs(volaNorm) + abs(trendNorm) + abs(structNorm)) / 5

// Smoothed confirmation via OakRing — reduces whipsaw on the raw alignment
var alignRing = oakring(smoothLen)
alignRing.push(alignScore)
alignSmooth = alignRing.avg()

// ─── Conjunction signals (fire on transition, smoothing-confirmed) ─
var wasAligned = 0
alignedNow = 0
if bullCount >= 3 and alignSmooth > 0.25 { alignedNow := 1 }
if bearCount >= 3 and alignSmooth < 0 - 0.25 { alignedNow := 0 - 1 }

if alignedNow == 1 and wasAligned != 1 {
    if showSignals { plotshape(bar_index, low, "CONJUNCTION BULL", "triangleup", "#00ff9f") }
}
if alignedNow == 0 - 1 and wasAligned != 0 - 1 {
    if showSignals { plotshape(bar_index, high, "CONJUNCTION BEAR", "triangledown", "#ff006e") }
}
wasAligned := alignedNow

// ─── Retrograde — momentum reversing against the standing trend ──
var prevMomentum = 0.0
momDelta = momentum - prevMomentum
retroBear = trendNorm > 0.15 and momDelta < 0 - 0.05 and momentum > 0.25
retroBull = trendNorm < 0 - 0.15 and momDelta > 0.05 and momentum < 0 - 0.25
if retroBear and showSignals { plotshape(bar_index, high, "RETROGRADE", "xcross", "#ffd43b") }
if retroBull and showSignals { plotshape(bar_index, low, "RETROGRADE", "xcross", "#ffd43b") }
prevMomentum := momentum

// ─── Color by the dominant body ──────────────────────────────────
col = "#b48cff"
if domIdx == 0 { col := "#22cc88" }
if domIdx == 1 { col := "#ffd43b" }
if domIdx == 2 { col := "#ff8800" }
if domIdx == 3 { col := "#00ff9f" }
if domIdx == 4 { col := "#4488ff" }
if alignedNow == 1 { col := "#00ff9f" }
if alignedNow == 0 - 1 { col := "#ff006e" }

// ─── Main chart + oscillator ──────────────────────────────────────
plot(close, "Price", "#ffffff", 1)
plot(alignScore * 100, "Alignment", col, 2, "separate")
plot(energy * 100, "Energy", "#ff8800", 1, "separate")
hline(alignThresh * 100, "rgba(34,204,136,0.2)", "separate")
hline(0 - alignThresh * 100, "rgba(255,0,110,0.2)", "separate")
hline(0, "rgba(255,255,255,0.08)", "separate")

// ─── 3D — unified with the price bars, 4 lenses on the sky ───────
// Vortex: orbital alignment — spiral tightens into a converging funnel
// when the 5 bodies agree, loosens and drifts when they contradict.
plot3d(alignScore * 100, "Orbital Alignment", "vortex", col, "3d")
// Torus: ring size = how extreme the DOMINANT body currently is —
// small rings mean nothing much is happening, large rings mean one
// dimension is at a real extreme.
plot3d(domAbs * 100, "Dominant Orbit", "torus", col, "3d")
// Constellation: zodiac-style star map of WHICH body has ruled each
// period — naturally clusters into plateaus as one dimension dominates
// for a stretch, then hands off to another, like a regime history chart.
plot3d(domIdx, "Zodiac Regime Map", "constellation", "#b48cff", "3d")
// Trail: total orbital energy — magnitude of movement across ALL 5
// dimensions regardless of direction, distinct from alignment (which is
// about agreement, not magnitude).
plot3d(energy * 100, "Orbital Energy", "trail", "#ff8800", "3d")

// ─── Background tint ─────────────────────────────────────────────
if alignedNow == 1 { bgcolor("rgba(0,255,159,0.05)") }
if alignedNow == 0 - 1 { bgcolor("rgba(255,0,110,0.05)") }
if retroBear or retroBull { bgcolor("rgba(255,212,59,0.05)") }`,
  },

  // ═══════════════════════════════════════════════════════════════════
  {
    name: 'Liquidity Landscape — 3D Volume Terrain',
    description: 'A real market-profile engine (point of control, value area, volume imbalance) '
      + 'rendered as a literal 3D terrain rather than a 2D histogram. The point of control gets a '
      + 'summit marker; the value area\'s width and balance drive the rest of the landscape. '
      + 'Signals on value-area breakouts, point-of-control reversion touches, and imbalance flips.',
    category: '3D Visualizations',
    source: `// ═════════════════════════════════════════════════════════════════════
// Liquidity Landscape — 3D Volume Terrain
// A real volume-profile / value-area engine, rendered as 3D terrain.
// Point of control = the summit. Value area = the plateau around it.
// ═════════════════════════════════════════════════════════════════════
//
// Array API:  push, get, set, sum
// 3D styles:  manifold, torus, scatter, trail (separate/lower pane)

// ─── Inputs ──────────────────────────────────────────────────────
numBins = input(10, "Price Bins", 5, 20, 1)
lookback = input(60, "Profile Lookback", 20, 200, 10)
decay = input(0.97, "Bin Decay Rate", 0.90, 0.999, 0.005)
vaPercent = input(70, "Value Area %", 50, 90, 5)
showSignals = input(true, "Show Signals")

// ─── Persistent decayed volume-at-price bins ─────────────────────
var binVol = array()
if array.size(binVol) == 0 {
    i = 0
    while i < numBins {
        array.push(binVol, 0.0)
        i := i + 1
    }
}

hh = highest(high, lookback)
ll = lowest(low, lookback)
rng = hh - ll
if rng <= 0 { rng := close * 0.01 }

// Decay every bin, then deposit this bar's volume into its bin.
i = 0
while i < numBins {
    array.set(binVol, i, array.get(binVol, i) * decay)
    i := i + 1
}
binIdx = floor((close - ll) / rng * numBins)
if binIdx < 0 { binIdx := 0 }
if binIdx > numBins - 1 { binIdx := numBins - 1 }
array.set(binVol, binIdx, array.get(binVol, binIdx) + volume)

// ─── Point of control — the summit ───────────────────────────────
pocBin = 0
pocVal = array.get(binVol, 0)
i = 1
while i < numBins {
    v = array.get(binVol, i)
    if v > pocVal {
        pocVal := v
        pocBin := i
    }
    i := i + 1
}
totalVol = array.sum(binVol)
pocStrength = 0.0
if totalVol > 0 { pocStrength := pocVal / totalVol }
pocPrice = ll + (pocBin + 0.5) / numBins * rng

// ─── Value area — classic expand-from-POC algorithm ──────────────
vaLow = pocBin
vaHigh = pocBin
accum = pocVal
target = totalVol * vaPercent / 100
guard = 0
while accum < target and guard < numBins {
    leftVal = 0 - 1.0
    if vaLow > 0 { leftVal := array.get(binVol, vaLow - 1) }
    rightVal = 0 - 1.0
    if vaHigh < numBins - 1 { rightVal := array.get(binVol, vaHigh + 1) }
    if rightVal >= leftVal and vaHigh < numBins - 1 {
        vaHigh := vaHigh + 1
        accum := accum + rightVal
    } else {
        if vaLow > 0 {
            vaLow := vaLow - 1
            accum := accum + leftVal
        }
    }
    guard := guard + 1
}
vaHighPrice = ll + (vaHigh + 1) / numBins * rng
vaLowPrice = ll + vaLow / numBins * rng
vaWidthPct = (vaHighPrice - vaLowPrice) / rng * 100
insideVA = close >= vaLowPrice and close <= vaHighPrice

// ─── Balance — volume above POC vs below POC ─────────────────────
aboveVol = 0.0
belowVol = 0.0
i = 0
while i < numBins {
    v = array.get(binVol, i)
    if i > pocBin { aboveVol := aboveVol + v }
    if i < pocBin { belowVol := belowVol + v }
    i := i + 1
}
balanceScore = 0.0
if totalVol > 0 { balanceScore := (aboveVol - belowVol) / totalVol }

// ─── Signals ──────────────────────────────────────────────────────
var wasInside = true
if not insideVA and wasInside and close > vaHighPrice {
    if showSignals { plotshape(bar_index, high, "BREAKOUT", "triangleup", "#00ff9f") }
}
if not insideVA and wasInside and close < vaLowPrice {
    if showSignals { plotshape(bar_index, low, "BREAKDOWN", "triangledown", "#ff006e") }
}
wasInside := insideVA

nearPOC = abs(close - pocPrice) / rng < 0.02
var wasNearPOC = false
if nearPOC and not wasNearPOC {
    if showSignals { plotshape(bar_index, close, "POC TOUCH", "circle", "#b48cff") }
}
wasNearPOC := nearPOC

var wasBalance = 0
balSig = 0
if balanceScore > 0.3 { balSig := 1 }
if balanceScore < 0 - 0.3 { balSig := 0 - 1 }
if balSig != 0 and balSig != wasBalance {
    if showSignals { plotshape(bar_index, close, "IMBALANCE", "diamond", "#ffd43b") }
}
wasBalance := balSig

// Summit flag — marks the bar where a NEW point of control is established,
// not every bar (the "Point of Control" plot line below already tracks its
// current level continuously; this flag calls out when the summit moves).
var wasPocBin = -1
if pocBin != wasPocBin {
    if showSignals { plotshape(bar_index, close, "POC", "square", "#b48cff") }
    label3d(bar_index, pocStrength * 100, "POC", "#ffd43b", 1.0, 0, "separate")
}
wasPocBin := pocBin

// ─── Main chart + oscillator ──────────────────────────────────────
plot(close, "Price", "#ffffff", 1)
plot(pocPrice, "Point of Control", "#b48cff", 2, "stepline")
plot(vaHighPrice, "Value Area High", "#22cc88", 1, "stepline")
plot(vaLowPrice, "Value Area Low", "#ff4477", 1, "stepline")
plot(pocStrength * 100, "POC Strength", "#b48cff", 2, "separate")
plot(balanceScore * 100, "Balance", "#ffd43b", 1, "separate")
hline(0, "rgba(255,255,255,0.08)", "separate")

// ─── 3D — a real terrain built from real market-profile mechanics ─
// Manifold: liquidity concentration over time — the parallel ridges read
// as literal terrain contours. Colored by whether price sits inside the
// value area (calm) or has broken out of it (extended).
terrainCol = "#22cc88"
if not insideVA { terrainCol := "#ff8800" }
plot3d(pocStrength * 100, "Liquidity Terrain", "manifold", terrainCol, "separate", 0)
plot3d(vaWidthPct, "Value Area Surface", "surface", "#4488ff", "separate", 1)
plot3d(balanceScore * 100, "POC Rail", "line3d", "#ffd43b", "separate", 2)

// ─── Background tint ─────────────────────────────────────────────
if not insideVA { bgcolor("rgba(255,136,0,0.04)") }
if nearPOC { bgcolor("rgba(180,140,255,0.05)") }`,
  },
  // ─── Showcase — every new drawing-layer builtin, working together ─
  {
    name: 'Structure Cartographer',
    description: 'Live swing structure: trendline, supply/demand zones, auto-fib, break-of-structure arrows',
    category: 'Showcase',
    source: `// ═════════════════════════════════════════════════════════════════════
// Structure Cartographer — Market Structure Mapper
// Confirmed swing pivots, a live trendline through structure, supply/
// demand zones at the freshest swings, an auto-fib across the dominant
// leg, and break-of-structure arrows — the full 2D drawing-object
// toolkit reading one real structural story, not decoration.
// ═════════════════════════════════════════════════════════════════════

// ─── Inputs ──────────────────────────────────────────────────────
pivotLen = input(5, "Pivot Lookback/Lookahead", 2, 15, 1)
atrLen = input(14, "ATR Length", 5, 50, 1)
showZone = input(true, "Show Supply/Demand Zones")
showFib = input(true, "Show Fibonacci Retracement")

// ─── Pivot detection + volatility scale ───────────────────────────
ph = pivothigh(high, pivotLen, pivotLen)
pl = pivotlow(low, pivotLen, pivotLen)
atrVal = atr(high, low, close, atrLen)

// ─── Track the two most recent confirmed swing highs/lows ────────
var lastHighPrice = 0.0
var lastHighBar = 0
var prevHighPrice = 0.0
var lastLowPrice = 0.0
var lastLowBar = 0
var prevLowPrice = 0.0

if ph > 0 {
    prevHighPrice := lastHighPrice
    lastHighPrice := ph
    lastHighBar := bar_index - pivotLen
}
if pl > 0 {
    prevLowPrice := lastLowPrice
    lastLowPrice := pl
    lastLowBar := bar_index - pivotLen
}

// ─── Trend read from the swing sequence ───────────────────────────
trendUp = lastLowPrice > prevLowPrice and lastLowPrice > 0 and prevLowPrice > 0
trendDn = lastHighPrice < prevHighPrice and lastHighPrice > 0 and prevHighPrice > 0
var trendState = 0
if trendUp {
    trendState := 1
}
if trendDn {
    trendState := -1
}

// ─── Confirmed-pivot markers (auto-id, one per event, capped) ─────
if ph > 0 {
    phId = "ph" + tostring(bar_index)
    circle.new(bar_index - pivotLen, ph - atrVal * 0.3, bar_index - pivotLen, ph + atrVal * 0.3, "#ff4477", "rgba(255,68,119,0.15)", 1, phId)
}
if pl > 0 {
    plId = "pl" + tostring(bar_index)
    circle.new(bar_index - pivotLen, pl - atrVal * 0.3, bar_index - pivotLen, pl + atrVal * 0.3, "#22cc88", "rgba(34,204,136,0.15)", 1, plId)
}

// ─── Live structure trendline — same id, moves as new swings confirm ─
if trendState == 1 {
    line.new(lastLowBar, lastLowPrice, bar_index, lastLowPrice, "#22cc88", 2, "solid", "right", "structline")
}
if trendState == -1 {
    line.new(lastHighBar, lastHighPrice, bar_index, lastHighPrice, "#ff4477", 2, "solid", "right", "structline")
}

// ─── Supply/demand zones at the freshest swings ────────────────────
if showZone and ph > 0 {
    box.new(bar_index - pivotLen, ph + atrVal * 0.15, bar_index, ph - atrVal * 0.15, "#ff4477", "rgba(255,68,119,0.10)", 1, "zone_sup")
    text.new(bar_index, ph + atrVal * 0.5, "Supply", "#ff4477", 11, "zonelabel_sup")
}
if showZone and pl > 0 {
    box.new(bar_index - pivotLen, pl + atrVal * 0.15, bar_index, pl - atrVal * 0.15, "#22cc88", "rgba(34,204,136,0.10)", 1, "zone_dem")
    text.new(bar_index, pl - atrVal * 0.5, "Demand", "#22cc88", 11, "zonelabel_dem")
}

// ─── Fibonacci retracement across the dominant recent leg ─────────
if showFib and lastHighBar > 0 and lastLowBar > 0 {
    if lastHighBar > lastLowBar {
        fibretracement.new(lastLowBar, lastLowPrice, lastHighBar, lastHighPrice, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], "#22cc88", "#ff4477", "fib")
    } else {
        fibretracement.new(lastHighBar, lastHighPrice, lastLowBar, lastLowPrice, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], "#ff4477", "#22cc88", "fib")
    }
}

// ─── Break of structure ────────────────────────────────────────────
var lastTrendState = 0
if trendState != lastTrendState and trendState != 0 {
    if trendState == 1 {
        arrow.new(lastHighBar, lastHighPrice, bar_index, high, "#22cc88", 2)
    } else {
        arrow.new(lastLowBar, lastLowPrice, bar_index, low, "#ff4477", 2)
    }
    alertcondition(true, "Break of Structure", "Trend flipped")
}
lastTrendState := trendState

// ─── Candle tint by structure state ─────────────────────────────────
if trendState == 1 {
    barcolor("#22cc88")
}
if trendState == -1 {
    barcolor("#ff4477")
}

// ─── Price + structure depth in 3D ──────────────────────────────────
plot(close, "Price", "#ffffff", 1)
swingDelta = lastHighPrice - lastLowPrice
plot3d(swingDelta, "Structure Depth", "bars3d", "#b48cff", "separate")
plot3d(trendState * 50 + 50, "Trend State", "ribbon", "#22aaff", "separate")`,
  },
  {
    name: 'Nova Signal Engine',
    description: 'Multi-oscillator confluence firing custom rocket/shield icon signals in 2D and as 3D billboards',
    category: 'Showcase',
    source: `// ═════════════════════════════════════════════════════════════════════
// Nova Signal Engine — Multi-Oscillator Confluence, Custom Icon Signals
// RSI + Stochastic + MFI + CMF vote on overbought/oversold; when they
// agree, fire a hand-drawn rocket/shield ICON instead of a stock shape —
// in both the 2D pane and as a real 3D billboard sprite. A Gann fan
// projects from the trailing swing low, and an adaptive channel shows
// where the range is tightening.
// ═════════════════════════════════════════════════════════════════════

// ─── Inputs ──────────────────────────────────────────────────────
rsiLen = input(14, "RSI Length", 5, 50, 1)
stochLen = input(14, "Stochastic Length", 5, 50, 1)
mfiLen = input(14, "MFI Length", 5, 50, 1)
cmfLen = input(20, "CMF Length", 5, 50, 1)
squeezeLen = input(20, "Squeeze Channel Length", 10, 80, 1)

// ─── Custom icon assets (inline data URIs — no upload needed) ─────
rocketIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADB0lEQVR4AdRXTWsUQRCtWc+egoIXwRUkgrdNjBjBk+LdgxJ/QXLIIQETf4GbQwJ6SPwFfvwBEb1GMWb35MEQcBURD4oH8Sa443s9szNd090zHVwIWbpmuqpevXo1szvDtuSQP0dLwJndtWvtXne93Vvbbve632F/c8PexNaJOchFjboCaDIP+5Ak6UuQL4mkszifgLGehr2JLRFDLGwe+cbF4iDobP9+p73bfQ3AJmwSFruI3WQtOeqKggJQeCtNk3eSyOU6gtocaslBrhDOK4AFKHyKIm8ecbNmjp8WmnHChxa5yOmDOA0A7KDgsQ9cjS2emhVaNe7zyUnuas4RkA6ThwA5ccTU4uSXcAVo3Kuk32nl3CqrGplvLu6bQgQce3J7H4BnYXCbHplnjkoAIouwxsWJOfkIyD1jI7/hrHoUAvIHCH8+DfXive/RV0FkMu9l+hQC8AC5YSINB07Kiaswxpirxn2+3asQIJLMSMSnbtK6nKYue1kC0nMa5HqckJO6mSzCHDGZV3cse1kCZKKuhLmYCWMw4Cp62QIQDy9OxgnDiCxDDLGZ13y0Bfysg0dOZigisEUvS0Cyb6o9B07EyezU1z+/ZG7/iVx9/0je/v5ip4RY1qigcspeloB0R2Esx57IbryDxvTveITYNRZVvi17FQLwsniRZ9WJk3AiNhpNzMYKBId5WwhrWIuUs+xehYBP0yuvgNyDqXVz4kJxqX2NFRiOLYQiEKquvbyXiRcCjCfCN2G+zU53Pz+XmMYZujxSyINv22Wg3KkeSsBganVLUnlTYse8A7fpYdEqAYwnrZRvqyH3Y7Zhzq1oHQEfO/f6eFnMKdQYHHKSu0rlCCAAwGcouI39OK7EkFzkBJ+zvAKIYgEKL/7XdwL3nBzkIqfPggIIRmF/ML3KPyEL8J2fKGKhRewCa8kRAjFeK4AAGr+5sPN4gFyHvyGS8M/KDxHhLaJhb2IbxBAL20K+cUUJGLHwAQLi5cHUyhWcT8KO5Ya9iS0TM8LHnA8kIIawimny/wEAAP//KrXSgAAAAAZJREFUAwBGsyJQA9w7EgAAAABJRU5ErkJggg=="
shieldIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC4UlEQVR4AdRXvW4UMRAebx4BwSOgowaBBOkuiegpQJR0SUEBEndvwB0SKSiSN0BQ0KPkrguRQFAT8QggHiFrvm/2z2t77T0aROTP65n5Zuazb28vW8g//vu/BNjpi127O3ttd+Zndmf2E7isgTV8jIGzyaGOOgE02Qe+izEnYuWZiL2HJlcB5hNYw8cYOOQC+4hnB5MHSXZvftNOZ59AOAImwNhB7hFzWSOVNCjATucPpbRfxMjdVIFkjLmoobUGiFEBmmDsO+RE4/CL3Lou8vJJBa7VGZ0KQS2tGQkXvk+PzNi3vr+12cxt7Nst0Vugptb23IEAubRvwAn9uUa5uEhR10b5bvQa6Z3Lz62Lb3LUVVZKCGprj4qpc08APE+B/niwXYnoe/MWhTA3ZPZ6tAJs9QCZBPwPZ4FrtCOeO6l7aZlWgBTmvnr86esPEcL352zmEDGe06sTYM2dGFd98Z1oaHBK5Ti9OgFi8cUeKMedEAPhwE0uEQQaR9fLESBXmnD0mtqRn5Dntr1cAX6Zvs0dEX1vaJFDhJGoxxXwO8pwnfmdiYzhiLS9HAEGt7vbLbLmzohISF2MEWqkpq5XJ8DYz6mUNpbaYSrWFsDC6dUJKO1HhPKDOyR8Jn2E74/ZTq9WgFm/OgX3AsiP2E5jvnili7qXRlsBaonwl7BeJi7cKdFQuCYaO33t9egJMKvlMf7nO0/n11F3x+66DkcvVs61hxPsCVD/luGvVanr1MQdu0hxq1gpVe3KqudAgDlZfBNrHtfx9IU7J9KsKoqaWruy2jkQwIhZL95DxCOs0yfRnACIiVGyltaMkKICyNOEwtwWfG60/wrMRQ2tNVBgUAD5PDKzXvIl5AD2uK8oiBjkHjCXNWAPjqSAJot3LnBDrN3De8KhiOHLyi8R4UdEYA2fkUNyyAWOEc+OUQKaKnyAmNPlc7NabJvV8hqwVQNr+BirHmhNSva6kYBstQgh5/oDAAD//5w/NJkAAAAGSURBVAMAW6IcUP2OZmoAAAAASUVORK5CYII="
orbIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAF2ElEQVR4AdRTy24cRRS9VT093T3jsbGj8AlRWCMFyWGHYkVCAXZE+QOy8CJZ4RhQAEXEEll4Ef4gIj8ADiZigy0lEmusfAKR4yzweLq6u4pzbrvbM37hrBCWj2911X2cc6ps5T/++X8RuLuwfeXe1Z3v71/b+f3+Rzt/rXyyU618vFNxzT2eMedNTD2TA/cWXn22cu31n1OD6JfejLmVTdvL/Rl7vj9tLSJxnnu9GXuLOcxlzVmInErg64XX73734auNZGAfJgO5mA2MtJjGetpKphFrnmGdThlhbjIwD1nLHqcRsScdfruw/WmayfN0ys7XQzFsAGAolEqviTNW9BsRLojuIw91kg6i+TQLz9nrpDnHEmBBN7M/Jj2xSd8IkSKmVInmGSPU9gAd2uxhXx2ACxp7IknPWPZiz+NI2MObtKybRY+SnkWxlbRfI+OQKSs6EOr7M5FQeR/KGRvlTV5T1/TpZvYRex+ed4RA3PGrcSI2TkW6mUgMdHtGiESVidCBFGrH75/fqrovkmi+oN4I+ygSY+PYr55KgC83Tu18nGBgymK4kBFGUjTlNWSNC2PKM67hUE0C+X0jCeq6mQEJK132Qs84sfPf4D9qnISd+OjaxU4s0ukaRZxgDcRowGZUpu8BTtAFvgGC6xR7PGeeDkRNzKFd9NB+iOwdy+LEzObj7gfbV6KOXIzienhLAsUkQOAeJcHb4P1mUNybjoT3zzVfPc8SqGZujOGdBujR9OvE9iJnNXNts4g69qrtiCiiIDYSASGJwLqJ6g4dwbtIcNcx3kkHSnk1XMc4izBMa/brLPpMIkiMWc3cAwKRvBdFRgjLSDKI9Rr7HYDuKKxYa4Q//GvQhQojnClZ5h4C+zQwmMVaAqUMgJELYoIQbCjobPbRrKX9QV67nlwc1CBH++Ecsdlnb6wvYFd/WwI4OGeMEWMAqYEghBGRgH4CBC/iK6m/sc9fnukezkJgNnYRDYoNlsbgL38VRjgL2/rbEmDHEAJCEI9INMOqCntAWQYpiyBFHsTteSldkAJwe4jY41lVeKmQ530AUQAxECCPoP3RXofzT0sgBLMtYF0DCqHGAwFqqa4qRapCpMSgYhRAQCQfIhIkgL3SieYw1yNf69kDEAIkpMY2hxMHBLy8aFlTARpUUEvVFVTq4NyLwyAqzne95LtBRoASAQkHV+gOnandCHADpNgLDnqFCIi94HCiJYDNZ1RKVJWRispZSNUE1BUjEcJhWL435kDrAs5zgUsiFfLpmLrBXg3ohJdnHE60BKrSr1VQXjP3uF+v91tAtVo+8qo+H0I5BuZwYDSBIDkccARd4lUBpWMvOAE36ShRYBaHEy2Br56eW/el2fL7qpU9VPBeCzSi8gLKeQU5CQBuWLvAb4ezAq44uoR8XhlrFRhewsXajbDFWRxOtAT4AbarfNUKNCla9QGPjgoBDObAHHdPBxgV6owXh0gyJOrgWoE+NZkAVwlZ5awGEwS++HXuh9KFTWUN9QXuUwFVjrZCpQMBQklgXQ8HQXVDcE0A8nhtrC3ZA73YE495kzOa4YwTBLhR5XYRrL0DewXvFMihrEbAy/f7qNf5/lvQc6xzEMhBzqGOqMl4X6A3Z4zjCIEvf3vrj2rkb5RQzXvnnTo01PtVlQE2E1CKa8h1r34LdKbODfhvIUToAgRJNQo32Ht8ONdHCHBz+em5x/nIX3ej4B2Vg0AONTnXwAjqeP8jrKm+BtzAfj4O1ux5j9rr7Mneh3EsASbhpT4uhuYSFG06vm4obSOGOGK3Vq5DQZJ7XKMGbyEI4ma5Zy+xF3sehxMJMJmW3Xkyd9kN/c186LdUNe74aAyS/+31XeQgBke23DDcvLM2d5k92OsknEqgKeLLXVqbewdWLuB//wGwgbt/iWEeEQgv4c4G3ssD5jCXNU39afFMBJoGsHJ9eX329tLa7PtLP8++/flPs9ESgTX3lp/M3mZOk3+W+EYEztLwcM6/ff8DAAD//66mwiIAAAAGSURBVAMAy+cOfQu05EMAAAAASUVORK5CYII="

// ─── Oscillator confluence ─────────────────────────────────────────
r = rsi(close, rsiLen)
st = stoch(high, low, close, stochLen)
mf = mfi(high, low, close, volume, mfiLen)
cm = cmf(high, low, close, volume, cmfLen)

bullVotes = 0
if r < 30 {
    bullVotes := bullVotes + 1
}
if st < 20 {
    bullVotes := bullVotes + 1
}
if mf < 20 {
    bullVotes := bullVotes + 1
}
if cm > 0.1 {
    bullVotes := bullVotes + 1
}

bearVotes = 0
if r > 70 {
    bearVotes := bearVotes + 1
}
if st > 80 {
    bearVotes := bearVotes + 1
}
if mf > 80 {
    bearVotes := bearVotes + 1
}
if cm < -0.1 {
    bearVotes := bearVotes + 1
}

confluence = bullVotes - bearVotes

// ─── Rocket / shield icon signals — extreme agreement only ─────────
// Icons fire on the bar an agreement starts, not on every bar it holds.
var prevBull = false
var prevBear = false
bullStart = bullVotes >= 3 and not prevBull
bearStart = bearVotes >= 3 and not prevBear
if bullStart {
    plotimage(bar_index, low, rocketIcon, 28, 28)
}
if bearStart {
    plotimage(bar_index, high, shieldIcon, 28, 28)
}
prevBull := bullVotes >= 3
prevBear := bearVotes >= 3

// ─── The SAME confluence, as a 3D billboard sprite (lower 3D pane) ──
plot3d(confluence * 25 + 50, "Confluence Terrain", "surface", "#b48cff", "separate")
if bullStart {
    plotimage_3d(bar_index, low, rocketIcon, 1.4, 0, "separate")
    label3d(bar_index, low, "MAX BULL", "#22cc88", 1, 1, "separate")
}
if bearStart {
    plotimage_3d(bar_index, high, shieldIcon, 1.4, 0, "separate")
    label3d(bar_index, high, "MAX BEAR", "#ff4477", 1, 1, "separate")
}

// ─── Adaptive squeeze channel — two live lines + a linefill bridge ──
hiBand = highest(high, squeezeLen)
loBand = lowest(low, squeezeLen)
line.new(bar_index - squeezeLen, hiBand, bar_index, hiBand, "#4cc9f0", 1, "dotted", "none", "squeezehi")
line.new(bar_index - squeezeLen, loBand, bar_index, loBand, "#4cc9f0", 1, "dotted", "none", "squeezelo")
linefill.new("squeezehi", "squeezelo", "rgba(76,201,240,0.06)")

// ─── Gann fan re-anchored to the trailing 40-bar low ────────────────
gannLow = lowest(low, 40)
gannUnit = atr(high, low, close, 14) * 0.5
gannfan.new(bar_index - 40, gannLow, gannUnit, "#b48cff", "gann")

// ─── Watermark logo, tracking near the top of the squeeze band ─────
image.new(bar_index - 45, hiBand, orbIcon, 22, 22, "center", 0.85, 0, "logo")

// ─── Base plots ───────────────────────────────────────────────────
plot(close, "Price", "#ffffff", 1)
plot(r, "RSI", "#22aaff", 1, "separate")
hline(70, "#ff4477", "separate")
hline(30, "#22cc88", "separate")`,
  },
  {
    name: 'Regression Nebula',
    description: 'Native regression channel rendered five ways: band, projected cone, faceted echo, breach markers',
    category: 'Showcase',
    source: `// ═════════════════════════════════════════════════════════════════════
// Regression Nebula — Linear Regression Channel, Projected Cone & Echo
// The engine's native regression.channel() drives everything: the
// historical band (plot+fill), a forward-projected cone built from two
// live line.new rays + linefill.new, a faceted polyline echo of the
// spine, and breach/re-entry markers — one real statistical read,
// rendered five different ways.
// ═════════════════════════════════════════════════════════════════════

// ─── Inputs ──────────────────────────────────────────────────────
rcLen = input(30, "Regression Length", 10, 100, 1)
rcMult = input(2.0, "Channel Width (stdev mult)", 0.5, 4.0, 0.1)
echoStep = input(8, "Echo Facet Spacing (bars)", 4, 20, 1)

// ─── The channel itself ─────────────────────────────────────────
rc = regression.channel(close, rcLen, rcMult)
width = rc.upper - rc.lower
posInChannel = 0.0
if width > 0 {
    posInChannel := (close - rc.lower) / width
}

// ─── Historical band ────────────────────────────────────────────
plot(rc.mid, "Regression Mid", "#b48cff", 2)
plot(rc.upper, "Upper", "#22aaff", 1)
plot(rc.lower, "Lower", "#ff9900", 1)
fill(rc.upper, rc.lower, "rgba(180,140,255,0.06)")

// ─── Forward-projected cone: two rays + a linefill bridge ─────────
line.new(bar_index - rcLen, rc.upper, bar_index, rc.upper, "#22aaff", 1, "dashed", "right", "conehi")
line.new(bar_index - rcLen, rc.lower, bar_index, rc.lower, "#ff9900", 1, "dashed", "right", "conelo")
linefill.new("conehi", "conelo", "rgba(34,170,255,0.05)")

// ─── Faceted polyline echo of the spine, sampled every echoStep bars ─
var echoPts = array()
if bar_index % echoStep == 0 {
    array.push(echoPts, bar_index)
    array.push(echoPts, rc.mid)
    if array.size(echoPts) > 24 {
        array.remove(echoPts, 0)
        array.remove(echoPts, 0)
    }
}
echoPath = array()
i = 0
while i < array.size(echoPts) {
    pt = array()
    array.push(pt, array.get(echoPts, i))
    array.push(pt, array.get(echoPts, i + 1))
    array.push(echoPath, pt)
    i := i + 2
}
polyline.new(echoPath, "#e0aaff", 2, false, "echo")

// ─── Breach + re-entry ──────────────────────────────────────────
var wasOutside = false
outside = close > rc.upper or close < rc.lower
if outside and not wasOutside {
    breachCol = "#ff4477"
    if close > rc.upper {
        breachCol := "#22cc88"
    }
    circle.new(bar_index - 1, close, bar_index + 1, close, breachCol, "rgba(255,255,255,0.08)", 1)
}
if not outside and wasOutside {
    arrow.new(bar_index - 2, close, bar_index, close, "#ffd43b", 2)
}
wasOutside := outside

// ─── 3D — volatility terrain + dispersion cloud ───────────────────
plot3d(width, "Channel Width Terrain", "ribbon", "#b48cff", "separate")
dispersion = (close - rc.mid) / (width + 0.0001) * 100
plot3d(dispersion, "Dispersion Cloud", "scatter", "#e0aaff", "separate")`,
  },
  {
    name: 'Liquidity Matrix',
    description: 'OakRing volume percentiles feed a real trend×volume Matrix, that drives the signal logic',
    category: 'Showcase',
    source: `// ═════════════════════════════════════════════════════════════════════
// Liquidity Matrix — OakRing Percentiles and a Real Regime Matrix
// A rolling OakRing tracks volume percentiles to flag genuine spikes; a
// 3×3 Matrix tallies trend×volume regime frequency and renders straight
// into a color-graded table.new heatmap; a polyline traces the
// liquidity trail; and the matrix's own live cell feeds a 3D layer.
// ═════════════════════════════════════════════════════════════════════

// ─── Inputs ──────────────────────────────────────────────────────
ringLen = input(50, "Volume Percentile Window", 20, 200, 1)
spikePct = input(85, "Spike Percentile Threshold", 50, 99, 1)
emaLen = input(20, "Trend EMA Length", 5, 100, 1)

// ─── Custom spike icon ──────────────────────────────────────────
boltIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADPklEQVR4AdRWv29TMRA+p4jCUBIELUMnGBBIdEJKqpYNgZAaWIGuTDBA1W78D62AAf4DBCukEgJ1o1UTiQEViYoBZtoiEiKE+NGY++z3XPs9+/2YEJEvz7777u7Lne2XCv3jz/9F4Mp690Kz3Vu83Om9bra7Wyy7kWxpXW8RmDJFLVSBmU73ZrPTez8Q9JJIzksppznJKAv8IaNaJ+eBARY+bM8dcA6CZta7Z5vtr6tC0kOS8lQIOHFon2tiLHzgixiu0V0FCTQ73atCUIdITFHGZ2y4QneOHwwgxBRiIFYAQF4CykHSE3by2llvxhwn3/o5MGvPpEIcS8X0GhNKVTJJjxNq73J2/ACh/O/6u167o+SYKrajpHQFhJAPGJP7y5H4+vgwQwuPShTbcXAS6Z0rMnsO72TfN/p/oC4gYkrn2IM6BASJ23um8Ax9P8abL4wIW5I5DAF1gfDxCbtqy/mj+1Xf9Up/b3wrWgHGcw6Vi6cYhsBAiEtQZAlKP3cifeSe16vkEx8W8e1chgCf1waMWYLSZ9lt22c+mvc+/rBVZm7nMgT4Kj1pEJ5JfOQ8Jq/q/id/coDtXIYAG46weEfZI4dfnrMvTC6bgDc5+h6+atMuKzu/CJK2+DU2gS8+CPpe9Mhl9T0R2+QyBIQQHxIgtby7+Z34Xe/Ijbd9ZUt+ZfXdxtq5DAEpqW2Dsua+ihTouwlp5zIEKlK+MIicycSI+/5HzyE5bsZs5zIEnk3WXpEQmwaVMTkzMmSsJfqufTiHyqVX7ttQknoTRqbwA8cythbte4xP5jAVAGC5XnvE//nWMA8JjmVsK9N37SPXdA69wrdDAAop1Rsx+Bcn3oDoOQQ+BWUQxXbgKQLLk7U3JGjWQVkLbMDSfYc/x1SxMbckRQC2Vr32lElc43mqEtiAJfs+QCwVkwMmh5cAQHCQkurJPbGy85ty7nm4RyLXEAOxIkXqESQAJErWahyeloJuER8f6Fb4rsczUxgLH/giRhY2k0DsiJ3bqldPVyRdJBJLfJWuEtE2yyCSba0TS8AACx+25Y5CBOIouEBajeoC//s512rUxliGIhnTuuoCMDG+yLMUgSIBk5i89V8AAAD//0EjwHkAAAAGSURBVAMAHtNHUF04SJ0AAAAASUVORK5CYII="

// ─── Rolling volume percentile via OakRing ─────────────────────────
var volRing = oakring(ringLen)
volRing.push(volume)
volThreshold = volRing.percentile(spikePct)
isSpike = volume > volThreshold and volThreshold > 0

// ─── Trend regime ───────────────────────────────────────────────
trendEma = ema(close, emaLen)
regimeUp = close > trendEma
volLevel = 1
if isSpike {
    volLevel := 2
}
if volume < volRing.percentile(30) {
    volLevel := 0
}

// ─── 3×3 regime matrix: rows = trend {down,flat,up}, cols = volume {lo,mid,spike} ─
var regimeMatrix = matrix(3, 3, 0)
trendRow = 1
if regimeUp {
    trendRow := 2
}
if close < trendEma {
    trendRow := 0
}
regimeMatrix.set(trendRow, volLevel, regimeMatrix.get(trendRow, volLevel) + 1)
matrixMax = 1.0
r = 0
while r < 3 {
    c = 0
    while c < 3 {
        v = regimeMatrix.get(r, c)
        if v > matrixMax {
            matrixMax := v
        }
        c := c + 1
    }
    r := r + 1
}

// ─── Liquidity trail — polyline through spike points ────────────────
var trailPts = array()
if isSpike {
    array.push(trailPts, bar_index)
    array.push(trailPts, close)
    if array.size(trailPts) > 40 {
        array.remove(trailPts, 0)
        array.remove(trailPts, 0)
    }
}
trailPath = array()
ti = 0
while ti < array.size(trailPts) {
    p = array()
    array.push(p, array.get(trailPts, ti))
    array.push(p, array.get(trailPts, ti + 1))
    array.push(trailPath, p)
    ti := ti + 2
}
polyline.new(trailPath, "#4cc9f0", 2, false, "trail")

// ─── Spike icon + zone box around the freshest spike cluster ───────
if isSpike {
    plotimage(bar_index, high, boltIcon, 22, 22)
}
recentHigh = highest(high, 10)
recentLow = lowest(low, 10)
if isSpike {
    box.new(bar_index - 10, recentHigh, bar_index, recentLow, "#4cc9f0", "rgba(76,201,240,0.08)", 1, "spikezone")
}

// ─── Candle tint on spikes ───────────────────────────────────────
if isSpike {
    barcolor("#4cc9f0")
}

// ─── Base + 3D ────────────────────────────────────────────────────
plot(close, "Price", "#ffffff", 1)
plot(trendEma, "Trend EMA", "#ffd43b", 2)
regimeDensity = regimeMatrix.get(trendRow, volLevel) / matrixMax * 100
plot3d(regimeDensity, "Regime Density", "manifold", "#b48cff", "separate")
plot3d(volume, "Volume Terrain", "bars3d", "#4cc9f0", "separate")`,
  },
  {
    name: 'Session Chronograph',
    description: 'Per-session range box, open line, auto-fib and flag markers — one drawing object per session, not per bar',
    category: 'Showcase',
    source: `// ═════════════════════════════════════════════════════════════════════
// Session Chronograph — Live Session Range, Auto-Fib, Time Terrain
// A configurable bar-count "session" gets a growing range box, a
// per-session open line, a flag-icon marker, and a fib across the PRIOR
// session's completed range — all keyed off a session counter, the
// most advanced form of the id idiom: one object PER SESSION, not per
// bar. A ridgeline closes it out with the true temporal distribution.
// ═════════════════════════════════════════════════════════════════════

// ─── Inputs ──────────────────────────────────────────────────────
sessionLen = input(30, "Bars per Session", 10, 100, 1)
atrLen = input(14, "ATR Length", 5, 50, 1)

// ─── Flag icon ───────────────────────────────────────────────────
flagIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABmUlEQVR4AeyWT07CUBDGv2ncoTtNhAto+KMbMZHiBhIXruQAcAG9ABwALoAXgAPgyoUJbKSYiBvlT/QCYKI7ZWcYX0NoSpMnD2mVRZtMOm/edL5fvvQ11fDP12oDcDd5boaXJkkdmAhzGeDyJPcGQwoAHm9ZkvbcKrqTyAHs8wmn/HR0xq8nAXvZjVwNABSHptXwPvrkrl7njp7nZ/3gDwFmpFIgFPGFtoAZcCdR4X4yy/3j4EyX4kLRAem0IIiyGHMF4/FAAN1zTy9yL5GSPuHYWBbAMQ5xMPJgqguYD+4la+YJ4kd9x9k4XbsNMJ2rfHcboA1CCcRpihobFGlmKNq8pH3jRUa0LMAQzFVolBOnJERR45AiRoEirYZM0Fn/DUADjALWEBeCIYq1chRuVil8O3QOV1krAnBbvOUZbAbWhWiaYkaJdo0HFYF5PWoAjGvau7ui7ZvRvIGL7qsBLDp1gX4fwHfAd8B3wHdghR0g7c36pNtzq+hOInWAxJ8MQBdmTHJ4ckkBTDVT2Awz9yp+BHBDdN6MbwAAAP//WgC0oQAAAAZJREFUAwAAVXlBIzM0jAAAAABJRU5ErkJggg=="

// ─── Session boundaries via a bar-count counter (no fake calendar aware) ─
var sessionCount = 0
var sessionStartBar = 0
var sessionOpen = 0.0
var sessionHigh = 0.0
var sessionLow = 999999999.0
var prevSessionHigh = 0.0
var prevSessionLow = 0.0

isNewSession = bar_index % sessionLen == 0

// Capture the outgoing session's completed range BEFORE resetting it.
if isNewSession and sessionCount > 0 {
    prevSessionHigh := sessionHigh
    prevSessionLow := sessionLow
}
prevSessionRange = prevSessionHigh - prevSessionLow

if isNewSession {
    sessionCount := sessionCount + 1
    sessionStartBar := bar_index
    sessionOpen := open
    sessionHigh := high
    sessionLow := low
}
if not isNewSession {
    if high > sessionHigh {
        sessionHigh := high
    }
    if low < sessionLow {
        sessionLow := low
    }
}
sessionRange = sessionHigh - sessionLow
barsElapsed = bar_index - sessionStartBar

atrVal = atr(high, low, close, atrLen)
rangeVsAvg = 0.0
if atrVal > 0 {
    rangeVsAvg := sessionRange / atrVal
}

// ─── Growing session box — same id all session, new id each session ──
sessBoxId = "sbox" + tostring(sessionCount)
box.new(sessionStartBar, sessionHigh, bar_index, sessionLow, "#b48cff", "rgba(180,140,255,0.05)", 1, sessBoxId)

// ─── Session open line — one per session ────────────────────────────
sessOpenId = "sopen" + tostring(sessionCount)
line.new(sessionStartBar, sessionOpen, bar_index, sessionOpen, "#ffd43b", 1, "dotted", "right", sessOpenId)

// ─── Session label + flag icon at the boundary ──────────────────────
if isNewSession {
    sessLabelId = "slabel" + tostring(sessionCount)
    text.new(bar_index, sessionHigh, "Session " + tostring(sessionCount), "#b48cff", 10, sessLabelId)
    image.new(bar_index, sessionHigh, flagIcon, 18, 18, "center", 1, 0, sessLabelId + "flag")
}

// ─── Fib across the PRIOR completed session's range ─────────────────
if isNewSession and sessionCount > 1 and prevSessionRange > 0 {
    fibretracement.new(sessionStartBar - sessionLen, prevSessionLow, sessionStartBar, prevSessionHigh, [0, 0.382, 0.5, 0.618, 1], "#22cc88", "#ff4477", "sfib")
}

// ─── Notable-session circle: flags an outsized COMPLETED session ────
if isNewSession and sessionCount > 1 and prevSessionRange > 0 and atrVal > 0 {
    prevRangeVsAvg = prevSessionRange / atrVal
    if prevRangeVsAvg > 1.6 {
        circle.new(sessionStartBar - sessionLen, prevSessionLow, sessionStartBar, prevSessionHigh, "#ffd43b", "rgba(255,212,59,0.06)", 1, "notable" + tostring(sessionCount))
    }
}

// ─── Candle tint by half of session range ───────────────────────────
midSession = (sessionHigh + sessionLow) / 2
if close > midSession {
    barcolor("#b48cff")
}
if close <= midSession {
    barcolor("#4cc9f0")
}

// ─── Base + temporal 3D ─────────────────────────────────────────────
plot(close, "Price", "#ffffff", 1)
plot(sessionHigh, "Session High", "#ff4477", 1, "stepline")
plot(sessionLow, "Session Low", "#22cc88", 1, "stepline")
plot3d(sessionRange, "Range Ridgeline", "ridgeline", "#b48cff", "separate")
plot3d(rangeVsAvg * 50, "Momentum Trail", "trail", "#4cc9f0", "separate")`,
  },
  {
    name: 'Wind Velocity Vector 3D',
    description: '3D wind-vector field: pitch/yaw/roll cones on each gust, a velocity ribbon and tail trail in the 3D pane, plus two small charts (wind speed against the gust threshold, and tail length). Bar motion drives the vector direction.',
    category: '3D Visualizations',
    source: `// Wind Velocity Vector 3D — bar motion becomes a wind vector: 3D field + two small charts
wx = input(1.0, "Wind X", -5.0, 5.0, 0.1)
wy = input(0.5, "Wind Y", -5.0, 5.0, 0.1)
wz = input(0.2, "Wind Z", -5.0, 5.0, 0.1)
baseKnots = input(15.0, "Base Knots", 1.0, 60.0, 0.5)
gustKnots = input(22.0, "Gust Knots", 5.0, 60.0, 0.5)
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
gust = crossover(windSpeed, gustKnots)
if gust {
    plotshape(bar_index, low, "Gust", "triangleup", "#ff8800")
    plotshape_3d(bar_index, windSpeed, "Vector", "coneup", "#ff8800", markerSize, 0, "separate", pitch, yaw, roll)
    label3d(bar_index, windSpeed, "GUST", "#ff8800", 0.9, 0, "separate")
}
plot(windSpeed, "Wind Speed", "#38d0ff", 2, "separate")
hline(gustKnots, "#ff8800", "separate")
plot(tailLen, "Tail Length", "#ff8800", 1, "separate")
plot3d(windSpeed, "Wind Velocity", "ribbon", "#38d0ff", "separate", 0)
plot3d(tailLen, "Vector Tail", "trail", "#ff8800", "separate", 1)`,
  },
];

export function getIndicators(): IndicatorDef[] {
  const userIndicators = getUserIndicators();
  return [...INDICATORS, ...userIndicators];
}

export function getIndicatorByName(name: string): IndicatorDef | undefined {
  return getIndicators().find(ind => ind.name === name);
}

export function getCategories(): string[] {
  const cats = new Set(getIndicators().map(ind => ind.category));
  return Array.from(cats);
}

// ─── User-created indicators (persisted in localStorage) ──────────

const USER_INDICATORS_KEY = 'oakscript_user_indicators';

export function getUserIndicators(): IndicatorDef[] {
  try {
    const raw = localStorage.getItem(USER_INDICATORS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function saveUserIndicator(name: string, source: string): void {
  const userInds = getUserIndicators();
  const existing = userInds.findIndex(i => i.name === name);
  const def: IndicatorDef = {
    name,
    description: 'User-created signal model',
    category: 'User Created',
    source,
  };
  if (existing >= 0) {
    userInds[existing] = def;
  } else {
    userInds.push(def);
  }
  localStorage.setItem(USER_INDICATORS_KEY, JSON.stringify(userInds));
  // Fire-and-forget: every save (toolbar Save, Strategy Lab's Approve &
  // Save, cartridge Import) goes through this one function, so hooking the
  // ledger here — rather than at each UI call site — makes it impossible to
  // add a new save path later that forgets to log it.
  void appendLedgerEntry('indicator.save', { name, overwrite: existing >= 0, sourceLength: source.length });
}

export function removeUserIndicator(name: string): void {
  const userInds = getUserIndicators().filter(i => i.name !== name);
  localStorage.setItem(USER_INDICATORS_KEY, JSON.stringify(userInds));
  void appendLedgerEntry('indicator.delete', { name });
}

// ─── OakCartridge (portable indicator export/import) ──────────────
// A self-contained, shareable file for one indicator: plain JSON so it's
// human-readable/diffable/hand-editable, with a content hash so a recipient
// can tell whether the file changed since it was exported — an integrity
// signal, not a security signature (no key involved, so it says "edited or
// corrupted since export," never "genuinely came from someone in particular").

export interface OakCartridge {
  format: 'oakcartridge';
  version: 1;
  name: string;
  description: string;
  category: string;
  source: string;
  exportedAt: number;
  contentHash: string;
}

export type CartridgeIntegrity = 'verified' | 'mismatch' | 'unsigned';

export interface CartridgeParseResult {
  def: IndicatorDef;
  integrity: CartridgeIntegrity;
}

// Deliberately excludes exportedAt: the hash identifies the CONTENT, so
// re-exporting the same unchanged indicator later reproduces the same hash.
function cartridgeDigestInput(name: string, description: string, category: string, source: string): string {
  return JSON.stringify({ name, description, category, source });
}

export async function buildCartridge(ind: IndicatorDef): Promise<OakCartridge> {
  const contentHash = await sha256Hex(cartridgeDigestInput(ind.name, ind.description, ind.category, ind.source));
  return {
    format: 'oakcartridge',
    version: 1,
    name: ind.name,
    description: ind.description,
    category: ind.category,
    source: ind.source,
    exportedAt: Date.now(),
    contentHash,
  };
}

/** Filesystem-safe filename for a cartridge — strips anything that isn't
 * alphanumeric/space/dash/underscore rather than trying to escape it. */
export function cartridgeFilename(name: string): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').slice(0, 80);
  return `${safe || 'indicator'}.oak.json`;
}

/**
 * Parses and validates an imported cartridge file's text. Throws on
 * structural problems (not JSON, wrong format, missing name/source) — those
 * are refused outright, not warned-and-allowed, since there's nothing
 * usable to import. A content-hash mismatch or absence is reported via
 * `integrity` instead of thrown: unlike structural validity, that's the
 * caller's/user's call on whether to proceed (a hand-edited cartridge is
 * expected to mismatch and is still perfectly usable).
 */
export async function parseCartridge(jsonText: string): Promise<CartridgeParseResult> {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e: any) {
    throw new Error(`Not valid JSON: ${e?.message || e}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('File does not contain a JSON object.');
  if (parsed.format !== 'oakcartridge') throw new Error('Not an OakCartridge file (missing or wrong "format" field).');
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) throw new Error('Cartridge is missing a valid "name".');
  if (typeof parsed.source !== 'string' || !parsed.source.trim()) throw new Error('Cartridge is missing a valid "source".');

  const description = typeof parsed.description === 'string' ? parsed.description : 'Imported indicator';
  const category = typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category : 'User Created';

  let integrity: CartridgeIntegrity = 'unsigned';
  if (typeof parsed.contentHash === 'string' && parsed.contentHash) {
    const recomputed = await sha256Hex(cartridgeDigestInput(parsed.name, description, category, parsed.source));
    integrity = recomputed === parsed.contentHash ? 'verified' : 'mismatch';
  }

  return { def: { name: parsed.name, description, category, source: parsed.source }, integrity };
}
