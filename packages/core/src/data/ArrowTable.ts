import type { ArrowTable as ArrowTableType } from '@dafe/types';

export class ArrowTable {
  private table: ArrowTableType = {
    schema: {},
    data: {},
    length: 0,
  };

  addColumn(name: string, type: ArrowTableType['schema'][string], data: Float32Array | Int32Array | Uint32Array): void {
    this.table.schema[name] = type;
    this.table.data[name] = data;
    this.table.length = data.length;
  }

  getColumn(name: string): Float32Array | Int32Array | Uint32Array | Float64Array | BigUint64Array | undefined {
    return this.table.data[name];
  }

  getRow(index: number): Record<string, number> | null {
    if (index >= this.table.length) return null;
    const row: Record<string, number> = {};
    for (const [name, data] of Object.entries(this.table.data)) {
      row[name] = data[index] as number;
    }
    return row;
  }

  toArrowIPC(): ArrayBuffer {
    const rowCount = this.table.length;
    const columnCount = Object.keys(this.table.schema).length;

    const headerSize = 8 + 4 + 4;
    let dataSize = 0;
    for (const data of Object.values(this.table.data)) {
      dataSize += data.byteLength;
    }

    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);
    view.setBigUint64(0, BigInt(rowCount), true);
    view.setUint32(8, columnCount, true);

    let offset = headerSize;
    for (const data of Object.values(this.table.data)) {
      const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const dst = new Uint8Array(buffer, offset, data.byteLength);
      dst.set(src);
      offset += data.byteLength;
    }

    return buffer;
  }

  getSchema(): ArrowTableType['schema'] {
    return { ...this.table.schema };
  }

  get length(): number {
    return this.table.length;
  }

  clear(): void {
    this.table = { schema: {}, data: {}, length: 0 };
  }
}
