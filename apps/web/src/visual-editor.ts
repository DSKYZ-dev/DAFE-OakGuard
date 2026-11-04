/**
 * Visual Editor — live control over the unified 3D chart scene's look:
 * bloom, emissive (glow) intensity, fog, marker size/gap, Z-plane spacing,
 * grid/starfield, camera reset, and presets. Persists to localStorage and
 * applies through three-indicators' setChart3DVisualSettings().
 *
 * Why this exists: the 3D look used to be fixed constants in the renderer
 * (a bloom threshold above nearly every material's emissive), so scripts
 * could not look like the OakGuard Observatory no matter what they asked
 * for. Taste is now a user/compiler policy with knobs, not prompt prose.
 */
import {
  getChart3DVisualSettings, setChart3DVisualSettings, resetChart3DCamera,
  mark3DSceneDirty, type Chart3DVisualSettings,
} from './three-indicators';
import { raiseOnPress } from './window-frame';

const KEY = 'dafe_visual_editor_v1';
const FONT = "ui-monospace, Menlo, Consolas, monospace";

const PRESETS: Record<string, Partial<Chart3DVisualSettings>> = {
  crucible: { bloomStrength: 1.05, bloomThreshold: 0.24, emissiveScale: 2.1, markerScale: 1.1, markerGap: 1, fogDensity: 0.034, zSpacing: 2, showGrid: true, showStars: true, exposure: 1.55, barBrightness: 1.25, bgBrightness: 1.45 },
  professional: { bloomStrength: 0.7, bloomThreshold: 0.32, emissiveScale: 1.4, markerScale: 1, markerGap: 1, fogDensity: 0.02, zSpacing: 2, showGrid: true, showStars: false, exposure: 1.25, barBrightness: 1.1, bgBrightness: 1.1 },
  minimal: { bloomStrength: 0.35, bloomThreshold: 0.45, emissiveScale: 0.9, markerScale: 0.85, markerGap: 0.85, fogDensity: 0.008, zSpacing: 1.4, showGrid: true, showStars: false, exposure: 1.05, barBrightness: 1, bgBrightness: 0.9 },
};

function loadSaved(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) setChart3DVisualSettings(JSON.parse(raw));
  } catch { /* defaults */ }
}

/** Persist the current 3D look. Other panels (Settings → 3D Scene) call this
 * after patching so both controls write the same stored profile. */
export function saveVisualSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(getChart3DVisualSettings())); } catch { /* unavailable */ }
}

function save(): void { saveVisualSettings(); }

let panel: HTMLDivElement | null = null;

function slider(label: string, key: keyof Chart3DVisualSettings, min: number, max: number, step: number): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'rgba(210,230,255,0.8)', fontFamily: FONT });
  const name = document.createElement('span');
  name.textContent = label;
  Object.assign(name.style, { width: '92px', flexShrink: '0', letterSpacing: '0.05em' });
  const input = document.createElement('input');
  input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(getChart3DVisualSettings()[key] as number);
  input.dataset.key = key;
  Object.assign(input.style, { flex: '1', accentColor: '#6fd6ff', cursor: 'pointer' });
  const val = document.createElement('span');
  val.textContent = Number(input.value).toFixed(step < 0.01 ? 3 : 2);
  Object.assign(val.style, { width: '36px', textAlign: 'right', color: '#9be8ff' });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = v.toFixed(step < 0.01 ? 3 : 2);
    setChart3DVisualSettings({ [key]: v } as Partial<Chart3DVisualSettings>);
    save();
  });
  row.append(name, input, val);
  return row;
}

function toggle(label: string, key: 'showGrid' | 'showStars'): HTMLLabelElement {
  const row = document.createElement('label');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '10px', color: 'rgba(210,230,255,0.8)', fontFamily: FONT, cursor: 'pointer' });
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!getChart3DVisualSettings()[key];
  input.dataset.key = key;
  input.style.accentColor = '#6fd6ff';
  input.addEventListener('change', () => {
    setChart3DVisualSettings({ [key]: input.checked } as Partial<Chart3DVisualSettings>);
    save();
  });
  const span = document.createElement('span');
  span.textContent = label;
  row.append(input, span);
  return row;
}

export function refreshVisualEditorInputs(apply = false): void {
  if (!panel) return;
  const s = getChart3DVisualSettings();
  panel.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(inp => {
    const k = inp.dataset.key as keyof Chart3DVisualSettings;
    if (!k) return;
    inp.value = String(s[k] as number);
    const out = inp.parentElement?.querySelector<HTMLSpanElement>('span:last-child');
    if (out) out.textContent = Number(inp.value).toFixed(Number(inp.step) < 0.01 ? 3 : 2);
    if (apply) inp.dispatchEvent(new Event('input'));
  });
  panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(inp => {
    const k = inp.dataset.key as 'showGrid' | 'showStars';
    if (k === 'showGrid' || k === 'showStars') inp.checked = !!s[k];
  });
}

function refreshInputs(): void { refreshVisualEditorInputs(true); }

