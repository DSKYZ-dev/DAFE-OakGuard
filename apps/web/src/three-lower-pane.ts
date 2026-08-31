/**
 * 3D Lower Pane — renders OakScript plot3d data as Three.js scene below chart.
 * Minimal surface area — no mouse handlers, no orbit controls.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { OakPlot3D, OakPlot } from './oakscript/runtime';
import { resolveImage } from './image-cache';

const ID = 'three-lower-scene';
let _ok = false;
let _rafId = 0;
// Cached scene resources — created once, reused across show3D calls
let _renderer: THREE.WebGLRenderer | null = null;
let _scene: THREE.Scene | null = null;
let _camera: THREE.PerspectiveCamera | null = null;
let _composer: EffectComposer | null = null;
let _bloomPass: UnrealBloomPass | null = null;
// Mobile host fallback — the web app anchors this pane's canvas via the
// #chart-container/#secondary-canvas IDs; the mobile app has neither, so it
// registers its own lower-pane wrapper here instead.
let _hostFallback: HTMLElement | null = null;
export function setLowerPaneHost(el: HTMLElement | null): void { _hostFallback = el; }
// Same rationale as three-indicators.ts's twin constants — this pane's
// geometry is built from the same emissive MeshPhongMaterial palette.
const BLOOM_STRENGTH = 0.55;
const BLOOM_RADIUS = 0.4;
// High threshold: only emissive geometry blooms. The old 0.15 bloomed the
// whole frame — the pane took on the viz's own color and looked hazy.
const BLOOM_THRESHOLD = 0.6;

// ─── Content-fit framing ───────────────────────────────────────────
// Plot geometry is normalized to a fixed world-space span (roughly x in
// [-5, 5]) regardless of container size, while this pane is extremely wide
// and short (aspect 5+). Two failed framing models preceded this one: a
// fixed vertical FOV strands the content in a narrow strip in the middle
// (unused width), and pinning the HORIZONTAL FOV instead crushes the
// vertical FOV so far at this aspect that content clips top/bottom. The
// robust model: keep a normal fixed FOV, then (1) stretch content
// x-positions so the content box's aspect matches the viewport's — bars
// just spread out; text sprites are counter-scaled so glyphs don't distort
// — and (2) fit the camera distance to the resulting box, so the scene
// fills the pane edge-to-edge on BOTH axes with no cropping at any size.
const BASE_FOV_DEG = 35;
// Gentle: spreads bar-like content across wide panes without visibly
// mangling organic geometry (helixes, tori, wireframe terrains) — the
// first cut allowed 3.5× and stretched those into unrecognizable spikes.
const X_STRETCH_CLAMP: [number, number] = [0.9, 1.5];

function isDecoration(obj: THREE.Object3D): boolean {
  return obj instanceof THREE.Light || obj instanceof THREE.GridHelper;
}

function stretchContentX(scene: THREE.Scene, k: number): void {
  for (const child of scene.children) {
    if (isDecoration(child)) continue;
    child.position.x *= k;
    child.scale.x *= k;
    // Keep text glyphs at their designed aspect — the group-level stretch
    // above already moved them to the right place.
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

function ensure(): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; canvas: HTMLCanvasElement } | null {
  const h = (window as any).__dafeLowerHeight || 220;
  let c = document.getElementById(ID) as HTMLCanvasElement;
  if (!c) {
    c = document.createElement('canvas');
    c.id = ID;
    c.style.cssText = `width:100%;height:${h}px;display:block;flex-shrink:0;border-top:1px solid rgba(180,140,255,0.15);background:#060612`;
    const container = document.getElementById('chart-container');
    const sec = document.getElementById('secondary-canvas');
    if (container && sec) { sec.style.display = 'none'; container.insertBefore(c, sec); }
    else if (_hostFallback) {
      // Mobile: hide the 2D lower canvas and mount the GL pane in its place.
      const lower2d = _hostFallback.querySelector('#mobile-lower-canvas') as HTMLElement | null;
      if (lower2d) lower2d.style.display = 'none';
      _hostFallback.appendChild(c);
    }
  }
  // If we already have cached resources, just resize and return
  if (_renderer && _scene && _camera) {
    // Live height — the mobile host sets __dafeLowerHeight whenever the user
    // resizes the pane, so the GL scene always fills the actual container
    // (no fixed-height GL floating in black unused space).
    const liveH = (window as any).__dafeLowerHeight;
    const effH = (typeof liveH === 'number' && liveH > 30) ? liveH : h;
    if (c.style.height !== `${effH}px`) c.style.height = `${effH}px`;
    const pw = c.parentElement?.clientWidth || 1200;
    if (c.width !== pw || c.height !== effH) {
      _renderer.setSize(pw, effH, false);
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      _camera.aspect = pw / effH; _camera.updateProjectionMatrix();
      _composer?.setSize(pw, effH);
      _bloomPass?.setSize(pw, effH);
    }
    return { renderer: _renderer, scene: _scene, camera: _camera, canvas: c };
  }
  try {
    _renderer = new THREE.WebGLRenderer({ canvas: c, alpha: false, antialias: true });
    _renderer.setSize(c.parentElement?.clientWidth || 1200, h, false);
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Standard charting black — same as the app's --bg. The old 0x060612 read
    // as a purple-blue wash bleeding into the chart area on bright scenes.
    _renderer.setClearColor(0x0a0a18, 1);
    _scene = new THREE.Scene();
    _scene.add(new THREE.AmbientLight(0x404060, 1.0));
    const d = new THREE.DirectionalLight(0xffffff, 0.7);
    d.position.set(3, 6, 5); _scene.add(d);
    _scene.add(new THREE.GridHelper(16, 12, 0x222244, 0x111122));
    const pw0 = c.parentElement?.clientWidth || 1200;
    _camera = new THREE.PerspectiveCamera(BASE_FOV_DEG, pw0 / h, 0.1, 100);
    _camera.position.set(0, 3.5, 10);
    _camera.lookAt(0, 1.8, 0);
    enableOrbit(c, _camera);
    _composer = new EffectComposer(_renderer);
    _composer.addPass(new RenderPass(_scene, _camera));
    _bloomPass = new UnrealBloomPass(new THREE.Vector2(pw0, h), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    _composer.addPass(_bloomPass);
    _composer.addPass(new OutputPass());
    return { renderer: _renderer, scene: _scene, camera: _camera, canvas: c };
  } catch { return null; }
}

export function show3D(plots: OakPlot3D[], shapePlots?: OakPlot[], totalBars?: number): void {
  if (plots.length === 0 && (!shapePlots || shapePlots.length === 0)) { hide3D(); return; }
  const r = ensure();
  if (!r) return;
  _ok = true;

  // Clear old geometry — works for Mesh, Group, Line, LineSegments, etc.
  const toRemove: THREE.Object3D[] = [];
  for (const child of r.scene.children) {
    if (child instanceof THREE.AmbientLight || child instanceof THREE.DirectionalLight || child instanceof THREE.GridHelper) continue;
    toRemove.push(child);
  }
  for (const child of toRemove) { dispose(child); r.scene.remove(child); }

  // Determine total bar count: from explicit totalBars param, or plot3d series length, or shape barIdx
  let barCount = 0;
  if (totalBars !== undefined) {
    barCount = totalBars;
  } else if (plots.length > 0 && plots[0].series) {
    barCount = plots[0].series.length;
  } else if (shapePlots && shapePlots.length > 0) {
    barCount = Math.max(0, ...shapePlots.map(s => s.barIdx ?? 0)) + 1;
  }
  if (barCount < 2 && plots.length === 0 && (!shapePlots || shapePlots.length === 0)) return;

  // Compute global Y range from plot3d values if present, otherwise from shape prices
  let min = 0, max = 1, range = 1;
  const allVals = plots.flatMap(p => p.series.filter(v => isFinite(v) && !isNaN(v)));
  if (allVals.length >= 2) {
    min = Math.min(...allVals);
    max = Math.max(...allVals);
    range = max - min || 1;
  } else if (shapePlots && shapePlots.length > 0) {
    const prices = shapePlots.map(s => s.price ?? 0).filter(v => isFinite(v));
    if (prices.length >= 2) {
      min = Math.min(...prices);
      max = Math.max(...prices);
      range = max - min || 1;
    }
  }

  // Group plots by z_level — same level = stacked together at same Z,
  // different levels = spaced apart. If z_level is unspecified, auto-space.
  // Include shape z_levels in the mapping for consistent positioning.
  const shapeLevels = shapePlots
    ? new Set(shapePlots.filter(s => s.type === 'plot3d_shape' || s.type === 'plot3d_label').map(s => s.z_level ?? 0))
    : new Set<number>();
  const hasLevels = plots.some(p => p.z_level !== undefined) || shapeLevels.size > 0;
  const groups = new Map<number, typeof plots>();
  if (hasLevels) {
    // Collect levels from both plot3d and shapes
    const allLevels = new Set<number>();
    for (const p of plots) allLevels.add(p.z_level ?? 0);
    for (const lvl of shapeLevels) allLevels.add(lvl);
    for (const key of allLevels) groups.set(key, []);
    for (const p of plots) {
      const key = p.z_level ?? 0;
      groups.get(key)!.push(p);
    }
  } else {
    // Auto-spacing: each plot gets its own Z
    for (let i = 0; i < plots.length; i++) {
      groups.set(i, [plots[i]]);
    }
  }

  // Compute Z offsets: sort levels ascending, space adjacent levels by
  // whichever is bigger — a flat 2.4 units (today's default, so the common
  // "0, 1, 2, …" authoring convention renders identically to before) or the
  // actual gap between the two z_level NUMBERS scaled the same way. A
  // script that deliberately spaces its levels wide (e.g. 0 and 10, to push
  // one layer dramatically further back) now gets that — previously only
  // RANK mattered, so 0-and-1 and 0-and-10 rendered identically.
  const Z_UNIT = 2.4;
  const sortedLevels = [...groups.keys()].sort((a, b) => a - b);
  const zOffsets = new Map<number, number>();
  let cursor = 0;
  sortedLevels.forEach((key, idx) => {
    if (idx === 0) { zOffsets.set(key, 0); cursor = 0; return; }
    const gap = Math.max(Z_UNIT, (key - sortedLevels[idx - 1]) * Z_UNIT);
    cursor += gap;
    zOffsets.set(key, cursor);
  });

  // Same-level micro-offset: distinct plot3d series that share a z_level
  // (usually an oversight — nothing in OakScript signals "these two are
  // meant to fuse") get a real, visible separation instead of the old
  // 0.05 units, which read as one merged/flickering surface. Shapes and
  // labels are unaffected — they intentionally sit AT their series' level,
  // not in a sub-layer of their own (see the shape/label rendering below).
  const SAME_LEVEL_GAP = 0.6;

  for (const [level, groupPlots] of groups) {
    const baseZ = zOffsets.get(level) ?? 0;
    for (let gi = 0; gi < groupPlots.length; gi++) {
      const p = groupPlots[gi];
      const z = baseZ + gi * SAME_LEVEL_GAP;
      const vals = p.series.filter(v => isFinite(v) && !isNaN(v));
      if (vals.length < 2) continue;

      if (p.style === 'surface' || p.style === 'wireframe' || p.style === 'mesh') {
      const isWire = p.style === 'wireframe';
      const xs = Math.min(vals.length, 80), hs = 15;
      const verts: number[] = [], idx: number[] = [], cols: number[] = [];
      for (let xi = 0; xi < xs; xi++) {
        const vi = Math.floor((xi / (xs - 1)) * (vals.length - 1));
        const x = (xi / (xs - 1)) * 10 - 5;
        const yb = ((vals[vi] - min) / range) * 4;
        // Color: green (low) -> yellow (mid) -> red (high) using HSL
        const frac = (vals[vi] - min) / range;
        const hue = (1 - frac) * 0.35; // 0.35=green, 0.0=red
        const c = new THREE.Color().setHSL(hue, 0.85, 0.45 + frac * 0.25);
        for (let hi = 0; hi < hs; hi++) {
          const d = Math.abs((hi / (hs - 1)) - 0.5) * 2;
          verts.push(x, yb * (1 - d * 0.85) * 0.85, z + (hi / (hs - 1)) * 2 - 1);
          cols.push(c.r, c.g, c.b);
        }
      }
      for (let xi = 0; xi < xs - 1; xi++) for (let hi = 0; hi < hs - 1; hi++) {
        const a = xi * hs + hi, b = a + 1, c = (xi + 1) * hs + hi, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      g.setIndex(idx); g.computeVertexNormals();
      r.scene.add(new THREE.Mesh(g, new THREE.MeshPhongMaterial({
        vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: isWire ? 0.5 : 0.8,
        wireframe: isWire, specular: 0x111122, shininess: 15,
      })));
    } else if (p.style === 'ribbon' || p.style === 'line3d') {
      const pts: THREE.Vector3[] = [];
      const step = Math.max(1, Math.floor(vals.length / 150));
      for (let i = 0; i < vals.length; i += step)
        pts.push(new THREE.Vector3((i / (vals.length - 1)) * 10 - 5, ((vals[i] - min) / range) * 4, z));
      if (pts.length < 2) continue;
      // line3d renders EXACT straight segments — Catmull-Rom smoothing turns
      // step-shaped series (fib/pivot levels) into spike blades that look
      // nothing like level lines. Ribbon keeps the smooth spline for flowing
      // oscillator/MA traces.
      let curve: THREE.Curve<THREE.Vector3>;
      if (p.style === 'line3d') {
        const path = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
        curve = path as unknown as THREE.Curve<THREE.Vector3>;
      } else {
        curve = new THREE.CatmullRomCurve3(pts);
      }
      r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, p.style === 'line3d' ? 0.03 : 0.06, 6, false),
        new THREE.MeshPhongMaterial({ color: new THREE.Color(p.color), emissive: new THREE.Color(p.color).multiplyScalar(0.2), shininess: 50 })));
    } else if (p.style === 'bars3d') {
      const count = Math.min(vals.length, 80), bw = 10 / count * 0.6;
      const group = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const h = Math.max(0.03, ((vals[vi] - min) / range) * 4);
        const box = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bw),
          new THREE.MeshPhongMaterial({ color: new THREE.Color(p.color), emissive: vals[vi] > (min + range * 0.5) ? new THREE.Color(p.color).multiplyScalar(0.3) : new THREE.Color(0), shininess: 35 }));
        box.position.set((i / (count - 1)) * 10 - 5, h / 2, z);
        group.add(box);
      }
      r.scene.add(group);
    } else if (p.style === 'scatter') {
      const count = Math.min(vals.length, 120);
      const group = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const val = vals[vi];
        const hue = 0.65 - ((val - min) / range) * 0.65;
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.03 + Math.random() * 0.05, 5, 4),
          new THREE.MeshPhongMaterial({ color: new THREE.Color().setHSL(hue, 0.75, 0.5), emissive: new THREE.Color().setHSL(hue, 0.4, 0.12), shininess: 40 }));
        sphere.position.set((i / (count - 1)) * 10 - 5 + (Math.random() - 0.5) * 0.25, ((val - min) / range) * 4, z + (Math.random() - 0.5) * 0.4);
        group.add(sphere);
      }
      r.scene.add(group);
    } else if (p.style === 'helix') {
      const count = Math.min(vals.length, 100);
      const twists = 3, radius = 0.8;
      const s1: THREE.Vector3[] = [], s2: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const x = (i / (count - 1)) * 10 - 5;
        const y = ((vals[vi] - min) / range) * 4;
        const angle = (i / count) * Math.PI * 2 * twists;
        s1.push(new THREE.Vector3(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, z));
        s2.push(new THREE.Vector3(x + Math.cos(angle + Math.PI) * radius, y + Math.sin(angle + Math.PI) * radius, z));
      }
      const c1 = new THREE.CatmullRomCurve3(s1), c2 = new THREE.CatmullRomCurve3(s2);
      r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(c1, count, 0.05, 6, false), new THREE.MeshPhongMaterial({ color: 0x22cc88, emissive: 0x004422, shininess: 70 })));
      r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(c2, count, 0.05, 6, false), new THREE.MeshPhongMaterial({ color: 0xff4477, emissive: 0x220011, shininess: 70 })));
      const center: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        center.push(new THREE.Vector3((i / (count - 1)) * 10 - 5, ((vals[vi] - min) / range) * 4, z));
      }
      const cc = new THREE.CatmullRomCurve3(center);
      r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(cc, count, 0.02, 4, false), new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x4444aa, transparent: true, opacity: 0.4 })));
    } else if (p.style === 'vortex') {
      const count = Math.min(vals.length, 100);
      const spirals = 6, maxR = 2.0;
      for (let s = 0; s < spirals; s++) {
        const pts: THREE.Vector3[] = [];
        const phase = (s / spirals) * Math.PI * 2;
        const hue = (s / spirals) * 0.8;
        for (let i = 0; i < count; i++) {
          const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
          const x = (i / (count - 1)) * 10 - 5;
          const y = ((vals[vi] - min) / range) * 4;
          const pct = i / count;
          const r = maxR * (1 - pct * 0.85);
          const angle = pct * Math.PI * 4 + phase;
          pts.push(new THREE.Vector3(x + Math.cos(angle) * r, y + Math.sin(angle) * r, z));
        }
        if (pts.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(pts);
        const col = new THREE.Color().setHSL(hue, 0.7, 0.5);
        r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, count, 0.03, 5, false), new THREE.MeshPhongMaterial({ color: col, emissive: col.clone().multiplyScalar(0.3), transparent: true, opacity: 0.55 })));
      }
    } else if (p.style === 'manifold') {
      const count = Math.min(vals.length, 60);
      const longCount = 8, manifoldWidth = 1.2;
      for (let l = 0; l < longCount; l++) {
        const pts: THREE.Vector3[] = [];
        const lFrac = l / (longCount - 1);
        for (let i = 0; i < count; i++) {
          const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
          const x = (i / (count - 1)) * 10 - 5;
          const y = ((vals[vi] - min) / range) * 4;
          pts.push(new THREE.Vector3(x + (lFrac - 0.5) * manifoldWidth, y * (0.6 + lFrac * 0.3), z + (lFrac - 0.5) * 0.8));
        }
        const curve = new THREE.CatmullRomCurve3(pts);
        const curvePts = curve.getPoints(count);
        const col = new THREE.Color().setHSL(0.7 + lFrac * 0.15, 0.6, 0.4 + lFrac * 0.3);
        r.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curvePts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 })));
      }
      const latStep = Math.max(1, Math.floor(count / 20));
      for (let i = 0; i < count; i += latStep) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const x = (i / (count - 1)) * 10 - 5;
        const y = ((vals[vi] - min) / range) * 4;
        const pts: THREE.Vector3[] = [];
        for (let l = 0; l < longCount; l++) {
          const lFrac = l / (longCount - 1);
          pts.push(new THREE.Vector3(x + (lFrac - 0.5) * manifoldWidth, y * (0.6 + lFrac * 0.3), z + (lFrac - 0.5) * 0.8));
        }
        r.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.25 })));
      }
    } else if (p.style === 'nebula') {
      const count = Math.min(vals.length, 60);
      const perBar = 8;
      const group = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const x = (i / (count - 1)) * 10 - 5;
        const y = ((vals[vi] - min) / range) * 4;
        const hue = 0.65 - ((vals[vi] - min) / range) * 0.65;
        for (let p = 0; p < perBar; p++) {
          const s = new THREE.Mesh(new THREE.SphereGeometry(0.015 + Math.random() * 0.05, 4, 3),
            new THREE.MeshPhongMaterial({ color: new THREE.Color().setHSL(hue + (Math.random() - 0.5) * 0.08, 0.6, 0.3 + Math.random() * 0.3), emissive: new THREE.Color().setHSL(hue, 0.3, 0.06), transparent: true, opacity: 0.4 + Math.random() * 0.4 }));
          s.position.set(x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.6);
          group.add(s);
        }
      }
      r.scene.add(group);
    } else if (p.style === 'constellation') {
      const count = Math.min(vals.length, 80);
      const positions: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        positions.push(new THREE.Vector3((i / (count - 1)) * 10 - 5, ((vals[vi] - min) / range) * 4, z));
      }
      const pairs: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) for (let j = i + 1; j < Math.min(i + 4, count); j++) {
        if (positions[i].distanceTo(positions[j]) < 1.5) pairs.push(positions[i], positions[j]);
      }
      if (pairs.length) r.scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pairs), new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.12 })));
      const starGroup = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const star = new THREE.Mesh(new THREE.SphereGeometry(0.04 + Math.random() * 0.06, 5, 4),
          new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x8844ff, emissiveIntensity: 0.3 + Math.random() * 0.5 }));
        star.position.copy(positions[i]);
        starGroup.add(star);
      }
      r.scene.add(starGroup);
    } else if (p.style === 'torus') {
      const count = Math.min(vals.length, 70);
      const maxV = Math.max(...vals, 1);
      const group = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const x = (i / (count - 1)) * 10 - 5;
        const y = ((vals[vi] - min) / range) * 4;
        const volScale = Math.abs(vals[vi]) / maxV;
        const torus = new THREE.Mesh(new THREE.TorusGeometry(0.2 + volScale * 0.4, 0.02 + volScale * 0.03, 6, 8),
          new THREE.MeshPhongMaterial({ color: new THREE.Color(p.color), emissive: new THREE.Color(p.color).multiplyScalar(0.2), transparent: true, opacity: 0.45 + volScale * 0.3 }));
        torus.position.set(x, y, z);
        torus.rotation.x = Math.PI / 2;
        group.add(torus);
      }
      r.scene.add(group);
      const centerPts: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        centerPts.push(new THREE.Vector3((i / (count - 1)) * 10 - 5, ((vals[vi] - min) / range) * 4, z));
      }
      r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(centerPts), count, 0.025, 6, false),
        new THREE.MeshPhongMaterial({ color: 0xb48cff, emissive: 0x442288, transparent: true, opacity: 0.25 })));
    } else if (p.style === 'ridgeline') {
      // Temporal distribution joyplot (LuxAlgo "Temporal VP" look): slice the
      // series into time windows, histogram each window's values, and stack
      // the resulting curves along Z with an HSL ramp (cyan → purple → red →
      // amber). Each ridge answers "where did the values live in this period".
      const windows = Math.max(4, Math.min(16, Math.floor(vals.length / 12)));
      const bins = 28;
      const winLen = Math.floor(vals.length / windows);
      let maxFreq = 1;
      const hists: number[][] = [];
      for (let w = 0; w < windows; w++) {
        const hist = new Array(bins).fill(0);
        const from = w * winLen, to = w === windows - 1 ? vals.length : from + winLen;
        for (let i = from; i < to; i++) {
          const b = Math.max(0, Math.min(bins - 1, Math.floor(((vals[i] - min) / range) * (bins - 1))));
          hist[b]++;
        }
        // one smoothing pass so ridges read as curves, not staircases
        const sm = hist.map((v, i) => (hist[i - 1] ?? v) * 0.25 + v * 0.5 + (hist[i + 1] ?? v) * 0.25);
        maxFreq = Math.max(maxFreq, ...sm);
        hists.push(sm);
      }
      for (let w = 0; w < windows; w++) {
        const pts: THREE.Vector3[] = [];
        const zr = z + (w / Math.max(windows - 1, 1)) * 4 - 2;
        for (let b = 0; b < bins; b++) {
          pts.push(new THREE.Vector3((b / (bins - 1)) * 10 - 5, (hists[w][b] / maxFreq) * 3.2, zr));
        }
        const hue = 0.5 + (w / Math.max(windows - 1, 1)) * 0.6; // cyan → violet → red → amber (wraps)
        const col = new THREE.Color().setHSL(hue % 1, 0.8, 0.55);
        const curve = new THREE.CatmullRomCurve3(pts);
        r.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(bins * 3)),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 })));
        // faint floor shadow line anchoring each ridge
        const floorPts = pts.map(v => new THREE.Vector3(v.x, 0.01, v.z));
        r.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(floorPts),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.15 })));
      }
    } else if (p.style === 'trail') {
      const count = Math.min(vals.length, 80);
      const upper: THREE.Vector3[] = [], lower: THREE.Vector3[] = [];
      const maxV = Math.max(...vals, 1);
      for (let i = 0; i < count; i++) {
        const vi = Math.floor((i / (count - 1)) * (vals.length - 1));
        const x = (i / (count - 1)) * 10 - 5;
        const y = ((vals[vi] - min) / range) * 4;
        const w = 0.05 + (Math.abs(vals[vi]) / maxV) * 0.25;
        upper.push(new THREE.Vector3(x, y + w, z));
        lower.push(new THREE.Vector3(x, y - w, z));
      }
      for (let i = 0; i < count - 1; i++) {
        const verts = [upper[i].x, upper[i].y, upper[i].z, upper[i + 1].x, upper[i + 1].y, upper[i + 1].z, lower[i + 1].x, lower[i + 1].y, lower[i + 1].z, lower[i].x, lower[i].y, lower[i].z];
        const idx = [0, 1, 2, 0, 2, 3];
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        g.setIndex(idx); g.computeVertexNormals();
        r.scene.add(new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: new THREE.Color(p.color), transparent: true, opacity: 0.4 + (Math.abs(vals[Math.min(i, vals.length - 1)]) / maxV) * 0.2, side: THREE.DoubleSide, shininess: 30 })));
      } // end inner loop
    } // end else-if chain (trail)
    } // end for gi (within group)
  } // end for groups

  // ── Render 3D labels (label3d) — billboard text sprites ──
  if (shapePlots) {
    let labelBudget = 40; // hard cap so an unconditional label3d can't stamp 500 sprites
    // Declutter: signals that fire on many nearby bars stamp the SAME text
    // dozens of times, stacking into unreadable towers. Walk newest→oldest
    // and skip a label when one with the same text already landed nearby.
    const placed: Array<{ text: string; x: number; y: number }> = [];
    for (let li = shapePlots.length - 1; li >= 0 && labelBudget > 0; li--) {
      const sp = shapePlots[li];
      if (sp.type !== 'plot3d_label' || !sp.text) continue;
      const xFrac = barCount > 1 ? (sp.barIdx ?? 0) / (barCount - 1) : 0.5;
      const x = xFrac * 10 - 5;
      const y = ((sp.price ?? 0) - min) / range * 4 + 0.35;
      if (placed.some(pl => pl.text === sp.text && Math.abs(pl.x - x) < 0.9 && Math.abs(pl.y - y) < 0.5)) continue;
      placed.push({ text: sp.text, x, y });
      labelBudget--;
      const sprite = makeTextSprite(sp.text, sp.color ?? '#ffffff', sp.size ?? 1);
      sprite.position.set(x, y, zOffsets.get(sp.z_level ?? 0) ?? 0);
      r.scene.add(sprite);
    }
  }

  // ── Render 3D shapes (plotshape_3d) ──
  if (shapePlots) {
    for (const sp of shapePlots) {
      if (sp.type !== 'plot3d_shape') continue;
      const s = sp.size ?? 1;
      // Position: map barIdx to X (using barCount), price to Y (using min/range), z_level to Z (using zOffsets)
      // Hoisted above the shape switch so both the mesh path and the 3D
      // image-billboard early-branch below can reuse the same x/y/z.
      const xFrac = barCount > 1 ? (sp.barIdx ?? 0) / (barCount - 1) : 0.5;
      const x = xFrac * 10 - 5;
      const y = ((sp.price ?? 0) - min) / range * 4;
      const z = zOffsets.get(sp.z_level ?? 0) ?? 0;
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
          r.scene.add(sprite);
        }
        continue;
      }
      let geometry: THREE.BufferGeometry;
      switch (sp.shape3d) {
        case 'cube':
          geometry = new THREE.BoxGeometry(s * 0.3, s * 0.3, s * 0.3);
          break;
        case 'sphere':
          geometry = new THREE.SphereGeometry(s * 0.2, 8, 6);
          break;
        case 'pyramid':
          geometry = new THREE.ConeGeometry(s * 0.25, s * 0.35, 4);
          break;
        case 'torus':
          geometry = new THREE.TorusGeometry(s * 0.2, s * 0.07, 6, 8);
          break;
        case 'diamond':
          geometry = new THREE.OctahedronGeometry(s * 0.25);
          break;
        case 'coneup':
        case 'conedown':
          geometry = new THREE.ConeGeometry(s * 0.22, s * 0.5, 12);
          break;
        default:
          geometry = new THREE.BoxGeometry(s * 0.25, s * 0.25, s * 0.25);
      }
      const col = new THREE.Color(sp.color ?? '#b48cff');
      const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
        color: col, emissive: col.clone().multiplyScalar(0.2),
        specular: 0x222244, shininess: 60,
      }));
      // Signal cones: offset from the bar (gap scales with size) with the tip
      // pointing AT the price — coneup sits below, conedown flips and sits above.
      let yOff = 0;
      let baseRotZ = 0;
      if (sp.shape3d === 'coneup') { yOff = -(0.15 + 0.25) * s; }
      else if (sp.shape3d === 'conedown') { yOff = (0.15 + 0.25) * s; baseRotZ = Math.PI; }
      // User rotation in degrees, applied on top of the built-in orientation.
      const d2r = Math.PI / 180;
      mesh.rotation.set((sp.rx ?? 0) * d2r, (sp.ry ?? 0) * d2r, baseRotZ + (sp.rz ?? 0) * d2r);
      mesh.position.set(x, y + yOff, z);
      mesh.castShadow = true;
      r.scene.add(mesh);
    }
  }

  const w = r.canvas.parentElement?.clientWidth || 1200;
  const h = (window as any).__dafeLowerHeight || 220;
  r.renderer.setSize(w, h, false);
  r.camera.aspect = w / h; r.camera.updateProjectionMatrix();

  // Start continuous render loop so camera orbit works
  // ── Content-fit: stretch to the pane's aspect, then frame the box ──
  const aspect = r.camera.aspect;
  const box = contentBox(r.scene);
  if (box) {
    const size = box.getSize(new THREE.Vector3());
    if (size.x > 0.001 && size.y > 0.001) {
      const k = Math.max(X_STRETCH_CLAMP[0], Math.min(X_STRETCH_CLAMP[1], (size.y * aspect) / size.x));
      stretchContentX(r.scene, k);
    }
    // Camera refit only when the CONTENT identity changes (different plots),
    // never on a same-indicator rebuild — the user's orbit must win there.
    const sig = plots.map(p => `${p.name}|${p.style}`).join(';') + `#${shapePlots?.length ?? 0}`;
    if (sig !== _lastLowerFitSig && _lowerOrbitFit) {
      _lastLowerFitSig = sig;
      const fitted = contentBox(r.scene);
      if (fitted) {
        // Box-face fit (fills the limiting axis) plus a strong z-margin.
        // Two failed extremes bracket this: distance from face-fit + s.z/2
        // alone let the tilted orbit camera sit inside deep terrain (huge
        // clipped wedges), while a full bounding-sphere fit banished wide
        // content so far away it became an invisible sliver on this pane's
        // extreme aspect. Face-fit with a 0.75×depth margin keeps the
        // camera outside the front face at the default tilt while staying
        // close enough that content actually fills the pane.
        const s = fitted.getSize(new THREE.Vector3());
        const center = fitted.getCenter(new THREE.Vector3());
        const vHalf = (r.camera.fov * Math.PI / 180) / 2;
        const hHalf = Math.atan(Math.tan(vHalf) * aspect);
        const dV = (s.y / 2) / Math.tan(vHalf);
        const dH = (s.x / 2) / Math.tan(hHalf);
        const dist = Math.max(dV, dH) * 1.1 + s.z * 0.75;
        _lowerOrbitFit(dist, center);
      }
    }
  }

  if (_rafId) cancelAnimationFrame(_rafId);
  const loop = () => {
    if (!document.getElementById(ID)) { _rafId = 0; return; }
    if (_composer) _composer.render(); else r.renderer.render(r.scene, r.camera);
    _rafId = requestAnimationFrame(loop);
  };
  _rafId = requestAnimationFrame(loop);
}

/** Billboard text sprite drawn to a canvas texture — used by label3d(). */
export function makeTextSprite(text: string, color: string, size: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  const fontPx = 44;
  const g = cv.getContext('2d')!;
  g.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  const tw = Math.ceil(g.measureText(text).width);
  cv.width = Math.max(2, tw + 24);
  cv.height = fontPx + 20;
  const g2 = cv.getContext('2d')!;
  g2.font = `700 ${fontPx}px ui-monospace, Menlo, monospace`;
  g2.textBaseline = 'middle';
  // pill backing so labels stay readable over bright geometry
  g2.fillStyle = 'rgba(6,6,18,0.65)';
  g2.beginPath();
  (g2 as any).roundRect ? (g2 as any).roundRect(0, 0, cv.width, cv.height, 12) : g2.rect(0, 0, cv.width, cv.height);
  g2.fill();
  g2.fillStyle = color;
  g2.fillText(text, 12, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const s = 0.45 * Math.max(0.2, Math.min(3, size));
  sprite.scale.set((cv.width / cv.height) * s, s, 1);
  return sprite;
}

function dispose(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) { obj.geometry?.dispose(); const m = obj.material; if (Array.isArray(m)) m.forEach(x => x.dispose()); else m?.dispose(); }
  if (obj instanceof THREE.Sprite) { obj.material.map?.dispose(); obj.material.dispose(); }
  if (obj instanceof THREE.Group) obj.children.forEach(c => dispose(c));
}

