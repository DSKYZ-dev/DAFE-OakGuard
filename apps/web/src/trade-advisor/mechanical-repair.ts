/**
 * Mechanical repair — deterministic fixes for violations that do not need a
 * model round-trip.
 *
 * The fix loop used to spend its three model rounds asking a stochastic
 * generator to delete a table or a forbidden 3D layer, and sometimes it
 * refused. These repairs are purely structural and can be applied — and
 * verified — with the validator before any model call. Semantic violations
 * (wrong indicator family, no KNN vote, missing model.* execution) are left
 * to the model, because removing code cannot invent the missing logic.
 */

import { classifySeries, plot3dLayers, seriesDefs } from './pane-law';

export interface MechanicalRepairResult {
  code: string;
  removed: string[];
}

function isCompleteCallLine(line: string): boolean {
  // Only touch lines whose parentheses balance, so a multi-line call is never
  // half-removed into invalid syntax. The validator catches anything missed.
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth === 0;
}

function stripLines(code: string, shouldRemove: (line: string, index: number) => string | null): MechanicalRepairResult {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const reason = shouldRemove(lines[i], i);
    if (reason && isCompleteCallLine(lines[i])) {
      removed.push(`${reason}: ${lines[i].trim()}`);
      continue;
    }
    kept.push(lines[i]);
  }
  return { code: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

function merge(a: MechanicalRepairResult, b: MechanicalRepairResult): MechanicalRepairResult {
  return { code: b.code, removed: [...a.removed, ...b.removed] };
}

/** Remove table.new/table.cell dashboards (the app already renders a metrics
 *  Dashboard for every script). Only call this when the request did NOT ask
 *  for an on-chart table. */
export function stripTableCalls(code: string): MechanicalRepairResult {
  const handles = new Set<string>();
  for (const m of code.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*table\.new\s*\(/gm)) handles.add(m[1]);
  const handleRe = handles.size > 0
    ? new RegExp(`\\b(?:${[...handles].join('|')})\\b`)
    : null;
  return stripLines(code, (line) => {
    const t = line.trim();
    if (/^table\.new\s*\(/.test(t) || /=\s*table\.new\s*\(/.test(t)) return 'table dashboard';
    if (handleRe && handleRe.test(t) && /\btable\.(?:cell|clear|delete)\s*\(/.test(t)) return 'table dashboard';
    if (!handleRe && /\btable\.(?:cell|clear|delete)\s*\(/.test(t)) return 'table dashboard';
    return null;
  });
}

/** Remove all 3D rendering calls. Only call this when the request is
 *  explicitly 2D-only or forbids decorative visuals / asks for execution
 *  only. */
export function strip3DCalls(code: string): MechanicalRepairResult {
  return stripLines(code, (line) => {
    if (/\b(?:plot3d|plotshape_3d|label3d)\s*\(/.test(line)) return 'forbidden 3D layer';
    return null;
  });
}

/** Keep the first plot3d call per source expression, remove restyles of the
 *  same value. Each 3D layer must answer a different question. */
export function stripDuplicate3DLayers(code: string): MechanicalRepairResult {
  const seen = new Set<string>();
  return stripLines(code, (line) => {
    const m = /plot3d\s*\(\s*([^,]+),/.exec(line);
    if (!m) return null;
    const source = m[1].replace(/\s+/g, ' ').trim();
    if (!source) return null;
    if (seen.has(source)) return `duplicate plot3d source "${source}"`;
    seen.add(source);
    return null;
  });
}

/** Hard-cap 3D layers at the visual-focus limit. Extra layers are decoration,
 *  not analysis: the coder prompt and every exemplar allow at most three.
 *  When a script puts 3 line3d rails ahead of its only terrain layer
 *  (surface/manifold/ridgeline), keep the terrain layer and drop the extra rail
 *  so capping never strips the primary terrain. */
export function cap3DLayers(code: string, maxLayers = 3): MechanicalRepairResult {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const plot3dIndices = lines
    .map((l, idx) => (/\bplot3d\s*\(/.test(l) ? idx : -1))
    .filter(idx => idx >= 0);
  if (plot3dIndices.length <= maxLayers) return { code, removed: [] };

  const isTerrain = (l: string) => /plot3d\s*\([^)]*"(ridgeline|surface|manifold)"/.test(l);
  const keep = new Set<number>(plot3dIndices.slice(0, maxLayers));
  const keptHasTerrain = [...keep].some(i => isTerrain(lines[i]));
  const laterTerrain = plot3dIndices.slice(maxLayers).find(i => isTerrain(lines[i]));
  if (!keptHasTerrain && laterTerrain !== undefined) {
    const dropIdx = plot3dIndices[maxLayers - 1];
    keep.delete(dropIdx);
    keep.add(laterTerrain);
  }

  return stripLines(code, (line, idx) => {
    if (!/\bplot3d\s*\(/.test(line)) return null;
    if (keep.has(idx)) return null;
    return `extra 3D layer (limit ${maxLayers})`;
  });
}

export function max3DLayersForRequest(request: string): number {
  if (/\b5\s+(?:distinct\s+|parallel\s+|vertical\s+)*(?:channel|cylinder|level|layer)/i.test(request)) return 6;
  if (/\bfib(?:onacci)?\b/i.test(request)) return 4;
  return 3;
}

/** Move a plot3d() layer from "3d" to "separate" when its series is an oscillator
 *  or volatility measure (pane-law.ts), so it cannot paint a spiky overlay on the
 *  candles. Price levels stay in the price scene. */
export function repairOscillatorPane3D(code: string): MechanicalRepairResult {
  const defs = seriesDefs(code);
  const targets = plot3dLayers(code)
    .filter(l => l.pane === '3d' && l.paneAt >= 0 && classifySeries(l.series, defs) === 'oscillator');
  let out = code;
  for (const t of [...targets].sort((a, b) => b.paneAt - a.paneAt)) {
    out = out.slice(0, t.paneAt) + '"separate"' + out.slice(t.paneAt + '"3d"'.length);
  }
  return { code: out, removed: targets.map(t => `routed non-price plot3d(${t.series}) from "3d" to "separate"`) };
}

/** Split a call's argument text at top-level commas (parens and brackets nest). */
function splitTopLevelArgs(inner: string): string[] {
  if (inner.trim() === '') return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** array(a, b, c) returns an EMPTY array in OakScript (array(n) is a pre-allocated
 *  size), so averages over it read 0. Rewrite a value-list call to the literal
 *  [a, b, c]. A numeric first argument is left alone: array(10, 0) is not a value list. */
export function repairArrayConstructor(code: string): MechanicalRepairResult {
  const removed: string[] = [];
  let out = code;
  let from = 0;
  for (;;) {
    const re = /(?<![\w.])array\(/g;
    re.lastIndex = from;
    const m = re.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < out.length; k++) {
      if (out[k] === '(' || out[k] === '[') depth++;
      else if (out[k] === ')' || out[k] === ']') {
        depth--;
        if (depth === 0) { close = k; break; }
      }
    }
    if (close < 0) break;
    const args = splitTopLevelArgs(out.slice(open + 1, close)).map(a => a.trim());
    if (args.length >= 2 && !/^\d+(\.\d+)?$/.test(args[0])) {
      const literal = `[${args.join(', ')}]`;
      removed.push(`array(${args.length} values) -> ${literal}`);
      out = out.slice(0, m.index) + literal + out.slice(close + 1);
      from = m.index + literal.length;
    } else {
      from = close + 1;
    }
  }
  return { code: out, removed };
}

export function repairMechanicalViolations(
  code: string,
  request: string,
  opts: { prefer3D?: boolean } = {},
): MechanicalRepairResult {
  let result: MechanicalRepairResult = { code, removed: [] };

  if (/(?<![\w.])array\(/.test(result.code)) {
    const arrays = repairArrayConstructor(result.code);
    if (arrays.removed.length > 0) result = merge(result, arrays);
  }

  const wantsTable = /\btable\b|on-chart table|table dashboard/i.test(request);
  if (!wantsTable && /\btable\.(?:new|cell|clear)\s*\(/.test(result.code)) {
    const stripped = stripTableCalls(result.code);
    // Only accept the strip if it produced parseable code; otherwise leave the
    // violation for the model/validator loop.
    if (!/\btable\.(?:new|cell|clear)\s*\(/.test(stripped.code)) result = merge(result, stripped);
  }

  const forbids3D = /\b(main chart only(?!\s+(?:when|if|where|after|once)\b)|2d only|no 3d|without 3d|remove(?: the)? 3d|flat chart|no decorative|no visuals|backtest(?:ing)?[- ]only|execution[- ]only)\b/i.test(request);
  if (forbids3D && /\b(?:plot3d|plotshape_3d|label3d)\s*\(/.test(result.code)) {
    const stripped = strip3DCalls(result.code);
    if (!/\b(?:plot3d|plotshape_3d|label3d)\s*\(/.test(stripped.code)) result = merge(result, stripped);
  }

  if (/\bplot3d\s*\(/.test(result.code)) {
    const paneFixed = repairOscillatorPane3D(result.code);
    if (paneFixed.removed.length > 0) result = merge(result, paneFixed);
    const deduped = stripDuplicate3DLayers(result.code);
    if (deduped.removed.length > 0) result = merge(result, deduped);
    const maxLayers = max3DLayersForRequest(request);
    const layerCount = (result.code.match(/\bplot3d\s*\(/g) || []).length;
    if (layerCount > maxLayers) {
      const capped = cap3DLayers(result.code, maxLayers);
      if (capped.removed.length > 0) result = merge(result, capped);
    }
  }

  return result;
}
