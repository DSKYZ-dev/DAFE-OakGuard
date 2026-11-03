import type { BaseBar, Tick, VolumeBin } from '@dafe/types';

export type BarType = 'candlestick' | 'heikin-ashi' | 'renko' | 'range-bar' | 'volume-bar' | 'tick-bar' | 'kagi' | 'footprint' | 'line' | 'area' | 'dollar-bar' | 'imbalance-bar';
export type Timeframe = '1s' | '5s' | '10s' | '30s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface PerBarVolume {
  levels: { price: number; lo: number; hi: number; volume: number; buyVol: number; sellVol: number }[];
  maxVol: number;
}

const TIMEFRAMES_MS: Record<Timeframe, number> = {
  '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000,
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000,
};

const SYMBOL_BASE_PRICES: Record<string, number> = {
  'AAPL': 230, 'MSFT': 420, 'GOOGL': 175, 'AMZN': 185, 'NVDA': 125,
  'TSLA': 250, 'META': 510, 'SPY': 550, 'QQQ': 470, 'IWM': 215,
  'ES': 5500, 'NQ': 19500, 'YM': 40000, 'RTY': 2100, 'CL': 72,
  'GC': 2350, 'SI': 29, 'NG': 2.8, 'ZB': 115, 'ZN': 108,
  'EURUSD': 1.08, 'GBPUSD': 1.27, 'USDJPY': 157, 'BTCUSD': 67000,
  'ETHUSD': 3500, 'DIA': 400, 'XLF': 42, 'XLE': 88,
};

export function generateBars(count: number, tf: Timeframe = '1m', symbol?: string): BaseBar[] {
  const bars: BaseBar[] = [];
  const sym = (symbol || 'SPY').toUpperCase();
  let price = SYMBOL_BASE_PRICES[sym] || (500 + Math.random() * 200);
  const intervalMs = TIMEFRAMES_MS[tf];
  const now = Date.now() - count * intervalMs;

  for (let i = 0; i < count; i++) {
    const volatility = price * 0.002;
    const open = price;
    const close = price + (Math.random() - 0.48) * volatility * 4;
    const high = Math.max(open, close) + Math.random() * volatility;
    const low = Math.min(open, close) - Math.random() * volatility;
    const volume = 100 + Math.random() * 5000;

    bars.push({
      timestamp: now + i * intervalMs,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(volume),
    });

    price = close;
    if (i > 0 && i % 20 === 0) price += (Math.random() - 0.5) * volatility * 10;
  }
  return bars;
}

export function generateTicks(bars: BaseBar[]): Tick[] {
  const ticks: Tick[] = [];
  for (const bar of bars) {
    const tickCount = Math.max(1, Math.round(bar.volume / 100));
    for (let j = 0; j < tickCount; j++) {
      const progress = j / tickCount;
      const price = bar.low + (bar.high - bar.low) * (j / tickCount) + Math.random() * (bar.high - bar.low) * 0.1;
      ticks.push({
        price: Math.round(price * 100) / 100,
        size: Math.round(Math.random() * 10 + 0.1),
        side: Math.random() > 0.5 ? 'buy' : 'sell',
        timestamp: bar.timestamp + Math.round(progress * (bar.timestamp < bars[bars.indexOf(bar) + 1]?.timestamp ? bars[bars.indexOf(bar) + 1].timestamp - bar.timestamp : 60000)),
        symbol: 'BTC/USD',
      });
    }
  }
  return ticks;
}

export function computeVolumeProfile(bars: BaseBar[], resolution: number = 5): VolumeBin[] {
  const binMap = new Map<number, VolumeBin>();
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const binPrice = Math.round(bar.close / resolution) * resolution;
    const existing = binMap.get(binPrice);
    const buyVol = bar.volume * (bar.close >= bar.open ? 0.6 : 0.4);
    if (existing) {
      existing.volume += bar.volume;
      existing.buyVolume += buyVol;
      existing.sellVolume += bar.volume - buyVol;
      existing.tickCount++;
    } else {
      binMap.set(binPrice, {
        price: binPrice,
        volume: bar.volume,
        buyVolume: buyVol,
        sellVolume: bar.volume - buyVol,
        barIndex: i,
        tickCount: 1,
      });
    }
  }
  return Array.from(binMap.values()).sort((a, b) => a.price - b.price);
}

