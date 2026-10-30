/**
 * Few-shot exemplar retrieval for the OakScript coder.
 *
 * Models copy structure far more reliably than they follow prose rules.
 * When a request matches a built-in study (session divergence, CCI manifold,
 * volume profile, KNN vote, trailing stops, Fibonacci planes), the matching
 * built-in source is injected into the code prompt as a pattern to mirror.
 *
 * The exemplars are deliberately trimmed: comments squeezed, table
 * dashboards removed unless requested, and plot3d layers capped at three.
 * A reference must demonstrate structure, not smuggle in unrequested
 * features or blow the model's context budget.
 */
import { getIndicators } from '../oakscript/indicators';
import { stripTableCalls } from './mechanical-repair';

interface ExemplarRule {
  id: string;
  test: RegExp;
  /** Built-in indicator name (exact) or a hand-authored pattern. */
  indicator?: string;
  pattern?: string;
  why: string;
}

// Hand-authored patterns for concepts the built-in library does not cover
// with a directly reusable study. Both are valid OakScript and are kept in
// sync with the live prompts by the generation-pipeline tests.
const MTF_SIEGE_PATTERN = `// MTF SIEGE PATTERN — confirmed HTF agreement + session extremes + model.* execution
lookback = input(78, "Session Lookback", 10, 500, 1)
htfClose = security("1h", close)
htfRising = htfClose > htfClose[1]
sessHigh = highest(high, lookback)
sessLow = lowest(low, lookback)
rng = sessHigh - sessLow
pos = rng > 0 ? (close - sessLow) / rng : 0.5
quality = abs(pos - 0.5) * 2
buySig = close > sessHigh[1] and htfRising and quality > 0.25
sellSig = close < sessLow[1] and not htfRising and quality > 0.25
if buySig {
    model.confidence(quality)
    model.stopLoss(2.0)
    model.longEntry("siege")
    plotshape(bar_index, low, "Long", "triangleup", "#22cc88")
}
if sellSig {
    model.confidence(quality)
    model.stopLoss(2.0)
    model.shortEntry("siege")
    plotshape(bar_index, high, "Short", "triangledown", "#ff4477")
}
if crossunder(close, sessLow[1]) { model.longExit("siege") }
if crossover(close, sessHigh[1]) { model.shortExit("siege") }
plot(sessHigh, "Session High", "#ff4477", 1, "stepline")
plot(sessLow, "Session Low", "#22cc88", 1, "stepline")`;

const COMPRESSION_PATTERN = `// VOLATILITY COMPRESSION PATTERN — ATR/range coil + vol-of-vol + release
atrLen = input(14, "ATR Length", 2, 60, 1)
rangeLen = input(20, "Range Length", 5, 100, 1)
smoothLen = input(10, "Volatility Smoothing", 3, 50, 1)
a = atr(high, low, close, atrLen)
aBase = sma(a, smoothLen)
rng = highest(high, rangeLen) - lowest(low, rangeLen)
rngNorm = rng / max(a, 0.0001)
volOfVol = stdev(a, smoothLen)
volBase = sma(volOfVol, smoothLen)
loaded = rngNorm < 3.0 and a < aBase
unpredictable = volOfVol > volBase
coilState = loaded ? (unpredictable ? 2.0 : 1.0) : 0.0
releaseUp = loaded[1] and not loaded and close > close[1]
releaseDn = loaded[1] and not loaded and close < close[1]
if releaseUp { plotshape(bar_index, low, "Release Up", "triangleup", "#22cc88") }
if releaseDn { plotshape(bar_index, high, "Release Dn", "triangledown", "#ff4477") }
plot(rngNorm, "Coil Load", "#22aaff", 2, "separate")
plot(volOfVol, "Vol of Vol", "#b48cff", 1, "separate")
plot3d(rngNorm, "Coil Load", "surface", "#22aaff", "separate", 0)
plot3d(coilState, "Coil State", "bars3d", "#ffd43b", "separate", 1)`;

