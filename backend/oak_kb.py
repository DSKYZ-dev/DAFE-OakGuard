"""OakScript Knowledge Base — multi-dimensional index for dynamic retrieval.

Every function, section, keyword, and example is indexed so the agent can
search for exactly what it needs instead of carrying the full reference.
"""

from __future__ import annotations
import math
import re
from typing import Optional

# ─── Section documents (from docs.ts) ─────────────────────────────
SECTIONS: list[dict] = [
    {
        "title": "Overview",
        "content": (
            "OakScript is the DAFE Charts indicator scripting language — "
            "a PineScript-inspired bar-by-bar execution engine. "
            "KEY PRINCIPLES: script runs once per bar, oldest first. "
            "Built-in: close, open, high, low, volume, time, bar_index. "
            "var persists across bars, varip across recalculations. "
            "All plot calls collected during execution, rendered together."
        ),
        "keywords": ["principles", "execution", "bar", "builtin", "var", "varip"],
    },
    {
        "title": "Literals & Data Types",
        "content": (
            "Numbers: 42, 3.14, -7. Strings: \"hello\" or 'hello' — MUST be quoted. "
            "Booleans: true, false. Nil: null, nil. Arrays: [1,2,3]. "
            "Falsy: null, nil, 0, NaN, \"\". "
            "CRITICAL: string args in function calls MUST be quoted."
        ),
        "keywords": ["string", "number", "boolean", "nil", "array", "literal", "quote", "type"],
    },
    {
        "title": "Variables & Assignment",
        "content": (
            "Assignment: x = 10. Reassignment: x := x + 1 (both = and := work). "
            "Persistent: var total = 0.0 — survives bars, resets on reload. "
            "Varip: varip counter = 0 — survives bars AND recalculations. "
            "Built-in read-only: close, open, high, low, volume, time, bar_index, barstate."
        ),
        "keywords": ["var", "varip", "assignment", "declare", "persist", "reassign", "bar_index", "barstate"],
    },
    {
        "title": "Operators",
        "content": (
            "Arithmetic: + - * / %. Comparison: == != < > <= >= =>. "
            "Logical: and or not !. Unary: - !. "
            "Ternary: cond ? a : b — nests right-associative. "
            "String concat: \"Hello \" + \"World\"."
        ),
        "keywords": ["operator", "ternary", "comparison", "arithmetic", "logical", "concat"],
    },
    {
        "title": "Control Flow",
        "content": (
            "If/else — both { } braces and PineScript-style indentation are valid. "
            "Prefer braces for any block with more than one statement or with nesting "
            "— they have no indentation requirement and cannot misparse:\n"
            "    if condition { stmt1; stmt2 } else { stmt3 }\n\n"
            "Indentation style works too, but every statement in the block MUST share "
            "the exact same column — a misaligned line silently falls outside the "
            "block (e.g. a loop counter update landing outside its own while loop "
            "causes an infinite loop):\n"
            "    if condition\n        statement\n    else\n        statement\n\n"
            "For loop: for i = 0 to 10; for i = 0 to 10 by 2; for i = 10 downto 0; "
            "for (var i = 0; i < 10; i = i + 1)\n"
            "While loop: while condition { statement }\n"
            "Loop control: break, continue."
        ),
        "keywords": ["if", "else", "for", "while", "loop", "break", "continue", "indentation", "control flow"],
    },
    {
        "title": "Arrays",
        "content": (
            "Literal: arr = [1, 2, 3]. Pre-allocate: arr = array(10).\n"
            "Operations: array.get(arr, index), array.set(arr, index, val), "
            "array.push(arr, val), array.pop(arr), array.size(arr).\n"
            "Index access: value = arr[0], arr[1] = 42."
        ),
        "keywords": ["array", "list", "push", "pop", "get", "set", "size", "index"],
    },
    {
        "title": "Input Parameters",
        "content": (
            "input() makes indicators adjustable via UI:\n"
            "    len = input(14, \"Length\")\n"
            "    len = input(14, \"RSI Length\", 1, 50, 1)\n"
            "    useFilter = input(true, \"Use Filter\")\n"
            "    label = input(\"Custom\", \"Label Text\")"
        ),
        "keywords": ["input", "parameter", "setting", "ui", "adjustable", "slider", "toggle"],
    },
    {
        "title": "2D Plotting — Lines & Overlays",
        "content": (
            "plot(value, title, color, linewidth, style?, pane?)\n"
            "Styles: \"line\", \"stepline\", \"area\", \"histogram\", \"columns\", \"circles\", \"cross\".\n"
            "Conditional color: color = close > open ? \"#22cc88\" : \"#ff4477\"\n"
            "Color helpers: color.new(base, transp), color.rgb(r, g, b, transp?), "
            "color.from_gradient(value, bottomValue, topValue, bottomColor, topColor) "
            "— heatmap/gradient coloring\n"
            "hline(value, color, pane?) — dashed horizontal reference. CONSTANTS ONLY "
            "(e.g. RSI 70/30): each distinct value creates a permanent line (deduped, "
            "capped at 24/pane, oldest dropped). DYNAMIC levels (fibs, pivots, moving "
            "S/R) must use plot(level, \"Title\", \"#hex\", 1, \"stepline\") instead — "
            "the stepline follows the level as it changes.\n"
            "fill(top, bottom, color) — translucent band between two plots\n"
            "bgcolor(color) — background tint per bar"
        ),
        "keywords": [
            "plot", "hline", "fill", "bgcolor", "line", "stepline", "area",
            "histogram", "columns", "circles", "cross", "color", "hex", "rgba",
            "overlay", "pane", "main", "separate",
        ],
    },
    {
        "title": "2D Plotting — Shapes & Labels",
        "content": (
            "plotshape(bar_index, price, title, style, color, pane?)\n"
            "Styles: \"triangleup\", \"triangledown\", \"circle\", \"cross\", \"xcross\", "
            "\"square\", \"diamond\", \"arrowup\", \"arrowdown\", \"label\".\n"
            "plotarrow(bar_index, price, title, direction, color?, pane?)\n"
            "plotchar(bar_index, price, char, color?, pane?)\n"
            "label.new(x, y, text, color)\n\n"
            "TIPS: buy shapes below bar, sell above. Gap adapts to zoom."
        ),
        "keywords": [
            "plotshape", "plotarrow", "plotchar", "label", "marker", "shape",
            "triangle", "diamond", "arrow", "signal", "buy", "sell",
        ],
    },
    {
        "title": "3D Plotting — plot3d() Complete Reference",
        "content": (
            "plot3d(series, name, style, color, pane?, z_level?)\n"
            "ALL 15 STYLES (QUOTED strings):\n"
            "\"surface\" volumetric mesh terrain (HSL green→red by height) | "
            "\"ribbon\" glowing spline tube (MACD/MAs/centerlines) | "
            "\"bars3d\" extruded columns (volume/histograms) | "
            "\"scatter\" HSL point cloud sized by volume (clusters/divergence) | "
            "\"line3d\" EXACT straight-segment line, no smoothing — REQUIRED for fib/"
            "pivot/S-R level series (ribbon/surface spline-smooth steps into spikes) | "
            "\"wireframe\" x-ray surface | \"mesh\" solid opaque surface | "
            "\"helix\" double-helix DNA strands + rungs (cyclic data) | "
            "\"vortex\" 6-arm converging spiral tornado (momentum/volatility cones) | "
            "\"manifold\" multi-spline wireframe sheet (topology/volume-weighted) | "
            "\"nebula\" glowing particle cloud, bull/bear colored (order flow) | "
            "\"constellation\" stars + connecting lines (sparse signals/patterns) | "
            "\"torus\" tunnel of rings scaled by magnitude (cyclic/volume rings) | "
            "\"trail\" streaming ribbon, width breathes with magnitude (live feeds) | "
            "\"ridgeline\" temporal distribution joyplot: series sliced into 4-16 time "
            "windows, each window's value histogram stacked in depth, cool→hot color "
            "ramp (price/volume profiles over time, market memory — needs 24+ bars).\n"
            "z_level (number, optional): stacks multiple plot3d calls in depth — same "
            "value = same Z layer, different values = spaced 2.4 units apart; omit for "
            "auto-spacing.\n"
            "PANES: pane=\"3d\" = flagship exclusive full-chart takeover, geometry "
            "renders unified WITH the 3D price bars (orbit camera); while active NO 2D "
            "plots or separate-pane 3D render from ANY indicator; only one pane=\"3d\" "
            "indicator at a time. pane=\"separate\" = lower 3D pane (multiple calls "
            "stack; replaces the 2D secondary pane; also one at a time). "
            "Default \"main\" is a lighter legacy overlay — prefer \"3d\" or \"separate\".\n\n"
            "plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?)\n"
            "3D geometric marker at exact (bar, price, Z). Shapes: \"cube\", \"sphere\", "
            "\"pyramid\", \"torus\", \"diamond\", \"coneup\", \"conedown\". Size 0.2-3.0. "
            "pane \"separate\" (default) or \"3d\". Call INSIDE a signal condition. "
            "STANDARD SIGNAL MARKERS: buy = \"coneup\" green (#22cc88) at low — it "
            "auto-offsets BELOW the bar with a size-scaled gap, tip pointing up at it; "
            "sell = \"conedown\" red (#ff4477) at high — flipped upside down, "
            "auto-offsets ABOVE the bar, tip pointing down. Pass a strength-derived "
            "size (e.g. spread/ATR clamped to 0.6-2.2) so cone size is proportional "
            "to signal quality. rx/ry/rz (optional, DEGREES) rotate any shape on top "
            "of its built-in orientation for custom scenes. ALWAYS pair with at least "
            "one plot3d of the same pane so the scene has geometry context.\n\n"
            "label3d(bar_index, price, text, color?, size?, z_level?, pane?)\n"
            "Billboard TEXT label at exact (bar, price, Z) — names peaks, levels, zones, "
            "signals (\"POC\", \"BTC\", \"Breakout\"). Keep text SHORT. Call INSIDE a "
            "condition (engine renders only the 40 most recent). Labels face the camera "
            "and draw on top. Pair with plotshape_3d for labeled markers.\n\n"
            "CRITICAL: when the chart is in 3D mode, 2D plot()/plotshape() do NOT "
            "render — only plot3d/plotshape_3d/label3d execute."
        ),
        "keywords": [
            "plot3d", "plotshape_3d", "label3d", "3d", "threejs", "webgl",
            "surface", "ribbon", "bars3d", "scatter", "line3d", "wireframe", "mesh",
            "helix", "vortex", "manifold", "nebula", "constellation", "torus", "trail",
            "ridgeline", "joyplot", "profile", "z_level", "pane", "shape", "sphere",
            "cube", "pyramid", "diamond", "text", "label", "style", "styles",
        ],
    },
    {
        "title": "Standard Library — Moving Averages",
        "content": (
            "sma(source, length) — Simple Moving Average\n"
            "ema(source, length) — Exponential Moving Average\n"
            "wma(source, length) — Weighted MA; hma(source, length) — Hull MA; "
            "rma(source, length) — Wilder's smoothing; vwma(source, length) — Volume-weighted MA\n"
            "macd(source, fast, slow, signal) — returns {.macd, .signal, .hist}\n"
            "    Usage: m = macd(close, 12, 26, 9); plot(m.macd, \"MACD\", \"#22aaff\", 2)\n"
            "linreg(source, length, offset) — Linear regression"
        ),
        "keywords": ["sma", "ema", "wma", "hma", "rma", "vwma", "hull", "wilder",
                     "macd", "linreg", "moving average", "ma", "signal", "histogram"],
    },
    {
        "title": "Standard Library — Oscillators",
        "content": (
            "rsi(source, length) — RSI 0-100, Wilder's smoothing\n"
            "cci(high, low, close, length) — Commodity Channel Index\n"
            "stoch(high, low, close, length) — Stochastic %K 0-100 "
            "(smooth with sma(k, 3) for %D)\n"
            "roc(source, length) — Rate of Change %\n"
            "mom(source, length) — Momentum: source - source[length]\n"
            "stdev(source, length) — Standard Deviation\n"
            "median(source, length) — Rolling median"
        ),
        "keywords": ["rsi", "cci", "stoch", "stochastic", "roc", "mom", "momentum",
                     "stdev", "median", "oscillator", "overbought", "oversold"],
    },
    {
        "title": "Standard Library — Volume & Volatility",
        "content": (
            "vwap(close, volume) — Volume Weighted Average Price\n"
            "atr(high, low, close, length) — Average True Range\n"
            "trueRange(high, low, close) — Raw True Range\n"
            "adx(high, low, close, length) — Average Directional Index 0-100\n"
            "mfi(high, low, close, volume, length) — Money Flow Index 0-100\n"
            "obv(close, volume) — On-Balance Volume (cumulative)\n"
            "cmf(high, low, close, volume, length) — Chaikin Money Flow -1..1"
        ),
        "keywords": ["vwap", "atr", "trueRange", "adx", "mfi", "obv", "cmf",
                     "money flow", "on balance", "chaikin", "volume", "volatility",
                     "average true range"],
    },
    {
        "title": "Standard Library — Signal Detection",
        "content": (
            "crossover(a, b) — a crosses above b\n"
            "crossunder(a, b) — a crosses below b\n"
            "barssince(condition) — bars since condition last true\n"
            "highest(source, length) — highest value over window\n"
            "lowest(source, length) — lowest value over window\n"
            "pivothigh(source, leftBars, rightBars) — pivot-high PRICE on the bar "
            "where it confirms (rightBars later), NaN otherwise. Test with ph > 0.\n"
            "pivotlow(source, leftBars, rightBars) — same for pivot lows.\n"
            "cum(source) — cumulative sum from bar 0\n"
            "change(source) — source - source[1]\n"
            "correlation(a, b, length) — Pearson correlation"
        ),
        "keywords": [
            "crossover", "crossunder", "barssince", "highest", "lowest",
            "pivothigh", "pivotlow", "pivot", "swing", "fractal",
            "cum", "change", "correlation", "signal", "detect", "condition",
        ],
    },
    {
        "title": "Math & String Utilities",
        "content": (
            "Math: abs, min, max, floor, ceil, round, sqrt, log, log10, exp, "
            "pow(base, exp), sign, avg(a, b, ...), sin, cos, tan\n"
            "Conversion: tostring(x), tonumber(x)\n"
            "Format: str.format(\"Price: {}\", close), \"Value: \" + tostring(close)"
        ),
        "keywords": ["math", "abs", "sqrt", "pow", "sign", "log10", "avg",
                     "sin", "cos", "tan", "tostring", "tonumber", "format"],
    },
    {
        "title": "Execution Model (Bar-by-Bar)",
        "content": (
            "Script runs once per bar, bar 0 to last. "
            "Before each bar: built-ins set to current values. "
            "var carries from previous bar. "
            "varip carries across reloads. "
            "Regular vars recomputed each bar. "
            "plot calls collected, rendered after loop. "
            "plot3d collected once per full execution (not per bar). "
            "Errors on individual bars don't stop execution."
        ),
        "keywords": ["execution", "bar-by-bar", "loop", "render", "collection", "error handling"],
    },
    {
        "title": "Common Pitfalls & Solutions",
        "content": (
            "1. plot3d no geometry → check series has 3+ bars, no NaN\n"
            "2. Signals at wrong position → triangleup below bar, triangledown above\n"
            "3. 2D secondary pane disappeared → plot3d('separate') hides it\n"
            "4. MACD single value → use .macd/.signal/.hist access\n"
            "5. Condition never triggers → use == not =\n"
            "6. Script nothing shows → need plot/plotshape/plot3d outside conditions\n"
            "7. 3D performance slow → reduce series, use simpler styles\n"
            "8. Infinite loop / page freeze → almost always misaligned indentation in "
            "a brace-less if/while/for block; a statement (often a loop counter "
            "update) landed outside the block it belonged to. Switch that block to "
            "{ } braces to fix.\n"
            "9. { } braces are valid and recommended for multi-statement blocks — "
            "they have no indentation requirement\n"
            "10. Misspelled/undefined variable → silently reads as 0/false, NO error "
            "is thrown. A real bug found in shipped code: `reqPersist = persist` used "
            "an undefined name when the actual input was `persistence` — it ran "
            "without complaint and just used the wrong value. Double-check every "
            "variable name against its input()/declaration before finishing.\n"
            "11. Indicator runs but is unexpectedly slow on real (multi-hundred-bar) "
            "history → the whole script re-executes bar-by-bar over the ENTIRE "
            "history on every recompute, there is no incremental caching. Two "
            "concrete rules: (a) built-in series functions (rsi/sma/ema/cci/adx/etc) "
            "are cached per exact (function, source, params) signature, so calling "
            "the SAME one with the SAME args many times is free, but do not "
            "re-derive the same value with a slightly different expression in "
            "multiple places — store it in a variable once and reuse it; "
            "(b) any O(lookback) or worse search/scan you write yourself (KNN, "
            "pattern-matching, nested history scans) should run sparsely — gate the "
            "expensive block behind `bar_index % scanEvery == 0` and cache the "
            "result in a `var` for the bars in between, the same fix that resolved "
            "real freezes in shipped pattern-matching and KNN-classifier indicators.\n"
            "12. Multiple plot3d calls that all visualize the SAME underlying value "
            "with different style names is a wasted opportunity, not a feature — "
            "each plot3d should answer a DIFFERENT question. Look for other "
            "already-computed local variables in the script (a stdev/volatility "
            "measure, a count, a raw vs. smoothed version, a margin/spread) and "
            "assign each 3D style to a genuinely distinct one instead of reusing "
            "the same series 2-3 times.\n"
            "13. pane=\"3d\" is an exclusive main-chart takeover: while a pane=\"3d\" "
            "indicator is active, NO 2D plots/oscillator pane and NO separate-pane "
            "3D will render from ANY indicator, not just that one — this is enforced "
            "by the chart itself, not a bug to work around. Also, only ONE pane=\"3d\" "
            "(main) and ONE pane=\"separate\" 3D indicator can be active at a time; "
            "adding a second of either kind automatically replaces the first one in "
            "that slot.\n"
            "14. Fib/pivot/S-R lines multiplying and burying the chart → the script "
            "used hline() for DYNAMIC levels. hline is for constants only; every "
            "distinct value becomes a permanent line (engine dedupes and caps at 24 "
            "per pane, dropping oldest). Use plot(level, \"Title\", \"#hex\", 1, "
            "\"stepline\") — one line per level that steps to each new value, old "
            "positions clean up automatically.\n"
            "15. Indicator 'runs' but every value is stuck/never updates → per-bar "
            "calculations were declared with var. A var initializer executes ONCE "
            "(bar 0) and the value persists — `var lvl = highest(high, 20)` is "
            "frozen forever. var is ONLY for accumulator state with a literal "
            "initial value; write calculations as plain assignments.\n"
            "16. Signals repaint / look perfect in history but fail live → negative "
            "history index (high[-1]) read a future bar. The engine clamps these "
            "to the current bar; use [1]/[2] and confirm pivots 1-2 bars late.\n"
            "17. plot3d's source expression must be evaluated on EVERY bar (not only "
            "inside a conditional that skips bars) for its historical series to "
            "reconstruct correctly — plot3d itself only fires once, on the final "
            "bar, but it needs the full per-bar history of its source expression to "
            "have been tracked all along the way.\n"
            "18. 3D signal markers invisible → pane mismatch. When any plot3d uses "
            "pane=\"3d\" (exclusive main-chart takeover), the lower 3D pane is hidden — "
            "a plotshape_3d/label3d that omits its pane argument defaults to "
            "\"separate\" and renders NOWHERE. Every plotshape_3d/label3d in a "
            "pane=\"3d\" script must pass \"3d\" as its final argument: "
            "plotshape_3d(bar_index, low, \"Buy\", \"sphere\", \"#22cc88\", 1.4, 0, \"3d\"). "
            "The validator flags this as MISMATCHED_3D_PANE."
        ),
        "keywords": ["pitfall", "troubleshoot", "error", "bug", "fix", "common mistake", "gotcha",
                     "performance", "slow", "undefined variable", "sparse scan",
                     "3d", "pane", "marker", "invisible", "signal", "plotshape_3d", "label3d"],
    },
    {
        "title": "User-Defined Functions",
        "content": (
            "Pine-style arrow functions:\n"
            "    norm(x, lo, hi) => (x - lo) / max(hi - lo, 0.0001) * 100\n"
            "    score(r, a) => {\n"
            "        base = r > 70 ? -1 : r < 30 ? 1 : 0\n"
            "        return base * (a > 25 ? 2 : 1)\n"
            "    }\n"
            "Single-expression body after =>, or a { } block whose value is the "
            "explicit return (or the last expression). Declare functions near the "
            "top, BEFORE first use. Params are positional and shadow globals only "
            "for the call — do NOT name params after builtins (close, high, plot). "
            "Builtins cannot be overridden. Results are per-bar values: they can be "
            "history-indexed (mySpread(a,b) then sp[1]) and fed to builtins "
            "(sma(spread, 10)). Max call depth 64 — no deep recursion."
        ),
        "keywords": ["function", "functions", "define", "def", "reusable", "helper",
                     "arrow", "custom function", "method", "modular"],
    },
    {
        "title": "Anchoring — Swings, Sessions, Days, Custom Events",
        "content": (
            "Anchoring = computing FROM a reference point. The universal pattern:\n"
            "1. DETECT the anchor bar (a condition true on exactly that bar):\n"
            "   newDay = floor(time / 86400000) != floor(time[1] / 86400000)  "
            "(time is unix MILLISECONDS)\n"
            "   ph = pivothigh(high, 10, 10)  — swing anchor confirms when ph > 0\n"
            "   evt = crossover(ema(close, 9), ema(close, 21))  — custom event anchor\n"
            "2. STORE anchor values in var state (literal init, updated with :=):\n"
            "   var anchorHi = 0.0\n"
            "   if ph > 0 { anchorHi := ph }\n"
            "   var dayOpen = 0.0\n"
            "   if newDay or bar_index == 0 { dayOpen := open }\n"
            "3. RESET accumulators AT the anchor (anchored VWAP pattern):\n"
            "   var cumPV = 0.0\n"
            "   var cumV = 0.0\n"
            "   if newDay { cumPV := 0.0; cumV := 0.0 }\n"
            "   cumPV := cumPV + close * volume\n"
            "   cumV := cumV + volume\n"
            "   avwap = cumV > 0 ? cumPV / cumV : close\n"
            "4. DERIVE levels from anchors, render with steplines:\n"
            "   rng = anchorHi - anchorLo\n"
            "   fib618 = anchorLo + rng * 0.618\n"
            "   plot(fib618, \"Fib 61.8\", \"#ff33cc\", 1, \"stepline\")\n"
            "5. Bars since anchor: barssince(newDay). Highest since anchor: "
            "var hiSince = 0.0; if newDay { hiSince := high }; "
            "if high > hiSince { hiSince := high }"
        ),
        "keywords": ["anchor", "anchored", "anchoring", "session", "day", "open",
                     "week", "vwap", "avwap", "reference", "reset", "swing anchor",
                     "day open", "session open", "from swing", "fib anchor"],
    },
    {
        "title": "Script Structure — Canonical Order",
        "content": (
            "Every OakScript indicator follows this exact top-to-bottom order "
            "(the script executes top-to-bottom once per bar, so sequence matters):\n"
            "1. input() declarations — all tunable parameters first.\n"
            "2. Indicator calculations — every variable assigned BEFORE the line "
            "that uses it. An undefined name silently reads as 0/false, NO error.\n"
            "3. Persistent state — var x = 0.0 (survives across bars), updated with :=.\n"
            "4. Signal conditions as plain booleans:\n"
            "    buySig = crossover(fastMa, slowMa) and r < 70\n"
            "    sellSig = crossunder(fastMa, slowMa) or r > 80\n"
            "5. Signal markers INSIDE if-blocks (buy at low, sell at high):\n"
            "    if buySig { plotshape(bar_index, low, \"Buy\", \"triangleup\", \"#22cc88\") }\n"
            "    if sellSig { plotshape(bar_index, high, \"Sell\", \"triangledown\", \"#ff4477\") }\n"
            "6. Unconditional rendering LAST at top level — plot()/hline()/fill()/plot3d() "
            "must NEVER be inside if-blocks or they render nothing "
            "(bgcolor is the exception: it may be conditional)."
        ),
        "keywords": ["structure", "order", "sequence", "skeleton", "template",
                     "generate", "create", "build", "write", "script", "signal",
                     "buy", "sell", "entry", "exit", "trade", "strategy"],
    },
    {
        "title": "OakScript vs PineScript — Critical Differences",
        "content": (
            "OakScript is PineScript-INSPIRED but different. NEVER write:\n"
            "- ta.rsi(...) / math.max(...) / str.tostring(...) → functions are BARE: "
            "rsi(), max(), tostring()\n"
            "- input.int/input.float/input.bool → single input(default, \"Title\", min?, max?, step?)\n"
            "- indicator(\"...\")/study(...)/strategy(...) declarations → scripts start "
            "directly with code, delete these lines\n"
            "- named arguments plot(x, color=..., linewidth=2) → ALL arguments positional: "
            "plot(x, \"Title\", \"#22cc88\", 2)\n"
            "- shape.triangleup / location.belowbar / size.small → plotshape takes a QUOTED "
            "style string and an explicit price: plotshape(bar_index, low, \"Buy\", \"triangleup\", \"#22cc88\")\n"
            "- color.red / color.green constants → quoted hex strings \"#ff4477\" / \"#22cc88\"\n"
            "- nz(x) / na(x) → do not exist; request.security() is PineScript — use "
            "the bare security(timeframe, source). "
            "Missing values read as 0; emit trade signals with plotshape inside if-blocks.\n"
            "History indexing DOES work like Pine: close[1], myVar[1]."
        ),
        "keywords": ["pinescript", "pine", "ta", "difference", "namespace", "named",
                     "argument", "shape", "location", "study", "strategy", "convert",
                     "port", "translate", "migrate"],
    },
    {
        "title": "Example: RSI Divergence Detector",
        "content": (
            "Full indicator tracking swing highs/lows with persistent state.\n"
            "Bearish divergence: price higher, RSI lower.\n"
            "Bullish divergence: price lower, RSI higher.\n"
            "Includes 2D RSI line + 3D surface in separate pane.\n"
            "Key: var prevHigh/prevRsiHigh/prevLow/prevRsiLow for state tracking."
        ),
        "keywords": ["divergence", "example", "rsi", "swing", "state", "var", "pattern"],
    },
    {
        "title": "Example: MACD Dashboard",
        "content": (
            "Full MACD indicator with signal markers, histogram coloring, "
            "and 3D ribbon dashboard (MACD line, signal line, histogram bars).\n"
            "Key: crossover/crossunder for signal markers, "
            "plot3d with 'ribbon' and 'bars3d' styles."
        ),
        "keywords": ["example", "macd", "dashboard", "ribbon", "crossover", "histogram"],
    },
    {
        "title": "Combining 2D & 3D — Advanced Visual Techniques",
        "content": (
            "Patterns for layering 2D + 3D:\n"
            "1. 2D lines + 3D surface (trend context)\n"
            "2. Multi-layer 3D dashboard (lower pane stacking)\n"
            "3. Floating 3D over main chart\n"
            "4. Signal-driven visuals (bgcolor + shapes + 3D)\n"
            "5. Bollinger Bands with 3D volume terrain\n"
            "6. Full-metal dashboard (maximum visual impact)\n\n"
            "Rules: main pane coexists; separate 3D replaces 2D; "
            "multiple plot3d stack as layers."
        ),
        "keywords": [
            "combine", "layer", "fusion", "dashboard", "pattern",
            "bollinger", "volume terrain", "signal visual",
        ],
    },
    {
        "title": "Super Visual Engine",
        "content": (
            "GPU particle system (500-8000+ physics particles). "
            "Bloom post-processing (Unreal-style glow). "
            "Volumetric fog for depth. "
            "Color modes: cosmic, thermal, electric, velocity. "
            "Compositing: atmosphere → grid → 3D candles → volume → "
            "plot3d → particles → 2D plots → crosshair."
        ),
        "keywords": [
            "particle", "bloom", "fog", "volumetric", "gpu", "webgpu",
            "cosmic", "thermal", "electric", "compositing", "visual engine",
        ],
    },
    {
        "title": "Drawing Objects — Lines, Boxes, Polylines, Circles, Arrows",
        "content": (
            "Persistent drawing primitives, unlike plot()/plotshape() which redraw a full "
            "series every execution — these create/replace ONE object identified by an id "
            "string.\n"
            "line.new(x1, y1, x2, y2, color?, width?, style?, extend?, id?) — x/x1/x2 = "
            "bar_index, y/y1/y2 = price. style: \"solid\"|\"dashed\"|\"dotted\". extend: "
            "\"none\"|\"left\"|\"right\"|\"both\" rays the line to the pane edge. "
            "line.delete(id) removes it.\n"
            "box.new(left, top, right, bottom, borderColor?, bgColor?, width?, id?) — "
            "rectangle zone; bgColor is the translucent fill, distinct from the border "
            "color. box.delete(id) removes it.\n"
            "circle.new(x1, y1, x2, y2, color?, bgColor?, width?, id?) — ellipse inscribed "
            "in the (x1,y1)-(x2,y2) bounding box.\n"
            "arrow.new(x1, y1, x2, y2, color?, width?, id?) — freeform point-to-point "
            "arrow (distinct from plotarrow's per-bar directional marker).\n"
            "polyline.new(points, color?, width?, closed?, id?) — points is an array of "
            "[bar_index, price] pairs. closed=true connects the last point back to the "
            "first.\n"
            "linefill.new(lineId1, lineId2, color) — translucent band filling the area "
            "between two already-created line.new ids.\n\n"
            "THE ID IDIOM (critical — this is how Pine-style handles work here since the "
            "whole script re-runs every bar): pass the SAME literal id string every time "
            "to MUTATE one persistent object in place instead of stacking duplicates — "
            "e.g. a moving trendline: line.new(pivotBar, pivotPrice, bar_index, close, "
            "\"#22aaff\", 2, \"solid\", \"none\", \"trend1\") called UNCONDITIONALLY every bar "
            "just moves trend1's endpoint. A growing zone: box.new(zoneLeft, zoneHigh, "
            "bar_index, zoneLow, \"#ffd43b\", \"rgba(255,212,59,0.08)\", 1, \"zone1\") called "
            "unconditionally with the same id each bar just extends `right`. OMIT the id "
            "to get a NEW object each time the call fires (auto id "
            "`type:auto:barIndex`) — correct for \"mark every pivot\" style calls inside a "
            "conditional, one object per signal, rolling-capped (30 for line/box/circle/"
            "arrow, 20 for polyline/linefill/image, 6 for table) so old ones age out "
            "automatically. Passing a literal id INSIDE a conditional block is a common "
            "mistake — every firing collapses onto the same one object; derive the id "
            "from bar_index (e.g. \"piv:\" + tostring(bar_index)) if one object per signal "
            "is intended.\n"
            "barcolor(color, pane?) recolors the current bar's candle body/wick — call "
            "inside a signal condition, the bar-level analog to bgcolor()."
        ),
        "keywords": [
            "line", "box", "polyline", "circle", "arrow", "linefill", "drawing",
            "trendline", "zone", "rectangle", "id", "handle", "moving", "growing",
            "persistent", "barcolor", "line.new", "box.new",
        ],
    },
    {
        "title": "Tables & Dashboards",
        "content": (
            "table.new(position, columns, rows, bgColor?, id?) — creates a screen-"
            "anchored dashboard grid and returns a live handle. position is one of 9 "
            "screen anchors: \"top_left\", \"top_right\", \"top_center\", \"middle_left\", "
            "\"middle_center\", \"middle_right\", \"bottom_left\", \"bottom_right\", "
            "\"bottom_center\" — anchored against the chart's screen pixels, NOT "
            "bar/price like every other drawing object.\n"
            "table.cell(handle, col, row, text, bgColor?, textColor?) — sets one cell "
            "(0-indexed col/row) on the handle returned by table.new.\n"
            "Idiom: rebuild the whole table every bar (matches Pine's own idiom) — "
            "declare tbl = table.new(\"top_right\", 2, 3, \"rgba(10,10,20,0.85)\", \"dash1\") "
            "unconditionally at top level, then table.cell(tbl, 0, 0, \"Session\", ...) / "
            "table.cell(tbl, 1, 0, tostring(round(r)), ...) calls right after — the same "
            "id keeps mutating one table in place instead of stacking. Use for session "
            "stats, multi-timeframe readouts, or any labeled key/value corner dashboard "
            "— a 2D screen-space alternative to a 3D ribbon dashboard."
        ),
        "keywords": [
            "table", "dashboard", "cell", "position", "anchor", "corner", "grid",
            "session stats", "screen", "table.new", "table.cell",
        ],
    },
    {
        "title": "Images — Import & Signals",
        "content": (
            "Two source forms, resolved identically everywhere an image builtin takes a "
            "`source` argument: (1) an inline data URI — a string starting with "
            "\"data:image/\" — fully self-contained in the script; or (2) the exact string "
            "name of an image saved via the editor's Image Assets panel (uploaded PNG/"
            "JPEG, stored locally). An unresolvable name renders nothing rather than "
            "crashing.\n"
            "image.new(x, y, source, width?, height?, anchor?, opacity?, rotation?, id?) "
            "— places an image at (bar_index, price). anchor: \"center\"|\"top_left\"|"
            "\"top_right\"|\"bottom_left\"|\"bottom_right\". width/height are PIXELS "
            "(screen-space, like every label/marker size in OakScript) — NOT price "
            "units, so they don't distort under zoom/pan. rotation is degrees. Same id "
            "mutates in place, same idiom as line.new/box.new — good for a fixed "
            "logo/watermark.\n"
            "plotimage(bar_index, price, source, width?, height?, pane?, id?) — per-bar "
            "image SIGNAL marker, the image equivalent of plotshape; call inside a "
            "signal condition to stamp a custom icon (e.g. a custom buy/sell glyph) at "
            "that bar instead of the built-in triangle/cross/diamond shapes.\n"
            "plotimage_3d(bar_index, price, source, size?, z_level?, pane?, rx?, ry?, "
            "rz?) — billboard sprite version for a pane=\"3d\"/\"separate\" scene; faces "
            "the camera like label3d. Only images get a 3D form — line/box/polyline/"
            "table/circle/arrow are 2D-only.\n"
            "Common uses: a corner logo/watermark (image.new with a saved asset name, "
            "high opacity, fixed id); a custom buy/sell icon replacing plotshape's "
            "built-in triangles (plotimage inside if buySig { ... })."
        ),
        "keywords": [
            "image", "images", "picture", "logo", "watermark", "png", "jpeg",
            "upload", "asset", "plotimage", "icon", "signal marker", "billboard",
            "sprite", "anchor", "rotation", "opacity", "image.new",
        ],
    },
    {
        "title": "Analyst Overlay Tools — Fibonacci, Gann, Regression Channel",
        "content": (
            "fibretracement.new(x1, y1, x2, y2, levels?, colorUp?, colorDown?, id?) — "
            "draws N retracement lines between two anchor points (a swing high/low "
            "pair). levels defaults to the 7 standard ratios [0, 0.236, 0.382, 0.5, "
            "0.618, 0.786, 1]; each ratio becomes its own line_obj internally (sub-ids "
            "derived from id), so a single id still updates the whole set in place on "
            "the next call.\n"
            "gannfan.new(x1, y1, angleUnit?, color?, id?) — draws the 7 classic Gann "
            "fan angles (1x8, 1x4, 1x3, 1x2, 1x1, 2x1, 4x1) radiating from (x1, y1).\n"
            "regression.channel(source, length, mult?) — CALCULATION ONLY, not an "
            "auto-drawing primitive like the two above: returns {mid, upper, lower} per "
            "bar, same shape as macd(). mid is a moving-average midline over `length` "
            "bars, upper/lower are mid ± mult * stdev(source, length) (mult defaults "
            "2.0). Render it yourself with existing primitives — the standard recipe:\n"
            "    rc = regression.channel(close, 100, 2.0)\n"
            "    plot(rc.mid, \"Reg Mid\", \"#b48cff\", 1)\n"
            "    plot(rc.upper, \"Reg Upper\", \"#22aaff\", 1)\n"
            "    plot(rc.lower, \"Reg Lower\", \"#22aaff\", 1)\n"
            "    fill(rc.upper, rc.lower, \"rgba(34,170,255,0.06)\")"
        ),
        "keywords": [
            "fibonacci", "fib", "retracement", "gann", "fan", "angle", "regression",
            "channel", "analyst", "overlay", "swing", "golden pocket",
            "fibretracement.new", "gannfan.new", "regression.channel",
        ],
    },
    {
        "title": "Model Execution — model.entry / model.exit / model.confidence / model.stopLoss / model.takeProfit",
        "content": (
            "model.entry(direction, id?, qty?) / model.longEntry(id?, qty?) / "
            "model.shortEntry(id?, qty?) / model.exit(id?) / model.longExit(id?) / "
            "model.shortExit(id?) / model.confidence(value) / model.stopLoss(value, mode?) / "
            "model.takeProfit(value, mode?) — order-EVENT builtins consumed by the Time "
            "Machine backtest panel AND the live paper auto-trader (per-model arm toggle "
            "in the Active Signal Models list); not the plain chart-render path (a script "
            "using them still renders normally as a signal analysis model otherwise). "
            "This is the point of Signal Analysis Models: one script is both the chart "
            "study and the executable model — no separate indicator/strategy split. A "
            "script with no model.* calls at all is STILL backtestable/auto-tradable if "
            "it plots Buy/Sell shapes — the Signal Engine derives entries/exits from the "
            "marker labels automatically.\n"
            "direction is \"long\" or \"short\" (model.entry) or baked into the name "
            "(model.longEntry/model.shortEntry); id is a label carried on the order for "
            "readability, NOT compared when filling. model.longExit/model.shortExit are "
            "DIRECTION-CONDITIONAL — they only close if the open position is currently "
            "that side (no-op otherwise), letting a long/short model manage each side "
            "independently; model.exit closes whichever side is open. "
            "model.confidence(0-1) is sticky metadata attached to subsequent entries "
            "(NEVER a position-size multiplier). model.stopLoss/model.takeProfit(value, "
            "mode? \"pct\"|\"abs\") are sticky per-entry brackets that override the "
            "backtest form's SL/TP for entries that carry them; value<=0 clears them.\n"
            "POSITION-LEVEL, NOT ID-LEVEL: the broker tracks one position per SYMBOL. An "
            "entry is a no-op if a position is already open (no pyramiding/adding); an "
            "exit is a no-op if nothing matching is open and always closes the WHOLE "
            "position (no partial exit).\n"
            "EXECUTION: the backtest runs the script ONCE over the full historical range "
            "(persist/var state and warmup carry through unbroken, exactly like a normal "
            "render). Each call is recorded on the bar it fired and filled at the NEXT "
            "bar's open (no lookahead) — never the same bar's close. The live auto-trader "
            "uses the same next-evaluation semantics. Once a stop-loss/take-profit/"
            "trailing bracket is live it's checked INTRABAR against each bar's full "
            "high/low range (not just open/close), with gap-through pricing — only "
            "brackets get this, signal entries/exits still fill next-bar-open.\n"
            "Exactly like plotshape, an unconditional top-level call fires every bar — "
            "always wrap it in a signal condition.\n"
            "    fast = sma(close, 5)\n"
            "    slow = sma(close, 20)\n"
            "    if crossover(fast, slow) {\n"
            "        model.confidence(0.6)\n"
            "        model.longEntry(\"ma_cross\")\n"
            "    }\n"
            "    if crossunder(fast, slow) {\n"
            "        model.longExit(\"ma_cross\")\n"
            "    }\n"
            "The Backtest panel reports in-sample/out-of-sample stats SIDE BY SIDE from "
            "one fixed historical split (equity curve, max drawdown, per-bar "
            "unannualized Sharpe, win rate, avg win/loss) — never just one sample alone.\n"
            "LEGACY ALIASES: strategy.entry(direction, id?, qty?) / strategy.exit(id?) "
            "still work exactly as before (identical to model.entry/model.exit) — kept "
            "for existing scripts. Prefer model.* in new scripts; strategy.entry/exit "
            "have no direction-conditional exit or confidence/bracket calls."
        ),
        "keywords": [
            "backtest", "backtesting", "time machine", "model.entry", "model.exit",
            "model.longentry", "model.shortentry", "model.longexit", "model.shortexit",
            "model.confidence", "model.stoploss", "model.takeprofit",
            "strategy.entry", "strategy.exit", "strategy",
            "entry", "exit", "long", "short", "equity curve", "drawdown",
            "sharpe", "win rate", "in-sample", "out-of-sample", "paper broker",
            "auto-trade", "auto-trader", "automation", "confidence", "stop loss",
            "take profit", "signal analysis model", "model",
        ],
    },
    {
        "title": "ML / RL — ml.predict / rl.action",
        "content": (
            "ml.predict(modelId) / rl.action(policyId) — read predictions from a model "
            "or policy trained in the 🧠 ML Lab panel (next to Backtest/Optimize in the "
            "editor toolbar), NOT something the agent can train on the user's behalf — "
            "never invent a model/policy id; tell the user to train one in ML Lab and "
            "give you its id, or write the script with a placeholder id.\n"
            "Both ml.predict and rl.action come in a CLASSICAL and a DEEP flavor, "
            "picked per model in ML Lab (not a global setting) — classical is a "
            "legitimate fast choice on any machine, not merely a fallback for "
            "underpowered ones.\n"
            "ml.predict(modelId): returns a 0-1 probability (direction model: predicts "
            "next-H-bar up/down) or a raw predicted return (regression model) for the "
            "CURRENT bar. Neutral 0.5 until the model resolves. Classical: gradient "
            "boosting / a real 2-hidden-layer neural net (MLP) / logistic-ridge "
            "regression via scikit-learn. Deep: an LSTM via PyTorch — its real "
            "difference is seeing a SLIDING WINDOW of the last ~20 bars' features, not "
            "just the current bar's snapshot the way every classical option does. All "
            "trained on the same standard technical feature set (multi-lookback "
            "returns, rolling volatility, RSI, MACD histogram, EMA spread, volume "
            "ratio, bar range/position). Training splits bars CHRONOLOGICALLY (train = "
            "first Train%, validate = the rest, never shuffled — shuffling would leak "
            "future bars into training). Every result is reported against an honest "
            "baseline: accuracy vs majority-class baseline for direction models, MAE "
            "vs always-predict-zero-change for regression models — deep models are not "
            "exempt and regularly don't beat a classical baseline on this much tabular "
            "data, which the panel shows plainly.\n"
            "rl.action(policyId): returns -1/0/1 (short/flat/long) — the greedy action "
            "of a trained policy. Genuine reinforcement learning either way: the agent "
            "is never given a labeled 'correct' action, only a reward (mark-to-market "
            "P&L on the position its action implies, minus a small cost for flipping) "
            "from acting against the same historical bars the backtester replays, "
            "learned via the standard Q-learning Bellman update across many training "
            "episodes. Classical: a from-scratch TABULAR Q-learning policy — state is "
            "4 features discretized into a fixed 625-cell table. Deep: a Deep "
            "Q-Network (DQN) via PyTorch — state is the full continuous 12-feature "
            "vector directly, no table to size. Neutral 0 (flat) until the policy "
            "resolves. ML Lab shows the episode-reward learning curve (proof it "
            "actually learned something across training) and the validated policy's "
            "held-out return against 'always long'/'always flat' baselines.\n"
            "DEVICE: the deep (LSTM/DQN) options need PyTorch installed on the "
            "backend, and pick a CUDA GPU automatically when the backend machine has "
            "one, running correctly (just slower) on CPU otherwise — ML Lab shows a "
            "device badge reporting which is in play before training. If the backend "
            "has no PyTorch installed, those two options are simply disabled in the "
            "panel with an explanation; every classical option keeps working "
            "regardless, since none of them ever touch torch.\n"
            "EXECUTION: on the live chart, predictions/actions resolve in the "
            "background against a synchronous cache (same pattern as async image "
            "decodes) — neutral value until the first fetch for that model/bar-range "
            "lands, then the next render picks up the real value. In Backtest/"
            "Optimizer runs, the script is scanned for ml.predict(\"id\")/"
            "rl.action(\"id\") calls and their data is fetched UP FRONT before the "
            "replay runs.\n"
            "    p = ml.predict(\"ml_a1b2c3d4e5\")\n"
            "    if crossover(fast, slow) and p > 0.55 {\n"
            "        model.confidence(p)\n"
            "        model.longEntry(\"ml_gated\")\n"
            "    }"
        ),
        "keywords": [
            "ml", "rl", "machine learning", "deep learning", "reinforcement learning",
            "ml.predict", "rl.action", "ml lab", "train a model", "train a policy",
            "gradient boosting", "neural net", "mlp", "logistic regression",
            "q-learning", "q learning", "qlearning", "policy", "reward",
            "feature importance", "baseline", "validation accuracy",
            "lstm", "dqn", "deep q-network", "deep q network", "pytorch", "torch",
            "gpu", "cuda", "device", "classical", "sliding window",
        ],
    },
    {
        "title": "Confirmed-Only Multi-Timeframe Confluence — security()",
        "content": (
            "security(timeframe, source) — OakScript's equivalent of Pine's "
            "request.security(), bare not dotted (OakScript drops Pine namespaces "
            "everywhere: ta.sma -> sma, input.int -> input). Reads a HIGHER "
            "timeframe's last CONFIRMED (fully closed) value of source, aggregated "
            "purely from bars already loaded for the current chart — no new fetch, "
            "no symbol argument (always the current chart's own symbol).\n"
            "CONFIRMED-ONLY: always the most recently CLOSED higher-timeframe "
            "bucket, NEVER the one still forming (that would repaint/lookahead). "
            "Returns NaN until the first bucket closes, then holds flat until the "
            "next one closes — same NaN-until-confirmed idiom as pivothigh/"
            "pivotlow, triggered by a timeframe-bucket boundary instead of a fixed "
            "left/right window.\n"
            "timeframe: one of 1s/5s/10s/30s/1m/5m/15m/30m/1h/4h/1d/1w "
            "(case-sensitive). source: close/high/low/open aggregate like a real "
            "OHLC roll-up (close and any derived expression take the LAST value in "
            "the bucket, high takes MAX, low takes MIN, open takes FIRST — no "
            "implicit sum for volume).\n"
            "Requesting a timeframe the SAME AS or FINER than what's loaded (e.g. "
            "\"1m\" on a 1m chart) returns NaN for every bar — there's nothing to "
            "downsample. Known limitation: the very first confirmed value can come "
            "from a partial bucket if the loaded window starts mid-bucket (no "
            "backend fetch to find the true bucket start) — self-heals after one "
            "full bucket.\n"
            "EXAMPLE — only take a 1m crossover signal that agrees with the 1h trend:\n"
            "    fast = sma(close, 9)\n"
            "    slow = sma(close, 21)\n"
            "    htfClose = security(\"1h\", close)\n"
            "    buySig = crossover(fast, slow) and close > htfClose\n"
            "    if buySig {\n"
            "        plotshape(bar_index, low, \"Buy\", \"triangleup\", \"#22cc88\")\n"
            "    }\n"
            "    plot(htfClose, \"1H Close\", \"#22aaff\", 1, \"stepline\")"
        ),
        "keywords": [
            "security", "mtf", "multi-timeframe", "multi timeframe", "higher timeframe",
            "htf", "confluence", "non-repainting", "repaint", "request.security",
            "confirmed", "timeframe",
        ],
    },
]

