import type { SharedBuffer as SharedBufferType } from '@dafe/types';

export class SharedBufferManager {
  private buffer: SharedBufferType | null = null;

  create(size: number = 1024 * 1024): SharedBufferType {
    const sab = new SharedArrayBuffer(size + 32);
    const buf: SharedBufferType = {
      buffer: sab,
      tickOffset: new Int32Array(sab, 0, 1),
      barOffset: new Int32Array(sab, 4, 1),
      writePointer: new Int32Array(sab, 8, 1),
      readPointer: new Int32Array(sab, 12, 1),
    };
    this.buffer = buf;
    return buf;
  }

  getBuffer(): SharedBufferType | null {
    return this.buffer;
  }

  write(data: Float32Array): void {
    if (!this.buffer) return;
    const offset = Atomics.add(this.buffer.writePointer, 0, data.length);
    const view = new Float32Array(this.buffer.buffer, 32 + offset * 4, data.length);
    view.set(data);
    Atomics.store(this.buffer.readPointer, 0, offset + data.length);
  }

  read(length: number): Float32Array | null {
    if (!this.buffer) return null;
    const readPos = Atomics.load(this.buffer.readPointer, 0);
    const writePos = Atomics.load(this.buffer.writePointer, 0);
    const available = writePos - readPos;
    if (available <= 0) return null;

    const actualLength = Math.min(length, available);
    const view = new Float32Array(this.buffer.buffer, 32 + readPos * 4, actualLength);
    Atomics.add(this.buffer.readPointer, 0, actualLength);
    return new Float32Array(view);
  }

  destroy(): void {
    this.buffer = null;
  }
}
