/**
 * Advanced 3D Indicator Visualizations Engine
 * Powers OakScript plot3d("main") — realistic 3D geometries overlaid on the chart.
 * Styles: surface, ribbon, scatter, bars3d, wireframe, line3d, mesh,
 *         helix, vortex, manifold, nebula, constellation, torus, trail, ridgeline
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { BaseBar } from '@dafe/types';
import type { OakPlot, OakPlot3D } from './oakscript/runtime';
import { makeTextSprite } from './three-lower-pane';
import { type ViewState, getVisibleRange, barX, priceToY, chartRight, TOP_FRAC, BOT_FRAC } from './chart-renderer';
import { resolveImage } from './image-cache';

export type VizType = 'surface' | 'ribbon' | 'scatter' | 'wireframe' | 'bars3d' | 'line3d' | 'mesh'
  | 'helix' | 'vortex' | 'manifold' | 'nebula' | 'constellation' | 'torus' | 'trail';

const CANVAS_ID = 'three-viz-canvas';

let _renderer: THREE.WebGLRenderer | null = null;
let _scene: THREE.Scene | null = null;
let _camera: THREE.PerspectiveCamera | null = null;
let _composer: EffectComposer | null = null;
let _bloomPass: UnrealBloomPass | null = null;
let _activeViz: VizType = 'surface';
let _initialized = false;
let _renderTime = 0;

// ─── Bloom post-processing + Visual Editor settings ─────────────
// Every scene here is built from MeshPhongMaterial with emissive colors —
// authored for glow that was never actually rendered. UnrealBloomPass adds
// it. These values are LIVE-TUNABLE from the Visual Editor module
// (visual-editor.ts) — the old fixed threshold (0.6) sat above almost
// every material's emissive intensity (0.2–0.5), so almost nothing bloomed
// and 3D indicators looked flat next to the OakGuard Observatory.
export interface Chart3DVisualSettings {
  bloomStrength: number;
  bloomThreshold: number;
  emissiveScale: number;
  markerScale: number;
  markerGap: number;
  fogDensity: number;
  zSpacing: number;
  showGrid: boolean;
  showStars: boolean;
}

const _vis: Chart3DVisualSettings = {
  bloomStrength: 0.9, bloomThreshold: 0.28, emissiveScale: 1.6,
  markerScale: 1, markerGap: 1, fogDensity: 0.03, zSpacing: 2,
  showGrid: true, showStars: true,
};

let _gridHelper: THREE.GridHelper | null = null;
let _starfield: THREE.Points | null = null;

export function getChart3DVisualSettings(): Chart3DVisualSettings { return { ..._vis }; }

export function setChart3DVisualSettings(patch: Partial<Chart3DVisualSettings>): void {
  Object.assign(_vis, patch);
  if (_bloomPass) { _bloomPass.strength = _vis.bloomStrength; _bloomPass.threshold = _vis.bloomThreshold; }
  if (_scene) _scene.fog = new THREE.FogExp2(0x05070f, _vis.fogDensity);
  if (_gridHelper) _gridHelper.visible = _vis.showGrid;
  if (_starfield) _starfield.visible = _vis.showStars;
  mark3DSceneDirty();
}

export function resetChart3DCamera(): void {
  _orbitTheta = -0.16; _orbitPhi = 1.24; _orbitDist = 14;
  _orbitTarget.set(0, 0, 0);
  applyOrbitCam();
  renderFrame();
}

function setupComposer(w: number, h: number): void {
  if (!_renderer || !_scene || !_camera) return;
  _composer = new EffectComposer(_renderer);
  _composer.addPass(new RenderPass(_scene, _camera));
  _bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), _vis.bloomStrength, 0.45, _vis.bloomThreshold);
  _composer.addPass(_bloomPass);
  _composer.addPass(new OutputPass());
}

function resizeComposer(w: number, h: number): void {
  _composer?.setSize(w, h);
  _bloomPass?.setSize(w, h);
}

function renderFrame(): void {
  if (_composer) { _composer.render(); return; }
  if (_renderer && _scene && _camera) _renderer.render(_scene, _camera);
}

export function setVizType(t: VizType) { _activeViz = t; }
export function getVizType(): VizType { return _activeViz; }
// Legacy overlay-3D state only — excludes unified chart3D mode (tracked by
// isChart3DMode()/_chart3DMode). Both modes share the same renderer/scene/
// camera globals, so without this exclusion, main.ts's legacy-viz cleanup
// (`if (isViz3DActive()) disposeViz()`) wrongly tore down a freshly-built
// chart3D scene on the very next check — disposeViz() doesn't reset orbit
// state, so the camera's pointer handlers never got re-attached on rebuild,
// silently killing rotate/zoom.
export function isViz3DActive(): boolean { return _initialized && !!_scene && !_chart3DMode; }
export function getRenderTime(): number { return _renderTime; }

function getCanvas(): HTMLCanvasElement {
  let c = document.getElementById(CANVAS_ID) as HTMLCanvasElement;
  if (!c) {
    c = document.createElement('canvas');
    c.id = CANVAS_ID;
    Object.assign(c.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      zIndex: '10', pointerEvents: 'none',
    });
    const container = document.getElementById('chart-canvas')?.parentElement;
    if (container) container.appendChild(c);
  }
  return c;
}

// ─── Content-fit framing ───────────────────────────────────────────
// Scene geometry is normalized to a fixed world-space span (buildBarGroup
// maps bar index to roughly x in [-5, 5]) regardless of container size.
// Framing history: a fixed vertical FOV strands that content in a narrow
// centered strip on wide windows; pinning the HORIZONTAL FOV instead (the
// previous approach) fills the width but crushes the vertical FOV at high
// aspect ratios, cropping tall content. The robust model, applied after
// each chart-3D rebuild: (1) stretch content x so its box matches the
// viewport aspect (bars spread out; text sprites are counter-scaled so
// glyphs keep their designed aspect), then (2) on CONTENT-identity change
// only, refit the orbit distance/target to the resulting box — filling
// both axes with no cropping, while user orbiting stays authoritative
// during pans of the same indicator.
const BASE_FOV_DEG = 45;
// Gentle — spreads bar spacing on wide windows without visibly distorting
// curved geometry (helix/vortex/torus layers).
const X_STRETCH_CLAMP: [number, number] = [0.85, 1.8];
let _lastMainFitSig: string | null = null;

// The instrument frame is content, not scenery: it stretches with the bars.
function isSceneDecoration(obj: THREE.Object3D): boolean {
  return obj instanceof THREE.Light || obj instanceof THREE.GridHelper || obj === _starfield || obj instanceof THREE.Points;
}

function mainContentBox(): THREE.Box3 | null {
  if (!_scene) return null;
  const box = new THREE.Box3();
  let has = false;
  for (const child of _scene.children) {
    if (isSceneDecoration(child)) continue;
    box.expandByObject(child);
    has = true;
  }
  return has && !box.isEmpty() ? box : null;
}

/** Stretch main-scene content along X by k. Idempotent: each object keeps its
 *  unstretched base transform and is set from it on every call. The old
 *  multiply compounded on persisting objects (the candle group), so candles
 *  drifted wider than freshly built indicator lines. */
function stretchMainContentX(k: number): void {
  if (!_scene) return;
  for (const child of _scene.children) {
    if (isSceneDecoration(child)) continue;
    const base = child.userData as { baseX?: number; baseSX?: number };
    if (base.baseX === undefined) { base.baseX = child.position.x; base.baseSX = child.scale.x; }
    child.position.x = (base.baseX as number) * k;
    if (child instanceof THREE.Sprite) continue;
    child.scale.x = (base.baseSX as number) * k;
    child.traverse(o => {
      if (o === child || !(o instanceof THREE.Sprite)) return;
      const sb = o.userData as { baseSX?: number };
      if (sb.baseSX === undefined) sb.baseSX = o.scale.x;
      o.scale.x = (sb.baseSX as number) / k;
    });
  }
}

function fitAndStretchMainScene(contentSig: string): void {
  if (!_scene || !_camera) return;
  const aspect = _camera.aspect;
  stretchMainContentX(1);
  const box = mainContentBox();
  if (!box) return;
  const size = box.getSize(new THREE.Vector3());
  if (size.x > 0.001 && size.y > 0.001) {
    const k = Math.max(X_STRETCH_CLAMP[0], Math.min(X_STRETCH_CLAMP[1], (size.y * aspect) / size.x));
    stretchMainContentX(k);
  }
  if (contentSig === _lastMainFitSig) return;
  _lastMainFitSig = contentSig;
  const fitted = mainContentBox();
  if (!fitted) return;
  // Box-face fit + bounded depth margin — fills the frame while keeping the
  // tilted orbit camera outside the content's front face.
  const s = fitted.getSize(new THREE.Vector3());
  const center = fitted.getCenter(new THREE.Vector3());
  const vHalf = (_camera.fov * Math.PI / 180) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const dV = (s.y / 2) / Math.tan(vHalf);
  const dH = (s.x / 2) / Math.tan(hHalf);
  _orbitDist = Math.max(8, Math.min(20, Math.max(dV, dH) * 1.12 + Math.min(s.z, 3) * 0.5));
  _orbitTarget.copy(center);
  applyOrbitCam();
}