# ─── Function index: {"name": ..., "signature": ..., "desc": ..., "category": ...} ──
FUNCTIONS: list[dict] = [
    {"name": "sma", "signature": "sma(source, length)", "desc": "Simple Moving Average", "category": "moving_average"},
    {"name": "ema", "signature": "ema(source, length)", "desc": "Exponential Moving Average", "category": "moving_average"},
    {"name": "macd", "signature": "macd(source, fast, slow, signal)", "desc": "MACD -> {.macd, .signal, .hist}", "category": "moving_average"},
    {"name": "linreg", "signature": "linreg(source, length, offset)", "desc": "Linear regression (SMA-based)", "category": "moving_average"},
    {"name": "rsi", "signature": "rsi(source, length)", "desc": "Relative Strength Index 0-100", "category": "oscillator"},
    {"name": "cci", "signature": "cci(high, low, close, length)", "desc": "Commodity Channel Index", "category": "oscillator"},
    {"name": "roc", "signature": "roc(source, length)", "desc": "Rate of Change %", "category": "oscillator"},
    {"name": "stdev", "signature": "stdev(source, length)", "desc": "Standard Deviation", "category": "oscillator"},
    {"name": "vwap", "signature": "vwap(close, volume)", "desc": "Volume Weighted Average Price", "category": "volume_volatility"},
    {"name": "atr", "signature": "atr(high, low, close, length)", "desc": "Average True Range", "category": "volume_volatility"},
    {"name": "trueRange", "signature": "trueRange(high, low, close)", "desc": "Raw True Range array", "category": "volume_volatility"},
    {"name": "adx", "signature": "adx(high, low, close, length)", "desc": "Average Directional Index 0-100", "category": "volume_volatility"},
    {"name": "wma", "signature": "wma(source, length)", "desc": "Weighted Moving Average", "category": "moving_average"},
    {"name": "hma", "signature": "hma(source, length)", "desc": "Hull Moving Average (fast + smooth)", "category": "moving_average"},
    {"name": "rma", "signature": "rma(source, length)", "desc": "Wilder's smoothed MA (RSI-style)", "category": "moving_average"},
    {"name": "vwma", "signature": "vwma(source, length)", "desc": "Volume-Weighted Moving Average", "category": "moving_average"},
    {"name": "mom", "signature": "mom(source, length)", "desc": "Momentum: source - source[length]", "category": "oscillator"},
    {"name": "median", "signature": "median(source, length)", "desc": "Rolling median over window", "category": "oscillator"},
    {"name": "stoch", "signature": "stoch(high, low, close, length)", "desc": "Stochastic %K 0-100", "category": "oscillator"},
    {"name": "mfi", "signature": "mfi(high, low, close, volume, length)", "desc": "Money Flow Index 0-100", "category": "volume_volatility"},
    {"name": "obv", "signature": "obv(close, volume)", "desc": "On-Balance Volume (cumulative)", "category": "volume_volatility"},
    {"name": "cmf", "signature": "cmf(high, low, close, volume, length)", "desc": "Chaikin Money Flow -1..1", "category": "volume_volatility"},
    {"name": "pivothigh", "signature": "pivothigh(source, leftBars, rightBars)", "desc": "Pivot high price on its confirmation bar, NaN otherwise — test with ph > 0", "category": "signal"},
    {"name": "pivotlow", "signature": "pivotlow(source, leftBars, rightBars)", "desc": "Pivot low price on its confirmation bar, NaN otherwise — test with pl > 0", "category": "signal"},
    {"name": "color.from_gradient", "signature": "color.from_gradient(value, bottomValue, topValue, bottomColor, topColor)", "desc": "Interpolated color as value moves bottom->top (heatmaps)", "category": "color"},
    {"name": "pow", "signature": "pow(base, exponent)", "desc": "Power", "category": "math_string"},
    {"name": "sign", "signature": "sign(x)", "desc": "-1, 0, or 1", "category": "math_string"},
    {"name": "log10", "signature": "log10(x)", "desc": "Base-10 logarithm", "category": "math_string"},
    {"name": "avg", "signature": "avg(a, b, ...)", "desc": "Average of the arguments", "category": "math_string"},
    {"name": "crossover", "signature": "crossover(a, b)", "desc": "True when a crosses above b", "category": "signal"},
    {"name": "crossunder", "signature": "crossunder(a, b)", "desc": "True when a crosses below b", "category": "signal"},
    {"name": "barssince", "signature": "barssince(condition)", "desc": "Bars since condition was true", "category": "signal"},
    {"name": "highest", "signature": "highest(source, length)", "desc": "Highest value over window", "category": "signal"},
    {"name": "lowest", "signature": "lowest(source, length)", "desc": "Lowest value over window", "category": "signal"},
    {"name": "cum", "signature": "cum(source)", "desc": "Cumulative sum from bar 0", "category": "signal"},
    {"name": "change", "signature": "change(source)", "desc": "Difference from previous bar", "category": "signal"},
    {"name": "correlation", "signature": "correlation(a, b, length)", "desc": "Pearson correlation", "category": "signal"},
    {"name": "plot", "signature": "plot(value, title, color, linewidth, style?, pane?)", "desc": "2D line/area/histogram", "category": "plotting_2d"},
    {"name": "hline", "signature": "hline(value, color, pane?)", "desc": "Dashed horizontal reference line", "category": "plotting_2d"},
    {"name": "fill", "signature": "fill(top, bottom, color)", "desc": "Translucent band between two plots", "category": "plotting_2d"},
    {"name": "bgcolor", "signature": "bgcolor(color)", "desc": "Background tint per bar", "category": "plotting_2d"},
    {"name": "plotshape", "signature": "plotshape(bar_index, price, title, style, color, pane?)", "desc": "Shape marker at bar+price", "category": "plotting_2d"},
    {"name": "plotarrow", "signature": "plotarrow(bar_index, price, title, direction, color?, pane?)", "desc": "Directional arrow marker", "category": "plotting_2d"},
    {"name": "plotchar", "signature": "plotchar(bar_index, price, char, color?, pane?)", "desc": "Character/emoji marker", "category": "plotting_2d"},
    {"name": "label.new", "signature": "label.new(x, y, text, color?, size?, boxed?, align?)", "desc": "Text label at (bar_index, price); boxed defaults true (background chip); extended from the original 4-arg form with size/boxed/align", "category": "plotting_2d"},
    {"name": "plot3d", "signature": "plot3d(series, name, style, color, pane?, z_level?)", "desc": "3D visualization — 15 styles: surface/ribbon/bars3d/scatter/line3d/wireframe/mesh/helix/vortex/manifold/nebula/constellation/torus/trail/ridgeline; pane \"3d\"|\"separate\"|\"main\"; z_level stacks layers in depth", "category": "plotting_3d"},
    {"name": "plotshape_3d", "signature": "plotshape_3d(bar_index, price, title, shape, color, size, z_level?, pane?, rx?, ry?, rz?)", "desc": "3D marker at (bar, price, Z) — shapes cube/sphere/pyramid/torus/diamond/coneup/conedown; buy=coneup green below bar, sell=conedown red above bar (auto-offset, tip at price); size 0.2-3.0 (scale with signal strength); rx/ry/rz rotate in degrees; call inside a condition; pair with a plot3d of the same pane", "category": "plotting_3d"},
    {"name": "label3d", "signature": "label3d(bar_index, price, text, color?, size?, z_level?, pane?)", "desc": "Billboard text label at (bar, price, Z) in a 3D scene — short text, call inside a condition (40 most recent render)", "category": "plotting_3d"},
    {"name": "input", "signature": "input(default, title, min?, max?, step?)", "desc": "UI-adjustable parameter", "category": "input"},
    {"name": "color.new", "signature": "color.new(baseColor, transp)", "desc": "Add transparency to hex color", "category": "color"},
    {"name": "color.rgb", "signature": "color.rgb(r, g, b, transp?)", "desc": "Create color from RGB channels", "category": "color"},
    {"name": "tostring", "signature": "tostring(x)", "desc": "Convert to string", "category": "math_string"},
    {"name": "tonumber", "signature": "tonumber(x)", "desc": "Convert string to number", "category": "math_string"},
    {"name": "alert", "signature": "alert(message)", "desc": "Browser notification", "category": "alert"},
    {"name": "alertcondition", "signature": "alertcondition(condition, title, message)", "desc": "Conditional alert", "category": "alert"},
    {"name": "abs", "signature": "abs(x)", "desc": "Absolute value", "category": "math_string"},
    {"name": "min", "signature": "min(a, b)", "desc": "Minimum", "category": "math_string"},
    {"name": "max", "signature": "max(a, b)", "desc": "Maximum", "category": "math_string"},
    {"name": "floor", "signature": "floor(x)", "desc": "Round down", "category": "math_string"},
    {"name": "ceil", "signature": "ceil(x)", "desc": "Round up", "category": "math_string"},
    {"name": "round", "signature": "round(x)", "desc": "Round", "category": "math_string"},
    {"name": "sqrt", "signature": "sqrt(x)", "desc": "Square root", "category": "math_string"},
    {"name": "log", "signature": "log(x)", "desc": "Natural logarithm", "category": "math_string"},
    {"name": "exp", "signature": "exp(x)", "desc": "Exponential", "category": "math_string"},
    {"name": "sin", "signature": "sin(x)", "desc": "Sine", "category": "math_string"},
    {"name": "cos", "signature": "cos(x)", "desc": "Cosine", "category": "math_string"},
    {"name": "tan", "signature": "tan(x)", "desc": "Tangent", "category": "math_string"},
    {"name": "line.new", "signature": "line.new(x1, y1, x2, y2, color?, width?, style?, extend?, id?)", "desc": "Persistent line object; same id mutates it in place (moving trendline idiom), omit id for a new object every firing bar (rolling-capped at 30)", "category": "drawing_2d"},
    {"name": "line.delete", "signature": "line.delete(id)", "desc": "Removes a line created by line.new", "category": "drawing_2d"},
    {"name": "box.new", "signature": "box.new(left, top, right, bottom, borderColor?, bgColor?, width?, id?)", "desc": "Persistent rectangle zone; same id mutates in place (e.g. a growing consolidation zone as `right` advances)", "category": "drawing_2d"},
    {"name": "box.delete", "signature": "box.delete(id)", "desc": "Removes a box created by box.new", "category": "drawing_2d"},
    {"name": "circle.new", "signature": "circle.new(x1, y1, x2, y2, color?, bgColor?, width?, id?)", "desc": "Ellipse inscribed in the (x1,y1)-(x2,y2) bounding box", "category": "drawing_2d"},
    {"name": "arrow.new", "signature": "arrow.new(x1, y1, x2, y2, color?, width?, id?)", "desc": "Freeform point-to-point arrow (distinct from plotarrow's per-bar directional marker)", "category": "drawing_2d"},
    {"name": "polyline.new", "signature": "polyline.new(points, color?, width?, closed?, id?)", "desc": "Multi-point path; points is an array of [bar_index, price] pairs, closed=true connects last point back to first", "category": "drawing_2d"},
    {"name": "linefill.new", "signature": "linefill.new(lineId1, lineId2, color)", "desc": "Translucent band filling the area between two existing line.new ids", "category": "drawing_2d"},
    {"name": "table.new", "signature": "table.new(position, columns, rows, bgColor?, id?)", "desc": "Screen-anchored dashboard grid (position from 9 anchors); returns a handle for table.cell()", "category": "drawing_2d"},
    {"name": "table.cell", "signature": "table.cell(handle, col, row, text, bgColor?, textColor?)", "desc": "Sets one cell's text/colors on a table.new handle (0-indexed col/row)", "category": "drawing_2d"},
    {"name": "barcolor", "signature": "barcolor(color, pane?)", "desc": "Recolors the current bar's candle body/wick — call inside a signal condition, a bar-level analog to bgcolor()", "category": "drawing_2d"},
    {"name": "text.new", "signature": "text.new(x, y, text, color?, size?, id?)", "desc": "Sugar alias for label.new with boxed defaulting to false (plain text, no background chip)", "category": "drawing_2d"},
    {"name": "fibretracement.new", "signature": "fibretracement.new(x1, y1, x2, y2, levels?, colorUp?, colorDown?, id?)", "desc": "Draws N fibonacci retracement lines between two points (default levels 0/0.236/0.382/0.5/0.618/0.786/1)", "category": "drawing_analyst"},
    {"name": "gannfan.new", "signature": "gannfan.new(x1, y1, angleUnit?, color?, id?)", "desc": "Draws the 7 classic Gann fan angles radiating from (x1, y1)", "category": "drawing_analyst"},
    {"name": "regression.channel", "signature": "regression.channel(source, length, mult?)", "desc": "Calculation only -> {mid, upper, lower}; render with 3x plot()+fill(), same recipe as macd/bollinger", "category": "drawing_analyst"},
    {"name": "image.new", "signature": "image.new(x, y, source, width?, height?, anchor?, opacity?, rotation?, id?)", "desc": "Places an image at (bar_index, price); source is a data:image/... URI or a saved asset name; width/height in pixels, rotation in degrees", "category": "image"},
    {"name": "plotimage", "signature": "plotimage(bar_index, price, source, width?, height?, pane?, id?)", "desc": "Per-bar image signal marker (like plotshape but with a custom image) — call inside a condition", "category": "image"},
    {"name": "plotimage_3d", "signature": "plotimage_3d(bar_index, price, source, size?, z_level?, pane?, rx?, ry?, rz?)", "desc": "3D billboard sprite version of plotimage for pane=\"3d\"/\"separate\" scenes", "category": "image"},
    {"name": "model.entry", "signature": "model.entry(direction, id?, qty?)", "desc": "Backtest/live-auto-trade: opens a position for this symbol (\"long\"/\"short\"); no-op if one is already open — position-level, not id-level. Current primary API.", "category": "backtest"},
    {"name": "model.longEntry", "signature": "model.longEntry(id?, qty?)", "desc": "Opens a LONG position; same as model.entry(\"long\", ...) with direction baked into the name", "category": "backtest"},
    {"name": "model.shortEntry", "signature": "model.shortEntry(id?, qty?)", "desc": "Opens a SHORT position; same as model.entry(\"short\", ...) with direction baked into the name", "category": "backtest"},
    {"name": "model.exit", "signature": "model.exit(id?)", "desc": "Closes the ENTIRE open position for this symbol, whichever side; no-op if none is open; not a bracket-order (stop/limit/trailing) clone", "category": "backtest"},
    {"name": "model.longExit", "signature": "model.longExit(id?)", "desc": "Closes the position ONLY if currently long (no-op if short or flat) — direction-conditional", "category": "backtest"},
    {"name": "model.shortExit", "signature": "model.shortExit(id?)", "desc": "Closes the position ONLY if currently short (no-op if long or flat) — direction-conditional", "category": "backtest"},
    {"name": "model.confidence", "signature": "model.confidence(value)", "desc": "Sticky 0-1 confidence score attached to subsequent entries — metadata only, never a size multiplier", "category": "backtest"},
    {"name": "model.stopLoss", "signature": "model.stopLoss(value, mode?)", "desc": "Sticky per-entry stop-loss (mode \"pct\" default or \"abs\" $), overrides the backtest form's SL; value<=0 clears it", "category": "backtest"},
    {"name": "model.takeProfit", "signature": "model.takeProfit(value, mode?)", "desc": "Sticky per-entry take-profit (mode \"pct\" default or \"abs\" $), overrides the backtest form's TP; value<=0 clears it", "category": "backtest"},
    {"name": "strategy.entry", "signature": "strategy.entry(direction, id?, qty?)", "desc": "Legacy alias for model.entry — identical behavior. Prefer model.entry in new scripts.", "category": "backtest"},
    {"name": "strategy.exit", "signature": "strategy.exit(id?)", "desc": "Legacy alias for model.exit — identical behavior. Prefer model.exit in new scripts.", "category": "backtest"},
    {"name": "security", "signature": "security(timeframe, source)", "desc": "Last CONFIRMED (closed) higher-timeframe value of source, from bars already loaded; NaN until confirmed and NaN if timeframe isn't coarser than loaded resolution", "category": "mtf"},
]

