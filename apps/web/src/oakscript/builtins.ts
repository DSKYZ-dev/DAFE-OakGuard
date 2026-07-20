/**
 * OakScript builtin registry — single source of truth for SIGNATURE METADATA
 * (arg counts, arg names, style-enum values) of every builtin, old and new.
 *
 * This is metadata only, NOT execution logic. The interpreter
 * (`interpreter.ts`) already has the real, battle-tested `case` bodies for
 * every one of these names; this file exists so `validator.ts` (and, by
 * hand-copy discipline, `docs.ts`/`backend/oak_kb.py`/the coder-agent
 * prompts) has one place to read signatures from instead of re-deriving
 * them from the interpreter switch or hand-duplicating a second copy.
 *
 * See the plan's §1 sketch and §3 frozen signature table for the contract
 * this file implements.
 */

export interface BuiltinStyleCheck {
  /** 0-indexed positional argument slot this check inspects. */
  argIndex: number;
  /** Valid literal string values for that argument. */
  values: Set<string>;
  /** ValidationIssue.code emitted when the argument's value isn't in `values`. */
  code: string;
  /** Human-readable label for the argument, used to build the warning message. */
  label: string;
}

export interface BuiltinDef {
  /** Dotted or bare builtin name, e.g. 'line.new', 'plotimage', 'sma'. */
  name: string;
  category: 'drawing_2d' | 'drawing_analyst' | 'image' | 'existing';
  minArgs: number;
  maxArgs: number;
  /** Positional argument names, in order (optional args are suffixed '?'). */
  argDescriptions: string[];
  /** Style-enum args (e.g. plotshape's style, line.new's style/extend) checked against a fixed value set. */
  styleChecks?: BuiltinStyleCheck[];
  /** OakPlot.type this builtin creates/mutates via upsertObject, if any — drives the id-guard idiom checks. */
  emitsObjectType?: string;
  /** True if this builtin accepts an optional trailing `id` argument (same-id-mutates-in-place idiom). */
  hasIdArg?: boolean;
  summary: string;
}

// ─── Style-enum value sets ──────────────────────────────────────────────
// Pre-existing (moved here from validator.ts so plotshape/plot3d's checks
// are driven by the same registry-based STYLE_CHECKS machinery as the new
// drawing-object checks below — see validator.ts).
export const PLOTSHAPE_STYLES = new Set([
  'triangleup', 'triangledown', 'circle', 'cross', 'xcross',
  'square', 'diamond', 'arrowup', 'arrowdown',
]);

export const PLOT3D_STYLES = new Set([
  'surface', 'ribbon', 'bars3d', 'scatter', 'line3d', 'wireframe', 'mesh',
  'helix', 'vortex', 'manifold', 'nebula', 'constellation', 'torus', 'trail',
  'ridgeline',
]);

// New style-checkable args introduced by the drawing-layer upgrade.
export const LINE_STYLES = new Set(['solid', 'dashed', 'dotted']);
export const LINE_EXTEND = new Set(['none', 'left', 'right', 'both']);
export const TABLE_POSITIONS = new Set([
  'top_left', 'top_right', 'top_center',
  'middle_left', 'middle_center', 'middle_right',
  'bottom_left', 'bottom_right', 'bottom_center',
]);
export const IMAGE_ANCHORS = new Set(['center', 'top_left', 'top_right', 'bottom_left', 'bottom_right']);

