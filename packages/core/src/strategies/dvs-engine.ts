/**
 * Dynamic Volatility Scaling (DVS) Engine
 * Multi-method volatility estimation with ensemble support
 */
export interface DVSOptions {
  method: 'ATR Ratio' | 'Parkinson' | 'Garman-Klass' | 'Ensemble';
  memory: number;
  sensitivity: number;
}

export interface DVSState {
  currentRatio: number;
  baselineRatio: number;
  atrRatio: number;
  parkinsonRatio: number;
  garmanKlassRatio: number;
  ensembleRatio: number;
  smoothedRatio: number;
}

export class DVSEngine {
  private atrRatios: number[] = [];
  private parkinsonRatios: number[] = [];
  private garmanKlassRatios: number[] = [];
  private smoothedValues: number[] = [];

  constructor(private options: DVSOptions) {}

  private calcATR(high: number[], low: number[], close: number[], period: number): number[] {
    const tr: number[] = [];
    const result: number[] = [];
    for (let i = 0; i < close.length; i++) {
      const hl = high[i] - low[i];
      const hc = i > 0 ? Math.abs(high[i] - close[i - 1]) : hl;
      const lc = i > 0 ? Math.abs(low[i] - close[i - 1]) : hl;
      tr.push(Math.max(hl, hc, lc));
    }
    const mult = 2 / (period + 1);
    let ema = tr[0];
    result.push(ema);
    for (let i = 1; i < tr.length; i++) {
      ema = (tr[i] - ema) * mult + ema;
      result.push(ema);
    }
    return result;
  }

  private calcParkinson(high: number[], low: number[], period: number): number[] {
    const result: number[] = [];
    const buffer: number[] = [];
    for (let i = 0; i < high.length; i++) {
      const hl = Math.log(high[i] / Math.max(low[i], 1e-10));
      buffer.push(hl * hl);
      if (buffer.length > period) buffer.shift();
      if (i < period - 1) {
        result.push(0);
      } else {
        const sum = buffer.reduce((a, b) => a + b, 0);
        result.push(Math.sqrt(sum / (4 * period * Math.log(2))));
      }
    }
    return result;
  }

  private calcGarmanKlass(open: number[], high: number[], low: number[], close: number[], period: number): number[] {
    const result: number[] = [];
    const buffer: number[] = [];
    for (let i = 0; i < high.length; i++) {
      const hl = Math.log(high[i] / Math.max(low[i], 1e-10));
      const co = Math.log(close[i] / Math.max(open[i], 1e-10));
      const gk = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
      buffer.push(gk);
      if (buffer.length > period) buffer.shift();
      if (i < period - 1) {
        result.push(0);
      } else {
        result.push(Math.sqrt(Math.max(buffer.reduce((a, b) => a + b, 0) / period, 0)));
      }
    }
    return result;
  }

  private sma(source: number[], length: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (i < length - 1) { result.push(source[i] || 0); continue; }
      let sum = 0;
      for (let j = i - length + 1; j <= i; j++) sum += source[j];
      result.push(sum / length);
    }
    return result;
  }

  private ema(source: number[], length: number): number[] {
    const result: number[] = [];
    const mult = 2 / (length + 1);
    let val = source[0] || 0;
    result.push(val);
    for (let i = 1; i < source.length; i++) {
      val = (source[i] - val) * mult + val;
      result.push(val);
    }
    return result;
  }

  private medianOfThree(a: number, b: number, c: number): number {
    if (a > b) {
      if (b > c) return b;
      return a > c ? c : a;
    }
    if (a > c) return a;
    return b > c ? c : b;
  }

  update(i: number, open: number[], high: number[], low: number[], close: number[]): DVSState {
    const { method, memory, sensitivity } = this.options;

    // ATR-based volatility
    const atrArr = this.calcATR(high, low, close, 14);
    const atrVol = close[i] > 0 ? atrArr[i] / close[i] : 0;
    const atrBaseline = this.sma(atrArr.map((v, idx) => close[idx] > 0 ? v / close[idx] : 0), memory);
    const atrRatio = atrBaseline[i] > 0 ? atrVol / atrBaseline[i] : 1;

    // Parkinson
    const pk = this.calcParkinson(high, low, 14);
    const pkVol = pk[i];
    const pkBaseline = this.sma(pk, memory);
    const pkRatio = pkBaseline[i] > 0 ? pkVol / pkBaseline[i] : 1;

    // Garman-Klass
    const gk = this.calcGarmanKlass(open, high, low, close, 14);
    const gkVol = gk[i];
    const gkBaseline = this.sma(gk, memory);
    const gkRatio = gkBaseline[i] > 0 ? gkVol / gkBaseline[i] : 1;

    let currentRatio = 1;
    switch (method) {
      case 'ATR Ratio':
        currentRatio = atrRatio;
        break;
      case 'Parkinson':
        currentRatio = pkRatio;
        break;
      case 'Garman-Klass':
        currentRatio = gkRatio;
        break;
      case 'Ensemble':
        currentRatio = this.medianOfThree(atrRatio, pkRatio, gkRatio);
        break;
    }

    const scaled = Math.pow(currentRatio, sensitivity);
    const clamped = Math.max(0.5, Math.min(scaled, 2.5));
    this.atrRatios.push(clamped);
    this.parkinsonRatios.push(pkRatio);
    this.garmanKlassRatios.push(gkRatio);

    // Smoothed with EMA-5
    const smoothed = this.ema(this.atrRatios, 5);
    this.smoothedValues = smoothed;

    return {
      currentRatio: clamped,
      baselineRatio: 1,
      atrRatio,
      parkinsonRatio: pkRatio,
      garmanKlassRatio: gkRatio,
      ensembleRatio: currentRatio,
      smoothedRatio: smoothed[i] ?? clamped,
    };
  }

  getSmoothedRatio(): number {
    return this.smoothedValues.length > 0
      ? this.smoothedValues[this.smoothedValues.length - 1]
      : 1;
  }

  reset(): void {
    this.atrRatios = [];
    this.parkinsonRatios = [];
    this.garmanKlassRatios = [];
    this.smoothedValues = [];
  }
}
