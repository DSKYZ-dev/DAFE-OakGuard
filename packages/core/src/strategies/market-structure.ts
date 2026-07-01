/**
 * Market Structure Engine — Swing points, POC/VAH/VAL, confluence zones, siege levels
 */
export interface SwingPoint {
  price: number;
  barIndex: number;
  timestamp: number;
}

export interface ProfileLevels {
  poc: number;
  vah: number;
  val: number;
}

export interface StructureState {
  tf1: {
    poc: number;
    vah: number;
    val: number;
    resCorridor: { isActive: boolean; price: number; startBar: number };
    supCorridor: { isActive: boolean; price: number; startBar: number };
  };
  activeCount: number;
  netBias: number;
}

export interface ConfluenceZone {
  price: number;
  strength: number;
  touches: number;
  isResistance: boolean;
}

export interface IntrabarState {
  atConfluence: boolean;
  atPoc: boolean;
  atVah: boolean;
  atVal: boolean;
  atSiegeRes: boolean;
  atSiegeSup: boolean;
}

export interface MarketContext {
  unifiedAgg: number;
  spreadProxy: number;
  absorption: number;
}

export class MarketStructureEngine {
  private swingHighs: SwingPoint[] = [];
  private swingLows: SwingPoint[] = [];
  private prevSwingHighs: SwingPoint[] = [];
  private prevSwingLows: SwingPoint[] = [];
  private profileLevels: ProfileLevels = { poc: 0, vah: 0, val: 0 };
  private resCorridor = { isActive: false, price: 0, startBar: 0 };
  private supCorridor = { isActive: false, price: 0, startBar: 0 };
  private confluenceZones: ConfluenceZone[] = [];

  detectSwingHigh(high: number[], low: number[], barIndex: number, lookback: number): SwingPoint | null {
    if (barIndex < lookback * 2) return null;
    const pivotIdx = barIndex - lookback;
    const pivotHigh = high[pivotIdx];
    let isPivot = true;
    for (let i = pivotIdx - lookback; i <= pivotIdx + lookback; i++) {
      if (i === pivotIdx) continue;
      if (i >= 0 && i < high.length && high[i] >= pivotHigh) { isPivot = false; break; }
    }
    if (!isPivot) return null;
    const sp: SwingPoint = { price: pivotHigh, barIndex: pivotIdx, timestamp: 0 };
    this.swingHighs.unshift(sp);
    if (this.swingHighs.length > 10) this.swingHighs.pop();
    this.prevSwingHighs.unshift(sp);
    if (this.prevSwingHighs.length > 20) this.prevSwingHighs.pop();
    return sp;
  }

  detectSwingLow(high: number[], low: number[], barIndex: number, lookback: number): SwingPoint | null {
    if (barIndex < lookback * 2) return null;
    const pivotIdx = barIndex - lookback;
    const pivotLow = low[pivotIdx];
    let isPivot = true;
    for (let i = pivotIdx - lookback; i <= pivotIdx + lookback; i++) {
      if (i === pivotIdx) continue;
      if (i >= 0 && i < low.length && low[i] <= pivotLow) { isPivot = false; break; }
    }
    if (!isPivot) return null;
    const sp: SwingPoint = { price: pivotLow, barIndex: pivotIdx, timestamp: 0 };
    this.swingLows.unshift(sp);
    if (this.swingLows.length > 10) this.swingLows.pop();
    this.prevSwingLows.unshift(sp);
    if (this.prevSwingLows.length > 20) this.prevSwingLows.pop();
    return sp;
  }

  calcProfile(high: number[], low: number[], close: number[], volume: number[], rows: number, barIndex: number): ProfileLevels {
    const lookback = Math.min(barIndex + 1, 100);
    const start = Math.max(0, barIndex - lookback + 1);
    const slice = (arr: number[]) => arr.slice(start, barIndex + 1);
    const h = slice(high);
    const l = slice(low);
    const c = slice(close);
    const v = slice(volume);

    if (h.length === 0) return { poc: close[barIndex], vah: close[barIndex], val: close[barIndex] };

    const minP = Math.min(...l);
    const maxP = Math.max(...h);
    const range = maxP - minP || 1;
    const binSize = range / rows;
    const bins: number[] = new Array(rows).fill(0);

    for (let i = 0; i < c.length; i++) {
      const binIdx = Math.min(rows - 1, Math.max(0, Math.floor((c[i] - minP) / binSize)));
      bins[binIdx] += v[i] || 0;
    }

    // POC = max volume bin
    let pocIdx = 0;
    let maxVol = 0;
    for (let i = 0; i < rows; i++) {
      if (bins[i] > maxVol) { maxVol = bins[i]; pocIdx = i; }
    }

    // VA = 70% of total volume
    const totalVol = bins.reduce((a, b) => a + b, 0);
    const vaTarget = totalVol * 0.7;
    let vaSum = bins[pocIdx];
    let vahIdx = pocIdx;
    let valIdx = pocIdx;

    while (vaSum < vaTarget) {
      const upperVol = vahIdx < rows - 1 ? bins[vahIdx + 1] : 0;
      const lowerVol = valIdx > 0 ? bins[valIdx - 1] : 0;
      if (upperVol >= lowerVol && vahIdx < rows - 1) {
        vahIdx++;
        vaSum += upperVol;
      } else if (valIdx > 0) {
        valIdx--;
        vaSum += lowerVol;
      } else if (vahIdx < rows - 1) {
        vahIdx++;
        vaSum += upperVol;
      } else {
        break;
      }
    }

    const poc = minP + (pocIdx + 0.5) * binSize;
    const vah = minP + (vahIdx + 0.5) * binSize;
    const val = minP + (valIdx + 0.5) * binSize;

    this.profileLevels = { poc, vah, val };
    return this.profileLevels;
  }

