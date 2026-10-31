export interface DocSection {
  title: string;
  content: string;
}

export function getDocumentation(): DocSection[] {
  return [
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Overview',
      content: `OakScript is the DAFE Charts signal analysis model scripting language — a PineScript-inspired
bar-by-bar execution engine that computes technical signal analysis models and renders them on
the chart in both 2D and 3D.

KEY PRINCIPLES:
- Your script runs once for every bar in the dataset, oldest bar first
- Built-in variables (close, open, high, low, volume, time, bar_index)
  are automatically set to the current bar's values before each execution
- var variables persist their value from one bar to the next
- varip variables persist across full script recalculations
- All plot calls (plot, plotshape, hline, plot3d, etc.) are collected
  during execution and rendered together on the final chart`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Comments',
      content: `// Single-line comment — everything after // on the line is ignored

/* Multi-line
   comment — C-style block comments */

Use comments to document your signal analysis model logic. The Trade Advisor agent can
read your comments to understand intent when fixing or enhancing code.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Literals & Data Types',
      content: `Numbers:   42, 3.14, -7, 100.0
Strings:   "hello", 'hello'  (single or double quotes — MUST be quoted)
Booleans:  true, false
Nil:       null, nil
Arrays:    [1, 2, 3], ["a", "b", "c"]

Falsy values (treated as false in conditions):
  null, nil, 0, NaN, "" (empty string)
Everything else is truthy.

CRITICAL: String arguments in function calls MUST be quoted.
  Correct:   plot3d(v, "RSI", "surface", "#b48cff", "separate")
  Wrong:     plot3d(v, RSI, surface, #b48cff, separate)  ← SYNTAX ERROR`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Variables & Assignment',
      content: `Assignment (declare or reassign):
    x = 10
    name = "AAPL"

Reassignment operator (required when changing a value from outer scope):
    x := x + 1     // reassign with :=
    x = x + 1      // also valid

Persistent variable — survives across bars, but RESETS when script is reloaded:
    var total = 0.0
    total := total + close

Varip variable — survives across bars AND full recalculations:
    varip counter = 0
    counter := counter + 1

Use var for state that resets when you change inputs.
Use varip for state that must survive input changes (rare).

Built-in variables (read-only, set per bar):
    close       — current bar's closing price
    open        — current bar's opening price
    high        — current bar's high price
    low         — current bar's low price
    volume      — current bar's trading volume
    time        — current bar's timestamp (unix milliseconds)
    bar_index   — current bar index (0 = first bar in dataset)
    barstate    — object: { isnew, isrealtime, isconfirmed }`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Operators',
      content: `Arithmetic:   +  -  *  /  %
Comparison:  ==  !=  <  >  <=  >=  =>  (use == not = in conditions!)
Logical:     and  or  not  !
Unary:       -  !

Ternary (conditional) — cond ? valueIfTrue : valueIfFalse
  Evaluated every bar. The KEY to dynamic, data-driven signal analysis models:
    trend = close > ema(close,50) ? 1 : -1
    col   = rsi(close,14) > 70 ? "#ff4477" : "#22cc88"
  Ternaries nest (right-associative):
    zone = r > 70 ? "#ff4477" : r < 30 ? "#22cc88" : "#888888"

String concatenation:
    "Hello " + "World"    → "Hello World"
    "Price: " + tostring(close)`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Control Flow',
      content: `Both block styles below are valid OakScript syntax. Braces are the
SAFER choice for any block with more than one statement — use them whenever
in doubt, especially for nested if/while/for or loop bodies.

Brace blocks (recommended for multi-statement bodies):
    if condition {
        statement1
        statement2
    } else {
        statement3
    }

    while condition {
        statement1
        statement2
    }

Indentation blocks (PineScript style, single line or simple bodies):
    if condition
        statement

    if condition
        statement1
        statement2
    else
        statement3

    if condition
        action1
    else if otherCondition
        action2
    else
        action3

For loop:
    for i = 0 to 10
        statement

    for i = 0 to 10 by 2        // step by 2

    for i = 10 downto 0          // count down

    for (var i = 0; i < 10; i = i + 1)   // C-style

While loop:
    while condition
        statement

Loop control:  break   continue

CRITICAL — indentation-block rule: every statement in a brace-less block
must start at the EXACT SAME column as the block's first statement. The
block ends at the first line that dedents to a shallower column. Mixing
tab/space indentation, or indenting two statements of the same block
differently, silently breaks the block boundary — a later statement (e.g. a
loop counter's increment/decrement) can end up OUTSIDE the loop it was meant
to be part of, which can produce an infinite loop. When a block has more
than one statement, or contains nested if/while/for, prefer { } braces —
they have no indentation requirement and cannot misparse this way.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Arrays — Complete Reference',
      content: `Arrays are the foundation of advanced signal analysis model logic — order queues, scale-in
levels, performance histories, adaptive metrics, and state machines all use arrays.

═══════════════════════════════════════════════════════════════════
ARRAY CREATION
═══════════════════════════════════════════════════════════════════

    arr = []                // empty array literal
    arr = [1, 2, 3]         // literal with values
    arr = array(10)         // pre-allocate size 10 (sparse)

═══════════════════════════════════════════════════════════════════
CORE OPERATIONS (PineScript-compatible)
═══════════════════════════════════════════════════════════════════

    array.get(arr, i)       — get element at index i
    array.set(arr, i, val)  — set element at index i
    array.push(arr, val)    — append value to end
    array.pop(arr)          — remove & return last element (LIFO)
    array.shift(arr)        — remove & return first element (FIFO)
    array.size(arr)         — number of elements

    Index shortcut:
    value = arr[0]          — same as array.get(arr, 0)
    arr[0] = 42             — same as array.set(arr, 0, 42)

═══════════════════════════════════════════════════════════════════
QUEUE & ORDER MANAGEMENT
═══════════════════════════════════════════════════════════════════

    array.unshift(arr, val) — insert at beginning
    array.remove(arr, i)    — remove element at index i
    array.insert(arr, i, v) — insert value v at index i
    array.clear(arr)        — remove all elements

    FIFO queue pattern (pending orders):
    if condition
        array.push(que, id)     // enqueue
    if fillCondition
        id = array.shift(que)   // dequeue

    LIFO stack pattern (recent values):
    array.push(stack, price)
    if someCondition
        last = array.pop(stack)

═══════════════════════════════════════════════════════════════════
SEARCH & INSPECTION
═══════════════════════════════════════════════════════════════════

    array.includes(arr, val) — true if val exists in arr
    array.indexOf(arr, val)  — first index of val, or -1
    array.head(arr, n)       — first n elements
    array.tail(arr, n)       — last n elements

═══════════════════════════════════════════════════════════════════
TRANSFORMATION
═══════════════════════════════════════════════════════════════════

    array.slice(arr, from, to)  — extract sub-array [from, to)
    array.copy(arr)             — shallow copy
    array.reverse(arr)          — reverse in place
    array.sort(arr, "asc")      — sort ascending (default)
    array.sort(arr, "desc")     — sort descending
    array.fill(arr, val)        — fill all with val
    array.fill(arr, val, 2, 5)  — fill indices 2..4 with val
    array.join(arr, ",")        — join elements into string

═══════════════════════════════════════════════════════════════════
STATISTICAL (numeric arrays)
═══════════════════════════════════════════════════════════════════

    array.sum(arr)           — sum of all numeric elements
    array.avg(arr)           — arithmetic mean
    array.min(arr)           — minimum value
    array.max(arr)           — maximum value
    array.median(arr)        — median value
    array.stdev(arr)         — population standard deviation
    array.percentile(arr, p) — p-th percentile (0-100)

═══════════════════════════════════════════════════════════════════
GENERATION
═══════════════════════════════════════════════════════════════════

    array.range(start, end, step?) — arithmetic progression
    array.range(0, 10)        → [0,1,2,3,4,5,6,7,8,9,10]
    array.range(0, 10, 2)     → [0,2,4,6,8,10]
    array.range(10, 0)        → [10,9,8,7,6,5,4,3,2,1,0]

═══════════════════════════════════════════════════════════════════
INDEX ACCESS
═══════════════════════════════════════════════════════════════════

    arr[0]     — first element
    arr[size-1] — last element
    arr[size]  — nil (out of bounds returns null)

═══════════════════════════════════════════════════════════════════
ADVANCED PATTERNS
═══════════════════════════════════════════════════════════════════

── 1. Capped FIFO Queue (safePush pattern) ──
    var buf = []
    safePush(val) =>
        if array.size(buf) >= 50
            array.shift(buf)     // evict oldest
        array.push(buf, val)

── 2. Parallel Arrays (pseudo-multi-dim) ──
    var prices = []
    var sizes = []
    var times = []
    addOrder(price, size) =>
        array.push(prices, price)
        array.push(sizes, size)
        array.push(times, bar_index)

── 3. Scale-In Levels ──
    var scalePrices = []
    var scaleSizes = []
    for i = 1 to 3
        array.push(scalePrices, close - atr(high,low,close,14) * 0.5 * i)
        array.push(scaleSizes, 1)

── 4. Rolling Performance History ──
    var pnlHist = []
    updatePnl(pnl) =>
        safePush(pnlHist, pnl)
        winRate = array.avg(array.map... ??)  // use statistical methods
        avgWin = array.avg(array.head(pnlHist, 20))

── 5. Cooldown Tracker ──
    var missHistory = []
    trackFill(success) =>
        safePush(missHistory, success ? 0 : 1)
        missRate = array.avg(missHistory)
        // adapt position size based on missRate
        posSize = missRate > 0.5 ? 0.5 : 1.0

── 6. Safe Access Helper ──
    safeGet(arr, i) =>
        if i >= 0 and i < array.size(arr)
            arr[i]
        else
            0`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'OakRing — Circular Buffer',
      content: `OakRing is a fixed-size circular buffer (ring buffer) that automatically
overwrites the oldest value when full. Unlike arrays, OakRing has bounded
memory — push a million values and it still uses exactly N slots.

Perfect for rolling windows, real-time tick buffers, and any streaming
computation where you only care about the last N values.

═══════════════════════════════════════════════════════════════════
CREATION
═══════════════════════════════════════════════════════════════════

    ring = oakring(20)       // ring buffer of capacity 20
    ring = oakring()         // default capacity 10

═══════════════════════════════════════════════════════════════════
METHODS
═══════════════════════════════════════════════════════════════════

    ring.push(val)           — append value (auto-evicts oldest if full)
    ring.pop()               — remove & return last (newest)
    ring.clear()             — empty the buffer
    ring.toArray()           — export as plain array [oldest..newest]
    ring.fill(val)           — fill all slots with val

═══════════════════════════════════════════════════════════════════
PROPERTIES
═══════════════════════════════════════════════════════════════════

    ring.size                — number of elements currently stored
    ring.capacity            — maximum capacity (fixed at creation)

═══════════════════════════════════════════════════════════════════
ACCESSORS
═══════════════════════════════════════════════════════════════════

    ring.first()             — oldest element (first pushed)
    ring.last()              — newest element (last pushed)
    ring[0]                  — newest element (last pushed)
    ring[1]                  — second newest
    ring[size-1]             — oldest (same as ring.first())

═══════════════════════════════════════════════════════════════════
STATISTICS (numeric buffers)
═══════════════════════════════════════════════════════════════════

    ring.sum()               — sum of all elements
    ring.avg()               — arithmetic mean
    ring.min()               — minimum value
    ring.max()               — maximum value
    ring.median()            — median value
    ring.std()               — population standard deviation
    ring.percentile(p)       — p-th percentile (0-100)

═══════════════════════════════════════════════════════════════════
USE CASES
═══════════════════════════════════════════════════════════════════

── 1. Rolling ATR Buffer ──
    var atrRing = oakring(14)
    tr = max(high - low, abs(high - close[1]), abs(low - close[1]))
    atrRing.push(tr)
    avgAtr = atrRing.avg()       // rolling mean of last 14 TR values

── 2. Tick Pressure Monitor ──
    var tickRing = oakring(100)
    tickRing.push(close > close[1] ? 1 : close < close[1] ? -1 : 0)
    pressure = tickRing.avg()    // -1 to 1, direction bias

── 3. Fill Miss Rate ──
    var fillRing = oakring(50)
    fillRing.push(fillSuccess ? 0 : 1)
    if fillRing.avg() > 0.6
        // reduce position size — too many misses

── 4. Rolling Volatility ──
    var volRing = oakring(20)
    volRing.push(roc(close, 1))
    vol = volRing.std()          // rolling standard deviation of returns`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Matrix — 2D Grid',
      content: `Matrix provides two-dimensional grid storage for multi-variable data,
covariance calculations, portfolio analysis, and advanced mathematical
operations on trading data.

═══════════════════════════════════════════════════════════════════
CREATION
═══════════════════════════════════════════════════════════════════

    m = matrix(3, 3)             // 3×3 zero matrix
    m = matrix(2, 4, 1.0)        // 2×4 matrix filled with 1.0

═══════════════════════════════════════════════════════════════════
METHODS
═══════════════════════════════════════════════════════════════════

    m.get(row, col)              — get element at (r, c)
    m.set(row, col, val)         — set element at (r, c)
    m.row(r)                     — get row r as array
    m.col(c)                     — get column c as array
    m.sum()                      — sum of all elements
    m.transpose()                — return new transposed matrix
    m.multiply(other)            — matrix multiplication
    m.add(other)                 — element-wise addition
    m.subtract(other)            — element-wise subtraction
    m.toArray()                  — export as 2D array

═══════════════════════════════════════════════════════════════════
PROPERTIES
═══════════════════════════════════════════════════════════════════

    m.rows                       — number of rows
    m.cols                       — number of columns

═══════════════════════════════════════════════════════════════════
INDEX ACCESS
═══════════════════════════════════════════════════════════════════

    m[0]                         — first row (as array)
    m[0][1]                      — element at row 0, column 1

═══════════════════════════════════════════════════════════════════
USE CASES
═══════════════════════════════════════════════════════════════════

── 1. Multi-Symbol Correlation Matrix ──
    // Track 3 symbols' returns in a 3×N window
    var corrMat = matrix(3, 3)

── 2. Covariance-Based Position Sizing ──
    // Build covariance matrix from asset returns
    // Use matrix operations to compute optimal weights

── 3. Feature Matrix for ML ──
    // Store [rsi, macd, volume, atr] per bar as rows
    var features = matrix(100, 4)
    barIdx = bar_index
    if barIdx < 100
        features.set(barIdx, 0, rsi(close, 14))
        features.set(barIdx, 1, macd(close, 12, 26, 9).macd)
        features.set(barIdx, 2, volume)
        features.set(barIdx, 3, atr(high, low, close, 14))

── 4. Portfolio Weights ──
    // weights × returns = portfolio return
    weights = matrix(1, 3)
    weights.set(0, 0, 0.5)
    weights.set(0, 1, 0.3)
    weights.set(0, 2, 0.2)
    returns = matrix(3, 1)
    returns.set(0, 0, roc(close, 1))
    portfolioReturn = weights.multiply(returns)`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Input Parameters',
      content: `input() makes your signal analysis model adjustable through the UI settings panel.

Number input:
    len = input(14, "Length")

Number with min/max/step:
    len = input(14, "RSI Length", 1, 50, 1)

Boolean toggle:
    useFilter = input(true, "Use Filter")

String input:
    label = input("Custom", "Label Text")

Inputs appear as interactive sliders/toggles in the inputs panel when
the signal analysis model is selected. Users can adjust them without touching code.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: '2D Plotting — Lines & Overlays',
      content: `plot(value, title, color, linewidth, style?, pane?)
  Renders a series on the chart. Each bar gets one plot point.
  - value:      number to plot (close, rsi(close,14), custom formula)
  - title:      string — displayed in legend and value label
  - color:      hex/rgba string — MAY CHANGE EVERY BAR (see conditional color)
  - linewidth:  number — 1=thin, 2=medium, 3=thick, 4+=bold
  - style:      render style (see below) — defaults to "line"
  - pane:       "main" (default, overlays price chart) or "separate" (lower pane)
  The 5th arg may be a style OR the pane; "separate" is always recognized as pane.

PLOT RENDER STYLES (use the quoted string):
  "line"       — smooth glowing polyline (default)
  "stepline"   — right-angled steps (state/threshold series)
  "area"       — line with a translucent fill down to the zero baseline
  "histogram"  — vertical bars from zero baseline (MACD hist, momentum)
  "columns"    — alias of histogram (volume columns)
  "circles"    — a dot at each bar
  "cross"      — a plus mark at each bar

CONDITIONAL / PER-BAR COLOR (the heart of expressive signal analysis models):
  Because plot() runs every bar, pass a color expression and the line is
  painted segment-by-segment in that bar's color:
    c = close > open ? "#22cc88" : "#ff4477"
    plot(close, "Price", c, 2)               // green up-bars, red down-bars
    plot(rsi(close,14), "RSI",
         rsi(close,14) > 70 ? "#ff4477" : rsi(close,14) < 30 ? "#22cc88" : "#888", 2, "separate")

COLOR HELPERS:
  color.new(baseColor, transp)   — transp 0 (opaque) .. 100 (fully transparent)
  color.rgb(r, g, b, transp?)    — channels 0..255, optional transp 0..100
  color.from_gradient(value, bottomValue, topValue, bottomColor, topColor)
    — interpolates between the two colors as value moves through the range.
    heat = color.from_gradient(r, 0, 100, "#22cc88", "#ff4477")
    plot(r, "RSI Heat", heat, 2, "separate")
    glassFill = color.new("#22aaff", 80)     // 20% opacity blue
    plot(vwap(close,volume), "VWAP", color.rgb(180,140,255,20), 2)

hline(value, color, pane?)
  Draws a dashed horizontal reference line at the given value.
  CONSTANTS ONLY (e.g. RSI 70/30) — for DYNAMIC levels (fibs, pivots,
  moving S/R) use plot(level, "Title", "#hex", 1, "stepline") so the
  line follows the level instead of leaving old copies behind.
  - value: number — price level or signal analysis model threshold
  - color: hex string
  - pane: "main" or "separate"

fill(top, bottom, color)
  Fills the area between two plot values with a translucent color.
  - top:    number — upper boundary value per bar
  - bottom: number — lower boundary value per bar
  - color:  hex string — typically use rgba() for transparency

bgcolor(color)
  Colors the ENTIRE background column behind the current bar.
  - color: hex or rgba string — use low alpha for subtle shading

EXAMPLES:
    plot(close, "Price", "#ffffff", 2)
    plot(sma(close, 50), "SMA 50", "#b48cff", 2)
    plot(rsi(close, 14), "RSI", "#22cc88", 2, "separate")
    hline(70, "#ff4477", "separate")           // RSI overbought line
    hline(30, "#22cc88", "separate")           // RSI oversold line
    fill(upper, lower, "rgba(180,140,255,0.08)")  // band fill
    bgcolor("rgba(255,68,119,0.06)")           // subtle red tint`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Combining, Layering & Manipulating — Cookbook',
      content: `OakScript rewards composition. Stack plots, drive colors from data,
and blend translucent layers to build expressive, "works-of-art" signal analysis models —
the same way you would in PineScript. Recipes:

── 1. Heatmap line (per-bar color from value) ──
  r = rsi(close, 14)
  c = r > 70 ? "#ff4477" : r < 30 ? "#22cc88" : color.new("#b48cff", 30)
  plot(r, "RSI Heat", c, 2, "separate")
  hline(70, color.new("#ff4477", 40), "separate")
  hline(30, color.new("#22cc88", 40), "separate")

── 2. Gradient cloud (area + translucent fill between bands) ──
  basis = sma(close, 20)
  dev   = 2 * stdev(close, 20)
  upper = basis + dev
  lower = basis - dev
  plot(basis, "Basis", color.new("#b48cff", 10), 2)
  plot(upper, "Upper", color.new("#22aaff", 50), 1, "area")
  fill(upper, lower, color.new("#22aaff", 88))     // soft volatility cloud

── 3. Momentum histogram + signal line (layered MACD) ──
  m = macd(close, 12, 26, 9)
  hcol = m.hist > 0 ? "#22cc88" : "#ff4477"
  plot(m.hist,   "Hist",   hcol,      1, "histogram", "separate")
  plot(m.macd,   "MACD",   "#22aaff", 2, "separate")
  plot(m.signal, "Signal", "#ff8800", 2, "separate")

── 4. Trend ribbon (stacked EMAs colored by slope) ──
  e1 = ema(close, 8)
  e2 = ema(close, 21)
  rc = e1 > e2 ? color.new("#22cc88", 20) : color.new("#ff4477", 20)
  plot(e1, "Fast", rc, 2)
  plot(e2, "Slow", rc, 2)
  fill(e1, e2, e1 > e2 ? color.new("#22cc88", 85) : color.new("#ff4477", 85))

── 5. State background + signal markers (full dashboard) ──
  bull = close > ema(close, 50)
  bgcolor(bull ? color.new("#22cc88", 94) : color.new("#ff4477", 94))
  if crossover(ema(close,9), ema(close,21))
      plotarrow(bar_index, low, "Buy", "up", "#22cc88")
  if crossunder(ema(close,9), ema(close,21))
      plotarrow(bar_index, high, "Sell", "down", "#ff4477")
  plotchar(bar_index, high, bull ? "▲" : "▼", bull ? "#22cc88" : "#ff4477")

── 6. 2D + 3D fusion ──  (see the 3D Plotting section)
  Combine any of the above with plot3d(series, name, style, color, "separate")
  to project the signal analysis model into an orbitable 3D scene beneath the chart.

LAYERING PRINCIPLES:
  • Order matters — later plot() calls draw on top.
  • Use color.new(c, 80..95) for fills/backgrounds so layers stay readable.
  • Drive color/linewidth/value from ternaries on signal analysis models for "living" plots.
  • Keep heavy fills subtle; let one bright line lead the eye.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: '2D Plotting — Shapes & Labels',
      content: `plotshape(bar_index, price, title, style, color, pane?)
  Places a shape marker at a specific bar + price.
  - bar_index: number — the bar index to place the marker on
  - price:     number — y-position (price level)
  - title:     string — label shown next to the shape
  - style:     string — shape type (see below)
  - color:     hex string
  - pane:      "main" or "separate"

Shape styles (use the STRING value, not unquoted):
  "triangleup"    — ▲ green buy signal (placed below bar, adaptive gap)
  "triangledown"  — ▼ red sell signal (placed above bar, adaptive gap)
  "circle"        — ● dot marker
  "cross"         — ✕ cross marker
  "xcross"        — diagonal cross
  "square"        — ■ square marker
  "diamond"       — ◆ diamond marker
  "arrowup"       — ↑ upward arrow (placed below bar, adaptive gap)
  "arrowdown"     — ↓ downward arrow (placed above bar, adaptive gap)
  "label"         — draws the title text itself as the marker
  All nine styles render as distinct glyphs (no fallback dots).

plotarrow(bar_index, price, title, direction, color?, pane?)
  Convenience wrapper that draws a directional arrow.
  - direction: "up" (default, green) or "down" (red)
  - Equivalent to plotshape(..., "arrowup"/"arrowdown", ...)
  EXAMPLE:  plotarrow(bar_index, low, "Long", "up", "#22cc88")

plotchar(bar_index, price, char, color?, pane?)
  Draws a single character / emoji marker at the bar+price.
  - char: any string — "B", "S", "★", "🚀", etc.
  EXAMPLE:  plotchar(bar_index, high, "S", "#ff4477")

label.new(x, y, text, color)
  Places a text label at a specific position.
  - x:     number — bar index or pixel position
  - y:     number — price level or pixel position
  - text:  string — label content
  - color: hex string

EXAMPLES:
    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")
    plotshape(bar_index, high, "Sell", "triangledown", "#ff4477")
    plotshape(bar_index, close, "Cross", "cross", "#ff8800", "separate")
    label.new(bar_index, high, "Resistance", "#ff4477")
    label.new(bar_index, low, "Support", "#22cc88")

TIPS:
- Shapes auto-position relative to the bar: buy signals below, sell signals above
- The gap adapts to chart zoom level (barSpacing * 1.5)
- Use title="" to suppress the text label on a shape
- Shapes work in both "main" and "separate" panes`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: '3D Plotting — plot3d() Complete Reference',
      content: `plot3d(series, name, style, color, pane?, z_level?)
  Renders signal analysis model data as a 3D visualization using Three.js (WebGL).
  - series: any number array — rsi(), macd.macd, volume, custom formula
  - name:   string — title displayed in the 3D scene
  - style:  string — must be one of the 15 styles below (QUOTED)
  - color:  hex string
  - pane:   "main" (overlays price chart) or "separate" (lower pane)
  - z_level: number (optional) — depth plane. Same value = same plane (layers
    coincide); different values = separated onto parallel planes in depth.
    Omit and each layer auto-gets its own plane. Works in BOTH "3d" and "separate".
    CRITICAL for level lines: give each fib/pivot/S-R line a DISTINCT z_level
    (0, 1, 2, …) or they overlap into a twisted rope. Example:
      plot3d(fib236, "Fib 23.6", "line3d", "#00ccff", "3d", 0)
      plot3d(fib382, "Fib 38.2", "line3d", "#ffcc00", "3d", 1)
      plot3d(fib618, "Fib 61.8", "line3d", "#ff8800", "3d", 2)
    → three clean, straight, separated parallel level lines.

plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?)
  Places a 3D geometric shape at a specific (bar, price, z) coordinate.
  - bar_index: number — X-axis position (use bar_index variable for current bar)
  - price: number — Y-axis position (e.g. high, low, close, or a custom value)
  - title: string — label for the legend
  - shape: string — "cube", "sphere", "pyramid", "torus", "diamond",
    "coneup", "conedown"
  - color: hex string or named color ("#22cc88", "#ff4477", etc.)
  - size: number — scale factor (0.2 = small, 1.0 = normal, 3.0 = large)
  - z_level: number (optional) — Z-axis position, same rules as plot3d z_level
  - pane: string (optional) — "separate" (default) renders in the lower 3D pane;
    "3d" renders in the main 3D chart scene (must also have plot3d calls with pane="3d")
  - rx, ry, rz: numbers (optional) — rotation in DEGREES around each axis,
    applied on top of any built-in orientation. Pose any shape for custom
    scenes: plotshape_3d(..., "3d", 0, 45, 0) spins it 45° around Y.

  SIGNAL CONES — the standard buy/sell markers:
  "coneup"   — auto-offsets BELOW the given price with a small gap (gap and
               cone scale with size), tip pointing UP at the bar. Use for
               BUYS at low, colored green (#22cc88).
  "conedown" — flipped upside down, auto-offsets ABOVE the given price, tip
               pointing DOWN at the bar. Use for SELLS at high, colored red
               (#ff4477).
  Pass a strength-derived size to make cones proportional to signal quality.
  Example:
    strength = min(abs(fastMa - slowMa) / atr(high, low, close, 14) + 0.6, 2.2)
    if buySig
        plotshape_3d(bar_index, low, "Buy", "coneup", "#22cc88", strength, 0, "3d")
    if sellSig
        plotshape_3d(bar_index, high, "Sell", "conedown", "#ff4477", strength, 0, "3d")
  → Shapes render only when the chart is in 3D mode.
  → 2D plotshape() does NOT render in 3D mode — use plotshape_3d instead.
  → Multiple shapes on the same bar will overlap; use size and z_level to arrange them.

label3d(bar_index, price, text, color?, size?, z_level?, pane?)
  Places a billboard TEXT label at an exact (bar, price, z) coordinate in a 3D
  scene — the tool for naming peaks, levels, zones, and signals (the way a
  market-cap landscape labels its assets or a solar-system scene names planets).
  - bar_index: number — X-axis position
  - price:     number — Y-axis position
  - text:      string — the label text (keep it SHORT: "POC", "BTC", "Breakout")
  - color:     hex string (default "#ffffff")
  - size:      number 0.2–3.0 (default 1)
  - z_level:   number (optional) — same stacking rules as plot3d
  - pane:      "separate" (default, lower 3D pane) or "3d" (main 3D scene)
  Example:
    if crossover(close, poc)
        label3d(bar_index, close, "POC RECLAIM", "#22cc88", 1.2)
  → Call it INSIDE a condition (or it stamps a label on every bar; the engine
    caps rendering at the 40 most recent labels).
  → Labels always face the camera and render on top of geometry.
  → Pair with plotshape_3d for labeled markers: shape for geometry, label3d for the name.

═══════════════════════════════════════════════════════════════════
15 VISUALIZATION STYLES — Complete Reference
═══════════════════════════════════════════════════════════════════

"surface" — Volumetric Price-Weighted Mesh
  A colored mesh surface flowing through time. Each point's height
  represents its proximity to the current bar's close price.
  - Colors: green-yellow gradient (HSL 0.35 → 0.0)
  - Requires: 40+ bars for good visual density
  - Pane: works on both "main" and "separate"
  - Main chart: floats above the price action, aligned to candle positions
  - Separate: rendered with HSL color gradient (green=low → red=high)

"ribbon" — Glowing Tube Trace with Depth Aura
  A smooth Catmull-Rom spline tube wrapped in a transparent glow band.
  - Upper band: green (#22cc88) — tracks price above center
  - Lower band: red (#ff4477) — tracks price below center
  - Center line: purple (#b48cff) emissive core
  - Best for: MACD lines, moving averages, trend signal analysis models, centerlines
  - Requires: 3+ bars (more = smoother spline)
  - Pane: works on both "main" and "separate"

"bars3d" — 3D Column/Bar Chart
  Extruded rectangular columns sized by the series value.
  - Each column is a BoxGeometry scaled by value magnitude
  - Volume: wider columns for higher relative volume
  - Color: bull=green (#22cc88), bear=red (#ff4477) with emissive glow
  - Best for: volume profiles, histogram data, delta, ADX histograms
  - Requires: 5+ bars
  - Pane: both "main" and "separate"

"scatter" — HSL Color-Coded Point Cloud
  Spheres positioned at each data point, colored by a full HSL gradient.
  - Size: proportional to volume (larger spheres = higher volume bars)
  - Color: HSL spectrum (blue/green=low, yellow=mid, red=high)
  - Jitter: slight random offset for organic cloud appearance
  - Best for: spotting clusters, divergence, overbought/oversold zones
  - Requires: 5+ bars (up to 120 points rendered)
  - Pane: both "main" and "separate"

"line3d" — Exact Straight-Segment Line
  A thin tube drawn through the EXACT data points with straight segments —
  no spline smoothing. This is the style for anything step-shaped or
  level-like: ribbon's Catmull-Rom smoothing overshoots steps into spikes.
  - Best for: fib levels, pivots, S/R lines, steplike series, secondary traces
  - Half the thickness of ribbon; renders values exactly as computed

"wireframe" — X-Ray Surface
  The surface mesh rendered in wireframe mode with reduced opacity.
  - Shows the underlying triangle structure
  - Best for: technical analysis overlay, debugging geometry
  - Combines well with "surface" for a wireframe-over-solid effect

"mesh" — Solid Surface Render
  Same geometry as "surface" but rendered as a solid mesh (opaque).
  - Best for: opaque overlays, contrast against transparent layers
  - Combines well with "wireframe" for a dual-layer effect

"helix" — Double-Helix DNA Wrapping
  Two interwoven Catmull-Rom tube strands (green/red) spiraling around
  the series timeline, connected by luminous cross-rungs and a purple
  glow core.
  - Strand 1 (green #22cc88): forward phase
  - Strand 2 (red #ff4477): reverse phase (π offset)
  - Rungs: purple (#b48cff) lines connecting strands every Nth bar
  - Core: white emissive tube running through the center
  - Best for: sine waves, cyclic signal analysis models, Elliott wave overlays
  - Requires: 3+ bars; 20+ recommended for visible helix structure
  - Pane: both "main" and "separate"

"vortex" — Spiral Tornado/Tunnel
  6 spiral arms converging on the series axis, each a Catmull-Rom tube
  with radius tapering from maxR→0 along the timeline. Spirals are
  phase-shifted and color-graded across the HSL ring.
  - 6 arms phase-shifted by 60°
  - Radius decays by 85% from start to end
  - 4 full twists over the visible span
  - Core: white emissive glow tube
  - Best for: momentum convergence, volatility cones, force fields
  - Requires: 10+ bars
  - Pane: both "main" and "separate"

"manifold" — Wireframe Lorentzian Surface Mesh
  Longitudinal + latitudinal curves forming a flowing 3D ribbon.
  8 longitudinal splines spread across the series width; cross-ribs
  connect them every Nth bar. The spread widens with volume.
  - 8 longitudinal splines with HSL color progression (purple→blue)
  - Latitudinal cross-ribs at lower opacity
  - Ghost floor grid at y=-0.5
  - Best for: volume-weighted surfaces, multi-dimensional overlays
  - Requires: 5+ bars
  - Pane: both "main" and "separate"

"nebula" — Glowing Volumetric Particle Cloud
  Dense scatter cloud with 6 glowing spheres per bar, randomly jittered
  in x/y/z. Color shifts from green (bull) to red (bear) based on
  bar direction. Size and spread scale with volume.
  - 6 particles per bar with random jitter (±0.2–0.8 spread)
  - Bullish bars: green hue cluster; Bearish: red hue cluster
  - Each particle has random size (0.02–0.08), opacity (0.3–0.9)
  - Emissive glow on every particle
  - Best for: dense volume clouds, order-flow visualization, atmosphere
  - Requires: 2+ bars; 30+ for full nebula effect
  - Pane: both "main" and "separate"

"constellation" — Star Points + Constellation Lines
  Stars positioned at each data point with interconnecting lines drawn
  between nearby points (distance < 1.2 units). Stars have bull/bear
  emissive colors and size scales by volume.
  - Stars: glowing spheres with emissive intensity ∝ volume
  - Lines: blue (#4488ff) at 15% opacity, connecting neighbors within threshold
  - Color: bull=green (#22cc88) emissive, bear=red (#ff4477) emissive
  - Best for: sparse data, signal dots, pattern recognition overlays
  - Requires: 2+ bars; 10+ for visible constellation pattern
  - Pane: both "main" and "separate"

"torus" — 3D Ring Array
  A ring (TorusGeometry) at each bar position, scaled by volume.
  Each ring rotates slightly along the z-axis, creating a flowing
  tunnel effect. A purple glow tube connects through the center.
  - Ring radius: 0.2 + volScale × 0.5
  - Tube radius: 0.02 + volScale × 0.03
  - Color follows bull/bear; emissive glow with dynamic opacity
  - Center: purple glow tube at 30% opacity
  - Best for: cyclic data, clock/radar displays, volume rings
  - Requires: 3+ bars
  - Pane: both "main" and "separate"

"trail" — Streaming Ribbon with Volume-Weighted Width
  A sinuous 3D ribbon whose width varies with volume. Built as
  individual quad segments between upper/lower edge points.
  Upper and lower edges are offset by ±(0.05 + volFrac × 0.3).
  - Each segment: flat Mesh with DoubleSide material
  - Color: bull=green, bear=red; opacity ∝ volume
  - Center: white guide line at 30% opacity
  - Best for: streaming data, real-time feeds, volume trails
  - Requires: 3+ bars
  - Pane: both "main" and "separate"

"ridgeline" — Temporal Distribution Joyplot
  Slices the series into 4–16 time windows, histograms each window's values,
  and stacks the resulting smoothed curves in depth — a "market memory"
  landscape showing where the values LIVED in each period (the classic
  temporal volume-profile look).
  - Windows: auto-sized (≈12 bars each, 4–16 ridges); bins: 28 per ridge
  - Color: HSL ramp across ridges — cool (oldest) → hot (newest)
  - Best for: price/value distributions over time, volume profiles, regime memory
  - Requires: 24+ bars (more bars = more ridges)
  - Pane: both "3d" and "separate"
  - Pair with label3d to name the point of control or key ridges

═══════════════════════════════════════════════════════════════════
PANE BEHAVIOR — Critical Details
═══════════════════════════════════════════════════════════════════

"separate" pane:
  - Renders in the dedicated 3D lower pane BELOW the main chart
  - Multiple plot3d("separate") calls STACK SIDE-BY-SIDE in the same scene
  - Automatically REPLACES the 2D secondary pane (3D takes priority)
  - Includes orbit camera controls (drag to rotate, scroll to zoom)
  - The scene has ambient + directional lighting and a grid floor
  - Resizable by dragging the chart splitter
  - 2D and 3D "separate" panes CANNOT coexist — 3D wins

"main" pane:
  - Renders as a 3D overlay ABOVE the price chart area
  - Multiple plot3d("main") calls layer in a single 3D scene
  - Uses a shared Three.js scene with perspective camera
  - Aligned to the chart's bar positions using barX() mapping
  - The scene is cleared when no 3D signal analysis models are active
  - Grid helper + ambient/directional lighting included

═══════════════════════════════════════════════════════════════════
PERFORMANCE CONSIDERATIONS
═══════════════════════════════════════════════════════════════════

- Surface/wireframe/mesh generate the most geometry (segments × price_steps triangles)
  — Works best with 100+ bars but uses more GPU memory
- Ribbon/line3d use TubeGeometry — smooth but heavier on long series
- Bars3d uses BoxGeometry per bar — lightweight even at high counts
- Scatter uses SphereGeometry per point — medium weight
- Helix/vortex/torus/trail use TubeGeometry + BoxGeometry — medium weight
- Manifold uses Line geometry — lightweight
- Nebula uses many small SphereGeometry — medium weight (6 particles × bars)
- Constellation uses SphereGeometry + LineSegments — lightweight
- Lower pane auto-caps segments: surface=80×15 grid, bars3d=80 columns, scatter=120 points
- Main chart 3D renders every frame; separate pane uses requestAnimationFrame loop
- Use fewer plot3d calls for better performance on low-end hardware`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Combining 2D & 3D — Advanced Visual Techniques',
      content: `The real power of OakScript comes from LAYERING 2D and 3D plots together.
Here are battle-tested patterns for incredible visuals.

═══════════════════════════════════════════════════════════════════
PATTERN 1: 2D Lines + 3D Surface (Trend Context)
═══════════════════════════════════════════════════════════════════
    // 2D: price and MA lines on the main chart
    plot(close, "Price", "#ffffff", 1)
    plot(sma(close, 20), "SMA 20", "#b48cff", 2)

    // 3D: RSI surface floating below as depth context
    r = rsi(close, 14)
    plot3d(r, "RSI Surface", "surface", "#b48cff", "separate")
    hline(70, "#ff4477", "separate")
    hline(30, "#22cc88", "separate")
  → The 2D chart shows price action with clean trend lines.
    The 3D lower pane shows the RSI landscape, making divergence
    and overbought/oversold zones instantly visible in 3D.

═══════════════════════════════════════════════════════════════════
PATTERN 2: Multi-Layer 3D Dashboard (Lower Pane)
═══════════════════════════════════════════════════════════════════
    // Layer 1: RSI as a surface (background context)
    r = rsi(close, 14)
    plot3d(r, "RSI", "surface", "#b48cff", "separate")

    // Layer 2: MACD as ribbon (floating above surface)
    m = macd(close, 12, 26, 9)
    plot3d(m.macd, "MACD", "ribbon", "#22aaff", "separate")
    plot3d(m.signal, "Signal", "ribbon", "#ff8800", "separate")

    // Layer 3: Volume as bars (ground-level context)
    plot3d(volume, "Volume", "bars3d", "#ffd43b", "separate")

    // 2D signals on the main chart
    if crossover(m.macd, m.signal)
        plotshape(bar_index, low, "MACD Bull", "triangleup", "#22aaff")
    if crossunder(m.macd, m.signal)
        plotshape(bar_index, high, "MACD Bear", "triangledown", "#ff8800")
  → The lower pane becomes a full 3D dashboard with the RSI landscape,
    MACD ribbons crossing each other, and volume bars as terrain.
    All layers orbit together with mouse drag.

═══════════════════════════════════════════════════════════════════
PATTERN 3: Floating 3D Over Main Chart
═══════════════════════════════════════════════════════════════════
    // 2D: candlestick price action (auto-rendered by the chart)
    // 2D: moving average lines
    plot(sma(close, 20), "SMA 20", "#b48cff", 2)
    plot(sma(close, 50), "SMA 50", "#ff8800", 2)

    // 3D: price surface floating ABOVE the candles
    plot3d(close, "Price Field", "surface", "#22cc88", "main")

    // 3D: volume scatter showing activity intensity
    plot3d(volume, "Vol Clusters", "scatter", "#ff6b6b", "main")
  → The price action is grounded in 2D candles with MA lines,
    while a 3D surface shows the broader price landscape and
    volume scatter reveals hidden activity clusters floating above.

═══════════════════════════════════════════════════════════════════
PATTERN 4: Signal-Driven Visuals
═══════════════════════════════════════════════════════════════════
    r = rsi(close, 14)

    // Color background based on overbought/oversold
    if r >= 70
        bgcolor("rgba(255,68,119,0.08)")
    if r <= 30
        bgcolor("rgba(34,204,136,0.08)")

    // Signal shapes at cross points
    if crossover(r, 30)
        plotshape(bar_index, low, "RSI Buy", "triangleup", "#22cc88")
    if crossunder(r, 70)
        plotshape(bar_index, high, "RSI Sell", "triangledown", "#ff4477")

    // 3D: RSI landscape showing the full oscillator wave
    plot3d(r, "RSI Wave", "surface", "#b48cff", "separate")
    hline(70, "#ff4477", "separate")
    hline(30, "#22cc88", "separate")
  → 2D bgcolor tints the chart column-by-column for overbought/oversold.
    Shapes mark exact entry/exit points.
    3D surface provides the macro view of oscillator momentum.

═══════════════════════════════════════════════════════════════════
PATTERN 5: Bollinger Bands with 3D Volume Terrain
═══════════════════════════════════════════════════════════════════
    len = input(20, "Length")
    mult = input(2.0, "Multiplier", 0.5, 4.0, 0.5)

    mid = sma(close, len)
    upper = mid + stdev(close, len) * mult
    lower = mid - stdev(close, len) * mult

    // 2D: band lines and fill
    plot(mid, "BB Mid", "#b48cff", 2)
    plot(upper, "BB Upper", "#ff4477", 1)
    plot(lower, "BB Lower", "#22cc88", 1)
    fill(upper, lower, "rgba(180,140,255,0.06)")

    // 2D: squeeze/expansion signals
    bbWidth = upper - lower
    if bbWidth < lowest(bbWidth, 20)[0]
        bgcolor("rgba(255,184,0,0.1)")  // squeeze alert

    // 3D: volume as terrain bars
    plot3d(volume, "Volume", "bars3d", "#ffd43b", "separate")
  → Classic Bollinger Bands in 2D with band fill overlay.
    3D volume bars show where real money entered during squeezes.

═══════════════════════════════════════════════════════════════════
PATTERN 6: Full-Metal Dashboard (Maximum Visual Impact)
═══════════════════════════════════════════════════════════════════
    // ═══ 2D Chart Layer ═══
    plot(sma(close, 20), "SMA 20", "#b48cff", 2)
    plot(sma(close, 50), "SMA 50", "#ff8800", 2)

    r = rsi(close, 14)
    m = macd(close, 12, 26, 9)

    if crossover(m.macd, m.signal)
        plotshape(bar_index, low, "MACD Cross", "triangleup", "#22cc88")
    if crossunder(m.macd, m.signal)
        plotshape(bar_index, high, "MACD Cross", "triangledown", "#ff4477")

    if r >= 70
        bgcolor("rgba(255,68,119,0.06)")
    if r <= 30
        bgcolor("rgba(34,204,136,0.06)")

    // ═══ 3D Lower Pane (Dashboard) ═══
    plot3d(r, "RSI Landscape", "surface", "#b48cff", "separate")
    plot3d(m.macd, "MACD", "ribbon", "#22aaff", "separate")
    plot3d(m.signal, "Signal", "ribbon", "#ff8800", "separate")
    plot3d(volume, "Volume Terrain", "bars3d", "#ffd43b", "separate")

    hline(70, "#ff4477", "separate")
    hline(30, "#22cc88", "separate")
    hline(0, "#ffffff", "separate")
  → The ultimate setup: 2D gives precise price levels, signals, and
    MA crossovers. The 3D lower pane shows the full oscillator landscape
    with MACD ribbons threading through RSI terrain and volume columns
    rising from the floor. Everything is interactive with orbit control.

═══════════════════════════════════════════════════════════════════
RULES FOR COMBINING 2D & 3D
═══════════════════════════════════════════════════════════════════

1. "main" pane: 2D plots + 3D overlays coexist — 3D floats above price
2. "separate" pane: 3D takes priority over 2D. If you have ANY
   plot3d("separate") call, the 2D secondary pane is hidden.
3. Multiple plot3d calls in the same pane STACK as layers in one scene
4. Use hline() in the same pane as plot3d for reference thresholds
5. Shapes (plotshape) always work in both panes, 2D and 3D
6. The splitter bar between main chart and lower pane is draggable
7. For pure 2D oscillators: use plot(rsi, "RSI", ..., "separate")
8. For 3D dashboards: use plot3d(rsi, "RSI", "surface", ..., "separate")`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: '3D Creative Visual Vocabulary — Kinematic & Topological Techniques',
      content: `When you need the agent to generate cutting-edge 3D signal analysis models, use
      these visual vocabularies. They transform math into geometry.
      
      ═══════════════════════════════════════════════════════════════════
      HIGHER-ORDER CALCULUS — 2nd & 3rd Derivative Signal Analysis Models
      ═══════════════════════════════════════════════════════════════════
      These are not MACD/RSI — they measure CHANGE OF CHANGE of momentum.
      
      // Velocity (1st derivative): rate of price change
      vel = close - close[1]
      
      // Acceleration (2nd derivative): change of velocity  
      acc = vel - vel[1]
      
      // Jerk (3rd derivative): change of acceleration
      jerk = acc - acc[1]
      
      // Render them as 3D ribbons to see momentum layers
      plot3d(vel, "Velocity", "ribbon", "#22aaff", "separate", 0)
      plot3d(acc, "Acceleration", "ribbon", "#ff8800", "separate", 0)
      plot3d(jerk, "Jerk", "ribbon", "#ff4477", "separate", 0)
      
      ═══════════════════════════════════════════════════════════════════
      KINEMATIC SIGNATURE — Phase-Space Embedding
      ═══════════════════════════════════════════════════════════════════
      Plot price vs its own lag to reveal attractors and cycles:
      
      // 3D phase space: (price, price[5], price[10])
      plot3d(close, "Phase Space", "scatter", "#b48cff", "main")
      // Add a 2nd trace with different z_level for depth
      plot3d(close[5], "Lag 5", "line", "#22cc88", "main", 1)
      
      When you see spiral or loop patterns, the market has
      a short-term cyclic attractor — mean reversion opportunity.
      
      ═══════════════════════════════════════════════════════════════════
      TOPOLOGICAL SIGNATURES — Knots, Wraps & Vortices
      ═══════════════════════════════════════════════════════════════════
      Cross-signal analysis model wraps detect regime changes:
      
      r = rsi(close, 14)
      m = macd(close, 12, 26, 9)
      
      // Normalize both to 0-1 range for topological comparison
      rNorm = r / 100
      mNorm = (m.macd - lowest(m.macd, 100)) / (highest(m.macd, 100) - lowest(m.macd, 100) + 0.001)
      
      // Cross-3D: when RSI wraps above MACD, trend is up
      // Use z_level=2 to float above other geometry
      plot3d(rNorm, "RSI Norm", "line", "#22cc88", "separate", 2)
      plot3d(mNorm, "MACD Norm", "line", "#ff4477", "separate", 2)
      plot3d(rNorm - mNorm, "Spread", "bars3d", "#b48cff", "separate", 2)
      
      // Mark wrap crossovers with 3D shapes
      if crossover(rNorm, mNorm)
          plotshape_3d(bar_index, high * 1.02, "Wrap Bull", "diamond", "#22cc88", 1.5, 2)
      if crossunder(rNorm, mNorm)
          plotshape_3d(bar_index, high * 1.02, "Wrap Bear", "diamond", "#ff4477", 1.5, 2)
      
      ═══════════════════════════════════════════════════════════════════
      VORTEX SHEET — Surface from Synthetic Dimensions
      ═══════════════════════════════════════════════════════════════════
      Build a surface from a single series by creating synthetic
      dimensions via phase-shifted lags:
      
      src = rsi(close, 14)
      // 3 surfaces at different phase shifts + z_levels create a vortex
      plot3d(src, "Phase 0", "surface", "#22cc88", "separate", 0)
      plot3d(src[2], "Phase 2", "surface", "#b48cff", "separate", 1)
      plot3d(src[5], "Phase 5", "surface", "#ff4477", "separate", 2)
      
      → This creates a multi-layered "vortex sheet" effect — each
        surface phase-shifted and depth-separated, producing a 3D
        toroidal wave structure when orbited.
      
      ═══════════════════════════════════════════════════════════════════
      GOLDEN RULES FOR 3D SIGNALS
      ═══════════════════════════════════════════════════════════════════
      
      1. ALWAYS use plotshape_3d() instead of plotshape() when chart is in
         3D mode — 2D shapes do NOT render in 3D mode
      2. Use z_level to layer signals: lowest signal analysis model at level 0,
         overlays at level 1-3, shapes at level 2-4
      3. Normalize signal analysis models to [0,1] range before comparing across types
      4. Higher-order derivatives (jerk, snap) produce noisier series —
         smooth them: ema(jerk, 5)
      5. Phase-space plots work best with scatter or line style, not surface
      6. Vortex sheets are GPU-intensive — use with ≤80 bars of history`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Standard Library — Moving Averages',
      content: `sma(source, length)         — Simple Moving Average
ema(source, length)         — Exponential Moving Average (multiplier = 2/(len+1))
wma(source, length)         — Weighted Moving Average (linear weights)
hma(source, length)         — Hull Moving Average (fast + smooth)
rma(source, length)         — Wilder's smoothed MA (as used inside RSI/ATR)
vwma(source, length)        — Volume-Weighted Moving Average
macd(source, fast, slow, signal) — MACD signal analysis model
  Returns an object with THREE properties:
    .macd   — MACD line array (fast EMA - slow EMA)
    .signal — Signal line array (EMA of MACD line)
    .hist   — Histogram array (macd - signal)
  Usage:
    m = macd(close, 12, 26, 9)
    plot(m.macd, "MACD", "#22aaff", 2)
    plot(m.signal, "Signal", "#ff8800", 1)
    plot(m.hist, "Histogram", "#b48cff", 1)

linreg(source, length, offset) — Least-squares linear regression (offset bars back)
  source: close/open/high/low/custom array
  length: number of bars
  offset: future offset (currently ignored, SMA fallback)`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Standard Library — Oscillators',
      content: `rsi(source, length)
  Relative Strength Index (0-100).
  Uses Wilder's smoothing: average gain/loss over ` + "`length`" + ` bars.

cci(high, low, close, length)
  Commodity Channel Index.
  Formula: (TP - SMA(TP)) / (0.015 × StdDev(TP))
  where TP = (H + L + C) / 3

stoch(high, low, close, length)
  Stochastic %K (0-100): where close sits in the high/low range.
  For %D, smooth it: d = sma(stoch(high, low, close, 14), 3)

roc(source, length)
  Rate of Change (%).
  ROC = ((price - price[n]) / price[n]) × 100

mom(source, length)
  Momentum: source - source[length].

stdev(source, length)
  Standard Deviation.

median(source, length)
  Rolling median over the window.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Standard Library — Volume & Volatility',
      content: `vwap(close, volume)
  Volume Weighted Average Price.
  Cumulative: Σ(V×P) / ΣV, computed bar by bar.

atr(high, low, close, length)
  Average True Range (EMA of True Range).
  True Range = max(H-L, |H-C[1]|, |L-C[1]|)

trueRange(high, low, close)
  Raw True Range array (before smoothing).

adx(high, low, close, length)
  Average Directional Index.
  Measures trend strength (0-100), NOT direction.
  Calculated via +DI, -DI, and DX smoothing.

mfi(high, low, close, volume, length)
  Money Flow Index (0-100) — volume-weighted RSI.

obv(close, volume)
  On-Balance Volume — cumulative volume flow.

cmf(high, low, close, volume, length)
  Chaikin Money Flow (-1..1) — buying vs selling pressure.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Standard Library — Signal Detection',
      content: `crossover(a, b)
  Returns true when series a crosses ABOVE series b.
  Condition: prev_a <= prev_b AND current_a > current_b.

crossunder(a, b)
  Returns true when series a crosses BELOW series b.
  Condition: prev_a >= prev_b AND current_a < current_b.

barssince(condition)
  Returns number of bars since the condition was last true.
  Returns -1 if never true.

highest(source, length)
  Highest value over the last ` + "`length`" + ` bars.

lowest(source, length)
  Lowest value over the last ` + "`length`" + ` bars.

pivothigh(source, leftBars, rightBars)
  Pivot-high PRICE on the bar where the pivot CONFIRMS (rightBars after
  the actual high); NaN on all other bars. Test with ` + "`ph > 0`" + `.
  Track the latest: var lastPh = 0.0; if ph > 0 { lastPh := ph }

pivotlow(source, leftBars, rightBars)
  Same for pivot lows — the standard building block for swing levels,
  fib anchors, and support/resistance.

cum(source)
  Cumulative sum from bar 0 to current bar.

change(source)
  Difference from previous bar: source - source[1].

correlation(a, b, length)
  Pearson correlation coefficient between two series over a window.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Math & String Utilities',
      content: `Math functions:
  abs(x)    min(a,b)  max(a,b)  floor(x)  ceil(x)  round(x)
  sqrt(x)   log(x)    log10(x)  exp(x)    sin(x)    cos(x)    tan(x)
  asin(x)   acos(x)   atan(x)   atan2(y, x)   inverse trig, in radians
  pow(base, exponent)   sign(x)   avg(a, b, ...)

Type conversion:
  tostring(x)   — convert number/boolean to string
  tonumber(x)   — convert string to number

String formatting:
  str.format("Price: {}", close)  — replaces {} with value
  "Value: " + tostring(close)     — concatenation`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Execution Model (Bar-by-Bar)',
      content: `OakScript executes your script once per bar, from bar 0 to the last bar:

1. Before each bar execution, built-in variables are set:
   close, open, high, low, volume, time = current bar's values
   bar_index = current position (0-based)

2. var variables carry their value from the PREVIOUS bar
   — They are NOT reset between bars
   — They ARE reset when the script is reloaded (input changes)

3. varip variables carry their value across bars AND reloads
   — Rarely needed; use for counters that must survive input edits

4. Regular variables (no var/varip) are recomputed from scratch each bar

5. plot/plotshape/hline/fill/bgcolor calls are COLLECTED per bar
   — They are NOT drawn immediately; all plots are rendered after execution

6. plot3d calls work differently:
   — They are collected once per FULL execution (not per bar)
   — The series array is reconstructed from all bars' values
   — plot3d emits AFTER the full bar loop completes

7. Errors on individual bars are captured and displayed WITHOUT
   stopping execution of subsequent bars`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Alerts & Webhooks',
      content: `alert(message)
  Fires a browser notification with the given message.

alertcondition(condition, title, message)
  Only fires when the condition is true on the current bar.

Alerts are sent as browser notifications and POSTed as JSON
to any configured webhook URL.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Consensus Gate',
      content: `Deterministic multi-condition confirmation for a signal — require
several independent conditions to agree on the SAME bar before you
alert on it, instead of firing on any single condition alone.

consensus.vote(name, condition)
  Registers a named boolean vote for the current bar and returns
  condition unchanged, so it composes inline with your own logic:
    trendUp = consensus.vote("trend", close > sma(close, 50))
    momentumUp = consensus.vote("momentum", rsi(close, 14) > 50)
    volumeConfirms = consensus.vote("volume", volume > sma(volume, 20))

consensus.ratio()
  Fraction (0-1) of this bar's registered votes that were true.
consensus.count()
  Count of this bar's registered votes that were true.
consensus.total()
  Total votes registered on this bar (true + false).

  if consensus.ratio() >= 0.66
      alert("Confirmed: " + tostring(consensus.count()) + "/" + tostring(consensus.total()) + " conditions agree")

Votes reset every bar automatically — nothing to clear yourself.
There is no cross-script or LLM-based voting here: every "vote" is a
plain boolean condition the SAME script evaluates, so the gate is
fully deterministic and reproducible from the same script and bars.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Common Pitfalls & Solutions',
      content: `1. "plot3d emits no geometry"
   → Check that your series has enough values (≥3 bars).
   → NaN values in the series are filtered out.
   → Ensure color is a hex string: "#22cc88" not "green".

2. "Signals appear at wrong position"
   → plotshape(bar_index, ...) places at the CURRENT bar.
   → Triangleup shapes appear BELOW the bar (adaptive gap).
   → Triangledown shapes appear ABOVE the bar (adaptive gap).

3. "2D secondary pane disappeared"
   → Any plot3d("separate") call hides the 2D secondary pane.
   → Remove all plot3d("separate") calls to restore 2D lower pane.

4. "MACD returns a single value, not .macd/.signal/.hist"
   → You MUST use m.macd, m.signal, m.hist to access the components.
   → m = macd(close, 12, 26, 9); plot(m.macd, "MACD", "#22aaff", 2)

5. "Condition never triggers"
   → Use == for comparison, NOT = (which is assignment).
   → crossover/crossunder return boolean arrays — access with [0] for current.

6. "Script runs but nothing shows"
   → Ensure at least one plot/plotshape/plot3d call exists outside conditionals.
   → Check that conditions actually evaluate true.

7. "3D performance is slow"
   → Reduce series length or use simpler styles (bars3d, scatter).
   → Avoid multiple surface/wireframe calls on the same pane.
   → Set performance mode to "medium" or "low" in settings.

8. "A loop runs forever / the page freezes"
   → Almost always an indentation mistake: a brace-less if/while/for block
     requires every statement in it to sit at the EXACT SAME column. If one
     line is indented differently, it falls OUTSIDE the block — for a while
     loop, this can strand the counter update (e.g. i := i + 1) outside the
     loop body, so the condition never changes and it never terminates.
   → Fix: switch that block to { } braces, which have no indentation
     requirement, or carefully re-align every statement in the block.

9. "Should I use { } or indentation?"
   → Both work. Prefer { } braces for any block with more than one
     statement, or with nested if/while/for — they can't misparse.
   → Indentation style is fine for short, single-line bodies.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Example: RSI Divergence Detector',
      content: `rsiLen = input(14, "RSI Length")
ob = input(70, "Overbought")
os = input(30, "Oversold")

r = rsi(close, rsiLen)

// Track swing highs/lows with persistent state
var prevHigh = 0.0
var prevRsiHigh = 0.0
var prevLow = 999999.0
var prevRsiLow = 0.0

if crossunder(r, ob)
    prevHigh := high
    prevRsiHigh := r

if crossover(r, os)
    prevLow := low
    prevRsiLow := r

// Bearish divergence: price higher, RSI lower
if prevHigh > 0 and high > prevHigh and r < prevRsiHigh
    plotshape(bar_index, high, "Bear Div", "triangledown", "#ff4477")

// Bullish divergence: price lower, RSI higher
if prevLow < 999999 and low < prevLow and r > prevRsiLow
    plotshape(bar_index, low, "Bull Div", "triangleup", "#22cc88")

// 2D RSI line + reference levels
plot(r, "RSI", "#b48cff", 2, "separate")
hline(ob, "#ff4477", "separate")
hline(os, "#22cc88", "separate")

// 3D RSI landscape (lower pane dashboard)
plot3d(r, "RSI Wave", "surface", "#b48cff", "separate")`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Example: MACD Dashboard',
      content: `fast = input(12, "Fast")
slow = input(26, "Slow")
sig = input(9, "Signal")

m = macd(close, fast, slow, sig)

// 2D signal markers
if crossover(m.macd, m.signal)
    plotshape(bar_index, low, "Bull Cross", "triangleup", "#22aaff")

if crossunder(m.macd, m.signal)
    plotshape(bar_index, high, "Bear Cross", "triangledown", "#ff8800")

// Histogram color coding
if m.hist > 0
    bgcolor("rgba(34,136,255,0.04)")

// 3D ribbon dashboard
plot3d(m.macd, "MACD Line", "ribbon", "#22aaff", "separate")
plot3d(m.signal, "Signal Line", "ribbon", "#ff8800", "separate")
plot3d(m.hist, "Histogram", "bars3d", "#b48cff", "separate")

hline(0, "#ffffff", "separate")`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Super Visual Engine — Particles, Bloom & Atmosphere',
      content: `DAFE Charts now features a GPU-accelerated visual engine with
WebGPU compute shaders for particle physics, Three.js post-processing
for bloom/glow effects, and volumetric atmosphere rendering.

═══════════════════════════════════════════════════════════════════
GPU PARTICLE SYSTEM
═══════════════════════════════════════════════════════════════════

The particle system renders 500-8000+ physics-driven particles
with gravity, drag, turbulence, and vortex forces. Particles flow
around the chart like cosmic dust, responding to price action.

Color modes (set via Settings → Background):
  "cosmic"    — Purple/blue/white nebula palette (default)
  "thermal"   — Red/orange/yellow heat-map coloring
  "electric"  — Blue/cyan/white electric arc coloring
  "velocity"  — Color shifts based on particle speed

Performance scaling:
  Ultra:  8192 particles (GPU compute required)
  High:   4096 particles
  Medium: 2048 particles
  Low:     512 particles (CPU fallback)

The system auto-detects WebGPU support and falls back to CPU
rendering if unavailable. GPU path uses compute shaders for
10-50x performance over CPU particles.

═══════════════════════════════════════════════════════════════════
BLOOM POST-PROCESSING
═══════════════════════════════════════════════════════════════════

The 3D chart renderer (Three.js WebGL) now includes Unreal Engine-
style bloom post-processing. This adds a natural glow to bright
areas of the chart:
- Candle bodies emit color-specific glow (green for bull, red for bear)
- 3D volume extrusions produce atmospheric radiance
- Model ribbons and surfaces glow with their assigned colors
- Bloom strength auto-adapts to performance mode

═══════════════════════════════════════════════════════════════════
VOLUMETRIC FOG
═══════════════════════════════════════════════════════════════════

FogExp2 depth fog in the 3D chart creates atmospheric depth:
- Bars further back in time fade into darkness
- Volume profile extrusions emerge from the fog
- Grid lines fade with distance for visual depth

═══════════════════════════════════════════════════════════════════
COMPOSITING LAYERS
═══════════════════════════════════════════════════════════════════

The visual engine composites in this order (back to front):
1. Deep-space / atmospheric background
2. Perspective floor grid
3. 3D candle extrusions (isometric)
4. 3D volume profile (depth-extruded)
5. OakScript 3D overlays (plot3d main pane)
6. GPU particle system (cosmic dust layer)
7. Price axis + grid labels
8. 2D OakScript plots (lines, shapes, fills)
9. Crosshair + tooltips
10. Status bar overlay

This ensures 2D elements render above 3D, and particles flow
behind UI elements for a cinematic look.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Agent Integration (AI-Powered Editor)',
      content: `The Agent is an expert OakScript coder that can:
- 💡 Brainstorm — suggest signal analysis model ideas based on your chart
- ✍️ Generate — create signal analysis models from natural language descriptions
- ✏️ Edit — modify existing signal analysis model code
- 🔧 Fix — diagnose and auto-correct syntax/runtime errors
- 📊 Analyze — review signal analysis model metrics and suggest improvements

How it works:
1. Your message + chart state + current source code → sent to LLM
2. LLM returns corrected/improved code in triple-backtick oakscript fences
3. Code appears in editor with buttons: View Code | Test Run | Accept | Decline
4. Test Run shows the visualization immediately without saving
5. Accept applies and runs the code permanently

Auto-Accept toggle: When ON, agent code is applied automatically.
When OFF, you review and choose to accept/decline.

Keyboard: Ctrl+Alt+G = Generate | Ctrl+Alt+F = Fix | Ctrl+Alt+B = Brainstorm | Ctrl+Alt+M = Metrics`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Drawing Objects — Lines, Boxes, Polylines, Circles, Arrows',
      content: `Persistent chart objects — unlike plot()/plotshape(), which add one point
per bar to a running series, these calls create discrete objects (lines,
boxes, polylines, circles, arrows) anchored at bar_index/price coordinates.
Every object type below shares the SAME id-based lifecycle (see THE ID
IDIOM further down).

line.new(x1, y1, x2, y2, color?, width?, style?, extend?, id?)
  - x1, x2: number — bar_index anchors (the two endpoints' bars)
  - y1, y2: number — price anchors (the two endpoints' prices)
  - color:  hex string (default "#b48cff")
  - width:  number — pixels (default 1)
  - style:  "solid" | "dashed" | "dotted" (default "solid")
  - extend: "none" | "left" | "right" | "both" (default "none") — projects
    a ray from the segment out to the edge of the pane
  - id: string — omit for a fresh auto-id every call, or pass the SAME
    string to update this exact line in place (see THE ID IDIOM below)
  Returns: the id (string).

line.delete(id)
  Removes the line with that id. No-op (does not error) if not found.

box.new(left, top, right, bottom, borderColor?, bgColor?, width?, id?)
  - left, right: number — bar_index anchors
  - top, bottom: number — price anchors
  - borderColor: hex string (default "#b48cff")
  - bgColor: fill color, typically rgba() for translucency
    (default "rgba(180,140,255,0.15)")
  - width: number — border pixels (default 1)
  - id: same replace-in-place rule as line.new
  Returns: the id.

box.delete(id)
  Removes the box with that id.

circle.new(x1, y1, x2, y2, color?, bgColor?, width?, id?)
  Draws an ellipse INSCRIBED inside the bounding box (x1,y1)-(x2,y2) — pass
  the same point twice (x1==x2, y1==y2) for a small dot-style marker.
  - color: stroke hex (default "#b48cff")
  - bgColor: fill, e.g. "transparent" (default) or an rgba() string
  - width: stroke pixels (default 1)
  - id: same replace-in-place rule
  Returns: the id.

arrow.new(x1, y1, x2, y2, color?, width?, id?)
  A freeform two-point arrow from (x1,y1) to (x2,y2) with the arrowhead at
  the SECOND point — distinct from plotarrow(), which is a fixed up/down
  buy/sell marker anchored to a single bar.
  Returns: the id.

polyline.new(points, color?, width?, closed?, id?)
  - points: array of [bar_index, price] pairs, e.g.
    [[10, 100], [15, 105], [20, 98], [25, 103]]
  - color: hex (default "#b48cff")
  - width: pixels (default 1)
  - closed: boolean — true connects the last point back to the first,
    forming a loop (default false)
  - id: same replace-in-place rule
  Returns: the id.

linefill.new(lineId1, lineId2, color)
  Fills the band between two EXISTING line.new lines, referenced by their
  ids. Both lines must already exist (created this bar or an earlier one).
  A mistyped or not-yet-created id simply renders nothing — it does not
  error or crash the script.
  - color: typically an rgba() string for translucency
  Re-calling with the same two ids just updates the same fill in place, so
  there's rarely a reason to keep its return value.

THE ID IDIOM — this is the single most important thing to understand about
every drawing object above. Your script re-runs from scratch every bar
(see Execution Model), so a .new() call does NOT mean "create another
one." It means "find the object with this id, or create it if it doesn't
exist yet, then overwrite its fields." Two opposite idioms fall out of
this:

REPLACE-IN-PLACE — give the object a literal, STABLE id so repeated calls
keep updating the SAME object instead of stacking duplicates. Use this for
anything that should look like ONE thing moving or growing over time.

  Worked example — a trendline that follows the latest 20-bar pivot high:
    var pivotBar = 0
    var pivotPrice = 0.0
    if high == highest(high, 20) {
        pivotBar := bar_index
        pivotPrice := high
    }
    line.new(pivotBar, pivotPrice, bar_index, close, "#22aaff", 2, "solid", "right", "trend1")

  Because the id "trend1" never changes, this stays ONE line whose right
  endpoint keeps re-anchoring to the current bar/close — not a stack of
  hundreds of overlapping lines.

  Worked example — a consolidation zone that grows while price stays
  tight, and resets when it breaks out:
    var boxLeft = 0
    var boxTop = 0.0
    var boxBottom = 999999.0
    tight = (high - low) < atr(high, low, close, 14) * 0.6
    if tight {
        boxTop := max(boxTop, high)
        boxBottom := min(boxBottom, low)
        box.new(boxLeft, boxTop, bar_index, boxBottom, "#ffcc00", "rgba(255,204,0,0.12)", 1, "zone1")
    } else {
        boxLeft := bar_index
        boxTop := high
        boxBottom := low
    }

  The id "zone1" pins this to ONE rectangle that widens right and expands
  top/bottom as the range persists, instead of a new box every bar.

OMITTED ID — leave the id off and every firing gets its own fresh object,
which is exactly right for "mark every occurrence." An omitted id auto-
expands to a name built from the object type and the firing bar (something
like "line:auto:482"), and each object type has its own rolling cap (30
for line/box/circle/arrow, 20 for polyline/linefill/image, 6 for table) —
the oldest is silently evicted once the cap is hit, so "one per signal"
signal analysis models never need manual cleanup.

  Worked example — mark every confirmed pivot with a small circle:
    ph = pivothigh(high, 3, 3)
    if ph > 0
        circle.new(bar_index, ph, bar_index, ph, "#ff8800", "transparent", 2)

    pl = pivotlow(low, 3, 3)
    if pl > 0
        circle.new(bar_index, pl, bar_index, pl, "#22aaff", "transparent", 2)

barcolor(color, pane?)
  Recolors the candle body/wick for the CURRENT bar directly — not a
  drawing object (no id, nothing to replace-in-place; every bar that calls
  it just overrides that bar's color). pane is accepted for signature
  symmetry with the other builtins but only "main" is currently supported.

    if close > open and close > sma(close, 50)
        barcolor("#22cc88")
    else if close < open and close < sma(close, 50)
        barcolor("#ff4477")`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Tables & Dashboards',
      content: `table.new(position, columns, rows, bgColor?, id?)
  Creates a SCREEN-anchored panel (position is relative to the canvas
  corner, not a bar/price — unlike every other drawing object) and returns
  a live table handle.
  - position: string, one of:
      "top_left"     "top_right"     "top_center"
      "middle_left"  "middle_center" "middle_right"
      "bottom_left"  "bottom_right"  "bottom_center"
  - columns, rows: number — grid size
  - bgColor: panel background, typically rgba()
    (default "rgba(20,20,30,0.85)")
  - id: string — same replace-in-place idiom as line.new/box.new/etc.
    ALWAYS give a dashboard table a stable literal id — omitting it means
    a brand-new table (capped at 6 total) is created every single bar,
    which is almost never what a dashboard wants.
  Returns: a table handle. Call handle.cell(...) on it directly, or pass
  it to the free-function form table.cell(...) below — both work
  identically.

table.cell(handle, col, row, text, bgColor?, textColor?)
  Sets one cell's contents. col/row are 0-indexed.
  - text: string — use tostring(x) to format numbers
  - bgColor, textColor: optional per-cell hex/rgba overrides

Because the whole script re-runs every bar, rebuild the table's cell text
every bar — this is normal (the same idiom Pine's own table type uses for
dashboards), not a workaround or a limitation.

EXAMPLE: session stats corner dashboard
    var dash = table.new("top_right", 2, 4, "rgba(10,10,20,0.9)", "stats")

    r = rsi(close, 14)
    atrv = atr(high, low, close, 14)
    trendUp = close > sma(close, 50)

    table.cell(dash, 0, 0, "RSI", "rgba(180,140,255,0.15)", "#ffffff")
    table.cell(dash, 1, 0, tostring(r), "rgba(180,140,255,0.15)", "#ffffff")
    table.cell(dash, 0, 1, "ATR", "", "#ffffff")
    table.cell(dash, 1, 1, tostring(atrv), "", "#ffffff")
    table.cell(dash, 0, 2, "Trend", "", "#ffffff")
    table.cell(dash, 1, 2, trendUp ? "UP" : "DOWN", "", trendUp ? "#22cc88" : "#ff4477")
    table.cell(dash, 0, 3, "Close", "", "#ffffff")
    table.cell(dash, 1, 3, tostring(close), "", "#ffffff")

  table.new() is called with a stable id ("stats") so it stays ONE panel
  pinned to the top-right corner regardless of zoom/pan; the four
  table.cell() calls below it just refresh that same panel's text and
  colors every bar.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Images — Import & Signals',
      content: `image.new(x, y, source, width?, height?, anchor?, opacity?, rotation?, id?)
  Places a persistent image at a chart position (bar_index/price, like
  line.new/box.new — NOT screen-space like table.new).
  - x: number — bar_index anchor
  - y: number — price anchor
  - source: string — see SOURCE below
  - width, height: number — PIXELS (default 48, 48)
  - anchor: which point of the image sits at (x,y) — "center" (default),
    "top_left", "top_right", "bottom_left", "bottom_right"
  - opacity: number 0..1 (default 1)
  - rotation: number — degrees (default 0); reuses the same rz field
    plot3d shapes use for rotation
  - id: same replace-in-place idiom as line.new/box.new/etc.
  Returns: the id.

plotimage(bar_index, price, source, width?, height?, pane?, id?)
  A per-bar signal marker — the image equivalent of plotshape()/
  plotarrow()/plotchar(). Fires a fresh marker every time its surrounding
  condition is true.
  - width, height: PIXELS (default 24, 24 — smaller than image.new's
    default since this is meant as a marker, not a watermark)
  - pane: "main" (default) or "separate"

plotimage_3d(bar_index, price, source, size?, z_level?, pane?, rx?, ry?, rz?)
  The 3D billboard version — same signal-marker role as plotimage, but for
  plot3d scenes. Renders as a camera-facing sprite (not a rotatable mesh).
  - size: scale factor, same convention as plotshape_3d's size (default 1)
  - z_level: depth plane, same convention as plot3d's z_level (default 0)
  - pane: "3d" (renders in the main 3D scene, alongside plot3d(..., "3d",
    ...) calls) or "separate" (default — the lower 3D pane)
  - rx, ry, rz: degrees (default 0) — accepted for signature symmetry with
    plotshape_3d, but a billboard sprite always faces the camera regardless

SOURCE — every image builtin resolves its source string the SAME way:
1. Inline data URI — a self-contained string starting with "data:image/",
   e.g. "data:image/png;base64,iVBORw0KG...". The image travels with the
   script text itself, no external file needed.
2. Saved asset name — any other string is looked up by EXACT NAME in your
   local image library. Upload a PNG or JPEG (5MB cap) via the editor's
   Images panel (the 🖼️ Image Assets toolbar button) and give it a name;
   clicking that name in the panel copies a ready-to-paste image.new(...)
   snippet using it to your clipboard.
A source matching neither form resolves to nothing — the object is still
created but renders no pixels; nothing crashes.

PIXELS, NOT PRICE UNITS: width/height (image.new, plotimage) and size
(plotimage_3d) are all screen-space values — exactly like label size and
plotshape_3d's size — NOT chart price units. An image stays a constant
on-screen size as you zoom/pan the price axis; it does not grow or shrink
with the chart.

EXAMPLE: logo watermark in the corner
    // Upload your logo once via the Images panel, name it "logo"
    image.new(bar_index, high, "logo", 64, 64, "top_right", 0.35, 0, "watermark")

  Called unconditionally every bar with the SAME id ("watermark"), this
  stays ONE image whose anchor keeps tracking the newest bar/high, sitting
  at 35% opacity so it doesn't compete with the price data.

EXAMPLE: custom icon buy/sell signal marker
    fastMa = ema(close, 9)
    slowMa = ema(close, 21)

    if crossover(fastMa, slowMa)
        plotimage(bar_index, low, "buy_icon", 20, 20)

    if crossunder(fastMa, slowMa)
        plotimage(bar_index, high, "sell_icon", 20, 20)

  Upload "buy_icon"/"sell_icon" PNGs via the Images panel first (or swap in
  inline data URIs for a fully self-contained script) — each crossover/
  crossunder then drops its own small icon at that bar.`,
    },
    // ═══════════════════════════════════════════════════════════════════
    {
      title: 'Analyst Overlay Tools — Fibonacci, Gann, Regression Channel',
      content: `fibretracement.new(x1, y1, x2, y2, levels?, colorUp?, colorDown?, id?)
  Draws a Fibonacci retracement as a set of dashed, right-extending level
  lines — sugar built directly on line.new (each level is a real line
  object under the hood), not a separate drawing primitive.
  - x1, x2: number — bar_index anchors (levels ray rightward past x2)
  - y1: number — the price that maps to the 0% level
  - y2: number — the price that maps to the 100% level
  - levels: array of ratios
    (default [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1])
  - colorUp: color for ratios <= 0.5 (default "#22cc88")
  - colorDown: color for ratios > 0.5 (default "#ff4477")
  - id: a BASE id — each level gets its own derived sub-id, so passing the
    SAME base id next time updates every level line in place; omit it and
    each call creates a fresh set (same replace-in-place idiom as
    line.new, applied per level)
  Returns: the base id.

  EXAMPLE:
    swingHigh = highest(high, 50)
    swingLow = lowest(low, 50)
    fibretracement.new(bar_index - 50, swingLow, bar_index, swingHigh, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], "#22cc88", "#ff4477", "fib1")

gannfan.new(x1, y1, angleUnit?, color?, id?)
  Draws the 7 classic Gann angles (1x1, 1x2, 2x1, 1x4, 4x1, 1x8, 8x1) as
  dotted, right-extending rays from a single origin — also sugar over
  line.new.
  - x1, y1: number — the origin bar_index/price (usually a swing pivot)
  - angleUnit: number — price-per-bar scale for the 1x1 ("45 degree")
    angle (default 1); tune this to the instrument's typical bar-to-bar
    price movement or the fan won't look meaningful
  - color: hex (default "#b48cff")
  - id: base id, same per-line derivation/replace-in-place rule as
    fibretracement.new
  Returns: the base id.

  EXAMPLE:
    pl = pivotlow(low, 5, 5)
    var originBar = 0
    var originPrice = 0.0
    if pl > 0 {
        originBar := bar_index - 5
        originPrice := pl
    }
    gannfan.new(originBar, originPrice, 0.5, "#ffcc00", "gann1")

regression.channel(source, length, mult?) — a CALCULATION, not a drawing
primitive. Unlike everything above, this does not draw anything by
itself. It returns three number arrays for the current bar — same shape
as macd() — and it is YOUR script's job to plot() and fill() them:
  .mid   — the regression midline over the window (a true least-squares
           fit, the same one linreg() uses)
  .upper — mid + mult * stdev(source, length)
  .lower — mid - mult * stdev(source, length)

EXAMPLE:
    rc = regression.channel(close, 100, 2)
    plot(rc.mid, "Mid", "#b48cff", 2)
    plot(rc.upper, "Upper", "#22aaff", 1)
    plot(rc.lower, "Lower", "#22aaff", 1)
    fill(rc.upper, rc.lower, "rgba(34,170,255,0.08)")

This is built from the exact same plot()/fill() primitives as any other
band signal analysis model (compare the "Gradient cloud" recipe earlier) —
regression.channel just supplies the three series; there is no auto-drawn
channel object to reach for instead.`,
    },
    {
      title: 'Model Execution — model.entry / model.exit / model.confidence / model.stopLoss / model.takeProfit',
      content: `model.entry(direction, id?, qty?)        model.longEntry(id?, qty?)
model.exit(id?)                          model.shortEntry(id?, qty?)
model.longExit(id?)                      model.shortExit(id?)
model.confidence(value)                  model.stopLoss(value, mode?)
                                          model.takeProfit(value, mode?)
  Order-EVENT builtins consumed by the Time Machine backtest engine (the
  ⏱️ Backtest panel) AND the live paper auto-trader (per-model 🤖 arm
  toggle in the Active Signal Models list) — NOT rendering calls. A script
  that calls these can still be used as a normal signal analysis model
  (plot()/plotshape() etc. keep working exactly as before); the model.*
  calls simply do nothing when neither consumer is active.

  This IS the point of Signal Analysis Models: one script is both the
  chart study AND the executable model — no separate "indicator version"
  and "strategy version" of the same idea. A script with no model.* calls
  at all is still fully backtestable/auto-tradable if it plots Buy/Sell
  shapes (plotshape/plotshape_3d) — the Signal Engine derives entries and
  exits from the marker labels automatically (see the Signals dropdown in
  the Backtest panel: Auto / model.* only / plotted shapes).

  ENTRY forms:
  - model.entry(direction, id?, qty?) — direction is "long" or "short"
  - model.longEntry(id?, qty?) / model.shortEntry(id?, qty?) — direction
    baked into the name, same effect as model.entry("long"/"short", ...)
  - id: a label carried on the order for readability — see POSITION-LEVEL
    below; it is NOT compared when deciding whether an order fills
  - qty: number of units (default: the backtest panel's "Qty/trade" field,
    or the auto-trader's qty field when trading live)

  EXIT forms:
  - model.exit(id?) — closes the open position for this symbol, whichever
    side it is (no-op if flat)
  - model.longExit(id?) / model.shortExit(id?) — DIRECTION-CONDITIONAL:
    only closes if the open position is currently that side (a shortExit
    while long is a no-op) — lets a long/short model manage each side
    independently instead of one exit condition closing whatever's open

  SIGNAL METADATA (sticky — applies to every subsequent entry until
  changed or cleared with a value <= 0):
  - model.confidence(value) — a 0-1 score. Metadata only, carried through
    to backtest results and live signals for your own review — it is
    NEVER a hidden position-size multiplier.
  - model.stopLoss(value, mode?) / model.takeProfit(value, mode?) — mode
    is "pct" (default) or "abs" ($ distance). Attaches a bracket to the
    NEXT entry(ies), overriding the backtest form's SL/TP config for just
    that entry. No trailing-stop form here — trailing stays a Backtest
    panel-level-only option.

  POSITION-LEVEL, NOT ID-LEVEL: the paper broker tracks one position per
  SYMBOL, not per id. So an entry is a no-op if a position is already
  open (no pyramiding), and an exit always closes the ENTIRE matching
  position (no partial-exit or per-id close).

  EXECUTION MODEL: the backtest runs your script ONCE over the full
  historical range exactly like a normal chart render (persist/var state
  and warmup carry across the whole run, unbroken). Every model.* call
  your script makes is recorded as a signal on the bar it fired; the
  backtest engine then fills it at the FOLLOWING bar's open price (never
  the same bar's close) — the standard no-lookahead assumption, since a
  signal computed from a bar's own close cannot realistically be acted on
  until the next bar opens. The live paper auto-trader uses the same
  next-evaluation semantics.

  INTRABAR BRACKETS: once a stop-loss/take-profit/trailing bracket is
  live, it's checked against each bar's FULL high/low range, not just its
  open and close — a wick that touches a level and reverses before the
  close still fills, with gap-through pricing when a bar's open already
  cleared the level. Only brackets get this — signal-driven entries/exits
  above still fill at next-bar-open, since that's the no-lookahead rule,
  not a fill-precision limitation.

  UNCONDITIONAL CALLS: exactly like plotshape(), an unconditional top-level
  model.entry/exit fires on every single bar — almost always a mistake.
  Wrap it in a signal condition (the validator will warn you if you don't).

  EXAMPLE — MA-crossover long/short model with a stop and confidence:
    fast = sma(close, 5)
    slow = sma(close, 20)
    buySig = crossover(fast, slow)
    sellSig = crossunder(fast, slow)
    if buySig {
        model.confidence(0.7)
        model.stopLoss(1.5)
        model.longEntry("ma_cross")
    }
    if sellSig {
        model.longExit("ma_cross")
    }
    plot(fast, "Fast", "#22cc88", 1)
    plot(slow, "Slow", "#ff4477", 1)

  LEGACY ALIASES: strategy.entry(direction, id?, qty?) and strategy.exit(id?)
  still work exactly as before (identical execution to model.entry/
  model.exit) — kept for existing scripts. Prefer model.* in new scripts;
  strategy.entry/exit have no equivalent of longExit/shortExit's
  direction-conditional behavior or the confidence/bracket metadata calls.

  The Backtest panel reports in-sample and out-of-sample stats SIDE BY
  SIDE from a single fixed historical split (equity curve, max drawdown,
  per-bar unannualized Sharpe, win rate, avg win/loss) — always both
  together, since an in-sample-only result is not evidence the model
  works out of sample.`,
    },
    {
      title: 'ML / RL — ml.predict / rl.action',
      content: `ml.predict(modelId)                      rl.action(policyId)

  Reads a prediction from an ML model or RL policy trained in the 🧠 ML Lab
  panel (next to ⏱️ Backtest and 🎯 Optimize in the editor toolbar) — real
  models trained on real historical bars, not a stub. ML Lab trains two
  kinds of thing:

  Each comes in a CLASSICAL and a DEEP flavor, picked per model in the
  panel — not a global setting, and not GPU-gated: the classical options
  are legitimate first choices on any machine, not merely a fallback for
  underpowered ones.

  ML SIGNAL MODELS (ml.predict): gradient boosting / a real 2-hidden-layer
  neural net (MLP) / logistic-ridge (classical, scikit-learn), or an LSTM
  (deep, PyTorch) — trained on a standard technical feature set (returns
  over several lookbacks, rolling volatility, RSI, MACD histogram, EMA
  spread, volume ratio, bar range/position) to predict either next-H-bar
  DIRECTION (up/down) or RETURN. The LSTM is the one genuinely different
  capability: it sees a SLIDING WINDOW of the last ~20 bars' features, not
  just the current bar's snapshot, the way every classical option here
  does. ml.predict("modelId") returns a 0-1 probability for a direction
  model or a raw predicted return for a regression model, for the CURRENT
  bar. Neutral (0.5) until the model resolves.

  RL TRADING POLICIES (rl.action): a from-scratch tabular Q-learning agent
  (classical, numpy) or a Deep Q-Network (deep, PyTorch) — genuine
  reinforcement learning either way. The agent is never told the "right"
  action; it only ever sees a reward (mark-to-market P&L on the position
  its action implies, minus a small cost for flipping) from acting against
  the SAME historical bars the backtester replays, and learns purely from
  that via the standard Q-learning Bellman update across many training
  episodes. The DQN's real difference from tabular: it consumes the full
  continuous feature vector directly, with no quantile-binned state table
  to size — tabular's state space is a fixed 625 cells (4 features × 5
  bins), DQN's is unbounded. rl.action("policyId") returns the policy's
  greedy action for the current bar: -1 (short), 0 (flat), or 1 (long).
  Defaults to 0 until the policy resolves.

  TRAINING: every model/policy type splits bars CHRONOLOGICALLY (train =
  the first Train %, validate = the rest) — never shuffled, which would
  leak future bars into training the same way it would corrupt the
  backtester's in-sample/out-of-sample split. Every result is reported
  next to an honest baseline: ML shows validation accuracy/MAE against the
  naive majority-class/zero-change baseline; RL shows an episode-reward
  learning curve (proof it actually learned something across training, not
  a static number) plus the validated policy's held-out return against
  "always long" and "always flat." A model or policy that beats these
  baselines is doing something real; one that doesn't is visibly not,
  right there in the panel — deep models are not exempt from this and
  regularly don't beat a classical baseline on this much tabular data,
  which the panel shows plainly rather than hiding.

  EXECUTION MODEL: on the live chart, predictions/actions resolve in the
  background against a synchronous cache — 0.5/0 until the first fetch for
  that model/bar-range lands, then the panel's next re-render picks up the
  real value (same pattern plotimage/label image sources already use for
  async decodes). In the Backtest and Optimizer panels, the script is
  scanned for ml.predict("id")/rl.action("id") calls and their data is
  fetched UP FRONT before the replay runs, so a backtest never sees the
  neutral placeholder mid-run the way a fresh live-chart load briefly
  might.

  DEVICE: the LSTM/DQN types use PyTorch, picking a CUDA GPU automatically
  when the backend machine has one (torch.cuda.is_available()) and running
  correctly, just slower, on CPU otherwise — ML Lab's device badge reports
  which is actually in play before you train. If the backend doesn't have
  torch installed at all, those two options are simply disabled in the
  panel with an explanation; every classical option keeps working
  regardless, since none of them ever touch torch.

  EXAMPLE — gate an EMA-cross entry behind an ML model's confidence:
    fast = sma(close, 5)
    slow = sma(close, 20)
    p = ml.predict("ml_a1b2c3d4e5")
    if crossover(fast, slow) and p > 0.55 {
        model.confidence(p)
        model.longEntry("ml_gated")
    }
    if crossunder(fast, slow) {
        model.longExit("ml_gated")
    }

  EXAMPLE — trade an RL policy directly:
    a = rl.action("rl_f6a7b8c9d0")
    if a > 0 { model.longEntry("rl_policy") }
    if a <= 0 { model.longExit("rl_policy") }`,
    },
    {
      title: 'Confirmed-Only Multi-Timeframe Confluence — security()',
      content: `security(timeframe, source)
  OakScript's equivalent of Pine's request.security() — bare, not dotted,
  since OakScript drops Pine's namespaces everywhere else too (ta.sma ->
  sma, input.int -> input). Reads a HIGHER timeframe's last CONFIRMED
  (fully closed) value of source, aggregated purely from the bars already
  loaded for the current chart — no new fetch, no symbol argument (always
  the current chart's own symbol).

  CONFIRMED-ONLY IS THE WHOLE POINT: the value returned is always the
  most recently CLOSED higher-timeframe bucket — never the one still
  forming. A script reading the in-progress bucket would effectively see
  the future relative to its own bar-by-bar walk (repainting) — this
  never happens with security(). Non-repaint is enforced by returning NaN
  until the first higher-timeframe bucket has actually closed, then
  holding that value flat until the next bucket closes — the exact same
  "withhold with NaN until confirmed" idiom pivothigh()/pivotlow() already
  use elsewhere in this language, just triggered by a timeframe-bucket
  boundary instead of a fixed left/right bar window.

  - timeframe: one of "1s","5s","10s","30s","1m","5m","15m","30m","1h",
    "4h","1d","1w" (case-sensitive; anything else returns NaN and the
    validator flags an unrecognized literal before you even run it).
  - source: close/open/high/low aggregate like a real OHLC roll-up
    (close/derived expressions take the LAST value seen in the bucket,
    high takes the MAX, low takes the MIN, open takes the FIRST) — volume
    and any other derived expression also use "last value in the bucket",
    matching Pine's own security() behavior for computed expressions, NOT
    an implicit sum.
  - Requesting a timeframe the SAME AS or FINER than what's actually
    loaded (e.g. asking for "1m" on a chart loaded at "1m", or "30s" on a
    "1m" chart) is nonsensical — there's no finer data to downsample —
    and returns NaN for every bar rather than a misleading result.
  - Known limitation: the very first confirmed value can be built from a
    PARTIAL bucket if the loaded window starts mid-bucket (there's no
    backend fetch to go find the true bucket start) — this self-heals
    after the first full bucket and only ever affects the first 1-2
    confirmed values.

  EXAMPLE — only take a 1-minute crossover signal that agrees with the
  1-hour trend:
    fast = sma(close, 9)
    slow = sma(close, 21)
    htfClose = security("1h", close)
    htfTrendUp = close > htfClose
    buySig = crossover(fast, slow) and htfTrendUp
    if buySig {
        plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")
    }
    plot(fast, "Fast", "#22cc88", 1)
    plot(slow, "Slow", "#ff4477", 1)
    plot(htfClose, "1H Close", "#22aaff", 1, "stepline")`,
    },
  ];
}
