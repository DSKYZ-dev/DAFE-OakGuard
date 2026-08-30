// A single cell in a table() drawing-object grid (row-major: cells[row][col]).
export interface OakTableCell {
  text: string;
  bgColor?: string;
  textColor?: string;
}

export interface OakPlot {
  type: 'line' | 'shape' | 'hline' | 'fill' | 'barcolor' | 'bgcolor' | 'label' | 'table' | 'plot3d' | 'plot3d_shape' | 'plot3d_label'
    | 'line_obj' | 'box_obj' | 'polyline_obj' | 'circle_obj' | 'arrow_obj' | 'image_obj' | 'linefill_obj';
  name: string;
  value?: number;
  series?: number[];
  color?: string;
  linewidth?: number;
  style?: string;
  price?: number;
  text?: string;
  x?: number;
  y?: number;
  barIdx?: number;
  pane?: 'main' | 'separate' | '3d';
  fillTop?: number;
  fillBot?: number;
  is3D?: boolean;
  // 3D shape fields
  shape3d?: 'cube' | 'sphere' | 'pyramid' | 'torus' | 'diamond' | 'coneup' | 'conedown' | 'image';
  // rotation in degrees (applied after any built-in orientation, e.g. conedown's flip)
  rx?: number;
  ry?: number;
  rz?: number;
  size?: number;
  z_level?: number;
  // ── Drawing-object fields (line/box/polyline/circle/arrow/image/table/linefill) ──
  id?: string;
  x2?: number;
  y2?: number;
  bgColor?: string;
  extend?: 'none' | 'left' | 'right' | 'both';
  points?: { x: number; y: number }[];
  closed?: boolean;
  cols?: number;
  rows?: number;
  cells?: OakTableCell[][];
  position?: string;
  opacity?: number;
  imgWidth?: number;
  imgHeight?: number;
  imageRef?: string;
  boxed?: boolean;
  align?: string;
  id1?: string;
  id2?: string;
}

export interface OakPlot3D {
  type: 'plot3d';
  name: string;
  series: number[];
  style: 'surface' | 'ribbon' | 'bars3d' | 'scatter' | 'line3d' | 'wireframe' | 'mesh'
    | 'helix' | 'vortex' | 'manifold' | 'nebula' | 'constellation' | 'torus' | 'trail' | 'ridgeline';
  color: string;
  pane: 'main' | 'separate' | '3d';
  z_level?: number;
}

export interface OakAlert {
  type: string;
  message: string;
  barIndex: number;
  timestamp: number;
  price: number;
  /** "Explain This Signal" — the script's own scalar variable bindings at
   * the exact bar the alert fired, so the alert is self-explaining without
   * an LLM: deterministic, reproducible from the same script + bar every
   * time, not a generated guess at what the script "meant." */
  provenance?: Record<string, number | string | boolean>;
}

export interface OakStrategyOrder {
  kind: 'entry' | 'exit';
  /** For entries: which side to open. For exits: when set, the exit only
   * applies if the open position IS that side (model.longExit/shortExit);
   * unset = flatten whatever is open (legacy strategy.exit / model.exit). */
  direction?: 'long' | 'short';
  id: string;
  qty?: number;
  barIdx: number;
  /** 0-1 score attached via model.confidence() — metadata carried through
   * to TradeSignals and backtest results, never a hidden qty multiplier. */
  confidence?: number;
  /** Per-script bracket set via model.stopLoss()/model.takeProfit() —
   * overrides the backtest form's SL/TP config for entries that carry it. */
  stopLoss?: { mode: 'pct' | 'abs'; value: number };
  takeProfit?: { mode: 'pct' | 'abs'; value: number };
}

export interface OakContext {
  barIndex: number;
  barCount: number;
  close: number[];
  open: number[];
  high: number[];
  low: number[];
  volume: number[];
  time: number[];
  persist: Map<string, any>;
  plots: OakPlot[];
  labels: OakPlot[];
  currentClose: number;
  currentOpen: number;
  currentHigh: number;
  currentLow: number;
  currentVolume: number;
  currentTime: number;
  symbol: string;
  timeframe: string;
}

