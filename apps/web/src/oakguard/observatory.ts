/**
 * OakGuard Observatory — "The Crucible".
 *
 * A dedicated Three.js scene where the self-improvement loop is visible.
 * Every dynamic channel binds to a real evaluator number:
 *   core rings   = promoted rules (labelled by issue code)
 *   mutant swarm = generated mutants (caught collapse at the shield,
 *                  escaped reach the core and pulse it red)
 *   pipeline     = the candidate's actual stage
 *   shards       = emeritus (rejected) rules, dim orbit
 *
 * Renderer discipline (this scene only): hero emissive for semantic
 * geometry, structure dim, FogExp2 depth, in-scene starfield, no
 * data-free random emissive.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { makeTextSprite } from '../three-lower-pane';

export const STAGE_NAMES = ['FAILURE', 'CANDIDATE', 'PROBATION', 'DUEL', 'GATE'] as const;

const CORE_POS = new THREE.Vector3(0, -0.4, 0);

function glowTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(160,240,255,0.55)');
  grad.addColorStop(1, 'rgba(120,200,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

interface SwarmParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  caught: boolean;
  state: 'fly' | 'dead' | 'hit';
  delay: number;
}

export class OakGuardObservatory {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private raf = 0;
  private disposed = false;
  private coreGroup = new THREE.Group();
  private coreInner: THREE.Mesh;
  private coreGlow: THREE.Sprite;
  private rings = new THREE.Group();
  private shards = new THREE.Group();
  private stageNodes: THREE.Mesh[] = [];
  private stageMats: THREE.MeshBasicMaterial[] = [];
  private swarm: SwarmParticle[] = [];
  private swarmPoints: THREE.Points | null = null;
  private corePulse = 0;
  private coreAlert = 0;
  private theta = 0;
  private phi = 1.05;
  private dist = 12.5;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private startedAt = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    const w = canvas.clientWidth || 960;
    const h = canvas.clientHeight || 540;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0x04040c);
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.028);

    this.camera = new THREE.PerspectiveCamera(46, w / Math.max(h, 1), 0.1, 200);

    // Atmosphere: starfield + floor grid (structure stays dim, never blooms).
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(900 * 3);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 900; i++) {
      const r = 30 + rnd() * 55;
      const a = rnd() * Math.PI * 2;
      const y = (rnd() - 0.35) * 40;
      starPos[i * 3] = Math.cos(a) * r;
      starPos[i * 3 + 1] = y;
      starPos[i * 3 + 2] = Math.sin(a) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8fb8ff, size: 0.14, transparent: true, opacity: 0.75, fog: false }));
    this.scene.add(stars);

    const grid = new THREE.GridHelper(48, 32, 0x1c2a55, 0x0d1330);
    grid.position.y = -3.2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    // Playbook Core: dim wire sphere (structure) + hero inner core (semantic).
    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.75, 2),
      new THREE.MeshBasicMaterial({ color: 0x1e6f8e, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    this.coreGroup.add(wire);
    this.coreInner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.82, 3),
      new THREE.MeshBasicMaterial({ color: 0x8fe8ff }),
    );
    this.coreGroup.add(this.coreInner);
    this.coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x2f7fd0, transparent: true, opacity: 0.4, depthWrite: false }));
    this.coreGlow.scale.set(3.4, 3.4, 1);
    this.coreGroup.add(this.coreGlow);
    this.coreGroup.position.copy(CORE_POS);
    this.scene.add(this.coreGroup);
    this.scene.add(this.rings);
    this.rings.position.copy(CORE_POS);
    this.scene.add(this.shards);
    this.shards.position.copy(CORE_POS);

    const coreLabel = makeTextSprite('PLAYBOOK CORE', '#9be8ff', 1.1);
    coreLabel.position.set(0, -3.0, 0);
    this.scene.add(coreLabel);

    // Pipeline stage nodes.
    STAGE_NAMES.forEach((name, i) => {
      const x = -5.2 + i * 2.6;
      const mat = new THREE.MeshBasicMaterial({ color: 0x24405e });
      const node = new THREE.Mesh(new THREE.OctahedronGeometry(0.34), mat);
      node.position.set(x, 2.75, 0);
      this.scene.add(node);
      this.stageNodes.push(node);
      this.stageMats.push(mat);
      const label = makeTextSprite(name, '#7fa8d8', 0.85);
      label.position.set(x, 2.05, 0);
      this.scene.add(label);
      if (i > 0) {
        const prev = new THREE.Vector3(-5.2 + (i - 1) * 2.6, 2.75, 0);
        const mid = prev.clone().lerp(node.position, 0.5); mid.y += 0.55;
        const curve = new THREE.QuadraticBezierCurve3(prev, mid, node.position.clone());
        const arc = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
          new THREE.LineBasicMaterial({ color: 0x2b5a86, transparent: true, opacity: 0.8 }),
        );
        this.scene.add(arc);
      }
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.45, 0.3);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());

    this.bindPointer();
    this.applyCamera();
    this.loop();
  }

  private bindPointer(): void {
    const c = this.canvas;
    c.style.cursor = 'grab';
    c.onpointerdown = (e) => { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; c.setPointerCapture(e.pointerId); };
    c.onpointermove = (e) => {
      if (!this.dragging) return;
      this.theta -= (e.clientX - this.lastX) * 0.005;
      this.phi = Math.max(0.35, Math.min(1.45, this.phi - (e.clientY - this.lastY) * 0.004));
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.applyCamera();
    };
    c.onpointerup = () => { this.dragging = false; };
    c.onwheel = (e) => { e.preventDefault(); this.dist = Math.max(6, Math.min(20, this.dist + e.deltaY * 0.01)); this.applyCamera(); };
  }

  private applyCamera(): void {
    this.camera.position.set(
      CORE_POS.x + this.dist * Math.sin(this.phi) * Math.sin(this.theta),
      CORE_POS.y + this.dist * Math.cos(this.phi),
      CORE_POS.z + this.dist * Math.sin(this.phi) * Math.cos(this.theta),
    );
    this.camera.lookAt(CORE_POS.x, 0.6, CORE_POS.z);
  }

  setStage(index: number): void {
    this.stageMats.forEach((mat, i) => {
      mat.color.set(i < index ? 0x2f9e6e : i === index ? 0xaef4ff : 0x24405e);
    });
  }

  setPlaybook(issueCodes: string[]): void {
    while (this.rings.children.length) {
      const child = this.rings.children.pop()!;
      this.rings.remove(child);
    }
    issueCodes.forEach((code, i) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.25 + i * 0.38, 0.02, 8, 90),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0x66ffb8 : 0x6fd6ff }),
      );
      ring.rotation.x = Math.PI / 2 + (i * 0.35);
      ring.rotation.y = i * 0.5;
      ring.name = `ring-${code}`;
      this.rings.add(ring);
      const label = makeTextSprite(code, '#aef4c8', 0.8);
      label.position.set(Math.cos(i * 2.1) * (2.6 + i * 0.38), 0.5 + i * 0.3, Math.sin(i * 2.1) * (2.6 + i * 0.38));
      this.rings.add(label);
    });
    this.corePulse = 1;
  }

  pulseEscape(): void {
    this.coreAlert = 1;
    this.corePulse = 1;
  }

  launchSwarm(total: number, caught: number): void {
    if (this.swarmPoints) { this.scene.remove(this.swarmPoints); this.swarmPoints.geometry.dispose(); this.swarmPoints = null; }
    this.swarm = [];
    const N = Math.min(220, Math.max(24, total * 6));
    let seed = 1234;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 11 + rnd() * 5;
      const pos = new THREE.Vector3(Math.cos(a) * r, (rnd() - 0.3) * 7, Math.sin(a) * r);
      const isCaught = i < Math.round(N * (total > 0 ? caught / total : 0));
      this.swarm.push({ pos, vel: new THREE.Vector3(), caught: isCaught, state: 'fly', delay: rnd() * 1.6 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.swarmPoints = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffc46b, size: 0.17, transparent: true, opacity: 0.95 }));
    this.scene.add(this.swarmPoints);
    this.setStage(2);
  }

  rejectToEmeritus(name: string): void {
    const shard = new THREE.Mesh(
      new THREE.TetrahedronGeometry(0.22),
      new THREE.MeshBasicMaterial({ color: 0x6b4a8f, wireframe: true, transparent: true, opacity: 0.8 }),
    );
    const i = this.shards.children.length;
    const a = i * 1.37;
    shard.position.set(Math.cos(a) * 3.4, -1.2 + (i % 3) * 0.5, Math.sin(a) * 3.4);
    shard.name = `emeritus-${name}`;
    this.shards.add(shard);
    this.coreAlert = Math.max(this.coreAlert, 0.6);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.canvas.clientWidth === 0) return; // hidden (panel closed) — don't burn GPU
    const t = (performance.now() - this.startedAt) / 1000;

    this.coreGroup.rotation.y = t * 0.12;
    this.rings.rotation.y = -t * 0.07;
    this.shards.rotation.y = t * 0.05;
    const alert = this.coreAlert;
    this.coreInner.scale.setScalar(1 + this.corePulse * 0.25 + Math.sin(t * 2.2) * 0.03);
    (this.coreInner.material as THREE.MeshBasicMaterial).color.setRGB(0.35 + alert * 2.0, 0.85 - alert * 0.5, 1 - alert * 0.5);
    this.coreGlow.material.color.setRGB(0.25 + alert * 1.8, 0.6 - alert * 0.3, 0.9 - alert * 0.35);
    this.corePulse = Math.max(0, this.corePulse - 0.015);
    this.coreAlert = Math.max(0, this.coreAlert - 0.008);
    this.stageNodes.forEach((n, i) => { n.rotation.y = t * (0.6 + i * 0.1); });

    if (this.swarmPoints && this.swarm.length) {
      const attr = this.swarmPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      let alive = false;
      this.swarm.forEach((p, i) => {
        if (p.delay > 0) { p.delay -= 0.016; attr.setXYZ(i, p.pos.x, p.pos.y, p.pos.z); return; }
        if (p.state === 'fly') {
          alive = true;
          const toCore = CORE_POS.clone().sub(p.pos);
          const d = toCore.length();
          p.vel.add(toCore.normalize().multiplyScalar(0.006));
          p.vel.multiplyScalar(0.985);
          p.pos.add(p.vel.clone().multiplyScalar(2.4));
          const shieldR = 2.55;
          if (p.caught && d < shieldR) { p.state = 'dead'; p.pos.set(CORE_POS.x + 60, -60, 0); }
          else if (!p.caught && d < 1.1) { p.state = 'hit'; this.pulseEscape(); p.pos.set(CORE_POS.x + 60, -60, 0); }
          attr.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
        } else {
          attr.setXYZ(i, 60, -60, 0);
        }
      });
      attr.needsUpdate = true;
      if (!alive && this.swarm.every(p => p.delay <= 0)) this.swarm = [];
    }

    this.composer.render();
  };

  resize(): void {
    const w = this.canvas.clientWidth || 960;
    const h = this.canvas.clientHeight || 540;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.onpointerdown = null;
    this.canvas.onpointermove = null;
    this.canvas.onpointerup = null;
    this.canvas.onwheel = null;
  }
}
