export interface IndicatorDef {
  name: string;
  description: string;
  category: string;
  source: string;
}

const INDICATORS: IndicatorDef[] = [
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
    source: `// RSI 3D Surface
rsiLen = input(14, "RSI Length")
rsiVal = rsi(close, rsiLen)
plot3d(rsiVal, "RSI Surface", "surface", "#b48cff", "separate")`,
  },
  {
    name: 'Volume 3D Bars',
    description: 'Volume histogram as 3D bars — makes volume spikes pop out of the chart',
    category: '3D Visualizations',
    source: `// Volume 3D Bars
plot3d(volume, "Volume 3D", "bars3d", "#ffd43b", "separate")`,
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
plot3d(m.macd, "MACD", "ribbon", "#22aaff", "separate")
plot3d(m.signal, "Signal", "ribbon", "#ff8800", "separate")
plot3d(m.hist, "Histogram", "bars3d", "#8866ff", "separate")`,
  },
  {
    name: 'RSI Scatter',
    description: 'RSI values as colored 3D scatter plot — overbought/oversold regions visible by color gradient',
    category: '3D Visualizations',
    source: `// RSI 3D Scatter
rsiLen = input(14, "RSI Length")
rsiVal = rsi(close, rsiLen)
plot3d(rsiVal, "RSI Scatter", "scatter", "#ff6b6b", "separate")`,
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
    upCross = crossover(kVal, dVal)
    dnCross = crossunder(kVal, dVal)
    if upCross
        plotshape(bar_index, low, "Stoch BUY", "triangleup", "#22cc88")
    if dnCross
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
    if buyCross
        plotshape(bar_index, low, "BB BUY", "triangleup", "#22cc88")
    if sellCross
        plotshape(bar_index, high, "BB SELL", "triangledown", "#ff4477")`,
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
    source: `// ATR Trailing Stops
atrLen = input(14, "ATR Length")
mult = input(2.0, "ATR Multiplier", 0.5, 5.0, 0.5)
showSignals = input(true, "Show Signals")

atrVal = atr(high, low, close, atrLen)
upperBand = close + atrVal * mult
lowerBand = close - atrVal * mult

plot(upperBand, "Upper", "#ff4477", 1)
plot(lowerBand, "Lower", "#22cc88", 1)
fill(upperBand, lowerBand, "rgba(180,140,255,0.06)")

var inLong = false
longTrail = close > upperBand
shortTrail = close < lowerBand
buySig = longTrail and not inLong
sellSig = shortTrail and inLong
inLong := longTrail

if showSignals
    if buySig
        plotshape(bar_index, low, "ATR BUY", "triangleup", "#22cc88")
    if sellSig
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

if showSignals {
    if sigAge >= reqPersist and signalNow == 1 and prob >= minProb and confluence >= minConf {
        plotshape(bar_index, low, "LONG", "triangleup", "#00FF9F")
    }
    if sigAge >= reqPersist and signalNow == 0 - 1 and prob >= minProb and confluence >= minConf {
        plotshape(bar_index, high, "SHORT", "triangledown", "#FF006E")
    }
}

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

// Confluence dots (LDRA-style) when confidence is very high
if confidence >= 65 and bar_index >= lookback {
    if signal > 0
        plotshape(bar_index, low - atrVal * 0.3, "BULL CONF", "circle", "#22cc88")
    if signal < 0
        plotshape(bar_index, high + atrVal * 0.3, "BEAR CONF", "circle", "#ff4477")
}

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
var sos = 0.0
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
var volRing = oakring(10)
volRing.push(bestSim)
matchVol = volRing.stdev()
matchAvg = volRing.avg()

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
    if showSignals { plotshape(bar_index, pocPrice, "POC", "square", "#b48cff") }
}
wasPocBin := pocBin

// ─── Main chart + oscillator ──────────────────────────────────────
plot(close, "Price", "#ffffff", 1)
plot(pocPrice, "Point of Control", "#b48cff", 1)
plot(pocStrength * 100, "POC Strength", "#b48cff", 2, "separate")
plot(balanceScore * 100, "Balance", "#ffd43b", 1, "separate")
hline(0, "rgba(255,255,255,0.08)", "separate")

// ─── 3D — a real terrain built from real market-profile mechanics ─
// Manifold: liquidity concentration over time — the parallel ridges read
// as literal terrain contours. Colored by whether price sits inside the
// value area (calm) or has broken out of it (extended).
terrainCol = "#22cc88"
if not insideVA { terrainCol := "#ff8800" }
plot3d(pocStrength * 100, "Liquidity Terrain", "manifold", terrainCol, "separate")
// Torus: ring size = value area WIDTH — tight rings during consolidation,
// wide rings during expansion. A different question than POC strength.
plot3d(vaWidthPct, "Value Area Rings", "torus", "#4488ff", "separate")
// Scatter: per-bar volume balance cloud — a speckled texture of where
// volume has been landing relative to the point of control.
plot3d(balanceScore * 100, "Volume Balance Cloud", "scatter", "#ffd43b", "separate")
// Trail: distance from POC as a percent of the rolling range — thickens
// when price is extended away from the point of control, thins when
// price is magnetized back toward it.
distFromPOC = abs(close - pocPrice) / rng * 100
plot3d(distFromPOC, "POC Distance", "trail", "#b48cff", "separate")

// ─── Background tint ─────────────────────────────────────────────
if not insideVA { bgcolor("rgba(255,136,0,0.04)") }
if nearPOC { bgcolor("rgba(180,140,255,0.05)") }`,
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
    description: 'User-created indicator',
    category: 'User Created',
    source,
  };
  if (existing >= 0) {
    userInds[existing] = def;
  } else {
    userInds.push(def);
  }
  localStorage.setItem(USER_INDICATORS_KEY, JSON.stringify(userInds));
}

export function removeUserIndicator(name: string): void {
  const userInds = getUserIndicators().filter(i => i.name !== name);
  localStorage.setItem(USER_INDICATORS_KEY, JSON.stringify(userInds));
}