function init(): void {
  if (_initialized) return;
  const canvas = getCanvas();
  const w = canvas.parentElement?.clientWidth || window.innerWidth;
  const h = canvas.parentElement?.clientHeight || window.innerHeight;
  canvas.width = w; canvas.height = h;
  _renderTime = performance.now();

  _renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  _renderer.setSize(w, h, false);
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  _renderer.toneMapping = THREE.ACESFilmicToneMapping;
  _renderer.toneMappingExposure = 1.0;

  _scene = new THREE.Scene();
  _scene.background = null;
  _scene.fog = new THREE.FogExp2(0x05070f, _vis.fogDensity);

  // In-scene starfield (the 3D takeover used to hide the 2D one behind an
  // opaque clear color, losing the deep-space cue entirely).
  {
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(700 * 3);
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 700; i++) {
      const r = 26 + rnd() * 50;
      const a = rnd() * Math.PI * 2;
      starPos[i * 3] = Math.cos(a) * r;
      starPos[i * 3 + 1] = (rnd() - 0.35) * 36;
      starPos[i * 3 + 2] = Math.sin(a) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    _starfield = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8fb8ff, size: 0.13, transparent: true, opacity: 0.7, fog: false }));
    _starfield.visible = _vis.showStars;
    _scene.add(_starfield);
  }

  _camera = new THREE.PerspectiveCamera(BASE_FOV_DEG, w / Math.max(h, 1), 0.1, 1000);
  _camera.position.set(0, 6, 18);
  _camera.lookAt(0, 0, 0);

  _scene.add(new THREE.AmbientLight(0x404060, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(8, 12, 6);
  _scene.add(dir);
  const fill = new THREE.DirectionalLight(0x4488ff, 0.4);
  fill.position.set(-4, 2, -6);
  _scene.add(fill);

  const grid = new THREE.GridHelper(24, 20, 0x333366, 0x1a1a33);
  grid.visible = _vis.showGrid;
  _gridHelper = grid;
  _scene.add(grid);

  setupComposer(w, h);

  _initialized = true;
}

export function disposeViz(): void {
  _composer?.dispose();
  _composer = null; _bloomPass = null;
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  _scene = null; _camera = null; _initialized = false;
  const c = document.getElementById(CANVAS_ID);
  if (c) c.remove();
}

// ─── Geometry helpers ──────────────────────────────────────────────

function visibleBars(bars: BaseBar[], view: ViewState, width: number): BaseBar[] {
  const { start, end } = getVisibleRange(view, width, bars.length);
  return bars.slice(Math.max(0, start), Math.min(bars.length, end + 1));
}

function normRange(visible: BaseBar[]): { min: number; max: number; range: number } {
  const prices = visible.flatMap(b => [b.high, b.low]);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return { min, max, range: max - min || 1 };
}

function barXNorm(i: number, total: number, width: number, view: ViewState): number {
  const halfW = width * 0.5;
  const px = barX(i, total, width, view.barSpacing, view.scrollX);
  return ((px - halfW) / halfW) * 5;
}

function clearViz(): void {
  if (!_scene) return;
  const toRemove: THREE.Object3D[] = [];
  for (const child of _scene.children) {
    if (child instanceof THREE.AmbientLight || child instanceof THREE.DirectionalLight || child instanceof THREE.GridHelper) continue;
    if (_barGroup && child === _barGroup) continue;
    if (_starfield && child === _starfield) continue;
    toRemove.push(child);
  }
  for (const child of toRemove) { disposeMesh(child); _scene.remove(child); }
}

function disposeMesh(obj: THREE.Object3D): void {
  // Check for geometry/material by shape, not by `instanceof THREE.Mesh` —
  // Line/LineSegments/Points (used by e.g. the constellation builder's
  // connection lines) have the same disposable geometry+material but are
  // NOT THREE.Mesh instances, so the old type check silently skipped them,
  // leaking their GPU buffers on every 3D scene rebuild.
  const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
  if (anyObj.geometry || anyObj.material) {
    anyObj.geometry?.dispose();
    if (Array.isArray(anyObj.material)) anyObj.material.forEach(m => m.dispose());
    else { (anyObj.material as THREE.Material & { map?: THREE.Texture })?.map?.dispose(); anyObj.material?.dispose(); }
  }
  if (obj instanceof THREE.Group) obj.children.forEach(c => disposeMesh(c));
}

// ─── Existing styles ───────────────────────────────────────────────

function surfacePlot(bars: BaseBar[], view: ViewState, width: number, height: number) {
  if (!_scene || !_camera) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const vols = visible.map(b => b.volume);
  const maxV = Math.max(...vols, 1);
  const segments = Math.min(visible.length, 100), priceSteps = 40;
  const halfW = width * 0.5;
  const verts: number[] = [], colors: number[] = [], indices: number[] = [];

  for (let xi = 0; xi < segments; xi++) {
    const idx = Math.floor((xi / segments) * visible.length);
    const bar = visible[Math.min(idx, visible.length - 1)];
    const px = barX(idx, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const barPrice = bar.close;
    const barVol = bar.volume / maxV;
    for (let pi = 0; pi < priceSteps; pi++) {
      const price = minP + (pi / (priceSteps - 1)) * pRange;
      const distFromClose = Math.abs(price - barPrice) / (pRange * 0.1 + 0.0001);
      const z = (price - minP) / pRange * 6 - 3;
      const y = (1 / (1 + distFromClose * distFromClose)) * barVol * 3;
      verts.push(xNorm, y, z);
      const c = new THREE.Color().setHSL(0.35, 0.8, 0.1 + (y / 3) * 0.6);
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let xi = 0; xi < segments - 1; xi++) {
    for (let pi = 0; pi < priceSteps - 1; pi++) {
      const a = xi * priceSteps + pi, b = a + 1, c = (xi + 1) * priceSteps + pi, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices); geom.computeVertexNormals();
  _scene.add(new THREE.Mesh(geom, new THREE.MeshPhongMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
    specular: 0x222244, shininess: 30, wireframe: _activeViz === 'wireframe',
  })));
}

function ribbonViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;

  for (const [offset, color, emit] of [[0.015, 0x22cc88, 0x002211], [-0.015, 0xff4477, 0x220011]] as const) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < visible.length; i++) {
      const bar = visible[i];
      const px = barX(i, visible.length, width, view.barSpacing, view.scrollX);
      const xNorm = ((px - halfW) / halfW) * 5;
      const z = ((bar.close * (1 + offset) - minP) / pRange) * 6 - 3;
      points.push(new THREE.Vector3(xNorm, 0.5, z));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeom = new THREE.TubeGeometry(curve, points.length * 2, 0.08, 8, false);
    _scene.add(new THREE.Mesh(tubeGeom, new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.7, shininess: 60 })));
  }
  const centerPts: THREE.Vector3[] = [];
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const px = barX(i, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    centerPts.push(new THREE.Vector3(xNorm, 0.6, z));
  }
  const cc = new THREE.CatmullRomCurve3(centerPts);
  _scene.add(new THREE.Mesh(new THREE.TubeGeometry(cc, centerPts.length * 2, 0.04, 6, false),
    new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x221133, shininess: 80 })));
}

function scatterViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const maxV = Math.max(...visible.map(b => b.volume), 1);
  const halfW = width * 0.5;
  const group = new THREE.Group();
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const px = barX(i, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    const size = Math.max(0.06, (bar.volume / maxV) * 0.4);
    const isBull = bar.close >= bar.open;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6),
      new THREE.MeshPhongMaterial({ color: isBull ? 0x22cc88 : 0xff4477, emissive: isBull ? 0x002211 : 0x220011, transparent: true, opacity: 0.8 }));
    sphere.position.set(xNorm, 0, z);
    group.add(sphere);
  }
  _scene.add(group);
}

function bars3DViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const maxV = Math.max(...visible.map(b => b.volume), 1);
  const barW = 10 / visible.length * 0.7;
  const halfW = width * 0.5;
  const group = new THREE.Group();
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const px = barX(i, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const oZ = ((bar.open - minP) / pRange) * 6 - 3;
    const cZ = ((bar.close - minP) / pRange) * 6 - 3;
    const bh = Math.abs(cZ - oZ) || 0.05;
    const bCenter = (oZ + cZ) / 2;
    const isBull = bar.close >= bar.open;
    const volH = (bar.volume / maxV) * 2;
    const box = new THREE.Mesh(new THREE.BoxGeometry(barW, volH, bh),
      new THREE.MeshPhongMaterial({ color: isBull ? 0x22cc88 : 0xff4477, emissive: isBull ? 0x002211 : 0x220011, transparent: true, opacity: 0.75 }));
    box.position.set(xNorm, volH / 2, bCenter);
    group.add(box);
  }
  _scene.add(group);
}

// ═══════════════════════════════════════════════════════════════════
// NEW ADVANCED GEOMETRIES
// ═══════════════════════════════════════════════════════════════════

/**
 * Helix — Double-helix DNA spiral wrapping around the price timeline.
 * Two interwoven strands with cross-rungs.
 */
function helixViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 3) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;
  const group = new THREE.Group();
  const radius = 0.8;
  const twists = 3;

  // Build shared helix points
  const strand1: THREE.Vector3[] = [];
  const strand2: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const angle = (i / count) * Math.PI * 2 * twists;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    strand1.push(new THREE.Vector3(xNorm + Math.cos(angle) * radius, Math.sin(angle) * radius, z));
    strand2.push(new THREE.Vector3(xNorm + Math.cos(angle + Math.PI) * radius, Math.sin(angle + Math.PI) * radius, z));
  }

  // Strand 1
  const c1 = new THREE.CatmullRomCurve3(strand1);
  const t1 = new THREE.TubeGeometry(c1, count * 2, 0.06, 6, false);
  _scene.add(new THREE.Mesh(t1, new THREE.MeshPhongMaterial({ color: 0x22cc88, emissive: 0x004422, shininess: 80 })));

  // Strand 2
  const c2 = new THREE.CatmullRomCurve3(strand2);
  const t2 = new THREE.TubeGeometry(c2, count * 2, 0.06, 6, false);
  _scene.add(new THREE.Mesh(t2, new THREE.MeshPhongMaterial({ color: 0xff4477, emissive: 0x220011, shininess: 80 })));

  // Rungs between strands
  const rungStep = Math.max(1, Math.floor(count / 20));
  for (let i = 0; i < count; i += rungStep) {
    const p1 = strand1[i], p2 = strand2[i];
    const rungGeom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
    const rungMat = new THREE.LineBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0.3 + (i / count) * 0.4 });
    _scene.add(new THREE.Line(rungGeom, rungMat));
  }

  // Glow core line
  const centerPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    centerPts.push(new THREE.Vector3(xNorm, 0, z));
  }
  const cc = new THREE.CatmullRomCurve3(centerPts);
  _scene.add(new THREE.Mesh(new THREE.TubeGeometry(cc, count, 0.02, 4, false),
    new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x4444aa, transparent: true, opacity: 0.4 })));
}

/**
 * Vortex — Spiral tornado/tunnel geometry wrapping price action.
 * Spiraling particle paths converging on the price axis.
 */
function vortexViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 3) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;
  const spirals = 6;
  const maxRadius = 2.5;
  const group = new THREE.Group();

  for (let s = 0; s < spirals; s++) {
    const pts: THREE.Vector3[] = [];
    const phase = (s / spirals) * Math.PI * 2;
    const hue = (s / spirals) * 0.8;
    for (let i = 0; i < count; i++) {
      const bar = visible[i];
      const px = barX(i, count, width, view.barSpacing, view.scrollX);
      const xNorm = ((px - halfW) / halfW) * 5;
      const progress = i / count;
      const r = maxRadius * (1 - progress * 0.85);
      const angle = progress * Math.PI * 4 + phase;
      const z = ((bar.close - minP) / pRange) * 6 - 3;
      pts.push(new THREE.Vector3(xNorm + Math.cos(angle) * r, Math.sin(angle) * r, z));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, count, 0.04, 5, false);
    const col = new THREE.Color().setHSL(hue, 0.8, 0.5);
    _scene.add(new THREE.Mesh(tube, new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.3), transparent: true, opacity: 0.6 - s * 0.04 })));
  }

  // Core glow tube
  const corePts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    corePts.push(new THREE.Vector3(xNorm, 0, z));
  }
  const cc = new THREE.CatmullRomCurve3(corePts);
  _scene.add(new THREE.Mesh(new THREE.TubeGeometry(cc, count, 0.15, 8, false),
    new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x8844ff, transparent: true, opacity: 0.3 })));
}

