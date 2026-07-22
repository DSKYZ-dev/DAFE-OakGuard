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

// ─── Bloom post-processing ──────────────────────────────────────────
// Every scene here is built from MeshPhongMaterial with emissive colors —
// authored for glow that was never actually rendered. UnrealBloomPass adds
// it: threshold keeps the bloom off flat unlit surfaces/grid lines (which
// sit well below it) so only the emissive geometry blooms, not the whole
// frame.
const BLOOM_STRENGTH = 0.7;
const BLOOM_RADIUS = 0.45;
const BLOOM_THRESHOLD = 0.15;

function setupComposer(w: number, h: number): void {
  if (!_renderer || !_scene || !_camera) return;
  _composer = new EffectComposer(_renderer);
  _composer.addPass(new RenderPass(_scene, _camera));
  _bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
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

function isSceneDecoration(obj: THREE.Object3D): boolean {
  return obj instanceof THREE.Light || obj instanceof THREE.GridHelper;
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

function stretchMainContentX(k: number): void {
  if (!_scene) return;
  for (const child of _scene.children) {
    if (isSceneDecoration(child)) continue;
    child.position.x *= k;
    child.scale.x *= k;
    child.traverse(o => { if (o instanceof THREE.Sprite) o.scale.x /= k; });
  }
}

function fitAndStretchMainScene(contentSig: string): void {
  if (!_scene || !_camera) return;
  const aspect = _camera.aspect;
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
  // Box-face fit + 0.75×depth margin — fills the frame while keeping the
  // tilted orbit camera outside the content's front face (see the lower
  // pane's twin of this logic for why both fit extremes failed).
  const s = fitted.getSize(new THREE.Vector3());
  const center = fitted.getCenter(new THREE.Vector3());
  const vHalf = (_camera.fov * Math.PI / 180) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  const dV = (s.y / 2) / Math.tan(vHalf);
  const dH = (s.x / 2) / Math.tan(hHalf);
  _orbitDist = Math.max(4, Math.min(50, Math.max(dV, dH) * 1.1 + s.z * 0.75));
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
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _renderer.toneMapping = THREE.ACESFilmicToneMapping;
  _renderer.toneMappingExposure = 1.2;

  _scene = new THREE.Scene();
  _scene.background = null;

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
let _orbitTheta = 0, _orbitPhi = 1.0, _orbitDist = 18;
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
    _orbitTheta -= (e.clientX - _orbitLX) * 0.008;
    _orbitPhi = Math.max(0.15, Math.min(1.5, _orbitPhi - (e.clientY - _orbitLY) * 0.008));
    _orbitLX = e.clientX; _orbitLY = e.clientY;
    applyOrbitCam();
    renderFrame();
  };
  c.onpointerup = () => { _orbitDragging = false; if (c) c.style.cursor = 'grab'; };
  c.onwheel = (e: WheelEvent) => {
    if (!_camera) return;
    _orbitDist = Math.max(4, Math.min(50, _orbitDist + e.deltaY * 0.02));
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

// ─── 3D price bar group builder ─────────────────────────────

function buildBarGroup(bars: BaseBar[], view: ViewState, width: number): THREE.Group | null {
  const visible = visibleBars(bars, view, width);
  if (visible.length < 1) return null;
  const { min: minP, max: maxP, range: pRange } = normRange(visible);
  const halfW = width * 0.5;
  const total = visible.length;
  const maxV = Math.max(...visible.map(b => b.volume), 1);
  const group = new THREE.Group();
  const depthScale = 0.8;

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
    const bw = 0.12 + vs * 0.2;
    const bd = depthScale * 0.3 + vs * depthScale * 0.2;

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
        new THREE.BoxGeometry(0.035, wickH, 0.035),
        new THREE.MeshPhongMaterial({ color: col, emissive: em, transparent: true, opacity: 0.6 })
      );
      wick.position.set(xNorm, bodyTop + wickH / 2, 0);
      group.add(wick);
    }

    // Lower wick: from body bottom to low
    if (bodyBot - lY > 0.01) {
      const wickH = bodyBot - lY;
      const wick = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, wickH, 0.035),
        new THREE.MeshPhongMaterial({ color: col, emissive: em, transparent: true, opacity: 0.6 })
      );
      wick.position.set(xNorm, lY + wickH / 2, 0);
      group.add(wick);
    }
  }
  return group;
}

// ─── Series-level geometry builders for plot3d data ─────────

