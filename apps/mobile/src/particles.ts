// Background particle field behind the chart column. Canvas 2D port of the
// desktop particle path in apps/web/src/gpu-particles.ts (drawCPUParticles).
// The WebGL check only decides whether the setting is offered.

const SETTING_KEY = 'dafe_mobile_particles';
const CHANGE_EVENT = 'dafe-particles-change';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MAX_PARTICLES = 300;
const GRAVITY = 0.15;
const DRAG = 0.998;
const TURBULENCE = 0.3;

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number; hue: number;
}

let supportedCache: boolean | null = null;
let host: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let rafId = 0;
let lastT = 0;
let width = 0;
let height = 0;
let dpr = 1;
const particles: Particle[] = [];

export function particlesSupported(): boolean {
  if (supportedCache !== null) return supportedCache;
  try {
    const probe = document.createElement('canvas');
    const gl: any = probe.getContext('webgl2') || probe.getContext('webgl');
    supportedCache = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    supportedCache = false;
  }
  return supportedCache;
}

export function particlesEnabled(): boolean {
  try { return localStorage.getItem(SETTING_KEY) === '1'; } catch { return false; }
}

export function setParticlesEnabled(on: boolean): void {
  try { localStorage.setItem(SETTING_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function mountParticleBackdrop(container: HTMLElement): void {
  if (canvas || !particlesSupported()) return;
  const c = document.createElement('canvas');
  c.className = 'particle-layer';
  c.setAttribute('aria-hidden', 'true');
  const context = c.getContext('2d');
  if (!context) return;
  canvas = c;
  ctx = context;
  host = container;
  container.insertBefore(c, container.firstChild);

  resize();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
  else window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener(CHANGE_EVENT, refresh);
  window.matchMedia?.(REDUCED_MOTION).addEventListener?.('change', refresh);
  refresh();
}

function reducedMotion(): boolean {
  return !!window.matchMedia?.(REDUCED_MOTION).matches;
}

function shouldRun(): boolean {
  if (!canvas || !host) return false;
  if (!particlesEnabled() || document.hidden || reducedMotion()) return false;
  return width > 0 && height > 0;
}

function resize(): void {
  if (!host || !canvas) return;
  width = host.clientWidth;
  height = host.clientHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // The host can be display:none when this mounts. Start the loop once it has size.
  if (shouldRun()) refresh();
  else stop();
}

function refresh(): void {
  if (shouldRun()) {
    if (!rafId) {
      lastT = 0;
      rafId = requestAnimationFrame(frame);
    }
  } else {
    stop();
  }
}

function stop(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  particles.length = 0;
  if (canvas && ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function spawn(): Particle {
  return {
    x: Math.random() * width,
    y: height * 0.1 + Math.random() * height * 0.3,
    vx: (Math.random() - 0.5) * 0.8,
    vy: -(0.3 + Math.random() * 1.2),
    life: 0,
    maxLife: 180 + Math.random() * 400,
    size: 0.4 + Math.random() * 2.5,
    hue: Math.random(),
  };
}

function step(dt: number, t: number): void {
  while (particles.length < MAX_PARTICLES && Math.random() < Math.min(1, 0.4 * dt)) {
    particles.push(spawn());
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life > p.maxLife || p.y > height + 20 || p.x < -20 || p.x > width + 20) {
      particles[i] = particles[particles.length - 1];
      particles.pop();
      continue;
    }
    p.vy += 0.015 * GRAVITY * dt;
    p.vy *= Math.pow(DRAG, dt);
    p.vx += Math.sin(p.y * 0.01 + t * 0.001) * 0.03 * TURBULENCE * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.hue = (p.hue + Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 0.0005 * dt) % 1;
  }
}

function draw(): void {
  if (!canvas || !ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  for (const p of particles) {
    const alpha = Math.min(1, (p.maxLife - p.life) / 80) * 0.4;
    if (alpha < 0.01) continue;
    const r = Math.floor(140 + p.hue * 115);
    const g = Math.floor(100 + p.hue * 100);
    const b = Math.floor(200 + p.hue * 55);
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function frame(t: number): void {
  rafId = 0;
  if (!shouldRun()) {
    stop();
    return;
  }
  const dt = lastT ? Math.min(3, (t - lastT) / 16.67) : 1;
  lastT = t;
  step(dt, t);
  draw();
  rafId = requestAnimationFrame(frame);
}