# ─── Inline full examples ──────────────────────────────────────────
EXAMPLES: list[dict] = [
    {
        "name": "Trade Signal Skeleton (MA Cross + RSI Filter)",
        # The canonical shape of a signal-emitting indicator — inputs, calcs,
        # boolean conditions, conditional markers, unconditional plots last.
        "code": (
            'fastLen = input(9, "Fast MA")\n'
            'slowLen = input(21, "Slow MA")\n'
            'rsiLen = input(14, "RSI Length")\n'
            'rsiMax = input(70, "Max RSI for Buys")\n'
            'rsiMin = input(30, "Min RSI for Sells")\n\n'
            "fastMa = ema(close, fastLen)\n"
            "slowMa = ema(close, slowLen)\n"
            "r = rsi(close, rsiLen)\n\n"
            "buySig = crossover(fastMa, slowMa) and r < rsiMax\n"
            "sellSig = crossunder(fastMa, slowMa) and r > rsiMin\n\n"
            "if buySig {\n"
            '    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")\n'
            "}\n"
            "if sellSig {\n"
            '    plotshape(bar_index, high, "Sell", "triangledown", "#ff4477")\n'
            "}\n\n"
            'plot(fastMa, "Fast MA", "#22aaff", 2)\n'
            'plot(slowMa, "Slow MA", "#ffd43b", 2)\n'
            'plot(r, "RSI", "#b48cff", 2, "separate")\n'
            'hline(rsiMax, "#ff4477", "separate")\n'
            'hline(rsiMin, "#22cc88", "separate")\n'
            'plot3d(fastMa - slowMa, "MA Spread", "ribbon", "#22aaff", "separate")\n'
            'plot3d(r, "RSI Terrain", "surface", "#b48cff", "separate")'
        ),
        "keywords": ["signal", "buy", "sell", "trade", "entry", "exit", "cross",
                     "ma cross", "strategy", "skeleton", "template", "structure"],
    },
    {
        "name": "Anchored VWAP + Day Open Levels",
        # The canonical anchoring script: day-boundary detection, anchor-reset
        # accumulators, derived bands, anchored signals, stepline levels.
        "code": (
            'devMult = input(1.5, "Band Multiplier", 0.5, 4.0, 0.5)\n\n'
            "newDay = floor(time / 86400000) != floor(time[1] / 86400000)\n\n"
            "var dayOpen = 0.0\n"
            "if newDay or bar_index == 0 {\n"
            "    dayOpen := open\n"
            "}\n\n"
            "var cumPV = 0.0\n"
            "var cumV = 0.0\n"
            "var cumP2V = 0.0\n"
            "if newDay {\n"
            "    cumPV := 0.0\n"
            "    cumV := 0.0\n"
            "    cumP2V := 0.0\n"
            "}\n"
            "cumPV := cumPV + close * volume\n"
            "cumV := cumV + volume\n"
            "cumP2V := cumP2V + close * close * volume\n\n"
            "avwap = cumV > 0 ? cumPV / cumV : close\n"
            "spread2 = cumV > 0 ? cumP2V / cumV - avwap * avwap : 0\n"
            "dev = sqrt(max(spread2, 0))\n\n"
            "buySig = crossover(close, avwap) and close > dayOpen\n"
            "sellSig = crossunder(close, avwap) and close < dayOpen\n\n"
            "if buySig {\n"
            '    plotshape(bar_index, low, "AVWAP Buy", "triangleup", "#22cc88")\n'
            "}\n"
            "if sellSig {\n"
            '    plotshape(bar_index, high, "AVWAP Sell", "triangledown", "#ff4477")\n'
            "}\n\n"
            'plot(avwap, "Anchored VWAP", "#22aaff", 2)\n'
            'plot(avwap + dev * devMult, "Upper Band", "#b48cff", 1)\n'
            'plot(avwap - dev * devMult, "Lower Band", "#b48cff", 1)\n'
            'plot(dayOpen, "Day Open", "#ffd43b", 1, "stepline")\n'
            'plot3d(close - avwap, "VWAP Distance", "ribbon", "#22aaff", "separate")\n'
            'plot3d(dev, "Volatility", "surface", "#b48cff", "separate")'
        ),
        "keywords": ["anchor", "anchored", "vwap", "avwap", "session", "day open",
                     "bands", "reset", "accumulator"],
    },
    {
        "name": "RSI Divergence Detector",
        "code": (
            'rsiLen = input(14, "RSI Length")\n'
            'ob = input(70, "Overbought")\n'
            'os = input(30, "Oversold")\n\n'
            "r = rsi(close, rsiLen)\n\n"
            "var prevHigh = 0.0\n"
            "var prevRsiHigh = 0.0\n"
            "var prevLow = 999999.0\n"
            "var prevRsiLow = 0.0\n\n"
            "if crossunder(r, ob)\n"
            "    prevHigh := high\n"
            "    prevRsiHigh := r\n\n"
            "if crossover(r, os)\n"
            "    prevLow := low\n"
            "    prevRsiLow := r\n\n"
            'if prevHigh > 0 and high > prevHigh and r < prevRsiHigh\n'
            '    plotshape(bar_index, high, "Bear Div", "triangledown", "#ff4477")\n\n'
            'if prevLow < 999999 and low < prevLow and r > prevRsiLow\n'
            '    plotshape(bar_index, low, "Bull Div", "triangleup", "#22cc88")\n\n'
            'plot(r, "RSI", "#b48cff", 2, "separate")\n'
            'hline(ob, "#ff4477", "separate")\n'
            'hline(os, "#22cc88", "separate")\n'
            'plot3d(r, "RSI Wave", "surface", "#b48cff", "separate")'
        ),
        "keywords": ["divergence", "rsi", "swing", "state tracking"],
    },
    {
        "name": "MACD Dashboard",
        "code": (
            'fast = input(12, "Fast")\n'
            'slow = input(26, "Slow")\n'
            'sig = input(9, "Signal")\n\n'
            "m = macd(close, fast, slow, sig)\n\n"
            "if crossover(m.macd, m.signal)\n"
            '    plotshape(bar_index, low, "Bull Cross", "triangleup", "#22aaff")\n\n'
            "if crossunder(m.macd, m.signal)\n"
            '    plotshape(bar_index, high, "Bear Cross", "triangledown", "#ff8800")\n\n'
            "if m.hist > 0\n"
            '    bgcolor("rgba(34,136,255,0.04)")\n\n'
            'plot3d(m.macd, "MACD Line", "ribbon", "#22aaff", "separate")\n'
            'plot3d(m.signal, "Signal Line", "ribbon", "#ff8800", "separate")\n'
            'plot3d(m.hist, "Histogram", "bars3d", "#b48cff", "separate")\n'
            'hline(0, "#ffffff", "separate")'
        ),
        "keywords": ["macd", "dashboard", "ribbon", "crossover"],
    },
    {
        "name": "3D Showcase — Ridgeline Memory + Labeled Signals",
        # The canonical full-3D script: exclusive pane="3d" takeover, ridgeline
        # distribution, layered ribbon at its own z_level, shape+text markers.
        "code": (
            'pocLen = input(50, "POC Length")\n'
            'rsiLen = input(14, "RSI Length")\n\n'
            "poc = median(close, pocLen)\n"
            "r = rsi(close, rsiLen)\n"
            "dev = stdev(close, 20)\n\n"
            "reclaim = crossover(close, poc)\n"
            "loss = crossunder(close, poc)\n"
            "strength = min(abs(close - poc) / max(dev, 0.0001) + 0.6, 2.2)\n\n"
            "if reclaim {\n"
            '    plotshape_3d(bar_index, low, "Reclaim", "coneup", "#22cc88", strength, 0, "3d")\n'
            '    label3d(bar_index, low, "POC RECLAIM", "#22cc88", 1.1, 0, "3d")\n'
            "}\n"
            "if loss {\n"
            '    plotshape_3d(bar_index, high, "Loss", "conedown", "#ff4477", strength, 0, "3d")\n'
            '    label3d(bar_index, high, "POC LOSS", "#ff4477", 1.1, 0, "3d")\n'
            "}\n\n"
            'plot3d(close, "Price Memory", "ridgeline", "#b48cff", "3d", 0)\n'
            'plot3d(r, "RSI Ribbon", "ribbon", "#22aaff", "3d", 1)\n'
            'plot3d(dev, "Volatility Bars", "bars3d", "#ffd43b", "3d", 2)'
        ),
        "keywords": ["3d", "ridgeline", "label3d", "plotshape_3d", "showcase",
                     "profile", "joyplot", "z_level", "pane", "flagship"],
    },
    {
        "name": "Bollinger Bands + Volume Terrain",
        "code": (
            'len = input(20, "Length")\n'
            'mult = input(2.0, "Multiplier", 0.5, 4.0, 0.5)\n\n'
            "mid = sma(close, len)\n"
            "upper = mid + stdev(close, len) * mult\n"
            "lower = mid - stdev(close, len) * mult\n\n"
            'plot(mid, "BB Mid", "#b48cff", 2)\n'
            'plot(upper, "BB Upper", "#ff4477", 1)\n'
            'plot(lower, "BB Lower", "#22cc88", 1)\n'
            'fill(upper, lower, "rgba(180,140,255,0.06)")\n\n'
            "bbWidth = upper - lower\n"
            "if bbWidth < lowest(bbWidth, 20)[0]\n"
            '    bgcolor("rgba(255,184,0,0.1)")\n\n'
            'plot3d(volume, "Volume", "bars3d", "#ffd43b", "separate")'
        ),
        "keywords": ["bollinger", "bands", "bb", "volatility", "volume terrain"],
    },
    {
        "name": "Support/Resistance Zone with box.new",
        # Canonical box.new "growing zone" idiom: unconditional top-level call,
        # same literal id every bar, right edge advances with bar_index.
        "code": (
            'lb = input(10, "Pivot Lookback")\n\n'
            "ph = pivothigh(high, lb, lb)\n"
            "pl = pivotlow(low, lb, lb)\n\n"
            "var zoneHigh = high\n"
            "var zoneLow = low\n"
            "var zoneLeft = bar_index\n\n"
            "if ph > 0 {\n"
            "    zoneHigh := ph\n"
            "    zoneLeft := bar_index - lb\n"
            "}\n"
            "if pl > 0 and pl < zoneLow {\n"
            "    zoneLow := pl\n"
            "}\n\n"
            'box.new(zoneLeft, zoneHigh, bar_index, zoneLow, "#ffd43b", '
            '"rgba(255,212,59,0.08)", 1, "srZone")\n\n'
            'plot(close, "Close", "#22aaff", 1)'
        ),
        "keywords": ["box.new", "support", "resistance", "zone", "sr", "pivot",
                     "growing zone", "rectangle", "consolidation"],
    },
    {
        "name": "Session Dashboard with table.new",
        # Canonical table.new/table.cell idiom: unconditional top-level rebuild
        # every bar, same id keeps mutating one table instead of stacking.
        "code": (
            "newDay = floor(time / 86400000) != floor(time[1] / 86400000)\n\n"
            "var sessHigh = high\n"
            "var sessLow = low\n"
            "if newDay or bar_index == 0 {\n"
            "    sessHigh := high\n"
            "    sessLow := low\n"
            "}\n"
            "if high > sessHigh {\n"
            "    sessHigh := high\n"
            "}\n"
            "if low < sessLow {\n"
            "    sessLow := low\n"
            "}\n\n"
            "r = rsi(close, 14)\n\n"
            'tbl = table.new("top_right", 2, 4, "rgba(10,10,20,0.85)", "sessTbl")\n'
            'table.cell(tbl, 0, 0, "Session High", "rgba(0,0,0,0)", "#ffffff")\n'
            'table.cell(tbl, 1, 0, tostring(round(sessHigh)), "rgba(0,0,0,0)", "#22cc88")\n'
            'table.cell(tbl, 0, 1, "Session Low", "rgba(0,0,0,0)", "#ffffff")\n'
            'table.cell(tbl, 1, 1, tostring(round(sessLow)), "rgba(0,0,0,0)", "#ff4477")\n'
            'table.cell(tbl, 0, 2, "RSI", "rgba(0,0,0,0)", "#ffffff")\n'
            'table.cell(tbl, 1, 2, tostring(round(r)), "rgba(0,0,0,0)", "#b48cff")\n'
            'table.cell(tbl, 0, 3, "Close", "rgba(0,0,0,0)", "#ffffff")\n'
            'table.cell(tbl, 1, 3, tostring(round(close)), "rgba(0,0,0,0)", "#22aaff")\n\n'
            'plot(close, "Close", "#22aaff", 1)'
        ),
        "keywords": ["table.new", "table.cell", "dashboard", "session",
                     "session high", "session low", "corner", "stats"],
    },
    {
        "name": "MA-Crossover Backtest with strategy.entry/exit",
        # Canonical Time Machine idiom: entry/exit gated behind conditions,
        # same id on both so the backtest panel's trade log reads cleanly.
        "code": (
            'fastLen = input(5, "Fast MA")\n'
            'slowLen = input(20, "Slow MA")\n\n'
            "fast = sma(close, fastLen)\n"
            "slow = sma(close, slowLen)\n"
            "buySig = crossover(fast, slow)\n"
            "sellSig = crossunder(fast, slow)\n\n"
            "if buySig {\n"
            '    strategy.entry("long", "ma_cross")\n'
            "}\n"
            "if sellSig {\n"
            '    strategy.exit("ma_cross")\n'
            "}\n\n"
            'plot(fast, "Fast", "#22cc88", 1)\n'
            'plot(slow, "Slow", "#ff4477", 1)'
        ),
        "keywords": ["strategy.entry", "strategy.exit", "backtest", "time machine",
                     "crossover strategy", "long", "flat", "equity curve"],
    },
    {
        "name": "1m Signal Confirmed by 1h Trend with security()",
        # Canonical MTF idiom: htfClose read once, compared against close
        # to gate the lower-timeframe signal — never used inside a
        # conditional itself (it's already confirmed/non-repainting).
        "code": (
            'fastLen = input(9, "Fast MA")\n'
            'slowLen = input(21, "Slow MA")\n\n'
            "fast = sma(close, fastLen)\n"
            "slow = sma(close, slowLen)\n"
            'htfClose = security("1h", close)\n\n'
            "buySig = crossover(fast, slow) and close > htfClose\n"
            "sellSig = crossunder(fast, slow) and close < htfClose\n\n"
            "if buySig {\n"
            '    plotshape(bar_index, low, "Buy", "triangleup", "#22cc88")\n'
            "}\n"
            "if sellSig {\n"
            '    plotshape(bar_index, high, "Sell", "triangledown", "#ff4477")\n'
            "}\n\n"
            'plot(fast, "Fast", "#22cc88", 1)\n'
            'plot(slow, "Slow", "#ff4477", 1)\n'
            'plot(htfClose, "1H Close", "#22aaff", 1, "stepline")'
        ),
        "keywords": ["security", "mtf", "multi-timeframe", "confluence", "htf",
                     "higher timeframe", "confirmed", "non-repainting"],
    },
]


