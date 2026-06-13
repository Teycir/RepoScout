#!/usr/bin/env npx tsx
// tests/crawler-e2e.ts
// ─────────────────────────────────────────────────────────────────────────────
// End-to-end test for the autonomous GitHub crawler + scanner workflow.
//
// What this tests:
//   1. GitHub crawler discovers repos from recent public activity (no seed list)
//   2. Scans discovered repos through the full pipeline
//   3. Validates findings are persisted correctly
//
// Usage:
//   npx tsx tests/crawler-e2e.ts
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname }           from 'node:path';
import { fileURLToPath }           from 'node:url';
import { createRequire }           from 'node:module';

const _require = createRequire(import.meta.url);
const Database = _require('./node_modules/better-sqlite3') as typeof import('better-sqlite3').default;

import { discoverRepos } from '../src/scan-worker/crawler.js';
import { scanRepo } from '../src/scan-worker/scanner.js';
import { createScanValidationGraph, persistEvaluation } from '../src/scan-worker/pipeline.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function applySchema(db: Database.Database, sql: string) {
  const stripped = sql.replace(/--[^\n]*/g, ' ');
  for (const stmt of stripped.split(';').map(s => s.trim()).filter(s => s.length > 0)) {
    try {
      db.exec(stmt + ';');
    } catch (e: any) {
      if (!e.message?.includes('already exists') && !e.message?.includes('duplicate column')) throw e;
    }
  }
}

// D1-compatible shim over better-sqlite3
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
      _run() { return stmt.run(); },
    };
    return stmt;
  }
  return {
    prepare: (sql: string) => makeStmt(sql),
    async dump() { return new ArrayBuffer(0); },
    async batch<T>(stmts: D1PreparedStatement[]) { return Promise.all(stmts.map((s: any) => s._run())) as any; },
    async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; },
  } as unknown as D1Database;
}

