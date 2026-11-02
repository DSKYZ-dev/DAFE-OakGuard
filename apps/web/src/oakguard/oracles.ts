/**
 * OakGuard runtime oracles — the evidence that a script is broken, gathered by
 * running it, not by reading it. A static rule is only worth promoting if it
 * predicts what these oracles find.
 *
 *   dead-output   a plotted line is mostly NaN, or holds one constant value
 *   dead-signal   a marker the script declares never fires on 2,400 bars
 *                 across a rising, a falling, a sideways and a volatile market
 *   runtime-error the interpreter reports an error
 */
import { parse } from '../oakscript/parser';
import { executeScript } from '../oakscript/interpreter';
import { mulberry32, syntheticBars, syntheticTrendBars, type SyntheticBarSet } from './mutants';

export type OracleKind = 'dead-output' | 'dead-signal' | 'runtime-error';

export interface OracleFinding {
  kind: OracleKind;
  target: string;
  detail: string;
}

export interface OracleReport {
  findings: OracleFinding[];
  /** Marker title → fires per regime. */
  markers: Record<string, number[]>;
  /** Line plot title → finite ratio on the sideways regime. */
  lines: Record<string, number>;
  bars: number;
}

export interface Regime { label: string; bars: SyntheticBarSet }

let regimeCache: Regime[] | null = null;

/** Calm and stormy blocks of 100 bars, so volatility-expansion signals have something to find. */
function volatilityShockBars(count: number, seed: number): SyntheticBarSet {
  const rnd = mulberry32(seed);
  const close: number[] = [], open: number[] = [], high: number[] = [], low: number[] = [], volume: number[] = [], time: number[] = [];
  let px = 100;
  for (let i = 0; i < count; i++) {
    const noise = Math.floor(i / 100) % 2 === 0 ? 0.004 : 0.04;
    const o = px;
    const c = Math.max(1, o * (1 + (rnd() - 0.5) * noise));
    close.push(c); open.push(o);
    high.push(Math.max(o, c) + o * noise * 0.5 * rnd());
    low.push(Math.min(o, c) - o * noise * 0.5 * rnd());
    volume.push(1000 + Math.floor(rnd() * 5000 * (noise > 0.01 ? 3 : 1)));
    time.push(1700000000000 + i * 60000);
    px = c;
  }
  return { close, open, high, low, volume, time, count };
}

/** Four fixed markets, 600 bars each. Deterministic: same bars on every machine. */
export function oracleRegimes(): Regime[] {
  if (!regimeCache) {
    regimeCache = [
      { label: 'rising', bars: syntheticTrendBars(600, 0.003, 0.02, 7) },
      { label: 'falling', bars: syntheticTrendBars(600, -0.003, 0.02, 11) },
      { label: 'sideways', bars: syntheticBars(600) },
      { label: 'volatile', bars: volatilityShockBars(600, 23) },
    ];
  }
  return regimeCache;
}

/** Marker titles the source declares as string literals (plotshape / plotshape_3d third argument). */
export function declaredMarkers(source: string): string[] {
  const out = new Set<string>();
  const re = /\bplotshape(?:_3d)?\s*\(\s*[^,]+,\s*[^,]+,\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return [...out];
}

/** Line plot titles the source declares as string literals. */
function declaredLines(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[^\w.])plot\s*\(\s*[^,]+,\s*"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return [...out];
}

export function runOracles(source: string): OracleReport {
  const findings: OracleFinding[] = [];
  const markers: Record<string, number[]> = {};
  const lines: Record<string, number> = {};
  const regimes = oracleRegimes();
  const wantMarkers = declaredMarkers(source);
  const wantLines = declaredLines(source);
  for (const t of wantMarkers) markers[t] = [];

  let ast;
  try {
    ast = parse(source);
  } catch (e: any) {
    findings.push({ kind: 'runtime-error', target: 'parse', detail: String(e?.message || e).slice(0, 160) });
    return { findings, markers, lines, bars: 0 };
  }

  for (const regime of regimes) {
    let plots: any[] = [];
    try {
      const result = executeScript(ast, regime.bars as any, new Map());
      plots = result.plots as any[];
      if (result.errors.length > 0 && !findings.some(f => f.kind === 'runtime-error')) {
        findings.push({ kind: 'runtime-error', target: regime.label, detail: result.errors.slice(0, 2).join('; ').slice(0, 160) });
      }
    } catch (e: any) {
      if (!findings.some(f => f.kind === 'runtime-error')) {
        findings.push({ kind: 'runtime-error', target: regime.label, detail: String(e?.message || e).slice(0, 160) });
      }
      continue;
    }
    for (const t of wantMarkers) {
      markers[t].push(plots.filter(p => (p.type === 'shape' || p.type === 'plot3d_shape') && p.name === t).length);
    }
    if (regime.label === 'sideways') {
      for (const t of wantLines) {
        const points = plots.filter(p => p.type === 'line' && p.name === t);
        const vals = points.map(p => p.value);
        if (vals.length === 0) continue;
        const finite = vals.filter(v => typeof v === 'number' && Number.isFinite(v)) as number[];
        lines[t] = finite.length / vals.length;
        // Dot styles are how sparse series (pivots) are meant to be drawn, so
        // only a line that is never finite counts as dead there.
        const dots = points.some(p => p.style === 'circles' || p.style === 'cross');
        if (finite.length / vals.length < (dots ? 1e-9 : 0.5)) {
          findings.push({ kind: 'dead-output', target: t, detail: `line "${t}" is finite on ${Math.round((100 * finite.length) / vals.length)}% of ${vals.length} bars` });
        } else if (finite.length >= 2 && Math.max(...finite) - Math.min(...finite) < 1e-9) {
          findings.push({ kind: 'dead-output', target: t, detail: `line "${t}" holds the constant ${finite[0]} on every bar` });
        }
      }
    }
  }

  const total = regimes.reduce((n, r) => n + r.bars.count, 0);
  for (const t of wantMarkers) {
    const counts = markers[t];
    if (counts.length === regimes.length && counts.every(c => c === 0)) {
      findings.push({ kind: 'dead-signal', target: t, detail: `marker "${t}" fired 0 times on ${total} bars (${regimes.map(r => r.label).join(', ')})` });
    }
  }
  return { findings, markers, lines, bars: total };
}

/** One-line summary for logs and prompts. */
export function describeFindings(report: OracleReport): string {
  if (report.findings.length === 0) return 'no runtime defect found';
  return report.findings.map(f => f.detail).join('; ');
}