const RULES: ExemplarRule[] = [
  {
    id: 'knn-vote',
    test: /\b(knn|k-nearest|nearest[- ]neighbou?r|classifier|classification)\b/i,
    indicator: 'Lorentzian Classification',
    why: 'arrays + distance search + k-nearest vote + vote margin/confidence channels',
  },
  {
    id: 'mtf-siege',
    test: /\b(confirmed|closed)\s+(?:1h|higher[- ]timeframe|htf)\b|\bmulti[- ]timeframe\b|\bsecurity\s*\(/i,
    pattern: MTF_SIEGE_PATTERN,
    why: 'confirmed security() agreement + session extremes + model.* entries/exits/stop',
  },
  {
    id: 'volatility-compression',
    test: /\bvolatility[- ]compression|\bcoil(?:ing|ed)?\b|\bsqueeze\b/i,
    pattern: COMPRESSION_PATTERN,
    why: 'ATR/range coil state + vol-of-vol + release-gated signals + two 3D readings',
  },
  {
    id: 'volume-profile',
    test: /\b(volume[- ]profile|point of control|\bpoc\b|value area)\b/i,
    indicator: 'Liquidity Landscape — 3D Volume Terrain',
    why: 'volume-at-price bins + POC + value-area expansion + terrain',
  },
  {
    id: 'session-divergence',
    test: /\bsession\b[^.\n]{0,40}\b(high|low)|\bdivergen\w*/i,
    indicator: 'Session High/Low Divergence',
    why: 'rolling session extremes + deviation-in-range + new-extreme divergence',
  },
  {
    id: 'atr-trailing',
    test: /\batr\b[^.\n]{0,40}\btrail|\btrailing stop/i,
    indicator: 'ATR Trailing Stops',
    why: 'var state machine + warmup guard + ratcheting stop',
  },
  {
    id: 'fib-levels',
    test: /\bfib(?:onacci)?\b/i,
    indicator: 'Fibonacci Levels 3D',
    why: 'line3d levels at distinct z_levels + reclaim/loss cones',
  },
  {
    id: 'cci-manifold',
    test: /\bcci\b/i,
    indicator: 'CCI Manifold Sheet',
    why: 'oscillator in the separate pane + main-chart signals + gated cones',
  },
  {
    id: 'ema-ribbon',
    test: /\bema\b[^.\n]{0,30}\bribbon|\bribbon\b[^.\n]{0,30}\bema\b/i,
    indicator: 'EMA Ribbon',
    why: 'multiple EMAs + full-bull/full-bear gate + flip signals',
  },
  {
    id: 'macd',
    test: /\bmacd\b/i,
    indicator: 'MACD 3D Ribbon',
    why: 'MACD components in the separate pane + cross signals',
  },
  {
    id: 'stochastic',
    test: /stochastic|\bstoch\b/i,
    indicator: 'Stochastic Helix',
    why: 'zone-gated crosses + lower-pane geometry',
  },
  {
    id: 'adx',
    test: /\badx\b/i,
    indicator: 'ADX Vortex Funnel',
    why: 'ADX strength + smoothed layer + trend-birth signal',
  },
  {
    id: 'obv',
    test: /\bobv\b/i,
    indicator: 'OBV Trail Stream',
    why: 'OBV flow + trend line + cross signals',
  },
  {
    id: 'vwap',
    test: /\bvwap\b/i,
    indicator: 'VWAP Bands',
    why: 'VWAP + deviation bands + cross signals',
  },
  {
    id: 'mean-reversion',
    test: /\bbollinger\b|\bmean[- ]reversion\b/i,
    indicator: 'Quantum Reversion Engine',
    why: 'band reclaim + basis exit + model.* execution + confidence/stop',
  },
  {
    id: 'regression',
    test: /\bregression\b|\blinreg\b/i,
    indicator: 'Regression Nebula',
    why: 'regression.channel + band fill + breach signals',
  },
  {
    id: 'volume-climax',
    test: /\bvolume\b[^.\n]{0,30}\bclimax|\brelative[- ]volume\b|\brelvol\b/i,
    indicator: 'Volume 3D Bars',
    why: 'relative volume + sparse climax signals + 3D volume bars',
  },
];

function allIndicators() {
  try {
    return getIndicators();
  } catch {
    return [];
  }
}

export interface ResolvedExemplar {
  id: string;
  name: string;
  why: string;
  source: string;
}

/** Squeeze comments/blank lines and cap the reference to a prompt budget. */
function compactSource(source: string, maxChars: number): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let commentRun = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (t.startsWith('//')) {
      // Drop decorative rule/box comments entirely; keep at most two
      // explanatory comment lines per section.
      if (/^\/{2,}[\s\-─═—–=*#_]+$/.test(t)) continue;
      commentRun++;
      if (commentRun > 2) continue;
      out.push(line);
      continue;
    }
    commentRun = 0;
    out.push(line);
  }
  let text = out.join('\n').trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    const lastNl = text.lastIndexOf('\n');
    if (lastNl > maxChars * 0.6) text = text.slice(0, lastNl);
    text += '\n// …(reference truncated to fit the prompt budget)';
  }
  return text;
}

