#!/usr/bin/env npx tsx
// tests/crawler-window-optimizer.ts
// Find optimal time window for repo discovery (volume vs rate limits)

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const Database = _require('./node_modules/better-sqlite3') as typeof import('better-sqlite3').default;

import { discoverRepos } from '../src/scan-worker/crawler.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

function loadDotEnv(): Record<string, string> {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function makeD1(db: Database.Database): D1Database {
  function makeStmt(sql: string): D1PreparedStatement {
    let params: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { params = args; return stmt; },
      async run() {
        const info = db.prepare(sql).run(...(params as any[]));
        return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 } };
      },
      async first<T>() { return (db.prepare(sql).get(...(params as any[])) as T) ?? null; },
      async all<T>() { return { results: db.prepare(sql).all(...(params as any[])) as T[], success: true, meta: {} }; },
    };
    return stmt;
  }
  return { prepare: (sql: string) => makeStmt(sql), async dump() { return new ArrayBuffer(0); }, async batch<T>(stmts: D1PreparedStatement[]) { return Promise.all(stmts.map((s: any) => s.run())) as any; }, async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; } } as unknown as D1Database;
}

function makeKV(db: Database.Database): KVNamespace {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  const get = db.prepare('SELECT v FROM kv_store WHERE k = ?');
  const set = db.prepare(`INSERT INTO kv_store (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
  return { async get(key: string) { const row = get.get(key) as { v: string } | undefined; return row?.v || null; }, async put(key: string, value: string) { set.run(key, value); }, async delete() {}, async list() { return { keys: [], list_complete: true, cacheStatus: null }; }, async getWithMetadata() { return { value: null, metadata: null, cacheStatus: null }; } } as KVNamespace;
}

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Crawler Window Optimization');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const rawEnv = loadDotEnv();
  const pats = Object.entries(rawEnv).filter(([k]) => k.startsWith('GITHUB_TOKEN_')).map(([, v]) => v);
  if (!pats.length) { console.error('❌ No GitHub PATs'); process.exit(1); }
  console.log(`✓ ${pats.length} PATs loaded\n`);

  const dbPath = join(__dir, 'window-opt.sqlite');
  const sqliteDb = new Database(dbPath);
  for (const file of ['schema.sql', '002_crawler.sql']) {
    const path = join(ROOT, 'migrations', file);
    if (existsSync(path)) sqliteDb.exec(readFileSync(path, 'utf8'));
  }
  
  const DB = makeD1(sqliteDb);
  const CACHE = makeKV(sqliteDb);

  const windows = [1, 6, 12, 24, 48, 72];
  const results: Array<{ hours: number; discovered: number; updated: number; duration: number; errors: number }> = [];

  for (const hours of windows) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    await CACHE.put('crawler:since', since);

    console.log(`Testing ${hours}h window...`);
    const start = Date.now();
    const result = await discoverRepos({ DB, CACHE }, pats[0]);
    const duration = Date.now() - start;

    const total = result.reposDiscovered + result.reposUpdated;
    console.log(`  Found: ${total} repos (${result.reposDiscovered} new, ${result.reposUpdated} updated) in ${duration}ms`);
    if (result.errors.length) console.log(`  Errors: ${result.errors.length}`);

    results.push({ hours, discovered: result.reposDiscovered, updated: result.reposUpdated, duration, errors: result.errors.length });
    await DB.prepare('DELETE FROM repositories').run();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('Window | Total | New | Updated | Duration | Errors');
  console.log('-------|-------|-----|---------|----------|-------');
  
  for (const r of results) {
    const total = r.discovered + r.updated;
    console.log(`${r.hours.toString().padStart(4)}h  | ${total.toString().padStart(5)} | ${r.discovered.toString().padStart(3)} | ${r.updated.toString().padStart(7)} | ${r.duration.toString().padStart(7)}ms | ${r.errors}`);
  }

  const valid = results.filter(r => r.errors === 0);
  if (!valid.length) { console.log('\n❌ All windows had errors'); process.exit(1); }

  const optimal = valid.reduce((best, curr) => {
    const currTotal = curr.discovered + curr.updated;
    const bestTotal = best.discovered + best.updated;
    if (currTotal >= 50 && currTotal <= 150) {
      if (bestTotal < 50 || bestTotal > 150) return curr;
      return curr.hours < best.hours ? curr : best;
    }
    return Math.abs(currTotal - 100) < Math.abs(bestTotal - 100) ? curr : best;
  });

  const optTotal = optimal.discovered + optimal.updated;

  console.log('\n📊 RECOMMENDATION:\n');
  console.log(`  Optimal: ${optimal.hours}h window`);
  console.log(`  Volume:  ${optTotal} repos/run`);
  console.log(`  Rate:    ${(optTotal / (optimal.duration / 1000)).toFixed(1)} repos/sec`);

  if (optTotal === 0) {
    console.log('\n  ❌ TEST FAILED: No repos found in any window');
    console.log('     The crawler may not be working or PATs lack permissions');
    console.log('     Try windows up to 7 days to validate functionality');
    process.exit(1);
  } else if (optTotal < 50) {
    console.log(`\n  ℹ️  Low volume - consider ${Math.max(...results.map(r => r.hours))}h`);
  } else if (optTotal > 150) {
    console.log('\n  ⚠️  High volume - may hit 150 repo limit');
  } else {
    console.log('\n  ✅ Optimal balance (50-150 repos)');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main();
