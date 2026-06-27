/**
 * 3D Indicator Visualizations — Surface, Ribbon, Scatter, Wireframe, Mesh
 * Uses Three.js for real-time 3D rendering overlaid on chart data
 */
import * as THREE from 'three';
import type { BaseBar } from '@dafe/types';
import { type ViewState, getVisibleRange, barX, priceToY, chartRight, TOP_FRAC, BOT_FRAC } from './chart-renderer';

export type VizType = 'surface' | 'ribbon' | 'scatter' | 'wireframe' | 'bars3d' | 'line3d' | 'mesh';

const CANVAS_ID = 'three-viz-canvas';

let _renderer: THREE.WebGLRenderer | null = null;
let _scene: THREE.Scene | null = null;
let _camera: THREE.PerspectiveCamera | null = null;
let _activeViz: VizType = 'surface';
let _initialized = false;

export function setVizType(t: VizType) { _activeViz = t; }
export function getVizType(): VizType { return _activeViz; }
export function isViz3DActive(): boolean { return _initialized && !!_scene; }

function getCanvas(): HTMLCanvasElement {
  let c = document.getElementById(CANVAS_ID) as HTMLCanvasElement;
  if (!c) {
    c = document.createElement('canvas');
    c.id = CANVAS_ID;
    Object.assign(c.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      zIndex: '3', pointerEvents: 'none',
    });
    const container = document.getElementById('chart-canvas')?.parentElement;
    if (container) container.appendChild(c);
  }
  return c;
}

