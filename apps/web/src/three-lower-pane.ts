/**
 * 3D Lower Pane — DAFE-3D Quantitative Instrument Deck
 *
 * Combines three synchronized instrument views in the lower pane:
 *   1. Left Telemetry Column: live SPOT values, Δ bar change, σ dispersion,
 *      z-score, and regime status pill (WATCH / BULL FLOW / BEAR FLOW / EXTREME).
 *   2. Center 3D Isometric Instrument Cube (Three.js WebGL + Bloom):
 *      - 3D wireframe bounding cage with vertical scale posts & tick labels
 *      - Translucent mid-level reference plane with glowing perimeter rail
 *      - Horizon & layer axis labels (-80b..-20b..SPOT, layer names along Z)
 *      - Smooth dual-pass quantitative surfaces (translucent thermal ramp +
 *        crisp wireframe contour grid + glowing ridge spine)
 *      - Translucent vertical floor curtains with glowing rib lines for
 *        ribbon / line3d / trail layers
 *      - Aerodynamic 3D vector arrows + wireframe octahedral diamond cores
 *        with tilted concentric orbital rings at SPOT and key extrema
 *   3. Right Stacked 2D Instrument Sub-Panels:
 *      - Top: Horizon Cross-Section Profile with glowing node dots & SPOT tag
 *      - Bottom: Bar-by-Bar Impulse / Delta Strip with numeric bar labels &
 *        regime classification banner
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { OakPlot3D, OakPlot } from './oakscript/runtime';
import { resolveImage } from './image-cache';

const ID = 'three-lower-scene';
const HUD_ID = 'three-lower-hud';
let _ok = false;
let _rafId = 0;
let _renderer: THREE.WebGLRenderer | null = null;
let _scene: THREE.Scene | null = null;
let _camera: THREE.PerspectiveCamera | null = null;
let _composer: EffectComposer | null = null;
let _bloomPass: UnrealBloomPass | null = null;
let _hudCanvas: HTMLCanvasElement | null = null;
let _lastPlots: OakPlot3D[] = [];
let _lastShapes: OakPlot[] = [];
let _lastMin = 0;
let _lastMax = 1;
let _hostFallback: HTMLElement | null = null;

export function setLowerPaneHost(el: HTMLElement | null): void { _hostFallback = el; }

const BLOOM_STRENGTH = 0.62;
const BLOOM_RADIUS = 0.42;
const BLOOM_THRESHOLD = 0.52;
const BASE_FOV_DEG = 34;
const X_STRETCH_CLAMP: [number, number] = [0.88, 1.08];

function isDecoration(obj: THREE.Object3D): boolean {
  return obj instanceof THREE.Light || obj instanceof THREE.GridHelper || Boolean((obj as any).userData?.isCage);
}

function stretchContentX(scene: THREE.Scene, k: number): void {
  for (const child of scene.children) {
    if (child instanceof THREE.Light) continue;
    child.position.x *= k;
    child.scale.x *= k;
    child.traverse(o => { if (o instanceof THREE.Sprite) o.scale.x /= k; });
  }
}

function contentBox(scene: THREE.Scene): THREE.Box3 | null {
  const box = new THREE.Box3();
  let has = false;
  for (const child of scene.children) {
    if (isDecoration(child)) continue;
    box.expandByObject(child);
    has = true;
  }
  return has && !box.isEmpty() ? box : null;
}

/** Gentle binomial smoothing so noisy 1-bar series read as clean quantitative curves/surfaces. */
function smoothSeries(vals: number[], passes = 2): number[] {
  if (vals.length < 4 || passes <= 0) return [...vals];
  let cur = [...vals];
  for (let p = 0; p < passes; p++) {
    const next = new Array<number>(cur.length);
    next[0] = cur[0] * 0.7 + cur[1] * 0.3;
    for (let i = 1; i < cur.length - 1; i++) {
      next[i] = cur[i - 1] * 0.25 + cur[i] * 0.5 + cur[i + 1] * 0.25;
    }
    next[cur.length - 1] = cur[cur.length - 2] * 0.3 + cur[cur.length - 1] * 0.7;
    cur = next;
  }
  return cur;
}

/** Blue → Cyan → Emerald → Amber → Orange/Magenta quantitative thermal color ramp. */
function quantRampColor(frac: number, baseHex?: string): THREE.Color {
  const f = Math.max(0, Math.min(1, frac));
  const c = new THREE.Color();
  if (f < 0.25) {
    c.setRGB(0.08, 0.32 + (f / 0.25) * 0.52, 0.92);
  } else if (f < 0.55) {
    const t = (f - 0.25) / 0.30;
    c.setRGB(0.08 * (1 - t) + 0.05 * t, 0.84 * (1 - t) + 0.92 * t, 0.92 * (1 - t) + 0.58 * t);
  } else if (f < 0.80) {
    const t = (f - 0.55) / 0.25;
    c.setRGB(0.05 * (1 - t) + 1.0 * t, 0.92 * (1 - t) + 0.74 * t, 0.58 * (1 - t) + 0.12 * t);
  } else {
    const t = (f - 0.80) / 0.20;
    c.setRGB(1.0, 0.74 * (1 - t) + 0.22 * t, 0.12 * (1 - t) + 0.45 * t);
  }
  if (baseHex) {
    c.lerp(new THREE.Color(baseHex), 0.22);
  }
  return c;
}

/** Build a glowing octahedral diamond core surrounded by a tilted orbital ring (Signal Pipeline style). */
function buildOrbitalNode(color: THREE.Color, size = 0.22, pitchRad = 0, yawRad = 0, isVectorArrow = false): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(size * 0.78, 0),
    new THREE.MeshPhongMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.65),
      transparent: true,
      opacity: 0.9,
      shininess: 90,
    }),
  );
  const wire = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.OctahedronGeometry(size * 0.88, 0)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(size * 1.18, size * 1.32, 28),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.65 }),
  );
  ring.rotation.x = Math.PI / 2.3;
  ring.rotation.y = 0.35;
  g.add(core, wire, ring);

  if (isVectorArrow) {
    const arrowGroup = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(size * 0.48, size * 1.35, 12),
      new THREE.MeshPhongMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.55),
        shininess: 80,
      }),
    );
    cone.rotation.z = -Math.PI / 2;
    cone.position.x = size * 0.95;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(size * 0.14, size * 0.08, size * 1.4, 10),
      new THREE.MeshPhongMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.4),
        transparent: true,
        opacity: 0.85,
      }),
    );
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = 0.1;
    arrowGroup.add(cone, shaft);
    arrowGroup.rotation.z = Math.max(-0.85, Math.min(0.85, pitchRad));
    arrowGroup.rotation.y = Math.max(-0.65, Math.min(0.65, yawRad));
    g.add(arrowGroup);
  }
  return g;
}

