/**
 * Signal-engine audit — runs every built-in library indicator through the same
 * validator and interpreter the app uses, on synthetic bars, and reports what
 * each one draws in 2D and 3D. The 2D view uses the same twin rule as the chart
 * (apps/web/src/plot-twins.ts), so "bridged" is what the 2D view adds.
 *
 * Usage: npx tsx tools/verify/signal-engine-audit.ts
 *
 * Columns:
 *   val / rt   validator errors and runtime errors (must be 0)
 *   2D         2D line points (one record per bar) and 2D signal markers
 *   3D         plot3d layers, plus 3D cones/shapes and 3D labels
 *   bridged    3D layers the 2D view draws through a 2D twin (no 2D line of their own)
 *   const      layers that hold one value on every bar (flat walls / flat lines)
 *   clust      signals that repeat on back-to-back bars (should be events, not states)
 *
 * Exit code is 1 only when an indicator fails validation, throws at runtime, or
 * draws nothing. Warnings are reported but do not fail the audit.
 */
import { getIndicators } from '../../apps/web/src/oakscript/indicators';
import { parse } from '../../apps/web/src/oakscript/parser';
import { validate } from '../../apps/web/src/oakscript/validator';
import { executeScript } from '../../apps/web/src/oakscript/interpreter';
import { syntheticBars } from '../../apps/web/src/oakguard/mutants';
import { probeConstantLines, probeSignalClustering } from '../../apps/web/src/trade-advisor/generation-pipeline';
import { layerTwins } from '../../apps/web/src/plot-twins';

const BARS = syntheticBars(400);

interface Row {
  name: string;
  validation: number;
  runtime: number;
  lines2d: number;
  signals2d: number;
  layers3d: number;
  shapes3d: number;
  labels3d: number;
  bridged: number;
  constant: number;
  clustered: number;
  status: 'OK' | 'WARN' | 'FAIL';
  note: string;
}

function auditOne(name: string, source: string): Row {
  const row: Row = {
    name, validation: 0, runtime: 0, lines2d: 0, signals2d: 0, layers3d: 0,
    shapes3d: 0, labels3d: 0, bridged: 0, constant: 0, clustered: 0, status: 'OK', note: '',
  };
  const issues = validate(source).issues.filter(i => i.severity === 'error');
  row.validation = issues.length;
  if (issues.length) row.note = issues[0].code + ': ' + issues[0].message.slice(0, 60);
  let plots: any[] = [];
  try {
    const res = executeScript(parse(source), BARS as any, new Map());
    row.runtime = res.errors.length;
    if (res.errors.length && !row.note) row.note = 'runtime: ' + String((res.errors[0] as any).message ?? res.errors[0]).slice(0, 60);
    plots = res.plots as any[];
  } catch (e: any) {
    row.runtime = 1;
    row.note = 'threw: ' + String(e?.message || e).slice(0, 60);
  }
  const lines = plots.filter(p => p.type === 'line');
  const shapes = plots.filter(p => p.type === 'shape');
  const layers = plots.filter(p => p.type === 'plot3d');
  row.lines2d = lines.length;
  row.signals2d = shapes.length;
  row.layers3d = layers.length;
  row.shapes3d = plots.filter(p => p.type === 'plot3d_shape').length;
  row.labels3d = plots.filter(p => p.type === 'plot3d_label').length;
  row.bridged = new Set([
    ...layerTwins(layers, lines, 'main').map(t => t.name),
    ...layerTwins(layers, lines, 'separate').map(t => t.name),
  ]).size;
  row.constant = probeConstantLines(plots).length;
  row.clustered = probeSignalClustering(source).length;

  const drawsSomething = lines.length + shapes.length + layers.length + row.shapes3d > 0;
  if (row.validation > 0 || row.runtime > 0 || !drawsSomething) row.status = 'FAIL';
  else if (row.constant > 0 || row.clustered > 0) row.status = 'WARN';
  if (!drawsSomething && !row.note) row.note = 'draws nothing';
  return row;
}

const rows = getIndicators().map(d => auditOne(d.name, d.source));
const pad = (s: string | number, n: number) => String(s).slice(0, n).padEnd(n);
console.log(
  pad('status', 6) + pad('indicator', 46) + pad('val', 4) + pad('rt', 4) + pad('2D', 7) +
  pad('sig', 5) + pad('3D', 4) + pad('3Dsh', 6) + pad('3Dlbl', 7) + pad('bridged', 8) +
  pad('const', 6) + pad('clust', 6) + 'note',
);
for (const r of rows) {
  console.log(
    pad(r.status, 6) + pad(r.name, 46) + pad(r.validation, 4) + pad(r.runtime, 4) + pad(r.lines2d, 7) +
    pad(r.signals2d, 5) + pad(r.layers3d, 4) + pad(r.shapes3d, 6) + pad(r.labels3d, 7) + pad(r.bridged, 8) +
    pad(r.constant, 6) + pad(r.clustered, 6) + r.note,
  );
}
const count = (s: Row['status']) => rows.filter(r => r.status === s).length;
const bridgedTotal = rows.reduce((n, r) => n + r.bridged, 0);
const flat = rows.filter(r => r.constant > 0).length;
console.log(
  `\n${rows.length} indicators: ${count('OK')} OK · ${count('WARN')} WARN · ${count('FAIL')} FAIL · ` +
  `${bridgedTotal} 3D layers bridged into the 2D view · ${flat} indicators with flat reference layers`,
);
if (count('FAIL') > 0) process.exit(1);
