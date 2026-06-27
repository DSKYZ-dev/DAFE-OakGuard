import type { BaseBar, Tick } from './bars';
import type { VolumeBin } from './volume';

export interface BarCollection {
  symbol: string;
  timeframe: string;
  bars: BaseBar[];
  earliestTimestamp: number;
  latestTimestamp: number;
  updateCount: number;
}

export interface ArrowTable {
  schema: Record<string, 'f32' | 'i32' | 'u32' | 'f64' | 'bool' | 'timestamp'>;
  data: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array | BigUint64Array>;
  length: number;
}

export interface SharedBuffer {
  buffer: SharedArrayBuffer;
  tickOffset: Int32Array;
  barOffset: Int32Array;
  writePointer: Int32Array;
  readPointer: Int32Array;
}

export interface DataProviderConfig {
  symbol: string;
  timeframe: string;
  maxBars: number;
  bufferSize: number;
}

export type DataSource = 'websocket' | 'historical' | 'replay';

export interface DataUpdate {
  type: 'tick' | 'bar' | 'volume' | 'indicator';
  timestamp: number;
  data: Tick | BaseBar | VolumeBin[];
}

export interface HistoricalRequest {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  limit?: number;
}

export interface WebSocketMessage {
  type: 'trade' | 'quote' | 'book' | 'error';
  symbol: string;
  data: unknown;
  timestamp: number;
}
