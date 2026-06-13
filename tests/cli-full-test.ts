#!/usr/bin/env npx tsx
// tests/cli-full-test.ts
// ─────────────────────────────────────────────────────────────────────────────
// End-to-end CLI validation test:
//
//   Phase 1  — GitHub Search crawl (last 24 hours of public pushes)
//   Phase 2  — For each discovered repo, fetch the last 5 commits and scan
//              each commit's tree for pattern matches
//   Phase 3  — For every match flagged as a risk, run the full 8-node
//              LangGraph pipeline (heuristic → API validation → Ollama LLM)
//   Phase 4  — Persist findings + AI evaluations to SQLite, print report
//
// This exercises the exact same code path as `repo-cli workflow` but gives
// step-by-step visibility into what each phase produces so you can confirm
// every component of the system is wired together correctly.
//
// Usage:
//   npx tsx tests/cli-full-test.ts
//   npm run test:workflow        (alias defined in package.json)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const _require = createRequire(import.meta.url);
const Database = _require('better-sqlite3') as typeof BetterSqlite3;

import { discoverRepos }                                from '../src/scan-worker/crawler.js';
import { scanRepo }                                     from '../src/scan-worker/scanner.js';
import { createScanValidationGraph, persistEvaluation } from '../src/scan-worker/pipeline.js';

// Cloudflare types
type D1Database = {
  prepare: (sql: string) => D1PreparedStatement;
  dump: () => Promise<ArrayBuffer>;
  batch: <T>(statements: D1PreparedStatement[]) => Promise<T[]>;
  exec: (sql: string) => Promise<{ count: number; duration: number }>;
};

type D1PreparedStatement = {
  bind: (...args: unknown[]) => D1PreparedStatement;
  run: () => Promise<{ results: any[]; success: boolean; meta: any }>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[]; success: boolean; meta: any }>;
};

type KVNamespace = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: () => Promise<{ keys: any[]; list_complete: boolean }>;
  getWithMetadata: (key: string) => Promise<{ value: string | null; metadata: any }>;
};

type Ai = {
  run: (model: string, input: any) => Promise<any>;
};

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const LOOKBACK_HOURS    = 24;    // how far back to look for GitHub pushes
const MAX_REPOS_TO_SCAN = 3;     // cap repos sampled from crawler results
const COMMITS_PER_REPO  = 5;     // last N commits to scan per repo
const MAX_FINDINGS_LLM  = 10;    // max findings sent to LangGraph per repo
const OLLAMA_BASE       = 'http://localhost:11434';
const OLLAMA_MODEL      = 'gemma4:latest';
const DB_PATH           = join(__dir, 'cli-full-test.sqlite');

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure helpers  (same adapters used in repo-cli.ts and run-workflow.ts)
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

function applySchema(db: BetterSqlite3.Database, sql: string) {
  const stripped = sql.replace(/--[^\n]*/g, ' ');
  for (const stmt of stripped.split(';').map(s => s.trim()).filter(Boolean)) {
    try {
      db.exec(stmt + ';');
    } catch (e: any) {
      if (!e.message?.includes('already exists') && !e.message?.includes('duplicate column')) throw e;
    }
  }
}

function makeD1(db: BetterSqlite3.Database): D1Database {
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
    prepare:  (sql: string) => makeStmt(sql),
    async dump()       { return new ArrayBuffer(0); },
    async batch<T>(s: D1PreparedStatement[]) { return Promise.all(s.map((x: any) => x._run())) as any; },
    async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; },
  } as unknown as D1Database;
}