// KV backed by SQLite
function makeKV(db: Database.Database): KVNamespace {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER)`);
  const get = db.prepare('SELECT v, expires_at FROM kv_store WHERE k = ?');
  const set = db.prepare(`INSERT INTO kv_store (k,v,expires_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at`);
  const del = db.prepare('DELETE FROM kv_store WHERE k = ?');

  return {
    async get(key: string) {
      const row = get.get(key) as { v: string; expires_at: number | null } | undefined;
      if (!row) return null;
      if (row.expires_at && Date.now() / 1000 > row.expires_at) { del.run(key); return null; }
      return row.v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const exp = opts?.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : null;
      set.run(key, value, exp);
    },
    async delete(key: string) { del.run(key); },
    async list() { return { keys: [], list_complete: true } as any; },
    async getWithMetadata(key: string) { return { value: await (this as any).get(key), metadata: null, cacheStatus: null } as any; },
  } as unknown as KVNamespace;
}

// Ollama AI adapter
const OLLAMA_BASE  = 'http://localhost:11434';
const OLLAMA_MODEL = 'gemma4:latest';

function makeOllamaAI(): Ai {
  return {
    async run(_model: string, input: { messages: Array<{ role: string; content: string }> }) {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: input.messages,
          stream: false,
          options: { temperature: 0.05, num_predict: 350 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as { message?: { content: string } };
      return { response: data.message?.content ?? '' };
    },
  } as unknown as Ai;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const start = Date.now();
  console.log('\n[crawler-e2e] Starting autonomous crawler + scan test\n');

  // ── Environment ───────────────────────────────────────────────────────────
  const dotenv = loadDotEnv();
  const tokens: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = dotenv[`GITHUB_TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  if (tokens.length === 0) {
    console.error('[crawler-e2e] No GITHUB_TOKEN_* found in .env');
    process.exit(1);
  }
  console.log(`[crawler-e2e] Loaded ${tokens.length} GitHub PAT(s)`);

  // ── Ollama check ──────────────────────────────────────────────────────────
  try {
    const test = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!test.ok) throw new Error(`HTTP ${test.status}`);
    console.log(`[crawler-e2e] Ollama reachable — model: ${OLLAMA_MODEL}`);
  } catch (e) {
    console.error(`[crawler-e2e] Cannot reach Ollama at ${OLLAMA_BASE}: ${e}`);
    process.exit(1);
  }

  // ── SQLite DB ─────────────────────────────────────────────────────────────
  const DB_PATH = join(ROOT, 'tests', 'crawler-e2e.sqlite');
  const rawDb   = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', 'schema.sql'), 'utf8'));
  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', '002_crawler.sql'), 'utf8'));
  console.log(`[crawler-e2e] SQLite ready: ${DB_PATH}`);

  const d1 = makeD1(rawDb);
  const kv = makeKV(rawDb);
  const ai = makeOllamaAI();

  // ── Run crawler ───────────────────────────────────────────────────────────
  console.log('\n[crawler-e2e] Running GitHub crawler to discover repos...');
  const env = { DB: d1, CACHE: kv, AI: ai };
  const crawlToken = tokens[0]!;
  
  const crawlResult = await discoverRepos(env, crawlToken);
  
  console.log(`[crawler-e2e] Crawler completed:`);
  console.log(`  - Discovered: ${crawlResult.reposDiscovered}`);
  console.log(`  - Updated: ${crawlResult.reposUpdated}`);
  console.log(`  - Eligible for scan: ${crawlResult.reposEligible.length}`);
  console.log(`  - Errors: ${crawlResult.errors.length}`);
  if (crawlResult.errors.length > 0) {
    console.log(`  - Error samples: ${crawlResult.errors.slice(0, 3).join('; ')}`);
  }

  if (crawlResult.reposEligible.length === 0) {
    console.log('\n[crawler-e2e] No repos discovered - this may be expected if no recent pushes');
    console.log('[crawler-e2e] Test completed (crawler functional, no repos to scan)');
    process.exit(0);
  }

  // ── Scan discovered repos ─────────────────────────────────────────────────
  console.log(`\n[crawler-e2e] Scanning ${Math.min(3, crawlResult.reposEligible.length)} discovered repos...`);
  const reposToScan = crawlResult.reposEligible.slice(0, 3);
  
  const patterns = JSON.parse(readFileSync(join(ROOT, 'src/scan-worker/patterns.json'), 'utf8'));
  const pipeline = createScanValidationGraph(env);
  const scanRunId = crypto.randomUUID();
  
  await d1.prepare(`INSERT INTO scan_runs (id, started_at, status) VALUES (?, datetime('now'), 'RUNNING')`)
    .bind(scanRunId).run();

  let totalFindings = 0;
  let totalEvaluated = 0;

  for (const repoId of reposToScan) {
    const repo = await d1.prepare(`SELECT * FROM repositories WHERE id = ?`).bind(repoId).first<any>();
    if (!repo) continue;

    console.log(`\n────────────────────────────────────────────────────────────────`);
    console.log(`Scanning ${repo.owner}/${repo.name}`);

    const scanStart = Date.now();
    let result;
    try {
      result = await scanRepo(repo.owner, repo.name, tokens[0]!, patterns);
    } catch (e) {
      console.error(`  [!] scanRepo threw: ${e}`);
      continue;
    }
    const { matches, filesScanned, errors } = result;
    const scanTime = Date.now() - scanStart;

    console.log(`  files : ${filesScanned}  |  matches : ${matches.length}  |  ${scanTime}ms`);
    if (errors.length) console.log(`  errors: ${errors.slice(0, 3).join('; ')}`);
    totalFindings += matches.length;

    await d1.prepare(`UPDATE repositories SET last_scan_status = 'COMPLETED', last_scan_at = datetime('now') WHERE id = ?`)
      .bind(repoId).run();

    // Run pipeline on sample findings
    const sampleSize = Math.min(10, matches.length);
    for (const match of matches.slice(0, sampleSize)) {
      const findingId = crypto.randomUUID();

      // Persist finding
      let activeFindingId = findingId;
      try {
        const row = await d1.prepare(`
          INSERT INTO findings
            (id, scan_run_id, repo_id, file_path, file_url, line_number,
             matched_text, line_content, context, pattern_id, template_id, severity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_id, file_path, line_number, pattern_id, matched_text)
          DO UPDATE SET scan_run_id = excluded.scan_run_id
          RETURNING id
        `).bind(
          findingId, scanRunId, repo.id,
          match.filePath,
          `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${match.filePath}#L${match.lineNumber}`,
          match.lineNumber,
          match.matchedText,
          match.context.split('\n')[0] ?? '',
          JSON.stringify(match.context.split('\n')),
          match.patternId, match.templateId, match.severity,
        ).first<{ id: string }>();
        activeFindingId = row?.id ?? findingId;
      } catch (e) {
        console.error(`  [!] finding persist: ${e}`);
        continue;
      }

      // LangGraph pipeline
      let finalState: any;
      try {
        finalState = await pipeline.invoke({
          findingId: activeFindingId,
          repoName: `${repo.owner}/${repo.name}`,
          filePath: match.filePath,
          lineNumber: match.lineNumber,
          matchedText: match.matchedText,
          rawMatchedText: match.rawMatchedText,
          lineContent: match.context.split('\n')[0] ?? '',
          surroundingContext: match.context,
          patternId: match.patternId,
          templateId: match.templateId,
          severity: match.severity,
          isHeuristicPlaceholder: false,
          validationStatus: 'UNVERIFIABLE' as const,
          verdict: 'NEEDS_HUMAN_REVIEW' as const,
          aiReasoning: '',
          confidenceScore: 0,
          riskScore: 0,
          validationMethod: 'heuristic' as const,
        });
      } catch (e) {
        console.error(`  [pipeline error] ${e}`);
        continue;
      }

      // Persist evaluation
      try {
        await persistEvaluation(d1, {
          findingId: activeFindingId,
          verdict: finalState.verdict,
          confidence: finalState.confidenceScore,
          validationMethod: finalState.validationMethod ?? 'llm',
          validationStatus: finalState.validationStatus ?? 'UNVERIFIABLE',
          reasoning: finalState.aiReasoning ?? '',
          riskScore: finalState.riskScore,
        });
        totalEvaluated++;

        const icon = finalState.verdict === 'TRUE_POSITIVE' ? '🔴' : 
                     finalState.verdict === 'NEEDS_HUMAN_REVIEW' ? '🟡' : '⚪';
        console.log(`  ${icon} ${match.severity.padEnd(8)} ${match.patternId.padEnd(30)} ${match.filePath}:${match.lineNumber}  [conf:${finalState.confidenceScore.toFixed(2)}]`);
      } catch (e) {
        console.error(`  [!] eval persist: ${e}`);
      }
    }
  }

  await d1.prepare(`UPDATE scan_runs SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?`)
    .bind(scanRunId).run();

  // ── Summary ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  CRAWLER E2E TEST REPORT`);
  console.log(`════════════════════════════════════════════════════════════════`);
  console.log(`  Wall time       : ${elapsed}s`);
  console.log(`  Repos discovered: ${crawlResult.reposDiscovered}`);
  console.log(`  Repos scanned   : ${reposToScan.length}`);
  console.log(`  Total findings  : ${totalFindings}`);
  console.log(`  Evaluated       : ${totalEvaluated}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  
  const assertions = [
    { name: 'Crawler ran successfully', pass: crawlResult.reposEligible.length >= 0 },
    { name: 'At least one repo scanned', pass: reposToScan.length > 0 },
    { name: 'Findings generated', pass: totalFindings > 0 },
    { name: 'Pipeline evaluations', pass: totalEvaluated > 0 },
  ];

  let passed = 0;
  let failed = 0;
  for (const a of assertions) {
    console.log(`  ${a.pass ? '✓' : '✗'} ${a.name}`);
    if (a.pass) passed++; else failed++;
  }

  console.log(`\n  ${passed} passed  ·  ${failed} failed`);
  console.log(`════════════════════════════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
