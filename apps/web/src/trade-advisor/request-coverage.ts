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

import { classifySeries, plot3dLayers, seriesDefs } from './pane-law';

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
  { id: 'bollinger', label: 'Bollinger Bands', requestRe: /bollinger/i, codeRe: /\bbollinger\b|(?:basis|mid)\w*\s*[+-]\s*(?:\w+\s*\*\s*)?stdev\s*\(\s*close\b/i },
];

const FAMILY_BY_ID = new Map(FAMILIES.map(f => [f.id, f]));

export function getFamilyLabel(id: string): string {
  return FAMILY_BY_ID.get(id)?.label || id;
}

export function familyIdFromLabel(label: string): string | undefined {
  const wanted = label.trim().toLowerCase();
  return FAMILIES.find(f => f.label.toLowerCase() === wanted || f.id === wanted)?.id;
}

/** Lines that actually compute/plot a family, for the fix-loop removal list. */
export function familyCodeLines(code: string, id: string): string[] {
  const fam = FAMILY_BY_ID.get(id);
  if (!fam) return [];
  return stripComments(code).split('\n').filter(l => fam.codeRe.test(l)).map(l => l.trim());
}

/** Negation is syntactically tied to the family ("do not use EMA",
 *  "no EMAs", "without moving averages") — a stray "no" elsewhere in the
 *  sentence ("No trading signals", "RSI Length") is not a rejection. */
function negatedInRequest(req: string, fam: Family): boolean {
  return new RegExp(`\\b(?:do not|don't|dont|never|without|no)\\s+(?:use\\s+|using\\s+)?(?:any\\s+)?(?:${fam.requestRe.source})`, 'i').test(req)
    || new RegExp(`\\bremove\\s+(?:the\\s+|all\\s+)?(?:${fam.requestRe.source})`, 'i').test(req);
}

export interface RequestFamilies {
  requested: string[];
  excluded: string[];
}

/** Deterministic classification of which indicator families a request names
 *  and which it explicitly rejects. Used both by the code gate and by the
 *  pre-code concept-brief gate. */
export function classifyRequestFamilies(request: string): RequestFamilies {
  const requested: string[] = [];
  const excluded: string[] = [];
  for (const fam of FAMILIES) {
    if (negatedInRequest(request, fam)) excluded.push(fam.id);
    else if (fam.requestRe.test(request)) requested.push(fam.id);
  }
  return { requested, excluded };
}

/** Composite/ML requests legitimately use oscillator families as FEATURES.
 *  Without this exemption a correct KNN model that reads RSI/CCI/ADX as
 *  inputs is flagged for "introducing RSI" and the fix loop strips the very
 *  features that make it a KNN model. The exemption only applies when the
 *  script also contains a genuine composite core (distance/vote/array loop),
 *  so an EMA-template substitution still gets caught. */
export function isCompositeRequest(request: string): boolean {
  return /\b(knn|k-nearest|nearest[- ]neighbou?r|classifier|classification|machine[- ]learning|ml model|feature[- ]space|feature vector|ensemble|vote|voting|similarity|cluster(?:ing)?|pattern[- ]recognition)\b/i.test(request);
}

function hasCompositeCore(code: string): boolean {
  return /\b(vote|voting|distance|neighbou?r|nearest|feature|classifier|classification|similarity|array\.)/i.test(code)
    && /\b(while|for)\b/.test(code);
}

export interface ConceptBrief {
  uses: string[];
  excludes: string[];
}