export function findPOC(bins: VolumeBin[]): VolumeBin | null {
  if (bins.length === 0) return null;
  return bins.reduce((max, b) => b.volume > max.volume ? b : max, bins[0]);
}

// ─── TRANSFORM BAR TYPES ──────────────────────────────────────────

/** Average bar range of the series — used to derive price-scale-relative
 * defaults (renko brick, range-bar size) so bars don't all collapse into one
 * when a fixed default (e.g. 50) is far larger than a $1.08 forex move or far
 * smaller than a $67k BTC move. */
function avgBarRange(bars: BaseBar[]): number {
  if (bars.length === 0) return 1;
  let sum = 0;
  for (const b of bars) sum += (b.high - b.low);
  return (sum / bars.length) || 1;
}

/** Precision-preserving price rounding. Fixed 2-decimal rounding corrupts
 *  instruments trading below ~$10 with tight ticks (forex 1.08543 → 1.09).
 *  Keeps 2–6 decimals scaled to magnitude so tick resolution survives. */
function roundPrice(p: number): number {
  if (!Number.isFinite(p)) return p;
  const mag = Math.abs(p);
  const dp = mag >= 1000 ? 2 : mag >= 10 ? 4 : mag >= 0.1 ? 5 : 6;
  const f = Math.pow(10, dp);
  return Math.round(p * f) / f;
}

/** Average bar volume — used to derive volume/dollar-bar targets. */
function avgBarVolume(bars: BaseBar[]): number {
  if (bars.length === 0) return 1;
  let sum = 0;
  for (const b of bars) sum += b.volume;
  return (sum / bars.length) || 1;
}

export function transformBars(bars: BaseBar[], type: BarType, params?: Record<string, number>): BaseBar[] {
  if (bars.length === 0) return bars;
  // Scale-relative defaults so a fixed constant doesn't collapse every bar into
  // one (forex ~1.08) or explode into thousands (BTC ~67k). Each ≈ a few source
  // bars' worth of movement/volume, which yields a readable number of bars.
  const rng = avgBarRange(bars);
  const vol = avgBarVolume(bars);
  const avgClose = bars[bars.length - 1].close || 1;
  switch (type) {
    case 'candlestick': return bars;
    case 'heikin-ashi': return transformHeikinAshi(bars);
    case 'renko': {
      const raw = Math.max(rng * 0.75, avgClose * 1e-4);
      const brick = Math.min(Math.max(raw, avgClose * 1e-4), avgClose * 0.02);
      return transformRenko(bars, params?.brickSize ?? brick);
    }
    case 'range-bar': {
      const raw = Math.max(rng * 1.5, avgClose * 2e-4);
      const range = Math.min(Math.max(raw, avgClose * 2e-4), avgClose * 0.02);
      return transformRangeBar(bars, params?.range ?? range);
    }
    case 'volume-bar': return transformVolumeBar(bars, params?.volTarget ?? Math.max(vol * 3, 1));
    case 'tick-bar': return transformTickBar(bars, params?.tickCount ?? 5);
    case 'kagi': return transformKagi(bars, params?.reversal ?? Math.max(rng * 0.9, avgClose * 1.2e-4));
    case 'footprint': return bars; // footprint adds per-level data; base OHLC same
    case 'line': return bars;
    case 'area': return bars;
    case 'dollar-bar': return transformDollarBar(bars, params?.dollarTarget ?? Math.max(vol * avgClose * 3, 1));
    case 'imbalance-bar': return transformImbalanceBar(bars, params?.imbalanceThreshold ?? 0.3);
    default: return bars;
  }
}

