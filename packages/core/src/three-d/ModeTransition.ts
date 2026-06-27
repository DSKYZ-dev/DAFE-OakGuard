import type { Scene3D } from './Scene3D';

interface TweenState {
  cameraZ: number;
  cameraY: number;
  barDepth: number;
  lightIntensity: number;
}

export class ModeTransition {
  private scene3D: Scene3D;
  private isAnimating = false;

  constructor(scene3D: Scene3D) {
    this.scene3D = scene3D;
  }

  async transition(to3D: boolean, duration: number = 800): Promise<void> {
    if (this.isAnimating) return;
    this.isAnimating = true;

    const start: TweenState = {
      cameraZ: this.scene3D.camera.position.z,
      cameraY: this.scene3D.camera.position.y,
      barDepth: to3D ? 0 : 1,
      lightIntensity: to3D ? 0 : 1,
    };

    const end: TweenState = {
      cameraZ: to3D ? 50 : 0,
      cameraY: to3D ? 20 : 0,
      barDepth: to3D ? 1 : 0,
      lightIntensity: to3D ? 1 : 0,
    };

    const startTime = performance.now();

    await new Promise<void>(resolve => {
      const animate = (now: number) => {
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);
        const ease = this.easeInOutCubic(t);

        this.scene3D.camera.position.z = start.cameraZ + (end.cameraZ - start.cameraZ) * ease;
        this.scene3D.camera.position.y = start.cameraY + (end.cameraY - start.cameraY) * ease;

        if (t >= 1) resolve();
        else requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    });

    this.isAnimating = false;
  }

  private easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}
