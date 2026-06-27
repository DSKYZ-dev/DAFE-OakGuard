import * as THREE from 'three';
import type { BaseBar, ChartConfig } from '@dafe/types';
import { CameraController } from './CameraController';
import { LightingRig } from './LightingRig';
import { MeshGenerator } from './MeshGenerator';
import { ModeTransition } from './ModeTransition';

export class Scene3D {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private cameraController: CameraController;
  private lightingRig: LightingRig;
  private meshGenerator: MeshGenerator;
  private modeTransition: ModeTransition;
  private barMeshes: THREE.InstancedMesh[] = [];
  private gridHelper: THREE.GridHelper;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0d0d14, 200, 500);

    this.camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 10000);
    this.camera.position.set(0, 40, 80);

    this.lightingRig = new LightingRig(this.scene);
    this.cameraController = new CameraController(this.camera, this.renderer.domElement);
    this.meshGenerator = new MeshGenerator();
    this.modeTransition = new ModeTransition(this);

    this.gridHelper = new THREE.GridHelper(200, 20, 0x444466, 0x333355);
    this.gridHelper.position.y = -10;
    this.scene.add(this.gridHelper);
  }

  setBars(bars: BaseBar[]): void {
    for (const mesh of this.barMeshes) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.barMeshes = [];

    const meshes = this.meshGenerator.generateBarMeshes(bars);
    for (const mesh of meshes) {
      this.scene.add(mesh);
      this.barMeshes.push(mesh);
    }
  }

  animate(): void {
    this.cameraController.update();
    this.renderer.render(this.scene, this.camera);
  }

  startTransition(to3D: boolean): void {
    this.modeTransition.transition(to3D);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  destroy(): void {
    this.renderer.dispose();
    this.scene.clear();
  }
}
