/**
 * 3D Lower Pane — renders OakScript plot3d data as Three.js scene below chart.
 * Minimal surface area — no mouse handlers, no orbit controls.
 */
import * as THREE from 'three';
import type { OakPlot3D } from './oakscript/runtime';

const ID = 'three-lower-scene';
let _ok = false;
let _rafId = 0;

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
  }
  try {
    const renderer = new THREE.WebGLRenderer({ canvas: c, alpha: false, antialias: true });
    renderer.setSize(c.parentElement?.clientWidth || 1200, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x060612);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x404060, 1.0));
    const d = new THREE.DirectionalLight(0xffffff, 0.7);
    d.position.set(3, 6, 5); scene.add(d);
    scene.add(new THREE.GridHelper(16, 12, 0x222244, 0x111122));
    const camera = new THREE.PerspectiveCamera(35, (c.parentElement?.clientWidth || 1200) / h, 0.1, 100);
    camera.position.set(0, 3.5, 10);
    camera.lookAt(0, 1.8, 0);
    enableOrbit(c, camera);
    return { renderer, scene, camera, canvas: c };
  } catch { return null; }
}

export function show3D(plots: OakPlot3D[]): void {
  if (plots.length === 0) { hide3D(); return; }
  const r = ensure();
  if (!r) return;
  _ok = true;

  // Clear old meshes
  while (r.scene.children.length > 3) {
    const ch = r.scene.children[r.scene.children.length - 1];
    if (ch instanceof THREE.Mesh || ch instanceof THREE.Group) { dispose(ch); r.scene.remove(ch); }
    else break;
  }

  const allVals = plots.flatMap(p => p.series.filter(v => isFinite(v) && !isNaN(v)));
  if (allVals.length < 2) return;
  const min = Math.min(...allVals), max = Math.max(...allVals), range = max - min || 1;
  const zSpacing = plots.length <= 1 ? 0 : -(plots.length - 1) * 1.2;

  for (let pi = 0; pi < plots.length; pi++) {
    const p = plots[pi];
    const z = zSpacing + pi * 2.4;
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
      const curve = new THREE.CatmullRomCurve3(pts);
      r.scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, 0.06, 6, false),
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
    }
  }

  const w = r.canvas.parentElement?.clientWidth || 1200;
  const h = (window as any).__dafeLowerHeight || 220;
  r.renderer.setSize(w, h, false);
  r.camera.aspect = w / h; r.camera.updateProjectionMatrix();

  // Start continuous render loop so camera orbit works
  if (_rafId) cancelAnimationFrame(_rafId);
  const loop = () => {
    if (!document.getElementById(ID)) { _rafId = 0; return; }
    r.renderer.render(r.scene, r.camera);
    _rafId = requestAnimationFrame(loop);
  };
  _rafId = requestAnimationFrame(loop);
}

function dispose(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh) { obj.geometry?.dispose(); const m = obj.material; if (Array.isArray(m)) m.forEach(x => x.dispose()); else m?.dispose(); }
  if (obj instanceof THREE.Group) obj.children.forEach(c => dispose(c));
}

export function hide3D(): void {
  _ok = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  const c = document.getElementById(ID); if (c) { c.onpointerdown = null; c.onpointermove = null; c.onpointerup = null; c.onwheel = null; c.remove(); }
  const sec = document.getElementById('secondary-canvas');
  if (sec) sec.style.display = '';
}

// ─── Inline camera orbit (plain events, no class) ──────────────────
function enableOrbit(dom: HTMLCanvasElement, camera: THREE.PerspectiveCamera): void {
  let dragging = false, lx = 0, ly = 0, theta = 0, phi = 0.8, dist = 10;
  const target = new THREE.Vector3(0, 1.8, 0);

  const apply = () => {
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.sin(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(target);
  };

  dom.onpointerdown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    dragging = true; lx = e.clientX; ly = e.clientY; e.preventDefault();
  };
  dom.onpointermove = (e: PointerEvent) => {
    if (!dragging) return;
    theta -= (e.clientX - lx) * 0.01;
    phi = Math.max(0.2, Math.min(1.4, phi - (e.clientY - ly) * 0.01));
    lx = e.clientX; ly = e.clientY;
    apply();
  };
  dom.onpointerup = () => { dragging = false; };
  dom.onwheel = (e: WheelEvent) => {
    dist = Math.max(4, Math.min(25, dist + e.deltaY * 0.02));
    apply(); e.preventDefault();
  };
}