/** Build the 3D Isometric Instrument Cage (wireframe bounding box, mid-plane reference, scale ticks & horizon labels). */
function buildInstrumentCage(min: number, max: number, zMin: number, zMax: number, layerNames: string[]): THREE.Group {
  const cage = new THREE.Group();
  (cage as any).userData = { isCage: true };

  const x0 = -5.0, x1 = 5.0;
  const y0 = 0.0, y1 = 3.8, yMid = 1.9;
  const z0 = zMin - 0.55, z1 = Math.max(zMax + 0.55, z0 + 1.6);

  // 1. Floor grid lines (X time divisions + Z horizon divisions)
  const gridPts: THREE.Vector3[] = [];
  const xCols = 10;
  for (let i = 0; i <= xCols; i++) {
    const x = x0 + ((x1 - x0) * i) / xCols;
    gridPts.push(new THREE.Vector3(x, y0, z0), new THREE.Vector3(x, y0, z1));
  }
  const zRows = 6;
  for (let j = 0; j <= zRows; j++) {
    const z = z0 + ((z1 - z0) * j) / zRows;
    gridPts.push(new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y0, z));
  }
  cage.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(gridPts),
    new THREE.LineBasicMaterial({ color: 0x263868, transparent: true, opacity: 0.45 }),
  ));

  // 2. Back & side vertical scale walls (subtle reference lines at 25%, 50%, 75%, 100%)
  const wallPts: THREE.Vector3[] = [];
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    const y = y0 + (y1 - y0) * frac;
    wallPts.push(
      new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0),
      new THREE.Vector3(x0, y, z0), new THREE.Vector3(x0, y, z1),
      new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1),
    );
  }
  // 4 vertical corner posts
  for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
    wallPts.push(new THREE.Vector3(cx, y0, cz), new THREE.Vector3(cx, y1, cz));
  }
  cage.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(wallPts),
    new THREE.LineBasicMaterial({ color: 0x3b5998, transparent: true, opacity: 0.38 }),
  ));

  // 3. Glowing Mid-Plane / Zero-Equilibrium Reference Box (SVV-3D / SKR-3D style)
  const midLoop = [
    new THREE.Vector3(x0, yMid, z0),
    new THREE.Vector3(x1, yMid, z0),
    new THREE.Vector3(x1, yMid, z1),
    new THREE.Vector3(x0, yMid, z1),
    new THREE.Vector3(x0, yMid, z0),
  ];
  cage.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(midLoop),
    new THREE.LineBasicMaterial({ color: 0xffd43b, transparent: true, opacity: 0.52 }),
  ));

  // 4. Glowing Floor Perimeter Frame
  const floorLoop = [
    new THREE.Vector3(x0, y0, z0),
    new THREE.Vector3(x1, y0, z0),
    new THREE.Vector3(x1, y0, z1),
    new THREE.Vector3(x0, y0, z1),
    new THREE.Vector3(x0, y0, z0),
  ];
  cage.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(floorLoop),
    new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.55 }),
  ));

  // 5. 3D Scale Tick Labels on left/right posts & Horizon ticks along front rail
  const fmt = (v: number) => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const midVal = (min + max) * 0.5;
  const topSprite = makeTextSprite(fmt(max), '#7ce8ff', 0.52);
  topSprite.position.set(x0 - 0.55, y1, z1);
  const midSprite = makeTextSprite(fmt(midVal), '#ffd43b', 0.52);
  midSprite.position.set(x0 - 0.55, yMid, z1);
  const botSprite = makeTextSprite(fmt(min), '#8fa8d8', 0.52);
  botSprite.position.set(x0 - 0.55, y0 + 0.15, z1);
  cage.add(topSprite, midSprite, botSprite);

  const horizonTicks: Array<[number, string]> = [
    [x0, '-80b'],
    [x0 * 0.5, '-40b'],
    [0, '-20b'],
    [x1 * 0.5, '-10b'],
    [x1, 'SPOT'],
  ];
  for (const [hx, label] of horizonTicks) {
    const sp = makeTextSprite(label, label === 'SPOT' ? '#ffd43b' : '#7ea2d6', 0.46);
    sp.position.set(hx, -0.26, z1 + 0.35);
    cage.add(sp);
  }

  // Layer name tags along the right Z rail
  layerNames.slice(0, 5).forEach((name, idx) => {
    const zPos = layerNames.length > 1
      ? z0 + 0.55 + (idx / (layerNames.length - 1)) * Math.max(0.1, (zMax - zMin))
      : 0;
    const sp = makeTextSprite(name.slice(0, 14), '#a8d4ff', 0.46);
    sp.position.set(x1 + 0.75, 0.22 + idx * 0.12, zPos);
    cage.add(sp);
  });

  return cage;
}

function applyCameraViewOffset(camera: THREE.PerspectiveCamera, w: number, h: number): void {
  camera.aspect = w / Math.max(h, 1);
  if (w >= 820) {
    // Shift the optical center of the 3D stage to ~40% from the left so it sits
    // cleanly between the Left Telemetry Column and the Right 2D Sub-Panels.
    camera.setViewOffset(w, h, Math.round(w * 0.09), 0, w, h);
  } else {
    camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
}

function ensure(): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; canvas: HTMLCanvasElement } | null {
  const h = (window as any).__dafeLowerHeight || 220;
  let c = document.getElementById(ID) as HTMLCanvasElement;
  if (!c) {
    c = document.createElement('canvas');
    c.id = ID;
    c.style.cssText = `width:100%;height:${h}px;display:block;flex-shrink:0;border-top:1px solid rgba(0,229,255,0.22);background:#050711`;
    const container = document.getElementById('chart-container');
    const sec = document.getElementById('secondary-canvas');
    if (container && sec) { sec.style.display = 'none'; container.insertBefore(c, sec); }
    else if (_hostFallback) {
      const lower2d = _hostFallback.querySelector('#mobile-lower-canvas') as HTMLElement | null;
      if (lower2d) lower2d.style.display = 'none';
      _hostFallback.appendChild(c);
    }
  }
  if (!_hudCanvas || !document.getElementById(HUD_ID)) {
    _hudCanvas = document.createElement('canvas');
    _hudCanvas.id = HUD_ID;
    _hudCanvas.style.cssText = 'position:fixed;pointer-events:none;z-index:25;display:block;';
    document.body.appendChild(_hudCanvas);
  }
  if (_renderer && _scene && _camera) {
    const liveH = (window as any).__dafeLowerHeight;
    const effH = (typeof liveH === 'number' && liveH > 30) ? liveH : h;
    if (c.style.height !== `${effH}px`) c.style.height = `${effH}px`;
    const pw = c.parentElement?.clientWidth || 1200;
    if (c.width !== pw || c.height !== effH) {
      _renderer.setSize(pw, effH, false);
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      applyCameraViewOffset(_camera, pw, effH);
      _composer?.setSize(pw, effH);
      _bloomPass?.setSize(pw, effH);
    }
    return { renderer: _renderer, scene: _scene, camera: _camera, canvas: c };
  }
  try {
    _renderer = new THREE.WebGLRenderer({ canvas: c, alpha: false, antialias: true });
    const pw0 = c.parentElement?.clientWidth || 1200;
    _renderer.setSize(pw0, h, false);
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    _renderer.setClearColor(0x050711, 1);
    _scene = new THREE.Scene();
    _scene.add(new THREE.AmbientLight(0x556688, 1.15));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.95);
    d1.position.set(6, 10, 7);
    _scene.add(d1);
    const d2 = new THREE.DirectionalLight(0x00d4ff, 0.45);
    d2.position.set(-6, 4, -5);
    _scene.add(d2);
    _camera = new THREE.PerspectiveCamera(BASE_FOV_DEG, pw0 / h, 0.1, 120);
    applyCameraViewOffset(_camera, pw0, h);
    enableOrbit(c, _camera);
    _composer = new EffectComposer(_renderer);
    _composer.addPass(new RenderPass(_scene, _camera));
    _bloomPass = new UnrealBloomPass(new THREE.Vector2(pw0, h), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    _composer.addPass(_bloomPass);
    _composer.addPass(new OutputPass());
    return { renderer: _renderer, scene: _scene, camera: _camera, canvas: c };
  } catch { return null; }
}

let _lowerBgMode = 'stars';
export function setLowerPaneBackground(mode: string): void {
  _lowerBgMode = mode;
  if (_renderer) {
    const col = mode === 'plain' ? 0x070914 : mode === 'graph' ? 0x060813 : 0x04060e;
    _renderer.setClearColor(col, 1);
    if (_scene) _scene.background = new THREE.Color(col);
  }
}

/**
 * Render the 2D Quantitative Instrument Deck HUD overlay:
 *   - Left Telemetry Column + Regime Status Pill
 *   - Right Top Sub-Panel: Horizon Cross-Section Profile with glowing nodes
 *   - Right Bottom Sub-Panel: Bar-by-Bar Impulse / Delta Strip with numeric callouts & Regime Banner
 */
