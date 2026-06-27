export type TokenType =
  | 'NUMBER' | 'STRING' | 'IDENTIFIER' | 'KEYWORD'
  | 'OPERATOR' | 'PUNCTUATION' | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  'indicator', 'strategy', 'plot', 'plotshape', 'plotarrow', 'plotchar', 'plot3d',
  'input', 'label', 'table', 'hline', 'fill', 'bgcolor',
  'var', 'varip', 'if', 'else', 'for', 'while', 'in',
  'break', 'continue', 'return', 'true', 'false', 'nil',
  'and', 'or', 'not', 'to', 'by',
  'crossover', 'crossunder', 'barssince',
  'sma', 'ema', 'rsi', 'macd', 'highest', 'lowest',
  'cum', 'change', 'roc', 'stdev', 'variance', 'correlation',
  'close', 'open', 'high', 'low', 'volume', 'time', 'bar_index',
  'barstate', 'str',
  'alert', 'alertcondition',
  'line', 'box', 'polygon', 'circle',
]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1, col = 1;

  while (i < source.length) {
    const ch = source[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '\n') { i++; line++; col = 1; continue; }

    // Single-line comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // Multi-line comments
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { line++; col = 1; }
        i++; col++;
      }
      i += 2; col += 2;
      continue;
    }

    // Strings (single or double)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      const startCol = col;
      i++; col++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { i++; col++; value += source[i]; }
        else value += source[i];
        i++; col++;
      }
      if (i < source.length) { i++; col++; }
      tokens.push({ type: 'STRING', value, line, col: startCol });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      let value = '';
      const startCol = col;
      while (i < source.length && /[0-9.]/.test(source[i])) {
        value += source[i]; i++; col++;
      }
      tokens.push({ type: 'NUMBER', value, line, col: startCol });
      continue;
    }

    // Identifiers / Keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let value = '';
      const startCol = col;
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i])) {
        value += source[i]; i++; col++;
      }
      const type = KEYWORDS.has(value) ? 'KEYWORD' : 'IDENTIFIER';
      tokens.push({ type, value, line, col: startCol });
      continue;
    }

    // Operators and punctuation
    const twoChar = source.substr(i, 2);
    const ops2 = new Set(['==', '!=', '<=', '>=', '=>', '->', ':=', '+=', '-=']);
    if (ops2.has(twoChar)) {
      tokens.push({ type: 'OPERATOR', value: twoChar, line, col });
      i += 2; col += 2;
      continue;
    }

    const oneChar = ch;
    if ('+-*/%=<>&|!^?:'.includes(oneChar)) {
      tokens.push({ type: 'OPERATOR', value: oneChar, line, col });
      i++; col++;
      continue;
    }

    if ('()[]{}.,;:#@'.includes(oneChar)) {
      tokens.push({ type: 'PUNCTUATION', value: oneChar, line, col });
      i++; col++;
      continue;
    }

    // Skip unknown
    i++; col++;
  }

  tokens.push({ type: 'EOF', value: '', line, col });
  return tokens;
}
