import type { Tick } from '@dafe/types';

export class TickStream {
  private ticks: Tick[] = [];
  private maxLength: number;
  private listeners: Array<(tick: Tick) => void> = [];

  constructor(maxLength: number = 100000) {
    this.maxLength = maxLength;
  }

  push(tick: Tick): void {
    this.ticks.push(tick);
    if (this.ticks.length > this.maxLength) {
      this.ticks.shift();
    }
    for (const listener of this.listeners) {
      listener(tick);
    }
  }

  pushBatch(ticks: Tick[]): void {
    for (const tick of ticks) {
      this.push(tick);
    }
  }

  getTicks(): Tick[] {
    return this.ticks;
  }

  getRecent(count: number): Tick[] {
    return this.ticks.slice(-count);
  }

  clear(): void {
    this.ticks = [];
  }

  get length(): number {
    return this.ticks.length;
  }

  onTick(listener: (tick: Tick) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}
