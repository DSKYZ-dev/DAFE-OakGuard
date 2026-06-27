import type { Tick, WebSocketMessage } from '@dafe/types';

export class WebSocketProvider {
  private ws: WebSocket | null = null;
  private url: string;
  private onTick: ((tick: Tick) => void) | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(url: string) {
    this.url = url;
  }

  connect(symbols: string[]): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.subscribe(symbols);
    };
    this.ws.onmessage = (event) => {
      const msg: WebSocketMessage = JSON.parse(event.data);
      if (msg.type === 'trade' && this.onTick) {
        this.onTick(msg.data as Tick);
      }
    };
    this.ws.onclose = () => this.handleReconnect(symbols);
    this.ws.onerror = () => this.ws?.close();
  }

  private subscribe(symbols: string[]): void {
    this.ws?.send(JSON.stringify({
      type: 'subscribe',
      symbols,
    }));
  }

  private handleReconnect(symbols: string[]): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    setTimeout(() => this.connect(symbols), 1000 * Math.min(this.reconnectAttempts, 10));
  }

  onTickCallback(cb: (tick: Tick) => void): void {
    this.onTick = cb;
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