function seriesNorm(series: number[], view: ViewState, width: number, _totalBars: number): { vals: number[]; sMin: number; sMax: number; sRange: number } {
  const vals = series.filter(v => isFinite(v) && !isNaN(v));
  const sMin = Math.min(...vals, 0);
  const sMax = Math.max(...vals, 1);
  return { vals, sMin, sMax, sRange: sMax - sMin || 1 };
}

function seriesX(i: number, count: number, view: ViewState, width: number, visibleCount?: number): number {
  const halfW = width * 0.5;
  const vc = visibleCount ?? count;
  // Map compressed index to actual visible bar index so geometry aligns with bars
  const barIdx = count > 1 ? Math.round((i / (count - 1)) * (vc - 1)) : 0;
  const px = barX(barIdx, vc, width, view.barSpacing, view.scrollX);
  return ((px - halfW) / halfW) * 5;
}

function seriesY(val: number, sMin: number, sRange: number): number {
  return ((val - sMin) / sRange) * 6 - 3;
}

function buildSurfaceFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Mesh | null {
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const count = Math.min(vals.length, 100);
  const segments = count, depth = 20;
  const verts: number[] = [], idx: number[] = [], cols: number[] = [];
  const baseCol = new THREE.Color(color);

  for (let xi = 0; xi < segments; xi++) {
    const vi = Math.floor((xi / (segments - 1)) * (vals.length - 1));
    const x = seriesX(xi, segments, view, width, visibleCount);
    const val = seriesY(vals[vi], sMin, sRange);
    for (let di = 0; di < depth; di++) {
      const d = Math.abs((di / (depth - 1)) - 0.5) * 2;
      const z = (di / (depth - 1)) * 2 - 1;
      verts.push(x, val + (1 - d * 0.9) * 0.4, z);
      const c = baseCol.clone().lerp(new THREE.Color(0x000000), d * 0.3);
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
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const step = Math.max(1, Math.floor(vals.length / 150));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < vals.length; i += step)
    pts.push(new THREE.Vector3(seriesX(i, vals.length, view, width, visibleCount), seriesY(vals[i], sMin, sRange), 0));
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
  return new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, straight ? 0.03 : 0.06, 6, false),
    new THREE.MeshPhongMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color).multiplyScalar(0.15), shininess: 50 }));
}

function buildBarsFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 2) return null;
  const count = Math.min(vals.length, 80);
  const bw = 10 / count * 0.5;
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
    const h = Math.max(0.05, ((vals[vi] - sMin) / sRange) * 3);
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bw), new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.15), shininess: 30 }));
    b.position.set(seriesX(i, count, view, width, visibleCount), seriesY(vals[vi], sMin, sRange), 0);
    group.add(b);
  }
  return group;
}

function buildScatterFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 2) return null;
  const count = Math.min(vals.length, 120);
  const group = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
    const frac = (vals[vi] - sMin) / sRange;
    const hue = (1 - frac) * 0.35;
    const c = new THREE.Color().setHSL(hue, 0.75, 0.45 + frac * 0.25);
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.04 + Math.random() * 0.04, 5, 4),
      new THREE.MeshPhongMaterial({ color: c, emissive: c.clone().multiplyScalar(0.2), shininess: 40 }));
    s.position.set(seriesX(i, count, view, width, visibleCount) + (Math.random() - 0.5) * 0.2, seriesY(vals[vi], sMin, sRange) + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3);
    group.add(s);
  }
  return group;
}

function buildHelixFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 4) return null;
  const count = vals.length, twists = 3, radius = 0.6;
  const s1: THREE.Vector3[] = [], s2: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const x = seriesX(i, count, view, width, visibleCount);
    const y = seriesY(vals[i], sMin, sRange);
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
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 5) return null;
  const count = Math.min(vals.length, 60), longs = 6, mw = 1.0;
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  for (let l = 0; l < longs; l++) {
    const lf = l / (longs - 1);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
      const x = seriesX(i, count, view, width, visibleCount);
      const y = seriesY(vals[vi], sMin, sRange);
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
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const count = Math.min(vals.length, 80);
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  const maxV = Math.max(...vals.map(Math.abs), 1);
  const upper: THREE.Vector3[] = [], lower: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
    const x = seriesX(i, count, view, width, visibleCount);
    const y = seriesY(vals[vi], sMin, sRange);
    const w = 0.06 + (Math.abs(vals[vi]) / maxV) * 0.35;
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
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 4) return null;
  const count = Math.min(vals.length, 100), spirals = 6, maxR = 1.6;
  const group = new THREE.Group();
  for (let s = 0; s < spirals; s++) {
    const phase = (s / spirals) * Math.PI * 2;
    const hue = (s / spirals) * 0.8;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
      const x = seriesX(i, count, view, width, visibleCount);
      const y = seriesY(vals[vi], sMin, sRange);
      const pct = i / count;
      // Spiral tightens toward the most recent bar — visually reads as
      // "converging" when the underlying series stays coherent/aligned.
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
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const count = Math.min(vals.length, 60), perBar = 7;
  const group = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
    const x = seriesX(i, count, view, width, visibleCount);
    const y = seriesY(vals[vi], sMin, sRange);
    const frac = (vals[vi] - sMin) / sRange;
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
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const count = Math.min(vals.length, 80);
  const group = new THREE.Group();
  const positions: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
    positions.push(new THREE.Vector3(seriesX(i, count, view, width, visibleCount), seriesY(vals[vi], sMin, sRange), 0));
  }
  // Connect nearby points only — dense clusters read as "strongly correlated",
  // sparse/unconnected stretches read as "structure breaking down".
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
    const star = new THREE.Mesh(new THREE.SphereGeometry(0.035 + Math.random() * 0.05, 6, 5),
      new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x8844ff, emissiveIntensity: 0.4 + Math.random() * 0.5 }));
    star.position.copy(pos);
    group.add(star);
  }
  return group;
}

function buildTorusFromSeries(series: number[], view: ViewState, width: number, color: string, visibleCount?: number): THREE.Group | null {
  const { vals, sMin, sRange } = seriesNorm(series, view, width, 0);
  if (vals.length < 3) return null;
  const count = Math.min(vals.length, 70);
  const maxV = Math.max(...vals.map(Math.abs), 1);
  const group = new THREE.Group();
  const col = new THREE.Color(color);
  const centerPts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
    const x = seriesX(i, count, view, width, visibleCount);
    const y = seriesY(vals[vi], sMin, sRange);
    centerPts.push(new THREE.Vector3(x, y, 0));
    const mag = Math.abs(vals[vi]) / maxV;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18 + mag * 0.35, 0.018 + mag * 0.025, 6, 10),
      new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.25), transparent: true, opacity: 0.4 + mag * 0.35 }));
    ring.position.set(x, y, 0);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
  }
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(centerPts), count, 0.02, 6, false),
    new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x442288, transparent: true, opacity: 0.3 })));
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
  shapes?: OakPlot[]
): void {
  if (!_initialized || !_chart3DMode) {
    _chart3DMode = true;
    initChart3D();
    _rebuildNeeded = true;
  }
  if (!_scene || !_camera || !_renderer) return;

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
    const zKeys = anyLevel
      ? [...new Set(p3dLayers.map(p => p.z_level ?? 0))].sort((a, b) => a - b)
      : p3dLayers.map((_, i) => i);
    const Z_SPACING = 2.0;
    const zCenter = ((zKeys.length - 1) / 2) * Z_SPACING; // center the stack around z=0
    for (let pi = 0; pi < p3dLayers.length; pi++) {
      const p = p3dLayers[pi];
      const series = p.series.filter(v => isFinite(v) && !isNaN(v));
      const col = typeof p.color === 'string' ? p.color : '#b48cff';
      const zKey = anyLevel ? (p.z_level ?? 0) : pi;
      const zPlane = zKeys.indexOf(zKey) * Z_SPACING - zCenter;

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

    // ── Render 3D shapes (plotshape_3d with pane="3d") ──
    if (shapes) {
      const visible = visibleBars(bars, view, width);
      if (visible.length > 0) {
        const { min: minP, max: maxP, range: pRange } = normRange(visible);
        const halfW = width * 0.5;
        const total = visible.length;
        let labelBudget = 40;
        // Declutter: skip same-text labels that would land on top of an
        // already-placed one (newest wins) — dense signal runs otherwise
        // stack "BULL FIB" dozens of times into unreadable towers.
        const placedLabels: Array<{ text: string; x: number; y: number }> = [];
        for (let li = shapes.length - 1; li >= 0 && labelBudget > 0; li--) {
          const sp = shapes[li];
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
          sprite.position.set(x, y, (sp.z_level ?? 0) * 0.3);
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
          const z = (sp.z_level ?? 0) * 0.3;
          const s = sp.size ?? 1;
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
          // Signal cones: offset from the bar (gap scales with size), tip
          // pointing AT the price — coneup below, conedown flipped above.
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
  _orbitTheta = 0; _orbitPhi = 1.0; _orbitDist = 18;
  _orbitTarget.set(0, 0, 0);
  disableOrbitMain();
  disposeViz();
}
