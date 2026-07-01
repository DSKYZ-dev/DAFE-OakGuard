import * as THREE from 'three';
import type { BaseBar } from '@dafe/types';
import type { PerBarVolume } from './data-generator';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  type ViewState, chartRight, visibleBarCount, getVisibleRange, barX,
  DEFAULT_BAR_SPACING, TOP_FRAC, BOT_FRAC,
} from './chart-renderer';

export class ThreeDRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private barGroup: THREE.Group;
  private gridGroup: THREE.Group;
  private particleGroup: THREE.Group;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private postEnabled = true;
  private width = 0;
  private height = 0;
  private view: ViewState = { scrollX: 0, barSpacing: DEFAULT_BAR_SPACING, offsetY: 0, scaleY: 1 };
  private bars: BaseBar[] = [];
  private perBarVols?: PerBarVolume[];
  private needsRebuild = true;
  private buildPending = false;
  private camTheta = -0.35;
  private camPhi = 0.25;

  // Shared materials (reused to avoid GC) — NEVER disposed during rebuilds
  private bullMat: THREE.MeshStandardMaterial;
  private bearMat: THREE.MeshStandardMaterial;
  private bullVolMat: THREE.MeshStandardMaterial;
  private bearVolMat: THREE.MeshStandardMaterial;
  private bullWickMat: THREE.LineBasicMaterial;
  private bearWickMat: THREE.LineBasicMaterial;
  private wickMat: THREE.LineBasicMaterial;
  // Shared unit-cube geometry reused by every instanced candle/volume mesh
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private dummy = new THREE.Object3D();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0a0a18, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a18);

    // Camera — will be resized to match canvas
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);

    // Lighting
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    const hemi = new THREE.HemisphereLight(0xb48cff, 0x0a0a18, 0.4);
    const dir = new THREE.DirectionalLight(0xb48cff, 0.9);
    dir.position.set(200, 400, 500);
    const backDir = new THREE.DirectionalLight(0x22cc88, 0.3);
    backDir.position.set(-200, -100, -300);
    this.scene.add(ambient, hemi, dir, backDir);

    // Materials — physically-lit glass-glow candles for premium visuals
    this.bullMat = new THREE.MeshStandardMaterial({
      color: 0x1affa0, emissive: 0x0a3322, emissiveIntensity: 0.9,
      metalness: 0.55, roughness: 0.18,
    });
    this.bearMat = new THREE.MeshStandardMaterial({
      color: 0xff3b6b, emissive: 0x33060f, emissiveIntensity: 0.9,
      metalness: 0.55, roughness: 0.18,
    });
    this.bullVolMat = new THREE.MeshStandardMaterial({
      color: 0x1affa0, emissive: 0x1affa0, emissiveIntensity: 0.25,
      transparent: true, opacity: 0.4, metalness: 0.1, roughness: 0.6,
    });
    this.bearVolMat = new THREE.MeshStandardMaterial({
      color: 0xff3b6b, emissive: 0xff3b6b, emissiveIntensity: 0.25,
      transparent: true, opacity: 0.36, metalness: 0.1, roughness: 0.6,
    });
    this.bullWickMat = new THREE.LineBasicMaterial({
      color: 0x1affa0, transparent: true, opacity: 0.5,
    });
    this.bearWickMat = new THREE.LineBasicMaterial({
      color: 0xff3b6b, transparent: true, opacity: 0.5,
    });
    this.wickMat = new THREE.LineBasicMaterial({
      color: 0xaab4ff, transparent: true, opacity: 0.4,
    });

    this.barGroup = new THREE.Group();
    this.gridGroup = new THREE.Group();
    this.particleGroup = new THREE.Group();
    this.scene.add(this.gridGroup);
    this.scene.add(this.barGroup);
    this.scene.add(this.particleGroup);

    // Post-processing — bloom for glow effects
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(800, 600), 0.4, 0.3, 0.1);
    this.bloomPass.threshold = 0.1;
    this.bloomPass.strength = 0.5;
    this.bloomPass.radius = 0.8;
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // Depth fog for atmospheric depth
    this.scene.fog = new THREE.FogExp2(0x0a0a18, 0.0008);
  }

  // ── Grid centered at (cx, 0, 0) in XZ plane ──
  private buildGrid(cx: number): void {
    while (this.gridGroup.children.length) {
      const c = this.gridGroup.children[0] as any;
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      this.gridGroup.remove(c);
    }
    const gridW = Math.max(200, this.width * 0.85);
    const divisions = 16;
    const mat = new THREE.LineBasicMaterial({
      color: 0xb48cff, transparent: true, opacity: 0.06,
    });
    const verts: number[] = [];
    const half = gridW / 2;
    for (let i = 0; i <= divisions; i++) {
      const t = i / divisions;
      const xPos = cx - half + t * gridW;
      const zPos = -half + t * gridW;
      verts.push(xPos, 0, -half, xPos, 0, half);
      verts.push(cx - half, 0, zPos, cx + half, 0, zPos);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.gridGroup.add(new THREE.LineSegments(geo, mat));
  }
  // ── Store data, trigger lazy rebuild ──
  updateBars(bars: BaseBar[], perBarVols?: PerBarVolume[]): void {
    this.bars = bars;
    this.perBarVols = perBarVols;
    this.needsRebuild = true;
  }

  setView(view: ViewState): void {
    if (this.view.scrollX === view.scrollX && this.view.barSpacing === view.barSpacing &&
        this.view.offsetY === view.offsetY && this.view.scaleY === view.scaleY) {
      return;
    }
    this.view = { ...view };
    this.needsRebuild = true;
  }

  private clearGroup(group: THREE.Group): void {
    while (group.children.length) {
      const c = group.children[0] as any;
      // Only dispose unique geometries; never dispose the shared unit box or shared materials
      if (c.geometry && c.geometry !== this.unitBox) c.geometry.dispose();
      group.remove(c);
    }
  }

  private rebuild(): void {
    this.buildPending = false;
    this.clearGroup(this.barGroup);
    this.clearGroup(this.particleGroup);

    const n = this.bars.length;
    if (n === 0) return;

    // Compute visible range using the shared right-anchored model
    const { start, end } = getVisibleRange(this.view, this.width, n);
    if (start >= n) return;
    const visible = this.bars.slice(start, Math.min(end + 1, n));
    const vLen = visible.length;
    if (vLen === 0) return;

    const all = visible.flatMap(b => [b.high, b.low]);
    const minP = Math.min(...all);
    const maxP = Math.max(...all);
    const pRange = maxP - minP || 1;

    const bs = this.view.barSpacing;
    const chartH = this.height * (BOT_FRAC - TOP_FRAC);
    const bw = Math.max(1.2, bs * 0.7);
    const depth = Math.max(2, bw); // square-ish pillars read as true 3D

    const bxOf = (vi: number) => (vi - (vLen - 1) / 2) * bs;
    const p2y = (p: number) => ((p - minP) / pRange - 0.5) * chartH;

    // ── Count bull/bear for instanced allocation ──
    let bullCount = 0, bearCount = 0;
    for (const b of visible) (b.close >= b.open ? bullCount++ : bearCount++);

    const bullInst = new THREE.InstancedMesh(this.unitBox, this.bullMat, Math.max(1, bullCount));
    const bearInst = new THREE.InstancedMesh(this.unitBox, this.bearMat, Math.max(1, bearCount));
    bullInst.count = bullCount;
    bearInst.count = bearCount;

    // ── Wick line segments (single merged buffer) ──
    const wickVerts = new Float32Array(vLen * 6);

    // ── Volume extrusion instancing (bounded for resource efficiency) ──
    const volLevelsTotal: number[] = [];
    let volBull = 0, volBear = 0;
    if (this.perBarVols) {
      for (let vi = 0; vi < vLen; vi++) {
        const pv = this.perBarVols[start + vi];
        if (pv && pv.levels.length) {
          for (const lv of pv.levels) (lv.buyVol / Math.max(lv.volume, 0.001) > 0.5 ? volBull++ : volBear++);
        }
      }
    }
    const volBullInst = new THREE.InstancedMesh(this.unitBox, this.bullVolMat, Math.max(1, volBull));
    const volBearInst = new THREE.InstancedMesh(this.unitBox, this.bearVolMat, Math.max(1, volBear));
    volBullInst.count = volBull; volBearInst.count = volBear;

    const d = this.dummy;
    let bi = 0, bei = 0, vbi = 0, vbei = 0;

    for (let vi = 0; vi < vLen; vi++) {
      const bar = visible[vi];
      const bx = bxOf(vi);
      const openY = p2y(bar.open);
      const closeY = p2y(bar.close);
      const highY = p2y(bar.high);
      const lowY = p2y(bar.low);
      const isBull = bar.close >= bar.open;
      const bodyTop = Math.min(openY, closeY);
      const bodyBot = Math.max(openY, closeY);
      const bodyH = Math.max(0.6, bodyBot - bodyTop);
      const bodyMid = (bodyTop + bodyBot) / 2;

      // Candle body instance
      d.position.set(bx, bodyMid, 0);
      d.scale.set(bw, bodyH, depth);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      if (isBull) bullInst.setMatrixAt(bi++, d.matrix);
      else bearInst.setMatrixAt(bei++, d.matrix);

      // Wick segment
      const o = vi * 6;
      wickVerts[o] = bx; wickVerts[o + 1] = highY; wickVerts[o + 2] = 0;
      wickVerts[o + 3] = bx; wickVerts[o + 4] = lowY; wickVerts[o + 5] = 0;

      // Volume profile extrusion (instanced)
      const pv = this.perBarVols ? this.perBarVols[start + vi] : undefined;
      if (pv && pv.levels.length > 0) {
        const volFactor = Math.min(1, bar.volume / 4000);
        const levelH = (chartH / pRange) * ((bar.high - bar.low) / pv.levels.length) * 1.1;
        const maxDepth = 6 + volFactor * 26;
        for (const level of pv.levels) {
          const ly = p2y(level.price);
          const vr = level.volume / pv.maxVol;
          const dz = 4 + vr * maxDepth;
          d.position.set(bx, ly, -depth / 2 - dz / 2);
          d.scale.set(bw * 0.7, Math.max(0.4, levelH), dz);
          d.rotation.set(0, 0, 0);
          d.updateMatrix();
          if (level.buyVol / Math.max(level.volume, 0.001) > 0.5) volBullInst.setMatrixAt(vbi++, d.matrix);
          else volBearInst.setMatrixAt(vbei++, d.matrix);
        }
      }
    }

    bullInst.instanceMatrix.needsUpdate = true;
    bearInst.instanceMatrix.needsUpdate = true;
    volBullInst.instanceMatrix.needsUpdate = true;
    volBearInst.instanceMatrix.needsUpdate = true;
    if (bullCount) this.barGroup.add(bullInst);
    if (bearCount) this.barGroup.add(bearInst);
    if (volBull) this.barGroup.add(volBullInst);
    if (volBear) this.barGroup.add(volBearInst);

    // Wicks as one LineSegments draw call
    const wickGeo = new THREE.BufferGeometry();
    wickGeo.setAttribute('position', new THREE.BufferAttribute(wickVerts, 3));
    this.barGroup.add(new THREE.LineSegments(wickGeo, this.wickMat));

    // Chart is centered at the origin in local coords
    const cx = 0;
    const chartW = vLen * bs;

    // Build grid at chart center
    this.buildGrid(cx);

    // Keep aspect ratio so bars aren't stretched. Frustum framed to the
    // chart width plus margin, height derived from the canvas aspect.
    const margin = 1.2;
    const aspect = this.width / Math.max(1, this.height);
    const halfW = (chartW * margin) / 2;
    const halfH = halfW / aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;

    // Orbit camera around the origin. For an orthographic camera the on-screen
    // size is fixed by the frustum, so radius only affects depth/parallax.
    const radius = Math.max(chartW, chartH) * 1.5 + 1000;
    // Positive near/far that safely bracket the whole scene depth.
    this.camera.near = Math.max(1, radius - Math.max(chartW, chartH) - 500);
    this.camera.far = radius + Math.max(chartW, chartH) + 500;
    this.camera.updateProjectionMatrix();

    const camX = cx + radius * Math.sin(this.camTheta) * Math.cos(this.camPhi);
    const camY = radius * Math.sin(this.camPhi);
    const camZ = radius * Math.cos(this.camTheta) * Math.cos(this.camPhi);
    this.camera.position.set(camX, camY, camZ);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(cx, 0, 0);
  }

  rotate(dxPct: number, dyPct: number): void {
    this.camTheta -= dxPct * 2.0;
    this.camPhi = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this.camPhi + dyPct * 1.5));
    this.needsRebuild = true;
  }

  // ── Render (rebuilds geometry if view/data changed) ──
  render(): void {
    if (this.needsRebuild && this.bars.length > 0) {
      this.needsRebuild = false;
      this.rebuild();
    }
    if (this.postEnabled) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ── Resize (frustum is set in rebuild() with chart-area bounds) ──
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.needsRebuild = true;
  }

  togglePostProcessing(enabled: boolean): void {
    this.postEnabled = enabled;
  }

  setBloomStrength(s: number): void {
    this.bloomPass.strength = Math.max(0, Math.min(3, s));
  }

  // ── Cleanup ──
  dispose(): void {
    this.composer.dispose();
    this.renderer.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material?.dispose();
        }
      }
    });
    this.bullMat.dispose();
    this.bearMat.dispose();
    this.bullVolMat.dispose();
    this.bearVolMat.dispose();
    this.bullWickMat.dispose();
    this.bearWickMat.dispose();
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
}