function renderInstrumentHUD(canvas3d: HTMLCanvasElement): void {
  if (!_hudCanvas || !_ok) return;
  const rect = canvas3d.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) {
    _hudCanvas.style.display = 'none';
    return;
  }
  _hudCanvas.style.display = 'block';
  _hudCanvas.style.left = `${Math.round(rect.left)}px`;
  _hudCanvas.style.top = `${Math.round(rect.top)}px`;
  _hudCanvas.style.width = `${Math.round(rect.width)}px`;
  _hudCanvas.style.height = `${Math.round(rect.height)}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (_hudCanvas.width !== Math.round(w * dpr) || _hudCanvas.height !== Math.round(h * dpr)) {
    _hudCanvas.width = Math.round(w * dpr);
    _hudCanvas.height = Math.round(h * dpr);
  }
  const ctx = _hudCanvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const plots = _lastPlots;
  if (plots.length === 0) { ctx.restore(); return; }

  const primary = plots[0];
  const fin0 = primary.series.filter(v => isFinite(v) && !isNaN(v));
  const last0 = fin0.length ? fin0[fin0.length - 1] : 0;
  const prev0 = fin0.length > 1 ? fin0[fin0.length - 2] : last0;
  const delta0 = last0 - prev0;
  const mean0 = fin0.length ? fin0.reduce((a, b) => a + b, 0) / fin0.length : 0;
  const variance0 = fin0.length > 1
    ? fin0.reduce((acc, v) => acc + (v - mean0) * (v - mean0), 0) / fin0.length
    : 1;
  const std0 = Math.sqrt(variance0) || 1;
  const zScore0 = (last0 - mean0) / std0;

  const regime = zScore0 > 1.15
    ? { label: 'BULL EXPANSION', pill: 'ACTIVE · +σ', col: '#00e599', bg: 'rgba(0,229,153,0.18)' }
    : zScore0 < -1.15
      ? { label: 'STEEP CONTRACTION', pill: 'WATCH · -σ', col: '#ff2a85', bg: 'rgba(255,42,133,0.18)' }
      : Math.abs(delta0) > std0 * 0.45
        ? { label: 'TURBULENCE WATCH', pill: 'WATCH', col: '#ffb800', bg: 'rgba(255,184,0,0.18)' }
        : { label: 'NEUTRAL EQUILIBRIUM', pill: 'BALANCED', col: '#38d0ff', bg: 'rgba(56,208,255,0.16)' };

  const fmt = (v: number) => Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(2);

  // ── 1. Left Telemetry Column (SVV-3D / SKR-3D / FVL-3D style) ─────────
  const leftX = 10, topY = 8;
  ctx.font = '700 9.5px ui-monospace, Menlo, Consolas, monospace';
  const badgeText = `◆ DAFE-3D [${(primary.name || 'MODEL').toUpperCase().slice(0, 18)}] · ${plots.length}L · BAR-DERIVED · ${regime.label}`;
  const badgeW = Math.min(w * 0.56, ctx.measureText(badgeText).width + 16);
  ctx.fillStyle = 'rgba(18, 24, 48, 0.85)';
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(leftX, topY, badgeW, 17, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#7ce8ff';
  ctx.fillText(badgeText, leftX + 8, topY + 12);

  let rowY = topY + 30;
  for (let i = 0; i < Math.min(plots.length, 5); i++) {
    const p = plots[i];
    const fin = p.series.filter(v => isFinite(v) && !isNaN(v));
    if (!fin.length) continue;
    const cur = fin[fin.length - 1];
    const prv = fin.length > 1 ? fin[fin.length - 2] : cur;
    const chg = cur - prv;
    const pMin = Math.min(...fin), pMax = Math.max(...fin);
    ctx.fillStyle = typeof p.color === 'string' ? p.color : '#38d0ff';
    ctx.fillRect(leftX, rowY - 7, 5, 8);
    ctx.font = '600 9.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(220, 234, 255, 0.92)';
    ctx.fillText(`${(p.name || `L${i + 1}`).slice(0, 14)}: ${fmt(cur)}`, leftX + 9, rowY);
    ctx.fillStyle = chg >= 0 ? '#00e599' : '#ff4d88';
    ctx.font = '500 9px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`Δ${chg >= 0 ? '+' : ''}${fmt(chg)}  [${fmt(pMin)}..${fmt(pMax)}]`, leftX + 9, rowY + 11);
    rowY += 24;
  }

  // Bottom-left Regime Status Pill (matches WATCH / IDLE pill in Images 3, 4, 6)
  const pillH = 20, pillY = h - pillH - 8;
  ctx.fillStyle = regime.col;
  ctx.beginPath();
  ctx.roundRect(leftX, pillY, 96, pillH, 3);
  ctx.fill();
  ctx.font = '800 9.5px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = '#050711';
  ctx.fillText(`⚡ ${regime.pill}`, leftX + 8, pillY + 13.5);

  ctx.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(180, 205, 240, 0.8)';
  ctx.fillText(`SPOT ${fmt(last0)}  ·  z=${zScore0 >= 0 ? '+' : ''}${zScore0.toFixed(2)}σ  ·  σ=${fmt(std0)}`, leftX + 104, pillY + 13.5);

  // ── 2. Right Stacked 2D Cross-Section & Impulse Sub-Panels ─────────────
  if (w >= 760 && h >= 130) {
    const rightX = Math.round(w * 0.62);
    const rightW = w - rightX - 12;
    const gap = 8;
    const botBannerH = 22;
    const availH = h - 18 - botBannerH - gap;
    const topPanelH = Math.max(46, Math.floor(availH * 0.50));
    const botPanelH = Math.max(46, availH - topPanelH);
    const topPanelY = 8;
    const botPanelY = topPanelY + topPanelH + gap;

    // ── Top Sub-Panel: HORIZON CROSS-SECTION PROFILE @ SPOT ──
    ctx.fillStyle = 'rgba(7, 10, 22, 0.88)';
    ctx.strokeStyle = 'rgba(80, 130, 210, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(rightX, topPanelY, rightW, topPanelH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font = '700 8.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(165, 195, 240, 0.85)';
    ctx.fillText(`HORIZON PROFILE @ SPOT · ${plots.map(p => (p.name || 'Series').slice(0, 12)).slice(0, 3).join(' / ')}`, rightX + 8, topPanelY + 11);
    ctx.fillStyle = '#ffd43b';
    const spotTag = `SPOT ${fmt(last0)}`;
    ctx.fillText(spotTag, rightX + rightW - ctx.measureText(spotTag).width - 8, topPanelY + 11);

    const padL = 36, padR = 12, padT = 17, padB = 14;
    const plotW = Math.max(40, rightW - padL - padR);
    const plotH = Math.max(20, topPanelH - padT - padB);
    const px0 = rightX + padL, py0 = topPanelY + padT;

    // Horizontal grid lines + Y labels
    ctx.strokeStyle = 'rgba(90, 130, 200, 0.14)';
    ctx.fillStyle = 'rgba(140, 170, 215, 0.65)';
    ctx.font = '500 8px ui-monospace, Menlo, Consolas, monospace';
    for (let g = 0; g <= 2; g++) {
      const gy = py0 + (plotH * g) / 2;
      ctx.beginPath(); ctx.moveTo(px0, gy); ctx.lineTo(px0 + plotW, gy); ctx.stroke();
      const gv = _lastMax - ((_lastMax - _lastMin) * g) / 2;
      ctx.fillText(fmt(gv), rightX + 4, gy + 3);
    }

    // Plot up to 3 smoothed series curves + node dots
    const horizonNodes = 12;
    plots.slice(0, 3).forEach((p, idx) => {
      const raw = p.series.filter(v => isFinite(v) && !isNaN(v)).slice(-48);
      if (raw.length < 2) return;
      const sm = smoothSeries(raw, 2);
      const col = idx === 0 ? '#ffd43b' : idx === 1 ? '#00e5ff' : (typeof p.color === 'string' ? p.color : '#b48cff');
      const span = (_lastMax - _lastMin) || 1;

      ctx.strokeStyle = col;
      ctx.lineWidth = idx === 0 ? 1.8 : 1.3;
      ctx.beginPath();
      const nodeCoords: Array<{ x: number; y: number; v: number }> = [];
      for (let k = 0; k < horizonNodes; k++) {
        const si = Math.floor((k / (horizonNodes - 1)) * (sm.length - 1));
        const v = sm[si];
        const nx = px0 + (k / (horizonNodes - 1)) * plotW;
        const ny = py0 + plotH - Math.max(0, Math.min(1, (v - _lastMin) / span)) * plotH;
        nodeCoords.push({ x: nx, y: ny, v });
        if (k === 0) ctx.moveTo(nx, ny);
        else ctx.lineTo(nx, ny);
      }
      ctx.stroke();

      // Subtle fill under primary curve
      if (idx === 0 && nodeCoords.length >= 2) {
        const grad = ctx.createLinearGradient(0, py0, 0, py0 + plotH);
        grad.addColorStop(0, 'rgba(255, 212, 59, 0.18)');
        grad.addColorStop(1, 'rgba(255, 212, 59, 0.01)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(nodeCoords[0].x, py0 + plotH);
        for (const pt of nodeCoords) ctx.lineTo(pt.x, pt.y);
        ctx.lineTo(nodeCoords[nodeCoords.length - 1].x, py0 + plotH);
        ctx.closePath();
        ctx.fill();
      }

      // Glowing node dots
      ctx.fillStyle = col;
      for (const pt of nodeCoords) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, idx === 0 ? 2.2 : 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Horizon X labels along bottom of top sub-panel
    ctx.fillStyle = 'rgba(140, 170, 215, 0.65)';
    ctx.font = '500 7.5px ui-monospace, Menlo, Consolas, monospace';
    const hLabels = ['-45b', '-35b', '-25b', '-15b', '-5b', 'SPOT'];
    hLabels.forEach((lbl, idx) => {
      const lx = px0 + (idx / (hLabels.length - 1)) * (plotW - 18);
      ctx.fillStyle = lbl === 'SPOT' ? '#ffd43b' : 'rgba(140, 170, 215, 0.65)';
      ctx.fillText(lbl, lx, topPanelY + topPanelH - 3);
    });

    // ── Bottom Sub-Panel: BAR-BY-BAR IMPULSE / CHANNEL DELTA STRIP ──
    ctx.fillStyle = 'rgba(7, 10, 22, 0.88)';
    ctx.strokeStyle = 'rgba(80, 130, 210, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(rightX, botPanelY, rightW, botPanelH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font = '700 8.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(165, 195, 240, 0.85)';
    ctx.fillText('IMPULSE / DELTA STRIP · + EXPANSION (EMERALD) / - CONTRACTION (MAGENTA)', rightX + 8, botPanelY + 11);

    const bpx0 = rightX + padL, bpy0 = botPanelY + 16;
    const bPlotH = Math.max(20, botPanelH - 26);
    const zeroY = bpy0 + bPlotH * 0.5;

    ctx.strokeStyle = 'rgba(255, 212, 59, 0.28)';
    ctx.beginPath(); ctx.moveTo(bpx0, zeroY); ctx.lineTo(bpx0 + plotW, zeroY); ctx.stroke();

    const barSlots = 12;
    const recent = fin0.slice(-(barSlots + 1));
    const deltas: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      deltas.push(recent[i] - mean0);
    }
    while (deltas.length < barSlots) deltas.unshift(0);
    const maxAbsDelta = Math.max(...deltas.map(Math.abs), 1e-6);
    const slotW = plotW / barSlots;
    const barW = Math.max(8, slotW * 0.62);

    ctx.font = '600 7.5px ui-monospace, Menlo, Consolas, monospace';
    for (let i = 0; i < barSlots; i++) {
      const d = deltas[i];
      const frac = Math.max(-1, Math.min(1, d / maxAbsDelta));
      const bh = Math.max(2, Math.abs(frac) * (bPlotH * 0.44));
      const bx = bpx0 + i * slotW + (slotW - barW) * 0.5;
      const by = d >= 0 ? zeroY - bh : zeroY;
      const isSpot = i === barSlots - 1;
      ctx.fillStyle = isSpot ? '#ffb800' : d >= 0 ? '#00e599' : '#ff2a85';
      ctx.fillRect(bx, by, barW, bh);

      // Numeric value callout above/below bar
      const vTxt = `${d >= 0 ? '+' : ''}${Math.abs(d) >= 10 ? d.toFixed(0) : d.toFixed(1)}`;
      ctx.fillStyle = isSpot ? '#ffd43b' : 'rgba(220, 234, 255, 0.82)';
      const ty = d >= 0 ? Math.max(botPanelY + 19, by - 2) : Math.min(botPanelY + botPanelH - 3, by + bh + 8);
      ctx.fillText(vTxt, bx + Math.max(0, (barW - ctx.measureText(vTxt).width) * 0.5), ty);
    }

    // Bottom-Right Regime Banner Pill (matches NEUTRAL / STEEP DOWN / CONTANGO banner in Images 3, 4, 6)
    const bannerW = Math.min(200, Math.round(rightW * 0.42));
    const bannerX = rightX + rightW - bannerW;
    const bannerY = h - pillH - 6;
    ctx.fillStyle = regime.col;
    ctx.beginPath();
    ctx.roundRect(bannerX, bannerY, bannerW, pillH - 1, 3);
    ctx.fill();
    ctx.font = '800 9.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#050711';
    const btw = ctx.measureText(regime.label).width;
    ctx.fillText(regime.label, bannerX + Math.max(6, (bannerW - btw) * 0.5), bannerY + 13);
  }

  ctx.restore();
}

export function show3D(plots: OakPlot3D[], shapePlots?: OakPlot[], totalBars?: number): void {
  if (plots.length === 0 && (!shapePlots || shapePlots.length === 0)) { hide3D(); return; }
  const r = ensure();
  if (!r) return;
  _ok = true;

  // Clear old geometry except lights
  const toRemove: THREE.Object3D[] = [];
  for (const child of r.scene.children) {
    if (child instanceof THREE.AmbientLight || child instanceof THREE.DirectionalLight) continue;
    toRemove.push(child);
  }
  for (const child of toRemove) { dispose(child); r.scene.remove(child); }

  // Slice each plot's series to the most recent visible window (up to 96 bars)
  // so the 3D instrument cube aligns with the current chart horizon.
  const WINDOW_BARS = 96;
  const windowedPlots: OakPlot3D[] = plots.map(p => ({
    ...p,
    series: p.series.length > WINDOW_BARS ? p.series.slice(-WINDOW_BARS) : p.series,
  }));

  let barCount = 0;
  if (windowedPlots.length > 0 && windowedPlots[0].series) {
    barCount = windowedPlots[0].series.length;
  } else if (totalBars !== undefined) {
    barCount = Math.min(totalBars, WINDOW_BARS);
  } else if (shapePlots && shapePlots.length > 0) {
    barCount = Math.max(0, ...shapePlots.map(s => s.barIdx ?? 0)) + 1;
  }
  if (barCount < 2 && windowedPlots.length === 0 && (!shapePlots || shapePlots.length === 0)) return;

  // Compute global Y range from plot3d values (anchor non-negative series at 0)
  let min = 0, max = 1, range = 1;
  const allVals = windowedPlots.flatMap(p => p.series.filter(v => isFinite(v) && !isNaN(v)));
  if (allVals.length >= 2) {
    const rawMin = Math.min(...allVals);
    const rawMax = Math.max(...allVals);
    min = rawMin >= 0 && (rawMax - rawMin) < rawMax * 0.85 ? rawMin * 0.85 : (rawMin >= 0 ? 0 : rawMin);
    max = rawMax > min ? rawMax : min + Math.max(Math.abs(rawMax), 1);
    range = max - min || 1;
  } else if (shapePlots && shapePlots.length > 0) {
    const prices = shapePlots.map(s => s.price ?? 0).filter(v => isFinite(v));
    if (prices.length >= 2) {
      min = Math.min(...prices);
      max = Math.max(...prices);
      range = max - min || 1;
    }
  }

  _lastPlots = windowedPlots;
  _lastShapes = shapePlots || [];
  _lastMin = min;
  _lastMax = max;

  // Group plots by z_level
  const shapeLevels = shapePlots
    ? new Set(shapePlots.filter(s => s.type === 'plot3d_shape' || s.type === 'plot3d_label').map(s => s.z_level ?? 0))
    : new Set<number>();
  const hasLevels = windowedPlots.some(p => p.z_level !== undefined) || shapeLevels.size > 0;
  const groups = new Map<number, typeof windowedPlots>();
  if (hasLevels) {
    const allLevels = new Set<number>();
    for (const p of windowedPlots) allLevels.add(p.z_level ?? 0);
    for (const lvl of shapeLevels) allLevels.add(lvl);
    for (const key of allLevels) groups.set(key, []);
    for (const p of windowedPlots) {
      const key = p.z_level ?? 0;
      groups.get(key)!.push(p);
    }
  } else {
    for (let i = 0; i < windowedPlots.length; i++) {
      groups.set(i, [windowedPlots[i]]);
    }
  }

  const Z_UNIT = 1.65;
  const sortedLevels = [...groups.keys()].sort((a, b) => a - b);
  const zOffsets = new Map<number, number>();
  let cursor = 0;
  sortedLevels.forEach((key, idx) => {
    if (idx === 0) { zOffsets.set(key, 0); cursor = 0; return; }
    const gap = Math.max(Z_UNIT, Math.min(Z_UNIT * 2.2, (key - sortedLevels[idx - 1]) * Z_UNIT));
    cursor += gap;
    zOffsets.set(key, cursor);
  });
  const zCenter = cursor * 0.5;
  for (const [k, v] of zOffsets) zOffsets.set(k, v - zCenter);

  const SAME_LEVEL_GAP = 0.75;
  const zValues = [...zOffsets.values()];
  const zMin = zValues.length ? Math.min(...zValues) : -1.2;
  const zMax = zValues.length ? Math.max(...zValues) : 1.2;

  // Add the 3D Isometric Instrument Cage (wireframe box, mid-plane, ticks, horizon labels)
  r.scene.add(buildInstrumentCage(min, max, zMin, zMax, windowedPlots.map(p => p.name || p.style)));

  // Collect smoothed layer profiles so multi-layer scenes also get a cohesive
  // translucent horizon cross-surface + wireframe cross-ribs (SVV-3D / SKR-3D / FVL-3D look).
  const layerProfiles: Array<{ z: number; ys: number[]; color: THREE.Color }> = [];
  const PROFILE_STEPS = 40;

  for (const [level, groupPlots] of groups) {
    const baseZ = zOffsets.get(level) ?? 0;
    for (let gi = 0; gi < groupPlots.length; gi++) {
      const p = groupPlots[gi];
      const z = baseZ + gi * SAME_LEVEL_GAP;
      const rawVals = p.series.filter(v => isFinite(v) && !isNaN(v));
      if (rawVals.length < 2) continue;
      const vals = p.style === 'line3d' ? rawVals : smoothSeries(rawVals, 2);

      // Record resampled profile for cross-layer surface bridging
      const profYs: number[] = [];
      for (let si = 0; si < PROFILE_STEPS; si++) {
        const vi = Math.floor((si / (PROFILE_STEPS - 1)) * (vals.length - 1));
        profYs.push(Math.max(0.05, Math.min(3.75, ((vals[vi] - min) / range) * 3.6)));
      }
      layerProfiles.push({ z, ys: profYs, color: new THREE.Color(p.color || '#38d0ff') });

      if (p.style === 'surface' || p.style === 'wireframe' || p.style === 'mesh' || p.style === 'manifold') {
        const isWireOnly = p.style === 'wireframe';
        const xs = Math.min(vals.length, 48), hs = 14;
        const spanZ = Math.max(1.8, (zMax - zMin) * 0.65);
        const verts: number[] = [], idx: number[] = [], cols: number[] = [];
        const wirePts: THREE.Vector3[] = [];
        const grid3D: THREE.Vector3[][] = [];

        for (let xi = 0; xi < xs; xi++) {
          const vi = Math.floor((xi / (xs - 1)) * (vals.length - 1));
          const x = (xi / (xs - 1)) * 10 - 5;
          const frac = Math.max(0, Math.min(1, (vals[vi] - min) / range));
          const yb = 0.12 + frac * 3.5;
          const row: THREE.Vector3[] = [];
          for (let hi = 0; hi < hs; hi++) {
            const hFrac = hi / (hs - 1);
            const d = Math.abs(hFrac - 0.5) * 2;
            const wave = Math.cos(d * Math.PI * 0.48);
            const py = Math.max(0.06, yb * (0.42 + 0.58 * wave));
            const pz = z + (hFrac - 0.5) * spanZ;
            verts.push(x, py, pz);
            row.push(new THREE.Vector3(x, py, pz));
            const c = quantRampColor(frac * (0.55 + 0.45 * wave), p.color);
            cols.push(c.r, c.g, c.b);
          }
          grid3D.push(row);
        }
        for (let xi = 0; xi < xs - 1; xi++) {
          for (let hi = 0; hi < hs - 1; hi++) {
            const a = xi * hs + hi, b = a + 1, c = (xi + 1) * hs + hi, d = c + 1;
            idx.push(a, b, c, b, d, c);
            if (xi % 2 === 0) wirePts.push(grid3D[xi][hi], grid3D[xi][hi + 1]);
            if (hi % 2 === 0) wirePts.push(grid3D[xi][hi], grid3D[xi + 1][hi]);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        r.scene.add(new THREE.Mesh(g, new THREE.MeshPhongMaterial({
          vertexColors: true, side: THREE.DoubleSide, transparent: true,
          opacity: isWireOnly ? 0.25 : 0.68, shininess: 45, specular: 0x223355,
        })));
        // Crisp quantitative wireframe contour grid over the surface (SVV-3D / SKR-3D style)
        if (wirePts.length > 0) {
          r.scene.add(new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(wirePts),
            new THREE.LineBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.42 }),
          ));
        }
        // Glowing crest spine along the center ridge
        const midHi = Math.floor(hs / 2);
        const spinePts = grid3D.map(row => row[midHi]);
        const spineCurve = new THREE.CatmullRomCurve3(spinePts);
        r.scene.add(new THREE.Mesh(
          new THREE.TubeGeometry(spineCurve, xs * 2, 0.038, 6, false),
          new THREE.MeshPhongMaterial({ color: 0x00ffaa, emissive: 0x00aa66, shininess: 80 }),
        ));
        // SPOT node at live right edge
        const lastPt = spinePts[spinePts.length - 1];
        const prevPt = spinePts[Math.max(0, spinePts.length - 2)];
        const node = buildOrbitalNode(new THREE.Color(0x00ffaa), 0.20, Math.atan2(lastPt.y - prevPt.y, 0.3), 0, true);
        node.position.copy(lastPt);
        r.scene.add(node);
      } else if (p.style === 'ribbon' || p.style === 'line3d' || p.style === 'trail') {
        const count = Math.min(vals.length, 56);
        const pts: THREE.Vector3[] = [];
        const curtainVerts: number[] = [];
        const curtainCols: number[] = [];
        const curtainIdx: number[] = [];
        const ribLines: THREE.Vector3[] = [];
        const baseCol = new THREE.Color(p.color || '#38d0ff');

        for (let i = 0; i < count; i++) {
          const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
          const x = (i / (count - 1)) * 10 - 5;
          const frac = Math.max(0, Math.min(1, (vals[vi] - min) / range));
          const y = 0.12 + frac * 3.5;
          pts.push(new THREE.Vector3(x, y, z));

          // Translucent vertical floor curtain (FVL-3D / SKR-3D front curtain style)
          const cTop = quantRampColor(frac, p.color);
          const cBot = cTop.clone().multiplyScalar(0.25);
          curtainVerts.push(x, y, z, x, 0.02, z);
          curtainCols.push(cTop.r, cTop.g, cTop.b, cBot.r, cBot.g, cBot.b);
          if (i < count - 1) {
            const a = i * 2, b = a + 1, c = (i + 1) * 2, d = c + 1;
            curtainIdx.push(a, b, c, b, d, c);
          }
          if (i % 3 === 0 || i === count - 1) {
            ribLines.push(new THREE.Vector3(x, 0.02, z), new THREE.Vector3(x, y, z));
          }
        }
        if (pts.length < 2) continue;

        const cg = new THREE.BufferGeometry();
        cg.setAttribute('position', new THREE.Float32BufferAttribute(curtainVerts, 3));
        cg.setAttribute('color', new THREE.Float32BufferAttribute(curtainCols, 3));
        cg.setIndex(curtainIdx);
        cg.computeVertexNormals();
        r.scene.add(new THREE.Mesh(cg, new THREE.MeshBasicMaterial({
          vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.26,
        })));
        r.scene.add(new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(ribLines),
          new THREE.LineBasicMaterial({ color: baseCol, transparent: true, opacity: 0.38 }),
        ));

        let curve: THREE.Curve<THREE.Vector3>;
        if (p.style === 'line3d') {
          const path = new THREE.CurvePath<THREE.Vector3>();
          for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
          curve = path as unknown as THREE.Curve<THREE.Vector3>;
        } else {
          curve = new THREE.CatmullRomCurve3(pts);
        }
        const tubeRadius = p.style === 'trail' ? 0.055 : p.style === 'line3d' ? 0.036 : 0.048;
        r.scene.add(new THREE.Mesh(
          new THREE.TubeGeometry(curve, pts.length * 2, tubeRadius, 8, false),
          new THREE.MeshPhongMaterial({ color: baseCol, emissive: baseCol.clone().multiplyScalar(0.38), shininess: 75 }),
        ));

        // Aerodynamic 3D Vector Arrow + Orbital Diamond Node at SPOT (right edge)
        const lastPt = pts[pts.length - 1];
        const prevPt = pts[Math.max(0, pts.length - 2)];
        const pitch = Math.atan2(lastPt.y - prevPt.y, Math.max(0.15, lastPt.x - prevPt.x));
        const lastFrac = Math.max(0, Math.min(1, (vals[vals.length - 1] - min) / range));
        const vecCol = quantRampColor(lastFrac, p.color);
        const spotNode = buildOrbitalNode(vecCol, 0.22, pitch, 0, true);
        spotNode.position.copy(lastPt);
        r.scene.add(spotNode);
      } else if (p.style === 'bars3d') {
        // Signal Pipeline 3D Columns + Top Diamond/Orbital Nodes + Connecting Spline
        const count = Math.min(vals.length, 24);
        const radius = (10 / Math.max(count, 8)) * 0.24;
        const group = new THREE.Group();
        const topPts: THREE.Vector3[] = [];
        for (let i = 0; i < count; i++) {
          const vi = count > 1 ? Math.floor((i / (count - 1)) * (vals.length - 1)) : 0;
          const frac = Math.max(0, Math.min(1, (vals[vi] - min) / range));
          const h = Math.max(0.12, frac * 3.5);
          const x = count > 1 ? (i / (count - 1)) * 10 - 5 : 0;
          const col = quantRampColor(frac, p.color);
          const cyl = new THREE.Mesh(
            new THREE.CylinderGeometry(radius * 0.88, radius, h, 14),
            new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.28), shininess: 65 }),
          );
          cyl.position.set(x, h / 2, z);
          group.add(cyl);
          topPts.push(new THREE.Vector3(x, h + 0.08, z));
          if (i === count - 1 || i % 6 === 0) {
            const node = buildOrbitalNode(col, 0.16);
            node.position.set(x, h + 0.22, z);
            group.add(node);
          }
        }
        if (topPts.length >= 3) {
          const topCurve = new THREE.CatmullRomCurve3(topPts);
          group.add(new THREE.Mesh(
            new THREE.TubeGeometry(topCurve, topPts.length * 2, 0.025, 6, false),
            new THREE.MeshPhongMaterial({ color: new THREE.Color(p.color || '#00e5ff'), emissive: 0x005577, transparent: true, opacity: 0.75 }),
          ));
        }
        r.scene.add(group);
      } else if (p.style === 'torus' || p.style === 'scatter' || p.style === 'constellation') {
        // Signal Pipeline Orbital Diamond Nodes + Parabolic Connecting Arcs
        const indexed = vals.map((v, idx) => ({ idx, v }));
        const nonZero = indexed.filter(s => Math.abs(s.v) > 1e-6);
        const isSparse = nonZero.length >= 1 && nonZero.length < indexed.length * 0.75;
        const active = isSparse ? nonZero : indexed;
        const count = Math.min(active.length, 10);
        const totalLen = Math.max(vals.length - 1, 1);
        const group = new THREE.Group();
        const nodePts: THREE.Vector3[] = [];
        for (let i = 0; i < count; i++) {
          const vi = count > 1 ? Math.floor((i / (count - 1)) * (active.length - 1)) : 0;
          const sample = active[vi];
          const x = (sample.idx / totalLen) * 10 - 5;
          const frac = Math.max(0, Math.min(1, (sample.v - min) / range));
          const y = 0.25 + frac * 3.3;
          const col = quantRampColor(frac, p.color);
          const node = buildOrbitalNode(col, 0.20 + frac * 0.08);
          node.position.set(x, y, z);
          group.add(node);
          nodePts.push(new THREE.Vector3(x, y, z));
        }
        // Smooth arching spline between orbital nodes (Signal Pipeline Image 5 look)
        for (let i = 0; i < nodePts.length - 1; i++) {
          const a = nodePts[i], b = nodePts[i + 1];
          const mid = new THREE.Vector3((a.x + b.x) * 0.5, Math.max(a.y, b.y) + 0.45, (a.z + b.z) * 0.5);
          const arc = new THREE.CatmullRomCurve3([a, mid, b]);
          group.add(new THREE.Mesh(
            new THREE.TubeGeometry(arc, 20, 0.022, 6, false),
            new THREE.MeshPhongMaterial({ color: 0x38d0ff, emissive: 0x1166aa, transparent: true, opacity: 0.75 }),
          ));
        }
        r.scene.add(group);
      } else if (p.style === 'helix' || p.style === 'vortex') {
        const count = Math.min(vals.length, 64);
        const twists = 2.5, maxR = 0.55;
        const pts1: THREE.Vector3[] = [], pts2: THREE.Vector3[] = [];
        for (let i = 0; i < count; i++) {
          const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
          const x = (i / (count - 1)) * 10 - 5;
          const frac = Math.max(0, Math.min(1, (vals[vi] - min) / range));
          const y = 0.3 + frac * 3.2;
          const pct = i / count;
          const rad = p.style === 'vortex' ? maxR * (1 - pct * 0.75) : maxR * 0.7;
          const ang = pct * Math.PI * 2 * twists;
          pts1.push(new THREE.Vector3(x, y + Math.sin(ang) * rad, z + Math.cos(ang) * rad));
          pts2.push(new THREE.Vector3(x, y + Math.sin(ang + Math.PI) * rad, z + Math.cos(ang + Math.PI) * rad));
        }
        r.scene.add(new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts1), count * 2, 0.036, 6, false),
          new THREE.MeshPhongMaterial({ color: 0x00e5ff, emissive: 0x005577, shininess: 75 }),
        ));
        r.scene.add(new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts2), count * 2, 0.036, 6, false),
          new THREE.MeshPhongMaterial({ color: 0xff2a85, emissive: 0x660033, shininess: 75 }),
        ));
      } else if (p.style === 'ridgeline') {
        const windows = Math.max(5, Math.min(12, Math.floor(vals.length / 8)));
        const bins = 24;
        const winLen = Math.max(2, Math.floor(vals.length / windows));
        let maxFreq = 1;
        const hists: number[][] = [];
        for (let w = 0; w < windows; w++) {
          const hist = new Array(bins).fill(0);
          const from = w * winLen, to = w === windows - 1 ? vals.length : from + winLen;
          for (let i = from; i < to; i++) {
            const b = Math.max(0, Math.min(bins - 1, Math.floor(((vals[i] - min) / range) * (bins - 1))));
            hist[b]++;
          }
          const sm = smoothSeries(hist, 2);
          maxFreq = Math.max(maxFreq, ...sm);
          hists.push(sm);
        }
        for (let w = 0; w < windows; w++) {
          const pts: THREE.Vector3[] = [];
          const zr = z + (w / Math.max(windows - 1, 1)) * 3.2 - 1.6;
          for (let b = 0; b < bins; b++) {
            pts.push(new THREE.Vector3((b / (bins - 1)) * 10 - 5, 0.08 + (hists[w][b] / maxFreq) * 3.3, zr));
          }
          const col = quantRampColor(w / Math.max(windows - 1, 1), p.color);
          const curve = new THREE.CatmullRomCurve3(pts);
          r.scene.add(new THREE.Mesh(
            new THREE.TubeGeometry(curve, bins * 2, 0.028, 6, false),
            new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.35), shininess: 65 }),
          ));
        }
      }
    }
  }

  // ── Multi-Layer Horizon Surface Bridge (connects 2+ layers, and when only
  // 1 layer is present from a short prompt, automatically derives smoothed
  // companion tenors so every indicator renders a complete 3D Horizon Surface
  // + wireframe cross-ribs like SVV-3D / SKR-3D / FVL-3D) ──
  if (layerProfiles.length === 1) {
    const base = layerProfiles[0];
    const t2 = smoothSeries(base.ys, 4);
    const t3 = smoothSeries(base.ys, 9);
    const t4 = smoothSeries(base.ys, 16);
    layerProfiles.push(
      { z: base.z - 0.85, ys: t2, color: new THREE.Color('#00e5ff') },
      { z: base.z - 1.70, ys: t3, color: new THREE.Color('#22cc88') },
      { z: base.z - 2.55, ys: t4, color: new THREE.Color('#ffd43b') },
    );
  }
  if (layerProfiles.length >= 2) {
    const sortedProf = [...layerProfiles].sort((a, b) => a.z - b.z);
    const L = sortedProf.length;
    const verts: number[] = [], cols: number[] = [], idx: number[] = [];
    const crossRibs: THREE.Vector3[] = [];
    for (let li = 0; li < L; li++) {
      const lp = sortedProf[li];
      for (let si = 0; si < PROFILE_STEPS; si++) {
        const x = (si / (PROFILE_STEPS - 1)) * 10 - 5;
        const y = lp.ys[si];
        verts.push(x, y, lp.z);
        const c = quantRampColor(y / 3.6);
        cols.push(c.r, c.g, c.b);
      }
    }
    for (let li = 0; li < L - 1; li++) {
      for (let si = 0; si < PROFILE_STEPS - 1; si++) {
        const a = li * PROFILE_STEPS + si, b = a + 1, c = (li + 1) * PROFILE_STEPS + si, d = c + 1;
        idx.push(a, b, c, b, d, c);
        if (si % 3 === 0) {
          crossRibs.push(
            new THREE.Vector3((si / (PROFILE_STEPS - 1)) * 10 - 5, sortedProf[li].ys[si], sortedProf[li].z),
            new THREE.Vector3((si / (PROFILE_STEPS - 1)) * 10 - 5, sortedProf[li + 1].ys[si], sortedProf[li + 1].z),
          );
        }
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    bg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    bg.setIndex(idx);
    bg.computeVertexNormals();
    r.scene.add(new THREE.Mesh(bg, new THREE.MeshPhongMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.44, shininess: 40,
    })));
    if (crossRibs.length > 0) {
      r.scene.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(crossRibs),
        new THREE.LineBasicMaterial({ color: 0xb8f0ff, transparent: true, opacity: 0.45 }),
      ));
    }
  }

  // ── Render 3D labels (label3d) — deduplicated newest-first ──
  if (shapePlots) {
    let labelBudget = 4;
    const seenTexts = new Set<string>();
    for (let li = shapePlots.length - 1; li >= 0 && labelBudget > 0; li--) {
      const sp = shapePlots[li];
      if (sp.type !== 'plot3d_label' || !sp.text || seenTexts.has(sp.text)) continue;
      seenTexts.add(sp.text);
      const xFrac = barCount > 1 ? Math.min(1, Math.max(0, (sp.barIdx ?? 0) / Math.max(totalBars ? totalBars - 1 : barCount - 1, 1))) : 0.85;
      const x = xFrac * 10 - 5;
      const y = Math.max(0.3, Math.min(3.9, ((sp.price ?? min) - min) / range * 3.6 + 0.45));
      labelBudget--;
      const sprite = makeTextSprite(sp.text, sp.color ?? '#ffd43b', Math.min(1.0, sp.size ?? 0.85));
      sprite.position.set(x, y, zOffsets.get(sp.z_level ?? 0) ?? 0);
      r.scene.add(sprite);
    }
  }

  // ── Render 3D shapes (plotshape_3d) as precision instrument markers ──
  if (shapePlots) {
    const totalRef = Math.max(totalBars ? totalBars - 1 : barCount - 1, 1);
    const winStart = Math.max(0, (totalBars ?? barCount) - barCount);
    const shapeSlice = shapePlots.filter(sp => sp.type === 'plot3d_shape' && (sp.barIdx ?? 0) >= winStart).slice(-16);
    for (const sp of shapeSlice) {
      const localIdx = (sp.barIdx ?? winStart) - winStart;
      const xFrac = barCount > 1 ? Math.max(0, Math.min(1, localIdx / (barCount - 1))) : ((sp.barIdx ?? 0) / totalRef);
      const x = xFrac * 10 - 5;
      const y = Math.max(0.15, Math.min(3.65, ((sp.price ?? min) - min) / range * 3.6));
      const z = zOffsets.get(sp.z_level ?? 0) ?? 0;
      const s = Math.max(0.35, Math.min(0.85, (sp.size ?? 1) * 0.45));

      if (sp.shape3d === 'image') {
        const img = resolveImage(sp.imageRef ?? '');
        if (img) {
          const tex = new THREE.Texture(img);
          tex.needsUpdate = true;
          const aspect = img.width && img.height ? img.width / img.height : 1;
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
          sprite.scale.set(s * 0.6 * aspect, s * 0.6, 1);
          sprite.position.set(x, y, z);
          r.scene.add(sprite);
        }
        continue;
      }

      const col = new THREE.Color(sp.color ?? '#00e5ff');
      const d2r = Math.PI / 180;
      const node = buildOrbitalNode(
        col,
        s * 0.34,
        (sp.rx ?? 0) * d2r,
        (sp.ry ?? 0) * d2r,
        Boolean(sp.rx || sp.ry || sp.rz),
      );
      node.position.set(x, y, z);
      r.scene.add(node);
    }
  }

  const w = r.canvas.parentElement?.clientWidth || 1200;
  const h = (window as any).__dafeLowerHeight || 220;
  r.renderer.setSize(w, h, false);
  applyCameraViewOffset(r.camera, w, h);

  // Frame the 3D Isometric Instrument Cube cleanly
  const box = contentBox(r.scene);
  if (box) {
    const size = box.getSize(new THREE.Vector3());
    if (size.x > 0.001 && size.y > 0.001) {
      const k = Math.max(X_STRETCH_CLAMP[0], Math.min(X_STRETCH_CLAMP[1], (size.y * 2.2) / size.x));
      stretchContentX(r.scene, k);
    }
    const sig = windowedPlots.map(p => `${p.name}|${p.style}`).join(';') + `#${shapePlots?.length ?? 0}`;
    if (sig !== _lastLowerFitSig && _lowerOrbitFit) {
      _lastLowerFitSig = sig;
      const fitted = contentBox(r.scene);
      if (fitted) {
        const s = fitted.getSize(new THREE.Vector3());
        const center = fitted.getCenter(new THREE.Vector3());
        const vHalf = (r.camera.fov * Math.PI / 180) / 2;
        const dV = (s.y / 2) / Math.tan(vHalf);
        const dist = Math.max(9.5, Math.min(16.5, dV * 1.55 + s.z * 0.65));
        _lowerOrbitFit(dist, center);
      }
    }
  }

  // Update the footer legend bar
  {
    let legend = document.getElementById('lower-pane-legend') as HTMLDivElement | null;
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'lower-pane-legend';
      legend.style.cssText = 'flex-shrink:0;padding:4px 10px;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:rgba(190,220,255,0.85);background:rgba(5,7,16,0.92);border-top:1px solid rgba(0,229,255,0.18);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      const sec = document.getElementById('secondary-canvas');
      const container = document.getElementById('chart-container');
      if (container && sec) container.insertBefore(legend, sec);
    }
    legend.style.display = 'block';
    const parts = windowedPlots.map(p => {
      const finite = p.series.filter(v => isFinite(v));
      const last = finite.length ? finite[finite.length - 1] : NaN;
      return `${p.name} [${p.style}] ${isFinite(last) ? last.toFixed(1) : '—'}`;
    });
    const sigCount = (shapePlots || []).filter(p => p.type === 'plot3d_shape').length;
    legend.textContent = `3D INSTRUMENT DECK · ${parts.join('  ·  ')}${sigCount ? `  ·  signals: ${sigCount}` : ''}  ·  drag orbit · shift-drag pan · scroll zoom`;
    legend.title = legend.textContent;
  }

  renderInstrumentHUD(r.canvas);

  if (_rafId) cancelAnimationFrame(_rafId);
  let lastW = w, lastH = h;
  const loop = () => {
    if (!document.getElementById(ID)) { _rafId = 0; return; }
    if (!document.hidden && r.canvas.clientHeight > 0) {
      const cw = r.canvas.clientWidth || r.canvas.parentElement?.clientWidth || lastW;
      const ch = r.canvas.clientHeight || (window as any).__dafeLowerHeight || lastH;
      if (cw !== lastW || ch !== lastH) {
        lastW = cw; lastH = ch;
        r.renderer.setSize(cw, ch, false);
        applyCameraViewOffset(r.camera, cw, ch);
        _composer?.setSize(cw, ch);
        _bloomPass?.setSize(cw, ch);
      }
      if (_composer) _composer.render(); else r.renderer.render(r.scene, r.camera);
      renderInstrumentHUD(r.canvas);
    }
    _rafId = requestAnimationFrame(loop);
  };
  _rafId = requestAnimationFrame(loop);
}

