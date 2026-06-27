export type BarCategory = 'time-based' | 'non-time-based' | 'advanced';

export type BarTypeId =
  | 'candlestick' | 'hollow-candle' | 'hlc-bar' | 'ohlc-bar'
  | 'line' | 'area' | 'baseline' | 'mountain' | 'step' | 'histogram'
  | 'heikin-ashi' | 'renko' | 'range-bar' | 'tick-bar'
  | 'volume-bar' | 'dollar-bar' | 'imbalance-bar'
  | 'point-figure' | 'kagi' | 'three-line-break'
  | 'footprint' | 'delta-bar' | 'market-profile'
  | 'order-flow' | 'heatmap-bar';

export interface BaseBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
  symbol: string;
}

export interface BarParams {
  period: number;
  timeframe?: string;
  [key: string]: unknown;
}

export interface Scale {
  priceScale: number;
  timeScale: number;
  priceOffset: number;
  timeOffset: number;
}

export interface ParameterDefinition {
  id: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  defaultValue: unknown;
  options?: { label: string; value: unknown }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface BarGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
  uvs?: Float32Array;
}

export interface TickStream {
  symbol: string;
  ticks: Tick[];
  maxLength: number;
}
