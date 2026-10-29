/**
 * Universal Metrics Adapter — the single source of data for the adaptive
 * Dashboard band.
 *
 * Contract: ANY script, user-authored or library, emits plots through the
 * OakScript runtime. The adapter reads those plots (plus alerts, tables and
 * labels when present) and derives a normalized metric set — the script
 * never declares "I have a dashboard" and never draws one itself. If a
 * script produces ANY observable output, it produces dashboard metrics.
 *
 * Metric derivation (per indicator, per bar-run):
 *   - line plots (main + separate panes) → latest values, per-name,
 *     deduped to the most recent bar (plot() pushes once per bar).
 *   - hline levels → static reference levels.
 *   - shapes → live signal state (long/short/last signal age) + counts.
 *   - bgcolor/fill → regime/state coloring.
 *   - table cells + labels → explicit readouts (the ONLY script-side hint
 *     the adapter consumes; a script that builds tables gets them shown
 *     as formatted metric rows, not free-floating canvas drawings).
 *   - plot3d → 3D series presence (value + style), kept lightweight.
 *
 * Everything is sorted into a stable display order and each indicator gets
 * a `hasMetrics` verdict that drives BOTH the dashboard band's content and
 * the parameter menu's automatic dashboard toggle — no OakScript code can
 * or needs to opt in.
 */

import type { OakPlot } from '../../web/src/oakscript/runtime';

export interface MetricRow {
  label: string;
  value: string;
  color?: string;       // value color (defaults themed)
  bg?: string;         // chip background override
  hint?: string;        // long-press/title text
  emphasis?: 'none' | 'up' | 'down' | 'neutral'; // signal-ish rows get emphasis
}

export interface IndicatorMetrics {
  id: string;
  name: string;
  enabled: boolean;
  rows: MetricRow[];
  signal: 'long' | 'short' | 'none';
  hasMetrics: boolean;
}

export interface AdapterInput {
  indicators: Array<{
    id: string;
    name: string;
    enabled: boolean;
    plots: OakPlot[];
    errors?: string[];
  }>;
}

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toExponential(1);
};

/** Latest value per named line series (plot() fires per bar — last wins). */
function latestLines(plots: OakPlot[]): MetricRow[] {
  const latest = new Map<string, OakPlot>();
  for (const p of plots) {
    if (p.type !== 'line') continue;
    const n = (p.name || '').trim();
    if (!n) continue;
    // barIdx ordering: later entries in the array are later bars, so a plain
    // overwrite in iteration order keeps the newest value per name.
    latest.set(n, p);
  }
  const rows: MetricRow[] = [];
  for (const [name, p] of latest) {
    const v = typeof p.value === 'number' ? p.value : NaN;
    rows.push({ label: name, value: fmt(v), color: p.color, hint: `${name} = ${v}` });
  }
  return rows;
}

/** Static reference levels (hline) — deduped by price+color. */
function levels(plots: OakPlot[]): MetricRow[] {
  const seen = new Map<string, OakPlot>();
  for (const p of plots) {
    if (p.type !== 'hline') continue;
    const v = typeof p.price === 'number' ? p.price : NaN;
    if (!Number.isFinite(v)) continue;
    seen.set(`${v.toFixed(4)}|${p.color || ''}`, p);
  }
  const rows: MetricRow[] = [];
  for (const p of seen.values()) {
    rows.push({ label: p.name || 'Level', value: (p.price as number).toFixed(2), color: p.color, hint: 'Reference level' });
  }
  return rows;
}

/** Live signal state from shapes (triangleup/down etc.). */
function signalState(plots: OakPlot[]): { row?: MetricRow; signal: 'long' | 'short' | 'none'; counts?: MetricRow } {
  const shapes = plots.filter(p => p.type === 'shape');
  if (shapes.length === 0) return { signal: 'none' };
  // Newest shape by barIdx wins; count longs/shorts across the visible run.
  let last: OakPlot | null = null;
  let lastIdx = -1;
  let longs = 0, shorts = 0;
  for (const s of shapes) {
    const style = (s.style || '').toLowerCase();
    const idx = typeof s.barIdx === 'number' ? s.barIdx : 0;
    if (idx >= lastIdx) { lastIdx = idx; last = s; }
    if (style.includes('up') || style.includes('triangleup')) longs++;
    else if (style.includes('down') || style.includes('triangledown')) shorts++;
  }
  const style = (last?.style || '').toLowerCase();
  const isLong = style.includes('up');
  const isShort = style.includes('down');
  const signal: 'long' | 'short' | 'none' = isLong ? 'long' : isShort ? 'short' : 'none';
  const row: MetricRow | undefined = signal !== 'none' ? {
    label: 'Signal',
    value: signal === 'long' ? '▲ LONG' : '▼ SHORT',
    color: signal === 'long' ? 'var(--green)' : 'var(--red)',
    emphasis: signal === 'long' ? 'up' : 'down',
    hint: `Last ${signal} @ bar ${lastIdx}`,
  } : undefined;
  const counts: MetricRow | undefined = (longs + shorts) > 0 ? {
    label: 'Signals',
    value: `${longs}▲ / ${shorts}▼`,
    hint: 'Historical signal counts this run',
  } : undefined;
  return { row, signal, counts };
}