function makeKV(db: BetterSqlite3.Database): KVNamespace {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER)`);
  const getRow = db.prepare('SELECT v, expires_at FROM kv_store WHERE k = ?');
  const setRow = db.prepare(`INSERT INTO kv_store (k,v,expires_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at`);
  const delRow = db.prepare('DELETE FROM kv_store WHERE k = ?');

  return {
    async get(key: string) {
      const row = getRow.get(key) as { v: string; expires_at: number | null } | undefined;
      if (!row) return null;
      if (row.expires_at && Date.now() / 1000 > row.expires_at) { delRow.run(key); return null; }
      return row.v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const exp = opts?.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : null;
      setRow.run(key, value, exp);
    },
    async delete(key: string) { delRow.run(key); },
    async list() { return { keys: [], list_complete: true } as any; },
    async getWithMetadata(key: string) { return { value: await (this as any).get(key), metadata: null } as any; },
  } as unknown as KVNamespace;
}

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
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as { message?: { content: string } };
      return { response: data.message?.content ?? '' };
    },
  } as unknown as Ai;
}

async function getLast5Commits(owner: string, repo: string, token: string, n = COMMITS_PER_REPO): Promise<string[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${n}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'RepoScout-CLITest/1.0',
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    if (!res.ok) { console.warn(`  ⚠ commits fetch ${owner}/${repo}: HTTP ${res.status}`); return ['HEAD']; }
    const list = await res.json() as Array<{ sha: string }>;
    if (!Array.isArray(list) || list.length === 0) return ['HEAD'];
    return list.map(c => c.sha);
  } catch (e) {
    console.warn(`  ⚠ commits fetch ${owner}/${repo}: ${e}`);
    return ['HEAD'];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

interface CheckResult { label: string; pass: boolean; detail: string }
const checks: CheckResult[] = [];

function check(label: string, condition: boolean, detail: string) {
  checks.push({ label, pass: condition, detail });
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} ${label}: ${detail}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const globalStart = Date.now();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   REPOSCOUT  —  CLI FULL END-TO-END VALIDATION TEST         ║');
  console.log('║   Crawler → 5-commit scan → Patterns → LangGraph pipeline   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── Load .env tokens ──────────────────────────────────────────────────────
  const envVars = loadDotEnv();
  const tokens: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = envVars[`GITHUB_TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  check('GitHub tokens loaded', tokens.length > 0, `${tokens.length} PAT(s) found`);
  if (tokens.length === 0) { console.error('\n❌ No GITHUB_TOKEN_* in .env — aborting.'); process.exit(1); }

  let tokenIdx = 0;
  const nextToken = () => tokens[tokenIdx++ % tokens.length]!;

  // ── Verify Ollama ─────────────────────────────────────────────────────────
  try {
    const probe = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    check('Ollama reachable', probe.ok, `${OLLAMA_BASE} → HTTP ${probe.status}  model: ${OLLAMA_MODEL}`);
    if (!probe.ok) { console.error('\n❌ Ollama not reachable — aborting.'); process.exit(1); }
  } catch (e) {
    check('Ollama reachable', false, String(e));
    console.error('\n❌ Ollama not reachable — aborting.'); process.exit(1);
  }

  // ── Database setup ────────────────────────────────────────────────────────
  for (const f of [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`]) {
    if (existsSync(f)) { try { unlinkSync(f); } catch {} }
  }
  const rawDb = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', 'schema.sql'), 'utf8'));
  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', '002_crawler.sql'), 'utf8'));
  check('SQLite schema applied', true, DB_PATH);

  const d1 = makeD1(rawDb);
  const kv  = makeKV(rawDb);
  const ai  = makeOllamaAI();
  const env = { DB: d1, CACHE: kv, AI: ai };

  // Load patterns JSON once
  const patterns = JSON.parse(readFileSync(join(ROOT, 'src/scan-worker/patterns.json'), 'utf8'));
  check('Patterns loaded', Array.isArray(patterns) && patterns.length > 0, `${patterns.length} pattern templates`);

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 1  — Crawler: discover repos pushed in the last 24 hours
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  PHASE 1: GitHub Search Crawler (last 24 hours)             │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  await kv.put('crawler:since', since);
  console.log(`  Lookback window: pushed since ${since}\n`);

  const crawlResult = await discoverRepos(env as any, nextToken());

  console.log(`  Discovered  : ${crawlResult.reposDiscovered} new repositories`);
  console.log(`  Re-queued   : ${crawlResult.reposUpdated} updated repositories`);
  console.log(`  Eligible    : ${crawlResult.reposEligible.length} repositories for scan`);
  if (crawlResult.errors.length) console.log(`  Warnings    : ${crawlResult.errors.slice(0, 3).join('; ')}`);

  check('Crawler returned results',
    crawlResult.reposDiscovered + crawlResult.reposUpdated > 0,
    `${crawlResult.reposDiscovered} new + ${crawlResult.reposUpdated} updated`);
  check('Crawler produced eligible repos',
    crawlResult.reposEligible.length > 0,
    `${crawlResult.reposEligible.length} repos queued`);

  if (crawlResult.reposEligible.length === 0) {
    console.log('\n⚠️  No eligible repos found. The GitHub search window may have returned no results.');
    printReport(checks, [], Date.now() - globalStart);
    rawDb.close();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 2  — Scan each repo across its last 5 commits
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log(`│  PHASE 2: Scan last ${COMMITS_PER_REPO} commits of ${MAX_REPOS_TO_SCAN} sampled repos          │`);
  console.log('└─────────────────────────────────────────────────────────────┘');

  const reposToScan = crawlResult.reposEligible.slice(0, MAX_REPOS_TO_SCAN);
  const scanRunId   = crypto.randomUUID();
  await d1.prepare(`INSERT INTO scan_runs (id, started_at, status) VALUES (?, datetime('now'), 'RUNNING')`)
    .bind(scanRunId).run();

  let totalFilesScanned = 0;
  let totalRawMatches   = 0;

  // Per-repo data collected for Phase 3
  interface RepoScanData {
    repoId:        string;
    repoSlug:      string;
    filesScanned:  number;
    matches:       any[];
    scanMs:        number;
    errors:        string[];
  }
  const repoScans: RepoScanData[] = [];

  for (const repoId of reposToScan) {
    const repo = await d1.prepare(`SELECT * FROM repositories WHERE id = ?`).bind(repoId).first<any>();
    if (!repo) continue;
    const slug = `${repo.owner}/${repo.name}`;

    console.log(`\n  ── ${slug}`);
    const t0 = Date.now();

    // Fetch last 5 commits
    const commits = await getLast5Commits(repo.owner, repo.name, nextToken());
    console.log(`     Commits to scan : ${commits.length}`);
    console.log(`     SHAs            : ${commits.map(s => s.slice(0, 7)).join(', ')}`);

    // Scan each commit and deduplicate matches
    const allMatchesMap = new Map<string, any>();
    let   filesTotal    = 0;
    const errors: string[] = [];

    for (let i = 0; i < commits.length; i++) {
      const sha = commits[i]!;
      process.stdout.write(`       [${i + 1}/${commits.length}] ${sha.slice(0, 7)} ... `);
      try {
        const result = await scanRepo(repo.owner, repo.name, nextToken(), patterns, sha);
        filesTotal += result.filesScanned;
        errors.push(...(result.errors ?? []));
        let newForCommit = 0;
        for (const m of result.matches) {
          const key = `${m.filePath}:${m.lineNumber}:${m.patternId}:${m.matchedText}`;
          if (!allMatchesMap.has(key)) {
            allMatchesMap.set(key, { ...m, commitSha: sha });
            newForCommit++;
          }
        }
        console.log(`${result.filesScanned} files, ${newForCommit} new matches`);
      } catch (e) {
        console.log(`FAILED: ${e}`);
        errors.push(`${sha.slice(0, 7)}: ${e}`);
      }
    }

    const matches  = Array.from(allMatchesMap.values());
    const scanMs   = Date.now() - t0;
    filesTotal;
    totalFilesScanned += filesTotal;
    totalRawMatches   += matches.length;

    console.log(`     Files scanned   : ${filesTotal} (across ${commits.length} commits)`);
    console.log(`     Unique matches  : ${matches.length}`);
    console.log(`     Scan time       : ${scanMs}ms`);

    // Update repo status
    await d1.prepare(`UPDATE repositories SET last_scan_status = 'COMPLETED', last_scan_at = datetime('now') WHERE id = ?`)
      .bind(repoId).run();

    repoScans.push({ repoId, repoSlug: slug, filesScanned: filesTotal, matches, scanMs, errors });
  }

  check('At least one repo scanned', repoScans.length > 0, `${repoScans.length} repos processed`);
  check('Files were scanned', totalFilesScanned > 0, `${totalFilesScanned} total files`);
  console.log(`\n  Total raw pattern matches across all repos: ${totalRawMatches}`);

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 3  — LangGraph pipeline for risk matches
  // Only matches that passed heuristic / pattern phase run through the
  // full AI pipeline: heuristic filter → API validation → Ollama LLM.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  PHASE 3: LangGraph AI Pipeline (pattern hits → verdicts)   │');
  console.log('└─────────────────────────────────────────────────────────────┘');

  const pipeline = createScanValidationGraph(env);

  interface RepoResult {
    repoSlug:   string;
    filesScanned: number;
    rawMatches: number;
    evaluated:  number;
    verdicts:   Record<string, number>;
    scanMs:     number;
    errors:     string[];
  }
  const results: RepoResult[] = [];

  let totalEvaluated  = 0;
  const aggregateVerdict: Record<string, number> = {
    TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0,
  };

  for (const scan of repoScans) {
    console.log(`\n  ── ${scan.repoSlug}  (${scan.matches.length} pattern matches)`);

    const verdicts: Record<string, number> = {
      TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0,
    };

    // Only send top MAX_FINDINGS_LLM matches through the pipeline
    const toEval = scan.matches.slice(0, MAX_FINDINGS_LLM);

    if (toEval.length === 0) {
      console.log('     No matches to evaluate — skipping LangGraph for this repo.');
      results.push({ repoSlug: scan.repoSlug, filesScanned: scan.filesScanned,
        rawMatches: 0, evaluated: 0, verdicts, scanMs: scan.scanMs, errors: scan.errors });
      continue;
    }

    for (const match of toEval) {
      const findingId = crypto.randomUUID();

      // Persist finding row
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
          findingId, scanRunId, scan.repoId,
          match.filePath,
          `https://github.com/${scan.repoSlug}/blob/${match.commitSha ?? 'HEAD'}/${match.filePath}#L${match.lineNumber}`,
          match.lineNumber,
          match.matchedText,
          match.context.split('\n')[0] ?? '',
          JSON.stringify(match.context.split('\n')),
          match.patternId, match.templateId, match.severity,
        ).first<{ id: string }>();
        activeFindingId = row?.id ?? findingId;
      } catch (e) {
        console.error(`     [!] finding persist: ${e}`);
        continue;
      }

      // Run the full LangGraph 8-node pipeline
      let finalState: any;
      try {
        finalState = await pipeline.invoke({
          findingId:          activeFindingId,
          repoName:           scan.repoSlug,
          filePath:           match.filePath,
          lineNumber:         match.lineNumber,
          matchedText:        match.matchedText,
          rawMatchedText:     match.rawMatchedText ?? match.matchedText,
          lineContent:        match.context.split('\n')[0] ?? '',
          surroundingContext: match.context,
          patternId:          match.patternId,
          templateId:         match.templateId,
          severity:           match.severity,
          isHeuristicPlaceholder: false,
          validationStatus:   'UNVERIFIABLE' as const,
          verdict:            'NEEDS_HUMAN_REVIEW' as const,
          aiReasoning:        '',
          confidenceScore:    0,
          riskScore:          0,
          validationMethod:   'heuristic' as const,
        });
      } catch (e) {
        console.error(`     [!] LangGraph pipeline failed: ${e}`);
        continue;
      }

      // Persist AI evaluation
      try {
        await persistEvaluation(d1, {
          findingId:        activeFindingId,
          verdict:          finalState.verdict,
          confidence:       finalState.confidenceScore,
          validationMethod: finalState.validationMethod ?? 'llm',
          validationStatus: finalState.validationStatus ?? 'UNVERIFIABLE',
          reasoning:        finalState.aiReasoning ?? '',
          riskScore:        finalState.riskScore,
        });
        totalEvaluated++;
        verdicts[finalState.verdict] = (verdicts[finalState.verdict] ?? 0) + 1;
        aggregateVerdict[finalState.verdict] = (aggregateVerdict[finalState.verdict] ?? 0) + 1;

        const icon = finalState.verdict === 'TRUE_POSITIVE'      ? '🔴'
                   : finalState.verdict === 'NEEDS_HUMAN_REVIEW' ? '🟡' : '⚪';
        const method = finalState.validationMethod.padEnd(9);
        const conf   = finalState.confidenceScore.toFixed(2);
        console.log(`     ${icon} [${method}] conf:${conf}  ${match.severity.padEnd(8)} ${match.patternId.slice(0, 28).padEnd(28)}  ${match.filePath}:${match.lineNumber}`);
      } catch (e) {
        console.error(`     [!] evaluation persist: ${e}`);
      }
    }

    results.push({
      repoSlug:    scan.repoSlug,
      filesScanned: scan.filesScanned,
      rawMatches:  scan.matches.length,
      evaluated:   toEval.length,
      verdicts,
      scanMs:      scan.scanMs,
      errors:      scan.errors,
    });
  }

  check('LangGraph pipeline invoked', totalEvaluated > 0 || totalRawMatches === 0,
    totalRawMatches === 0 ? 'No pattern matches found (nothing to evaluate)' : `${totalEvaluated} findings evaluated`);

  // Finalize scan_runs record
  await d1.prepare(`
    UPDATE scan_runs SET
      status             = 'COMPLETED',
      completed_at       = datetime('now'),
      total_repos_scanned = ?,
      total_findings      = ?,
      true_positives      = ?,
      needs_human_review  = ?,
      false_positives     = ?
    WHERE id = ?
  `).bind(
    reposToScan.length,
    totalRawMatches,
    aggregateVerdict.TRUE_POSITIVE  ?? 0,
    aggregateVerdict.NEEDS_HUMAN_REVIEW ?? 0,
    aggregateVerdict.FALSE_POSITIVE ?? 0,
    scanRunId,
  ).run();

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 4  — Final report
  // ─────────────────────────────────────────────────────────────────────────
  const elapsedMs  = Date.now() - globalStart;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // Write JSON report
  const report = {
    timestamp:   new Date().toISOString(),
    elapsedSec:  Number(elapsedSec),
    config: {
      lookbackHours: LOOKBACK_HOURS,
      maxReposToScan: MAX_REPOS_TO_SCAN,
      commitsPerRepo:  COMMITS_PER_REPO,
      maxFindingsLlm:  MAX_FINDINGS_LLM,
      ollamaModel:     OLLAMA_MODEL,
    },
    crawl: {
      discovered:    crawlResult.reposDiscovered,
      updated:       crawlResult.reposUpdated,
      eligible:      crawlResult.reposEligible.length,
    },
    scan: {
      reposScanned:   reposToScan.length,
      filesScanned:   totalFilesScanned,
      rawMatches:     totalRawMatches,
      evaluated:      totalEvaluated,
      verdicts:       aggregateVerdict,
    },
    repositories: results,
  };

  const reportPath = join(ROOT, 'tests', 'cli-full-test-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // ─────────────────────────────────────────────────────────────────────────
  printReport(checks, results, elapsedMs);
  console.log(`\n  JSON report → ${reportPath}\n`);

  rawDb.close();

  const failed = checks.filter(c => !c.pass).length;
  process.exit(failed > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pretty final report
// ─────────────────────────────────────────────────────────────────────────────

function printReport(checks: CheckResult[], results: any[], elapsedMs: number) {
  const passed = checks.filter(c => c.pass).length;
  const failed = checks.filter(c => !c.pass).length;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   CLI FULL-TEST  —  RESULTS                                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`  Elapsed: ${elapsedSec}s\n`);

  if (results.length > 0) {
    console.log('  Per-Repository Summary:');
    for (const r of results) {
      console.log(`    ${r.repoSlug}`);
      console.log(`      Files scanned: ${r.filesScanned}  Raw matches: ${r.rawMatches}  Evaluated: ${r.evaluated}  Time: ${r.scanMs}ms`);
      console.log(`      🔴 ${r.verdicts.TRUE_POSITIVE ?? 0}  🟡 ${r.verdicts.NEEDS_HUMAN_REVIEW ?? 0}  ⚪ ${r.verdicts.FALSE_POSITIVE ?? 0}`);
      if (r.errors.length) console.log(`      Errors: ${r.errors.slice(0, 2).join('; ')}`);
    }

    const tv  = results.reduce((s, r) => s + (r.verdicts.TRUE_POSITIVE ?? 0), 0);
    const nhv = results.reduce((s, r) => s + (r.verdicts.NEEDS_HUMAN_REVIEW ?? 0), 0);
    const fv  = results.reduce((s, r) => s + (r.verdicts.FALSE_POSITIVE ?? 0), 0);
    console.log('\n  LangGraph Aggregate Verdicts:');
    console.log(`    🔴 TRUE_POSITIVE      : ${tv}`);
    console.log(`    🟡 NEEDS_HUMAN_REVIEW : ${nhv}`);
    console.log(`    ⚪ FALSE_POSITIVE     : ${fv}`);
  }

  console.log('\n  Validation Checks:');
  for (const c of checks) {
    const icon = c.pass ? '✅' : '❌';
    console.log(`    ${icon} ${c.label}  —  ${c.detail}`);
  }

  console.log(`\n  ── ${passed}/${checks.length} checks passed${failed > 0 ? `  (${failed} FAILED)` : ''} ──`);

  if (failed === 0) {
    console.log('\n  ✅  All checks passed — the full CLI pipeline is working end-to-end!\n');
  } else {
    console.log('\n  ❌  Some checks failed — see above for details.\n');
  }
}

main().catch(e => {
  console.error('\n[Fatal Error]', e);
  process.exit(1);
});
