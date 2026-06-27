export interface OakPlot {
  type: 'line' | 'shape' | 'hline' | 'fill' | 'barcolor' | 'bgcolor' | 'label' | 'table' | 'plot3d';
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
  pane?: 'main' | 'separate';
  fillTop?: number;
  fillBot?: number;
  is3D?: boolean;
}

export interface OakPlot3D {
  type: 'plot3d';
  name: string;
  series: number[];
  style: 'surface' | 'ribbon' | 'bars3d' | 'scatter' | 'line3d' | 'wireframe' | 'mesh';
  color: string;
  pane: 'main' | 'separate';
}

export interface OakPlot {
  type: 'line' | 'shape' | 'hline' | 'fill' | 'barcolor' | 'bgcolor' | 'label' | 'table' | 'plot3d';
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
  pane?: 'main' | 'separate';
  fillTop?: number;
  fillBot?: number;
  is3D?: boolean;
}

export interface OakAlert {
  type: string;
  message: string;
  barIndex: number;
  timestamp: number;
  price: number;
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
  const result: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (i < length - 1) { result.push(NaN); continue; }
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += source[j];
    result.push(sum / length);
  }
  return result;
}

function emaImpl(source: number[], length: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (length + 1);
  let emaV = source[0];
  result.push(emaV);
  for (let i = 1; i < source.length; i++) {
    emaV = (source[i] - emaV) * multiplier + emaV;
    result.push(emaV);
  }
  return result;
}

export const StdLib = {
  sma: smaImpl,
  ema: emaImpl,

  rsi(source: number[], length: number): number[] {
    const result: number[] = [50];
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
      } else if (i > length) {
        avgGain = (avgGain * (length - 1) + Math.max(diff, 0)) / length;
        avgLoss = (avgLoss * (length - 1) + Math.max(-diff, 0)) / length;
      }
      if (avgLoss === 0) result.push(100);
      else result.push(100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
  },

  macd(source: number[], fast: number, slow: number, signal: number): { macd: number[]; signal: number[]; hist: number[] } {
    const emaFast = emaImpl(source, fast);
    const emaSlow = emaImpl(source, slow);
    const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
    const signalLine = emaImpl(macdLine, signal);
    const histogram = macdLine.map((v, i) => v - signalLine[i]);
    return { macd: macdLine, signal: signalLine, hist: histogram };
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

  linreg(source: number[], length: number, _offset: number): number[] {
    return smaImpl(source, length);
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
    return emaImpl(tr, length);
  },

  cci(high: number[], low: number[], close: number[], length: number): number[] {
    const tp: number[] = [];
    for (let i = 0; i < close.length; i++) tp.push((high[i] + low[i] + close[i]) / 3);
    const tpSma = smaImpl(tp, length);
    const tpStd = this.stdev(tp, length);
    const result: number[] = [];
    for (let i = 0; i < close.length; i++) {
      if (i < length - 1) { result.push(0); continue; }
      result.push((tp[i] - tpSma[i]) / (0.015 * tpStd[i]));
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
    const trSma = smaImpl(tr, length);
    const plusDI: number[] = [];
    const minusDI: number[] = [];
    for (let i = 0; i < close.length; i++) {
      const p = trSma[i] !== 0 ? 100 * smaImpl(plusDM, length)[i] / trSma[i] : 0;
      const m = trSma[i] !== 0 ? 100 * smaImpl(minusDM, length)[i] / trSma[i] : 0;
      plusDI.push(p);
      minusDI.push(m);
    }
    const dx: number[] = [];
    for (let i = 0; i < close.length; i++) {
      const sum = plusDI[i] + minusDI[i];
      dx.push(sum !== 0 ? Math.abs(plusDI[i] - minusDI[i]) / sum * 100 : 0);
    }
    return smaImpl(dx, length);
  },
};