function transformHeikinAshi(bars: BaseBar[]): BaseBar[] {
  if (bars.length === 0) return [];
  const ha: BaseBar[] = [];
  let prevHaOpen = (bars[0].open + bars[0].close) / 2;
  let prevHaClose = bars[0].close;

  for (const bar of bars) {
    const haClose = (bar.open + bar.high + bar.low + bar.close) / 4;
    const haOpen = (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(bar.high, haOpen, haClose);
    const haLow = Math.min(bar.low, haOpen, haClose);
    ha.push({
      timestamp: bar.timestamp,
      open: roundPrice(haOpen),
      high: roundPrice(haHigh),
      low: roundPrice(haLow),
      close: roundPrice(haClose),
      volume: bar.volume,
    });
    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }
  return ha;
}

function transformRenko(bars: BaseBar[], brickSize: number): BaseBar[] {
  const bricks: BaseBar[] = [];
  let price = bars[0].open;
  for (const bar of bars) {
    const move = bar.close - price;
    const bricksCount = Math.floor(Math.abs(move) / brickSize);
    if (bricksCount < 1) continue;
    for (let i = 0; i < bricksCount; i++) {
      const direction = move > 0 ? 1 : -1;
      const brickClose = price + direction * brickSize;
      bricks.push({
        timestamp: bar.timestamp,
        open: price,
        high: Math.max(price, brickClose),
        low: Math.min(price, brickClose),
        close: brickClose,
        volume: bar.volume / bricksCount,
      });
      price = brickClose;
    }
  }
  return bricks.length > 0 ? bricks : bars.slice(0, 1);
}

function transformRangeBar(bars: BaseBar[], range: number): BaseBar[] {
  const result: BaseBar[] = [];
  let openB = bars[0].open;
  let highB = bars[0].high;
  let lowB = bars[0].low;
  let volB = 0;
  let tsB = bars[0].timestamp;
  let closeB = bars[0].close;

  for (const bar of bars) {
    highB = Math.max(highB, bar.high);
    lowB = Math.min(lowB, bar.low);
    volB += bar.volume;
    closeB = bar.close;
    if (highB - lowB >= range) {
      result.push({ timestamp: tsB, open: openB, high: highB, low: lowB, close: closeB, volume: volB });
      openB = bar.close;
      highB = bar.high;
      lowB = bar.low;
      volB = 0;
      tsB = bar.timestamp;
    }
  }
  return result.length > 0 ? result : bars.slice(0, 1);
}

function transformVolumeBar(bars: BaseBar[], volTarget: number): BaseBar[] {
  const result: BaseBar[] = [];
  let openB = bars[0].open;
  let highB = bars[0].high;
  let lowB = bars[0].low;
  let volB = 0;
  let tsB = bars[0].timestamp;
  let closeB = bars[0].close;

  for (const bar of bars) {
    highB = Math.max(highB, bar.high);
    lowB = Math.min(lowB, bar.low);
    volB += bar.volume;
    closeB = bar.close;
    if (volB >= volTarget) {
      result.push({ timestamp: tsB, open: openB, high: highB, low: lowB, close: closeB, volume: volB });
      openB = bar.close;
      highB = bar.high;
      lowB = bar.low;
      volB = 0;
      tsB = bar.timestamp;
    }
  }
  return result.length > 0 ? result : bars.slice(0, 1);
}

function transformKagi(bars: BaseBar[], reversal: number): BaseBar[] {
  const result: BaseBar[] = [];
  if (bars.length < 2) return bars;
  let direction: 'up' | 'down' = bars[1].close >= bars[0].close ? 'up' : 'down';
  // `extreme` is the high/low water-mark of the current leg. The prior version
  // only moved its pivot at reversals, so in a trending market the counter-move
  // was measured from a stale point and almost never triggered — yielding just
  // a handful of segments. Track the running extreme and reverse when price
  // retraces `reversal` from it (the correct kagi rule).
  let extreme = bars[0].close;
  let legStart = bars[0].close;
  let legStartTs = bars[0].timestamp;

  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close;
    if (direction === 'up') {
      if (c > extreme) extreme = c;
      else if (c <= extreme - reversal) {
        // Reversal down — close the up-leg from its start to the peak.
        result.push({ timestamp: legStartTs, open: legStart, high: extreme, low: Math.min(legStart, extreme), close: extreme, volume: bars[i].volume });
        direction = 'down';
        legStart = extreme; legStartTs = bars[i].timestamp; extreme = c;
      }
    } else {
      if (c < extreme) extreme = c;
      else if (c >= extreme + reversal) {
        // Reversal up — close the down-leg from its start to the trough.
        result.push({ timestamp: legStartTs, open: legStart, high: Math.max(legStart, extreme), low: extreme, close: extreme, volume: bars[i].volume });
        direction = 'up';
        legStart = extreme; legStartTs = bars[i].timestamp; extreme = c;
      }
    }
  }
  // Emit the in-progress final leg so the newest move is visible.
  const lastC = bars[bars.length - 1].close;
  result.push({
    timestamp: bars[bars.length - 1].timestamp,
    open: legStart, high: Math.max(legStart, lastC), low: Math.min(legStart, lastC), close: lastC,
    volume: bars[bars.length - 1].volume,
  });
  return result.length > 0 ? result : bars.slice(0, 1);
}

