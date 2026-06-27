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

  // ─── Machine Learning ───────────────────────────────────────────
  {
    name: 'Lorentzian Classification',
    description: 'KNN classifier with Lorentzian distance kernel for trend prediction. '
      + 'Classifies bars as bullish/bearish by comparing feature-space similarity to historical bars. '
      + 'Renders prediction bands, confidence trail, and LONG/SHORT signals with confidence %.',
    category: 'Machine Learning',
    source: `// Lorentzian Classification — TradingVision Edition
// KNN with Lorentzian distance kernel
// Prediction band, confidence trail, LONG/SHORT signals on regime flips

// ─── Inputs ────────────────────────────────────────────────
k = input(8, "K Neighbors", 1, 30, 1)
lookback = input(100, "Lookback Period", 10, 500, 10)
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

// Current-bar feature values (these are scalars in OakScript)
rsiCur = rsi(close, rsiLen)
cciCur = cci(high, low, close, cciLen)
adxCur = adx(high, low, close, adxLen)
momCur = roc(close, momLen)

// Persistent feature & label history (one entry appended per bar)
varip rsiHist = array(0)
varip cciHist = array(0)
varip adxHist = array(0)
varip momHist = array(0)
varip closeHist = array(0)
varip targetHist = array(0)

// Determine previous close from history (offset indexing is unavailable)
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
bestDist = array()
bestTargets = array()
i = 0
while i < k {
    array.push(bestDist, 999999.0)
    array.push(bestTargets, 0)
    i := i + 1
}

numBars = array.size(rsiHist)
// Search only within the lookback window (and exclude the current bar)
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

// ─── Voting ────────────────────────────────────────────────
bullVotes = 0
bearVotes = 0
m = 0
while m < k {
    if bestDist[m] < 999999.0 {
        if bestTargets[m] == 1 { bullVotes := bullVotes + 1 }
        else { bearVotes := bearVotes + 1 }
    }
    m := m + 1
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

// ─── Signals only on regime FLIPS (no per-bar spam) ────────
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

// ─── Confidence trail in separate pane ─────────────────────
plot(signal * 100, "Confidence", "#b48cff", 2, "separate")
hline(0, "rgba(255,255,255,0.1)", "separate")
hline(50, "rgba(34,204,136,0.2)", "separate")
hline(0 - 50, "rgba(255,68,119,0.2)", "separate")`,

  },
];

export function getIndicators(): IndicatorDef[] {
  return INDICATORS;
}

export function getIndicatorByName(name: string): IndicatorDef | undefined {
  return INDICATORS.find(ind => ind.name === name);
}

export function getCategories(): string[] {
  const cats = new Set(INDICATORS.map(ind => ind.category));
  return Array.from(cats);
}