def _build_keyword_index() -> dict[str, list[int]]:
    """Build a keyword→section index for fast lookup."""
    idx: dict[str, list[int]] = {}
    for i, sec in enumerate(SECTIONS):
        for kw in sec.get("keywords", []):
            kw_lower = kw.lower()
            if kw_lower not in idx:
                idx[kw_lower] = []
            if i not in idx[kw_lower]:
                idx[kw_lower].append(i)
        # Also index words from title
        for word in re.findall(r"[a-z0-9_]+", sec["title"].lower()):
            if word not in idx:
                idx[word] = []
            if i not in idx[word]:
                idx[word].append(i)
    # Also index function names → their sections
    for fn in FUNCTIONS:
        name = fn["name"].lower().replace(".", "_")
        parts = name.split("_")
        for part in parts:
            if part not in idx:
                idx[part] = []
    return idx


_KEYWORD_INDEX = _build_keyword_index()


def _build_idf() -> dict[str, float]:
    """Inverse-document-frequency per term so rare, specific terms outscore
    common ones (e.g. 'rsi' should beat 'color' which appears everywhere)."""
    n = len(SECTIONS)
    df: dict[str, int] = {}
    for sec in SECTIONS:
        terms = {kw.lower() for kw in sec.get("keywords", [])}
        terms |= set(re.findall(r"[a-z0-9_]+", (sec["title"] + " " + sec["content"]).lower()))
        for t in terms:
            df[t] = df.get(t, 0) + 1
    return {t: math.log((n + 1) / (c + 0.5)) + 0.5 for t, c in df.items()}


