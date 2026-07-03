/**
 * OakScript Validator — Pre-flight checks that catch common mistakes
 * BEFORE code hits the interpreter. Returns human-readable warnings
 * and errors the agent can use to self-correct.
 */
import { tokenize } from './lexer';
import { parse } from './parser';

export interface ValidationIssue {
  line: number;
  col: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const KNOWN_BLOCK_KEYWORDS = new Set(['if', 'else', 'for', 'while']);
const ALL_KEYWORDS = new Set([
  'indicator', 'strategy', 'plot', 'plotshape', 'plotshape_3d', 'plotarrow', 'plotchar', 'plot3d',
  'input', 'label', 'table', 'hline', 'fill', 'bgcolor',
  'var', 'varip', 'if', 'else', 'for', 'while', 'in',
  'break', 'continue', 'return', 'true', 'false', 'nil',
  'and', 'or', 'not', 'to', 'by', 'downto',
  'crossover', 'crossunder', 'barssince',
  'sma', 'ema', 'rsi', 'macd', 'highest', 'lowest', 'vwap',
  'cum', 'change', 'roc', 'stdev', 'variance', 'correlation',
  'close', 'open', 'high', 'low', 'volume', 'time', 'bar_index',
  'barstate', 'str',
  'alert', 'alertcondition',
  'line', 'box', 'polygon', 'circle',
  'array', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'sqrt', 'log', 'exp',
  'sin', 'cos', 'tan', 'tostring', 'tonumber', 'linreg', 'atr', 'cci', 'adx',
  'trueRange', 'log', 'oakring', 'matrix',
]);

const BUILTIN_FN_SIGNATURES: Record<string, { minArgs: number; maxArgs: number; argDescriptions: string[] }> = {
  sma:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  ema:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  rsi:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  macd:      { minArgs: 4, maxArgs: 4, argDescriptions: ['source', 'fast', 'slow', 'signal'] },
  highest:   { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  lowest:    { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  stdev:     { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  roc:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  cum:       { minArgs: 1, maxArgs: 1, argDescriptions: ['source'] },
  change:    { minArgs: 1, maxArgs: 1, argDescriptions: ['source'] },
  barssince: { minArgs: 1, maxArgs: 1, argDescriptions: ['condition'] },
  vwap:      { minArgs: 2, maxArgs: 2, argDescriptions: ['close', 'volume'] },
  linreg:    { minArgs: 3, maxArgs: 3, argDescriptions: ['source', 'length', 'offset'] },
  correlation: { minArgs: 3, maxArgs: 3, argDescriptions: ['a', 'b', 'length'] },
  cci:       { minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'] },
  atr:       { minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'] },
  adx:       { minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'] },
  trueRange: { minArgs: 3, maxArgs: 3, argDescriptions: ['high', 'low', 'close'] },
  crossover: { minArgs: 2, maxArgs: 2, argDescriptions: ['seriesA', 'seriesB'] },
  crossunder: { minArgs: 2, maxArgs: 2, argDescriptions: ['seriesA', 'seriesB'] },
  wma:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  hma:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  rma:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  vwma:      { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  mom:       { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  median:    { minArgs: 2, maxArgs: 2, argDescriptions: ['source', 'length'] },
  pivothigh: { minArgs: 3, maxArgs: 3, argDescriptions: ['source', 'leftBars', 'rightBars'] },
  pivotlow:  { minArgs: 3, maxArgs: 3, argDescriptions: ['source', 'leftBars', 'rightBars'] },
  stoch:     { minArgs: 4, maxArgs: 4, argDescriptions: ['high', 'low', 'close', 'length'] },
  mfi:       { minArgs: 5, maxArgs: 5, argDescriptions: ['high', 'low', 'close', 'volume', 'length'] },
  obv:       { minArgs: 2, maxArgs: 2, argDescriptions: ['close', 'volume'] },
  cmf:       { minArgs: 5, maxArgs: 5, argDescriptions: ['high', 'low', 'close', 'volume', 'length'] },
  pow:       { minArgs: 2, maxArgs: 2, argDescriptions: ['base', 'exponent'] },
  sign:      { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  log10:     { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  avg:       { minArgs: 2, maxArgs: 8, argDescriptions: ['a', 'b', '...'] },
  'color.from_gradient': { minArgs: 5, maxArgs: 5, argDescriptions: ['value', 'bottomValue', 'topValue', 'bottomColor', 'topColor'] },
  plotshape_3d: { minArgs: 2, maxArgs: 11, argDescriptions: ['bar_index', 'price', 'title', 'shape', 'color', 'size', 'z_level', 'pane', 'rx_deg', 'ry_deg', 'rz_deg'] },
  label3d:   { minArgs: 3, maxArgs: 7, argDescriptions: ['bar_index', 'price', 'text', 'color', 'size', 'z_level', 'pane'] },
  plot:      { minArgs: 1, maxArgs: 6, argDescriptions: ['value', 'title', 'color', 'linewidth', 'style|pane', 'pane'] },
  plotshape: { minArgs: 2, maxArgs: 6, argDescriptions: ['bar_index', 'price', 'title', 'style', 'color', 'pane'] },
  plotarrow: { minArgs: 2, maxArgs: 6, argDescriptions: ['bar_index', 'price', 'title', 'direction', 'color', 'pane'] },
  plotchar:  { minArgs: 2, maxArgs: 5, argDescriptions: ['bar_index', 'price', 'char', 'color', 'pane'] },
  plot3d:    { minArgs: 2, maxArgs: 6, argDescriptions: ['series', 'name', 'style', 'color', 'pane', 'z_level'] },
  hline:     { minArgs: 1, maxArgs: 3, argDescriptions: ['price', 'color', 'pane'] },
  fill:      { minArgs: 3, maxArgs: 3, argDescriptions: ['top', 'bottom', 'color'] },
  bgcolor:   { minArgs: 1, maxArgs: 2, argDescriptions: ['color', 'pane'] },
  input:     { minArgs: 1, maxArgs: 5, argDescriptions: ['default', 'title', 'min', 'max', 'step'] },
  alert:     { minArgs: 1, maxArgs: 1, argDescriptions: ['message'] },
  alertcondition: { minArgs: 2, maxArgs: 3, argDescriptions: ['condition', 'title', 'message'] },
  abs:       { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  min:       { minArgs: 2, maxArgs: 2, argDescriptions: ['a', 'b'] },
  max:       { minArgs: 2, maxArgs: 2, argDescriptions: ['a', 'b'] },
  floor:     { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  ceil:      { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  round:     { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  sqrt:      { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  tostring:  { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  tonumber:  { minArgs: 1, maxArgs: 1, argDescriptions: ['x'] },
  'label.new': { minArgs: 4, maxArgs: 4, argDescriptions: ['x', 'y', 'text', 'color'] },
  'color.new': { minArgs: 2, maxArgs: 2, argDescriptions: ['color', 'transp'] },
  'color.rgb': { minArgs: 3, maxArgs: 4, argDescriptions: ['r', 'g', 'b', 'transp'] },
  'array.get': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'index'] },
  'array.set': { minArgs: 3, maxArgs: 3, argDescriptions: ['array', 'index', 'value'] },
  'array.push': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'] },
  'array.pop': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.shift': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.unshift': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'] },
  'array.remove': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'index'] },
  'array.insert': { minArgs: 3, maxArgs: 3, argDescriptions: ['array', 'index', 'value'] },
  'array.clear': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.size': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.includes': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'] },
  'array.indexOf': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'value'] },
  'array.slice': { minArgs: 2, maxArgs: 3, argDescriptions: ['array', 'from', 'to'] },
  'array.join': { minArgs: 1, maxArgs: 2, argDescriptions: ['array', 'separator'] },
  'array.copy': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.reverse': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.sort': { minArgs: 1, maxArgs: 2, argDescriptions: ['array', 'order'] },
  'array.fill': { minArgs: 2, maxArgs: 4, argDescriptions: ['array', 'value', 'from', 'to'] },
  'array.sum': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.avg': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.min': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.max': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.median': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.stdev': { minArgs: 1, maxArgs: 1, argDescriptions: ['array'] },
  'array.percentile': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'percent'] },
  'array.head': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'count'] },
  'array.tail': { minArgs: 2, maxArgs: 2, argDescriptions: ['array', 'count'] },
  'array.range': { minArgs: 2, maxArgs: 3, argDescriptions: ['start', 'end', 'step'] },
  'oakring': { minArgs: 0, maxArgs: 1, argDescriptions: ['capacity'] },
  'matrix': { minArgs: 2, maxArgs: 3, argDescriptions: ['rows', 'cols', 'initialValue'] },
};

// Identifiers that are valid roots but absent from ALL_KEYWORDS / the lexer
// keyword set (e.g. `color.new(...)` — "color" alone is a plain identifier).
const KNOWN_EXTRA_IDENTIFIERS = new Set(['color', 'null', 'math', 'vwap', 'atr',
  'cci', 'adx', 'trueRange', 'linreg', 'variance', 'oakring', 'matrix',
  'tostring', 'tonumber', 'exp', 'sqrt', 'plot3d', 'label3d']);

// PineScript color constants — the giveaway that the model wrote Pine, not Oak.
const PINE_COLORS = 'red|green|blue|white|black|orange|yellow|purple|fuchsia|aqua|lime|maroon|navy|olive|silver|teal|gray|grey';

/** Blank out string contents and cut trailing // comments so regex checks
 * never fire on text inside quotes. Preserves column positions. */
function stripStringsAndComments(line: string): string {
  let out = '';
  let inStr = false, quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      out += ch === quote ? ((inStr = false), ch) : ' ';
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; out += ch; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    out += ch;
  }
  return out;
}

const PLOTSHAPE_STYLES = new Set([
  'triangleup', 'triangledown', 'circle', 'cross', 'xcross',
  'square', 'diamond', 'arrowup', 'arrowdown',
]);

const PLOT3D_STYLES = new Set([
  'surface', 'ribbon', 'bars3d', 'scatter', 'line3d', 'wireframe', 'mesh',
  'helix', 'vortex', 'manifold', 'nebula', 'constellation', 'torus', 'trail',
  'ridgeline',
]);

/**
 * Run pre-flight validation on OakScript source code.
 * Returns issues BEFORE attempting to parse — catches the most common LLM mistakes.
 */
export function validate(source: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const lines = source.split('\n');
  const tokens = tokenize(source);

  // ── Indentation check: if/else/for/while must be followed by indented body ──
  const nonCommentTokens = tokens.filter(t => t.type !== 'EOF');
  for (let i = 0; i < nonCommentTokens.length - 1; i++) {
    const t = nonCommentTokens[i];
    if (t.type === 'KEYWORD' && KNOWN_BLOCK_KEYWORDS.has(t.value)) {
      // Look ahead: next statement on the same or next logical line must be indented
      // or must be a block start `{`
      let j = i + 1;
      // Skip past the condition tokens (find next statement)
      while (j < nonCommentTokens.length) {
        const nt = nonCommentTokens[j];
        if (nt.type === 'KEYWORD' && ['if', 'for', 'while'].includes(nt.value)) break;
        if (nt.type === 'PUNCTUATION' && nt.value === '{') break;
        if (nt.type === 'IDENTIFIER' && j > i + 1) break;
        if (nt.type === 'KEYWORD' && ['var', 'varip', 'break', 'continue', 'return', 'plot', 'plotshape'].includes(nt.value)) break;
        j++;
      }
    }
  }

  // ── Per-line keyword checks ──
  for (let li = 0; li < lines.length; li++) {
    const lineNum = li + 1;
    const trimmed = lines[li].trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // Check for `=` used as comparison inside if/while conditions
    if (trimmed.startsWith('if ') || trimmed.startsWith('else if ') || trimmed.startsWith('while ')) {
      // Strip the keyword
      let condPart = trimmed.replace(/^(if|else if|while)\s+/, '');
      // Stop at comment or brace-block body — we only check the CONDITION
      const commentIdx = condPart.indexOf('//');
      const braceIdx = condPart.indexOf('{');
      let endIdx = condPart.length;
      if (commentIdx >= 0 && commentIdx < endIdx) endIdx = commentIdx;
      if (braceIdx >= 0 && braceIdx < endIdx) endIdx = braceIdx;
      condPart = condPart.slice(0, endIdx);
      // `=` by itself (not ==, !=, <=, >=, :=) in a condition is suspicious
      const singleEqRegex = /(?<![=!<>:])=(?![=])/g;
      let m;
      while ((m = singleEqRegex.exec(condPart)) !== null) {
        // Make sure this = is not inside a string
        const beforeEq = condPart.slice(0, m.index);
        const quoteCount = (beforeEq.match(/"/g) || []).length;
        if (quoteCount % 2 === 0) {
          issues.push({
            line: lineNum, col: m.index + (trimmed.length - condPart.length) + 1,
            severity: 'error',
            code: 'EQ_IN_CONDITION',
            message: `Assignment '=' found in condition. Did you mean comparison '==' ?`,
            fix: `Replace '=' with '==' or ':=' depending on intent. In conditions use '=='.`,
          });
          break; // one per line is enough
        }
      }
    }

    // Check for `input()` without assignment — must be assigned to a variable
    if (trimmed.includes('input(') && !trimmed.includes('=')) {
      issues.push({
        line: lineNum, col: 0,
        severity: 'error',
        code: 'INPUT_NO_ASSIGN',
        message: 'input() must be assigned to a variable. Example: len = input(14, "Length")',
        fix: 'Add assignment: varname = input(...)',
      });
    }
  }

  // ── PineScript idiom detection ──
  // LLMs trained on PineScript reach for its namespaces/constants/named args
  // by reflex; none of them exist in OakScript and most fail SILENTLY at
  // runtime (unknown names read as 0/false). Catch them with targeted fixes
  // so the self-correction loop converges instead of thrashing.
  for (let li = 0; li < lines.length; li++) {
    const lineNum = li + 1;
    const raw = lines[li];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const s = stripStringsAndComments(raw);

    let m: RegExpExecArray | null;
    if ((m = /(?<![\w.])(ta|request|syminfo|timeframe)\.([A-Za-z_]\w*)/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'PINE_NAMESPACE',
        message: `'${m[1]}.${m[2]}' is PineScript — the '${m[1]}.' namespace does not exist in OakScript.`,
        fix: m[1] === 'ta' ? `OakScript functions are bare: ta.${m[2]}(...) → ${m[2]}(...)` : 'Remove it — there is no equivalent; compute the value from close/open/high/low/volume directly.',
      });
    }
    if ((m = /(?<![\w.])math\.([A-Za-z_]\w*)/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'PINE_MATH',
        message: `'math.${m[1]}' is PineScript — OakScript math functions are bare.`,
        fix: `math.${m[1]}(...) → ${m[1]}(...)`,
      });
    }
    if ((m = /(?<![\w.])(shape|location|size)\.([A-Za-z_]\w*)/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'PINE_SHAPE',
        message: `'${m[1]}.${m[2]}' is PineScript — OakScript plotshape takes positional args with QUOTED style strings.`,
        fix: 'plotshape(bar_index, price, "Title", "triangleup", "#22cc88") — buy markers at low, sell markers at high, inside an if-block.',
      });
    }
    if ((m = new RegExp(`(?<![\\w.])color\\.(${PINE_COLORS})\\b`).exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'PINE_COLOR',
        message: `'color.${m[1]}' is PineScript — OakScript colors are quoted hex strings.`,
        fix: 'Use "#22cc88" (green), "#ff4477" (red), "#22aaff" (blue), etc.',
      });
    }
    if ((m = /(?<![\w.])input\.(int|float|bool|string|color|source|time|symbol)\s*\(/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'PINE_INPUT',
        message: `'input.${m[1]}()' is PineScript — OakScript has a single input().`,
        fix: 'len = input(14, "Length", 1, 100, 1) — (default, title, min?, max?, step?)',
      });
    }
    if (/^(indicator|study)\s*\(/.test(trimmed)) {
      issues.push({
        line: lineNum, col: 1, severity: 'error', code: 'PINE_DECLARATION',
        message: 'indicator()/study() declarations are PineScript — OakScript scripts start directly with code.',
        fix: 'Delete this line.',
      });
    }
    if (/^strategy\s*\(/.test(trimmed) || /(?<![\w.])strategy\.[A-Za-z_]/.test(s)) {
      issues.push({
        line: lineNum, col: 1, severity: 'error', code: 'PINE_STRATEGY',
        message: 'strategy()/strategy.* is PineScript — OakScript has no strategy engine.',
        fix: 'Express entries/exits as signals: if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") }',
      });
    }
    if ((m = /(?<![\w.])(nz|na|fixnan)\s*\(/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'PINE_NA',
        message: `'${m[1]}()' is PineScript — OakScript has no nz/na/fixnan.`,
        fix: 'Undefined/missing values already read as 0; guard with explicit comparisons (e.g. if bar_index > len).',
      });
    }
    // Named arguments (style=, color=, linewidth=) — all Oak args are positional.
    if (!/^for\b/.test(trimmed) && (m = /[(,]\s*([A-Za-z_]\w*)\s*=(?![=])/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'NAMED_ARGS',
        message: `Named argument '${m[1]}=' — OakScript arguments are positional only.`,
        fix: 'Pass values in order, e.g. plot(value, "Title", "#22cc88", 2).',
      });
    }

    // `var x = <dynamic expression>` — var initializers run ONCE on bar 0 and
    // the value persists (never recomputed). A per-bar calculation declared
    // with var silently FREEZES at its first-bar value: fib levels stuck,
    // signals never fire, the whole indicator looks alive but computes
    // nothing. This exact pattern shipped from an LLM draft.
    if ((m = /^\s*var(?:ip)?\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(s))) {
      const rhs = m[2].trim();
      const isLiteral = /^-?\d+(\.\d+)?$/.test(rhs) || /^".*"$/.test(rhs)
        || /^(true|false|null|nil)$/.test(rhs)
        || /^\[[^\]]*\]$/.test(rhs);
      const isAllowedCtor = /^(input|array|oakring|matrix)\s*\(/.test(rhs);
      if (!isLiteral && !isAllowedCtor) {
        issues.push({
          line: lineNum, col: 1, severity: 'error', code: 'VAR_DYNAMIC_INIT',
          message: `var ${m[1]} = <expression> initializes ONCE (bar 0) and then persists — this value will be FROZEN at its first-bar result, never recomputed.`,
          fix: `Per-bar calculation: drop the var → ${m[1]} = ${rhs.slice(0, 40)}. Persistent state: var ${m[1]} = 0.0, then update inside logic with ${m[1]} := ...`,
        });
      }
    }

    // Negative history index looks INTO THE FUTURE (repaints / cannot trade).
    if ((m = /\[\s*-\d+(\.\d+)?\s*\]/.exec(s))) {
      issues.push({
        line: lineNum, col: m.index + 1, severity: 'error', code: 'FUTURE_INDEX',
        message: `History index ${m[0]} references a FUTURE bar — signals would repaint and be untradeable.`,
        fix: 'Use [1] for the previous bar, [2] for two bars back. To confirm a swing, evaluate it 1-2 bars late (e.g. compare high[1] against high[2] and high).',
      });
    }
  }

  // ── Plot placement: unconditional renderers vs conditional markers ──
  // plot()/plot3d()/hline()/fill() must execute on EVERY bar (top level) or
  // the series renders nothing/gaps; plotshape() is the opposite — it draws a
  // marker per execution, so an UNconditional plotshape stamps every bar.
  {
    let depth = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineNum = li + 1;
      const raw = lines[li];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const s = stripStringsAndComments(raw);
      const inBlock = depth > 0 || /^\s/.test(raw);
      if (inBlock && /(?<![\w.])(plot|plot3d|hline|fill)\s*\(/.test(s)) {
        const fn = /(?<![\w.])(plot|plot3d|hline|fill)\s*\(/.exec(s)![1];
        issues.push({
          line: lineNum, col: 1, severity: 'warning', code: 'PLOT_IN_CONDITIONAL',
          message: `${fn}() inside a conditional/indented block — it must run on every bar or nothing renders reliably.`,
          fix: 'Move it to top level (column 0) and make the VALUE or COLOR conditional instead: plot(cond ? a : b, "T", cond ? "#22cc88" : "#ff4477", 2).',
        });
      }
      if (!inBlock && /^plotshape\s*\(/.test(s.trim())) {
        issues.push({
          line: lineNum, col: 1, severity: 'warning', code: 'PLOTSHAPE_UNCONDITIONAL',
          message: 'Unconditional plotshape() draws a marker on EVERY bar.',
          fix: 'Wrap it in a signal condition: if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") }',
        });
      }
      for (const ch of s) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
    }
  }

  // ── 3D pane mismatch: shapes/labels invisible in pane="3d" mode ──
  // When any plot3d uses pane="3d" (exclusive full-chart takeover), the lower
  // 3D pane is hidden — so a plotshape_3d/label3d that defaults to (or names)
  // "separate" renders NOWHERE. Silent, and exactly the arg a model forgets.
  {
    if (/plot3d\s*\([^)]*"3d"/.test(source)) {
      for (let li = 0; li < lines.length; li++) {
        const raw = lines[li].trim();
        if (!raw || raw.startsWith('//')) continue;
        const m = /(plotshape_3d|label3d)\s*\(([^)]*)\)/.exec(raw);
        if (m && !/"3d"/.test(m[2])) {
          issues.push({
            line: li + 1, col: 1, severity: 'error', code: 'MISMATCHED_3D_PANE',
            message: `${m[1]}() targets the "separate" pane, but a plot3d(..., "3d") call makes this an exclusive main-chart 3D indicator — the lower pane is hidden, so this marker renders NOWHERE.`,
            fix: `Add "3d" as the final pane argument: ${m[1]}(..., z_level, "3d").`,
          });
        }
      }
    }
  }

  // ── Undefined variables & unknown functions ──
  // The runtime resolves unknown names to null (→ 0/false) with NO error, so
  // a single typo produces an indicator that "works" but never signals. Flag
  // every identifier that is neither assigned anywhere nor a known builtin.
  {
    const declared = new Set<string>();
    // User-defined functions (f(a, b) => ...): the name is callable and the
    // params are in scope — register both so neither gets flagged.
    for (const line of lines) {
      const fm = /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=>/.exec(stripStringsAndComments(line));
      if (fm) {
        declared.add(fm[1]);
        for (const p of fm[2].split(',')) {
          const pn = p.trim();
          if (/^[A-Za-z_]\w*$/.test(pn)) declared.add(pn);
        }
      }
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i], next = tokens[i + 1];
      if ((t.type === 'IDENTIFIER' || t.type === 'KEYWORD') && next.type === 'OPERATOR'
          && (next.value === '=' || next.value === ':=')) {
        declared.add(t.value);
      }
    }
    const reported = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'IDENTIFIER') continue;
      const prev = tokens[i - 1];
      if (prev && prev.value === '.') continue; // member property (m.macd, ring.push)
      const name = t.value;
      if (declared.has(name) || ALL_KEYWORDS.has(name)
          || KNOWN_EXTRA_IDENTIFIERS.has(name) || BUILTIN_FN_SIGNATURES[name]
          || reported.has(name)) continue;
      const next = tokens[i + 1];
      const nextIsDot = next && next.value === '.';
      if (nextIsDot) continue; // namespace-ish roots are checked by the Pine pass
      reported.add(name);
      if (next && next.value === '(') {
        issues.push({
          line: t.line, col: t.col, severity: 'error', code: 'UNKNOWN_FUNCTION',
          message: `'${name}()' is not an OakScript builtin — the call silently returns 0.`,
          fix: 'Check the function list: sma, ema, wma, hma, rma, vwma, rsi, macd, cci, adx, atr, roc, mom, stoch, mfi, obv, cmf, vwap, stdev, median, linreg, correlation, crossover, crossunder, highest, lowest, pivothigh, pivotlow, barssince, cum, change, trueRange.',
        });
      } else {
        issues.push({
          line: t.line, col: t.col, severity: 'error', code: 'UNDEFINED_VAR',
          message: `Variable '${name}' is never assigned — it silently reads as 0/false, so conditions using it never fire.`,
          fix: 'Assign it before use, or fix the typo (check against your input()/var declarations).',
        });
      }
    }
  }

  // ── Parse level check — catch hard syntax errors ──
  try {
    parse(source);
  } catch (e: any) {
    if (e.message && e.message.includes('Parse error')) {
      issues.push({
        line: e.token?.line || 0,
        col: e.token?.col || 0,
        severity: 'error',
        code: 'PARSE_ERROR',
        message: e.message.replace('Parse error at ', '').replace('Parse error at line ', '').trim(),
        fix: undefined,
      });
    }
  }

  // ── Token-level: check for mismatched parentheses/braces ──
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (const t of tokens) {
    if (t.type === 'PUNCTUATION') {
      if (t.value === '(') parenDepth++;
      if (t.value === ')') parenDepth--;
      if (t.value === '{') braceDepth++;
      if (t.value === '}') braceDepth--;
      if (t.value === '[') bracketDepth++;
      if (t.value === ']') bracketDepth--;
      if (parenDepth < 0) {
        issues.push({
          line: t.line, col: t.col,
          severity: 'error', code: 'UNMATCHED_PAREN',
          message: 'Unmatched closing parenthesis )',
        });
        parenDepth = 0;
      }
      if (braceDepth < 0) {
        issues.push({
          line: t.line, col: t.col,
          severity: 'error', code: 'UNMATCHED_BRACE',
          message: 'Unmatched closing brace }',
        });
        braceDepth = 0;
      }
      if (bracketDepth < 0) {
        issues.push({
          line: t.line, col: t.col,
          severity: 'error', code: 'UNMATCHED_BRACKET',
          message: 'Unmatched closing bracket ]',
        });
        bracketDepth = 0;
      }
    }
  }
  if (parenDepth > 0) {
    issues.push({
      line: tokens[tokens.length - 1]?.line || 1,
      col: 1,
      severity: 'error', code: 'UNCLOSED_PAREN',
      message: `${parenDepth} unclosed parenthesis`,
    });
  }
  if (braceDepth > 0) {
    issues.push({
      line: tokens[tokens.length - 1]?.line || 1,
      col: 1,
      severity: 'error', code: 'UNCLOSED_BRACE',
      message: `${braceDepth} unclosed brace(s)`,
    });
  }
  if (bracketDepth > 0) {
    issues.push({
      line: tokens[tokens.length - 1]?.line || 1,
      col: 1,
      severity: 'error', code: 'UNCLOSED_BRACKET',
      message: `${bracketDepth} unclosed bracket(s)`,
    });
  }

  // ── Function signature check ──
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'IDENTIFIER' || (t.type === 'KEYWORD' && !KNOWN_BLOCK_KEYWORDS.has(t.value))) {
      // A dotted property (array.min, ring.avg, m.macd) is NOT the bare
      // builtin of the same name — checking it against the builtin signature
      // false-errored valid shipped indicators (array.min(x) flagged as
      // "min() expects 2 args") and sent the agent's auto-fix loop chasing
      // phantom issues.
      if (tokens[i - 1]?.value === '.') continue;
      const fnName = t.value;
      const sig = BUILTIN_FN_SIGNATURES[fnName];
      if (!sig) continue;

      // Look for opening paren
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === 'PUNCTUATION' && tokens[j].value !== '(') j++;
      if (j >= tokens.length || tokens[j].value !== '(') continue;

      // Count arguments between ( and the matching )
      let pDepth = 0;
      let argCount = 0;
      let inArg = false;
      j++;
      for (; j < tokens.length; j++) {
        const nt = tokens[j];
        if (nt.value === '(') { pDepth++; continue; }
        if (nt.value === ')') {
          if (pDepth === 0) break;
          pDepth--;
          continue;
        }
        if (nt.value === ',' && pDepth === 0) {
          argCount++;
          inArg = false;
          continue;
        }
        if (!inArg && nt.type !== 'PUNCTUATION') {
          inArg = true;
        }
      }
      if (inArg) argCount++; // count the last arg

      if (argCount < sig.minArgs) {
        issues.push({
          line: t.line, col: t.col,
          severity: 'error', code: 'FN_TOO_FEW_ARGS',
          message: `${fnName}() expects at least ${sig.minArgs} argument(s) but got ${argCount}`,
          fix: `${fnName}(${sig.argDescriptions.join(', ')})`,
        });
      } else if (argCount > sig.maxArgs) {
        issues.push({
          line: t.line, col: t.col,
          severity: 'warning', code: 'FN_TOO_MANY_ARGS',
          message: `${fnName}() expects at most ${sig.maxArgs} argument(s) but got ${argCount}`,
          fix: `${fnName}(${sig.argDescriptions.join(', ')})`,
        });
      }

      // Check plotshape style argument
      if (fnName === 'plotshape') {
        // Find the 4th argument (index 3, since we 0-index) — it's a string literal
        let aIdx = 0;
        let styleStr = '';
        for (let k = i + 1; k < tokens.length; k++) {
          const nt = tokens[k];
          if (nt.value === '(') continue;
          if (nt.value === ')' || nt.value === ',') {
            if (nt.value === ')') break;
            aIdx++;
            continue;
          }
          if (aIdx === 3 && nt.type === 'STRING') {
            styleStr = nt.value;
            break;
          }
          if (nt.type !== 'PUNCTUATION') {
            if (aIdx === 3 && nt.type === 'IDENTIFIER') {
              styleStr = nt.value;
              break;
            }
            // skip the arg value
            let parenInner = 0;
            k++;
            while (k < tokens.length && !(tokens[k].value === ',' && parenInner === 0) && !(tokens[k].value === ')' && parenInner === 0)) {
              if (tokens[k].value === '(') parenInner++;
              if (tokens[k].value === ')') parenInner--;
              k++;
            }
            aIdx++;
            if (k < tokens.length && tokens[k].value === ')') break;
          }
        }
        if (styleStr && !PLOTSHAPE_STYLES.has(styleStr)) {
          issues.push({
            line: t.line, col: t.col,
            severity: 'warning', code: 'UNKNOWN_SHAPE_STYLE',
            message: `plotshape style "${styleStr}" may not be valid. Valid: ${[...PLOTSHAPE_STYLES].join(', ')}`,
          });
        }
      }

      // Check plot3d style argument
      if (fnName === 'plot3d') {
        let aIdx = 0;
        let styleStr = '';
        for (let k = i + 1; k < tokens.length; k++) {
          const nt = tokens[k];
          if (nt.value === '(') continue;
          if (nt.value === ')' || nt.value === ',') {
            if (nt.value === ')') break;
            aIdx++;
            continue;
          }
          if (aIdx === 2 && nt.type === 'STRING') {
            styleStr = nt.value;
            break;
          }
          if (aIdx === 2 && nt.type === 'IDENTIFIER') {
            styleStr = nt.value;
            break;
          }
          if (nt.type !== 'PUNCTUATION') {
            let parenInner = 0;
            k++;
            while (k < tokens.length && !(tokens[k].value === ',' && parenInner === 0) && !(tokens[k].value === ')' && parenInner === 0)) {
              if (tokens[k].value === '(') parenInner++;
              if (tokens[k].value === ')') parenInner--;
              k++;
            }
            aIdx++;
            if (k < tokens.length && tokens[k].value === ')') break;
          }
        }
        if (styleStr && !PLOT3D_STYLES.has(styleStr)) {
          issues.push({
            line: t.line, col: t.col,
            severity: 'warning', code: 'UNKNOWN_3D_STYLE',
            message: `plot3d style "${styleStr}" not recognized. Valid: ${[...PLOT3D_STYLES].join(', ')}`,
          });
        }
      }
    }
  }

  // ── Check for `=` vs `:=` in reassignment context ──
  // `x = x + 1` is fine (parser handles both) but warn if inside a var
  for (let li = 0; li < lines.length; li++) {
    const trimmed = lines[li].trim();
    // Nothing else critical at line level that we haven't caught yet
  }

  return {
    valid: issues.filter(i => i.severity === 'error').length === 0,
    issues,
  };
}

/**
 * Format validation issues as a human-readable list for the agent.
 */
export function formatValidationIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return 'No issues found.';
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  let out = '';
  if (errors.length > 0) {
    out += `${errors.length} error(s):\n`;
    out += errors.map(i => `  L${i.line} [${i.code}] ${i.message}`).join('\n');
  }
  if (warnings.length > 0) {
    if (out) out += '\n';
    out += `${warnings.length} warning(s):\n`;
    out += warnings.map(i => `  L${i.line} [${i.code}] ${i.message} — ${i.fix || ''}`).join('\n');
  }
  return out;
}
