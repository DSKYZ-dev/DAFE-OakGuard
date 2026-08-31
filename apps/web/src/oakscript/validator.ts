/**
 * OakScript Validator — Pre-flight checks that catch common mistakes
 * BEFORE code hits the interpreter. Returns human-readable warnings
 * and errors the agent can use to self-correct.
 */
import { tokenize, type Token } from './lexer';
import { parse } from './parser';
import { BUILTIN_REGISTRY, buildSignatureMap, type BuiltinStyleCheck } from './builtins';

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

// Derived from the central builtin registry (builtins.ts) instead of being
// hand-written here — one source of truth for arg-count metadata, shared
// with the style-enum checks below.
const BUILTIN_FN_SIGNATURES: Record<string, { minArgs: number; maxArgs: number; argDescriptions: string[] }> = buildSignatureMap();

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

// PLOTSHAPE_STYLES/PLOT3D_STYLES now live in builtins.ts (imported above),
// attached to the 'plotshape'/'plot3d' BuiltinDef.styleChecks so the same
// STYLE_CHECKS machinery below drives both the pre-existing checks and the
// new drawing-object ones.

/**
 * Resolved style-enum checks, one per (builtin, argIndex) pair, flattened
 * from every BuiltinDef.styleChecks entry in the registry. Replaces the two
 * hand-copied plotshape/plot3d blocks that used to live inline in the
 * function-signature-check loop below.
 */
interface ResolvedStyleCheck extends BuiltinStyleCheck { fnName: string }
const STYLE_CHECKS: ResolvedStyleCheck[] = BUILTIN_REGISTRY.flatMap((def) =>
  (def.styleChecks || []).map((sc) => ({ fnName: def.name, ...sc }))
);

/**
 * Walks tokens starting at `startIdx` (expected to be the '(' opening a
 * call, or the token right after the function-name token) and returns the
 * literal STRING/IDENTIFIER value of the Nth (0-indexed) positional
 * argument, or '' if that argument isn't a simple literal/identifier (e.g.
 * it's an expression) or doesn't exist. Same token-walking logic the
 * plotshape/plot3d style checks already used, generalized to any argIndex.
 */