/**
 * Manifold — Wireframe 3D surface mesh (like Lorentzian Dreamer).
 * Longitudinal + latitudinal curves forming a flowing ribbon structure.
 */
function manifoldViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 5) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;
  const longitudinalCount = 8;
  const latitudinalCount = Math.min(count, 40);
  const manifoldWidth = 1.5;

  const longCurves: THREE.Vector3[][] = [];
  for (let l = 0; l < longitudinalCount; l++) {
    const pts: THREE.Vector3[] = [];
    const lFrac = l / (longitudinalCount - 1);
    const lOffset = (lFrac - 0.5) * manifoldWidth * 2;
    for (let i = 0; i < count; i++) {
      const bar = visible[i];
      const px = barX(i, count, width, view.barSpacing, view.scrollX);
      const xNorm = ((px - halfW) / halfW) * 5;
      const volFrac = bar.volume / Math.max(...visible.map(b => b.volume), 1);
      const height = volFrac * 2;
      const spread = manifoldWidth * (0.5 + volFrac * 0.5);
      const z = ((bar.close - minP) / pRange) * 6 - 3;
      pts.push(new THREE.Vector3(xNorm + lOffset * spread, (lFrac - 0.5) * height * 1.5, z));
    }
    longCurves.push(pts);

    // Draw longitudinal curve
    const curve = new THREE.CatmullRomCurve3(pts);
    const curvePts = curve.getPoints(count);
    const geom = new THREE.BufferGeometry().setFromPoints(curvePts);
    const col = new THREE.Color().setHSL(0.7 + lFrac * 0.15, 0.7, 0.5 + lFrac * 0.2);
    _scene.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.7 })));
  }

  // Latitudinal curves (cross-ribs)
  const latStep = Math.max(1, Math.floor(count / latitudinalCount));
  for (let i = 0; i < count; i += latStep) {
    const pts: THREE.Vector3[] = [];
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    const volFrac = bar.volume / Math.max(...visible.map(b => b.volume), 1);
    const height = volFrac * 2;

    for (let l = 0; l < longitudinalCount; l++) {
      const lFrac = l / (longitudinalCount - 1);
      const spread = manifoldWidth * (0.5 + volFrac * 0.5);
      const lOff = (lFrac - 0.5) * spread;
      pts.push(new THREE.Vector3(xNorm + lOff, (lFrac - 0.5) * height * 1.5, z));
    }
    const latGeom = new THREE.BufferGeometry().setFromPoints(pts);
    const frac = i / count;
    _scene.add(new THREE.Line(latGeom, new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(0.35 - frac * 0.35, 0.8, 0.4 + frac * 0.3),
      transparent: true, opacity: 0.4,
    })));
  }

  // Ghost floor grid
  const floorPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    floorPts.push(new THREE.Vector3(xNorm, -0.5, z));
  }
  _scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(floorPts),
    new THREE.LineBasicMaterial({ color: 0x222244, transparent: true, opacity: 0.3 })));
}

/**
 * Nebula — Glowing particle cloud scatter plot.
 * Thousands of small glowing spheres forming a dense volumetric cloud.
 */
function nebulaViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;
  const particlesPerBar = 6;
  const group = new THREE.Group();

  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const baseZ = ((bar.close - minP) / pRange) * 6 - 3;
    const isBull = bar.close >= bar.open;
    const baseHue = isBull ? 0.35 : 0.0;
    const volScale = bar.volume / Math.max(...visible.map(b => b.volume), 1);

    for (let p = 0; p < particlesPerBar; p++) {
      const spread = 0.6 * volScale + 0.2;
      const xOff = (Math.random() - 0.5) * spread;
      const yOff = (Math.random() - 0.5) * spread;
      const zOff = (Math.random() - 0.5) * spread;
      const size = 0.02 + Math.random() * 0.06 * volScale;
      const hue = baseHue + (Math.random() - 0.5) * 0.1;
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 4, 3),
        new THREE.MeshPhongMaterial({
          color: new THREE.Color().setHSL(hue, 0.7, 0.4 + Math.random() * 0.3),
          emissive: new THREE.Color().setHSL(hue, 0.5, 0.08),
          transparent: true, opacity: 0.5 + Math.random() * 0.4,
        }));
      sphere.position.set(xNorm + xOff, yOff, baseZ + zOff);
      group.add(sphere);
    }
  }
  _scene.add(group);
}

/**
 * Constellation — Points with interconnecting lines.
 * Stars at each bar with lines drawn between nearby points.
 */
function constellationViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;

  // Build star points
  const positions: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    const y = (bar.volume / Math.max(...visible.map(b => b.volume), 1)) * 1.5;
    positions.push(new THREE.Vector3(xNorm, y * 0.5, z));
  }

  // Draw constellation lines (connect nearby points)
  const lineThreshold = 1.2;
  const linePairs: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < Math.min(i + 5, count); j++) {
      if (positions[i].distanceTo(positions[j]) < lineThreshold) {
        linePairs.push(positions[i], positions[j]);
      }
    }
  }
  if (linePairs.length > 0) {
    const lineGeom = new THREE.BufferGeometry().setFromPoints(linePairs);
    _scene.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.15 })));
  }

  // Draw stars as glowing spheres
  const starGroup = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const p = positions[i];
    const bar = visible[i];
    const isBull = bar.close >= bar.open;
    const size = 0.04 + (bar.volume / Math.max(...visible.map(b => b.volume), 1)) * 0.12;
    const star = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 4),
      new THREE.MeshPhongMaterial({
        color: isBull ? 0x22cc88 : 0xff4477,
        emissive: isBull ? 0x00ff44 : 0xff0044,
        emissiveIntensity: 0.5 + (bar.volume / Math.max(...visible.map(b => b.volume), 1)) * 0.5,
      }));
    star.position.copy(p);
    starGroup.add(star);
  }
  _scene.add(starGroup);
}

/**
 * Torus — Rotating ring/torus geometry wrapping around the price timeline.
 * A 3D ring with tube cross-section that follows the price series.
 */
function torusViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 3) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;

  // Create a ring at each bar position, scaled by volume
  const group = new THREE.Group();
  const maxV = Math.max(...visible.map(b => b.volume), 1);

  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    const volScale = bar.volume / maxV;
    const ringRadius = 0.2 + volScale * 0.5;
    const tubeRadius = 0.02 + volScale * 0.03;
    const isBull = bar.close >= bar.open;
    const segments = 8;

    const torusGeom = new THREE.TorusGeometry(ringRadius, tubeRadius, 6, segments);
    const col = isBull ? 0x22cc88 : 0xff4477;
    const mat = new THREE.MeshPhongMaterial({
      color: col, emissive: col, emissiveIntensity: 0.2,
      transparent: true, opacity: 0.5 + volScale * 0.3,
    });
    const mesh = new THREE.Mesh(torusGeom, mat);
    mesh.position.set(xNorm, 0, z);
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.z = i * 0.05;
    group.add(mesh);
  }
  _scene.add(group);

  // Connect with a glow tube through center
  const centerPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    centerPts.push(new THREE.Vector3(xNorm, 0, z));
  }
  _scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(centerPts), count, 0.03, 6, false),
    new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x442288, transparent: true, opacity: 0.3 })));
}

/**
 * Trail — Streaming 3D path with ribbon width varying by volume.
 * A sinuous ribbon that twists through 3D space.
 */
function trailViz(bars: BaseBar[], view: ViewState, width: number) {
  if (!_scene) return;
  clearViz();
  const visible = visibleBars(bars, view, width);
  if (visible.length < 3) return;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const count = visible.length;
  const maxV = Math.max(...visible.map(b => b.volume), 1);

  // Upper and lower ribbon edges with varying width
  const upper: THREE.Vector3[] = [];
  const lower: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    const volFrac = bar.volume / maxV;
    const widthOffset = 0.05 + volFrac * 0.3;
    upper.push(new THREE.Vector3(xNorm, widthOffset, z));
    lower.push(new THREE.Vector3(xNorm, -widthOffset, z));
  }

  // Build ribbon as a tube connecting the edges
  const ribbonPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    ribbonPts.push(upper[i]);
  }
  for (let i = count - 1; i >= 0; i--) {
    ribbonPts.push(lower[i]);
  }

  // Draw ribbon surface as lathe-like geometry
  for (let i = 0; i < count - 1; i++) {
    const verts: number[] = [];
    const idx: number[] = [];
    const pts = [upper[i], upper[i + 1], lower[i + 1], lower[i]];
    for (const p of pts) verts.push(p.x, p.y, p.z);
    idx.push(0, 1, 2, 0, 2, 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idx); geom.computeVertexNormals();
    const bar = visible[i];
    const isBull = bar.close >= bar.open;
    _scene.add(new THREE.Mesh(geom, new THREE.MeshPhongMaterial({
      color: isBull ? 0x22cc88 : 0xff4477,
      transparent: true, opacity: 0.5 + (bar.volume / maxV) * 0.3,
      side: THREE.DoubleSide, shininess: 40,
    })));
  }

  // Center guide line
  const centerPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const bar = visible[i];
    const px = barX(i, count, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    centerPts.push(new THREE.Vector3(xNorm, 0, z));
  }
  _scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(centerPts),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })));
}

// ─── Public Render API ─────────────────────────────────────────────