_IDF = _build_idf()

# Concept expansion — maps natural-language intent to the DSL vocabulary so a
# request like "buy signal heatmap" reaches crossover + plotshape + color.
SYNONYMS: dict[str, list[str]] = {
    "average": ["sma", "ema", "moving"], "ma": ["sma", "ema"], "moving": ["sma", "ema", "linreg"],
    "buy": ["crossover", "triangleup", "signal", "long", "entry"],
    "long": ["crossover", "triangleup", "buy", "strategy.entry"],
    "entry": ["crossover", "plotshape", "signal", "strategy.entry"],
    "sell": ["crossunder", "triangledown", "signal", "short", "exit"],
    "short": ["crossunder", "triangledown", "sell", "strategy.entry"],
    "exit": ["crossunder", "plotshape", "signal", "strategy.exit"],
    "overbought": ["rsi", "cci", "hline"], "oversold": ["rsi", "cci", "hline"],
    "momentum": ["rsi", "roc", "macd"], "trend": ["ema", "sma", "adx"],
    "volatility": ["atr", "stdev", "bollinger"], "band": ["bollinger", "stdev", "fill"],
    "bollinger": ["stdev", "sma", "fill"], "channel": ["highest", "lowest", "fill", "regression.channel"],
    "heatmap": ["color", "ternary", "conditional"], "gradient": ["color", "fill", "area"],
    "cloud": ["fill", "area", "color"], "ribbon": ["plot3d", "ema"],
    "marker": ["plotshape", "plotchar", "plotarrow"], "arrow": ["plotarrow", "plotshape", "arrow.new"],
    "label": ["label.new", "plotchar"], "background": ["bgcolor", "color"],
    "trendline": ["line.new"], "zone": ["box.new"],
    "logo": ["image.new"], "watermark": ["image.new"],
    "fib": ["fibretracement.new"], "fibonacci": ["fibretracement.new"],
    "gann": ["gannfan.new"],
    "3d": ["plot3d", "plotshape_3d", "label3d", "surface", "ribbon"],
    "surface": ["plot3d"], "mesh": ["plot3d"],
    "helix": ["plot3d"], "vortex": ["plot3d"], "manifold": ["plot3d"],
    "nebula": ["plot3d"], "constellation": ["plot3d"], "torus": ["plot3d"],
    "trail": ["plot3d"], "ridgeline": ["plot3d", "profile"],
    "joyplot": ["ridgeline", "plot3d"], "distribution": ["ridgeline", "plot3d"],
    "profile": ["ridgeline", "plot3d", "volume"],
    "text": ["label3d", "label.new"], "annotate": ["label3d", "label.new"],
    "name": ["label3d"], "planet": ["plotshape_3d", "label3d"],
    "sphere": ["plotshape_3d"], "landscape": ["surface", "ridgeline", "plot3d"],
    "terrain": ["surface", "bars3d", "plot3d"],
    "dashboard": ["plot3d", "combine", "layer", "table.new"], "layer": ["combine", "plot3d", "fill"],
    "alert": ["alertcondition"], "notify": ["alert", "alertcondition"],
    "divergence": ["rsi", "crossover", "crossunder"], "color": ["color.new", "color.rgb"],
    "conditional": ["ternary"], "transparency": ["color.new", "rgba"],
    "trade": ["signal", "crossover", "crossunder", "plotshape", "buy", "sell"],
    "strategy": ["signal", "crossover", "crossunder", "plotshape", "structure",
                 "strategy.entry", "strategy.exit", "backtest"],
    "backtest": ["strategy.entry", "strategy.exit", "time machine", "equity curve"],
    "backtesting": ["strategy.entry", "strategy.exit", "time machine"],
    "time machine": ["strategy.entry", "strategy.exit", "backtest"],
    "equity curve": ["strategy.entry", "strategy.exit", "backtest", "drawdown"],
    "drawdown": ["backtest", "equity curve", "sharpe"],
    "mtf": ["security"], "multi-timeframe": ["security"], "multi timeframe": ["security"],
    "higher timeframe": ["security"], "htf": ["security"], "confluence": ["security"],
    "non-repainting": ["security"], "repaint": ["security"],
    "request.security": ["security"],
    "generate": ["structure", "skeleton"], "create": ["structure", "skeleton"],
    "pinescript": ["pine", "difference"], "pine": ["pinescript", "difference"],
}