// ─── Standard Library ──────────────────────────────────────────────
function smaImpl(source: number[], length: number): number[] {
  const result: number[] = new Array(source.length);
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    sum += source[i];
    if (i >= length) sum -= source[i - length];
    result[i] = i < length - 1 ? NaN : sum / length;
  }
  return result;
}

function emaImpl(source: number[], length: number): number[] {
  const result: number[] = new Array(source.length);
  const multiplier = 2 / (length + 1);
  // Wilder-correct seed: SMA of first length bars, not source[0] (reduces early bias)
  let emaV: number;
  if (source.length >= length && length > 1) {
    let s = 0; for (let k = 0; k < length; k++) s += source[k];
    emaV = s / length;
    for (let i = 0; i < length - 1; i++) result[i] = NaN;
    result[length - 1] = emaV;
    for (let i = length; i < source.length; i++) {
      emaV = (source[i] - emaV) * multiplier + emaV;
      result[i] = emaV;
    }
  } else {
    emaV = source[0];
    result[0] = emaV;
    for (let i = 1; i < source.length; i++) {
      emaV = (source[i] - emaV) * multiplier + emaV;
      result[i] = emaV;
    }
  }
  return result;
}

export const StdLib = {
  sma: smaImpl,
  ema: emaImpl,

  rsi(source: number[], length: number): number[] {
    const result: number[] = new Array(source.length).fill(NaN);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < source.length; i++) {
      const diff = source[i] - source[i - 1];
      if (i === length) {
        let sumGain = 0, sumLoss = 0;
        for (let j = 0; j < length; j++) {
          const d = source[j + 1] - source[j];
          if (d > 0) sumGain += d; else sumLoss -= d;
        }
        avgGain = sumGain / length; avgLoss = sumLoss / length;
        result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else if (i > length) {
        avgGain = (avgGain * (length - 1) + Math.max(diff, 0)) / length;
        avgLoss = (avgLoss * (length - 1) + Math.max(-diff, 0)) / length;
        result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return result;
  },

  macd(source: number[], fast: number, slow: number, signal: number): { macd: number[]; signal: number[]; hist: number[] } {
    const emaFast = emaImpl(source, fast);
    const emaSlow = emaImpl(source, slow);
    const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
    // The slow EMA is NaN during its warmup, which would poison an SMA seed
    // computed over the head of macdLine (NaN + anything = NaN forever).
    // Seed the signal EMA from the first bar where BOTH EMAs are valid, then
    // shift back into full-array position with NaN padding.
    const firstValid = macdLine.findIndex(v => Number.isFinite(v));
    const signalLine: number[] = new Array(source.length).fill(NaN);
    if (firstValid >= 0) {
      const validRegion = macdLine.slice(firstValid);
      const sig = emaImpl(validRegion, Math.max(1, Math.floor(signal)));
      for (let i = 0; i < sig.length; i++) signalLine[firstValid + i] = sig[i];
    }
    const histogram = macdLine.map((v, i) =>
      Number.isFinite(v) && Number.isFinite(signalLine[i]) ? v - signalLine[i] : NaN);
    return { macd: macdLine, signal: signalLine, hist: histogram };
  },

  // regression.channel(source, length, mult) — per-bar-record shape matching
  // macd(). Mid is a TRUE least-squares linear regression over the trailing
  // window (via linreg below); upper/lower add mult × stdev around it.
  regressionChannel(source: number[], length: number, mult: number): { mid: number[]; upper: number[]; lower: number[] } {
    const mid = this.linreg(source, length, 0);
    const dev = this.stdev(source, length);
    const m = typeof mult === 'number' ? mult : 2;
    const upper = mid.map((v, i) => v + m * dev[i]);
    const lower = mid.map((v, i) => v - m * dev[i]);
    return { mid, upper, lower };
  },

  crossover(a: number[], b: number[]): boolean[] {
    const result: boolean[] = [false];
    for (let i = 1; i < a.length; i++) {
      result.push(a[i - 1] <= b[i - 1] && a[i] > b[i]);
    }
    return result;
  },

  crossunder(a: number[], b: number[]): boolean[] {
    const result: boolean[] = [false];
    for (let i = 1; i < a.length; i++) {
      result.push(a[i - 1] >= b[i - 1] && a[i] < b[i]);
    }
    return result;
  },

  highest(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      result.push(Math.max(...source.slice(Math.max(0, i - length + 1), i + 1)));
    }
    return result;
  },

  lowest(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      result.push(Math.min(...source.slice(Math.max(0, i - length + 1), i + 1)));
    }
    return result;
  },

  barssince(condition: boolean[]): number[] {
    let bars = -1; const result: number[] = [];
    for (const c of condition) {
      if (c) bars = 0;
      else if (bars >= 0) bars++;
      result.push(bars);
    }
    return result;
  },

  cum(source: number[]): number[] {
    let sum = 0; const result: number[] = [];
    for (const v of source) { sum += v; result.push(sum); }
    return result;
  },

  change(source: number[]): number[] {
    const result: number[] = [NaN];
    for (let i = 1; i < source.length; i++) result.push(source[i] - source[i - 1]);
    return result;
  },

  roc(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (i < length) result.push(NaN);
      else result.push((source[i] - source[i - length]) / source[i - length] * 100);
    }
    return result;
  },

  stdev(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      const slice = source.slice(i - length + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / length;
      const sqDiff = slice.reduce((a, b) => a + (b - mean) ** 2, 0);
      result.push(Math.sqrt(sqDiff / length));
    }
    return result;
  },

  vwap(close: number[], volume: number[]): number[] {
    let cumV = 0, cumVP = 0; const result: number[] = [];
    for (let i = 0; i < close.length; i++) {
      cumV += volume[i]; cumVP += volume[i] * close[i];
      result.push(cumVP / cumV);
    }
    return result;
  },

  linreg(source: number[], length: number, offset: number): number[] {
    // TRUE least-squares linear regression over the trailing `length` window,
    // evaluated (length-1-offset) bars back from the current bar — TradingView
    // ta.linreg semantics. Previously this was an SMA alias, which silently
    // gave every linreg-based script a lagged mean instead of a fitted line.
    const result: number[] = [];
    const n = Math.max(1, Math.floor(length));
    const off = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    for (let i = 0; i < source.length; i++) {
      if (i < n - 1) { result.push(NaN); continue; }
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let j = 0; j < n; j++) {
        const y = source[i - n + 1 + j];
        sx += j;
        sy += y;
        sxy += j * y;
        sxx += j * j;
      }
      const denom = n * sxx - sx * sx;
      const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / n;
      result.push(intercept + slope * (n - 1 - off));
    }
    return result;
  },

  // ── Corpus-driven additions (Pine parity: ta.wma/hma/rma/vwma/mom/median,
  //    ta.pivothigh/pivotlow, ta.stoch/mfi/obv/cmf) ─────────────────────────
  wma(source: number[], length: number): number[] {
    const result: number[] = [];
    const denom = (length * (length + 1)) / 2;
    for (let i = 0; i < source.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      let sum = 0;
      for (let j = 0; j < length; j++) sum += source[i - j] * (length - j);
      result.push(sum / denom);
    }
    return result;
  },

  rma(source: number[], length: number): number[] {
    // Wilder's smoothing: seeded with SMA, then alpha = 1/length.
    const result: number[] = [];
    let prev = NaN;
    for (let i = 0; i < source.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      if (Number.isNaN(prev)) {
        let sum = 0;
        for (let j = i - length + 1; j <= i; j++) sum += source[j];
        prev = sum / length;
      } else {
        prev = (prev * (length - 1) + source[i]) / length;
      }
      result.push(prev);
    }
    return result;
  },

  hma(source: number[], length: number): number[] {
    const half = Math.max(1, Math.round(length / 2));
    const sqrtLen = Math.max(1, Math.round(Math.sqrt(length)));
    const wHalf = StdLib.wma(source, half);
    const wFull = StdLib.wma(source, length);
    const diff = wHalf.map((v, i) => 2 * v - wFull[i]);
    return StdLib.wma(diff, sqrtLen);
  },

  vwma(source: number[], volume: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      let pv = 0, v = 0;
      for (let j = i - length + 1; j <= i; j++) { pv += source[j] * volume[j]; v += volume[j]; }
      result.push(v > 0 ? pv / v : NaN);
    }
    return result;
  },

  mom(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      result.push(i < length ? NaN : source[i] - source[i - length]);
    }
    return result;
  },

  median(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      const win = source.slice(i - length + 1, i + 1).slice().sort((a, b) => a - b);
      const mid = Math.floor(win.length / 2);
      result.push(win.length % 2 === 0 ? (win[mid - 1] + win[mid]) / 2 : win[mid]);
    }
    return result;
  },

  // Pivot detection: NaN everywhere except the bar where the pivot is
  // CONFIRMED (right bars after the pivot bar), where it returns the pivot
  // price. Test with `ph > 0` in conditions (NaN comparisons are false).
  pivothigh(source: number[], left: number, right: number): number[] {
    const result: number[] = new Array(source.length).fill(NaN);
    for (let p = left; p < source.length - right; p++) {
      let isPivot = true;
      for (let j = p - left; j <= p + right && isPivot; j++) {
        if (j !== p && source[j] >= source[p]) isPivot = false;
      }
      if (isPivot) result[p + right] = source[p];
    }
    return result;
  },

  pivotlow(source: number[], left: number, right: number): number[] {
    const result: number[] = new Array(source.length).fill(NaN);
    for (let p = left; p < source.length - right; p++) {
      let isPivot = true;
      for (let j = p - left; j <= p + right && isPivot; j++) {
        if (j !== p && source[j] <= source[p]) isPivot = false;
      }
      if (isPivot) result[p + right] = source[p];
    }
    return result;
  },

  stoch(high: number[], low: number[], close: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < close.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      let hh = -Infinity, ll = Infinity;
      for (let j = i - length + 1; j <= i; j++) {
        if (high[j] > hh) hh = high[j];
        if (low[j] < ll) ll = low[j];
      }
      result.push(hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100);
    }
    return result;
  },

  mfi(high: number[], low: number[], close: number[], volume: number[], length: number): number[] {
    const result: number[] = [NaN];
    const tp: number[] = high.map((h, i) => (h + low[i] + close[i]) / 3);
    for (let i = 1; i < close.length; i++) {
      if (i < length) { result.push(NaN); continue; }
      let pos = 0, neg = 0;
      for (let j = i - length + 1; j <= i; j++) {
        const mf = tp[j] * volume[j];
        if (tp[j] > tp[j - 1]) pos += mf;
        else if (tp[j] < tp[j - 1]) neg += mf;
      }
      result.push(neg === 0 ? 100 : 100 - 100 / (1 + pos / neg));
    }
    return result;
  },

  obv(close: number[], volume: number[]): number[] {
    let sum = 0;
    const result: number[] = [0];
    for (let i = 1; i < close.length; i++) {
      if (close[i] > close[i - 1]) sum += volume[i];
      else if (close[i] < close[i - 1]) sum -= volume[i];
      result.push(sum);
    }
    return result;
  },

  cmf(high: number[], low: number[], close: number[], volume: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < close.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      let mfv = 0, vol = 0;
      for (let j = i - length + 1; j <= i; j++) {
        const range = high[j] - low[j];
        const mult = range === 0 ? 0 : ((close[j] - low[j]) - (high[j] - close[j])) / range;
        mfv += mult * volume[j];
        vol += volume[j];
      }
      result.push(vol > 0 ? mfv / vol : 0);
    }
    return result;
  },

  correlation(a: number[], b: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < a.length; i++) {
      if (i < length - 1) { result.push(NaN); continue; }
      const sa = a.slice(i - length + 1, i + 1);
      const sb = b.slice(i - length + 1, i + 1);
      const ma = sa.reduce((s, v) => s + v, 0) / length;
      const mb = sb.reduce((s, v) => s + v, 0) / length;
      let num = 0, da = 0, db = 0;
      for (let j = 0; j < length; j++) {
        num += (sa[j] - ma) * (sb[j] - mb);
        da += (sa[j] - ma) ** 2;
        db += (sb[j] - mb) ** 2;
      }
      result.push(num / Math.sqrt(da * db));
    }
    return result;
  },

  // ─── Additional Technical Indicators ────────────────────────────────

  trueRange(high: number[], low: number[], close: number[]): number[] {
    const result: number[] = [high[0] - low[0]];
    for (let i = 1; i < close.length; i++) {
      const hl = high[i] - low[i];
      const hc = Math.abs(high[i] - close[i - 1]);
      const lc = Math.abs(low[i] - close[i - 1]);
      result.push(Math.max(hl, hc, lc));
    }
    return result;
  },

  atr(high: number[], low: number[], close: number[], length: number): number[] {
    const tr = this.trueRange(high, low, close);
    // Wilder's RMA, not EMA — matches TradingView ta.atr and ATR Threshold spec
    return this.rma(tr, length);
  },

  cci(high: number[], low: number[], close: number[], length: number): number[] {
    const tp: number[] = [];
    for (let i = 0; i < close.length; i++) tp.push((high[i] + low[i] + close[i]) / 3);
    const tpSma = smaImpl(tp, length);
    const result: number[] = [];
    for (let i = 0; i < close.length; i++) {
      if (i < length - 1) { result.push(0); continue; }
      // Lambert's CCI uses mean deviation, not stdev (≈1.25× difference)
      let sumDev = 0;
      for (let j = i - length + 1; j <= i; j++) sumDev += Math.abs(tp[j] - tpSma[i]);
      const meanDev = sumDev / length || 1e-9;
      result.push((tp[i] - tpSma[i]) / (0.015 * meanDev));
    }
    return result;
  },

  adx(high: number[], low: number[], close: number[], length: number): number[] {
    const tr = this.trueRange(high, low, close);
    const up: number[] = [0];
    const down: number[] = [0];
    for (let i = 1; i < close.length; i++) {
      up.push(high[i] - high[i - 1]);
      down.push(low[i - 1] - low[i]);
    }
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    for (let i = 0; i < close.length; i++) {
      plusDM.push(up[i] > down[i] && up[i] > 0 ? up[i] : 0);
      minusDM.push(down[i] > up[i] && down[i] > 0 ? down[i] : 0);
    }
    // Wilder's RMA, not SMA — matches Wilder's ADX spec
    const trRma = this.rma(tr, length);
    const plusDMRma = this.rma(plusDM, length);
    const minusDMRma = this.rma(minusDM, length);
    const plusDI: number[] = [];
    const minusDI: number[] = [];
    for (let i = 0; i < close.length; i++) {
      const p = trRma[i] !== 0 && isFinite(trRma[i]) ? 100 * plusDMRma[i] / trRma[i] : 0;
      const m = trRma[i] !== 0 && isFinite(trRma[i]) ? 100 * minusDMRma[i] / trRma[i] : 0;
      plusDI.push(p);
      minusDI.push(m);
    }
    const dx: number[] = [];
    for (let i = 0; i < close.length; i++) {
      const sum = plusDI[i] + minusDI[i];
      dx.push(sum !== 0 ? Math.abs(plusDI[i] - minusDI[i]) / sum * 100 : 0);
    }
    return this.rma(dx, length);
  },

  log(source: number[], base?: number): number[] {
    const b = base ?? Math.E;
    return source.map((v) => Math.log(Math.max(v, 0.001)) / Math.log(b));
  },
};
