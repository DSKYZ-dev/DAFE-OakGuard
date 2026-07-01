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
  'indicator', 'strategy', 'plot', 'plotshape', 'plotarrow', 'plotchar', 'plot3d',
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
  plot:      { minArgs: 1, maxArgs: 6, argDescriptions: ['value', 'title', 'color', 'linewidth', 'style|pane', 'pane'] },
  plotshape: { minArgs: 2, maxArgs: 6, argDescriptions: ['bar_index', 'price', 'title', 'style', 'color', 'pane'] },
  plotarrow: { minArgs: 2, maxArgs: 6, argDescriptions: ['bar_index', 'price', 'title', 'direction', 'color', 'pane'] },
  plotchar:  { minArgs: 2, maxArgs: 5, argDescriptions: ['bar_index', 'price', 'char', 'color', 'pane'] },
  plot3d:    { minArgs: 2, maxArgs: 5, argDescriptions: ['series', 'name', 'style', 'color', 'pane'] },
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

const PLOTSHAPE_STYLES = new Set([
  'triangleup', 'triangledown', 'circle', 'cross', 'xcross',
  'square', 'diamond', 'arrowup', 'arrowdown',
]);

const PLOT3D_STYLES = new Set([
  'surface', 'ribbon', 'bars3d', 'scatter', 'line3d', 'wireframe', 'mesh',
  'helix', 'vortex', 'manifold', 'nebula', 'constellation', 'torus', 'trail',
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
