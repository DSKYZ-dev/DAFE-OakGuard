/**
 * Adaptive Genesis Engine (AGE) — Darwinian strategy evolution
 * Core genetic algorithm with population management, signal generation, trade management.
 */
import { DVSEngine, type DVSState } from './dvs-engine';
import { MarketStructureEngine, type IntrabarState, type MarketContext, type ProfileLevels, type StructureState } from './market-structure';
import { RCMEngine, type RCMState, type RCMModulation, type RCMPermissions } from './rcm-engine';

// ─── Gene Indices ─────────────────────────────────────────────────
const GENE_COUNT = 10;
const IDX_ENTROPY_SENS = 0;
const IDX_MOMENTUM_SENS = 1;
const IDX_STRUCTURE_SENS = 2;
const IDX_PROB_BOOST = 3;
const IDX_TREND_STRENGTH = 4;
const IDX_VOL_FILTER = 5;
const IDX_ATR_MULT = 6;
const IDX_STOP_MULT = 7;
const IDX_TARGET_MULT = 8;
const IDX_REGIME_ADAPT = 9;

const GENE_MIN = [0.5, 0.5, 0.5, -0.10, 0.3, 0.5, 1.5, 1.0, 1.5, 0.0];
const GENE_MAX = [2.0, 2.0, 2.0, 0.10, 0.8, 1.5, 4.0, 2.5, 4.0, 1.0];

// ─── Strategy Interface ───────────────────────────────────────────
export interface Strategy {
  id: number;
  parent: number;
  generation: number;
  birthBar: number;
  active: boolean;
  wfoValidated: boolean;
  dna: number[];
  shadowPosition: number;
  shadowEntry: number;
  shadowStop: number;
  shadowTarget: number;
  shadowTrailStop: number;
  shadowMFE: number;
  shadowSLDist: number;
  shadowCooldown: number;
  shadowSignalAge: number;
  shadowLastSignal: number;
  shadowLastProbability: number;
  shadowLastConfluence: number;
  trades: number;
  wins: number;
  pnl: number;
  peak: number;
  drawdown: number;
  fitness: number;
  // WFO
  wfoTrainTrades: number;
  wfoTrainWins: number;
  wfoTrainPnl: number;
  wfoTestTrades: number;
  wfoTestWins: number;
  wfoTestPnl: number;
  wfoEfficiency: number;
  // Diagnostics
  diagSignalsEvaluated: number;
  diagRejectedProbability: number;
  diagRejectedConfluence: number;
  diagRejectedTrend: number;
  diagRejectedRegime: number;
  diagRejectedVolume: number;
  diagRejectedPersistence: number;
  diagSignalsPassed: number;
}

// ─── Signal Result ─────────────────────────────────────────────────
export interface SignalResult {
  direction: number;
  probability: number;
  confluence: number;
  signalAge: number;
  lastSignal: number;
}

// ─── AGE Configuration ─────────────────────────────────────────────
export interface AGEConfig {
  enableAGE: boolean;
  maxPopulation: number;
  minPopulation: number;
  eliteCount: number;
  histSpawnInterval: number;
  histCullInterval: number;
  liveSpawnInterval: number;
  liveCullInterval: number;
  histMutationRate: number;
  liveMutationRate: number;
  mutationStrength: number;
  minProbability: number;
  minConfluence: number;
  basePersistence: number;
  cooldownBars: number;
  entropyLen: number;
  momentumLen: number;
  trendLen: number;
  structureLen: number;
  atrPeriod: number;
  tmMode: 'Genetic Adaptive' | 'Fixed ATR + R2R';
  fixedSL: number;
  fixedR2R: number;
  tsMode: 'None' | 'ATR Trailing';
  tsActivation: number;
  tsATRMult: number;
  enableWFO: boolean;
  wfoTrainBars: number;
  wfoTestBars: number;
  wfoMinTrades: number;
  wfoEfficiencyThreshold: number;
}

export const DEFAULT_AGE_CONFIG: AGEConfig = {
  enableAGE: true,
  maxPopulation: 8,
  minPopulation: 3,
  eliteCount: 2,
  histSpawnInterval: 30,
  histCullInterval: 60,
  liveSpawnInterval: 200,
  liveCullInterval: 400,
  histMutationRate: 0.2,
  liveMutationRate: 0.08,
  mutationStrength: 0.12,
  minProbability: 0.65,
  minConfluence: 2,
  basePersistence: 2,
  cooldownBars: 8,
  entropyLen: 20,
  momentumLen: 14,
  trendLen: 50,
  structureLen: 50,
  atrPeriod: 14,
  tmMode: 'Genetic Adaptive',
  fixedSL: 1.5,
  fixedR2R: 2.0,
  tsMode: 'ATR Trailing',
  tsActivation: 1.0,
  tsATRMult: 1.0,
  enableWFO: true,
  wfoTrainBars: 250,
  wfoTestBars: 75,
  wfoMinTrades: 5,
  wfoEfficiencyThreshold: 0.55,
};

