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
  // Moving-average families only count when applied to PRICE (close).
  // sma()/ema() used to smooth a requested oscillator (sma(k,3) on %K,
  // ema(obv,21)) is a utility, not an MA-template substitution.
  { id: 'ema', label: 'EMA', requestRe: /\bema\b|exponential moving/i, codeRe: /\bema\s*\(\s*close\b/ },
  { id: 'sma', label: 'SMA / moving average', requestRe: /\bsma\b|moving average|\bma cross/i, codeRe: /\b(?:sma|wma|hma|rma|vwma)\s*\(\s*close\b/ },
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
    // "Band" requests (Bollinger-style) intrinsically need an SMA basis.
    const requested = fam.requestRe.test(req)
      || ((fam.id === 'sma' || fam.id === 'ema') && /\bbollinger|\bbands?\b/i.test(req));
    // Negation must be syntactically tied to the family ("do not use EMA",
    // "no EMAs", "without moving averages") — a stray "no" elsewhere in
    // the sentence ("No trading signals", "RSI Length") is not a rejection.
    const negated = new RegExp(`\\b(?:do not|don't|dont|never|without|no)\\s+(?:use\\s+|using\\s+)?(?:any\\s+)?(?:${fam.requestRe.source})`, 'i').test(req)
      || new RegExp(`\\bremove\\s+(?:the\\s+|all\\s+)?(?:${fam.requestRe.source})`, 'i').test(req);
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

  // 3b. Input bounds that lock the slider one way (observed live: a
  // length input whose min == default can't go lower, max == default
  // can't go higher — the Model Inputs panel faithfully reflects the
  // script, so the script's bounds are the bug).
  for (const m of src.matchAll(/\binput\(\s*(-?\d+(?:\.\d+)?)\s*,\s*"([^"]+)"\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g)) {
    const def = parseFloat(m[1]), title = m[2], min = parseFloat(m[3]), max = parseFloat(m[4]);
    const lengthLike = /len|period|lookback|window/i.test(title);
    if (min >= max) problems.push(`COVERAGE: input "${title}" has min ${min} >= max ${max} — its slider is locked. Give it a usable range around the default ${def}.`);
    else if (lengthLike && min >= def) problems.push(`COVERAGE: input "${title}" min (${min}) >= default (${def}) — the slider cannot go lower. Set min well below the default (e.g. 2).`);
    else if (lengthLike && max <= def) problems.push(`COVERAGE: input "${title}" max (${max}) <= default (${def}) — the slider cannot go higher. Set max well above the default.`);
  }

  // 3f. Explicit "no decorative visuals" — any plot3d is decoration the
  // user forbade (observed in limit testing: a backtest-focused siege
  // model still grew a 3D layer).
  if (/no decorative|no visuals|backtest(ing)?[- ]only|execution[- ]only/i.test(req) && /plot3d\s*\(|plotshape_3d\s*\(/.test(src)) {
    problems.push('COVERAGE: the user explicitly forbade decorative visuals / asked for execution only, but the script contains 3D calls. Remove all plot3d/plotshape_3d calls.');
  }

  // 3d. Ungated level-triggered signals: a plotshape whose script has no
  // crossover/crossunder anywhere and no compound (and-gated) condition
  // fires on EVERY bar the level holds — the "signals painted everywhere"
  // failure. State machines and compound conditions are exempt.
  if (/\bplotshape\s*\(/.test(src) && !/cross(?:over|under)\s*\(/.test(src)) {
    // Gated = a compound condition anywhere (if-line or the assignment
    // that defines the signal), or a var state machine doing the gating.
    const gated = src.split('\n').some(l => /\band\b/.test(l) && /=|if\b/.test(l))
      || (/\bvar\s+\w+/.test(src) && /:=/.test(src));
    if (!gated) {
      problems.push('COVERAGE: signals are level-triggered (a bare comparison like close > x with no crossover and no compound/state gate) — they fire on every bar the level holds and paint the chart. Gate signals with crossover/crossunder, a state machine (var inPos), or a compound condition.');
    }
  }

  // 3e. Same series plotted under multiple 3D styles — wasted layers that
  // answer the same question (the visual-focus rule, made checkable).
  {
    const sources = [...src.matchAll(/plot3d\s*\(\s*([^,]+),/g)].map(m => m[1].trim());
    const dup = sources.find((s, i) => sources.indexOf(s) !== i);
    if (dup) {
      problems.push(`COVERAGE: plot3d source "${dup}" is plotted under multiple styles — each 3D layer must carry a genuinely different value (raw vs smoothed, margin, count), not the same number restyled.`);
    }
  }

  // 3c. Table dashboards duplicate the app's own metrics Dashboard
  // (observed live: script table top-right + app Dashboard bottom-right
  // showing the same numbers). Only an explicit on-chart TABLE request
  // justifies table.new.
  if (/table\.new\s*\(/.test(src) && !/\btable\b|on-chart table|table dashboard/i.test(req)) {
    problems.push('COVERAGE: the script builds a table.new dashboard, but the app already renders a metrics Dashboard for every script — a table duplicates it in the top-right corner. Remove the table unless the user explicitly asked for an on-chart table; the requested dashboard values are already shown by the app.');
  }

  // 4. Dimension enforcement: Prefer-3D must actually render in 3D — but
  // in the RIGHT scene. Price-denominated series (EMAs, levels) belong in
  // the unified pane="3d" scene with the bars; oscillator series (RSI,
  // CCI, MACD…) belong in the 3D LOWER pane ("separate") — forcing them
  // into the price scene renders a spiky forest over the candles.
  const wants2DOnly = /\b(main chart only|2d only|no 3d|without 3d|remove( the)? 3d|flat chart)\b/i.test(req);
  const forbidsDecor = /no decorative|no visuals|backtest(ing)?[- ]only|execution[- ]only/i.test(req);
  if (opts.prefer3D && !wants2DOnly && !forbidsDecor) {
    const has3dAny = /plot3d\s*\(/.test(src);
    const oscillatorStudy = /\b(rsi|cci|macd|stoch|mfi|adx)\s*\(/.test(src);
    if (!has3dAny) {
      problems.push('COVERAGE: Prefer 3D is on but the script has no plot3d() at all — it will render as a flat 2D indicator. Add plot3d geometry: pane "3d" for price-denominated series (EMAs, levels), pane "separate" for oscillator series (RSI/CCI/MACD).');
    } else if (oscillatorStudy && /plot3d\s*\([^)]*"3d"/.test(src)) {
      problems.push('COVERAGE: oscillator series rendered with pane "3d" — inside the price scene it becomes a spiky forest over the candles. Use pane "separate" for oscillator plot3d layers; keep main-chart plotshape() signals.');
    }
  }
  if (wants2DOnly && /plot3d\s*\(|plotshape_3d\s*\(/.test(src)) {
    problems.push('COVERAGE: the user asked for a 2D / main-chart-only indicator but the script contains 3D calls. Remove all plot3d/plotshape_3d calls.');
  }

  return problems;
}
