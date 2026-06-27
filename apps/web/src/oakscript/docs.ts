export interface DocSection {
  title: string;
  content: string;
}

export function getDocumentation(): DocSection[] {
  return [
    {
      title: 'Overview',
      content: `OakScript is a PineScript-inspired scripting language for the TradingVision platform.
It executes bar-by-bar across historical data, computing technical indicators and generating chart plots.

Key concepts:
- Bar-by-bar execution — your script runs once for each bar in the dataset
- Series access — close, open, high, low, volume, time give the current bar's values
- Persistent state — var and varip keep values between bars and recalculations
- Built-in library — sma, ema, rsi, macd, crossover, and many more
- Chart integration — plot(), plotshape(), hline(), bgcolor() render directly on the chart`,
    },
    {
      title: 'Comments',
      content: `// Single-line comment — everything after // is ignored

/* Multi-line
   comment */`,
    },
    {
      title: 'Literals & Data Types',
      content: `Numbers:   42, 3.14, -7, 100.0
Strings:   "hello", 'hello'  (single or double quotes)
Booleans:  true, false
Nil:       null, nil
Arrays:    [1, 2, 3], ["a", "b", "c"]

Type coercion: Numbers, strings, booleans, and nil interoperate freely.
  - nil/null is falsy
  - 0 and NaN are falsy
  - Empty string "" is falsy
  - Everything else is truthy`,
    },
    {
      title: 'Variables & Assignment',
      content: `Regular variable:
    x = 10
    name = "AAPL"

Reassignment:
    x := x + 1
    x = x + 1

Persistent variable (survives across bars):
    var total = 0.0
    total := total + close

Varip variable (survives across bars AND full recalculations):
    varip count = 0
    count := count + 1

Difference: var resets when script re-runs on new data; varip persists across full re-executions.

Built-in variables (read-only):
    close      — current bar's closing price
    open       — current bar's opening price
    high       — current bar's high
    low        — current bar's low
    volume     — current bar's volume
    time       — current bar's timestamp (unix ms)
    bar_index  — current bar index (0-based)
    barstate   — object with isnew, isrealtime, isconfirmed`,
    },
    {
      title: 'Operators',
      content: `Arithmetic:   +  -  *  /  %
Comparison:  ==  !=  <  >  <=  >=  =>
Logical:     and  or  not  !
Unary:       -  !
Assignment:  =  :=

String concatenation:
    "Hello " + "World"    → "Hello World"`,
    },
    {
      title: 'Conditionals',
      content: `if condition
    statement

if condition
    statement1
    statement2
else
    statement3

if condition
    statement
else if otherCondition
    statement
else
    statement

Braces are optional for single statements. For multiple statements,
indent them under the if/else (PineScript style) or use { } blocks.`,
    },
    {
      title: 'Loops',
      content: `// Numeric for loop
for i = 0 to 10
    statement

for i = 0 to 10 by 2
    statement

for i = 10 downto 0
    statement

// For-in loop (iterate array elements)
for val in array
    statement

// C-style for loop
for (var i = 0; i < 10; i = i + 1)
    statement

// While loop
while condition
    statement

Loop control: break, continue`,
    },
    {
      title: 'Arrays',
      content: `// Create array
arr = [1, 2, 3]
arr = array(size)     // pre-allocate

// Array operations
array.get(arr, index)   — get element
array.set(arr, index, val) — set element
array.push(arr, val)    — append
array.pop(arr)          — remove & return last
array.size(arr)         — length

// Index access
value = arr[0]
arr[1] = 42`,
    },
    {
      title: 'Input Parameters',
      content: `input() makes your indicator adjustable through the UI.

// Number input
len = input(14, "Length")

// Number with range
len = input(14, "RSI Length", 1, 50, 1)
    //                          min max step

// Boolean input
useFilter = input(true, "Use Filter")

// String input
label = input("Custom", "Label Text")

When an indicator is selected from the menu, inputs appear
as interactive controls below the editor.`,
    },
    {
      title: 'Plotting (2D)',
      content: `// Plot a line on the chart or lower pane
plot(value, title, color, linewidth, pane?)
  pane: "main" (default) or "separate" (lower pane)

// Plot a shape marker on the chart
plotshape(bar_index, price, title, style, color, pane?)

// Horizontal reference line
hline(price, color, pane?)

// Fill between two plot values
fill(top, bottom, color)

// Background color for a bar
bgcolor(color)

// Label on the chart
label.new(x, y, text, color)

Shape styles: triangleup, triangledown, circle, cross, xcross,
              square, diamond, arrowup, arrowdown

Examples:
    plot(close, "Close", "#ffffff", 1)
    plot(rsiVal, "RSI", "#b48cff", 2, "separate")
    plotshape(bar_index, low, "BUY", "triangleup", "#22cc88")
    hline(70, "#ff4477")
    hline(30, "#22cc88", "separate")
    bgcolor("rgba(255,0,0,0.1)")`,
    },
    {
      title: '3D Plotting (plot3d)',
      content: `// Render indicator data as a 3D visualization
plot3d(series, name, style, color, pane?)

  series — any indicator array (rsi(), volume, macd.macd, etc.)
  name   — title displayed in the 3D scene
  style  — visualization type
  color  — hex color string
  pane   — "main" (chart overlay) or "separate" (lower pane)

3D Visualization Styles:
  "surface"   — Colored mesh surface flowing through time. Best for
                oscillators (RSI, Stochastics, CCI)
  "ribbon"    — Glowing tube trace with transparency aura. Best for
                MACD lines, moving averages, trend indicators
  "bars3d"    — 3D columns sized by value. Best for volume,
                histogram data, delta
  "scatter"   — HSL-color-coded spheres. Best for spotting
                overbought/oversold clusters, divergence
  "line3d"    — Same as ribbon but thinner (alias)

Panes:
  "separate"  — Renders in the 3D lower pane below the chart.
                Multiple plot3d("separate") calls stack side-by-side.
                Replaces the secondary 2D pane automatically.
  "main"      — Renders as a 3D overlay on the main chart area.
                The surface/ribbon floats above the price action.

Examples:
    // RSI as a 3D surface in the lower pane
    rsiVal = rsi(close, 14)
    plot3d(rsiVal, "RSI", "surface", "#b48cff", "separate")

    // Volume as 3D bars — spikes pop out dramatically
    plot3d(volume, "Volume", "bars3d", "#ffd43b", "separate")

    // MACD with multiple layers
    m = macd(close, 12, 26, 9)
    plot3d(m.macd, "MACD", "ribbon", "#22aaff", "separate")
    plot3d(m.signal, "Signal", "ribbon", "#ff8800", "separate")

    // 3D surface floating above price on main chart
    plot3d(close, "Price Surface", "surface", "#22cc88", "main")

    // RSI as scatter plot — overbought/oversold visible by color
    plot3d(rsi(close, 14), "RSI Scatter", "scatter", "#ff6b6b", "separate")

Limitations:
  - plot3d emits once per full execution (not per-bar). Arrays
    are reconstructed from the series history.
  - Only one 3D scene exists per pane. Multiple plot3d calls
    in the same pane stack as layers within the same scene.
  - The lower pane switches between 2D (plot with "separate")
    and 3D (plot3d with "separate") automatically. They cannot
    coexist — 3D takes priority.
  - 3D rendering uses Three.js (WebGL). Performance depends on
    series length — longer series = more geometry. Use
    performance mode to reduce quality if needed.
  - Surface/ribbon styles work best with 100+ bars of data.
    Less than 20 bars may produce sparse geometry.`,
    },
    {
      title: 'Alerts & Webhooks',
      content: `// Fire an alert
alert("Price crossed above SMA 50")

// Conditional alert
alertcondition(condition, "Title", "Message")
// Only fires when condition is true

Alerts are sent as browser notifications and POSTed
to the configured webhook URL (JSON payload).`,
    },
    {
      title: 'Standard Library — Moving Averages',
      content: `sma(source, length)
    Simple Moving Average
    Returns array of SMA values

ema(source, length)
    Exponential Moving Average
    Uses multiplier = 2 / (length + 1)

macd(source, fast, slow, signal)
    MACD indicator
    Returns object with .macd, .signal, .hist arrays
    Access: macdLine = macd(close, 12, 26, 9)
    (Returns the macd line by default)`,
    },
    {
      title: 'Standard Library — Oscillators',
      content: `rsi(source, length)
    Relative Strength Index

cci(high, low, close, length)
    Commodity Channel Index
    Formula: (TP - SMA(TP, n)) / (0.015 × StdDev(TP, n))
    where TP = (H + L + C) / 3

adx(high, low, close, length)
    Average Directional Index
    Measures trend strength (not direction)

roc(source, length)
    Rate of Change (%)
    ROC = ((price - price[n]) / price[n]) × 100

stdev(source, length)
    Standard Deviation`,
    },
    {
      title: 'Standard Library — Volume & Volatility',
      content: `vwap(close, volume)
    Volume Weighted Average Price
    Cumulative (V × P) / Cumulative V

atr(high, low, close, length)
    Average True Range (EMA of True Range)
    True Range = max(H-L, |H-C[1]|, |L-C[1]|)

trueRange(high, low, close)
    True Range array (before smoothing)`,
    },
    {
      title: 'Standard Library — Signal Detection',
      content: `crossover(a, b)
    Returns true when series a crosses above series b
    (previous a <= previous b AND current a > current b)

crossunder(a, b)
    Returns true when series a crosses below series b
    (previous a >= previous b AND current a < current b)

barssince(condition)
    Returns number of bars since condition was true
    Returns -1 if never true

highest(source, length)
    Highest value over last ` + "`length`" + ` bars

lowest(source, length)
    Lowest value over last ` + "`length`" + ` bars

cum(source)
    Cumulative sum

change(source)
    Difference from previous bar: source - source[1]

linreg(source, length, offset)
    Linear regression (currently SMA-based approximation)

correlation(a, b, length)
    Pearson correlation coefficient`,
    },
    {
      title: 'Math Utilities',
      content: `abs(x)       — absolute value
min(a, b)    — minimum
max(a, b)    — maximum
floor(x)     — round down
ceil(x)      — round up
round(x)     — round to nearest integer
sqrt(x)      — square root
log(x)       — natural logarithm
exp(x)       — e^x
sin(x)       — sine (radians)
cos(x)       — cosine
tan(x)       — tangent
tostring(x)  — convert to string
tonumber(x)  — convert to number`,
    },
    {
      title: 'String Functions',
      content: `str.format("Price: {}", close)
    Replaces {} with values

str concatenation:
    "Value: " + tostring(close)

Comparison:
    "hello" == "hello"   → true`,
    },
    {
      title: 'Execution Model',
      content: `1. OakScript runs your code once per bar, from bar 0 to the last bar
2. Before execution, built-in variables are set: close, open, high, low, volume, time, bar_index
3. var variables persist their values from the previous bar
4. varip variables persist across full script recalculations (e.g., when changing inputs)
5. Regular variables are re-computed each bar from scratch
6. Plot, plotshape, hline, bgcolor calls are collected and rendered on the chart
7. Errors on individual bars are captured and displayed without stopping execution`,
    },
    {
      title: 'Example: RSI Divergence',
      content: `// RSI Divergence Detector
rsiLen = input(14, "RSI Length")
ob = input(70, "Overbought")
os = input(30, "Oversold")

rsiVal = rsi(close, rsiLen)

// Track swing highs/lows
var prevHigh = 0.0
var prevRsiHigh = 0.0
var prevLow = 999999.0
var prevRsiLow = 0.0

if crossunder(rsiVal, ob)
    prevHigh := high
    prevRsiHigh := rsiVal

if crossover(rsiVal, os)
    prevLow := low
    prevRsiLow := rsiVal

// Bearish divergence: price higher, RSI lower
if prevHigh > 0 and high > prevHigh and rsiVal < prevRsiHigh
    plotshape(bar_index, high, "BEAR DIV", "triangledown", "#ff4477")

// Bullish divergence: price lower, RSI higher
if prevLow < 999999 and low < prevLow and rsiVal > prevRsiLow
    plotshape(bar_index, low, "BULL DIV", "triangleup", "#22cc88")

plot(rsiVal, "RSI", "#b48cff", 2)
hline(ob, "#ff4477")
hline(os, "#22cc88")`,
    },
    {
      title: 'Example: Bollinger Bands',
      content: `// Bollinger Bands
len = input(20, "Length")
mult = input(2.0, "StdDev Multiplier", 0.5, 4.0, 0.5)

mid = sma(close, len)
std = stdev(close, len)
upper = mid + std * mult
lower = mid - std * mult

plot(mid, "Middle", "#b48cff", 2)
plot(upper, "Upper", "#ff4477", 1)
plot(lower, "Lower", "#22cc88", 1)

// Price touching upper band
if crossover(close, upper)
    plotshape(bar_index, high, "OVER", "triangledown", "#ff4477")

if crossunder(close, lower)
    plotshape(bar_index, low, "UNDER", "triangleup", "#22cc88")`,
    },
    {
      title: 'Keyboard Shortcuts',
      content: `E           — Toggle OakScript editor
Ctrl+Enter  — Run script
Ctrl+S      — Save script (in editor)
Esc         — Close editor`,
    },
  ];
}