export function mountVisualEditor(): void {
  loadSaved();
  if (document.getElementById('visual-editor-btn')) return;
  const toolbar = document.getElementById('toolbar');
  const btn = document.createElement('button');
  btn.id = 'visual-editor-btn';
  btn.textContent = '🎛 Visuals';
  btn.title = 'Visual Editor — tune the 3D scene (bloom, glow, fog, markers, camera)';
  btn.addEventListener('click', () => toggleVisualEditor());
  if (toolbar) toolbar.appendChild(btn);
  else {
    Object.assign(btn.style, { position: 'fixed', right: '16px', bottom: '96px', zIndex: '4000' });
    document.body.appendChild(btn);
  }
}

export function toggleVisualEditor(): void {
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    return;
  }
  panel = document.createElement('div');
  panel.id = 'visual-editor-panel';
  panel.className = 'hud-window';
  Object.assign(panel.style, {
    position: 'fixed', right: '16px', bottom: '170px', zIndex: '4500', width: '300px',
    display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px',
    background: 'rgba(7,10,24,0.96)', border: '1px solid rgba(111,214,255,0.35)',
    borderRadius: '10px', boxShadow: '0 0 24px rgba(80,180,255,0.22)', backdropFilter: 'blur(10px)',
  });
  raiseOnPress(panel);
  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
  head.className = 'hud-head';
  const title = document.createElement('span');
  title.textContent = '🎛 VISUAL EDITOR · 3D SCENE';
  Object.assign(title.style, { fontSize: '11px', fontWeight: '800', letterSpacing: '0.1em', color: '#9be8ff', fontFamily: FONT });
  const close = document.createElement('button');
  close.textContent = '✕';
  Object.assign(close.style, { background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer' });
  close.addEventListener('click', () => { if (panel) panel.style.display = 'none'; });
  head.append(title, close);
  panel.appendChild(head);

  const presetRow = document.createElement('div');
  Object.assign(presetRow.style, { display: 'flex', gap: '6px' });
  for (const [name, preset] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name.toUpperCase();
    Object.assign(b.style, {
      flex: '1', padding: '5px 4px', fontSize: '9px', fontWeight: '800', letterSpacing: '0.08em',
      fontFamily: FONT, cursor: 'pointer', borderRadius: '5px',
      border: '1px solid rgba(111,214,255,0.35)', background: 'rgba(20,40,70,0.6)', color: '#bfe9ff',
    });
    b.addEventListener('click', () => { setChart3DVisualSettings(preset); save(); refreshInputs(); });
    presetRow.appendChild(b);
  }
  panel.appendChild(presetRow);

  const sceneHead = document.createElement('div');
  sceneHead.textContent = 'SCENE LIGHT';
  Object.assign(sceneHead.style, { fontSize: '9px', fontWeight: '800', letterSpacing: '0.16em', color: 'rgba(124,232,255,0.55)', fontFamily: FONT, marginTop: '2px' });
  const lookHead = document.createElement('div');
  lookHead.textContent = 'GEOMETRY';
  Object.assign(lookHead.style, { fontSize: '9px', fontWeight: '800', letterSpacing: '0.16em', color: 'rgba(124,232,255,0.55)', fontFamily: FONT, marginTop: '2px' });

  panel.append(
    sceneHead,
    slider('Scene exposure', 'exposure', 0.4, 2.4, 0.05),
    slider('Bar brightness', 'barBrightness', 0.3, 2.4, 0.05),
    slider('Background', 'bgBrightness', 0, 2.2, 0.05),
    slider('Bloom strength', 'bloomStrength', 0, 2, 0.05),
    slider('Bloom threshold', 'bloomThreshold', 0, 1, 0.02),
    slider('Glow (emissive)', 'emissiveScale', 0.2, 3, 0.1),
    lookHead,
    slider('Marker size', 'markerScale', 0.4, 2.5, 0.1),
    slider('Marker gap', 'markerGap', 0.4, 2.5, 0.1),
    slider('Fog density', 'fogDensity', 0, 0.08, 0.004),
    slider('Z spacing', 'zSpacing', 0.5, 4, 0.25),
  );
  const toggles = document.createElement('div');
  Object.assign(toggles.style, { display: 'flex', gap: '16px' });
  toggles.append(toggle('Starfield', 'showStars'), toggle('Grid floor', 'showGrid'));
  panel.appendChild(toggles);

  const cam = document.createElement('button');
  cam.textContent = '⌂ RESET CAMERA';
  Object.assign(cam.style, {
    padding: '6px', fontSize: '10px', fontWeight: '700', fontFamily: FONT, cursor: 'pointer',
    borderRadius: '5px', border: '1px solid rgba(111,214,255,0.35)', background: 'rgba(20,40,70,0.6)', color: '#bfe9ff',
  });
  cam.addEventListener('click', () => { resetChart3DCamera(); mark3DSceneDirty(); });
  panel.appendChild(cam);

  const note = document.createElement('div');
  note.textContent = 'Signal cones anchor to their bar index + price (bar-accurate). Series geometry is sliced to the visible window so it tracks the bars on scroll. Settings persist.';
  Object.assign(note.style, { fontSize: '9px', lineHeight: '1.5', color: 'rgba(160,190,230,0.6)', fontFamily: FONT });
  panel.appendChild(note);

  document.body.appendChild(panel);
}