function init(): void {
  if (_initialized) return;
  const canvas = getCanvas();
  const w = canvas.parentElement?.clientWidth || window.innerWidth;
  const h = canvas.parentElement?.clientHeight || window.innerHeight;
  canvas.width = w; canvas.height = h;

  _renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  _renderer.setSize(w, h, false);
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  _scene = new THREE.Scene();

  _camera = new THREE.PerspectiveCamera(45, w / Math.max(h, 1), 0.1, 1000);
  _camera.position.set(0, 8, 15);
  _camera.lookAt(0, 0, 0);

  // Ambient + directional lights
  _scene.add(new THREE.AmbientLight(0x404060, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(5, 10, 5);
  _scene.add(dir);

  // Grid helper
  const grid = new THREE.GridHelper(20, 20, 0x333355, 0x1a1a33);
  _scene.add(grid);

  _initialized = true;
}

export function disposeViz(): void {
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  _scene = null;
  _camera = null;
  _initialized = false;
  const c = document.getElementById(CANVAS_ID);
  if (c) c.remove();
}

// ─── Builders ────────────────────────────────────────────────────

function surfacePlot(bars: BaseBar[], view: ViewState, width: number, height: number) {
  if (!_scene || !_camera) return;
  clearViz();

  const { start, end } = getVisibleRange(view, width, bars.length);
  const visible = bars.slice(Math.max(0, start), Math.min(bars.length, end + 1));
  if (visible.length < 2) return;

  const prices = visible.flatMap(b => [b.high, b.low]);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = maxP - minP || 1;

  const vols = visible.map(b => b.volume);
  const maxV = Math.max(...vols, 1);

  const segments = Math.min(visible.length, 100);
  const priceSteps = 40;

  // Build vertex grid
  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let xi = 0; xi < segments; xi++) {
    const idx = Math.floor((xi / segments) * visible.length);
    const bar = visible[Math.min(idx, visible.length - 1)];
    const xNorm = (xi / (segments - 1)) * 10 - 5; // -5 to 5 in 3D space
    const barPrice = bar.close;
    const barVol = bar.volume / maxV;

    for (let pi = 0; pi < priceSteps; pi++) {
      const price = minP + (pi / (priceSteps - 1)) * pRange;
      const distFromClose = Math.abs(price - barPrice) / (pRange * 0.1 + 0.0001);
      const z = (price - minP) / pRange * 6 - 3; // -3 to 3 height
      // Volume-weighted surface: peak at close, falloff based on distance + volume
      const y = (1 / (1 + distFromClose * distFromClose)) * barVol * 3;
      vertices.push(xNorm, y, z);

      // Color: green near close, fading to dark
      const c = new THREE.Color();
      c.setHSL(0.35, 0.8, 0.1 + (y / 3) * 0.6);
      colors.push(c.r, c.g, c.b);
    }
  }

  // Build triangle strip indices
  for (let xi = 0; xi < segments - 1; xi++) {
    for (let pi = 0; pi < priceSteps - 1; pi++) {
      const a = xi * priceSteps + pi;
      const b = a + 1;
      const c = (xi + 1) * priceSteps + pi;
      const d = c + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    transparent: true, opacity: 0.85,
    specular: 0x222244, shininess: 30,
    wireframe: _activeViz === 'wireframe',
  });
  const mesh = new THREE.Mesh(geom, mat);
  _scene.add(mesh);
}

function ribbonViz(bars: BaseBar[], view: ViewState, width: number, height: number) {
  if (!_scene) return;
  clearViz();

  const { start, end } = getVisibleRange(view, width, bars.length);
  const visible = bars.slice(Math.max(0, start), Math.min(bars.length, end + 1));
  if (visible.length < 2) return;

  const prices = visible.flatMap(b => [b.high, b.low]);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = maxP - minP || 1;

  // Ribbon bands around price — upper and lower bands add depth
  for (const band of [{ offset: 0.015, color: 0x22cc88 }, { offset: -0.015, color: 0xff4477 }]) {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < visible.length; i++) {
      const bar = visible[i];
      const x = barX(i - (start > 0 ? 0 : 0), visible.length, width, view.barSpacing, view.scrollX);
      const xNorm = (x / width) * 10 - 5;
      const price = bar.close * (1 + band.offset);
      const z = ((price - minP) / pRange) * 6 - 3;
      points.push(new THREE.Vector3(xNorm, 0.5, z));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeom = new THREE.TubeGeometry(curve, points.length * 2, 0.08, 8, false);
    const tubeMat = new THREE.MeshPhongMaterial({ color: band.color, transparent: true, opacity: 0.7, shininess: 60 });
    _scene.add(new THREE.Mesh(tubeGeom, tubeMat));
  }

  // Center price line
  const centerPts: THREE.Vector3[] = [];
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const x = barX(i, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = (x / width) * 10 - 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    centerPts.push(new THREE.Vector3(xNorm, 0.6, z));
  }
  const centerCurve = new THREE.CatmullRomCurve3(centerPts);
  const centerGeom = new THREE.TubeGeometry(centerCurve, centerPts.length * 2, 0.04, 6, false);
  const centerMat = new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x221133, shininess: 80 });
  _scene.add(new THREE.Mesh(centerGeom, centerMat));
}

function scatterViz(bars: BaseBar[], view: ViewState, width: number, height: number) {
  if (!_scene) return;
  clearViz();

  const { start, end } = getVisibleRange(view, width, bars.length);
  const visible = bars.slice(Math.max(0, start), Math.min(bars.length, end + 1));
  if (visible.length < 2) return;

  const prices = visible.flatMap(b => [b.high, b.low]);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = maxP - minP || 1;

  // Scatter each bar as a sphere, size = relative volume
  const vols = visible.map(b => b.volume);
  const maxV = Math.max(...vols, 1);

  const group = new THREE.Group();
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const x = barX(i - start, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = (x / width) * 10 - 5;
    const z = ((bar.close - minP) / pRange) * 6 - 3;
    const size = Math.max(0.06, (bar.volume / maxV) * 0.4);
    const isBull = bar.close >= bar.open;

    const geom = new THREE.SphereGeometry(size, 8, 6);
    const mat = new THREE.MeshPhongMaterial({
      color: isBull ? 0x22cc88 : 0xff4477,
      emissive: isBull ? 0x002211 : 0x220011,
      transparent: true, opacity: 0.8, shininess: 40,
    });
    const sphere = new THREE.Mesh(geom, mat);
    sphere.position.set(xNorm, 0, z);
    group.add(sphere);
  }
  _scene.add(group);
}