  calcUnifiedPOC_VA(high: number[], low: number[], close: number[], volume: number[], rows: number): ProfileLevels {
    const n = high.length;
    if (n === 0) return { poc: 0, vah: 0, val: 0 };
    return this.calcProfile(high, low, close, volume, rows, n - 1);
  }

  findZones(tolerance: number): ConfluenceZone[] {
    const zones: ConfluenceZone[] = [];
    const tolPct = tolerance / 100;

    // Cluster swing highs into resistance zones
    for (const sh of this.prevSwingHighs) {
      let found = false;
      for (const zone of zones) {
        if (zone.isResistance && Math.abs(sh.price - zone.price) / zone.price < tolPct) {
          zone.strength += 1;
          zone.touches += 1;
          found = true;
          break;
        }
      }
      if (!found) {
        zones.push({ price: sh.price, strength: 1, touches: 1, isResistance: true });
      }
    }

    // Cluster swing lows into support zones
    for (const sl of this.prevSwingLows) {
      let found = false;
      for (const zone of zones) {
        if (!zone.isResistance && Math.abs(sl.price - zone.price) / zone.price < tolPct) {
          zone.strength += 1;
          zone.touches += 1;
          found = true;
          break;
        }
      }
      if (!found) {
        zones.push({ price: sl.price, strength: 1, touches: 1, isResistance: false });
      }
    }

    this.confluenceZones = zones.filter(z => z.touches >= 2);
    return this.confluenceZones;
  }

  checkSiegeProximity(currentPrice: number, corridor: { isActive: boolean; price: number }, atr: number): boolean {
    if (!corridor.isActive) return false;
    return Math.abs(currentPrice - corridor.price) < atr * 0.5;
  }

  isInsideValue(price: number): boolean {
    const { vah, val } = this.profileLevels;
    return price >= val && price <= vah;
  }

  getStructureState(): StructureState {
    return {
      tf1: {
        poc: this.profileLevels.poc,
        vah: this.profileLevels.vah,
        val: this.profileLevels.val,
        resCorridor: this.resCorridor,
        supCorridor: this.supCorridor,
      },
      activeCount: 1,
      netBias: (this.swingHighs.length || 0) - (this.swingLows.length || 0),
    };
  }

  getIntrabarState(price: number, atr: number): IntrabarState {
    let atConfluence = false;
    for (const zone of this.confluenceZones) {
      if (Math.abs(price - zone.price) < atr * 0.2) { atConfluence = true; break; }
    }
    const { poc, vah, val } = this.profileLevels;
    return {
      atConfluence,
      atPoc: Math.abs(price - poc) < atr * 0.1,
      atVah: Math.abs(price - vah) < atr * 0.15,
      atVal: Math.abs(price - val) < atr * 0.15,
      atSiegeRes: this.checkSiegeProximity(price, this.resCorridor, atr),
      atSiegeSup: this.checkSiegeProximity(price, this.supCorridor, atr),
    };
  }

  getMarketContext(close: number[], volume: number[], avgVol: number[], barIndex: number): MarketContext {
    // Unified aggressor: compare close to midpoint of bar
    let aggSum = 0;
    let aggCount = 0;
    const lookback = Math.min(20, barIndex + 1);
    for (let i = barIndex - lookback + 1; i <= barIndex; i++) {
      if (i < 0) continue;
      const mid = i > 0 ? (close[i] + close[i - 1]) / 2 : close[i];
      aggSum += close[i] > mid ? 1 : 0;
      aggCount++;
    }
    const unifiedAgg = aggCount > 0 ? aggSum / aggCount : 0.5;

    // Spread proxy (normalized high-low as %)
    const atrArr = (() => {
      const tr: number[] = [];
      for (let i = 1; i < close.length; i++) {
        const hl = Math.abs(close[i] - close[i - 1]);
        tr.push(hl / close[i]);
      }
      tr.unshift(0);
      return tr;
    })();
    const spreadProxy = atrArr[barIndex] || 0;

    // Absorption: compare volume to average
    const absorption = avgVol[barIndex] > 0 && volume[barIndex] > avgVol[barIndex] * 1.3 ? 1 : 0;

    return { unifiedAgg, spreadProxy, absorption };
  }

  projectSiegePrice(corridor: { isActive: boolean; price: number; startBar: number }, barIndex: number): number {
    if (!corridor.isActive) return NaN;
    const elapsed = barIndex - corridor.startBar;
    const decay = Math.exp(-elapsed * 0.0005);
    return corridor.price * (1 - (1 - decay) * 0.3);
  }

  reset(): void {
    this.swingHighs = [];
    this.swingLows = [];
    this.prevSwingHighs = [];
    this.prevSwingLows = [];
    this.profileLevels = { poc: 0, vah: 0, val: 0 };
    this.confluenceZones = [];
    this.resCorridor = { isActive: false, price: 0, startBar: 0 };
    this.supCorridor = { isActive: false, price: 0, startBar: 0 };
  }
}