export function render3DViz(bars: BaseBar[], view: ViewState, width: number, height: number): void {
  if (!_initialized || !_scene || !_renderer || !_camera) return;

  switch (_activeViz) {
    case 'surface': surfacePlot(bars, view, width, height); break;
    case 'ribbon': ribbonViz(bars, view, width); break;
    case 'scatter': scatterViz(bars, view, width); break;
    case 'bars3d': bars3DViz(bars, view, width); break;
    case 'wireframe': { const p = _activeViz; _activeViz = 'surface'; surfacePlot(bars, view, width, height); _activeViz = p; break; }
    case 'mesh': { const p = _activeViz; _activeViz = 'surface'; surfacePlot(bars, view, width, height); _activeViz = p; break; }
    case 'line3d': ribbonViz(bars, view, width); break;
    case 'helix': helixViz(bars, view, width); break;
    case 'vortex': vortexViz(bars, view, width); break;
    case 'manifold': manifoldViz(bars, view, width); break;
    case 'nebula': nebulaViz(bars, view, width); break;
    case 'constellation': constellationViz(bars, view, width); break;
    case 'torus': torusViz(bars, view, width); break;
    case 'trail': trailViz(bars, view, width); break;
  }

  const canvas = getCanvas();
  if (canvas.width !== width || canvas.height !== height) {
    _renderer.setSize(width, height, false);
    _camera.aspect = width / Math.max(height, 1);
    _camera.updateProjectionMatrix();
    resizeComposer(width, height);
  }
  _renderTime = performance.now();
  renderFrame();
}

export function toggle3DViz(bars: BaseBar[], view: ViewState, width: number, height: number): boolean {
  if (_initialized) { disposeViz(); return false; }
  _chart3DMode = false;
  init();
  render3DViz(bars, view, width, height);
  return true;
}

export function cycleVizType(): VizType {
  const types: VizType[] = ['surface', 'ribbon', 'scatter', 'bars3d', 'wireframe', 'line3d', 'mesh',
    'helix', 'vortex', 'manifold', 'nebula', 'constellation', 'torus', 'trail'];
  const idx = types.indexOf(_activeViz);
  _activeViz = types[(idx + 1) % types.length];
  return _activeViz;
}

// ═══════════════════════════════════════════════════════════════════
// 3D CHART MODE — Price bars + plot3d indicators in ONE Three.js scene
// ═══════════════════════════════════════════════════════════════════

let _chart3DMode = false;
let _barGroup: THREE.Group | null = null;
// Visible-range signature (start|end|barCount) as of the last bar-group
// build. Compared every render call so panning/zooming — which only ever
// changes view.scrollX/barSpacing, never the plot3d series data that
// mark3DSceneDirty() watches — still forces a rebuild instead of leaving
// the candles frozen at whatever window was in view when 3D mode opened.
let _lastVisibleRangeKey: string | null = null;
let _orbitEnabled = false;
let _orbitDragging = false, _orbitLX = 0, _orbitLY = 0;
let _orbitTheta = -0.16, _orbitPhi = 1.24, _orbitDist = 14;
const _orbitTarget = new THREE.Vector3(0, 0, 0);

function enableOrbitMain(): void {
  if (_orbitEnabled) return;
  const c = getCanvas();
  c.style.pointerEvents = 'auto';
  c.style.cursor = 'grab';
  c.onpointerdown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    _orbitDragging = true; _orbitLX = e.clientX; _orbitLY = e.clientY;
    c.style.cursor = 'grabbing'; e.preventDefault();
  };
  c.onpointermove = (e: PointerEvent) => {
    if (!_orbitDragging || !_camera) return;
    const dx = e.clientX - _orbitLX;
    const dy = e.clientY - _orbitLY;
    if (e.shiftKey) {
      // Shift-drag = pan the camera target (screen-plane): drag zoomed-out
      // content back into view instead of rotating around it.
      const right = new THREE.Vector3().setFromMatrixColumn(_camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(_camera.matrix, 1);
      const scale = _orbitDist * 0.0016;
      _orbitTarget.addScaledVector(right, -dx * scale);
      _orbitTarget.addScaledVector(up, dy * scale);
      _orbitTarget.y = Math.max(-6, Math.min(6, _orbitTarget.y));
    } else {
      _orbitTheta -= dx * 0.008;
      _orbitPhi = Math.max(0.15, Math.min(1.5, _orbitPhi - dy * 0.008));
    }
    _orbitLX = e.clientX; _orbitLY = e.clientY;
    applyOrbitCam();
    renderFrame();
  };
  c.onpointerup = () => { _orbitDragging = false; if (c) c.style.cursor = 'grab'; };
  c.onwheel = (e: WheelEvent) => {
    if (!_camera) return;
    _orbitDist = Math.max(2.5, Math.min(50, _orbitDist + e.deltaY * 0.02));
    applyOrbitCam();
    renderFrame();
    e.preventDefault();
  };
  _orbitEnabled = true;
}

function disableOrbitMain(): void {
  if (!_orbitEnabled) return;
  const c = document.getElementById(CANVAS_ID) as HTMLCanvasElement;
  if (c) { c.style.pointerEvents = 'none'; c.style.cursor = '';
    c.onpointerdown = null; c.onpointermove = null; c.onpointerup = null; c.onwheel = null; }
  _orbitEnabled = false;
}

function initChart3D(): void {
  if (!_initialized) { init(); }
  if (_scene) _scene.background = new THREE.Color(0x0a0a18);
  if (_renderer) _renderer.setClearColor(0x0a0a18, 1);
  if (_barGroup) { _scene?.remove(_barGroup); disposeMesh(_barGroup); _barGroup = null; }
  clearViz();
  enableOrbitMain();
  applyOrbitCam();
}

function applyOrbitCam(): void {
  if (!_camera) return;
  _camera.position.x = _orbitTarget.x + _orbitDist * Math.sin(_orbitPhi) * Math.sin(_orbitTheta);
  _camera.position.y = _orbitTarget.y + _orbitDist * Math.cos(_orbitPhi);
  _camera.position.z = _orbitTarget.z + _orbitDist * Math.sin(_orbitPhi) * Math.cos(_orbitTheta);
  _camera.lookAt(_orbitTarget);
}

export function isChart3DMode(): boolean { return _chart3DMode; }

function buildMainInstrumentCage(bars: BaseBar[], view: ViewState, width: number): THREE.Group | null {
  const visible = visibleBars(bars, view, width);
  if (visible.length < 2) return null;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const cage = new THREE.Group();

  // Span the same bars as the candles (first and last visible bar, plus room for
  // the candle bodies), so the frame follows zoom, pan and new bars.
  const total = visible.length;
  const x0 = barXNorm(0, total, width, view) - 0.35;
  const x1 = barXNorm(total - 1, total, width, view) + 0.35;
  const y0 = -3.0, y1 = 3.0;
  const zBack = -0.65, zFront = 0.65;

  const linePts: THREE.Vector3[] = [];
  // Horizontal price reference lines on back plane + right scale post
  for (let s = 0; s <= 4; s++) {
    const frac = s / 4;
    const y = y0 + (y1 - y0) * frac;
    linePts.push(
      new THREE.Vector3(x0, y, zBack), new THREE.Vector3(x1, y, zBack),
      new THREE.Vector3(x1, y, zBack), new THREE.Vector3(x1, y, zFront),
    );
    const price = minP + pRange * frac;
    const fmt = price >= 100 ? price.toFixed(2) : price.toFixed(3);
    const lbl = makeTextSprite(fmt, s === 2 ? '#ffd43b' : '#7ce8ff', 0.48);
    lbl.position.set(x1 + 0.65, y, zFront * 0.5);
    cage.add(lbl);
  }
  // Vertical corner posts
  for (const [cx, cz] of [[x0, zBack], [x1, zBack], [x1, zFront]]) {
    linePts.push(new THREE.Vector3(cx, y0, cz), new THREE.Vector3(cx, y1, cz));
  }
  cage.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(linePts),
    new THREE.LineBasicMaterial({ color: 0x2b4b88, transparent: true, opacity: 0.36 }),
  ));
  return cage;
}

function buildBarGroup(bars: BaseBar[], view: ViewState, width: number): THREE.Group | null {
  const visible = visibleBars(bars, view, width);
  if (visible.length < 1) return null;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const total = visible.length;
  const maxV = Math.max(...visible.map(b => b.volume), 1);
  const group = new THREE.Group();
  // Candle width, depth and wick thickness are fractions of one bar pitch, so
  // neighbouring bodies never overlap and each candle sits on its own bar.
  const pitch = (view.barSpacing / halfW) * 5;
  const wickW = Math.max(0.006, pitch * 0.14);

  for (let i = 0; i < total; i++) {
    const bar = visible[i];
    const px = barX(i, total, width, view.barSpacing, view.scrollX);
    const xNorm = ((px - halfW) / halfW) * 5;
    // Price mapped to Y axis (vertical)
    const oY = ((bar.open - minP) / pRange) * 6 - 3;
    const cY = ((bar.close - minP) / pRange) * 6 - 3;
    const hY = ((bar.high - minP) / pRange) * 6 - 3;
    const lY = ((bar.low - minP) / pRange) * 6 - 3;
    const isBull = bar.close >= bar.open;
    const col = isBull ? 0x22cc88 : 0xff4477;
    const em = isBull ? 0x004422 : 0x220011;

    const bodyTop = Math.max(oY, cY);
    const bodyBot = Math.min(oY, cY);
    const bodyH = Math.max(0.06, bodyTop - bodyBot);
    const vs = bar.volume / maxV;
    const bw = Math.max(0.012, pitch * (0.55 + 0.3 * vs));
    const bd = Math.max(0.012, pitch * (0.55 + 0.3 * vs));

    // Body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(bw, bodyH, bd),
      new THREE.MeshPhongMaterial({ color: col, emissive: em, emissiveIntensity: 0.25, transparent: true, opacity: 0.85, shininess: 40 })
    );
    body.position.set(xNorm, (bodyTop + bodyBot) / 2, 0);
    group.add(body);

    // Upper wick: from body top to high
    if (hY > bodyTop + 0.01) {
      const wickH = hY - bodyTop;
      const wick = new THREE.Mesh(
        new THREE.BoxGeometry(wickW, wickH, wickW),
        new THREE.MeshPhongMaterial({ color: col, emissive: em, transparent: true, opacity: 0.6 })
      );
      wick.position.set(xNorm, bodyTop + wickH / 2, 0);
      group.add(wick);
    }

    // Lower wick: from body bottom to low
    if (bodyBot - lY > 0.01) {
      const wickH = bodyBot - lY;
      const wick = new THREE.Mesh(
        new THREE.BoxGeometry(wickW, wickH, wickW),
        new THREE.MeshPhongMaterial({ color: col, emissive: em, transparent: true, opacity: 0.6 })
      );
      wick.position.set(xNorm, lY + wickH / 2, 0);
      group.add(wick);
    }
  }
  return group;
}

// ─── Series-level geometry builders for plot3d data ─────────