function bars3DViz(bars: BaseBar[], view: ViewState, width: number, height: number) {
  if (!_scene) return;
  clearViz();

  const { start, end } = getVisibleRange(view, width, bars.length);
  const visible = bars.slice(Math.max(0, start), Math.min(bars.length, end + 1));
  if (visible.length < 2) return;

  const prices = visible.flatMap(b => [b.high, b.low]);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = maxP - minP || 1;
  const vols = visible.map(b => b.volume);
  const maxV = Math.max(...vols, 1);

  const barW = 10 / visible.length * 0.7;
  const group = new THREE.Group();

  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    const x = barX(i - start, visible.length, width, view.barSpacing, view.scrollX);
    const xNorm = (x / width) * 10 - 5;
    const oZ = ((bar.open - minP) / pRange) * 6 - 3;
    const cZ = ((bar.close - minP) / pRange) * 6 - 3;
    const bh = Math.abs(cZ - oZ) || 0.05;
    const bCenter = (oZ + cZ) / 2;
    const isBull = bar.close >= bar.open;
    const volH = (bar.volume / maxV) * 2;

    const geom = new THREE.BoxGeometry(barW, volH, bh);
    const mat = new THREE.MeshPhongMaterial({
      color: isBull ? 0x22cc88 : 0xff4477,
      emissive: isBull ? 0x002211 : 0x220011,
      transparent: true, opacity: 0.75, shininess: 50,
    });
    const box = new THREE.Mesh(geom, mat);
    box.position.set(xNorm, volH / 2, bCenter);
    group.add(box);
  }
  _scene.add(group);
}

function clearViz(): void {
  if (!_scene) return;
  while (_scene.children.length > 3) { // keep lights + grid
    const child = _scene.children[_scene.children.length - 1];
    if (child instanceof THREE.Mesh || child instanceof THREE.Group) {
      disposeMesh(child);
      _scene.remove(child);
    } else {
      break;
    }
  }
}

function disposeMesh(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh) {
    obj.geometry?.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
    else obj.material?.dispose();
  }
  if (obj instanceof THREE.Group) {
    obj.children.forEach(c => disposeMesh(c));
  }
}

// ─── Public Render API ───────────────────────────────────────────

export function render3DViz(
  bars: BaseBar[],
  view: ViewState,
  width: number,
  height: number,
): void {
  if (!_initialized || !_scene || !_renderer || !_camera) return;

  switch (_activeViz) {
    case 'surface': surfacePlot(bars, view, width, height); break;
    case 'ribbon': ribbonViz(bars, view, width, height); break;
    case 'scatter': scatterViz(bars, view, width, height); break;
    case 'bars3d': bars3DViz(bars, view, width, height); break;
    case 'wireframe': {
      const prev = _activeViz;
      _activeViz = 'surface'; surfacePlot(bars, view, width, height); _activeViz = prev;
      break;
    }
    case 'mesh': {
      const prev2 = _activeViz;
      _activeViz = 'surface'; surfacePlot(bars, view, width, height); _activeViz = prev2;
      break;
    }
    case 'line3d': ribbonViz(bars, view, width, height); break;
  }

  const canvas = getCanvas();
  if (canvas.width !== width || canvas.height !== height) {
    _renderer.setSize(width, height, false);
    _camera.aspect = width / Math.max(height, 1);
    _camera.updateProjectionMatrix();
  }
  _renderer.render(_scene, _camera);
}

export function toggle3DViz(bars: BaseBar[], view: ViewState, width: number, height: number): boolean {
  if (_initialized) {
    disposeViz();
    return false;
  }
  init();
  render3DViz(bars, view, width, height);
  return true;
}

export function cycleVizType(): VizType {
  const types: VizType[] = ['surface', 'ribbon', 'scatter', 'bars3d', 'wireframe', 'line3d', 'mesh'];
  const idx = types.indexOf(_activeViz);
  _activeViz = types[(idx + 1) % types.length];
  return _activeViz;
}
