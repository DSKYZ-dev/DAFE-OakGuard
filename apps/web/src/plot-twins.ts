/**
 * 2D twins for 3D layers. A script may draw a series only in 3D (plot3d) or a
 * marker only in 3D (plotshape_3d). In the 2D view those would be blank, so each
 * one the script does not already draw in 2D gets a 2D twin here. The same rule
 * serves the chart and the audit, so both agree on what 2D shows.
 */
import type { OakPlot, OakPlot3D } from './oakscript/runtime';

export type TwinPane = 'main' | 'separate';

/** A 2D line on the same pane already draws this layer: same name, or the same latest value. */
function linesShowLayer(layer: OakPlot3D, lines: OakPlot[]): boolean {
  if (lines.some(l => l.name === layer.name)) return true;
  let last = -1;
  for (let i = layer.series.length - 1; i >= 0; i--) {
    if (Number.isFinite(layer.series[i])) { last = i; break; }
  }
  if (last < 0) return true;
  const v = layer.series[last];
  return lines.some(l => l.barIdx === last && Math.abs((l.value as number) - v) < 1e-9);
}

/** 2D line records for every 3D layer that the 2D lines do not already show. */
export function layerTwins(layers: OakPlot3D[], lines: OakPlot[], pane: TwinPane): OakPlot[] {
  const out: OakPlot[] = [];
  for (const layer of layers) {
    if (linesShowLayer(layer, lines)) continue;
    const style = pane === 'main' && layer.style === 'line3d' ? 'stepline' : 'line';
    const color = typeof layer.color === 'string' ? layer.color : pane === 'main' ? '#22aaff' : '#38d0ff';
    for (let bi = 0; bi < layer.series.length; bi++) {
      const v = layer.series[bi];
      if (!Number.isFinite(v)) continue;
      out.push({
        type: 'line',
        name: layer.name || (pane === 'main' ? 'Level' : 'Series'),
        barIdx: bi,
        value: v,
        color,
        linewidth: 1.5,
        style,
        pane,
      } as OakPlot);
    }
  }
  return out;
}

/** 2D marker records for every 3D marker whose bar has no 2D marker yet. */
export function shapeTwins(shapes3d: OakPlot[], shapes2d: OakPlot[]): OakPlot[] {
  const marked = new Set(shapes2d.filter(s => s.type === 'shape').map(s => s.barIdx));
  const out: OakPlot[] = [];
  for (const sp of shapes3d) {
    if (sp.type !== 'plot3d_shape' || marked.has(sp.barIdx)) continue;
    const isSell = sp.shape3d === 'conedown';
    out.push({
      type: 'shape',
      name: sp.name || '',
      barIdx: sp.barIdx,
      price: sp.price,
      color: sp.color || (isSell ? '#ff4477' : '#22cc88'),
      style: isSell ? 'triangledown' : 'triangleup',
      pane: 'main',
    } as OakPlot);
  }
  return out;
}