function seriesNorm(series: number[], _view: ViewState, _width: number, _totalBars: number): {
  vals: number[];
  indexed: Array<{ barIdx: number; val: number }>;
  sMin: number;
  sMax: number;
  sRange: number;
} {
  const indexed: Array<{ barIdx: number; val: number }> = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (isFinite(v) && !isNaN(v)) indexed.push({ barIdx: i, val: v });
  }
  const vals = indexed.map(p => p.val);
  const sMin = vals.length ? Math.min(...vals) : 0;
  // Robust max (98th percentile): one warmup spike (e.g. the first ATR
  // value) used to either flatten every other bar or render as a single
  // giant column filling the scene. Visual scaling only — data untouched.
  const sorted = [...vals].sort((a, b) => a - b);
  const p98 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] : 1;
  const sMax = vals.length ? Math.max(p98, sMin + 1e-6) : 1;
  return { vals, indexed, sMin, sMax, sRange: sMax - sMin || 1 };
}

function seriesX(i: number, count: number, view: ViewState, width: number, visibleCount?: number): number {
  const halfW = width * 0.5;
  const vc = visibleCount ?? count;
  // Map compressed index to actual visible bar index so geometry aligns with bars
  const barIdx = count > 1 ? Math.round((i / (count - 1)) * (vc - 1)) : 0;
  const px = barX(barIdx, vc, width, view.barSpacing, view.scrollX);
  return ((px - halfW) / halfW) * 5;
}

/**
 * Price-scale mapping for the unified scene: a series whose values live
 * in the visible PRICE range (e.g. EMAs of close) must be positioned with
 * the same scale as the bars, or it floats detached above/below them
 * (the "ribbons hovering in space" bug). Oscillator series keep their
 * own normalization. Set per-layer by renderMain3DScene.
 */
let _yPriceMap: { min: number; range: number } | null = null;

function seriesY(val: number, sMin: number, sRange: number): number {
  if (_yPriceMap) return ((val - _yPriceMap.min) / _yPriceMap.range) * 6 - 3;
  return ((val - sMin) / sRange) * 6 - 3;
}

function buildSurfaceFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Mesh | null {
  const { vals, indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const count = Math.min(vals.length, 100);
  const segments = count, depth = 20;
  const verts: number[] = [], idx: number[] = [], cols: number[] = [];
  const baseCol = new THREE.Color(color);
  const totalLen = Math.max(series.length, 2);

  for (let xi = 0; xi < segments; xi++) {
    const vi = Math.floor((xi / (segments - 1)) * (indexed.length - 1));
    const sample = indexed[vi];
    const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
    const val = seriesY(sample.val, sMin, sRange);
    // Height-ramp vertex colors (deep blue → cyan → green → yellow →
    // magenta) — the layered-terrain read of the Pine "3D surface"
    // creations, instead of one flat color fading to black. The script's
    // own color tints the ramp so author intent still shows.
    const frac = Math.max(0, Math.min(1, (sample.val - sMin) / sRange));
    const ramp = new THREE.Color().setHSL((1 - frac) * 0.68, 0.85, 0.32 + frac * 0.3);
    ramp.lerp(baseCol, 0.25);
    for (let di = 0; di < depth; di++) {
      const d = Math.abs((di / (depth - 1)) - 0.5) * 2;
      const z = (di / (depth - 1)) * 2 - 1;
      verts.push(x, val + (1 - d * 0.9) * 0.4, z);
      const c = ramp.clone().lerp(new THREE.Color(0x000000), d * 0.3);
      cols.push(c.r, c.g, c.b);
    }
  }
  for (let xi = 0; xi < segments - 1; xi++) for (let di = 0; di < depth - 1; di++) {
    const a = xi * depth + di, b = a + 1, c = (xi + 1) * depth + di, d2 = c + 1;
    idx.push(a, b, c, b, d2, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.8, shininess: 25 }));
}

function buildRibbonFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number, straight = false): THREE.Mesh | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 3) return null;
  const step = Math.max(1, Math.floor(indexed.length / 150));
  const totalLen = Math.max(series.length, 2);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < indexed.length; i += step) {
    const sample = indexed[i];
    pts.push(new THREE.Vector3(seriesX(sample.barIdx, totalLen, view, width, visibleCount), seriesY(sample.val, sMin, sRange), 0));
  }
  if (indexed.length - 1 > 0 && (indexed.length - 1) % step !== 0) {
    const last = indexed[indexed.length - 1];
    pts.push(new THREE.Vector3(seriesX(last.barIdx, totalLen, view, width, visibleCount), seriesY(last.val, sMin, sRange), 0));
  }
  // straight (line3d): exact segments — Catmull-Rom smoothing turns
  // step-shaped level series (fibs/pivots) into spike blades.
  let curve: THREE.Curve<THREE.Vector3>;
  if (straight) {
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
    curve = path as unknown as THREE.Curve<THREE.Vector3>;
  } else {
    curve = new THREE.CatmullRomCurve3(pts);
  }
  return new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, straight ? 0.032 : 0.06, 6, false),
    new THREE.MeshPhongMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color).multiplyScalar(0.22), shininess: 60 }));
}

function buildBarsFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 2) return null;
  const count = Math.min(indexed.length, 80);
  const bw = 10 / Math.max(series.length, count) * 0.5;
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
    const sample = indexed[vi];
    const h = Math.min(3, Math.max(0.05, ((sample.val - sMin) / sRange) * 3));
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bw), new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.15 * _vis.emissiveScale), shininess: 30 }));
    b.position.set(seriesX(sample.barIdx, totalLen, view, width, visibleCount), -3 + h / 2, 0);
    group.add(b);
  }
  return group;
}

function buildScatterFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 2) return null;
  const count = Math.min(indexed.length, 120);
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
    const sample = indexed[vi];
    const frac = (sample.val - sMin) / sRange;
    const hue = (1 - frac) * 0.35;
    const c = new THREE.Color().setHSL(hue, 0.75, 0.45 + frac * 0.25);
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.05 + frac * 0.05, 5, 4),
      new THREE.MeshPhongMaterial({ color: c, emissive: c.clone().multiplyScalar(0.2 * _vis.emissiveScale), shininess: 40 }));
    s.position.set(seriesX(sample.barIdx, totalLen, view, width, visibleCount), seriesY(sample.val, sMin, sRange), 0);
    group.add(s);
  }
  return group;
}

function buildHelixFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 4) return null;
  const count = indexed.length, twists = 3, radius = 0.6;
  const totalLen = Math.max(series.length, 2);
  const s1: THREE.Vector3[] = [], s2: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const sample = indexed[i];
    const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
    const y = seriesY(sample.val, sMin, sRange);
    const a = (i / count) * Math.PI * 2 * twists;
    s1.push(new THREE.Vector3(x + Math.cos(a) * radius, y, Math.sin(a) * radius));
    s2.push(new THREE.Vector3(x + Math.cos(a + Math.PI) * radius, y, Math.sin(a + Math.PI) * radius));
  }
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(s1), count, 0.04, 6, false),
    new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.2), shininess: 60 })));
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(s2), count, 0.04, 6, false),
    new THREE.MeshPhongMaterial({ color: 0xff4477, emissive: 0x220011, shininess: 60 })));
  return group;
}

function buildManifoldFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 5) return null;
  const count = Math.min(indexed.length, 60), longs = 6, mw = 1.0;
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  for (let l = 0; l < longs; l++) {
    const lf = l / (longs - 1);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
      const sample = indexed[vi];
      const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
      const y = seriesY(sample.val, sMin, sRange);
      pts.push(new THREE.Vector3(x + (lf - 0.5) * mw, y + (lf - 0.5) * 0.6, (lf - 0.5) * 0.6));
    }
    const c = col.clone().lerp(new THREE.Color(0x4488ff), lf);
    const curve = new THREE.CatmullRomCurve3(pts);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, count * 2, 0.035, 5, false),
      new THREE.MeshPhongMaterial({ color: c, emissive: c.clone().multiplyScalar(0.3), transparent: true, opacity: 0.7, shininess: 60 })));
  }
  return group;
}

function buildTrailFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { vals, indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 3) return null;
  const count = Math.min(indexed.length, 80);
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  const maxV = Math.max(...vals.map(Math.abs), 1);
  const upper: THREE.Vector3[] = [], lower: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
    const sample = indexed[vi];
    const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
    const y = seriesY(sample.val, sMin, sRange);
    const w = 0.06 + (Math.abs(sample.val) / maxV) * 0.35;
    upper.push(new THREE.Vector3(x, y + w, 0.12));
    lower.push(new THREE.Vector3(x, y - w, 0.12));
  }
  for (let i = 0; i < count - 1; i++) {
    const v = [upper[i].x, upper[i].y, upper[i].z, upper[i + 1].x, upper[i + 1].y, upper[i + 1].z, lower[i + 1].x, lower[i + 1].y, lower[i + 1].z, lower[i].x, lower[i].y, lower[i].z];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals();
    group.add(new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.25), transparent: true, opacity: 0.65, side: THREE.DoubleSide, shininess: 40 })));
  }
  return group;
}

function buildVortexFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 4) return null;
  const count = Math.min(indexed.length, 100), spirals = 6, maxR = 1.6;
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  for (let s = 0; s < spirals; s++) {
    const phase = (s / spirals) * Math.PI * 2;
    const hue = (s / spirals) * 0.8;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
      const sample = indexed[vi];
      const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
      const y = seriesY(sample.val, sMin, sRange);
      const pct = i / count;
      const r = maxR * (1 - pct * 0.85);
      const angle = pct * Math.PI * 4 + phase;
      pts.push(new THREE.Vector3(x + Math.cos(angle) * r, y + Math.sin(angle) * r * 0.5, Math.sin(angle) * r));
    }
    const col = new THREE.Color().setHSL(hue, 0.7, 0.55);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), count, 0.03, 5, false),
      new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.3), transparent: true, opacity: 0.6, shininess: 50 })));
  }
  return group;
}

function buildNebulaFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 3) return null;
  const count = Math.min(indexed.length, 60), perBar = 7;
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
    const sample = indexed[vi];
    const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
    const y = seriesY(sample.val, sMin, sRange);
    const frac = (sample.val - sMin) / sRange;
    const hue = 0.65 - frac * 0.65;
    for (let p = 0; p < perBar; p++) {
      const c = new THREE.Color().setHSL(hue + (Math.random() - 0.5) * 0.08, 0.65, 0.35 + Math.random() * 0.3);
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.02 + Math.random() * 0.06, 5, 4),
        new THREE.MeshPhongMaterial({ color: c, emissive: c.clone().multiplyScalar(0.25), transparent: true, opacity: 0.4 + Math.random() * 0.4 }));
      s.position.set(x + (Math.random() - 0.5) * 0.7, y + (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.7);
      group.add(s);
    }
  }
  return group;
}

function buildConstellationFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 3) return null;
  const count = Math.min(indexed.length, 80);
  const totalLen = Math.max(series.length, 2);
  const group = new THREE.Group();
  const positions: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (indexed.length - 1));
    const sample = indexed[vi];
    positions.push(new THREE.Vector3(seriesX(sample.barIdx, totalLen, view, width, visibleCount), seriesY(sample.val, sMin, sRange), 0));
  }
  const linkPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < Math.min(i + 4, count); j++) {
      if (positions[i].distanceTo(positions[j]) < 1.4) linkPts.push(positions[i], positions[j]);
    }
  }
  if (linkPts.length) {
    const col = new THREE.Color(color);
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linkPts),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.25 })));
  }
  for (const pos of positions) {
    const star = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5),
      new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x8844ff, emissiveIntensity: 0.45 * _vis.emissiveScale }));
    star.position.copy(pos);
    group.add(star);
  }
  return group;
}

function buildTorusFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number, layerIdx = 0): THREE.Group | null {
  const { vals, indexed, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (indexed.length < 2) return null;
  // Event/shockwave series often sit at 0 on normal bars and spike > 0 on
  // trigger bars. Render rings only on active bars when 0 is the baseline, so
  // inactive bars don't litter the floor with dead rings or vertical spikes.
  const nonZero = indexed.filter(s => Math.abs(s.val) > 1e-6);
  const isSparseEvent = nonZero.length >= 1 && nonZero.length < indexed.length * 0.75;
  const active = isSparseEvent ? nonZero : indexed;
  const count = Math.min(active.length, 18);
  const totalLen = Math.max(series.length, 2);
  const maxV = Math.max(...vals.map(Math.abs), 1);
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  const centerPts: THREE.Vector3[] = [];
  const concentricBoost = layerIdx * 0.14;
  for (let i = 0; i < count; i++) {
    const vi = count > 1 ? Math.floor((i / (count - 1)) * (active.length - 1)) : 0;
    const sample = active[vi];
    const x = seriesX(sample.barIdx, totalLen, view, width, visibleCount);
    const y = seriesY(sample.val, sMin, sRange);
    centerPts.push(new THREE.Vector3(x, y, 0));
    const mag = Math.abs(sample.val) / maxV;
    const radius = 0.16 + concentricBoost + mag * 0.24;
    const tube = 0.016 + mag * 0.018;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 20),
      new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.35), transparent: true, opacity: 0.55 + mag * 0.35 }));
    ring.position.set(x, y, 0);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
  }
  if (!isSparseEvent && centerPts.length >= 3) {
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(centerPts), centerPts.length * 2, 0.016, 6, false),
      new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.2), transparent: true, opacity: 0.25 })));
  }
  return group;
}

function buildRidgelineFromSeries(series: number[], view: ViewState, width: number, visibleCount?: number): THREE.Group | null {
  // Temporal distribution joyplot: time windows along X (aligned to bars),
  // value bins along Z, ridge height = frequency. Colored on an HSL ramp so
  // early ridges read cool and recent ridges hot.
  const vals = series.filter(v => isFinite(v) && !isNaN(v));
  if (vals.length < 24) return null;
  const sMin = Math.min(...vals), sMax = Math.max(...vals);
  const range = sMax - sMin || 1;
  const windows = Math.max(4, Math.min(16, Math.floor(vals.length / 12)));
  const bins = 28;
  const winLen = Math.floor(vals.length / windows);
  const group = new THREE.Group();
  let maxFreq = 1;
  const hists: number[][] = [];
  for (let w = 0; w < windows; w++) {
    const hist = new Array(bins).fill(0);
    const from = w * winLen, to = w === windows - 1 ? vals.length : from + winLen;
    for (let i = from; i < to; i++) {
      const b = Math.max(0, Math.min(bins - 1, Math.floor(((vals[i] - sMin) / range) * (bins - 1))));
      hist[b]++;
    }
    const sm = hist.map((v, i) => (hist[i - 1] ?? v) * 0.25 + v * 0.5 + (hist[i + 1] ?? v) * 0.25);
    maxFreq = Math.max(maxFreq, ...sm);
    hists.push(sm);
  }
  for (let w = 0; w < windows; w++) {
    const x = seriesX(w, windows, view, width, visibleCount);
    const pts: THREE.Vector3[] = [];
    for (let b = 0; b < bins; b++) {
      pts.push(new THREE.Vector3(x, (hists[w][b] / maxFreq) * 3 - 3, (b / (bins - 1)) * 4 - 2));
    }
    const hue = 0.5 + (w / Math.max(windows - 1, 1)) * 0.6;
    const col = new THREE.Color().setHSL(hue % 1, 0.8, 0.55);
    const curve = new THREE.CatmullRomCurve3(pts);
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(bins * 3)),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 })));
  }
  return group;
}

// ─── Entry point ────────────────────────────────────────────
let _rebuildNeeded = true;

export function mark3DSceneDirty(): void { _rebuildNeeded = true; }

/**
 * Render the unified 3D scene every frame. Rebuilds geometry when
 * mark3DSceneDirty() was called (indicator data changed) or the visible
 * bar range moved (pan/zoom).
 */