// ─── Main Engine Class ─────────────────────────────────────────────
export class AdaptiveGenesisEngine {
  private config: AGEConfig;
  private dvs: DVSEngine;
  marketStructure: MarketStructureEngine;
  rcm: RCMEngine;

  private strategies: Strategy[] = [];
  private currentGeneration = 0;
  private totalSpawned = 0;
  private totalCulled = 0;
  private totalWFOPassed = 0;
  private MAS = 0.10;
  private selectedStrategy = -1;
  private lastSpawnBar = 0;
  private lastCullBar = 0;
  private isLivePhase = false;
  private isInitialized = false;
  private regimeType = 0;
  private lastEvolutionBar = 0;

  // Cached technical values
  private _volume: number[] = [];
  private trendEMA: number[] = [];
  private atrValues: number[] = [];
  private volSMA: number[] = [];
  private entropySignal: number[] = [];
  private momentumSignal: number[] = [];
  private structureSignal2: number[] = [];
  private dvsState: DVSState = { currentRatio: 1, baselineRatio: 1, atrRatio: 1, parkinsonRatio: 1, garmanKlassRatio: 1, ensembleRatio: 1, smoothedRatio: 1 };

  // Public readonly state
  public signalFormingAge = 0;
  public signalFormingProb = 0;
  public onEvolutionEvent: ((type: 'spawn' | 'cull' | 'elite' | 'validated', strategyId: number) => void) | null = null;

  constructor(config: Partial<AGEConfig> = {}) {
    this.config = { ...DEFAULT_AGE_CONFIG, ...config };
    this.dvs = new DVSEngine({
      method: 'Ensemble',
      memory: 100,
      sensitivity: 0.7,
    });
    this.marketStructure = new MarketStructureEngine();
    this.rcm = new RCMEngine(RCMEngine.defaultConfig());
  }

  // ─── Initialization ────────────────────────────────────────────
  private init(): void {
    if (this.isInitialized) return;

    // Initialize with 4 seed strategies
    const seeds: number[][] = [
      [1.0, 1.0, 1.0, 0.0, 0.4, 0.8, 2.5, 1.5, 2.5, 0.5],  // Balanced
      [0.7, 1.5, 0.8, 0.03, 0.5, 0.7, 2.0, 1.3, 3.0, 0.7],  // Momentum + R2R
      [1.5, 0.8, 0.7, -0.02, 0.6, 1.0, 3.0, 1.8, 2.5, 0.8], // Entropy + Wide
      [0.8, 0.9, 1.4, 0.02, 0.35, 0.9, 2.2, 1.6, 2.8, 0.4],  // Structure
    ];

    for (let i = 0; i < seeds.length; i++) {
      const s = this.createStrategy(i, -1, 0, 0);
      s.dna = [...seeds[i]];
      s.wfoValidated = !this.config.enableWFO;
      this.strategies.push(s);
    }

    this.totalSpawned = 4;
    this.MAS = 0.08;
    this.isInitialized = true;
  }

  private createStrategy(id: number, parent: number, generation: number, barIndex: number): Strategy {
    return {
      id, parent, generation, birthBar: barIndex,
      active: true, wfoValidated: false,
      dna: new Array(GENE_COUNT).fill(0),
      shadowPosition: 0, shadowEntry: 0, shadowStop: 0, shadowTarget: 0,
      shadowTrailStop: NaN, shadowMFE: 0, shadowSLDist: 0,
      shadowCooldown: 0, shadowSignalAge: 0, shadowLastSignal: 0,
      shadowLastProbability: 0, shadowLastConfluence: 0,
      trades: 0, wins: 0, pnl: 0, peak: 0, drawdown: 0, fitness: 0,
      wfoTrainTrades: 0, wfoTrainWins: 0, wfoTrainPnl: 0,
      wfoTestTrades: 0, wfoTestWins: 0, wfoTestPnl: 0, wfoEfficiency: 0,
      diagSignalsEvaluated: 0, diagRejectedProbability: 0,
      diagRejectedConfluence: 0, diagRejectedTrend: 0,
      diagRejectedRegime: 0, diagRejectedVolume: 0,
      diagRejectedPersistence: 0, diagSignalsPassed: 0,
    };
  }

  // ─── Technical Computations ────────────────────────────────────
  private ema(source: number[], period: number): number[] {
    const result: number[] = [];
    const mult = 2 / (period + 1);
    let val = source[0] || 0;
    result.push(val);
    for (let i = 1; i < source.length; i++) {
      val = (source[i] - val) * mult + val;
      result.push(val);
    }
    return result;
  }

