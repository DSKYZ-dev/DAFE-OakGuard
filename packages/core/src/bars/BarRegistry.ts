import type { BarTypeId } from '@dafe/types';
import type { BarEngine } from './BarEngine';

export class BarRegistry {
  private engines: Map<BarTypeId, BarEngine> = new Map();

  register(engine: BarEngine): void {
    this.engines.set(engine.id, engine);
  }

  unregister(id: BarTypeId): void {
    this.engines.delete(id);
  }

  get(id: BarTypeId): BarEngine | undefined {
    return this.engines.get(id);
  }

  getAll(): BarEngine[] {
    return Array.from(this.engines.values());
  }

  getIds(): BarTypeId[] {
    return Array.from(this.engines.keys());
  }
}