function transformTickBar(bars: BaseBar[], tickCount: number): BaseBar[] {
  // No raw trade-tick stream at this layer, so each source bar stands in for
  // one "tick" — a fixed count of source bars forms one tick-bar.
  const result: BaseBar[] = [];
  for (let i = 0; i < bars.length; i += tickCount) {
    const chunk = bars.slice(i, i + tickCount);
    if (chunk.length === 0) continue;
    result.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result.length > 0 ? result : bars.slice(0, 1);
}

function transformDollarBar(bars: BaseBar[], dollarTarget: number): BaseBar[] {
  const result: BaseBar[] = [];
  let openB = bars[0].open;
  let highB = bars[0].high;
  let lowB = bars[0].low;
  let volB = 0;
  let dollarB = 0;
  let tsB = bars[0].timestamp;
  let closeB = bars[0].close;

  for (const bar of bars) {
    highB = Math.max(highB, bar.high);
    lowB = Math.min(lowB, bar.low);
    volB += bar.volume;
    dollarB += bar.close * bar.volume;
    closeB = bar.close;
    if (dollarB >= dollarTarget) {
      result.push({ timestamp: tsB, open: openB, high: highB, low: lowB, close: closeB, volume: volB });
      openB = bar.close;
      highB = bar.high;
      lowB = bar.low;
      volB = 0;
      dollarB = 0;
      tsB = bar.timestamp;
    }
  }
  return result.length > 0 ? result : bars.slice(0, 1);
}

function transformImbalanceBar(bars: BaseBar[], imbalanceThreshold: number): BaseBar[] {
  // Closes a bar once the running buy/sell volume imbalance (using close>=open
  // as a buy-tick proxy) exceeds the threshold fraction of accumulated volume.
  // Min-volume gate uses the series' average bar volume (not the arbitrary first
  // bar) so a single quiet bar can't instantly satisfy the gate.
  const result: BaseBar[] = [];
  const minVol = Math.max(avgBarVolume(bars) * 0.5, 1);
  let openB = bars[0].open;
  let highB = bars[0].high;
  let lowB = bars[0].low;
  let volB = 0;
  let signedVolB = 0;
  let tsB = bars[0].timestamp;
  let closeB = bars[0].close;

  for (const bar of bars) {
    highB = Math.max(highB, bar.high);
    lowB = Math.min(lowB, bar.low);
    const sign = bar.close >= bar.open ? 1 : -1;
    volB += bar.volume;
    signedVolB += sign * bar.volume;
    closeB = bar.close;
    if (volB > 0 && volB >= minVol && Math.abs(signedVolB) / volB >= imbalanceThreshold) {
      result.push({ timestamp: tsB, open: openB, high: highB, low: lowB, close: closeB, volume: volB });
      openB = bar.close;
      highB = bar.high;
      lowB = bar.low;
      volB = 0;
      signedVolB = 0;
      tsB = bar.timestamp;
    }
  }
  return result.length > 0 ? result : bars.slice(0, 1);
}

// ─── TIMEFRAME AGGREGATION ────────────────────────────────────────
export function aggregateTimeframe(bars: BaseBar[], tf: Timeframe): BaseBar[] {
  const ms = TIMEFRAMES_MS[tf];
  const map = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();

  for (const bar of bars) {
    const key = Math.floor(bar.timestamp / ms) * ms;
    const existing = map.get(key);
    if (existing) {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
      existing.volume += bar.volume;
    } else {
      map.set(key, { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, d]) => ({
      timestamp,
      open: roundPrice(d.open),
      high: roundPrice(d.high),
      low: roundPrice(d.low),
      close: roundPrice(d.close),
      volume: Math.round(d.volume),
    }));
}

// ─── PER-BAR VOLUME DISTRIBUTION ──────────────────────────────────
// Deterministic seeded RNG — per-bar/per-level stable so 3D isotropic
// VolP voxels don't jump colors/volumes when a live bar is appended.
function seededUnit(seed: number): number {
  let x = seed | 0;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  return ((x >>> 0) % 1_000_000) / 1_000_000;
}
function barSeed(bar: BaseBar, salt: number): number {
  return (bar.timestamp ^ Math.floor(bar.close * 100) ^ Math.floor(bar.volume) ^ (salt * 0x9e3779b9)) | 0;
}
/**
 * Buy share of the volume at one price level, from the bar's candle shape. No bar
 * feed carries buy/sell flags, so this is an estimate: levels inside the body take
 * the bar's direction (buy for an up bar, sell for a down bar, half for a doji);
 * upper-wick levels are sell-side (buyers were rejected there); lower-wick levels
 * are buy-side (sellers were absorbed there).
 */
export function levelBuyShare(bar: BaseBar, mid: number): number {
  const bodyLow = Math.min(bar.open, bar.close);
  const bodyHigh = Math.max(bar.open, bar.close);
  if (mid > bodyHigh) return 0;
  if (mid < bodyLow) return 1;
  if (bar.close > bar.open) return 1;
  if (bar.close < bar.open) return 0;
  return 0.5;
}

/**
 * Per-bar volume profile, derived from OHLCV alone. Rules:
 *  - Conservation: the level volumes sum to bar.volume. Nothing is noise or clamped.
 *  - Placement: volume spreads over equal price bins, weighted by a triangle that
 *    peaks at the bar's typical price (H+L+C)/3, the usual OHLCV proxy for where
 *    the bar traded.
 *  - Bias: each level's buy share comes from levelBuyShare (the candle shape).
 * Every bin keeps its exact edges (lo, hi), so renderers can draw them without gaps.
 * A bar with no volume or no price range has no profile.
 */
export function generatePerBarVolumes(bars: BaseBar[], levelCount: number = 8): PerBarVolume[] {
  return bars.map(bar => {
    const range = bar.high - bar.low;
    if (!(range > 0) || !(bar.volume > 0) || levelCount < 1) return { levels: [], maxVol: 0 };
    const step = range / levelCount;
    const typical = (bar.high + bar.low + bar.close) / 3;
    const halfSpan = Math.max(typical - bar.low, bar.high - typical);
    const raw: number[] = [];
    for (let i = 0; i < levelCount; i++) {
      const centre = bar.low + step * (i + 0.5);
      raw.push(Math.max(0, 1 - Math.abs(centre - typical) / halfSpan));
    }
    const rawTotal = raw.reduce((a, b) => a + b, 0);
    const weights = rawTotal > 0 ? raw : raw.map(() => 1);
    const total = weights.reduce((a, b) => a + b, 0);
    const levels: PerBarVolume['levels'] = [];
    let maxVol = 0;
    for (let i = 0; i < levelCount; i++) {
      const lo = bar.low + step * i;
      const hi = i === levelCount - 1 ? bar.high : bar.low + step * (i + 1);
      const mid = (lo + hi) / 2;
      const volume = (bar.volume * weights[i]) / total;
      const buyVol = volume * levelBuyShare(bar, mid);
      levels.push({ price: mid, lo, hi, volume, buyVol, sellVol: volume - buyVol });
      if (volume > maxVol) maxVol = volume;
    }
    return { levels, maxVol };
  });
}