  private sma(source: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (i < period - 1) { result.push(source[i] || 0); continue; }
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += source[j];
      result.push(sum / period);
    }
    return result;
  }

  private trueRange(high: number[], low: number[], close: number[]): number[] {
    const result: number[] = [high[0] - low[0]];
    for (let i = 1; i < close.length; i++) {
      result.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    }
    return result;
  }

  private rsi(close: number[], period: number): number[] {
    const result: number[] = [50];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < close.length; i++) {
      const diff = close[i] - close[i - 1];
      if (i === period) {
        let sg = 0, sl = 0;
        for (let j = 0; j < period; j++) {
          const d = close[j + 1] - close[j];
          if (d > 0) sg += d; else sl -= d;
        }
        avgGain = sg / period; avgLoss = sl / period;
      } else if (i > period) {
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
      }
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
  }

  private computeTechnicals(open: number[], high: number[], low: number[], close: number[], volume: number[]): void {
    const n = close.length;

    // Store volume for signal calculation
    this._volume = volume;

    // Trend EMA
    this.trendEMA = this.ema(close, this.config.trendLen);

    // ATR
    const tr = this.trueRange(high, low, close);
    this.atrValues = this.ema(tr, this.config.atrPeriod);

    // Volume SMA
    this.volSMA = this.sma(volume, 20);

    // Entropy signal
    this.entropySignal = new Array(n).fill(0);
    const entLen = this.config.entropyLen;
    for (let i = entLen; i < n; i++) {
      let sumUp = 0, sumDn = 0;
      for (let j = 0; j < entLen; j++) {
        const chg = close[i - j] - close[i - j - 1];
        if (chg > 0) sumUp += chg;
        else sumDn -= chg;
      }
      const total = sumUp + sumDn;
      if (total === 0) { this.entropySignal[i] = 0; continue; }
      const ratio = sumUp / total;
      const clamp = (v: number) => Math.max(0.001, v);
      const entropy = -(ratio * Math.log(clamp(ratio)) + (1 - ratio) * Math.log(clamp(1 - ratio)));
      const order = 1 - entropy / 0.693;
      this.entropySignal[i] = order * (sumUp > sumDn ? 1 : -1);
    }

    // Momentum signal
    this.momentumSignal = new Array(n).fill(0);
    const momLen = this.config.momentumLen;
    const rsiArr = this.rsi(close, momLen);
    for (let i = momLen; i < n; i++) {
      const rsiNorm = (rsiArr[i] - 50) / 50;
      const rocVal = momLen > 0 ? (close[i] - close[i - momLen]) / close[i - momLen] : 0;
      const rocNorm = Math.max(-1, Math.min(1, rocVal / 3));
      const emaFast = this.ema(close, 12);
      const emaSlow = this.ema(close, 26);
      const macdHist = emaFast[i] - emaSlow[i];
      const macdNorm = Math.max(-1, Math.min(1, macdHist / (this.atrValues[i] || 1)));
      this.momentumSignal[i] = rsiNorm * 0.4 + rocNorm * 0.3 + macdNorm * 0.3;
    }

    // Structure signal
    this.structureSignal2 = new Array(n).fill(0);
    const structLen = this.config.structureLen;
    for (let i = structLen; i < n; i++) {
      const hh = Math.max(...high.slice(i - structLen + 1, i + 1));
      const ll = Math.min(...low.slice(i - structLen + 1, i + 1));
      const range = hh - ll;
      if (range === 0) { this.structureSignal2[i] = 0; continue; }
      const pos = (close[i] - ll) / range;
      const atSupport = pos < 0.2 && close[i] > close[i - 1];
      const atResistance = pos > 0.8 && close[i] < close[i - 1];
      if (atSupport) this.structureSignal2[i] = 0.7;
      else if (atResistance) this.structureSignal2[i] = -0.7;
      else if (pos > 0.5) this.structureSignal2[i] = close[i] > high[i - 1] ? 0.5 : -0.3;
      else this.structureSignal2[i] = close[i] < low[i - 1] ? -0.5 : 0.3;
    }

    // DVS
    this.dvsState = this.dvs.update(n - 1, open, high, low, close);

    // Regime detection
    const atrArr = this.atrValues;
    const hh = Math.max(...high.slice(Math.max(0, n - this.config.trendLen), n));
    const ll = Math.min(...low.slice(Math.max(0, n - this.config.trendLen), n));
    const priceRange = hh - ll;
    const directional = Math.abs(close[n - 1] - close[Math.max(0, n - this.config.trendLen)]);
    const efficiency = priceRange > 0 ? directional / priceRange : 0;
    const volCurrent = atrArr[n - 1] / close[n - 1];
    const volSlice = atrArr.slice(Math.max(0, n - this.config.trendLen), n).map((v, idx) => close[idx + Math.max(0, n - this.config.trendLen)] > 0 ? v / close[idx + Math.max(0, n - this.config.trendLen)] : 0);
    const volAvg = volSlice.reduce((a, b) => a + b, 0) / volSlice.length || 0;
    const volRatio = volAvg > 0 ? volCurrent / volAvg : 1;

    if (efficiency > 0.5 && volRatio < 1.3) this.regimeType = 1; // Trending
    else if (volRatio > 1.5) this.regimeType = 2;              // Volatile
    else this.regimeType = 0;                                  // Balanced
  }

  // ─── Signal Calculation ────────────────────────────────────────
  private calcSignal(strategy: Strategy, barIndex: number): SignalResult {
    const entropySens = strategy.dna[IDX_ENTROPY_SENS];
    const momentumSens = strategy.dna[IDX_MOMENTUM_SENS];
    const structureSens = strategy.dna[IDX_STRUCTURE_SENS];
    const probBoost = strategy.dna[IDX_PROB_BOOST];
    const trendReq = strategy.dna[IDX_TREND_STRENGTH];
    const volFilter = strategy.dna[IDX_VOL_FILTER];
    const regimeAdapt = strategy.dna[IDX_REGIME_ADAPT];

    const dvsRatio = this.dvsState.smoothedRatio;
    const ent = this.entropySignal[barIndex] || 0;
    const mom = this.momentumSignal[barIndex] || 0;
    const struc = this.structureSignal2[barIndex] || 0;

    const adjEntropy = ent * entropySens;
    const adjMomentum = mom * momentumSens;
    const adjStructure = struc * structureSens;

    const baseThreshold = 0.30;
    const sensAdjEnt = baseThreshold / Math.max(0.5, entropySens);
    const sensAdjMom = baseThreshold / Math.max(0.5, momentumSens);
    const sensAdjStr = baseThreshold / Math.max(0.5, structureSens);
    const dvsAdj = dvsRatio > 1.5 ? 0.95 : dvsRatio < 0.7 ? 1.05 : 1.0;
    const threshEnt = Math.max(0.15, Math.min(0.50, sensAdjEnt * dvsAdj));
    const threshMom = Math.max(0.15, Math.min(0.50, sensAdjMom * dvsAdj));
    const threshStr = Math.max(0.15, Math.min(0.50, sensAdjStr * dvsAdj));

    let longVotes = 0, shortVotes = 0;
    if (adjEntropy > threshEnt) longVotes++;
    else if (adjEntropy < -threshEnt) shortVotes++;
    if (adjMomentum > threshMom) longVotes++;
    else if (adjMomentum < -threshMom) shortVotes++;
    if (adjStructure > threshStr) longVotes++;
    else if (adjStructure < -threshStr) shortVotes++;

    const confluence = Math.max(longVotes, shortVotes);
    const direction = longVotes > shortVotes ? 1 : shortVotes > longVotes ? -1 : 0;
    const avgSignal = (Math.abs(adjEntropy) + Math.abs(adjMomentum) + Math.abs(adjStructure)) / 3;
    let prob = 0.50 + avgSignal * 0.25 + probBoost;

    if (this.regimeType === 1) prob += 0.03 * regimeAdapt;
    else if (this.regimeType === 2) prob -= 0.05 * regimeAdapt;
    else prob -= 0.02 * regimeAdapt;

    const trendSlope = barIndex > 0 && barIndex < this.trendEMA.length ? (this.trendEMA[barIndex] - (this.trendEMA[barIndex - 1] || this.trendEMA[barIndex])) / (this.trendEMA[barIndex] || 1) * 100 : 0;
    const trendDir = trendSlope > 0.1 ? 1 : trendSlope < -0.1 ? -1 : 0;
    const trendStrength = Math.abs(trendSlope);

    if (direction === trendDir) prob += 0.04;
    else if (direction !== 0 && trendDir !== 0 && direction !== trendDir) prob -= 0.08;
    if (trendStrength < trendReq) prob -= 0.03;

    if (this._volume[barIndex] < this.volSMA[barIndex] * volFilter) prob -= 0.03;
    if (dvsRatio > 1.8) { prob -= 0.04; }
    else if (dvsRatio < 0.7) prob -= 0.02;
    else if (dvsRatio > 1.0 && dvsRatio < 1.3) prob += 0.02;

    if (confluence >= 3) prob += 0.05;
    else if (confluence >= 2) prob += 0.02;

    prob = Math.max(0.35, Math.min(0.88, prob));

    const signalAge = direction === strategy.shadowLastSignal && direction !== 0 ? strategy.shadowSignalAge + 1 : (direction !== 0 ? 1 : 0);

    return { direction, probability: prob, confluence, signalAge, lastSignal: direction !== 0 ? direction : strategy.shadowLastSignal };
  }

  // ─── Quality Gate ──────────────────────────────────────────────
  private qualityGate(
    strategy: Strategy,
    signal: SignalResult,
    close: number[],
    volume: number[],
    barIndex: number,
  ): boolean {
    strategy.diagSignalsEvaluated++;

    if (signal.probability < this.config.minProbability) {
      strategy.diagRejectedProbability++;
      return false;
    }
    if (signal.confluence < this.config.minConfluence) {
      strategy.diagRejectedConfluence++;
      return false;
    }
    if (signal.direction === 0) {
      strategy.diagRejectedConfluence++;
      return false;
    }

    const trendSlope = barIndex > 0 ? (this.trendEMA[barIndex] - this.trendEMA[barIndex - 1]) / this.trendEMA[barIndex] * 100 : 0;
    const trendDir = trendSlope > 0.1 ? 1 : trendSlope < -0.1 ? -1 : 0;
    const trendStrength = Math.abs(trendSlope);

    if (trendStrength > 0.5 && signal.direction !== trendDir && trendDir !== 0) {
      strategy.diagRejectedTrend++;
      return false;
    }
    if (this.regimeType === 2 && signal.probability < 0.72) {
      strategy.diagRejectedRegime++;
      return false;
    }
    if (volume[barIndex] < this.volSMA[barIndex] * 0.7) {
      strategy.diagRejectedVolume++;
      return false;
    }

    strategy.diagSignalsPassed++;
    return true;
  }

  // ─── Required Persistence ──────────────────────────────────────
  private requiredPersistence(probability: number): number {
    let base = this.config.basePersistence;
    if (probability >= 0.75) base = Math.max(1, base - 1);
    else if (probability < 0.68) base = base + 1;
    if (this.regimeType === 1) base = Math.max(1, base - 1);
    else if (this.regimeType === 2) base = base + 1;
    return Math.max(1, Math.min(5, base));
  }

  // ─── Fitness ───────────────────────────────────────────────────
  private calcFitness(strategy: Strategy): number {
    if (strategy.trades < 3) return 0;
    const winRate = strategy.wins / strategy.trades;
    const normWR = winRate;
    const normPnl = Math.max(0, Math.min(1, (strategy.pnl + 300) / 600));
    const expectancy = strategy.pnl / strategy.trades;
    const normExpect = Math.max(0, Math.min(1, (expectancy + 30) / 60));
    const normDD = Math.max(0, Math.min(1, 1 - strategy.drawdown / 15));
    const qualityFactor = strategy.trades < 50 ? 1 : strategy.trades < 100 ? 0.95 : 0.85;

    let fit = (0.30 * normWR + 0.30 * normPnl + 0.25 * normExpect + 0.15 * normDD) * qualityFactor;

    if (strategy.wfoValidated) {
      fit += (strategy.wfoEfficiency - 0.5) * 0.1;
    }

    if (strategy.diagSignalsEvaluated > 10) {
      const efficiency = strategy.diagSignalsPassed / strategy.diagSignalsEvaluated;
      fit += (efficiency - 0.1) * 0.05;
    }

    return Math.max(0, fit);
  }

  // ─── WFO Check ─────────────────────────────────────────────────
  private checkWFO(strategy: Strategy): boolean {
    if (strategy.wfoTrainTrades < this.config.wfoMinTrades || strategy.wfoTestTrades < this.config.wfoMinTrades) return false;
    const trainWR = strategy.wfoTrainWins / strategy.wfoTrainTrades;
    const testWR = strategy.wfoTestWins / strategy.wfoTestTrades;
    const trainExp = strategy.wfoTrainPnl / strategy.wfoTrainTrades;
    const testExp = strategy.wfoTestPnl / strategy.wfoTestTrades;
    const wrEff = trainWR > 0 ? testWR / trainWR : 0;
    const expEff = trainExp > 0.01 ? testExp / trainExp : (testExp > 0 ? 1 : 0);
    strategy.wfoEfficiency = (wrEff + Math.max(0, Math.min(2, expEff))) / 2;
    return strategy.wfoEfficiency >= this.config.wfoEfficiencyThreshold;
  }

  // ─── Genetic Operations ─────────────────────────────────────────
  private pseudoRandom(seed: number): number {
    const x = (seed * 1103515245 + 12345) % 2147483647;
    return x / 2147483647;
  }

  private selectParent(seed: number): number {
    let best = -1, bestFit = -1;
    const active = this.strategies.filter(s => s.active);
    for (let attempt = 0; attempt < 3; attempt++) {
      let candidateIdx = -1;
      let tries = 0;
      while (candidateIdx === -1 && tries < 20) {
        const cand = Math.floor(this.pseudoRandom(seed + attempt * 100 + tries) * this.strategies.length);
        if (cand < this.strategies.length && this.strategies[cand].active) candidateIdx = cand;
        tries++;
      }
      if (candidateIdx >= 0 && this.strategies[candidateIdx].fitness > bestFit) {
        bestFit = this.strategies[candidateIdx].fitness;
        best = candidateIdx;
      }
    }
    return best;
  }

  private selectForTrading(): number {
    let best = -1, bestFit = -1;
    for (let i = 0; i < this.strategies.length; i++) {
      if (this.strategies[i].active) {
        let fit = this.strategies[i].fitness;
        if (this.strategies[i].wfoValidated) fit *= 1.3;
        if (fit > bestFit) { bestFit = fit; best = i; }
      }
    }
    return best;
  }

  private mutate(val: number, geneIdx: number, seed: number, rate: number): number {
    if (this.pseudoRandom(seed) < rate) {
      const minV = GENE_MIN[geneIdx];
      const maxV = GENE_MAX[geneIdx];
      const range = maxV - minV;
      const noise = (this.pseudoRandom(seed + 1) - 0.5) * 2 * this.config.mutationStrength * range;
      return Math.max(minV, Math.min(maxV, val + noise));
    }
    return val;
  }

  private crossover(p1Idx: number, p2Idx: number, childIdx: number, seed: number, mutRate: number): void {
    const p1 = this.strategies[p1Idx];
    const p2 = this.strategies[p2Idx];
    const totalFit = p1.fitness + p2.fitness;
    const w1 = totalFit > 0 ? p1.fitness / totalFit : 0.5;

    for (let g = 0; g < GENE_COUNT; g++) {
      let childVal = w1 * p1.dna[g] + (1 - w1) * p2.dna[g];
      childVal = this.mutate(childVal, g, seed + g * 10, mutRate);
      this.strategies[childIdx].dna[g] = childVal;
    }
  }

  // ─── Main Update Loop ──────────────────────────────────────────
  /**
   * Main update: call once per bar with OHLCV data.
   * Returns the signal state for the selected strategy.
   */
  update(
    barIndex: number,
    isRealtime: boolean,
    open: number[],
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
  ): {
    position: number;
    entry: number;
    stop: number;
    target: number;
    trailStop: number;
    probability: number;
    confluence: number;
    signalAge: number;
    lastSignal: number;
    strategyId: number;
    generation: number;
    validated: boolean;
    newSignal: boolean;
    exitSignal: boolean;
  } | null {
    if (!this.config.enableAGE) return null;

    if (!this.isInitialized) this.init();
    if (barIndex < this.config.structureLen + 20) return null;

    // Update technicals
    this.computeTechnicals(open, high, low, close, volume);

    // Update RCM
    this.rcm.update(close, volume, barIndex);

    // Update market structure
    this.marketStructure.detectSwingHigh(high, low, barIndex, 5);
    this.marketStructure.detectSwingLow(high, low, barIndex, 5);
    this.marketStructure.calcProfile(high, low, close, volume, 24, barIndex);

    if (isRealtime && !this.isLivePhase) this.isLivePhase = true;

    const mutRate = this.isLivePhase ? this.config.liveMutationRate : this.config.histMutationRate;
    const spawnInt = this.isLivePhase ? this.config.liveSpawnInterval : this.config.histSpawnInterval;
    const cullInt = this.isLivePhase ? this.config.liveCullInterval : this.config.histCullInterval;

    // Process all active strategies
    for (let i = 0; i < this.strategies.length; i++) {
      const s = this.strategies[i];
      if (!s.active) continue;

      // Trade management
      if (s.shadowPosition !== 0) {
        let exitHit = false;
        let tradePnl = 0;

        if (s.shadowPosition === 1) {
          // Long position
          s.shadowMFE = Math.max(s.shadowMFE, high[barIndex]);
          if (this.config.tsMode === 'ATR Trailing') {
            const activationPrice = s.shadowEntry + s.shadowSLDist * this.config.tsActivation;
            if (high[barIndex] >= activationPrice) {
              const newTrail = high[barIndex] - (this.atrValues[barIndex] || 0) * this.config.tsATRMult;
              if (isNaN(s.shadowTrailStop) || newTrail > s.shadowTrailStop) {
                s.shadowTrailStop = newTrail;
              }
            }
          }
          if (low[barIndex] <= s.shadowStop) {
            tradePnl = (s.shadowStop - s.shadowEntry) / s.shadowSLDist;
            exitHit = true;
          } else if (!isNaN(s.shadowTrailStop) && low[barIndex] <= s.shadowTrailStop) {
            tradePnl = (s.shadowTrailStop - s.shadowEntry) / s.shadowSLDist;
            exitHit = true;
          } else if (high[barIndex] >= s.shadowTarget) {
            tradePnl = (s.shadowTarget - s.shadowEntry) / s.shadowSLDist;
            exitHit = true;
          }
        } else {
          // Short position
          s.shadowMFE = Math.min(s.shadowMFE === 0 ? low[barIndex] : s.shadowMFE, low[barIndex]);
          if (this.config.tsMode === 'ATR Trailing') {
            const activationPrice = s.shadowEntry - s.shadowSLDist * this.config.tsActivation;
            if (low[barIndex] <= activationPrice) {
              const newTrail = low[barIndex] + (this.atrValues[barIndex] || 0) * this.config.tsATRMult;
              if (isNaN(s.shadowTrailStop) || newTrail < s.shadowTrailStop) {
                s.shadowTrailStop = newTrail;
              }
            }
          }
          if (high[barIndex] >= s.shadowStop) {
            tradePnl = (s.shadowEntry - s.shadowStop) / s.shadowSLDist;
            exitHit = true;
          } else if (!isNaN(s.shadowTrailStop) && high[barIndex] >= s.shadowTrailStop) {
            tradePnl = (s.shadowEntry - s.shadowTrailStop) / s.shadowSLDist;
            exitHit = true;
          } else if (low[barIndex] <= s.shadowTarget) {
            tradePnl = (s.shadowEntry - s.shadowTarget) / s.shadowSLDist;
            exitHit = true;
          }
        }

        if (exitHit) {
          s.trades++;
          if (tradePnl > 0) s.wins++;
          s.pnl += tradePnl;
          if (s.pnl > s.peak) s.peak = s.pnl;
          else {
            const dd = s.peak - s.pnl;
            if (dd > s.drawdown) s.drawdown = dd;
          }
          const age = barIndex - s.birthBar;
          if (age <= this.config.wfoTrainBars) {
            s.wfoTrainTrades++;
            if (tradePnl > 0) s.wfoTrainWins++;
            s.wfoTrainPnl += tradePnl;
          } else if (age <= this.config.wfoTrainBars + this.config.wfoTestBars) {
            s.wfoTestTrades++;
            if (tradePnl > 0) s.wfoTestWins++;
            s.wfoTestPnl += tradePnl;
          }
          s.shadowPosition = 0;
          s.shadowCooldown = this.config.cooldownBars;
          s.shadowTrailStop = NaN;
        }
      }

      // Signal generation (only when not in a trade)
      if (s.shadowPosition === 0) {
        if (s.shadowCooldown > 0) {
          s.shadowCooldown--;
        } else {
          const signal = this.calcSignal(s, barIndex);
          s.shadowLastProbability = signal.probability;
          s.shadowLastConfluence = signal.confluence;
          s.shadowSignalAge = signal.signalAge;
          s.shadowLastSignal = signal.lastSignal;

          const requiredPersist = this.requiredPersistence(signal.probability);
          const passesGate = this.qualityGate(s, signal, close, volume, barIndex);
          const rcmPerms = this.rcm.getPermissions(false);
          const rcmGate = this.rcm.getGate(false);
          const rcmAllowLong = rcmPerms.allowLong;
          const rcmAllowShort = rcmPerms.allowShort;

          if (signal.signalAge >= requiredPersist && passesGate && rcmGate) {
            const dirOk = (signal.direction === 1 && rcmAllowLong) || (signal.direction === -1 && rcmAllowShort);
            if (dirOk) {
              let slDist = 0;
              let tpDist = 0;

              if (this.config.tmMode === 'Fixed ATR + R2R') {
                slDist = (this.atrValues[barIndex] || 1) * this.config.fixedSL * this.dvsState.smoothedRatio;
                tpDist = slDist * this.config.fixedR2R;
              } else {
                const atrMult = s.dna[IDX_ATR_MULT];
                const stopMult = s.dna[IDX_STOP_MULT];
                const targetMult = s.dna[IDX_TARGET_MULT];
                const rcmMod = this.rcm.getBandMod(0.45, 1.10);
                const atrScaled = (this.atrValues[barIndex] || 1) * atrMult * this.dvsState.smoothedRatio * rcmMod;
                slDist = atrScaled * stopMult;
                tpDist = atrScaled * targetMult;
              }

              if (signal.direction === 1) {
                s.shadowPosition = 1;
                s.shadowEntry = close[barIndex];
                s.shadowStop = close[barIndex] - slDist;
                s.shadowTarget = close[barIndex] + tpDist;
              } else {
                s.shadowPosition = -1;
                s.shadowEntry = close[barIndex];
                s.shadowStop = close[barIndex] + slDist;
                s.shadowTarget = close[barIndex] - tpDist;
              }
              s.shadowSLDist = slDist;
              s.shadowMFE = signal.direction === 1 ? high[barIndex] : low[barIndex];
              s.shadowTrailStop = NaN;
              s.shadowSignalAge = 0;
            }
          } else if (signal.signalAge >= requiredPersist && !passesGate) {
            s.diagRejectedPersistence++;
          }
        }
      }

      // Update fitness
      s.fitness = this.calcFitness(s);

      // WFO validation
      if (this.config.enableWFO && !s.wfoValidated) {
        if (this.checkWFO(s)) {
          s.wfoValidated = true;
          this.totalWFOPassed++;
          this.onEvolutionEvent?.('validated', s.id);
        }
      }
    }

    // Spawn new strategies
    if (barIndex - this.lastSpawnBar >= spawnInt) {
      const activeCount = this.strategies.filter(s => s.active).length;
      if (activeCount < this.config.maxPopulation) {
        const p1 = this.selectParent(barIndex);
        const p2 = this.selectParent(barIndex + 500);
        if (p1 >= 0 && p2 >= 0 && p1 !== p2) {
          const childS = this.createStrategy(this.totalSpawned, this.strategies[p1].id, this.currentGeneration + 1, barIndex);
          this.crossover(p1, p2, this.strategies.length, barIndex, mutRate);
          this.strategies.push(childS);
          this.totalSpawned++;
          this.currentGeneration = Math.max(this.currentGeneration, childS.generation);
          this.lastEvolutionBar = barIndex;
          this.onEvolutionEvent?.('spawn', childS.id);
        }
      }
      this.lastSpawnBar = barIndex;
    }

    // Cull worst strategies
    if (barIndex - this.lastCullBar >= cullInt) {
      this.MAS = Math.max(0.03, this.MAS * 0.995);
      const activeCount = this.strategies.filter(s => s.active).length;
      if (activeCount > this.config.minPopulation) {
        let worstIdx = -1; let worstFit = 999;
        for (let i = 0; i < this.strategies.length; i++) {
          const s = this.strategies[i];
          if (s.active) {
            const age = barIndex - s.birthBar;
            if (age > cullInt) {
              let fit = s.fitness;
              if (this.config.enableWFO && !s.wfoValidated) fit *= 0.7;
              if (fit < worstFit) { worstFit = fit; worstIdx = i; }
            }
          }
        }
        if (worstIdx >= 0 && worstFit < this.MAS) {
          let eliteCount = 0;
          for (let i = 0; i < this.strategies.length; i++) {
            if (this.strategies[i].active && this.strategies[i].fitness > worstFit) eliteCount++;
          }
          if (eliteCount >= this.config.eliteCount) {
            this.strategies[worstIdx].active = false;
            this.totalCulled++;
            this.lastEvolutionBar = barIndex;
            this.onEvolutionEvent?.('cull', this.strategies[worstIdx].id);
          }
        }
      }
      this.lastCullBar = barIndex;
    }

    // Select best for trading
    this.selectedStrategy = this.selectForTrading();

    // Build return value
    if (this.selectedStrategy < 0 || this.selectedStrategy >= this.strategies.length) return null;
    const sel = this.strategies[this.selectedStrategy];

    const prevPos = sel.shadowPosition;
    const newSignal = (sel.shadowPosition === 1 || sel.shadowPosition === -1) && prevPos !== sel.shadowPosition;

    if (sel.shadowLastSignal !== 0 && sel.shadowSignalAge > 0) {
      this.signalFormingAge = sel.shadowSignalAge;
      this.signalFormingProb = sel.shadowLastProbability;
    } else {
      this.signalFormingAge = 0;
      this.signalFormingProb = 0;
    }

    return {
      position: sel.shadowPosition,
      entry: sel.shadowEntry,
      stop: sel.shadowStop,
      target: sel.shadowTarget,
      trailStop: sel.shadowTrailStop,
      probability: sel.shadowLastProbability,
      confluence: sel.shadowLastConfluence,
      signalAge: sel.shadowSignalAge,
      lastSignal: sel.shadowLastSignal,
      strategyId: sel.id,
      generation: sel.generation,
      validated: sel.wfoValidated,
      newSignal,
      exitSignal: sel.shadowPosition === 0 && prevPos !== 0,
    };
  }

  // ─── Public Accessors ──────────────────────────────────────────
  getAllStrategies(): Strategy[] { return this.strategies; }

  getActiveStrategies(): Strategy[] { return this.strategies.filter(s => s.active); }

  selectedStrategyIndex(): number { return this.selectedStrategy; }

  getCurrentGeneration(): number { return this.currentGeneration; }

  getTotalSpawned(): number { return this.totalSpawned; }

  getTotalCulled(): number { return this.totalCulled; }

  getTotalWFOPassed(): number { return this.totalWFOPassed; }

  getMAS(): number { return this.MAS; }

  getRegimeType(): number { return this.regimeType; }

  getRegimeLabel(): string {
    return this.regimeType === 1 ? 'TRENDING' : this.regimeType === 2 ? 'VOLATILE' : 'BALANCED';
  }

  getDVSState(): DVSState { return this.dvsState; }

  getATRValue(): number { return this.atrValues.length > 0 ? this.atrValues[this.atrValues.length - 1] || 0 : 0; }

  getTrendEMA(): number { return this.trendEMA.length > 0 ? this.trendEMA[this.trendEMA.length - 1] || 0 : 0; }

  getProfileLevels(): ProfileLevels { return this.marketStructure.calcProfile([], [], [], [], 0, 0); }

  getRCMState(): RCMState { return this.rcm.getCurrentState(); }

  reset(): void {
    this.strategies = [];
    this.currentGeneration = 0;
    this.totalSpawned = 0;
    this.totalCulled = 0;
    this.totalWFOPassed = 0;
    this.MAS = 0.10;
    this.selectedStrategy = -1;
    this.lastSpawnBar = 0;
    this.lastCullBar = 0;
    this.isLivePhase = false;
    this.isInitialized = false;
    this.regimeType = 0;
    this.lastEvolutionBar = 0;
    this.signalFormingAge = 0;
    this.signalFormingProb = 0;
    this.dvs.reset();
    this.marketStructure.reset();
    this.trendEMA = [];
    this.atrValues = [];
    this.volSMA = [];
    this.entropySignal = [];
    this.momentumSignal = [];
    this.structureSignal2 = [];
  }
}
