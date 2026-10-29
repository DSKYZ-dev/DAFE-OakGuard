/**
 * Request Coverage — the semantic gate the syntax validator cannot be.
 *
 * The validator proves a script is legal OakScript. It cannot prove the
 * script is the indicator the user ASKED for. Observed failure mode: a
 * user asks for session highs/lows with divergence signals; the model
 * drafts an EMA crossover (its strongest prior), auto-fix "passes
 * validation", and the user gets a syntactically perfect wrong indicator
 * with signals painted everywhere.
 *
 * This checker is deterministic (no LLM): it compares concept families
 * in the request against concept families in the code, enforces explicit
 * negations ("not EMA"), checks requested concepts are present, enforces
 * the Prefer-3D dimension, and flags tautological signal conditions
 * (e.g. crossunder(low, close), which fires constantly by construction).
 */

export interface CoverageOptions {
  prefer3D?: boolean;
  /** Source being edited (edit path): families already present may stay unless the request removes them. */
  previousSource?: string;
}

interface Family {
  id: string;
  label: string;
  requestRe: RegExp;
  codeRe: RegExp;
}

const FAMILIES: Family[] = [
  { id: 'ema', label: 'EMA', requestRe: /\bema\b|exponential moving/i, codeRe: /\bema\s*\(/ },
  { id: 'sma', label: 'SMA / moving average', requestRe: /\bsma\b|moving average|\bma cross/i, codeRe: /\b(sma|wma|hma|rma|vwma)\s*\(/ },
  { id: 'macd', label: 'MACD', requestRe: /\bmacd\b/i, codeRe: /\bmacd\s*\(/ },
  { id: 'rsi', label: 'RSI', requestRe: /\brsi\b|relative strength/i, codeRe: /\brsi\s*\(/ },
  { id: 'atr', label: 'ATR', requestRe: /\batr\b|average true range/i, codeRe: /\batr\s*\(/ },
  { id: 'stoch', label: 'Stochastic', requestRe: /stochastic|\bstoch\b/i, codeRe: /\bstoch\s*\(/ },
  { id: 'vwap', label: 'VWAP', requestRe: /\bvwap\b/i, codeRe: /\bvwap\s*\(/ },
  { id: 'bollinger', label: 'Bollinger Bands', requestRe: /bollinger/i, codeRe: /bollinger|stdev\s*\([^)]*\)\s*[*+-]/i },
];

function stripComments(code: string): string {
  return code.split('\n').map(l => {
    const i = l.indexOf('//');
    return i >= 0 ? l.slice(0, i) : l;
  }).join('\n');
}

export function checkRequestCoverage(request: string, code: string, opts: CoverageOptions = {}): string[] {
  const problems: string[] = [];
  const req = request || '';
  const src = stripComments(code || '');
  const prev = opts.previousSource ? stripComments(opts.previousSource) : '';

  // 1. Unrequested / explicitly-rejected concept families.
  for (const fam of FAMILIES) {
    if (!fam.codeRe.test(src)) continue;
    const requested = fam.requestRe.test(req);
    const negated = new RegExp(`\\b(not|no|never|without|don'?t|remove|drop)\\b[^.\\n]{0,40}${fam.requestRe.source}`, 'i').test(req)
      || new RegExp(`${fam.requestRe.source}[^\\w]{0,12}\\b(not|no|never)\\b`, 'i').test(req);
    const preExisting = prev ? fam.codeRe.test(prev) : false;
    if (negated) {
      problems.push(`COVERAGE: the user explicitly rejected ${fam.label} ("${req.slice(0, 90)}") but the script uses it. Remove every ${fam.label} calculation and plot.`);
    } else if (!requested && !preExisting) {
      problems.push(`COVERAGE: the script introduces ${fam.label}, which the user never asked for. Remove it and rebuild the logic from what WAS requested: "${req.slice(0, 110)}". Do not substitute a moving-average/oscillator template for the requested concept.`);
    }
  }

  // 2. Requested concepts that must be present.
  if (/\bsession\b[^.\n]{0,40}\b(high|low)|highs?\s*(and|&|\/)\s*lows?\b/i.test(req)) {
    if (!/\b(highest|lowest)\s*\(|\bhigh\b[^.\n]{0,30}:?=|\bsession/i.test(src)) {
      problems.push('COVERAGE: the user asked for session highs/lows but the script never computes session/range extremes (expected highest(high, N) / lowest(low, N) or equivalent session tracking).');
    }
  }
  if (/\bhighs?\b/i.test(req) && !/\bhigh\b/.test(src)) problems.push('COVERAGE: request references highs but the script never uses the high series.');
  if (/\blows?\b/i.test(req) && !/\blow\b/.test(src)) problems.push('COVERAGE: request references lows but the script never uses the low series.');
  if (/\bdivergen/i.test(req) && !/diverg|rsi|stdev|deviation|momentum/i.test(src)) {
    problems.push('COVERAGE: the user asked for divergence but the script has no divergence logic (price extreme vs a counter-moving measure such as RSI/deviation). A plain crossover is not divergence.');
  }

  // 3. Tautological / near-tautological signal conditions paint signals everywhere.
  const alias = new Map<string, string>();
  for (const m of src.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(high|low|close|open)\s*$/gm)) alias.set(m[1], m[2]);
  const resolve = (s: string) => alias.get(s.trim()) || s.trim();
  for (const m of src.matchAll(/\bcross(?:over|under)\s*\(\s*([A-Za-z_]\w*)(?:\[\d+\])?\s*,\s*([A-Za-z_]\w*)(?:\[\d+\])?\s*\)/g)) {
    const a = resolve(m[1]), b = resolve(m[2]);
    const priceFields = new Set(['high', 'low', 'close', 'open']);
    if (priceFields.has(a) && priceFields.has(b)) {
      problems.push(`COVERAGE: signal condition cross between raw price fields (${m[1]} vs ${m[2]}) is near-tautological — e.g. low is below close on most bars, so markers paint everywhere. Derive signals from the requested structure (session extremes, divergence, deviation) instead.`);
    }
  }

  // 4. Dimension enforcement: Prefer-3D must actually render in 3D.
  const wants2DOnly = /\b(main chart only|2d only|no 3d|without 3d|remove( the)? 3d|flat chart)\b/i.test(req);
  if (opts.prefer3D && !wants2DOnly) {
    const has3dScene = /plot3d\s*\([^)]*"3d"/.test(src);
    const has3dShapes = /plotshape_3d\s*\([^)]*"3d"/.test(src);
    const has2dShapes = /(?<![\w.])plotshape\s*\(/.test(src);
    if (!has3dScene) {
      problems.push('COVERAGE: Prefer 3D is on but the script has no plot3d(..., "3d") — it will render as a flat 2D indicator. Add a plot3d series with pane "3d" that carries the requested logic.');
    }
    if (has2dShapes && !has3dShapes && has3dScene) {
      problems.push('COVERAGE: the script uses 2D plotshape() for signals in a pane="3d" indicator — 2D shapes do not render in the 3D scene. Pair every signal with plotshape_3d(..., "3d") at the same bar/price.');
    }
  }
  if (wants2DOnly && /plot3d\s*\(|plotshape_3d\s*\(/.test(src)) {
    problems.push('COVERAGE: the user asked for a 2D / main-chart-only indicator but the script contains 3D calls. Remove all plot3d/plotshape_3d calls.');
  }

  return problems;
}