/** Billboard text sprite drawn to a canvas texture — used by label3d() & cage ticks. */
export function makeTextSprite(text: string, color: string, size: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  const fontPx = 42;
  const g = cv.getContext('2d')!;
  g.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  const tw = Math.ceil(g.measureText(text).width);
  cv.width = Math.max(2, tw + 24);
  cv.height = fontPx + 18;
  const g2 = cv.getContext('2d')!;
  g2.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  g2.textBaseline = 'middle';
  g2.fillStyle = 'rgba(5, 8, 20, 0.76)';
  g2.beginPath();
  (g2 as any).roundRect ? (g2 as any).roundRect(0, 0, cv.width, cv.height, 10) : g2.rect(0, 0, cv.width, cv.height);
  g2.fill();
  g2.fillStyle = color;
  g2.fillText(text, 12, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const s = 0.42 * Math.max(0.2, Math.min(3, size));
  sprite.scale.set((cv.width / cv.height) * s, s, 1);
  return sprite;
}

function dispose(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
    obj.geometry?.dispose();
    const m = obj.material;
    if (Array.isArray(m)) m.forEach(x => x.dispose());
    else m?.dispose();
  }
  if (obj instanceof THREE.Sprite) {
    obj.material.map?.dispose();
    obj.material.dispose();
  }
  if (obj instanceof THREE.Group) obj.children.forEach(c => dispose(c));
}