function briefList(text: string, key: 'USES' | 'EXCLUDES'): string[] {
  const normalized = text.replace(/[*_`]/g, '');
  const m = new RegExp(`(?:^|\\n)\\s*(?:[-•]\\s*)?(?:\\d+[.)]\\s*)?\\b${key}\\b\\s*[:\\-]\\s*([^\\n]*)`, 'i').exec(normalized);
  if (!m) return [];
  const value = m[1].trim();
  if (!value || /^(none|n\/a|nothing|—|-)$/i.test(value)) return [];
  return value.split(/[,;/|]+|\band\b/).map(s => s.trim()).filter(Boolean);
}

export function parseConceptBrief(text: string): ConceptBrief {
  return { uses: briefList(text, 'USES'), excludes: briefList(text, 'EXCLUDES') };
}

function familyMentions(text: string): string[] {
  return FAMILIES.filter(f => f.requestRe.test(text)).map(f => f.id);
}

/**
 * Gate Phase 1's design brief BEFORE any code is generated. The brief must
 * name what it will use and what the request forbids. A brief that plans an
 * EMA for a session-divergence request fails here and the brief is
 * regenerated — the coder is never asked to write code against a poisoned
 * design.
 */
export function checkConceptBrief(request: string, brief: string): string[] {
  const problems: string[] = [];
  if (!/\bUSES\s*:/i.test(brief)) {
    problems.push('CONCEPT BRIEF: missing a USES: line — the design must state which concept families it will use.');
  }
  if (!/\bEXCLUDES\s*:/i.test(brief)) {
    problems.push('CONCEPT BRIEF: missing an EXCLUDES: line — write "EXCLUDES: NONE" when the request forbids nothing.');
  }
  if (problems.length > 0) return problems;

  const parsed = parseConceptBrief(brief);
  const { requested, excluded } = classifyRequestFamilies(request);
  const uses = new Set(familyMentions(parsed.uses.join(', ')));
  const excludes = new Set(familyMentions(parsed.excludes.join(', ')));
  const composite = isCompositeRequest(request)
    && /\b(vote|voting|distance|neighbou?r|nearest|feature|classifier|similarity)\b/i.test(brief);

  for (const id of uses) {
    if (!requested.includes(id) && !excluded.includes(id) && !composite) {
      problems.push(`CONCEPT BRIEF: the design plans to use ${getFamilyLabel(id)}, which the request never asked for. Rebuild the design from the requested concepts only.`);
    }
  }
  for (const id of requested) {
    if (!uses.has(id)) {
      problems.push(`CONCEPT BRIEF: the request asks for ${getFamilyLabel(id)} but the design's USES line omits it.`);
    }
  }
  for (const id of excluded) {
    if (!excludes.has(id)) {
      problems.push(`CONCEPT BRIEF: the request explicitly rejects ${getFamilyLabel(id)} but the design's EXCLUDES line omits it.`);
    }
  }
  for (const id of uses) {
    if (excludes.has(id)) {
      problems.push(`CONCEPT BRIEF: ${getFamilyLabel(id)} appears in both USES and EXCLUDES — the design is contradictory.`);
    }
  }

  // Scan the rest of the brief (outside EXCLUDES and negation clauses) for
  // families the request never asked for. This catches "Calculation: smooth
  // with an EMA" even when the USES line is clean.
  const body = brief.split('\n').filter(l => !/\bEXCLUDES\s*:/i.test(l)).join('\n')
    .replace(/\b(?:do not|don't|dont|never|without|avoid|exclude|no)\b[^.\n]*/gi, '');
  for (const id of familyMentions(body)) {
    if (!requested.includes(id) && !excluded.includes(id) && !composite) {
      problems.push(`CONCEPT BRIEF: the design text mentions ${getFamilyLabel(id)}, which the request never asked for. Remove it from the design before writing code.`);
    }
  }
  return problems;
}

/** A deterministic constraint block appended to every code prompt. Even when
 *  the model's design brief is imperfect, code generation cannot lose the
 *  request's own family list. */
export function buildBindingBrief(request: string): string {
  const { requested, excluded } = classifyRequestFamilies(request);
  const uses = requested.length > 0
    ? requested.map(getFamilyLabel).join(', ')
    : 'ONLY the structures named in the request';
  const excludes = excluded.length > 0
    ? excluded.map(getFamilyLabel).join(', ')
    : 'NONE';
  return `BINDING CONSTRAINTS (deterministic, checked before code):
USES: ${uses}
EXCLUDES: ${excludes}
Do not introduce any indicator family outside USES. Do not substitute a moving-average/oscillator template for the requested concept.`;
}

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

  // 0. A script with no rendering call cannot produce an indicator. This
  // also catches over-aggressive mechanical stripping (e.g. removing the
  // only 3D calls from a 2D-incompatible script leaves nothing visible).
  if (!/\bplot\w*\s*\(/.test(src)) {
    problems.push('COVERAGE: the script has no plot()/plotshape()/plot3d() output. Every model must render at least one visible series or marker.');
  }

  // 1. Unrequested / explicitly-rejected concept families.
  // Repair intent ("fix/upgrade this script") inherits the script's own
  // families — flagging the RSI inside a pasted RSI script as
  // "unrequested" is a false positive that poisons the fix loop.
  const repairIntent = /\b(fix|repair|upgrade|correct|debug)\b[^.\n]{0,40}\bscript\b/i.test(req);
  const compositeExempt = isCompositeRequest(req) && hasCompositeCore(src);
  for (const fam of FAMILIES) {
    if (!fam.codeRe.test(src)) continue;
    if (repairIntent && !/\b(remove|drop|delete)\b[^.\n]{0,30}/i.test(req)) {
      // Still enforce explicit negations below, but not introduction.
      if (!negatedInRequest(req, fam)) continue;
    }
    // "Band" requests (Bollinger-style) intrinsically need an SMA basis.
    const requested = fam.requestRe.test(req)
      || ((fam.id === 'sma' || fam.id === 'ema') && /\bbollinger|\bbands?\b/i.test(req));
    const negated = negatedInRequest(req, fam);
    const preExisting = prev ? fam.codeRe.test(prev) : false;
    if (negated) {
      problems.push(`COVERAGE: the user explicitly rejected ${fam.label} ("${req.slice(0, 90)}") but the script uses it. Remove every ${fam.label} calculation and plot.`);
    } else if (!requested && !preExisting && !compositeExempt) {
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

  // 2a. A named indicator family must be computed, not just mentioned. The
  // family's builtin counts, and so does the operation that defines it when a
  // model writes it out by hand (highest/lowest for %K, cum for VWAP). The
  // moving-average and Bollinger families have several equivalent forms, so they
  // are not checked here.
  const FAMILY_COMPUTED: Record<string, { test: (s: string) => boolean; example: string }> = {
    ema: { test: s => /\bema\s*\(/.test(s), example: 'ema(close, n)' },
    macd: { test: s => /\bmacd\s*\(/.test(s), example: 'macd(close, fast, slow, signal)' },
    rsi: { test: s => /\brsi\s*\(/.test(s), example: 'rsi(close, n)' },
    atr: { test: s => /\batr\s*\(/.test(s), example: 'atr(high, low, close, n)' },
    stoch: { test: s => /\bstoch\s*\(/.test(s) || (/\bhighest\s*\(/.test(s) && /\blowest\s*\(/.test(s)), example: 'stoch(high, low, close, n)' },
    vwap: { test: s => /\bvwap\s*\(/.test(s) || /\bcum\s*\(/.test(s), example: 'vwap(close, volume)' },
  };
  const { requested: askedFamilies } = classifyRequestFamilies(req);
  for (const id of askedFamilies) {
    const computed = FAMILY_COMPUTED[id];
    if (computed && !computed.test(src)) {
      const label = getFamilyLabel(id);
      problems.push(`COVERAGE: the request asks for ${label}, but the script never computes it (expected ${computed.example}). Compute ${label} from the bar data and drive the signal logic with it.`);
    }
  }

  // 2b. Composite-model requests carry their own structural contract. These
  // checks catch the observed "semantic drift" failures where a valid script
  // has nothing to do with the requested model (e.g. a KNN request answered
  // with a price plot, or a siege/backtest request with dead signals).
  const wantsKnn = /\b(knn|k-nearest|nearest[- ]neighbou?r|classifier|classification)\b/i.test(req);
  if (wantsKnn) {
    const hasVote = /\b(vote|voting|bullVotes|bearVotes)\b/i.test(src);
    const hasDistance = /\b(dist|distance|neighbou?r|nearest|similarity|feature)\w*/i.test(src)
      || /\barray\.(?:push|get|set)\s*\(/.test(src);
    if (!hasVote) {
      problems.push('COVERAGE: the request asks for a KNN/nearest-neighbour vote but the script has no vote count. Implement the k nearest neighbours, count their up/down labels, and expose the result.');
    }
    if (!hasDistance) {
      problems.push('COVERAGE: the request asks for nearest neighbours but the script has no distance/feature comparison. Compute a distance between the current feature vector and historical bars, then select the k nearest.');
    }
    if (/\b(both agree|only signal when|agreement)\b/i.test(req)
      && !src.split('\n').some(l => /\band\b/.test(l) && /(?:=|if\b)/.test(l))) {
      problems.push('COVERAGE: the request says to signal only when both readings agree, but the script has no compound (and-gated) signal condition.');
    }
  }

  // "Two separate readings / two independently readable channels" must
  // actually produce two independently readable series.
  if (/\b(two (?:separate|independent)|two independently readable|as two (?:separate )?readings)\b/i.test(req)) {
    const plot3dSources = new Set([...src.matchAll(/plot3d\s*\(\s*([^,]+),/g)].map(m => m[1].trim()));
    const plotLines = (src.match(/(?<![\w.])plot\s*\(/g) || []).length;
    if (plot3dSources.size < 2 && plotLines < 2) {
      problems.push('COVERAGE: the request asks for two independently readable readings/channels, but the script renders fewer than two distinct series. Give each reading its own source value (raw vs smoothed, margin, count, disagreement) — do not restyle the same number.');
    }
  }

  // Volume-profile requests need a real profile, not just a price line.
  if (/\b(volume[- ]profile|point of control|\bpoc\b|value area)\b/i.test(req)) {
    const hasProfile = /\b(poc\w*|vaHigh|vaLow|valueArea|value area|profile\w*)\s*(?:=|:=)/i.test(src)
      || /\b(?:pocBin|pocPrice|pocVal|vaHigh|vaLow)\b/.test(src);
    if (!hasProfile) {
      problems.push('COVERAGE: the request asks for a volume profile / POC / value area but the script never computes one. Build volume-at-price bins, find the point of control, expand the value area, and plot/plot3d those values.');
    }
  }
  if (/\b(2d must|when 3d is off|2d twin)\b/i.test(req) && !/(?<![\w.])plot\s*\(/.test(src)) {
    problems.push('COVERAGE: the request states that 2D must carry the same information when 3D is off, but the script has no 2D plot() calls.');
  }

  // Confirmed higher-timeframe agreement must actually use security().
  if (/\b(confirmed|closed)\s+(?:1h|higher[- ]timeframe|htf)\b|\bconfirmed\s+(?:structure|trend)\b/i.test(req)
    && !/\bsecurity\s*\(/.test(src)) {
    problems.push('COVERAGE: the request requires confirmed higher-timeframe agreement, but the script never calls security(timeframe, source). Use a confirmed, closed higher-timeframe value.');
  } else if (/\b(confirmed|closed)\s+1h\b/i.test(req) && !/\bsecurity\s*\(\s*"1h"/.test(src)) {
    problems.push('COVERAGE: the request requires confirmed 1h structure — call security("1h", source) with the literal "1h" timeframe string.');
  }

  // Explicit signal requests must emit 2D main-chart plotshape() markers
  // (even when 3D cones or model.* execution calls are also present).
  if (/\b(fire on release|only signal when|is the signal|mark entries)\b/i.test(req)
    && !/(?<![\w.])plotshape\s*\(/.test(src)) {
    problems.push('COVERAGE: the request asks for chart signals, but the script has no 2D plotshape(bar_index, low/high, ...) markers on the main chart. Always include 2D plotshape() markers inside the signal conditions.');
  }

  // Backtest/auto-trade requests need order-event calls, not just markers.
  const wantsExecution = /\b(backtest(?:er)?[- ]?(?:ready)?|auto[- ]?trad|model\.\*|entries?\s*(?:and|\/|&)\s*exits?|long\/short execution)\b/i.test(req);
  if (wantsExecution) {
    const wantsModelApi = /\bmodel\.\*/i.test(req);
    if (!/\bmodel\.(?:entry|longEntry|shortEntry)\s*\(/.test(src) && (wantsModelApi || !/\bstrategy\.entry\s*\(/.test(src))) {
      problems.push('COVERAGE: the request asks for a backtester/auto-trading model, but the script has no model.entry/model.longEntry/model.shortEntry calls. Add the order-event calls inside the signal conditions.');
    }
    if (!/\bmodel\.(?:exit|longExit|shortExit)\s*\(/.test(src) && (wantsModelApi || !/\bstrategy\.exit\s*\(/.test(src))) {
      problems.push('COVERAGE: the request asks for a backtester/auto-trading model, but the script has no model.exit/model.longExit/model.shortExit calls. Add the exit order-event calls.');
    }
    if (/\bhard stop|stop[- ]loss\b/i.test(req) && !/\bmodel\.stopLoss\s*\(/.test(src)) {
      problems.push('COVERAGE: the request asks for a hard stop, but the script has no model.stopLoss(...) bracket. Attach a hard stop to the entries.');
    }
    if (/\bconfidence\b/i.test(req) && !/\bmodel\.confidence\s*\(/.test(src)) {
      problems.push('COVERAGE: the request asks for confidence, but the script never calls model.confidence(...). Attach the requested confidence score to the entries.');
    }
  }

  // Volatility-compression requests must actually compute ATR, a coil state,
  // and a release transition gate when the request asks to fire on release.
  if (/\bvolatility[- ]compression|coil(?:ing|ed)?\b|\bsqueeze\b/i.test(req)) {
    if (!/\batr\s*\(/.test(src)) {
      problems.push('COVERAGE: the request is a volatility-compression model built on ATR, but the script never calls atr(high, low, close, length).');
    }
    const hasState = /\b(coil|squeeze|compress|loaded|release|expand)\w*\s*(?:=|:=)/i.test(src)
      || /\b(?:if|and)\b[^\n]*\b(coil|squeeze|compress|loaded|release|expand)/i.test(src);
    if (!hasState) {
      problems.push('COVERAGE: the request asks for a loaded coil and a release event, but the script has no compression/loaded/release state. Compute the coil condition, plot how loaded it is, and gate the signal on the release.');
    }
    if (/\bfire on release\b/i.test(req) && !/crossover|crossunder|barssince|var\s|release|loaded\[1\]/.test(src)) {
      problems.push('COVERAGE: the request asks to fire on release of the coil, but the script has no release transition gate. Define an explicit release condition (e.g. releaseUp = loaded[1] and not loaded, crossover/crossunder, or a var state machine) and gate the signals on it.');
    }
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

  // 3g. Main-chart plotshape markers must anchor to the bar's [low, high]
  // range (low, high, close, or open) — passing an external level like
  // pocPrice or low - atr floats markers off the candle.
  for (const m of src.matchAll(/(?<![\w.])plotshape\s*\(\s*bar_index\s*,\s*([^,]+),/g)) {
    const priceExpr = m[1].trim();
    if (!/^(?:low|high|close|open)$/.test(priceExpr)) {
      problems.push(`COVERAGE: plotshape(bar_index, ${priceExpr}, ...) places a 2D marker at "${priceExpr}", which can sit outside the bar's [low, high] range. Use low for buy/up markers or high for sell/down markers.`);
      break;
    }
  }

  // 4. Dimension enforcement: Prefer-3D must actually render in 3D — but
  // in the RIGHT scene. Price-denominated series (EMAs, levels) belong in
  // the unified pane="3d" scene with the bars; oscillator series (RSI,
  // CCI, MACD…) belong in the 3D LOWER pane ("separate") — forcing them
  // into the price scene renders a spiky forest over the candles.
  const wants2DOnly = /\b(main chart only(?!\s+(?:when|if|where|after|once)\b)|2d only|no 3d|without 3d|remove( the)? 3d|flat chart)\b/i.test(req);
  const forbidsDecor = /no decorative|no visuals|backtest(ing)?[- ]only|execution[- ]only/i.test(req);
  // Judged per series (pane-law.ts): a price level in the 3D scene is fine
  // even when the script also runs an RSI on the separate pane.
  const oscillatorStudy = /\b(rsi|cci|macd|stoch|mfi|adx)\s*\(/.test(src);
  const pane3dDefs = seriesDefs(src);
  const pane3dClasses = plot3dLayers(src).filter(l => l.pane === '3d').map(l => classifySeries(l.series, pane3dDefs));
  if (pane3dClasses.some(c => c === 'oscillator' || (c === 'unknown' && oscillatorStudy))) {
    problems.push('COVERAGE: oscillator series rendered with pane "3d" — inside the price scene it becomes a spiky forest over the candles. Use pane "separate" for oscillator plot3d layers; keep main-chart plotshape() signals.');
  }
  const plot3dCount = (src.match(/\bplot3d\s*\(/g) || []).length;
  const max3dLayers = /\b5\s+(?:distinct\s+|parallel\s+|vertical\s+)*(?:channel|cylinder|level|layer)/i.test(req)
    ? 6
    : /\bfib(?:onacci)?\b/i.test(req)
      ? 4
      : 3;
  if (plot3dCount > max3dLayers) {
    problems.push(`COVERAGE: the script has ${plot3dCount} plot3d() layers (limit ${max3dLayers}) — remove extra decorative 3D layers so at most ${max3dLayers} distinct layers remain.`);
  }
  if (opts.prefer3D && !wants2DOnly && !forbidsDecor) {
    const has3dAny = plot3dCount > 0;
    if (!has3dAny) {
      problems.push('COVERAGE: Prefer 3D is on but the script has no plot3d() at all — it will render as a flat 2D indicator. Add plot3d geometry: pane "3d" for price-denominated series (EMAs, levels), pane "separate" for oscillator series (RSI/CCI/MACD).');
    }
    if (/\bterrain\b/i.test(req) && !/plot3d\s*\([^)]*"(ridgeline|surface|manifold)"/.test(src)) {
      problems.push('COVERAGE: the request asks for 3D terrain, but the script has no terrain plot3d() style. Include a plot3d(..., "surface" | "manifold" | "ridgeline", ...) layer for the terrain alongside any line3d rail.');
    }
  }
  if (wants2DOnly && /plot3d\s*\(|plotshape_3d\s*\(/.test(src)) {
    problems.push('COVERAGE: the user asked for a 2D / main-chart-only indicator but the script contains 3D calls. Remove all plot3d/plotshape_3d calls.');
  }

  return problems;
}