export function renderMain3DScene(
  bars: BaseBar[],
  plots: OakPlot3D[],
  view: ViewState,
  width: number,
  height: number,
  shapes?: OakPlot[],
  bgMode?: string
): void {
  if (!_initialized || !_chart3DMode) {
    _chart3DMode = true;
    initChart3D();
    _rebuildNeeded = true;
  }
  if (!_scene || !_camera || !_renderer) return;
  // Display background is obeyed in 3D too (Settings → Display): stars /
  // particles show the atmosphere, plain / graph use the solid scene.
  if (bgMode) {
    const atmospheric = bgMode === 'stars' || bgMode === 'particles';
    _scene.background = atmospheric ? null : new THREE.Color(0x0a0a18);
    _renderer.setClearColor(0x0a0a18, atmospheric ? 0 : 1);
    if (_starfield) _starfield.visible = _vis.showStars && atmospheric;
    if (_gridHelper) _gridHelper.visible = _vis.showGrid;
  }

  const canvas = getCanvas();
  if (canvas.width !== width || canvas.height !== height) {
    _renderer.setSize(width, height, false);
    _camera.aspect = width / Math.max(height, 1);
    _camera.updateProjectionMatrix();
    resizeComposer(width, height);
  }

  // Pan/zoom changes which bars getVisibleRange() considers "in view" even
  // though it touches neither the plot3d series data nor its length/last
  // value — the only signal mark3DSceneDirty()'s caller watches. Without
  // this, scrolling in 3D mode moves the camera around the same frozen set
  // of candles forever instead of swapping in the newly-scrolled-to bars.
  const { start, end } = getVisibleRange(view, width, bars.length);
  const visibleRangeKey = `${start}|${end}|${bars.length}`;
  if (visibleRangeKey !== _lastVisibleRangeKey) {
    _lastVisibleRangeKey = visibleRangeKey;
    _rebuildNeeded = true;
    if (_barGroup) { _scene.remove(_barGroup); disposeMesh(_barGroup); _barGroup = null; }
  }

  const didRebuild = _rebuildNeeded;
  if (_rebuildNeeded) {
    _rebuildNeeded = false;
    clearViz();

    if (!_barGroup || _barGroup.children.length === 0) {
      const bg = buildBarGroup(bars, view, width);
      if (bg) { _barGroup = bg; _scene.add(_barGroup); }
    }
    const mainCage = buildMainInstrumentCage(bars, view, width);
    if (mainCage) _scene.add(mainCage);

    const visibleCount = end - start + 1;

    // Build indicator geometry. z_level controls DEPTH separation so parallel
    // level-lines (fibs/pivots) stay cleanly spaced instead of overlapping
    // into a rope: layers on different z_levels render on parallel Z planes,
    // and when NO z_level is given each layer auto-gets its own plane. Every
    // build function returns geometry centered at z=0, so we just offset the
    // returned object's position.z. (Previously z_level was silently ignored
    // here — every layer piled onto z=0.)
    const p3dLayers = plots.filter(p =>
      p.pane === '3d' && p.series.filter(v => isFinite(v) && !isNaN(v)).length >= 2);
    const anyLevel = p3dLayers.some(p => p.z_level !== undefined);
    const Z_SPACING = _vis.zSpacing;
    // Cumulative, magnitude-respecting spacing between DISTINCT z_levels —
    // same rationale as three-lower-pane.ts's zOffsets: "0, 1, 2, …" (the
    // documented convention) renders identically to before, but a script
    // that deliberately spaces levels wide (0 and 10) now actually gets
    // that instead of collapsing to rank-only spacing.
    const zKeys = anyLevel
      ? [...new Set(p3dLayers.map(p => p.z_level ?? 0))].sort((a, b) => a - b)
      : p3dLayers.map((_, i) => i);
    const zPlaneByKey = new Map<number, number>();
    let zCursor = 0;
    zKeys.forEach((key, idx) => {
      if (idx === 0) { zPlaneByKey.set(key, 0); zCursor = 0; return; }
      zCursor += Math.max(Z_SPACING, (key - zKeys[idx - 1]) * Z_SPACING);
      zPlaneByKey.set(key, zCursor);
    });
    const zCenter = zCursor / 2; // center the stack around z=0
    // Same-key collision count — TWO layers sharing one z_level used to
    // render at the exact same Z (true overlap, not even a Z-fight gap,
    // since indexOf(zKey) is identical for both). Give repeats after the
    // first a real, visible push instead.
    const zKeyOccurrence = new Map<number, number>();
    for (let pi = 0; pi < p3dLayers.length; pi++) {
      const p = p3dLayers[pi];
      // Slice to the VISIBLE bar window so series index i maps to visible
      // bar i (builders compress their input across the visible range).
      // Feeding full-history series here shifted geometry relative to the
      // bars on scroll, and pre-filtering NaNs compressed warmup bars out
      // of the time axis.
      const series = p.series.slice(start, end + 1);
      const col = typeof p.color === 'string' ? p.color : '#b48cff';
      // Price-denominated? If most values sit inside the visible price
      // range, map on the bars' price scale so the geometry hugs price.
      {
        const vis = visibleBars(bars, view, width);
        const { min: pMin, range: pRg } = normRange(vis.length ? vis : bars);
        const finite = series.filter(v => isFinite(v));
        const inside = finite.filter(v => v >= pMin - pRg * 0.15 && v <= pMin + pRg * 1.15).length;
        _yPriceMap = finite.length > 0 && inside / finite.length >= 0.7 ? { min: pMin, range: pRg } : null;
      }
      const zKey = anyLevel ? (p.z_level ?? 0) : pi;
      const occurrence = zKeyOccurrence.get(zKey) ?? 0;
      zKeyOccurrence.set(zKey, occurrence + 1);
      // Price-level lines/ribbons (Fibonacci retracements, session extremes,
      // price EMAs) are ALREADY separated vertically in Y by their price.
      // Spreading them across Z (-3..+3) pushes them off the candles across
      // the floor. Keep price-scaled lines/ribbons hugging the candle plane!
      const isPriceLine = _yPriceMap !== null && (p.style === 'line3d' || p.style === 'ribbon');
      const isPriceLevel = _yPriceMap !== null && p.style === 'line3d';
      const isCenteredTorus = p.style === 'torus';
      const zPlane = isCenteredTorus
        ? 0
        : isPriceLevel
          ? 0
          : isPriceLine
            ? 0.22 + pi * 0.04
            : (zPlaneByKey.get(zKey) ?? 0) - zCenter + occurrence * 0.6;

      let obj: THREE.Object3D | null = null;
      switch (p.style) {
        case 'surface': case 'wireframe': case 'mesh':
          obj = buildSurfaceFromSeries(series, view, width, col, visibleCount); break;
        case 'ribbon': case 'line3d':
          obj = buildRibbonFromSeries(series, view, width, col, visibleCount, p.style === 'line3d'); break;
        case 'bars3d':
          obj = buildBarsFromSeries(series, view, width, col, visibleCount); break;
        case 'scatter':
          obj = buildScatterFromSeries(series, view, width, col, visibleCount); break;
        case 'helix':
          obj = buildHelixFromSeries(series, view, width, col, visibleCount); break;
        case 'manifold':
          obj = buildManifoldFromSeries(series, view, width, col, visibleCount); break;
        case 'trail':
          obj = buildTrailFromSeries(series, view, width, col, visibleCount); break;
        case 'vortex':
          obj = buildVortexFromSeries(series, view, width, col, visibleCount); break;
        case 'nebula':
          obj = buildNebulaFromSeries(series, view, width, col, visibleCount); break;
        case 'constellation':
          obj = buildConstellationFromSeries(series, view, width, col, visibleCount); break;
        case 'torus':
          obj = buildTorusFromSeries(series, view, width, col, visibleCount, pi); break;
        case 'ridgeline':
          obj = buildRidgelineFromSeries(series, view, width, visibleCount); break;
      }
      if (obj) { obj.position.z += zPlane; _scene.add(obj); }
      if (obj && isPriceLevel) {
        // Levels sit on the candle plane, so they draw over the bodies rather
        // than being hidden inside them.
        obj.traverse(o => {
          if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
          o.material.depthTest = false;
          o.renderOrder = 10;
        });
      }
    }

    // ── Render 3D shapes (plotshape_3d with pane="3d") ──
    if (shapes) {
      const visible = visibleBars(bars, view, width);
      if (visible.length > 0) {
        const { min: minP, max: maxP, range: pRange } = normRange(visible);
        const halfW = width * 0.5;
        const total = visible.length;
        const isPriceAligned = (price: number | undefined): boolean =>
          typeof price === 'number' && isFinite(price)
          && price >= minP - pRange * 0.5 && price <= maxP + pRange * 0.5;
        const shapeZ = (zLevel: number | undefined, price?: number): number => {
          if (isPriceAligned(price)) return 0.28;
          const key = zLevel ?? 0;
          const known = zPlaneByKey.get(key);
          return (known ?? key * Z_SPACING) - zCenter;
        };
        let labelBudget = 4;
        // Declutter: keep only the MOST RECENT visible occurrence of each
        // distinct label text (newest wins) and avoid close spatial overlap.
        const seenLabelTexts = new Set<string>();
        const placedLabels: Array<{ text: string; x: number; y: number }> = [];
        for (let li = shapes.length - 1; li >= 0 && labelBudget > 0; li--) {
          const sp = shapes[li];
          if (sp.type !== 'plot3d_label' || sp.pane !== '3d' || !sp.text) continue;
          const vi = (sp.barIdx ?? 0) - start;
          if (vi < 0 || vi >= total) continue;
          if (seenLabelTexts.has(sp.text)) continue;
          const px = barX(vi, total, width, view.barSpacing, view.scrollX);
          const x = ((px - halfW) / halfW) * 5;
          const y = ((sp.price ?? minP) - minP) / pRange * 6 - 3 + 0.42;
          if (placedLabels.some(pl => Math.abs(pl.x - x) < 1.2 && Math.abs(pl.y - y) < 0.5)) continue;
          seenLabelTexts.add(sp.text);
          placedLabels.push({ text: sp.text, x, y });
          labelBudget--;
          const sprite = makeTextSprite(sp.text, sp.color ?? '#ffffff', Math.min(1.0, sp.size ?? 0.9));
          sprite.position.set(x, y, shapeZ(sp.z_level, sp.price));
          sprite.renderOrder = 20;
          _scene.add(sprite);
        }
        for (const sp of shapes) {
          if (sp.type !== 'plot3d_shape' || sp.pane !== '3d') continue;
          const barIdx = sp.barIdx ?? 0;
          const vi = barIdx - start;
          if (vi < 0 || vi >= total) continue;
          const px = barX(vi, total, width, view.barSpacing, view.scrollX);
          const x = ((px - halfW) / halfW) * 5;
          const y = ((sp.price ?? minP) - minP) / pRange * 6 - 3;
          const z = shapeZ(sp.z_level, sp.price);
          const s = Math.max(0.45, Math.min(1.0, sp.size ?? 0.8)) * _vis.markerScale;
          // 3D image billboard (plotimage_3d) — resolved from the shared
          // sync-read image decode cache; skip the geometry switch entirely.
          if (sp.shape3d === 'image') {
            const img = resolveImage(sp.imageRef ?? '');
            if (img) {
              const tex = new THREE.Texture(img);
              tex.needsUpdate = true;
              const aspect = img.width && img.height ? img.width / img.height : 1;
              const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
              sprite.scale.set(s * 0.6 * aspect, s * 0.6, 1);
              sprite.position.set(x, y, z);
              _scene.add(sprite);
            }
            continue;
          }
          let geometry: THREE.BufferGeometry;
          switch (sp.shape3d) {
            case 'cube': geometry = new THREE.BoxGeometry(s * 0.22, s * 0.22, s * 0.22); break;
            case 'sphere': geometry = new THREE.SphereGeometry(s * 0.16, 8, 6); break;
            case 'pyramid': geometry = new THREE.ConeGeometry(s * 0.18, s * 0.28, 4); break;
            case 'torus': geometry = new THREE.TorusGeometry(s * 0.16, s * 0.05, 6, 8); break;
            case 'diamond': geometry = new THREE.OctahedronGeometry(s * 0.18); break;
            case 'coneup': case 'conedown': geometry = new THREE.ConeGeometry(s * 0.12, s * 0.28, 12); break;
            default: geometry = new THREE.BoxGeometry(s * 0.2, s * 0.2, s * 0.2);
          }
          const col = new THREE.Color(sp.color ?? '#b48cff');
          const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
            color: col, emissive: col.clone().multiplyScalar(0.25 * _vis.emissiveScale),
            specular: 0x222244, shininess: 60,
          }));
          // Signal cones: offset from the bar (gap scales with size), tip
          // pointing AT the price — coneup below, conedown flipped above.
          let yOff = 0;
          let baseRotZ = 0;
          if (sp.shape3d === 'coneup') { yOff = -(0.20) * s * _vis.markerGap; }
          else if (sp.shape3d === 'conedown') { yOff = (0.20) * s * _vis.markerGap; baseRotZ = Math.PI; }
          const d2r = Math.PI / 180;
          mesh.rotation.set((sp.rx ?? 0) * d2r, (sp.ry ?? 0) * d2r, baseRotZ + (sp.rz ?? 0) * d2r);
          mesh.position.set(x, y + yOff, z);
          mesh.renderOrder = 20;
          _scene.add(mesh);
        }
      }
    }
  }

  // Content-fit AFTER the rebuild placed everything: aspect-stretch always
  // (children are freshly created each rebuild), camera refit only when the
  // content identity changed (see fitAndStretchMainScene).
  if (didRebuild) {
    fitAndStretchMainScene(plots.map(p => `${p.name}|${p.style}|${p.pane}`).join(';'));
  }

  applyOrbitCam();
  _renderTime = performance.now();
  renderFrame();
}

export function dispose3DScene(): void {
  _chart3DMode = false;
  _rebuildNeeded = true;
  _barGroup = null;
  _lastVisibleRangeKey = null;
  _lastMainFitSig = null;
  _orbitTheta = -0.16; _orbitPhi = 1.24; _orbitDist = 14;
  _orbitTarget.set(0, 0, 0);
  disableOrbitMain();
  disposeViz();
}

// ─── ISO-COMPOSITE MODE (Option B) ──────────────────────────────────
// The isometric canvas (iso3d.ts) stays the BASE scene — the candles the
// user knows and loves render there in 2D. This module then renders the
// GENUINE GL geometry for plot3d indicators on a transparent overlay canvas
// in the SAME screen rect, with a projection aligned to iso's cabinet
// math (depth axis recedes up-left at ISO_ANGLE, DEPTH_SCALE 0.62).
//
// Alignment contract (both sides must agree):
//   x: barX(i) screen px → world x = (px/halfW - 1) * 5   (same as chart3D)
//   y: price → world y = (price - minP)/pRange * 6 - 3     (same as chart3D)
//   z: iso depth offsets px by z*ISO_COS*0.62 horizontally and z*ISO_SIN*0.62
//      vertically. A camera rotated to iso's own angle reproduces that
//      shearing EXACTLY in GL, so GL shapes at (x, y, z) land on the same
//      pixels iso3d would have drawn them.
let _isoHost: (() => HTMLElement | null) | null = null;
let _isoActive = false;
// MUST equal iso3d.ts's ISO_ANGLE (Math.PI / 6.5, ~27.7°) — the composite
// camera is rotated by exactly this much to reproduce iso's cabinet shear.
const ISO_ANGLE = Math.PI / 6.5;

/** Mount the GL overlay onto a host element (the mobile iso chart area). */
export function setIsoCompositeHost(host: (() => HTMLElement | null) | null): void {
  _isoHost = host;
  if (!host) { _isoActive = false; disposeViz(); }
}