export function hide3D(): void {
  _ok = false;
  const legend = document.getElementById('lower-pane-legend');
  if (legend) legend.style.display = 'none';
  if (_hudCanvas) _hudCanvas.style.display = 'none';
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  _composer?.dispose();
  _composer = null; _bloomPass = null;
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  _scene = null; _camera = null;
  _lowerOrbitFit = null;
  _lastLowerFitSig = null;
  const c = document.getElementById(ID);
  if (c) {
    c.onpointerdown = null; c.onpointermove = null; c.onpointerup = null; c.onwheel = null;
    c.remove();
  }
  const sec = document.getElementById('secondary-canvas');
  if (sec) sec.style.display = '';
  if (_hostFallback) {
    const lower2d = _hostFallback.querySelector('#mobile-lower-canvas') as HTMLElement | null;
    if (lower2d) lower2d.style.display = '';
  }
}

let _lowerOrbitFit: ((dist: number, target: THREE.Vector3) => void) | null = null;
let _lastLowerFitSig: string | null = null;

function enableOrbit(dom: HTMLCanvasElement, camera: THREE.PerspectiveCamera): void {
  // Default isometric instrument azimuth (-0.54 rad ≈ -31°) & elevation (1.06 rad ≈ 30°)
  // matching the exact isometric perspective of SVV-3D / SKR-3D / FVL-3D.
  let dragging = false, lx = 0, ly = 0, theta = -0.54, phi = 1.06, dist = 12.2;
  const target = new THREE.Vector3(0, 1.75, 0);
  let pinchStart = 0, pinchDist0 = 0;
  let movedFar = false;

  const apply = () => {
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.sin(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(target);
  };
  apply();

  _lowerOrbitFit = (d: number, t: THREE.Vector3) => {
    dist = Math.max(6, Math.min(36, d));
    target.copy(t);
    apply();
  };

  const pointers = new Map<number, { x: number; y: number }>();
  dom.onpointerdown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedFar = false;
    if (pointers.size === 1) { dragging = true; lx = e.clientX; ly = e.clientY; }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchDist0 = dist;
    }
    e.preventDefault();
  };
  dom.onpointermove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const pinch = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart > 0) {
        dist = Math.max(6, Math.min(36, pinchDist0 * (pinchStart / Math.max(1, pinch))));
        movedFar = true;
        apply();
      }
      e.preventDefault();
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    if (Math.abs(dx) + Math.abs(dy) > 6) movedFar = true;
    if (e.shiftKey) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const scale = dist * 0.0016;
      target.addScaledVector(right, -dx * scale);
      target.addScaledVector(up, dy * scale);
      target.y = Math.max(-4, Math.min(8, target.y));
    } else {
      theta -= dx * 0.01;
      phi = Math.max(0.25, Math.min(1.42, phi - dy * 0.01));
    }
    lx = e.clientX; ly = e.clientY;
    apply();
    if (movedFar) e.preventDefault();
  };
  const releasePointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) dragging = false;
    if (pointers.size < 2) pinchStart = 0;
  };
  dom.onpointerup = releasePointer;
  dom.onpointercancel = releasePointer;
  dom.onpointerleave = (e: PointerEvent) => releasePointer(e);
  dom.onwheel = (e: WheelEvent) => {
    dist = Math.max(6, Math.min(36, dist + e.deltaY * 0.02));
    apply(); e.preventDefault();
  };
}
