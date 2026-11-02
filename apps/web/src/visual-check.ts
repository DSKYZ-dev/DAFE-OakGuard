/**
 * Visual check — Muse Spark looks at the rendered chart.
 *
 * The validator and the oracles prove a script runs and its signals fire. They
 * cannot say whether the chart LOOKS like what the user asked for. This
 * captures every visible chart canvas (2D, 3D and the lower pane) into one
 * image and asks Muse Spark, with a JSON schema, which requested elements it
 * can see and which are missing. It is advisory: it never blocks an apply.
 */

const BACKEND = (): string => (window as any).__DAFE_BACKEND_URL || 'http://localhost:8788';

export interface VisualVerdict {
  ok: boolean;
  detail?: string;
  matches: boolean;
  seen: string[];
  missing: string[];
  problems: string[];
  summary: string;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  image?: string;
}

const VISUAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'seen', 'missing', 'problems', 'summary'],
  properties: {
    matches: { type: 'boolean', description: 'True when every element the request asks for is visibly rendered.' },
    seen: { type: 'array', items: { type: 'string' }, description: 'Requested elements you can see in the image.' },
    missing: { type: 'array', items: { type: 'string' }, description: 'Requested elements you cannot find in the image.' },
    problems: { type: 'array', items: { type: 'string' }, description: 'Rendering problems: overlapping labels, flat lines, markers off the bars, unreadable scale.' },
    summary: { type: 'string', description: 'One sentence for the user.' },
  },
};

/** Composite every visible chart canvas into one JPEG data URL (max 1280 px wide). */
export function captureChart(): string | null {
  const area = document.getElementById('chart-container') || document.body;
  const box = area.getBoundingClientRect();
  if (box.width < 50 || box.height < 50) return null;
  const scale = Math.min(1, 1280 / box.width);
  const out = document.createElement('canvas');
  out.width = Math.round(box.width * scale);
  out.height = Math.round(box.height * scale);
  const g = out.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#0a0a18';
  g.fillRect(0, 0, out.width, out.height);
  const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => {
    if (c.closest('#oakguard-window')) return false;
    const r = c.getBoundingClientRect();
    const style = getComputedStyle(c);
    return r.width > 40 && r.height > 40 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.05
      && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
  });
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    try {
      g.drawImage(c, (r.left - box.left) * scale, (r.top - box.top) * scale, r.width * scale, r.height * scale);
    } catch { /* a tainted canvas is skipped */ }
  }
  return out.toDataURL('image/jpeg', 0.82);
}

/** Titles a script declares for plots and markers, so the model can name what it sees. */
function declaredTitles(source: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:plot|plot3d|plotshape|plotshape_3d|hline)\s*\([^,]+,\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return [...out].slice(0, 30);
}

export async function visualCheck(request: string, source: string): Promise<VisualVerdict> {
  const image = captureChart();
  const empty: VisualVerdict = { ok: false, matches: false, seen: [], missing: [], problems: [], summary: '' };
  if (!image) return { ...empty, detail: 'The chart is not visible, so there is nothing to look at.' };
  const titles = declaredTitles(source);
  const system = 'You check trading charts. You are shown a screenshot of a charting app and the request an indicator was written for. Judge only what is visibly rendered in the image, not what the code intends. Be strict: an element counts as seen only if you can point to it.';
  const user = [
    `REQUEST: "${request}"`,
    titles.length ? `The script names its plots and markers: ${titles.join(', ')}.` : '',
    'Which elements the request asks for are visible in this chart, which are missing, and are there rendering problems?',
  ].filter(Boolean).join('\n');
  try {
    const r = await fetch(`${BACKEND()}/api/meta/structured`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'muse-spark-1.3', system, user, image,
        schema: VISUAL_SCHEMA, schema_name: 'visual_check', reasoning_effort: 'low', max_tokens: 3000,
      }),
    });
    const d = await r.json();
    if (!d.ok) return { ...empty, detail: d.detail || `HTTP ${r.status}`, image };
    const v = JSON.parse(d.content);
    return {
      ok: true,
      matches: !!v.matches,
      seen: Array.isArray(v.seen) ? v.seen.map(String) : [],
      missing: Array.isArray(v.missing) ? v.missing.map(String) : [],
      problems: Array.isArray(v.problems) ? v.problems.map(String) : [],
      summary: String(v.summary || ''),
      model: d.model,
      latencyMs: d.latency_ms,
      costUsd: d.cost_usd,
      image,
    };
  } catch {
    return { ...empty, detail: 'The backend is not reachable, so the visual check is unavailable.', image };
  }
}
