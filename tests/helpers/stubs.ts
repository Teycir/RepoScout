// tests/helpers/stubs.ts
// In-process stubs for Cloudflare Worker runtime bindings.
// These let real application code run locally under Node.js / tsx
// without any Workers runtime dependency.

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dir      = dirname(__filename);

// ─── KV Namespace stub ────────────────────────────────────────────────────────

export class FakeKV implements KVNamespace {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(_opts?: unknown): Promise<KVNamespaceListResult<unknown, string>> {
    return { keys: [], list_complete: true, caches: { default: 'none' } } as any;
  }

  async getWithMetadata<M>(key: string): Promise<KVNamespaceGetWithMetadataResult<string, M>> {
    const value = this.store.get(key) ?? null;
    return { value, metadata: null as unknown as M, cacheStatus: null };
  }

  peek(key: string): string | undefined { return this.store.get(key); }
  clear(): void { this.store.clear(); }
}

// ─── D1 Database stub ─────────────────────────────────────────────────────────

function makeStatement(sqlite: Database.Database, query: string): D1PreparedStatement {
  let boundArgs: unknown[] = [];

  const stmt: any = {
    bind(...args: unknown[]): D1PreparedStatement {
      boundArgs = args;
      return stmt;
    },
    async first<T>(colName?: string): Promise<T | null> {
      try {
        const s = sqlite.prepare(query);
        const row = s.get(...(boundArgs as any[])) as T | undefined;
        if (!row) return null;
        if (colName) return (row as any)[colName] as T;
        return row as T;
      } catch (e) {
        throw new Error(`D1.first() — ${e}\nSQL: ${query}`);
      }
    },
    async all<T>(): Promise<D1Result<T>> {
      try {
        const s = sqlite.prepare(query);
        const results = s.all(...(boundArgs as any[])) as T[];
        return { results, success: true, meta: { changed_db: false, changes: 0, duration: 0, last_row_id: 0, rows_read: results.length, rows_written: 0, size_after: 0 } };
      } catch (e) {
        throw new Error(`D1.all() — ${e}\nSQL: ${query}`);
      }
    },
    async run(): Promise<D1Result<Record<string, unknown>>> {
      try {
        const s = sqlite.prepare(query);
        const info = s.run(...(boundArgs as any[]));
        return {
          results: [],
          success: true,
          meta: { changed_db: info.changes > 0, changes: info.changes, duration: 0, last_row_id: Number(info.lastInsertRowid), rows_read: 0, rows_written: info.changes, size_after: 0 },
        };
      } catch (e) {
        throw new Error(`D1.run() — ${e}\nSQL: ${query}`);
      }
    },
    _run(): Promise<D1Result<Record<string, unknown>>> { return stmt.run(); },
  };

  return stmt as D1PreparedStatement;
}

export function createTestDb(): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db: D1Database = {
    prepare(query: string) { return makeStatement(sqlite, query); },
    dump()  { return Promise.resolve(new ArrayBuffer(0)); },
    batch<T>(stmts: D1PreparedStatement[]) {
      return Promise.all(stmts.map(s => (s as any)._run() as Promise<D1Result<T>>));
    },
    exec(query: string) { sqlite.exec(query); return Promise.resolve({ count: 0, duration: 0 }); },
  };

  return { db, sqlite };
}

export function applySchema(sqlite: Database.Database): void {
  const s1 = readFileSync(join(__dir, '../../migrations/schema.sql'), 'utf8');
  sqlite.exec(s1);

  const s2path = join(__dir, '../../migrations/002_crawler.sql');
  if (existsSync(s2path)) {
    const stmts = readFileSync(s2path, 'utf8').split(';').map(s => s.trim()).filter(Boolean);
    for (const s of stmts) {
      try { sqlite.exec(s); } catch { /* already exists */ }
    }
  }
}

// Build a fully-migrated in-memory D1 database
export function makeDb(): { db: D1Database; sqlite: Database.Database } {
  const { db, sqlite } = createTestDb();
  applySchema(sqlite);
  return { db, sqlite };
}

// ─── Workers AI stub ─────────────────────────────────────────────────────────

export class FakeAI {
  nextResponse = JSON.stringify({
    verdict: 'NEEDS_HUMAN_REVIEW',
    reasoning: 'FakeAI stub — ambiguous match',
    confidence: 0.3,
  });

  async run(_model: string, input: { messages: { role: string; content: string }[] }): Promise<{ response: string }> {
    const lastMsg = input.messages[input.messages.length - 1]?.content ?? '';
    if (lastMsg.includes('access_granted')) {
      return { response: JSON.stringify({ access_granted: 'Full account access', blast_radius: 'All repositories', remediation: 'Revoke token immediately' }) };
    }
    if (lastMsg.includes('"found"')) {
      return { response: JSON.stringify({ found: false, value: null, reasoning: 'stub' }) };
    }
    return { response: this.nextResponse };
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

export interface TestEnv {
  DB: D1Database;
  CACHE: FakeKV;
  AI: FakeAI;
  [key: string]: unknown;
}

export function makeTestEnv(extraTokens: Record<string, string> = {}): TestEnv & { sqlite: Database.Database } {
  const { db, sqlite } = makeDb();
  return {
    DB: db,
    CACHE: new FakeKV(),
    AI: new FakeAI(),
    sqlite,
    ...extraTokens,
  };
}
