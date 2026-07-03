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
            "\"line3d\" thin ribbon (secondary series) | "
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
            "- nz(x) / na(x) / request.security / strategy.entry → do not exist. "
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
    {"name": "label.new", "signature": "label.new(x, y, text, color)", "desc": "Text label at position", "category": "plotting_2d"},
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
    "long": ["crossover", "triangleup", "buy"], "entry": ["crossover", "plotshape", "signal"],
    "sell": ["crossunder", "triangledown", "signal", "short", "exit"],
    "short": ["crossunder", "triangledown", "sell"], "exit": ["crossunder", "plotshape", "signal"],
    "overbought": ["rsi", "cci", "hline"], "oversold": ["rsi", "cci", "hline"],
    "momentum": ["rsi", "roc", "macd"], "trend": ["ema", "sma", "adx"],
    "volatility": ["atr", "stdev", "bollinger"], "band": ["bollinger", "stdev", "fill"],
    "bollinger": ["stdev", "sma", "fill"], "channel": ["highest", "lowest", "fill"],
    "heatmap": ["color", "ternary", "conditional"], "gradient": ["color", "fill", "area"],
    "cloud": ["fill", "area", "color"], "ribbon": ["plot3d", "ema"],
    "marker": ["plotshape", "plotchar", "plotarrow"], "arrow": ["plotarrow", "plotshape"],
    "label": ["label.new", "plotchar"], "background": ["bgcolor", "color"],
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
    "dashboard": ["plot3d", "combine", "layer"], "layer": ["combine", "plot3d", "fill"],
    "alert": ["alertcondition"], "notify": ["alert", "alertcondition"],
    "divergence": ["rsi", "crossover", "crossunder"], "color": ["color.new", "color.rgb"],
    "conditional": ["ternary"], "transparency": ["color.new", "rgba"],
    "trade": ["signal", "crossover", "crossunder", "plotshape", "buy", "sell"],
    "strategy": ["signal", "crossover", "crossunder", "plotshape", "structure"],
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
    "conditions to always render. A misspelled/undefined variable name reads as 0/false "
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
    used = len(out[0])

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