export function hide3D(): void {
  _ok = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  _composer?.dispose();
  _composer = null; _bloomPass = null;
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  _scene = null; _camera = null;
  _lowerOrbitFit = null;
  _lastLowerFitSig = null;
  const c = document.getElementById(ID); if (c) { c.onpointerdown = null; c.onpointermove = null; c.onpointerup = null; c.onwheel = null; c.remove(); }
  const sec = document.getElementById('secondary-canvas');
  if (sec) sec.style.display = '';
  // Mobile: restore the hidden 2D lower canvas.
  if (_hostFallback) {
    const lower2d = _hostFallback.querySelector('#mobile-lower-canvas') as HTMLElement | null;
    if (lower2d) lower2d.style.display = '';
  }
}

// ─── Inline camera orbit (plain events, no class) ──────────────────
// Content-fit hook into the orbit closure's own state, so a programmatic
// refit and a subsequent user drag agree on distance/target instead of the
// drag snapping back to stale values.
let _lowerOrbitFit: ((dist: number, target: THREE.Vector3) => void) | null = null;
let _lastLowerFitSig: string | null = null;

function enableOrbit(dom: HTMLCanvasElement, camera: THREE.PerspectiveCamera): void {
  let dragging = false, lx = 0, ly = 0, theta = 0, phi = 0.8, dist = 10;
  const target = new THREE.Vector3(0, 1.8, 0);
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

  _lowerOrbitFit = (d: number, t: THREE.Vector3) => {
    dist = Math.max(4, Math.min(60, d));
    target.copy(t);
    apply();
  };

  // Touch support — phones/tablets never send pointerType 'mouse', which made
  // every orbit gesture dead on mobile. One finger drags to orbit; two-finger
  // pinch zooms; a minimal-drag touch falls through (no preventDefault) so
  // taps keep reaching anything beneath.
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
        dist = Math.max(4, Math.min(60, pinchDist0 * (pinchStart / Math.max(1, pinch))));
        movedFar = true;
        apply();
      }
      e.preventDefault();
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    if (Math.abs(dx) + Math.abs(dy) > 6) movedFar = true;
    theta -= dx * 0.01;
    phi = Math.max(0.2, Math.min(1.4, phi - dy * 0.01));
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
  // Wheel zoom (desktop) — on touch devices wheel events are synthesized with
  // ctrlKey from pinches; both paths land here and stay clamped.
  dom.onwheel = (e: WheelEvent) => {
    dist = Math.max(4, Math.min(60, dist + e.deltaY * 0.02));
    apply(); e.preventDefault();
  };
}