// ─── Registry ────────────────────────────────────────────────────────────
export const BUILTIN_REGISTRY: BuiltinDef[] = [
  // ── Existing — technical/series functions ────────────────────────────
  { name: 'sma', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Simple moving average.' },
  { name: 'ema', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Exponential moving average.' },
  { name: 'rsi', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Relative Strength Index.' },
  { name: 'macd', category: 'existing', minArgs: 4, maxArgs: 4, argDescriptions: ['source', 'fast', 'slow', 'signal'], summary: 'MACD line/signal/histogram record.' },
  { name: 'highest', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Highest value over a lookback window.' },
  { name: 'lowest', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Lowest value over a lookback window.' },
  { name: 'stdev', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Standard deviation over a lookback window.' },
  { name: 'roc', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Rate of change (%) over a lookback window.' },
  { name: 'cum', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['source'], summary: 'Cumulative running sum of a series.' },
  { name: 'change', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['source'], summary: 'Bar-to-bar difference of a series.' },
  { name: 'barssince', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['condition'], summary: 'Bars elapsed since a condition was last true.' },
  { name: 'vwap', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['close', 'volume'], summary: 'Volume-weighted average price.' },
  { name: 'linreg', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['source', 'length', 'offset'], summary: 'Linear regression value (SMA approximation).' },
  { name: 'correlation', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['a', 'b', 'length'], summary: 'Pearson correlation between two series over a window.' },
  { name: 'cci', category: 'existing', minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'], summary: 'Commodity Channel Index.' },
  { name: 'atr', category: 'existing', minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'], summary: 'Average True Range.' },
  { name: 'adx', category: 'existing', minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'], summary: 'Average Directional Index.' },
  { name: 'trueRange', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['high', 'low', 'close'], summary: 'True range per bar.' },
  { name: 'crossover', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['seriesA', 'seriesB'], summary: 'True on the bar series A crosses above series B.' },
  { name: 'crossunder', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['seriesA', 'seriesB'], summary: 'True on the bar series A crosses below series B.' },
  { name: 'wma', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Weighted moving average.' },
  { name: 'hma', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Hull moving average.' },
  { name: 'rma', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: "Wilder's smoothed moving average." },
  { name: 'vwma', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Volume-weighted moving average.' },
  { name: 'mom', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Momentum (value vs. N bars ago).' },
  { name: 'median', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'], summary: 'Rolling median over a window.' },
  { name: 'pivothigh', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['source', 'leftBars', 'rightBars'], summary: 'Confirmed pivot-high price.' },
  { name: 'pivotlow', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['source', 'leftBars', 'rightBars'], summary: 'Confirmed pivot-low price.' },
  { name: 'stoch', category: 'existing', minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'], summary: 'Stochastic %K.' },
  { name: 'mfi', category: 'existing', minArgs: 5, maxArgs: 5, argDescriptions: ['high', 'low', 'close', 'volume', 'length'], summary: 'Money Flow Index.' },
  { name: 'obv', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['close', 'volume'], summary: 'On-balance volume.' },
  { name: 'cmf', category: 'existing', minArgs: 5, maxArgs: 5, argDescriptions: ['high', 'low', 'close', 'volume', 'length'], summary: 'Chaikin Money Flow.' },
  { name: 'pow', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['base', 'exponent'], summary: 'x raised to y.' },
  { name: 'sign', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Sign of a number (-1/0/1).' },
  { name: 'log10', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Base-10 logarithm.' },
  { name: 'avg', category: 'existing', minArgs: 2, maxArgs: 8, argDescriptions: ['a', 'b', '...'], summary: 'Average of 2-8 numeric arguments.' },
  { name: 'color.from_gradient', category: 'existing', minArgs: 5, maxArgs: 5, argDescriptions: ['value', 'bottomValue', 'topValue', 'bottomColor', 'topColor'], summary: 'Interpolates a hex color between two colors by value.' },

  // ── Existing — plotting/rendering ────────────────────────────────────
  {
    name: 'plotshape_3d', category: 'existing', minArgs: 2, maxArgs: 11,
    argDescriptions: ['bar_index', 'price', 'title', 'shape', 'color', 'size', 'z_level', 'pane', 'rx_deg', 'ry_deg', 'rz_deg'],
    summary: 'Draws a 3D marker shape at a bar/price/z-level.',
  },
  {
    name: 'label3d', category: 'existing', minArgs: 3, maxArgs: 7,
    argDescriptions: ['bar_index', 'price', 'text', 'color', 'size', 'z_level', 'pane'],
    summary: 'Draws a 3D text label at a bar/price/z-level.',
  },
  { name: 'plot', category: 'existing', minArgs: 1, maxArgs: 6, argDescriptions: ['value', 'title', 'color', 'linewidth', 'style|pane', 'pane'], summary: 'Plots a numeric series on the main pane.' },
  {
    name: 'plotshape', category: 'existing', minArgs: 2, maxArgs: 6,
    argDescriptions: ['bar_index', 'price', 'title', 'style', 'color', 'pane'],
    styleChecks: [{ argIndex: 3, values: PLOTSHAPE_STYLES, code: 'UNKNOWN_SHAPE_STYLE', label: 'plotshape style' }],
    summary: 'Draws a 2D marker shape at a bar/price.',
  },
  { name: 'plotarrow', category: 'existing', minArgs: 2, maxArgs: 6, argDescriptions: ['bar_index', 'price', 'title', 'direction', 'color', 'pane'], summary: 'Draws a directional arrow marker at a bar/price.' },
  { name: 'plotchar', category: 'existing', minArgs: 2, maxArgs: 5, argDescriptions: ['bar_index', 'price', 'char', 'color', 'pane'], summary: 'Draws a character marker at a bar/price.' },
  {
    name: 'plot3d', category: 'existing', minArgs: 2, maxArgs: 6,
    argDescriptions: ['series', 'name', 'style', 'color', 'pane', 'z_level'],
    styleChecks: [{ argIndex: 2, values: PLOT3D_STYLES, code: 'UNKNOWN_3D_STYLE', label: 'plot3d style' }],
    summary: 'Plots a numeric series as a 3D surface/line style.',
  },
  { name: 'hline', category: 'existing', minArgs: 1, maxArgs: 3, argDescriptions: ['price', 'color', 'pane'], summary: 'Draws a horizontal reference line at a fixed price.' },
  { name: 'fill', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['top', 'bottom', 'color'], summary: 'Fills the area between two series.' },
  { name: 'bgcolor', category: 'existing', minArgs: 1, maxArgs: 2, argDescriptions: ['color', 'pane'], summary: 'Colors the chart background on a bar.' },
  { name: 'input', category: 'existing', minArgs: 1, maxArgs: 5, argDescriptions: ['default', 'title', 'min', 'max', 'step'], summary: 'Declares a user-configurable script input.' },
  { name: 'alert', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['message'], summary: 'Fires a one-shot alert message.' },
  { name: 'alertcondition', category: 'existing', minArgs: 2, maxArgs: 3, argDescriptions: ['condition', 'title', 'message'], summary: 'Declares a named alert condition.' },
  { name: 'abs', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Absolute value.' },
  { name: 'min', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['a', 'b'], summary: 'Minimum of two numbers.' },
  { name: 'max', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['a', 'b'], summary: 'Maximum of two numbers.' },
  { name: 'floor', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Round down to the nearest integer.' },
  { name: 'ceil', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Round up to the nearest integer.' },
  { name: 'round', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Round to the nearest integer.' },
  { name: 'sqrt', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Square root.' },
  { name: 'tostring', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Converts a value to a string.' },
  { name: 'tonumber', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['x'], summary: 'Converts a value to a number.' },
  { name: 'color.new', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['color', 'transp'], summary: 'Applies transparency to a hex color.' },
  { name: 'color.rgb', category: 'existing', minArgs: 3, maxArgs: 4, argDescriptions: ['r', 'g', 'b', 'transp'], summary: 'Builds a color from r/g/b(/transp) channels.' },

  // ── Existing — arrays/collections ────────────────────────────────────
  { name: 'array.get', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'index'], summary: 'Reads an array element by index.' },
  { name: 'array.set', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['array', 'index', 'value'], summary: 'Writes an array element by index.' },
  { name: 'array.push', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'], summary: 'Appends a value to the end of an array.' },
  { name: 'array.pop', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Removes and returns the last array element.' },
  { name: 'array.shift', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Removes and returns the first array element.' },
  { name: 'array.unshift', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'], summary: 'Inserts a value at the start of an array.' },
  { name: 'array.remove', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'index'], summary: 'Removes the element at an index.' },
  { name: 'array.insert', category: 'existing', minArgs: 3, maxArgs: 3, argDescriptions: ['array', 'index', 'value'], summary: 'Inserts a value at an index.' },
  { name: 'array.clear', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Empties an array.' },
  { name: 'array.size', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Returns array length.' },
  { name: 'array.includes', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'], summary: 'Tests whether an array contains a value.' },
  { name: 'array.indexOf', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'], summary: 'Finds the index of a value in an array.' },
  { name: 'array.slice', category: 'existing', minArgs: 2, maxArgs: 3, argDescriptions: ['array', 'from', 'to'], summary: 'Returns a sub-range of an array.' },
  { name: 'array.join', category: 'existing', minArgs: 1, maxArgs: 2, argDescriptions: ['array', 'separator'], summary: 'Joins array elements into a string.' },
  { name: 'array.copy', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Returns a shallow copy of an array.' },
  { name: 'array.reverse', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Reverses an array in place.' },
  { name: 'array.sort', category: 'existing', minArgs: 1, maxArgs: 2, argDescriptions: ['array', 'order'], summary: 'Sorts an array.' },
  { name: 'array.fill', category: 'existing', minArgs: 2, maxArgs: 4, argDescriptions: ['array', 'value', 'from', 'to'], summary: 'Fills a range of an array with a value.' },
  { name: 'array.sum', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Sums all array elements.' },
  { name: 'array.avg', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Averages all array elements.' },
  { name: 'array.min', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Minimum value in an array.' },
  { name: 'array.max', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Maximum value in an array.' },
  { name: 'array.median', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Median value in an array.' },
  { name: 'array.stdev', category: 'existing', minArgs: 1, maxArgs: 1, argDescriptions: ['array'], summary: 'Standard deviation of array values.' },
  { name: 'array.percentile', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'percent'], summary: 'Percentile value of an array.' },
  { name: 'array.head', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'count'], summary: 'First N elements of an array.' },
  { name: 'array.tail', category: 'existing', minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'count'], summary: 'Last N elements of an array.' },
  { name: 'array.range', category: 'existing', minArgs: 2, maxArgs: 3, argDescriptions: ['start', 'end', 'step'], summary: 'Builds an array of a numeric range.' },
  { name: 'oakring', category: 'existing', minArgs: 0, maxArgs: 1, argDescriptions: ['capacity'], summary: 'Creates a fixed-size circular buffer.' },
  { name: 'matrix', category: 'existing', minArgs: 2, maxArgs: 3, argDescriptions: ['rows', 'cols', 'initialValue'], summary: 'Creates a 2D matrix filled with an initial value.' },

  // ── New — drawing objects: lines, boxes, polylines, circles, arrows ──
  {
    name: 'line.new', category: 'drawing_2d', minArgs: 4, maxArgs: 9,
    argDescriptions: ['x1', 'y1', 'x2', 'y2', 'color?', 'width?', 'style?', 'extend?', 'id?'],
    styleChecks: [
      { argIndex: 6, values: LINE_STYLES, code: 'UNKNOWN_LINE_STYLE', label: 'line.new style' },
      { argIndex: 7, values: LINE_EXTEND, code: 'UNKNOWN_LINE_EXTEND', label: 'line.new extend' },
    ],
    emitsObjectType: 'line_obj', hasIdArg: true,
    summary: 'Creates or updates a persistent line segment between two points.',
  },
  {
    name: 'line.delete', category: 'drawing_2d', minArgs: 1, maxArgs: 1, argDescriptions: ['id'],
    emitsObjectType: 'line_obj',
    summary: 'Removes a line created by line.new.',
  },
  {
    name: 'box.new', category: 'drawing_2d', minArgs: 4, maxArgs: 8,
    argDescriptions: ['left', 'top', 'right', 'bottom', 'borderColor?', 'bgColor?', 'width?', 'id?'],
    emitsObjectType: 'box_obj', hasIdArg: true,
    summary: 'Creates or updates a persistent rectangle zone.',
  },
  {
    name: 'box.delete', category: 'drawing_2d', minArgs: 1, maxArgs: 1, argDescriptions: ['id'],
    emitsObjectType: 'box_obj',
    summary: 'Removes a box created by box.new.',
  },
  {
    name: 'circle.new', category: 'drawing_2d', minArgs: 4, maxArgs: 8,
    argDescriptions: ['x1', 'y1', 'x2', 'y2', 'color?', 'bgColor?', 'width?', 'id?'],
    emitsObjectType: 'circle_obj', hasIdArg: true,
    summary: 'Creates or updates a persistent ellipse inscribed in a bounding box.',
  },
  {
    name: 'arrow.new', category: 'drawing_2d', minArgs: 4, maxArgs: 7,
    argDescriptions: ['x1', 'y1', 'x2', 'y2', 'color?', 'width?', 'id?'],
    emitsObjectType: 'arrow_obj', hasIdArg: true,
    summary: 'Creates or updates a persistent freeform two-point arrow.',
  },
  {
    name: 'polyline.new', category: 'drawing_2d', minArgs: 1, maxArgs: 5,
    argDescriptions: ['points', 'color?', 'width?', 'closed?', 'id?'],
    emitsObjectType: 'polyline_obj', hasIdArg: true,
    summary: 'Creates or updates a persistent multi-point path (points = [[bar,price],...]).',
  },
  {
    name: 'linefill.new', category: 'drawing_2d', minArgs: 3, maxArgs: 3,
    argDescriptions: ['lineId1', 'lineId2', 'color'],
    emitsObjectType: 'linefill_obj',
    summary: 'Fills the band between two named lines (keyed on both ids, not a single id).',
  },

  // ── New — tables & dashboards ─────────────────────────────────────────
  {
    name: 'table.new', category: 'drawing_2d', minArgs: 3, maxArgs: 5,
    argDescriptions: ['position', 'columns', 'rows', 'bgColor?', 'id?'],
    styleChecks: [{ argIndex: 0, values: TABLE_POSITIONS, code: 'UNKNOWN_TABLE_POSITION', label: 'table.new position' }],
    emitsObjectType: 'table', hasIdArg: true,
    summary: 'Creates or updates a corner-anchored dashboard table; returns a cell-writable handle.',
  },
  {
    name: 'table.cell', category: 'drawing_2d', minArgs: 4, maxArgs: 6,
    argDescriptions: ['handle', 'col', 'row', 'text', 'bgColor?', 'textColor?'],
    summary: 'Writes text/colors into a table cell (free-function form of handle.cell(...)).',
  },

  // ── New — bar coloring ─────────────────────────────────────────────────
  {
    name: 'barcolor', category: 'drawing_2d', minArgs: 1, maxArgs: 2,
    argDescriptions: ['color', 'pane?'],
    summary: "Recolors the current bar's candle.",
  },

  // ── New — analyst overlay tools ───────────────────────────────────────
  {
    name: 'fibretracement.new', category: 'drawing_analyst', minArgs: 4, maxArgs: 8,
    argDescriptions: ['x1', 'y1', 'x2', 'y2', 'levels?', 'colorUp?', 'colorDown?', 'id?'],
    emitsObjectType: 'line_obj',
    summary: 'Draws a Fibonacci retracement ladder between two points (sugar over line.new, N sub-ids).',
  },
  {
    name: 'gannfan.new', category: 'drawing_analyst', minArgs: 2, maxArgs: 5,
    argDescriptions: ['x1', 'y1', 'angleUnit?', 'color?', 'id?'],
    emitsObjectType: 'line_obj',
    summary: 'Draws the 7 classic Gann fan angles from an anchor point (sugar over line.new).',
  },
  {
    name: 'regression.channel', category: 'drawing_analyst', minArgs: 2, maxArgs: 3,
    argDescriptions: ['source', 'length', 'mult?'],
    summary: 'Computes a regression mid-line and mult*stdev upper/lower bands — calculation only, pair with plot()+fill().',
  },

  // ── New — text/labels ──────────────────────────────────────────────────
  {
    name: 'text.new', category: 'drawing_2d', minArgs: 3, maxArgs: 6,
    argDescriptions: ['x', 'y', 'text', 'color?', 'size?', 'id?'],
    hasIdArg: true,
    summary: 'Creates or updates an unboxed text label (sugar over label.new with boxed=false).',
  },
  {
    name: 'label.new', category: 'drawing_2d', minArgs: 3, maxArgs: 7,
    argDescriptions: ['x', 'y', 'text', 'color?', 'size?', 'boxed?', 'align?'],
    summary: 'Creates a boxed (default) or unboxed text label at a bar/price.',
  },

  // ── New — images ───────────────────────────────────────────────────────
  {
    name: 'image.new', category: 'image', minArgs: 3, maxArgs: 9,
    argDescriptions: ['x', 'y', 'source', 'width?', 'height?', 'anchor?', 'opacity?', 'rotation?', 'id?'],
    styleChecks: [{ argIndex: 5, values: IMAGE_ANCHORS, code: 'UNKNOWN_IMAGE_ANCHOR', label: 'image.new anchor' }],
    emitsObjectType: 'image_obj', hasIdArg: true,
    summary: 'Places an image (inline data URI or saved asset name) at a bar/price.',
  },
  {
    name: 'plotimage', category: 'image', minArgs: 3, maxArgs: 7,
    argDescriptions: ['bar_index', 'price', 'source', 'width?', 'height?', 'pane?', 'id?'],
    summary: 'Draws a per-bar image signal marker.',
  },
  {
    name: 'plotimage_3d', category: 'image', minArgs: 3, maxArgs: 9,
    argDescriptions: ['bar_index', 'price', 'source', 'size?', 'z_level?', 'pane?', 'rx?', 'ry?', 'rz?'],
    summary: 'Draws a 3D billboard image sprite at a bar/price/z-level.',
  },
];

/**
 * Derives the validator's { minArgs, maxArgs, argDescriptions } signature
 * map from BUILTIN_REGISTRY. Replaces the old hand-written
 * BUILTIN_FN_SIGNATURES object in validator.ts.
 */
export function buildSignatureMap(): Record<string, { minArgs: number; maxArgs: number; argDescriptions: string[] }> {
  const map: Record<string, { minArgs: number; maxArgs: number; argDescriptions: string[] }> = {};
  for (const def of BUILTIN_REGISTRY) {
    map[def.name] = {
      minArgs: def.minArgs,
      maxArgs: def.maxArgs,
      argDescriptions: def.argDescriptions,
    };
  }
  return map;
}