/** Explicit readouts — table cells + labels (script-authored readouts). */
function explicitReadouts(plots: OakPlot[]): MetricRow[] {
  const rows: MetricRow[] = [];
  const seen = new Set<string>();
  for (const p of plots) {
    if (p.type === 'table' && Array.isArray(p.cells)) {
      for (const row of p.cells as any[][]) {
        for (const cell of row) {
          if (cell == null || typeof cell !== 'object') continue;
          const text = String(cell.text ?? '').trim();
          if (!text || seen.has(text)) continue;
          seen.add(text);
          rows.push({ label: '', value: text.slice(0, 48), bg: cell.bgColor, color: cell.textColor });
        }
      }
    } else if (p.type === 'label' && typeof p.text === 'string' && p.text.trim()) {
      const text = p.text.trim();
      if (!seen.has(text)) {
        seen.add(text);
        rows.push({ label: '', value: text.slice(0, 48), color: p.color });
      }
    }
  }
  return rows.slice(0, 12);
}

/** 3D series presence (lightweight: value + style). */
function three(plots: OakPlot[]): MetricRow[] {
  const rows: MetricRow[] = [];
  const seen = new Set<string>();
  for (const p of plots) {
    if (p.type !== 'plot3d') continue;
    const key = `${p.name}|${(p as any).style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const series = (p as any).series as number[] | undefined;
    const last = series && series.length ? series[series.length - 1] : undefined;
    rows.push({
      label: `${p.name} (${(p as any).style || '3d'})`,
      value: typeof last === 'number' && Number.isFinite(last) ? fmt(last) : 'live',
      color: p.color,
      hint: '3D series — renders in the Three.js pane',
    });
  }
  return rows.slice(0, 6);
}

/** Regime/state from background fills — newest fill's color tells the state. */
function regime(plots: OakPlot[]): MetricRow[] {
  const fills = plots.filter(p => p.type === 'bgcolor' || p.type === 'fill');
  if (fills.length === 0) return [];
  const last = fills[fills.length - 1];
  const c = (last.color || '').toLowerCase();
  // Theme-agnostic verdicts: red-ish = volatile/bearish, green-ish = calm/bull.
  const isRed = c.includes('255,0,110') || c.includes('255, 0, 110') || c.includes('#ff006e') || c.includes('#ff4477');
  const isGreen = c.includes('0,255,136') || c.includes('0, 255, 136') || c.includes('#00ff88') || c.includes('#22cc88');
  if (!isRed && !isGreen) return [];
  return [{
    label: 'State',
    value: isRed ? 'VOLATILE' : 'TRENDING',
    color: isRed ? 'var(--red)' : 'var(--green)',
    emphasis: isRed ? 'down' : 'up',
    hint: 'Derived from the script\'s most recent background fill',
  }];
}

/**
 * Derive the full metric set for every indicator. Pure function — safe to
 * call on every dashboard refresh tick.
 */
export function deriveMetrics(input: AdapterInput): IndicatorMetrics[] {
  const out: IndicatorMetrics[] = [];
  for (const ind of input.indicators) {
    if (!ind.enabled) {
      out.push({ id: ind.id, name: ind.name, enabled: false, rows: [], signal: 'none', hasMetrics: false });
      continue;
    }
    const plots = ind.plots || [];
    const rows: MetricRow[] = [];
    const sig = signalState(plots);
    if (sig.row) rows.push(sig.row);
    rows.push(...regime(plots));
    rows.push(...latestLines(plots));
    rows.push(...levels(plots));
    rows.push(...explicitReadouts(plots));
    rows.push(...three(plots));
    if (sig.counts) rows.push(sig.counts);
    if (ind.errors && ind.errors.length > 0) {
      rows.push({ label: '⚠', value: `${ind.errors.length} error${ind.errors.length > 1 ? 's' : ''}`, color: 'var(--red)' });
    }
    out.push({
      id: ind.id,
      name: ind.name,
      enabled: true,
      rows,
      signal: sig.signal,
      hasMetrics: rows.length > 0,
    });
  }
  return out;
}
