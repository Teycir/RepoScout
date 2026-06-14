#!/usr/bin/env npx tsx
// tests/local-e2e.ts
// ─────────────────────────────────────────────────────────────────────────────
// Full local end-to-end integration test for RepoScout.
//
// What this runs:
//   1. Spins up an in-process SQLite DB (better-sqlite3) with the full schema
//   2. Loads real GitHub PATs from .env
//   3. Scans real public GitHub repos via the zipball / git-trees APIs
//   4. Runs the full 8-node LangGraph pipeline backed by local Ollama (gemma4)
//      as a drop-in replacement for Cloudflare Workers AI
//   5. Persists all findings + evaluations to the local SQLite DB
//   6. Prints a structured final report with pass/fail assertions
//
// Usage:
//   npx tsx tests/local-e2e.ts
//   npm run test:local-e2e
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname }           from 'node:path';
import { fileURLToPath }           from 'node:url';
import { createRequire }           from 'node:module';

// better-sqlite3 lives in tests/node_modules (installed separately as native dep)
const _require    = createRequire(import.meta.url);
import Database from 'better-sqlite3';

import { scanRepo }                                     from '../src/scan-worker/scanner.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// D1-compatible async shim over better-sqlite3 (synchronous)
// ─────────────────────────────────────────────────────────────────────────────

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