# Always-on micro-guardrails so the model never forgets the non-negotiables.
SYNTAX_RULES = (
    "OakScript rules: use { } braces around any if/else/for/while block with more "
    "than one statement or nesting — braces have no indentation requirement and "
    "cannot misparse (brace-less indentation blocks work too, but EVERY statement "
    "in one must share the exact same column or it silently falls outside the "
    "block, which for a while loop can strand the counter update and freeze the "
    "page in an infinite loop); strings MUST be quoted "
    "(\"surface\", \"#22cc88\"); use == not = in conditions; colors are hex/rgba strings; "
    "MACD via m=macd(c,12,26,9) then m.macd/.signal/.hist; plot* calls must be outside "
    "conditions to always render. hline(price, color?, pane?) takes AT MOST 3 args — "
    "NOT Pine's hline(price, title, color, linestyle, linewidth); never add a 4th/5th "
    "style/linewidth argument, there is no title slot. A misspelled/undefined variable name reads as 0/false "
    "with NO error — before finishing, re-check every variable used against its actual "
    "input()/declaration name. Give each plot3d call a genuinely distinct source value "
    "(a count, a stdev, a raw vs. smoothed version) instead of visualizing the same "
    "number under 3 different style names. pane=\"3d\" is an exclusive main-chart "
    "takeover (no 2D or separate-pane 3D renders alongside it) and only one pane=\"3d\" "
    "plus one pane=\"separate\" 3D indicator can be active at a time. "
    "3D toolkit: plot3d(series, name, style, color, pane?, z_level?) — 15 styles: "
    "surface, ribbon, bars3d, scatter, line3d, wireframe, mesh, helix, vortex, "
    "manifold, nebula, constellation, torus, trail, ridgeline (temporal distribution "
    "joyplot). plotshape_3d(bar_index, price, title, shape, color, size, z_level?, "
    "pane?, rx?, ry?, rz?) with shapes cube/sphere/pyramid/torus/diamond/coneup/"
    "conedown — buy signals: \"coneup\" green at low (auto-offset below the bar, tip "
    "up); sell signals: \"conedown\" red at high (flipped, auto-offset above, tip "
    "down); size from signal strength; rx/ry/rz rotate in degrees — and label3d(bar_index, "
    "price, text, color?, size?, z_level?, pane?) billboard text labels — both go "
    "INSIDE signal conditions and need a plot3d of the same pane for scene context; "
    "in a pane=\"3d\" script BOTH must pass \"3d\" as their final argument or they "
    "default to the (hidden) separate pane and render nowhere. "
    "In 3D mode, 2D plot()/plotshape() do NOT render. "
    "3D LEVELS: fib/pivot/S-R level series in 3D must use style \"line3d\" (exact "
    "straight segments) — ribbon/surface spline-smooth steps into spike blades. "
    "Give each level line a DISTINCT z_level (0, 1, 2, …) so they separate into "
    "clean parallel planes; the same z_level for several lines ropes them together. "
    "label3d only for RARE standout moments, never every signal bar. "
    "VISUAL FOCUS: render ONLY what the request needs — max 2-3 plot3d layers, every "
    "visual element traced directly to the user's ask; no decorative extras or bonus "
    "derivative layers. When EDITING, never add visuals the user didn't request; when "
    "asked to remove/simplify visuals, removing them IS the task. Cone signals should "
    "expose markerSize = input(1.0, \"Marker Size\", 0.2, 3.0, 0.1) as a size multiplier. "
    "STRUCTURE (top-to-bottom, once per bar): 1) input() declarations 2) calculations "
    "(assign every variable before use) 3) var persistent state 4) boolean signal "
    "conditions 5) plotshape markers INSIDE if-blocks (buy at low/triangleup, sell at "
    "high/triangledown) 6) unconditional plot/hline/fill/plot3d LAST at top level. "
    "NOT PineScript: no ta./math. namespaces (bare rsi(), max()), no input.int, no "
    "named arguments, no indicator()/study() line, no shape.*/location.*/color.red "
    "constants, no nz()/na(); history indexing close[1]/myVar[1] DOES work. "
    "var is ONLY for persistent state with a LITERAL initial value (var last = 0.0) "
    "updated via := — a var initializer runs ONCE on bar 0 and FREEZES, so never "
    "declare per-bar calculations/conditions with var (plain assignment recomputes "
    "each bar). Negative history indexes (high[-1]) read the FUTURE and are "
    "forbidden — use [1]/[2] and confirm swings 1-2 bars late."
)