function findPositionalArgToken(tokens: Token[], startIdx: number, targetIdx: number): string {
  let aIdx = 0;
  let val = '';
  for (let k = startIdx; k < tokens.length; k++) {
    const nt = tokens[k];
    if (nt.value === '(') continue;
    if (nt.value === ')' || nt.value === ',') {
      if (nt.value === ')') break;
      aIdx++;
      continue;
    }
    if (aIdx === targetIdx && (nt.type === 'STRING' || nt.type === 'IDENTIFIER')) {
      val = nt.value;
      break;
    }
    if (nt.type !== 'PUNCTUATION') {
      // Skip past this arg's full token span (handles nested calls/arrays).
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
  return val;
}

/**
 * Like findPositionalArgToken, but returns the literal value ONLY if that
 * argument is specifically a plain STRING token (not an identifier or a
 * multi-token expression) — used where treating an identifier/expression as
 * a suspicious literal would false-positive (a color computed into a
 * variable, e.g. `col = up ? "#22cc88" : "#ff4477"` then `hline(x, col)`, is
 * not a mistake to flag; a bare string literal in that slot is checkable).
 */
function findPositionalStringLiteral(tokens: Token[], startIdx: number, targetIdx: number): string | null {
  let aIdx = 0;
  let depth = 0;
  let k = startIdx;
  // startIdx points at the call's own opening '(' — skip it WITHOUT counting
  // toward depth (only parens/brackets NESTED inside argument expressions
  // should count), matching findPositionalArgToken's convention.
  if (tokens[k]?.value === '(') k++;
  for (; k < tokens.length; k++) {
    const nt = tokens[k];
    if (nt.value === '(' || nt.value === '[') { depth++; continue; }
    if (nt.value === ')' || nt.value === ']') {
      if (depth === 0) break; // the call's own closing paren
      depth--;
      continue;
    }
    if (nt.value === ',' && depth === 0) { aIdx++; continue; }
    if (aIdx === targetIdx && depth === 0) {
      return nt.type === 'STRING' ? nt.value : null;
    }
  }
  return null;
}

// ── Object-creation id-guard helpers (OBJECT_NO_ID_UNCONDITIONAL /
// OBJECT_STATIC_ID_IN_CONDITIONAL below) ──────────────────────────────────
// The 7 drawing-object primitives that take an optional trailing `id` and
// route through the interpreter's upsertObject/autoId idiom (see
// interpreter.ts). fibretracement.new/gannfan.new also take a trailing id
// but are sugar that fans out into N sub-ids of their own and are
// intentionally NOT part of this specific guard family.
const OBJECT_CREATION_RE = /(?<![\w.])(line|box|polyline|circle|arrow|table|image)\.new\s*\(/;

/**
 * Given a line already run through stripStringsAndComments (so string
 * contents are blanked but quote characters survive), a regex match for an
 * object-creation call, and the match's start index, returns the raw
 * substring between that call's outer '(' and its matching ')' — or null if
 * the call isn't closed on this line (the existing idiom checks in this
 * file are line-based and don't handle calls split across lines either).
 */
function extractCallArgSpan(s: string, matchIndex: number, matchLen: number): string | null {
  const start = matchIndex + matchLen; // just past the opening '('
  let depth = 1;
  let i = start;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  return s.slice(start, i);
}

/** Splits a call's argument span on top-level commas (ignoring commas nested inside (), []). */
function splitTopLevelArgs(argsStr: string): string[] {
  const trimmed = argsStr.trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { parts.push(argsStr.slice(start, i)); start = i + 1; }
  }
  parts.push(argsStr.slice(start));
  return parts;
}

/**
 * True if a (stripStringsAndComments'd) argument span is EXACTLY a quoted
 * string literal — i.e. `"<blanked content>"` with nothing else around it
 * (string contents were already replaced with spaces by
 * stripStringsAndComments, so this is a cheap way to tell "plain string
 * literal" apart from an expression like `"zone:" + tostring(bar_index)`
 * without needing the original unstripped text).
 */
function isPlainStringLiteralArg(strippedArg: string): boolean {
  const t = strippedArg.trim();
  return /^"[ ]*"$/.test(t) || /^'[ ]*'$/.test(t);
}

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
    if (/^strategy\s*\(/.test(trimmed) || /(?<![\w.])strategy\.(?!entry\b|exit\b)[A-Za-z_]/.test(s)) {
      issues.push({
        line: lineNum, col: 1, severity: 'error', code: 'PINE_STRATEGY',
        message: 'strategy()/strategy.* (other than entry/exit) is PineScript — OakScript has no bracket-order strategy engine.',
        fix: 'For live/backtest signals use strategy.entry("long"|"short", id?, qty?) / strategy.exit(id?), or express as markers: if buySig { plotshape(bar_index, low, "Buy", "triangleup", "#22cc88") }',
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

      // strategy.entry/exit are order EVENTS (backtest engine), same
      // unconditional-footgun shape as plotshape's marker-per-bar above.
      if (!inBlock) {
        const stratMatch = /^strategy\.(entry|exit)\s*\(/.exec(s.trim());
        if (stratMatch) {
          const stratFn = stratMatch[1];
          const example = stratFn === 'entry' ? 'strategy.entry("long")' : 'strategy.exit()';
          issues.push({
            line: lineNum, col: 1, severity: 'warning', code: 'STRATEGY_CALL_UNCONDITIONAL',
            message: `Unconditional strategy.${stratFn}(...) fires on EVERY bar.`,
            fix: `Wrap it in a signal condition: if buySig { ${example} }`,
          });
        }
      }

      // Drawing-object id guards: line.new/box.new/polyline.new/circle.new/
      // arrow.new/table.new/image.new all take an optional trailing `id`
      // that decides whether a repeat call MUTATES the same object
      // (upsertObject) or creates a fresh one (autoId). Two opposite
      // footguns share this call family, mirroring PLOT_IN_CONDITIONAL/
      // PLOTSHAPE_UNCONDITIONAL's placement-aware pattern above.
      {
        const objMatch = OBJECT_CREATION_RE.exec(s);
        if (objMatch) {
          const objFnName = `${objMatch[1]}.new`;
          const sig = BUILTIN_FN_SIGNATURES[objFnName];
          const argsSpan = extractCallArgSpan(s, objMatch.index, objMatch[0].length);
          if (sig && argsSpan !== null) {
            const argList = splitTopLevelArgs(argsSpan);
            const argCount = argList.length;
            if (!inBlock && argCount === sig.minArgs) {
              // The trailing optional id was omitted entirely.
              issues.push({
                line: lineNum, col: 1, severity: 'warning', code: 'OBJECT_NO_ID_UNCONDITIONAL',
                message: `Unconditional ${objFnName}(...) with no id argument creates a NEW object every bar — once the rolling cap for this object type is exceeded, the oldest one is silently evicted.`,
                fix: `Pass a stable literal id as the last argument, e.g. ${objFnName}(..., "myId"), so repeated calls update the SAME object instead of stacking new ones.`,
              });
            } else if (inBlock && argCount === sig.maxArgs && isPlainStringLiteralArg(argList[argList.length - 1])) {
              // The trailing id IS present and is a fixed string literal, inside a conditional.
              issues.push({
                line: lineNum, col: 1, severity: 'warning', code: 'OBJECT_STATIC_ID_IN_CONDITIONAL',
                message: `${objFnName}(...) inside a conditional block with a fixed string id — every firing collapses onto the SAME object instead of creating one per signal.`,
                fix: `Either omit the id (one object per signal, auto-capped) or derive it from bar_index for a one-per-signal id, e.g. ${objFnName}(..., "id:" + tostring(bar_index)).`,
              });
            }
          }
        }
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
      // builtin of the same name — checking a SUFFIX token (the "min" in
      // "array.min") against the bare builtin signature false-errored valid
      // shipped indicators (array.min(x) flagged as "min() expects 2 args")
      // and sent the agent's auto-fix loop chasing phantom issues. Still
      // skip suffix tokens for that reason.
      if (tokens[i - 1]?.value === '.') continue;
      // But namespaced builtins (table.new, line.new, array.push, ...) ARE
      // real registry-keyed dotted names — the lexer tokenizes `table`,
      // `.`, `new` as three separate tokens, so a bare `t.value` lookup can
      // only ever match UNnamespaced builtins (sma, plotshape, ...). Fold
      // `root` + '.' + `suffix` into one dotted name and prefer it — but
      // ONLY when that combined name is actually in the registry, so every
      // non-namespaced/unrecognized case falls through to the exact
      // original bare-name behavior unchanged.
      let fnName = t.value;
      let nameEndIdx = i;
      if (tokens[i + 1]?.value === '.' && (tokens[i + 2]?.type === 'IDENTIFIER' || tokens[i + 2]?.type === 'KEYWORD')) {
        const dotted = `${t.value}.${tokens[i + 2].value}`;
        if (BUILTIN_FN_SIGNATURES[dotted]) { fnName = dotted; nameEndIdx = i + 2; }
      }
      const sig = BUILTIN_FN_SIGNATURES[fnName];
      if (!sig) continue;

      // Look for opening paren
      let j = nameEndIdx + 1;
      while (j < tokens.length && tokens[j].type === 'PUNCTUATION' && tokens[j].value !== '(') j++;
      if (j >= tokens.length || tokens[j].value !== '(') continue;

      // Count arguments between ( and the matching ). Must track [ ] depth
      // too, not just ( ) — an array-literal argument (e.g. fibretracement.new's
      // levels?: [0, 0.236, 0.5, ...]) contains its own top-level commas that
      // are NOT argument separators; without bracketDepth every comma inside
      // the literal inflated the count (a 7-element array turned a real
      // 8-arg call into an apparent 14-arg one — a false FN_TOO_MANY_ARGS on
      // entirely valid code).
      let pDepth = 0;
      let bracketDepth = 0;
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
        if (nt.value === '[') { bracketDepth++; continue; }
        if (nt.value === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
        if (nt.value === ',' && pDepth === 0 && bracketDepth === 0) {
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

      // Style-enum checks: driven by builtins.ts's BuiltinDef.styleChecks —
      // one shared token-walk (findPositionalArgToken) instead of the
      // hand-copied per-builtin blocks this used to be. Behavior for the
      // pre-existing plotshape/plot3d checks is unchanged (same trigger
      // condition, same codes, same valid-value lists — just sourced from
      // the registry now); the four new checks (line.new style/extend,
      // table.new position, image.new anchor) share the exact same helper.
      for (const check of STYLE_CHECKS) {
        if (check.fnName !== fnName) continue;
        const val = findPositionalArgToken(tokens, nameEndIdx + 1, check.argIndex);
        if (!val || check.values.has(val)) continue;
        // The two pre-existing checks keep their original exact wording;
        // every new check uses a generic template built from its `label`.
        const message = check.code === 'UNKNOWN_SHAPE_STYLE'
          ? `plotshape style "${val}" may not be valid. Valid: ${[...check.values].join(', ')}`
          : check.code === 'UNKNOWN_3D_STYLE'
            ? `plot3d style "${val}" not recognized. Valid: ${[...check.values].join(', ')}`
            : `${check.label} "${val}" not recognized. Valid: ${[...check.values].join(', ')}`;
        issues.push({
          line: t.line, col: t.col,
          severity: 'warning', code: check.code,
          message,
        });
      }

      // hline()'s color argument is index 1. A residual Pine-idiom mistake
      // (Pine's hline(price, title, color, linestyle, linewidth) has a title
      // in that slot) has models pass a human-readable string here instead
      // of the actual color, e.g. hline(70, "Overbought", "#ff4477") — 3
      // args stays under maxArgs so FN_TOO_MANY_ARGS never fires, and the
      // bogus color string just silently fails as a canvas color with no
      // runtime error, so nothing else in this file catches it. Confirmed
      // empirically against a real model that prompt wording alone doesn't
      // reliably suppress this, so it's caught deterministically here
      // instead — only for a plain string literal, never an identifier
      // (a color computed into a variable is legitimate, see
      // findPositionalStringLiteral's doc comment).
      if (fnName === 'hline') {
        const colorTok = findPositionalStringLiteral(tokens, nameEndIdx + 1, 1);
        if (colorTok !== null && !/^#[0-9a-fA-F]{3,8}$/.test(colorTok) && !/^rgba?\(/i.test(colorTok)) {
          issues.push({
            line: t.line, col: t.col,
            severity: 'warning', code: 'HLINE_INVALID_COLOR',
            message: `hline()'s 2nd argument "${colorTok}" doesn't look like a color — OakScript's hline(price, color?, pane?) has NO title slot (that's Pine's hline(price, title, color, linestyle, linewidth)).`,
            fix: `Drop the title — hline(price, "#22cc88", pane?). For a label, use label.new()/text.new() near the line instead.`,
          });
        }
      }

      // PLOTSHAPE CONDITION-FIRST (Pine signature) — the invisible-signal
      // trap. Pine's plotshape(condition, ...) puts a boolean first; Oak's
      // is plotshape(bar_index, price, "label", "style", color). A boolean
      // arg0 falls back to ctx.barIndex (fine) but the agent's intended
      // PRICE lands in the title slot and price becomes 0 — every marker
      // renders at price 0, invisible at the chart's floor. Empirically
      // prompt wording alone doesn't stop this, so it's caught here.
      if (fnName === 'plotshape' || fnName === 'plotshape_3d') {
        const firstArgEnd = nameEndIdx + 1;
        const firstTok = tokens[firstArgEnd];
        // Boolean literal first arg is always Pine-signature.
        if (firstTok && firstTok.value === '(') {
          const inner = tokens[firstArgEnd + 1];
          if (inner && /^(true|false)$/i.test(inner.value)) {
            issues.push({
              line: t.line, col: t.col,
              severity: 'error', code: 'PLOTSHAPE_PINE_SIGNATURE',
              message: `${fnName}(true/false, ...) is the Pine signature — markers get price 0 and render invisible.`,
              fix: `OakScript: ${fnName}(bar_index, low, "Buy", "triangleup", "#22cc88") — inside an if-block for the condition.`,
            });
          }
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
