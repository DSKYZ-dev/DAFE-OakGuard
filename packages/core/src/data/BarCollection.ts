import type { BaseBar } from '@dafe/types';

export class BarCollection {
  private bars: Map<string, BaseBar[]> = new Map();
  private listeners: Array<(bars: BaseBar[], symbol: string) => void> = [];

  setBars(symbol: string, bars: BaseBar[]): void {
    this.bars.set(symbol, bars);
    for (const listener of this.listeners) {
      listener(bars, symbol);
    }
  }

  appendBar(symbol: string, bar: BaseBar): void {
    const existing = this.bars.get(symbol) || [];
    const lastBar = existing[existing.length - 1];
    if (lastBar && lastBar.timestamp === bar.timestamp) {
      existing[existing.length - 1] = bar;
    } else {
      existing.push(bar);
    }
    this.bars.set(symbol, existing);
  }

  getBars(symbol: string): BaseBar[] {
    return this.bars.get(symbol) || [];
  }

  getLastBar(symbol: string): BaseBar | undefined {
    const bars = this.bars.get(symbol);
    return bars?.[bars.length - 1];
  }

  getAllSymbols(): string[] {
    return Array.from(this.bars.keys());
  }

  clear(symbol?: string): void {
    if (symbol) this.bars.delete(symbol);
    else this.bars.clear();
  }

  onChange(listener: (bars: BaseBar[], symbol: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}