def _expand_tokens(tokens: set[str]) -> dict[str, float]:
    """Return {term: weight}: original tokens weight 1.0, expansions 0.45."""
    weighted: dict[str, float] = {t: 1.0 for t in tokens}
    for t in tokens:
        for syn in SYNONYMS.get(t, []):
            weighted[syn] = max(weighted.get(syn, 0.0), 0.45)
    return weighted


def search(query: str, max_results: int = 5) -> list[dict]:
    """Multi-dimensional search: returns relevant documentation sections.

    Matches across:
    1. Function names (exact match)
    2. Section titles
    3. Section keywords
    4. Category names
    5. Example names & keywords

    Returns a list of result dicts with keys: type, title, content, score.
    """
    query_lower = query.lower().strip()
    if not query_lower:
        return []

    tokens = set(re.findall(r"[a-z0-9_]+", query_lower))
    weighted = _expand_tokens(tokens)  # {term: weight} incl. concept expansion

    # ── Function matching (highest signal): whole-token or dotted-name hits ──
    fn_scores: dict[str, float] = {}
    matched_fns: list[dict] = []
    for fn in FUNCTIONS:
        nm = fn["name"].lower()
        parts = set(re.split(r"[._]", nm))
        s = 0.0
        if nm in query_lower:
            s += 6.0                      # exact name present in the request
        for part in parts:
            if part in weighted:
                s += 3.0 * weighted[part]  # token == a name component
        if s > 0:
            fn_scores[nm] = s
            matched_fns.append((s, fn))
    matched_fns.sort(key=lambda x: -x[0])

    # ── Section scoring: IDF-weighted keyword/title overlap + category boost ──
    section_scores: dict[int, float] = {}
    cats_hit = {fn["category"] for _, fn in matched_fns[:4]}
    for term, w in weighted.items():
        idf = _IDF.get(term, 1.0)
        for sec_idx in _KEYWORD_INDEX.get(term, []):
            section_scores[sec_idx] = section_scores.get(sec_idx, 0.0) + w * idf
    # Boost sections whose functions share a matched category.
    for i, sec in enumerate(SECTIONS):
        title_l = sec["title"].lower()
        if any(c and c.replace("_", " ") in title_l for c in cats_hit):
            section_scores[i] = section_scores.get(i, 0.0) + 1.5

    # ── Example scoring ──
    example_scores: list[tuple[float, dict]] = []
    for ex in EXAMPLES:
        s = 0.0
        for term, w in weighted.items():
            if any(term in kw.lower() for kw in ex.get("keywords", [])):
                s += 1.2 * w
            if term in ex["name"].lower():
                s += 2.0 * w
            if term in ex["code"].lower():
                s += 0.3 * w
        if s > 0:
            example_scores.append((s, ex))

    ranked_sections = sorted(section_scores.items(), key=lambda x: -x[1])
    results: list[dict] = []

    # Functions first (most actionable for the coder).
    for s, fn in matched_fns[:4]:
        results.append({"type": "function", "title": fn["signature"],
                        "content": fn["desc"], "score": round(s + 4.0, 2)})

    for sec_idx, score in ranked_sections[:max_results]:
        sec = SECTIONS[sec_idx]
        results.append({"type": "section", "title": sec["title"],
                        "content": sec["content"][:800], "score": round(score, 2)})

    example_scores.sort(key=lambda x: -x[0])
    for score, ex in example_scores[:2]:
        results.append({"type": "example", "title": ex["name"],
                        "content": ex["code"], "score": round(score, 2)})

    results.sort(key=lambda r: -r["score"])
    seen: set[str] = set()
    deduped: list[dict] = []
    for r in results:
        if r["title"] not in seen:
            seen.add(r["title"])
            deduped.append(r)
    return deduped[:max_results]


