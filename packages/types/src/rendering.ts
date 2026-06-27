import type { BarTypeId } from './bars';
import type { VolumeProfileConfig } from './volume';

export type ChartMode = '2D' | '3D';
export type RenderBackend = 'webgpu' | 'webgl2' | 'canvas2d';
export type CameraMode = 'perspective' | 'orthographic' | 'cinematic' | 'first-person' | 'top-down';

export interface LayerConfig {
  id: string;
  zIndex: number;
  enabled: boolean;
  opacity: number;
}

export interface CameraState {
  mode: CameraMode;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  rotation: [number, number, number];
}

export interface Theme {
  id: string;
  name: string;
  background: string;
  gridColor: string;
  textColor: string;
  accentColor: string;
  candleBull: string;
  candleBear: string;
  volumeProfileColors: ColorOverrides;
}

export interface ColorOverrides {
  bull: string;
  bear: string;
  poc: string;
  valueArea: string;
}

export interface RenderStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  gpuMemory: number;
  workerLatency: number;
}

export interface PostProcessingConfig {
  bloom: boolean;
  bloomStrength: number;
  ssao: boolean;
  fxaa: boolean;
  chromaticAberration: boolean;
  vignette: boolean;
  vignetteStrength: number;
}

export interface ChartConfig {
  mode: ChartMode;
  barType: BarTypeId;
  volumeProfile: VolumeProfileConfig;
  camera: CameraState;
  theme: Theme;
  postProcessing: PostProcessingConfig;
  performance: {
    targetFps: number;
    maxBars: number;
    lodEnabled: boolean;
    frustumCulling: boolean;
  };
}