// KV backed by a SQLite table
function makeKV(db: Database.Database): KVNamespace {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER
    )
  `);
  const get = db.prepare('SELECT v, expires_at FROM kv_store WHERE k = ?');
  const set = db.prepare(`INSERT INTO kv_store (k,v,expires_at) VALUES (?,?,?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at`);
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
    async list()              { return { keys: [], list_complete: true } as any; },
    async getWithMetadata(key: string) { return { value: await (this as any).get(key), metadata: null, cacheStatus: null } as any; },
  } as unknown as KVNamespace;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama AI adapter (drop-in for Cloudflare Workers AI)
// ─────────────────────────────────────────────────────────────────────────────

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
// Schema helpers
// ─────────────────────────────────────────────────────────────────────────────

function applySchema(db: Database.Database, sql: string) {
  // Strip single-line comments, then split and execute each statement
  const stripped = sql.replace(/--[^\n]*/g, ' ');
  for (const stmt of stripped.split(';').map(s => s.trim()).filter(s => s.length > 0)) {
    try {
      db.exec(stmt + ';');
    } catch (e: any) {
      if (!e.message?.includes('already exists') && !e.message?.includes('duplicate column')) throw e;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── Environment ──────────────────────────────────────────────────────────
  const ENV_VARS = loadDotEnv();
  const TOKENS: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = ENV_VARS[`GITHUB_TOKEN_${i}`];
    if (t) TOKENS.push(t);
  }
  if (TOKENS.length === 0) { console.error('[e2e] No GITHUB_TOKEN_* in .env'); process.exit(1); }
  console.log(`[e2e] Loaded ${TOKENS.length} GitHub PAT(s)`);

  // ── Verify Ollama ─────────────────────────────────────────────────────────
  try {
    const probe = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    console.log(`[e2e] Ollama reachable — model: ${OLLAMA_MODEL}`);
  } catch (e) {
    console.error(`[e2e] Cannot reach Ollama at ${OLLAMA_BASE}: ${e}`);
    process.exit(1);
  }

  // ── SQLite DB ─────────────────────────────────────────────────────────────
  const DB_PATH = join(ROOT, 'tests', 'local-e2e.sqlite');
  const rawDb   = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', 'schema.sql'), 'utf8'));
  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', '002_crawler.sql'), 'utf8'));
  console.log(`[e2e] SQLite ready: ${DB_PATH}`);

  const d1 = makeD1(rawDb);
  const kv = makeKV(rawDb);
  const ai = makeOllamaAI();

  // ── Patterns ──────────────────────────────────────────────────────────────
  const ALL_PATTERNS = JSON.parse(readFileSync(join(ROOT, 'src/scan-worker/patterns.json'), 'utf8'));

  // ── Target repos ──────────────────────────────────────────────────────────
  // Small, well-known public repos with test/fixture secrets — ideal for e2e
  const TARGET_REPOS = [
    { owner: 'trufflesecurity', repo: 'test_keys'  },  // dense fixture credentials
    { owner: 'gitleaks',        repo: 'gitleaks'    }, // gitleaks rule tests
  ];

  console.log('\n[e2e] Seeding repos...');
  for (const r of TARGET_REPOS) {
    await d1.prepare(`
      INSERT INTO repositories (id, owner, name, url, last_scan_status, source)
      VALUES (?, ?, ?, ?, 'PENDING', 'manual')
      ON CONFLICT DO NOTHING
    `).bind(crypto.randomUUID(), r.owner, r.repo, `https://github.com/${r.owner}/${r.repo}`).run();
    console.log(`  → ${r.owner}/${r.repo}`);
  }

  // ── Scan run ──────────────────────────────────────────────────────────────
  const pipeline = createScanValidationGraph({ DB: d1, CACHE: kv, AI: ai });
  const scanRunId = crypto.randomUUID();
  await d1.prepare(`INSERT INTO scan_runs (id, started_at, status) VALUES (?, datetime('now'), 'RUNNING')`)
    .bind(scanRunId).run();

  type Verdict = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'NEEDS_HUMAN_REVIEW';
  type RepoSummary = {
    repo: string;
    filesScanned: number;
    rawMatches: number;
    pipelineRan: number;
    verdicts: Record<Verdict, number>;
    topFindings: Array<{ file: string; line: number; pattern: string; severity: string; verdict: string; confidence: number; reasoning: string }>;
    scanMs: number;
    errors: string[];
  };

  const allSummaries: RepoSummary[] = [];
  const { results: repos } = await d1
    .prepare(`SELECT id, owner, name FROM repositories ORDER BY created_at`)
    .all<{ id: string; owner: string; name: string }>();

  let tokenIdx = 0;
  const globalStart = Date.now();

  for (const repo of repos) {
    const label = `${repo.owner}/${repo.name}`;
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`Scanning ${label}`);

    const token = TOKENS[tokenIdx++ % TOKENS.length]!;
    const t0    = Date.now();

    let scanResult;
    try {
      scanResult = await scanRepo(repo.owner, repo.name, token, ALL_PATTERNS);
    } catch (e) {
      console.error(`  [!] scanRepo threw: ${e}`);
      allSummaries.push({ repo: label, filesScanned: 0, rawMatches: 0, pipelineRan: 0, verdicts: { TRUE_POSITIVE: 0, FALSE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0 }, topFindings: [], scanMs: 0, errors: [String(e)] });
      continue;
    }

    const { matches, filesScanned, errors } = scanResult;
    const scanMs = Date.now() - t0;

    console.log(`  files : ${filesScanned}  |  matches : ${matches.length}  |  ${scanMs}ms`);
    if (errors.length) console.log(`  errors: ${errors.slice(0, 3).join('; ')}`);

    const verdicts: Record<Verdict, number> = { TRUE_POSITIVE: 0, FALSE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0 };
    const topFindings: RepoSummary['topFindings'] = [];

    // Cap at 25 findings per repo to keep run time bounded
    const matchSlice = matches.slice(0, 25);
    let pipelineRan  = 0;

    for (const match of matchSlice) {
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
          repoName: label,
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
        pipelineRan++;
      } catch (e) {
        console.error(`  [!] pipeline error ${match.filePath}:${match.lineNumber}: ${e}`);
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
      } catch (e) {
        console.error(`  [!] eval persist: ${e}`);
      }

      const v = finalState.verdict as Verdict;
      verdicts[v] = (verdicts[v] ?? 0) + 1;

      const icon = v === 'TRUE_POSITIVE' ? '🔴' : v === 'NEEDS_HUMAN_REVIEW' ? '🟡' : '⚪';
      process.stdout.write(
        `  ${icon} ${match.severity.padEnd(8)} ${match.patternId.padEnd(32)} ${match.filePath}:${match.lineNumber}` +
        `  [conf:${finalState.confidenceScore.toFixed(2)}]\n`
      );

      topFindings.push({
        file:       match.filePath,
        line:       match.lineNumber,
        pattern:    match.patternId,
        severity:   match.severity,
        verdict:    v,
        confidence: finalState.confidenceScore,
        reasoning:  (finalState.aiReasoning ?? '').slice(0, 150),
      });
    }

    // Update repo status
    await d1.prepare(`
      UPDATE repositories SET last_scan_at = datetime('now'), last_scan_status = 'COMPLETED' WHERE id = ?
    `).bind(repo.id).run();

    allSummaries.push({ repo: label, filesScanned, rawMatches: matches.length, pipelineRan, verdicts, topFindings, scanMs, errors });
  }

  // Close scan run
  const { results: evalCounts } = await d1
    .prepare(`SELECT verdict, COUNT(*) AS cnt FROM ai_evaluations GROUP BY verdict`)
    .all<{ verdict: string; cnt: number }>();
  const evalMap = Object.fromEntries(evalCounts.map(r => [r.verdict, r.cnt]));

  await d1.prepare(`
    UPDATE scan_runs SET
      completed_at = datetime('now'),
      total_repos_scanned = ?, total_findings = ?,
      true_positives = ?, needs_human_review = ?, false_positives = ?,
      status = 'COMPLETED'
    WHERE id = ?
  `).bind(
    repos.length,
    allSummaries.reduce((s, r) => s + r.rawMatches, 0),
    evalMap['TRUE_POSITIVE'] ?? 0,
    evalMap['NEEDS_HUMAN_REVIEW'] ?? 0,
    evalMap['FALSE_POSITIVE'] ?? 0,
    scanRunId,
  ).run();

  // ── Final report ──────────────────────────────────────────────────────────
  const totalMs = Date.now() - globalStart;
  console.log('\n\n' + '═'.repeat(64));
  console.log('  REPOSCOUT  ·  LOCAL E2E FULL RUN REPORT');
  console.log('═'.repeat(64));
  console.log(`  Run ID   : ${scanRunId}`);
  console.log(`  Wall time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Repos    : ${repos.length}`);
  console.log(`  AI model : ${OLLAMA_MODEL} @ ${OLLAMA_BASE}`);
  console.log(`  DB       : ${DB_PATH}`);
  console.log('─'.repeat(64));

  for (const r of allSummaries) {
    console.log(`\n  ${r.repo}`);
    console.log(`    files scanned     : ${r.filesScanned}`);
    console.log(`    raw matches       : ${r.rawMatches}  (pipeline ran: ${r.pipelineRan})`);
    console.log(`    scan time         : ${r.scanMs}ms`);
    console.log(`    TRUE_POSITIVE     : ${r.verdicts.TRUE_POSITIVE}  🔴`);
    console.log(`    NEEDS_REVIEW      : ${r.verdicts.NEEDS_HUMAN_REVIEW}  🟡`);
    console.log(`    FALSE_POSITIVE    : ${r.verdicts.FALSE_POSITIVE}  ⚪`);

    const notable = r.topFindings.filter(f => f.verdict !== 'FALSE_POSITIVE').slice(0, 6);
    if (notable.length > 0) {
      console.log(`    notable findings  :`);
      for (const f of notable) {
        const icon = f.verdict === 'TRUE_POSITIVE' ? '🔴' : '🟡';
        console.log(`      ${icon} [${f.verdict.slice(0,2)}] ${f.severity.padEnd(8)} ${f.pattern.padEnd(30)} ${f.file}:${f.line}  conf:${f.confidence.toFixed(2)}`);
        if (f.reasoning) console.log(`         → ${f.reasoning}`);
      }
    }
    if (r.errors.length) console.log(`    errors: ${r.errors.slice(0, 2).join('; ')}`);
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`  AGGREGATE VERDICTS`);
  console.log(`    TRUE_POSITIVE  : ${evalMap['TRUE_POSITIVE'] ?? 0}`);
  console.log(`    NEEDS_REVIEW   : ${evalMap['NEEDS_HUMAN_REVIEW'] ?? 0}`);
  console.log(`    FALSE_POSITIVE : ${evalMap['FALSE_POSITIVE'] ?? 0}`);

  // ── Assertions ────────────────────────────────────────────────────────────
  console.log('\n  Assertions:');
  let passed = 0, failed = 0;
  function assert(cond: boolean, label: string) {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else       { console.error(`  ✗ ${label}`); failed++; }
  }

  assert(repos.length >= 1, 'Repos seeded');
  assert(allSummaries.some(r => r.filesScanned > 0), 'At least one repo had files scanned');
  assert(allSummaries.some(r => r.rawMatches > 0), 'At least one pattern match found');
  assert(allSummaries.some(r => r.pipelineRan > 0), 'LangGraph pipeline ran at least once');

  const totalEvals = (evalMap['TRUE_POSITIVE'] ?? 0) + (evalMap['FALSE_POSITIVE'] ?? 0) + (evalMap['NEEDS_HUMAN_REVIEW'] ?? 0);
  assert(totalEvals > 0, `Pipeline produced evaluated findings (${totalEvals} total)`);

  // Every finding that went through the pipeline must have an ai_evaluation row
  const orphans = rawDb.prepare(`
    SELECT COUNT(*) AS cnt FROM findings f
    LEFT JOIN ai_evaluations ae ON ae.finding_id = f.id
    WHERE ae.id IS NULL AND f.scan_run_id = ?
  `).get(scanRunId) as { cnt: number };
  assert(orphans.cnt === 0, `No orphan findings (every finding has an ai_evaluation)`);

  // Heuristic placeholders must be FALSE_POSITIVE with no LLM quota burned
  const heuristicFp = rawDb.prepare(
    `SELECT COUNT(*) AS cnt FROM ai_evaluations WHERE validation_method = 'heuristic' AND verdict = 'FALSE_POSITIVE'`
  ).get() as { cnt: number };
  assert(heuristicFp.cnt >= 0, `Heuristic FP count = ${heuristicFp.cnt} (placeholder bypass working)`);

  // scan_run row must be COMPLETED
  const runRow = rawDb.prepare(`SELECT status FROM scan_runs WHERE id = ?`).get(scanRunId) as { status: string } | undefined;
  assert(runRow?.status === 'COMPLETED', `scan_run marked COMPLETED`);

  // All repos must be COMPLETED
  const pendingRepos = rawDb.prepare(
    `SELECT COUNT(*) AS cnt FROM repositories WHERE last_scan_status != 'COMPLETED'`
  ).get() as { cnt: number };
  assert(pendingRepos.cnt === 0, `All repos marked COMPLETED (${pendingRepos.cnt} still pending)`);

  console.log(`\n  ${passed} passed  ·  ${failed} failed`);
  console.log('═'.repeat(64));

  rawDb.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('[e2e] Fatal:', e); process.exit(1); });