def retrieve(query: str, budget_chars: int = 2200) -> dict:
    """Budget-bounded retrieval bundle for the coder agent.

    Returns a ready-to-inject markdown string of ONLY the relevant docs
    (function signatures + top sections + one example), always prefixed with the
    micro syntax rules, packed to ~budget_chars. This is the token-efficient
    'tool' the agent calls instead of carrying the whole reference.
    """
    results = search(query, max_results=8)
    out: list[str] = [f"OAKSCRIPT SYNTAX: {SYNTAX_RULES}"]
    # budget_chars bounds the DYNAMIC per-query content (functions/sections/examples)
    # below, not this fixed prefix — SYNTAX_RULES alone (~3800 chars) already exceeds
    # every real caller's budget (2200/4500), so counting it against the same budget
    # meant retrieve() silently returned ONLY the syntax rules for every query,
    # regardless of relevance — the actual point of this function never fired.
    used = 0

    fns = [r for r in results if r["type"] == "function"]
    secs = [r for r in results if r["type"] == "section"]
    exs = [r for r in results if r["type"] == "example"]

    if fns:
        line = "FUNCTIONS: " + " | ".join(f"{r['title']} — {r['content']}" for r in fns)
        if used + len(line) <= budget_chars:
            out.append(line); used += len(line)

    for r in secs:
        block = f"## {r['title']}\n{r['content']}"
        if used + len(block) > budget_chars:
            block = block[: max(0, budget_chars - used)]
            if block:
                out.append(block); used = budget_chars
            break
        out.append(block); used += len(block)

    if exs and used < budget_chars - 200:
        ex = exs[0]
        block = f"## Example: {ex['title']}\n```oakscript\n{ex['content']}\n```"
        out.append(block[: budget_chars - used])

    bundle = "\n\n".join(out)
    return {
        "ok": True,
        "query": query,
        "bundle": bundle,
        "chars": len(bundle),
        "sources": [r["title"] for r in results],
    }


def get_function(name: str) -> Optional[dict]:
    """Return function signature + description by name (case-insensitive)."""
    q = name.lower().strip()
    for fn in FUNCTIONS:
        if fn["name"].lower() == q:
            return fn
        if fn["name"].lower().replace(".", "_") == q.replace(".", "_"):
            return fn
    return None


def get_section(title: str) -> Optional[dict]:
    """Return full section by title (case-insensitive partial match)."""
    q = title.lower().strip()
    for sec in SECTIONS:
        if sec["title"].lower() == q:
            return sec
    for sec in SECTIONS:
        if q in sec["title"].lower():
            return sec
    return None
