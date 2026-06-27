import * as THREE from 'three';

export type CameraMode = 'orbit' | 'trackball' | 'first-person';

export class CameraController {
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;
  private mode: CameraMode = 'orbit';
  private spherical: THREE.Spherical = new THREE.Spherical(80, Math.PI / 4, 0);
  private target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private isDragging = false;
  private previousMouse = new THREE.Vector2();
  private minDistance = 10;
  private maxDistance = 500;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.attachListeners();
    this.updateCamera();
  }

  private attachListeners(): void {
    this.domElement.addEventListener('mousedown', this.onMouseDown);
    this.domElement.addEventListener('mousemove', this.onMouseMove);
    this.domElement.addEventListener('mouseup', this.onMouseUp);
    this.domElement.addEventListener('wheel', this.onWheel);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.isDragging = true;
      this.previousMouse.set(e.clientX, e.clientY);
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging) return;
    const deltaX = e.clientX - this.previousMouse.x;
    const deltaY = e.clientY - this.previousMouse.y;

    if (this.mode === 'orbit') {
      this.spherical.theta -= deltaX * 0.005;
      this.spherical.phi -= deltaY * 0.005;
      this.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.spherical.phi));
    }

    this.previousMouse.set(e.clientX, e.clientY);
  };

  private onMouseUp = (): void => {
    this.isDragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    this.spherical.radius += e.deltaY * 0.05;
    this.spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.spherical.radius));
  };

  private updateCamera(): void {
    const pos = new THREE.Vector3();
    pos.setFromSpherical(this.spherical);
    pos.add(this.target);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }

  update(): void {
    this.updateCamera();
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  focusOn(point: THREE.Vector3): void {
    this.target.copy(point);
  }

  reset(): void {
    this.spherical.set(80, Math.PI / 4, 0);
    this.target.set(0, 0, 0);
  }

  detach(): void {
    this.domElement.removeEventListener('mousedown', this.onMouseDown);
    this.domElement.removeEventListener('mousemove', this.onMouseMove);
    this.domElement.removeEventListener('mouseup', this.onMouseUp);
    this.domElement.removeEventListener('wheel', this.onWheel);
  }
}
