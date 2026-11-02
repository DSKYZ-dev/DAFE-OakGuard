/**
 * Regime strip — the desktop Regime Ribbon, reduced to a thin read-only line.
 *
 * Classification, hysteresis, labels and colours come from the desktop module,
 * computed from the bars the chart already holds. The strip is advisory: it has
 * no suggestion buttons and ignores pointer input, so chart touches pass through.
 */
import {
  applyHysteresis, classifyRegime, createInitialRegimeState,
  REGIME_COLORS, REGIME_LABELS, type RegimeResult,
} from '../../web/src/regime-ribbon';

const RECOMPUTE_MS = 3000;

export interface RegimeStrip {
  el: HTMLDivElement;
  update: (bars: readonly { high: number; low: number; close: number }[], now: number) => void;
}

export function createRegimeStrip(): RegimeStrip {
  const el = document.createElement('div');
  el.id = 'regime-strip';
  el.style.cssText = 'display:none;flex-shrink:0;align-items:center;gap:8px;height:18px;padding:0 10px;font:10px monospace;color:rgba(255,255,255,0.75);background:rgba(12,12,28,0.7);border-bottom:1px solid rgba(180,140,255,0.08);pointer-events:none;user-select:none;overflow:hidden;white-space:nowrap;';

  const dot = document.createElement('span');
  dot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;';
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:700;letter-spacing:0.5px;';
  const detail = document.createElement('span');
  detail.style.color = 'rgba(255,255,255,0.4)';
  const advisory = document.createElement('span');
  advisory.textContent = 'advisory';
  advisory.title = 'Regime Ribbon never applies anything automatically.';
  advisory.style.cssText = 'color:rgba(255,255,255,0.25);font-size:9px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;padding:0 4px;';
  el.append(dot, label, detail, advisory);

  const hysteresis = createInitialRegimeState();
  let lastComputeAt = Number.NEGATIVE_INFINITY;

  function paint(r: RegimeResult): void {
    const color = REGIME_COLORS[r.regime];
    el.style.display = 'flex';
    dot.style.background = color;
    dot.style.boxShadow = `0 0 5px ${color}`;
    label.textContent = REGIME_LABELS[r.regime];
    label.style.color = color;
    detail.textContent = `${Math.round(r.confidence * 100)}% · ADX ${r.adx.toFixed(0)} · ATR×${r.atrRatio.toFixed(2)}`;
  }

  function update(bars: readonly { high: number; low: number; close: number }[], now: number): void {
    if (now - lastComputeAt < RECOMPUTE_MS) return;
    lastComputeAt = now;
    const fresh = bars.length
      ? classifyRegime(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close))
      : null;
    if (!fresh) { el.style.display = 'none'; return; }
    paint(applyHysteresis(hysteresis, fresh, now));
  }

  return { el, update };
}