function cap3DLayers(source: string, maxLayers: number): string {
  let seen = 0;
  return source.split('\n').filter(line => {
    if (!/\bplot3d\s*\(/.test(line)) return true;
    seen++;
    return seen <= maxLayers;
  }).join('\n');
}

function prepare(source: string, request: string, maxChars: number): string {
  let text = source;
  if (!/\btable\b|on-chart table|table dashboard/i.test(request)) {
    text = stripTableCalls(text).code;
  }
  const maxLayers = /\bfib(?:onacci)?\b/i.test(request) ? 4 : 3;
  text = cap3DLayers(text, maxLayers);
  return compactSource(text, maxChars);
}

/** Return up to `limit` exemplars whose structural pattern matches the
 *  request. Built-ins are resolved by name; custom patterns are used as-is. */
export function findExemplars(
  request: string,
  opts: { max?: number; maxChars?: number } = {},
): ResolvedExemplar[] {
  const max = opts.max ?? 2;
  const maxChars = opts.maxChars ?? 6000;
  const indicators = allIndicators();
  const picked: ResolvedExemplar[] = [];
  for (const rule of RULES) {
    if (picked.length >= max) break;
    if (!rule.test.test(request)) continue;
    if (rule.pattern) {
      picked.push({
        id: rule.id,
        name: rule.id,
        why: rule.why,
        source: prepare(rule.pattern, request, Math.min(maxChars, 4500)),
      });
      continue;
    }
    const def = indicators.find(i => i.name === rule.indicator);
    if (!def) continue;
    picked.push({
      id: rule.id,
      name: def.name,
      why: rule.why,
      source: prepare(def.source, request, maxChars),
    });
  }
  return picked;
}

/** Every reference source in the library, for regression probes over the whole set. */
export function allExemplarSources(): Array<{ id: string; source: string }> {
  const indicators = allIndicators();
  const out: Array<{ id: string; source: string }> = [];
  for (const rule of RULES) {
    if (rule.pattern) {
      out.push({ id: rule.id, source: rule.pattern });
      continue;
    }
    const def = indicators.find(i => i.name === rule.indicator);
    if (def) out.push({ id: rule.id, source: def.source });
  }
  return out;
}

export function formatExemplarBlock(exemplars: ResolvedExemplar[]): string {
  if (exemplars.length === 0) return '';
  const chunks = exemplars.map(e =>
    `### ${e.name}\nWhy this matches: ${e.why}\n\`\`\`oakscript\n${e.source}\n\`\`\``);
  return `\n\nREFERENCE PATTERNS (mirror the STRUCTURE and call signatures; adapt names, values, and visuals to the request; do NOT copy features or extras the request did not ask for):\n\n${chunks.join('\n\n')}\n`;
}
