import type { BaseBar, Tick } from '@dafe/types';

interface PythonComputeRequest {
  id: string;
  method: string;
  bars?: BaseBar[];
  ticks?: Tick[];
  params: Record<string, unknown>;
}

interface PythonComputeResponse {
  id: string;
  success: boolean;
  data?: Float64Array;
  error?: string;
}

export class PythonBridge {
  private worker: Worker | null = null;
  private pending: Map<string, { resolve: (v: Float64Array) => void; reject: (e: Error) => void }> = new Map();
  private counter = 0;

  async connect(workerUrl: string = '/python-bridge-worker.js'): Promise<void> {
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (event: MessageEvent<PythonComputeResponse>) => {
      const { id, success, data, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (success && data) pending.resolve(data);
      else pending.reject(new Error(error || 'Python compute failed'));
    };
  }

  async compute(
    method: string,
    bars: BaseBar[],
    params: Record<string, unknown> = {},
  ): Promise<Float64Array> {
    if (!this.worker) throw new Error('Python bridge not connected');

    const id = `py_${this.counter++}_${Date.now()}`;
    const request: PythonComputeRequest = { id, method, bars, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage(request);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('Python compute timed out'));
        }
      }, 30000);
    });
  }

  async disconnect(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, { reject }] of this.pending) {
      reject(new Error('Python bridge disconnected'));
      this.pending.delete(id);
    }
  }
}
