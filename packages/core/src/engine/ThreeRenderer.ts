import * as THREE from 'three';
import type { RenderBackend, ChartConfig, RenderStats } from '@dafe/types';
import type { RendererBackend } from './Renderer';

export class ThreeRenderer implements RendererBackend {
  readonly type: RenderBackend = 'webgl2';
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private config: ChartConfig | null = null;

  async initialize(canvas: HTMLCanvasElement, config: ChartConfig): Promise<void> {
    this.config = config;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x0d0d14);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0x404060, 0.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(50, 100, 50);
    this.scene.add(dirLight);

    const aspect = canvas.width / canvas.height || 1;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
    this.camera.position.set(0, 30, 60);
    this.camera.lookAt(0, 0, 0);
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    this.renderer.render(this.scene, this.camera);
  }

  getScene(): THREE.Scene | null {
    return this.scene;
  }

  getCamera(): THREE.PerspectiveCamera | null {
    return this.camera;
  }

  destroy(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }

  getStats(): RenderStats {
    return { fps: 0, drawCalls: 0, triangles: 0, gpuMemory: 0, workerLatency: 0 };
  }
}
