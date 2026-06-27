export type VolumeProfileMode = '2D-Side' | '2D-Per-Bar' | '3D-Extrude' | '3D-Heatmap';
export type ProfileOrientation = 'left' | 'right' | 'both' | 'behind';
export type BinningAlgorithm = 'fixed' | 'adaptive' | 'TPO';
export type ExtrusionScale = 'linear' | 'log' | 'sqrt';

export interface VolumeBin {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  barIndex: number;
  tickCount: number;
  low?: number;
  high?: number;
}

export interface VolumeProfileConfig {
  enabled: boolean;
  mode: VolumeProfileMode;
  priceResolution: number;
  binningAlgorithm: BinningAlgorithm;
  orientation: ProfileOrientation;
  colorScheme: ColorScheme;
  showPOC: boolean;
  showValueArea: boolean;
  valueAreaPercent: number;
  extrusionDepth: number;
  extrusionScale: ExtrusionScale;
  lighting: boolean;
  transparency: number;
  maxBarsRendered: number;
  lodLevels: number;
}

export interface ColorScheme {
  bullColor: [number, number, number];
  bearColor: [number, number, number];
  pocColor: [number, number, number];
  valueAreaColor: [number, number, number];
  backgroundColor: [number, number, number];
}

export interface POCResult {
  price: number;
  volume: number;
  index: number;
}

export interface ValueAreaResult {
  vah: number;
  val: number;
  totalVolume: number;
  includedVolume: number;
  percent: number;
}
