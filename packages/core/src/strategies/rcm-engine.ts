/**
 * Regime Change Module (RCM) Engine
 * Tracks market regime transitions, structural integrity, and damage states
 */
export type RCMPreset = 'Default' | 'Scalp' | 'Swing';

export interface RCMConfig {
  trendStrength: number;
  momentumPeriod: number;
  volatilityThreshold: number;
  bullThreshold: number;
  bearThreshold: number;
  recoveryBars: number;
}

export interface RCMState {
  state: number;         // 1=bull, -1=bear, 0=neutral
  integrity: number;     // 0-1 structural integrity
  bullShift: boolean;
  bearShift: boolean;
  bullDamaged: boolean;
  bearDamaged: boolean;
}

export interface RCMPermissions {
  allowLong: boolean;
  allowShort: boolean;
  blockAll: boolean;
}

export interface RCMModulation {
  bandMultiplier: number;  // Adjusts signal sensitivity
  probabilityAdjust: number;
  direction: number;
  color: string;
}

export class RCMEngine {
  private config: RCMConfig;
  private state: RCMState = { state: 0, integrity: 0.5, bullShift: false, bearShift: false, bullDamaged: false, bearDamaged: false };
  private prevState = 0;
  private damageCounter = 0;
  private recoveryCounter = 0;

  constructor(config: RCMConfig) {
    this.config = config;
  }

  static defaultConfig(): RCMConfig {
    return {
      trendStrength: 0.45,
      momentumPeriod: 20,
      volatilityThreshold: 1.1,
      bullThreshold: 0.55,
      bearThreshold: 0.45,
      recoveryBars: 10,
    };
  }

  static scalpConfig(): RCMConfig {
    return {
      trendStrength: 0.35,
      momentumPeriod: 10,
      volatilityThreshold: 1.0,
      bullThreshold: 0.52,
      bearThreshold: 0.48,
      recoveryBars: 5,
    };
  }

  static swingConfig(): RCMConfig {
    return {
      trendStrength: 0.55,
      momentumPeriod: 30,
      volatilityThreshold: 1.25,
      bullThreshold: 0.58,
      bearThreshold: 0.42,
      recoveryBars: 15,
    };
  }

  update(close: number[], volume: number[], barIndex: number): RCMState {
    if (barIndex < this.config.momentumPeriod) {
      this.state = { state: 0, integrity: 0.5, bullShift: false, bearShift: false, bullDamaged: false, bearDamaged: false };
      return this.state;
    }

    this.prevState = this.state.state;

    // Calculate momentum via ROC
    const rocLen = this.config.momentumPeriod;
    const roc = barIndex >= rocLen
      ? (close[barIndex] - close[barIndex - rocLen]) / close[barIndex - rocLen]
      : 0;

    // Calculate volatility
    const tr: number[] = [];
    for (let i = Math.max(0, barIndex - rocLen + 1); i <= barIndex; i++) {
      if (i === 0) tr.push(close[i] > 0 ? 0 : 0);
      else tr.push(Math.abs(close[i] - close[i - 1]) / close[i]);
    }
    const avgTr = tr.reduce((a, b) => a + b, 0) / tr.length || 0;

    // Normalize momentum to [0,1] range
    const normalizedSignal = 0.5 + roc * 10;

    // Determine state
    const { bullThreshold, bearThreshold, volatilityThreshold } = this.config;

    if (normalizedSignal > bullThreshold) {
      this.state.state = 1;
    } else if (normalizedSignal < bearThreshold) {
      this.state.state = -1;
    } else {
      this.state.state = 0;
    }

    // Detect shifts
    this.state.bullShift = this.state.state === 1 && this.prevState <= 0;
    this.state.bearShift = this.state.state === -1 && this.prevState >= 0;

    // Integrity calculation (based on volatility)
    const integrity = Math.max(0, 1 - (avgTr / (volatilityThreshold * 0.02)));
    this.state.integrity = Math.min(1, integrity);

    // Damage detection
    if (this.state.state === 0 && this.prevState !== 0) {
      this.damageCounter++;
    } else {
      this.recoveryCounter++;
    }

    this.state.bullDamaged = this.damageCounter >= this.config.recoveryBars && this.prevState === 1;
    this.state.bearDamaged = this.damageCounter >= this.config.recoveryBars && this.prevState === -1;

    if (this.recoveryCounter >= this.config.recoveryBars * 2) {
      this.damageCounter = 0;
      this.recoveryCounter = 0;
      this.state.bullDamaged = false;
      this.state.bearDamaged = false;
    }

    return this.state;
  }

  getPermissions(blockSignalsInTransition: boolean): RCMPermissions {
    return {
      allowLong: this.state.state === 1 || (!blockSignalsInTransition && !this.state.bullDamaged),
      allowShort: this.state.state === -1 || (!blockSignalsInTransition && !this.state.bearDamaged),
      blockAll: blockSignalsInTransition && this.state.state === 0,
    };
  }

  getModulation(minBandMod: number, maxBandMod: number, signalStrength: number): RCMModulation {
    const bandMultiplier = minBandMod + (1 - this.state.integrity) * (maxBandMod - minBandMod);
    return {
      bandMultiplier,
      probabilityAdjust: this.state.state === 1 ? 0.03 : this.state.state === -1 ? -0.03 : 0,
      direction: this.state.state,
      color: this.state.state === 1 ? '#22cc88' : this.state.state === -1 ? '#ff4477' : '#8B9DC3',
    };
  }

  getGate(blockInTransition: boolean): boolean {
    if (blockInTransition && this.state.state === 0) return false;
    if (this.state.bullDamaged || this.state.bearDamaged) return false;
    return true;
  }

  getBandMod(min: number, max: number): number {
    const mod = this.getModulation(min, max, 0);
    return mod.bandMultiplier;
  }

  stateText(): string {
    switch (this.state.state) {
      case 1: return 'BULLISH';
      case -1: return 'BEARISH';
      default: return 'NEUTRAL';
    }
  }

  integrityText(): string {
    const val = Math.round(this.state.integrity * 100);
    if (val >= 80) return 'HI';
    if (val >= 60) return 'MID';
    if (val >= 35) return 'LOW';
    return 'BRK';
  }

  damageText(): string {
    if (this.state.bullDamaged) return 'BULL DMG';
    if (this.state.bearDamaged) return 'BEAR DMG';
    return 'CLEAN';
  }

  getRegime(): string {
    if (this.state.bullDamaged) return 'Bull Structure Compromised';
    if (this.state.bearDamaged) return 'Bear Structure Compromised';
    return this.stateText();
  }

  getCurrentState(): RCMState {
    return { ...this.state };
  }
}
