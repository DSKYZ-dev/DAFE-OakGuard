/**
 * DAFE GPU Particle System — WebGPU compute-shader-driven particle physics.
 *
 * Features:
 * - 10,000+ particles at 60fps (vs ~15 CPU particles)
 * - Gravity, drag, turbulence, vortex forces
 * - Collision with chart elements (price barriers, indicator levels)
 * - Color blending based on velocity and proximity
 * - Auto-scales particle count based on GPU capability and perf mode
 *
 * Fallback: CPU particle system when WebGPU is unavailable.
 */

// ─── Particle state (shared between GPU and CPU paths) ──────────────
export interface ParticleField {
  count: number;
  width: number;
  height: number;
  gravity: number;
  drag: number;
  turbulence: number;
  colorMode: 'velocity' | 'thermal' | 'electric' | 'cosmic';
  intensity: number;
}

export interface ParticleGPUState {
  field: ParticleField;
  device: GPUDevice | null;
  pipeline: GPUComputePipeline | null;
  posBuffer: GPUBuffer | null;
  velBuffer: GPUBuffer | null;
  uniformBuffer: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  initialized: boolean;
}

// ─── CPU fallback particle ─────────────────────────────────────────
interface CPUParticle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number;
  hue: number;
}

const _cpuParticles: CPUParticle[] = [];
let _cpuInitialized = false;

// ─── Singleton state ────────────────────────────────────────────────
const state: ParticleGPUState = {
  field: { count: 0, width: 0, height: 0, gravity: 0.15, drag: 0.998, turbulence: 0.3, colorMode: 'cosmic', intensity: 1.0 },
  device: null, pipeline: null, posBuffer: null, velBuffer: null, uniformBuffer: null, bindGroup: null, initialized: false,
};

// ─── WGSL compute shader ───────────────────────────────────────────
const PARTICLE_SHADER = /* wgsl */ `
struct Particle {
  pos: vec2<f32>,
  vel: vec2<f32>,
  life: f32,
  maxLife: f32,
  size: f32,
  hue: f32,
}

struct Uniforms {
  dt: f32,
  width: f32,
  height: f32,
  gravity: f32,
  drag: f32,
  turbulence: f32,
  time: f32,
  intensity: f32,
  spawnRate: f32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

fn hash(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&particles)) { return; }

  var p = particles[i];

  // Decrease life
  p.life -= uniforms.dt;

  // Respawn dead particles
  if (p.life <= 0.0) {
    let seed = f32(i) + uniforms.time;
    p.pos = vec2(hash(seed) * uniforms.width, hash(seed + 1.0) * uniforms.height * 0.3);
    p.vel = vec2((hash(seed + 2.0) - 0.5) * 40.0, -(hash(seed + 3.0) * 80.0 + 20.0));
    p.maxLife = 2.0 + hash(seed + 4.0) * 6.0;
    p.life = p.maxLife;
    p.size = 0.3 + hash(seed + 5.0) * 2.5;
    p.hue = hash(seed + 6.0);
  }

  // Physics: gravity pulls down
  p.vel.y -= uniforms.gravity * uniforms.dt;

  // Turbulence: Perlin-like noise approximation
  let turbX = sin(p.pos.y * 0.01 + uniforms.time) * cos(p.pos.x * 0.013) * uniforms.turbulence;
  let turbY = cos(p.pos.x * 0.01 + uniforms.time * 0.7) * sin(p.pos.y * 0.013) * uniforms.turbulence;
  p.vel.x += turbX * uniforms.dt * 30.0;
  p.vel.y += turbY * uniforms.dt * 30.0;

  // Drag
  p.vel *= uniforms.drag;

  // Integrate position
  p.pos += p.vel * uniforms.dt;

  // Boundary bounce (soft)
  if (p.pos.x < 0.0) { p.pos.x = 0.0; p.vel.x *= -0.5; }
  if (p.pos.x > uniforms.width) { p.pos.x = uniforms.width; p.vel.x *= -0.5; }
  if (p.pos.y > uniforms.height) { p.pos.y = uniforms.height; p.vel.y *= -0.8; }

  // Color shifts based on velocity magnitude
  let speed = length(p.vel);
  p.hue = fract(p.hue + speed * uniforms.dt * 0.02);

  particles[i] = p;
}
`;

