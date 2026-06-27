export interface CrosshairState {
  visible: boolean;
  x: number;
  y: number;
  price: number;
  timestamp: number;
}

export class Crosshair {
  private state: CrosshairState = { visible: false, x: 0, y: 0, price: 0, timestamp: 0 };
  private listeners: Array<(state: CrosshairState) => void> = [];

  show(x: number, y: number, price: number, timestamp: number): void {
    this.state = { visible: true, x, y, price, timestamp };
    this.notify();
  }

  hide(): void {
    this.state.visible = false;
    this.notify();
  }

  getState(): CrosshairState {
    return { ...this.state };
  }

  onChange(cb: (state: CrosshairState) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
