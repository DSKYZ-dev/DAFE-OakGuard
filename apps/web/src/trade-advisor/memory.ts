export interface MemoryEntry {
  id?: number;
  content: string;
  type: 'conversation' | 'note' | 'decision' | 'alert';
  agent: string;
  tags: string[];
  ts: number;
  score?: number;
}

const DB_NAME = 'dafe-trade-advisor';
const DB_VERSION = 1;
const STORE_NAME = 'memories';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('agent', 'agent', { unique: false });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class LocalMemory {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB();
    }
    return this.dbPromise;
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'ts'> & { ts?: number }): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.add({ ...entry, ts: entry.ts ?? Date.now() });
      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
  }

  async recall(query: string, k: number = 10): Promise<MemoryEntry[]> {
    const db = await this.getDB();
    const all = await this.getAll();
    const q = query.toLowerCase();

    const scored = all
      .map(entry => {
        const content = entry.content.toLowerCase();
        let score = 0;
        const words = q.split(/\s+/);
        for (const word of words) {
          if (word.length < 3) continue;
          if (content.includes(word)) score += 1;
        }
        return { ...entry, score };
      })
      .filter(e => e.score > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, k);

    return scored;
  }

  private async getAll(): Promise<MemoryEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as MemoryEntry[]);
      req.onerror = () => reject(req.error);
    });
  }

  async getByAgent(agent: string, limit: number = 50): Promise<MemoryEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('agent');
      const range = IDBKeyRange.only(agent);
      const req = index.getAll(range, limit);
      req.onsuccess = () => resolve(req.result as MemoryEntry[]);
      req.onerror = () => reject(req.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export class RemoteMemory {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8788') {
    this.baseUrl = baseUrl;
  }

  async store(content: string, type: string = 'note', agent: string = 'all', tags: string[] = []): Promise<number | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/chat/memory/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, type, agent, tags }),
      });
      const data = await resp.json();
      return data.ok ? data.id : null;
    } catch {
      return null;
    }
  }

  async recall(query: string, k: number = 5, memoryType?: string, agent?: string): Promise<MemoryEntry[]> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/chat/memory/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, k, type: memoryType, agent }),
      });
      const data = await resp.json();
      if (data.ok) {
        return data.results.map((r: any) => ({
          id: r.id,
          content: r.content,
          type: r.type as MemoryEntry['type'],
          agent: r.agent,
          tags: r.tags,
          ts: r.ts,
          score: r.score,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  async stats(): Promise<{ total: number; types: Record<string, number> } | null> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/chat/memory/stats`);
      const data = await resp.json();
      return data.ok ? { total: data.total_memories, types: data.types } : null;
    } catch {
      return null;
    }
  }
}