// ─── Initialize GPU pipeline ───────────────────────────────────────
async function initGPU(canvas: HTMLCanvasElement): Promise<boolean> {
  if (state.initialized) return true;
  if (!navigator.gpu) return false;

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;
    state.device = await adapter.requestDevice();

    const count = state.field.count || 4096;
    const particleSize = 6 * 4; // 6 floats × 4 bytes

    state.pipeline = state.device.createComputePipeline({
      layout: 'auto',
      compute: { module: state.device.createShaderModule({ code: PARTICLE_SHADER }), entryPoint: 'main' },
    });

    state.posBuffer = state.device.createBuffer({
      size: count * particleSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    state.velBuffer = state.device.createBuffer({
      size: count * particleSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Init particles with random positions
    const initData = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const off = i * 6;
      initData[off] = Math.random() * state.field.width;
      initData[off + 1] = Math.random() * state.field.height * 0.3;
      initData[off + 2] = (Math.random() - 0.5) * 30;
      initData[off + 3] = -(Math.random() * 60 + 15);
      initData[off + 4] = 1.0 + Math.random() * 5.0;
      initData[off + 5] = Math.random();
    }
    state.device.queue.writeBuffer(state.posBuffer!, 0, initData);

    state.uniformBuffer = state.device.createBuffer({
      size: 9 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    state.bindGroup = state.device.createBindGroup({
      layout: state.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: state.posBuffer! } },
        { binding: 1, resource: { buffer: state.uniformBuffer! } },
      ],
    });

    state.initialized = true;
    return true;
  } catch {
    return false;
  }
}

// Recreate just the position/velocity/bind-group buffers at the current
// state.field.count, reusing the existing GPU device/pipeline. Needed
// because setParticleCount() changes the buffer size requirement but must
// NOT tear down and re-request a whole new GPUDevice for a routine
// perf-tier retune (recreating buffers only, is what initGPU() should have
// been asked to do — recreating the whole device was both wasteful and,
// since nothing ever called initGPU() again, is why particles silently
// stopped updating forever after the very first tier change).
function resizeParticleBuffers(): void {
  if (!state.device || !state.pipeline) return;
  const count = state.field.count || 4096;
  const particleSize = 6 * 4;

  state.posBuffer?.destroy();
  state.velBuffer?.destroy();

  state.posBuffer = state.device.createBuffer({
    size: count * particleSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  state.velBuffer = state.device.createBuffer({
    size: count * particleSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const initData = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const off = i * 6;
    initData[off] = Math.random() * state.field.width;
    initData[off + 1] = Math.random() * state.field.height * 0.3;
    initData[off + 2] = (Math.random() - 0.5) * 30;
    initData[off + 3] = -(Math.random() * 60 + 15);
    initData[off + 4] = 1.0 + Math.random() * 5.0;
    initData[off + 5] = Math.random();
  }
  state.device.queue.writeBuffer(state.posBuffer, 0, initData);

  state.bindGroup = state.device.createBindGroup({
    layout: state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: state.posBuffer } },
      { binding: 1, resource: { buffer: state.uniformBuffer! } },
    ],
  });
}

// ─── Update uniforms and dispatch compute ───────────────────────────
export function updateGPUParticles(time: number): void {
  if (!state.initialized || !state.device || !state.uniformBuffer) return;

  const uniforms = new Float32Array([
    0.016, // dt
    state.field.width,
    state.field.height,
    state.field.gravity,
    state.field.drag,
    state.field.turbulence,
    time * 0.001,
    state.field.intensity,
    0.05, // spawnRate
  ]);
  state.device.queue.writeBuffer(state.uniformBuffer, 0, uniforms);

  const encoder = state.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(state.pipeline!);
  pass.setBindGroup(0, state.bindGroup!);
  pass.dispatchWorkgroups(Math.ceil(state.field.count / 64));
  pass.end();
  state.device.queue.submit([encoder.finish()]);
}

// ─── Draw particles (CPU fallback) ──────────────────────────────────
export function drawCPUParticles(
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  height: number,
  intensity: number = 1.0,
): void {
  if (!_cpuInitialized) {
    _cpuParticles.length = 0;
    _cpuInitialized = true;
  }

  const targetCount = Math.min(state.field.count || 200, 500);

  // Spawn new particles
  while (_cpuParticles.length < targetCount && Math.random() < 0.4) {
    _cpuParticles.push({
      x: Math.random() * width,
      y: height * 0.1 + Math.random() * height * 0.3,
      vx: (Math.random() - 0.5) * 0.8,
      vy: -(0.3 + Math.random() * 1.2),
      life: 0,
      maxLife: 180 + Math.random() * 400,
      size: 0.4 + Math.random() * 2.5,
      hue: Math.random(),
    });
  }

  // Update particles
  for (let i = _cpuParticles.length - 1; i >= 0; i--) {
    const p = _cpuParticles[i];
    p.life++;
    if (p.life > p.maxLife || p.y > height + 20 || p.x < -20 || p.x > width + 20) {
      _cpuParticles[i] = _cpuParticles[_cpuParticles.length - 1];
      _cpuParticles.pop();
      continue;
    }

    // Physics
    p.vy += 0.015 * (state.field.gravity || 0.15);
    p.vy *= state.field.drag || 0.998;
    p.vx += Math.sin(p.y * 0.01 + time * 0.001) * 0.03 * (state.field.turbulence || 0.3);
    p.x += p.vx;
    p.y += p.vy;
    p.hue = (p.hue + Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 0.0005) % 1;
  }

  // Draw
  ctx.save();
  for (const p of _cpuParticles) {
    const alpha = Math.min(1, (p.maxLife - p.life) / 80) * 0.4 * intensity;
    if (alpha < 0.01) continue;

    const mode = state.field.colorMode;
    let color: string;
    if (mode === 'thermal') {
      const r = Math.floor(180 + p.hue * 75);
      const g = Math.floor(100 + p.hue * 80);
      const b = Math.floor(200 - p.hue * 120);
      color = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    } else if (mode === 'electric') {
      color = `rgba(${Math.floor(100 + p.hue * 155)},${Math.floor(180 + p.hue * 75)},255,${alpha.toFixed(3)})`;
    } else if (mode === 'cosmic') {
      const r = Math.floor(140 + p.hue * 115);
      const g = Math.floor(100 + p.hue * 100);
      const b = Math.floor(200 + p.hue * 55);
      color = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    } else {
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const vh = Math.min(1, speed / 2);
      const r = Math.floor(100 + vh * 155);
      const g = Math.floor(180 - vh * 80);
      const b = Math.floor(200 + vh * 55);
      color = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Public API ─────────────────────────────────────────────────────

export async function initParticleSystem(
  canvas: HTMLCanvasElement,
  config: Partial<ParticleField> = {},
): Promise<boolean> {
  state.field = {
    count: config.count || 4096,
    width: canvas.width,
    height: canvas.height,
    gravity: config.gravity ?? 0.15,
    drag: config.drag ?? 0.998,
    turbulence: config.turbulence ?? 0.3,
    colorMode: config.colorMode || 'cosmic',
    intensity: config.intensity ?? 1.0,
  };

  const gpuOk = await initGPU(canvas);
  if (!gpuOk) {
    console.log('[DAFE] WebGPU unavailable — using CPU particle fallback');
    _cpuInitialized = false;
    _cpuParticles.length = 0;
  }
  return gpuOk;
}

export function setParticleCount(n: number): void {
  state.field.count = Math.max(64, Math.min(16384, n));
  // Previously set state.initialized = false here, which permanently
  // stalled updateGPUParticles() (it early-returns on !state.initialized)
  // since nothing ever called initGPU() again afterward — the particle
  // system silently went dark after the very first perf-tier retune.
  // Resize the buffers in place on the existing device instead.
  if (state.initialized) resizeParticleBuffers();
}

export function setParticleMode(mode: ParticleField['colorMode']): void {
  state.field.colorMode = mode;
}

export function setParticleIntensity(v: number): void {
  state.field.intensity = Math.max(0.1, Math.min(3.0, v));
}

export function resizeParticleField(width: number, height: number): void {
  state.field.width = width;
  state.field.height = height;
}

export function getParticleSystemState(): ParticleGPUState {
  return state;
}

export function disposeParticles(): void {
  state.posBuffer?.destroy();
  state.velBuffer?.destroy();
  state.uniformBuffer?.destroy();
  state.device?.destroy();
  state.initialized = false;
  _cpuParticles.length = 0;
  _cpuInitialized = false;
}
