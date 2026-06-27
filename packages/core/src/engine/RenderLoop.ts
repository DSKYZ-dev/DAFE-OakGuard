export type FrameCallback = (deltaTime: number, frameCount: number) => void;

export class RenderLoop {
  private animFrameId: number | null = null;
  private frameCount = 0;
  private lastTime = 0;
  private callbacks: FrameCallback[] = [];
  private running = false;
  private targetFps: number;

  constructor(targetFps = 120) {
    this.targetFps = targetFps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.tick(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const delta = now - this.lastTime;
    this.lastTime = now;
    this.frameCount++;

    const frameInterval = 1000 / this.targetFps;
    if (delta >= frameInterval) {
      for (const cb of this.callbacks) {
        cb(delta, this.frameCount);
      }
    }

    this.animFrameId = requestAnimationFrame(this.tick);
  };

  onFrame(cb: FrameCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter(c => c !== cb);
    };
  }

  setTargetFps(fps: number): void {
    this.targetFps = fps;
  }

  getFps(): number {
    return this.targetFps;
  }

  destroy(): void {
    this.stop();
    this.callbacks = [];
  }
}
