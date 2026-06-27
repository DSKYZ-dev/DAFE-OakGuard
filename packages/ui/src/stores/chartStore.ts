import type { BarTypeId, ChartMode, CameraMode, VolumeProfileConfig, Theme, PostProcessingConfig, CameraState } from '@dafe/types';
import { type VolumeProfileMode } from '@dafe/types';
import { dafe } from '@dafe/themes';

export interface ChartState {
  symbol: string;
  timeframe: string;
  mode: ChartMode;
  barType: BarTypeId;
  camera: CameraState;
  theme: Theme;
  volumeProfile: VolumeProfileConfig;
  postProcessing: PostProcessingConfig;
  fps: number;
  barCount: number;
  isPlaying: boolean;

  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: string) => void;
  setMode: (mode: ChartMode) => void;
  setBarType: (type: BarTypeId) => void;
  setCameraMode: (mode: CameraMode) => void;
  setTheme: (theme: Theme) => void;
  setVolumeProfile: (config: Partial<VolumeProfileConfig>) => void;
  toggleVolumeProfile: () => void;
  cycleVolumeProfileMode: () => void;
  setPlaying: (playing: boolean) => void;
}

const defaultVolumeProfile: VolumeProfileConfig = {
  enabled: false,
  mode: '2D-Side',
  priceResolution: 0.01,
  binningAlgorithm: 'fixed',
  orientation: 'right',
  colorScheme: {
    bullColor: [0, 1, 0.4],
    bearColor: [1, 0.2, 0.3],
    pocColor: [1, 1, 1],
    valueAreaColor: [0.3, 0.3, 0.5],
    backgroundColor: [0.05, 0.05, 0.08],
  },
  showPOC: true,
  showValueArea: true,
  valueAreaPercent: 70,
  extrusionDepth: 20,
  extrusionScale: 'linear',
  lighting: true,
  transparency: 0.85,
  maxBarsRendered: 1000,
  lodLevels: 3,
};

const volumeProfileModes: VolumeProfileMode[] = ['2D-Side', '2D-Per-Bar', '3D-Extrude', '3D-Heatmap'];

let state: ChartState = {
  symbol: 'BTC/USD',
  timeframe: '1m',
  mode: '2D',
  barType: 'candlestick',
  camera: { mode: 'perspective', position: [0, 30, 60], target: [0, 0, 0], zoom: 1, rotation: [0, 0, 0] },
  theme: dafe,
  volumeProfile: { ...defaultVolumeProfile },
  postProcessing: { bloom: false, bloomStrength: 0.3, ssao: false, fxaa: true, chromaticAberration: false, vignette: false, vignetteStrength: 0.3 },
  fps: 0,
  barCount: 0,
  isPlaying: true,

  setSymbol: (symbol: string) => { state.symbol = symbol; },
  setTimeframe: (timeframe: string) => { state.timeframe = timeframe; },
  setMode: (mode: ChartMode) => { state.mode = mode; },
  setBarType: (type: BarTypeId) => { state.barType = type; },
  setCameraMode: (mode: CameraMode) => { state.camera.mode = mode; },
  setTheme: (theme: Theme) => { state.theme = theme; },
  setVolumeProfile: (config: Partial<VolumeProfileConfig>) => {
    state.volumeProfile = { ...state.volumeProfile, ...config };
  },
  toggleVolumeProfile: () => {
    state.volumeProfile.enabled = !state.volumeProfile.enabled;
  },
  cycleVolumeProfileMode: () => {
    const currentIdx = volumeProfileModes.indexOf(state.volumeProfile.mode);
    const nextIdx = (currentIdx + 1) % volumeProfileModes.length;
    state.volumeProfile.mode = volumeProfileModes[nextIdx];
    state.volumeProfile.enabled = state.volumeProfile.mode !== '2D-Side' || state.volumeProfile.enabled;
  },
  setPlaying: (playing: boolean) => { state.isPlaying = playing; },
};

export function getChartState(): ChartState {
  return state;
}

export function getStore(): ChartState {
  return state;
}
