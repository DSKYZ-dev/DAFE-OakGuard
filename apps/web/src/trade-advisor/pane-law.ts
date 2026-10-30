/**
 * Pane law, judged per series. A plot3d() layer on pane "3d" renders in the
 * price scene, so its series has to be price-denominated. These helpers read
 * the series expression and the variables it uses to decide that. The coverage
 * gate and the mechanical repair both use them, so they always agree.
 */

export type SeriesClass = 'price' | 'oscillator' | 'unknown';

const OSCILLATOR_CALL = /\b(?:rsi|cci|macd|stoch|mfi|adx|mom|roc|cmf|obv|stdev|atr)\s*\(/;
const PRICE_FIELD_TERM = /^(?:close|open|high|low|hl2|hlc3|ohlc4)\b/;
const PRICE_LEVEL_CALL = /^(?:highest|lowest|sma|ema|wma|hma|vwma|vwap|pivothigh|pivotlow|linreg|median)\s*\(/;

/** Right-hand sides of every assignment, by variable name. */
export function seriesDefs(code: string): Map<string, string[]> {
  const defs = new Map<string, string[]>();
  for (const m of code.replace(/\r/g, '').matchAll(/^\s*([A-Za-z_]\w*)\s*:?=\s*([^\n]+)$/gm)) {
    defs.set(m[1], [...(defs.get(m[1]) ?? []), m[2].split('//')[0]]);
  }
  return defs;
}

/** Each plot3d() call: its series expression, its pane, and where the pane literal sits (-1 if not a literal). */
export function plot3dLayers(code: string): { series: string; pane: string; paneAt: number }[] {
  const layers: { series: string; pane: string; paneAt: number }[] = [];
  for (const m of code.matchAll(/(?<![\w.])plot3d\s*\(/g)) {
    const args: string[] = [];
    const starts: number[] = [];
    let argStart = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let inStr = false;
    let cur = '';
    for (let i = argStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"') inStr = !inStr;
      if (!inStr) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') {
          depth--;
          if (depth === 0) break;
        } else if (ch === ',' && depth === 1) {
          args.push(cur.trim());
          starts.push(argStart);
          cur = '';
          argStart = i + 1;
          continue;
        }
      }
      cur += ch;
    }
    args.push(cur.trim());
    starts.push(argStart);
    const pane = args[4] ?? '';
    layers.push({
      series: args[0] ?? '',
      pane: pane.replace(/^"|"$/g, ''),
      paneAt: pane.startsWith('"') ? code.indexOf('"', starts[4]) : -1,
    });
  }
  return layers;
}

/** Top-level + and - terms; parentheses, brackets and strings are not split. */
function additiveTerms(expr: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const ch of expr) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if ((ch === '+' || ch === '-') && depth === 0) {
        if (cur.trim()) terms.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) terms.push(cur.trim());
  return terms;
}

/**
 * A top-level price term (close, low, highest(...)) makes the series a price
 * level, even with a volatility offset (low - 2 * atr(...)). Otherwise an
 * oscillator or volatility builtin, read directly or through a variable that
 * holds one, makes it an oscillator. Anything else is unknown.
 */
export function classifySeries(expr: string, defs: Map<string, string[]>, visiting = new Set<string>()): SeriesClass {
  let oscillator = false;
  let priceRef = false;
  for (const term of additiveTerms(expr)) {
    if (PRICE_FIELD_TERM.test(term) || PRICE_LEVEL_CALL.test(term)) return 'price';
    if (OSCILLATOR_CALL.test(term)) oscillator = true;
    for (const id of term.replace(/"[^"]*"/g, '').match(/[A-Za-z_]\w*/g) ?? []) {
      const rhsList = defs.get(id);
      if (!rhsList || visiting.has(id)) continue;
      visiting.add(id);
      const kinds = rhsList.map(rhs => classifySeries(rhs, defs, visiting));
      visiting.delete(id);
      if (kinds.includes('oscillator')) oscillator = true;
      else if (kinds.includes('price')) priceRef = true;
    }
  }
  if (oscillator) return 'oscillator';
  return priceRef ? 'price' : 'unknown';
}

/** Every call to `name(...)`: its top-level arguments as written, and where the call starts. */
export function callArgs(code: string, name: string): { args: string[]; at: number }[] {
  const calls: { args: string[]; at: number }[] = [];
  for (const m of code.matchAll(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'))) {
    const args: string[] = [];
    let depth = 1;
    let inStr = false;
    let cur = '';
    for (let i = (m.index ?? 0) + m[0].length; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"') inStr = !inStr;
      if (!inStr) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') {
          depth--;
          if (depth === 0) break;
        } else if (ch === ',' && depth === 1) {
          args.push(cur.trim());
          cur = '';
          continue;
        }
      }
      cur += ch;
    }
    args.push(cur.trim());
    calls.push({ args, at: m.index ?? 0 });
  }
  return calls;
}