function getIsoCanvas(): HTMLCanvasElement {
  let c = document.getElementById(CANVAS_ID) as HTMLCanvasElement;
  if (!c) {
    c = document.createElement('canvas');
    c.id = CANVAS_ID;
    Object.assign(c.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      zIndex: '11', pointerEvents: 'none',
    });
    const host = _isoHost?.() ?? document.getElementById('chart-canvas')?.parentElement;
    if (host) host.appendChild(c);
  }
  return c;
}

/**
 * Render the GL indicator overlay for the ISO-COMPOSITE mode.
 * bars/view/width/height mirror renderMain3DScene's contract; the candles
 * themselves are NOT drawn here — iso3d draws them on its own canvas below.
 */
export function renderIsoOverlay3D(
  bars: BaseBar[],
  plots: OakPlot3D[],
  view: ViewState,
  width: number,
  height: number,
  shapes?: OakPlot[],
): void {
  if (plots.length === 0) { if (_isoActive) { disposeViz(); _isoActive = false; } return; }
  const canvas = getIsoCanvas();
  if (!_initialized || !_isoActive || !_renderer) {
    if (!_initialized) {
      init();
    }
    _isoActive = true;
    _chart3DMode = false; // NOT the unified bars+viz scene — overlay only
    _rebuildNeeded = true;
    _barGroup = null;     // never draw GL candles in composite mode
    if (_scene) {
      _scene.background = null;
      if (_renderer) _renderer.setClearColor(0x000000, 0); // fully transparent
    }
    canvas.style.pointerEvents = 'none';
    disableOrbitMain(); // iso owns the gestures; the overlay never intercepts
  }
  if (!_scene || !_camera || !_renderer) return;

  if (canvas.width !== width || canvas.height !== height) {
    _renderer.setSize(width, height, false);
    _camera.aspect = width / Math.max(height, 1);
    _camera.updateProjectionMatrix();
    resizeComposer(width, height);
  }

  // Camera: reproduce iso3d's cabinet shearing. Iso depth (z) offsets screen
  // pixels by (-z*COS*0.62, -z*SIN*0.62); a camera positioned along the
  // direction that produces that same shear maps world (x,y,z) onto the
  // iso canvas in register. Phi/theta chosen so the perspective vanishing
  // matches iso's up-left recede.
  _orbitTheta = Math.PI - ISO_ANGLE; // depth recedes to the LEFT
  _orbitPhi = Math.PI / 2 - ISO_ANGLE * 0.55; // up-tilt mirrors iso's y-shear
  _orbitTarget.set(0, 0, 0);
  _orbitDist = 18;
  applyOrbitCam();

  const { start, end } = getVisibleRange(view, width, bars.length);
  const visibleRangeKey = `${start}|${end}|${bars.length}|ISO`;
  if (visibleRangeKey !== _lastVisibleRangeKey) {
    _lastVisibleRangeKey = visibleRangeKey;
    _rebuildNeeded = true;
  }

  const didRebuild = _rebuildNeeded;
  if (_rebuildNeeded) {
    _rebuildNeeded = false;
    clearViz();
    if (_barGroup) { _scene.remove(_barGroup); disposeMesh(_barGroup); _barGroup = null; }

    const visibleCount = end - start + 1;
    // Same z-plane separation as chart3D so multi-layer scripts keep their
    // documented depth spacing in the composite too.
    const p3dLayers = plots.filter(p =>
      p.pane === '3d' && p.series.filter(v => isFinite(v) && !isNaN(v)).length >= 2);
    const anyLevel = p3dLayers.some(p => p.z_level !== undefined);
    const Z_SPACING = 2.0;
    const zKeys = anyLevel
      ? [...new Set(p3dLayers.map(p => p.z_level ?? 0))].sort((a, b) => a - b)
      : p3dLayers.map((_, i) => i);
    const zPlaneByKey = new Map<number, number>();
    let zCursor = 0;
    zKeys.forEach((key, idx) => {
      if (idx === 0) { zPlaneByKey.set(key, 0); zCursor = 0; return; }
      zCursor += Math.max(Z_SPACING, (key - zKeys[idx - 1]) * Z_SPACING);
      zPlaneByKey.set(key, zCursor);
    });
    const zCenter = zCursor / 2;

    for (let pi = 0; pi < p3dLayers.length; pi++) {
      const p = p3dLayers[pi];
      const series = p.series.filter(v => isFinite(v) && !isNaN(v));
      const col = typeof p.color === 'string' ? p.color : '#b48cff';
      const zKey = anyLevel ? (p.z_level ?? 0) : pi;
      const zPlane = (zPlaneByKey.get(zKey) ?? 0) - zCenter;
      let obj: THREE.Object3D | null = null;
      switch (p.style) {
        case 'surface': case 'wireframe': case 'mesh':
          obj = buildSurfaceFromSeries(series, view, width, col, visibleCount); break;
        case 'ribbon': case 'line3d':
          obj = buildRibbonFromSeries(series, view, width, col, visibleCount, p.style === 'line3d'); break;
        case 'bars3d':
          obj = buildBarsFromSeries(series, view, width, col, visibleCount); break;
        case 'scatter':
          obj = buildScatterFromSeries(series, view, width, col, visibleCount); break;
        case 'helix':
          obj = buildHelixFromSeries(series, view, width, col, visibleCount); break;
        case 'manifold':
          obj = buildManifoldFromSeries(series, view, width, col, visibleCount); break;
        case 'trail':
          obj = buildTrailFromSeries(series, view, width, col, visibleCount); break;
        case 'vortex':
          obj = buildVortexFromSeries(series, view, width, col, visibleCount); break;
        case 'nebula':
          obj = buildNebulaFromSeries(series, view, width, col, visibleCount); break;
        case 'constellation':
          obj = buildConstellationFromSeries(series, view, width, col, visibleCount); break;
        case 'torus':
          obj = buildTorusFromSeries(series, view, width, col, visibleCount); break;
        case 'ridgeline':
          obj = buildRidgelineFromSeries(series, view, width, visibleCount); break;
      }
      if (obj) { obj.position.z += zPlane; _scene.add(obj); }
    }

    if (shapes && shapes.length > 0) {
      const visible = visibleBars(bars, view, width);
      if (visible.length > 0) {
        const { min: minP, max: maxP, range: pRange } = normRange(visible);
        const halfW = width * 0.5;
        const total = visible.length;
        const shapeZ = (zLevel: number | undefined): number => {
          const key = zLevel ?? 0;
          const known = zPlaneByKey.get(key);
          return (known ?? key * Z_SPACING) - zCenter;
        };
        let labelBudget = 40;
        const placedLabels: Array<{ text: string; x: number; y: number }> = [];
        for (const sp of shapes) {
          if (sp.type !== 'plot3d_label' || sp.pane !== '3d' || !sp.text) continue;
          const vi = (sp.barIdx ?? 0) - start;
          if (vi < 0 || vi >= total) continue;
          const px = barX(vi, total, width, view.barSpacing, view.scrollX);
          const x = ((px - halfW) / halfW) * 5;
          const y = ((sp.price ?? minP) - minP) / pRange * 6 - 3 + 0.4;
          if (placedLabels.some(pl => pl.text === sp.text && Math.abs(pl.x - x) < 1.0 && Math.abs(pl.y - y) < 0.6)) continue;
          placedLabels.push({ text: sp.text, x, y });
          labelBudget--;
          const sprite = makeTextSprite(sp.text, sp.color ?? '#ffffff', sp.size ?? 1);
          sprite.position.set(x, y, shapeZ(sp.z_level));
          _scene.add(sprite);
        }
        for (const sp of shapes) {
          if (sp.type !== 'plot3d_shape' || sp.pane !== '3d') continue;
          const barIdx = sp.barIdx ?? 0;
          const vi = barIdx - start;
          if (vi < 0 || vi >= total) continue;
          const px = barX(vi, total, width, view.barSpacing, view.scrollX);
          const x = ((px - halfW) / halfW) * 5;
          const y = ((sp.price ?? minP) - minP) / pRange * 6 - 3;
          const z = shapeZ(sp.z_level);
          const s = sp.size ?? 1;
          if (sp.shape3d === 'image') {
            const img = resolveImage(sp.imageRef ?? '');
            if (img) {
              const tex = new THREE.Texture(img);
              tex.needsUpdate = true;
              const aspect = img.width && img.height ? img.width / img.height : 1;
              const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
              sprite.scale.set(s * 0.6 * aspect, s * 0.6, 1);
              sprite.position.set(x, y, z);
              _scene.add(sprite);
            }
            continue;
          }
          let geometry: THREE.BufferGeometry;
          switch (sp.shape3d) {
            case 'cube': geometry = new THREE.BoxGeometry(s * 0.3, s * 0.3, s * 0.3); break;
            case 'sphere': geometry = new THREE.SphereGeometry(s * 0.2, 8, 6); break;
            case 'pyramid': geometry = new THREE.ConeGeometry(s * 0.25, s * 0.35, 4); break;
            case 'torus': geometry = new THREE.TorusGeometry(s * 0.2, s * 0.07, 6, 8); break;
            case 'diamond': geometry = new THREE.OctahedronGeometry(s * 0.25); break;
            case 'coneup': case 'conedown': geometry = new THREE.ConeGeometry(s * 0.22, s * 0.5, 12); break;
            default: geometry = new THREE.BoxGeometry(s * 0.25, s * 0.25, s * 0.25);
          }
          const col = new THREE.Color(sp.color ?? '#b48cff');
          const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
            color: col, emissive: col.clone().multiplyScalar(0.2),
            specular: 0x222244, shininess: 60,
          }));
          let yOff = 0;
          let baseRotZ = 0;
          if (sp.shape3d === 'coneup') { yOff = -(0.15 + 0.25) * s; }
          else if (sp.shape3d === 'conedown') { yOff = (0.15 + 0.25) * s; baseRotZ = Math.PI; }
          const d2r = Math.PI / 180;
          mesh.rotation.set((sp.rx ?? 0) * d2r, (sp.ry ?? 0) * d2r, baseRotZ + (sp.rz ?? 0) * d2r);
          mesh.position.set(x, y + yOff, z);
          _scene.add(mesh);
        }
      }
    }
  }

  // ISO-COMPOSITE: never content-fit/stretch — the overlay must stay in
  // exact register with the iso canvas beneath, which does no such fitting.
  applyOrbitCam();
  _renderTime = performance.now();
  renderFrame();
}

/** True while the ISO-composite overlay owns the GL canvas. */
export function isIsoCompositeActive(): boolean { return _isoActive; }
