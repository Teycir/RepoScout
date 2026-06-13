#!/usr/bin/env node
/**
 * repo-cli.ts
 * CLI tool for AI assistants (Claude, ChatGPT, etc.) to query RepoScout findings
 *
 * Usage:
 *   repo-cli repos [limit] [--local] [--db <path>]
 *   repo-cli findings <repoId> [limit] [--local] [--db <path>]
 *   repo-cli queue [limit] [--local] [--db <path>]
 *   repo-cli runs [limit] [--local] [--db <path>]
 *   repo-cli stats [--local] [--db <path>]
 * 
 * Local Scan & Workflow commands:
 *   repo-cli scan <owner/repo> [depth] [--db <path>]
 *   repo-cli workflow [lookbackHours] [--db <path>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

declare global {
  interface D1Result<T = unknown> {
    results: T[];
    success: boolean;
    meta: {
      changes: number;
      last_row_id: number;
      duration: number;
    };
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    dump(): Promise<ArrayBuffer>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<{ count: number; duration: number }>;
  }

  interface KVNamespacePutOptions {
    expiration?: number;
    expirationTtl?: number;
    metadata?: any;
  }

  interface KVNamespaceListOptions {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }

  interface KVNamespace {
    get(key: string, options?: any): Promise<string | null>;
    getWithMetadata<T = any>(key: string, options?: any): Promise<{ value: string | null; metadata: T | null }>;
    put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: KVNamespaceListOptions): Promise<{ keys: { name: string; expiration?: number; metadata?: any }[]; list_complete: boolean; cursor?: string }>;
  }

  interface Ai {
    run(model: string, input: any, options?: any): Promise<any>;
  }
}

const _require = createRequire(import.meta.url);
const Database = _require('better-sqlite3') as any;


import { discoverRepos } from '../src/scan-worker/crawler.js';
import { scanRepo } from '../src/scan-worker/scanner.js';
import { createScanValidationGraph, persistEvaluation } from '../src/scan-worker/pipeline.js';

const __dir = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(): string {
  let dir = __dir;
  while (dir && dir !== '/' && dir !== '.') {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'migrations', 'schema.sql'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return join(__dir, '..'); // Fallback
}
const ROOT = findProjectRoot();

const API_BASE = process.env.REPOSCOUT_API_BASE || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetch_api(endpoint: string): Promise<any> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: string };
      if (body.error) detail = ` — ${body.error}`;
    } catch { /* non-JSON error body */ }
    throw new Error(`HTTP ${res.status}: ${res.statusText}${detail}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Local DB Helpers
// ---------------------------------------------------------------------------

function applySchema(db: any, sql: string) {
  const stripped = sql.replace(/--[^\n]*/g, ' ');
  for (const stmt of stripped.split(';').map(s => s.trim()).filter(s => s.length > 0)) {
    try {
      db.exec(stmt + ';');
    } catch (e: any) {
      if (!e.message?.includes('already exists') && !e.message?.includes('duplicate column')) throw e;
    }
  }
}

function getLocalDb(dbPath: string) {
  const resolvedDbPath = join(ROOT, dbPath);
  console.log(`[cli] Opening SQLite database: ${resolvedDbPath}`);
  const rawDb = new Database(resolvedDbPath);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', 'schema.sql'), 'utf8'));
  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', '002_crawler.sql'), 'utf8'));

  return rawDb;
}

// D1-compatible async shim over better-sqlite3
function makeD1(db: any): D1Database {
  function makeStmt(sql: string): D1PreparedStatement {
    let params: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...args: unknown[]) { params = args; return stmt; },
      async run<T>() {
        const info = db.prepare(sql).run(...params);
        return {
          results: [] as T[],
          success: true,
          meta: {
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid),
            duration: 0
          }
        };
      },
      async first<T>() {
        const row = db.prepare(sql).get(...params);
        return (row as T) ?? null;
      },
      async all<T>() {
        const results = db.prepare(sql).all(...params) as T[];
        return {
          results,
          success: true,
          meta: {
            changes: 0,
            last_row_id: 0,
            duration: 0
          }
        };
      },
    };
    return stmt;
  }
  return {
    prepare: (sql: string) => makeStmt(sql),
    async dump() { return new ArrayBuffer(0); },
    async batch<T>(stmts: D1PreparedStatement[]) {
      return Promise.all(stmts.map((s) => s.run())) as any;
    },
    async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// KV memory adapter
function makeKV(db: any): KVNamespace {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER)`);
  const get = db.prepare('SELECT v, expires_at FROM kv_store WHERE k = ?');
  const set = db.prepare(`INSERT INTO kv_store (k,v,expires_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at`);
  const del = db.prepare('DELETE FROM kv_store WHERE k = ?');

  const kv: KVNamespace = {
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
    async list() { return { keys: [], list_complete: true }; },
    async getWithMetadata<T = any>(key: string) {
      const value = await kv.get(key);
      return { value, metadata: null as T | null };
    },
  };
  return kv;
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
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json() as { message?: { content: string } };
      return { response: data.message?.content ?? '' };
    },
  };
}

function loadDotEnv(): Record<string, string> {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) {
      console.warn(`  ⚠ Warning: invalid syntax in .env line: "${line}" (missing '=')`);
      continue;
    }
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

async function getLast5Commits(owner: string, repo: string, token: string): Promise<string[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=5`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'RepoScout-Workflow/1.0',
        Accept: 'application/vnd.github.v3+json',
      }
    });
    if (!res.ok) {
      console.warn(`  ⚠ Failed to fetch commits for ${owner}/${repo}: HTTP ${res.status}`);
      return ['HEAD'];
    }
    const list = await res.json() as Array<{ sha: string }>;
    if (!Array.isArray(list) || list.length === 0) return ['HEAD'];
    return list.map(c => c.sha);
  } catch (e) {
    console.warn(`  ⚠ Failed to fetch commits for ${owner}/${repo}: ${e}`);
    return ['HEAD'];
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function format_repo(r: any, i: number) {
  const lines = [
    `[${i + 1}] ${r.owner}/${r.name}`,
    `    ID: ${r.id}`,
    `    Risk score: ${r.risk_score}`,
    `    Critical: ${r.critical_severity_findings}  High: ${r.high_severity_findings}`,
    `    Status: ${r.last_scan_status}`,
    `    Last scan: ${r.last_scan_at ?? 'never'}`,
    `    URL: ${r.url}`,
  ];
  return lines.join('\n');
}

function format_finding(f: any, i: number) {
  const lines = [
    `[${i + 1}] ${f.file_path}:${f.line_number}`,
    `    Repo: ${f.repo_owner}/${f.repo_name} (${f.repo_id})`,
    `    Matched: ${f.matched_text}`,
    `    Severity: ${f.severity}`,
    `    Template: ${f.template_id} / Pattern: ${f.pattern_id}`,
  ];
  if (f.eval) {
    lines.push(`    Verdict: ${f.eval.verdict} (${(f.eval.confidence * 100).toFixed(0)}% confidence, via ${f.eval.validation_method})`);
    if (f.eval.reasoning) lines.push(`    Reasoning: ${f.eval.reasoning}`);
    if (f.eval.analyst_reviewed) lines.push(`    Analyst override: ${f.eval.analyst_verdict}`);
  } else {
    lines.push(`    Verdict: — pending —`);
  }
  if (f.file_url) lines.push(`    URL: ${f.file_url}`);
  lines.push(`    Detected: ${f.detected_at}`);
  return lines.join('\n');
}

function format_scan_run(r: any, i: number) {
  const lines = [
    `[${i + 1}] ${r.id}`,
    `    Status: ${r.status}`,
    `    Started: ${r.started_at}`,
    `    Completed: ${r.completed_at ?? '—'}`,
    `    Repos scanned: ${r.total_repos_scanned}`,
    `    Findings: ${r.total_findings} (TP: ${r.true_positives}, needs review: ${r.needs_human_review}, FP: ${r.false_positives})`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmd_repos(limit = 50, local = false, dbPath = '') {
  if (local) {
    const rawDb = getLocalDb(dbPath);
    try {
      const repos = rawDb.prepare(`SELECT * FROM repositories ORDER BY risk_score DESC LIMIT ?`).all(limit);
      console.log(`Repositories (Local DB - ${repos.length}):\n`);
      repos.forEach((r: any, i: number) => {
        console.log(`${format_repo(r, i)}\n`);
      });
    } finally {
      rawDb.close();
    }
  } else {
    const data = await fetch_api(`/api/repos?limit=${limit}`);
    const repos = data.repos ?? [];
    console.log(`Repositories (${repos.length}):\n`);
    repos.forEach((r: any, i: number) => {
      console.log(`${format_repo(r, i)}\n`);
    });
  }
}

async function cmd_findings(repoId: string, limit = 100, local = false, dbPath = '') {
  if (local) {
    const rawDb = getLocalDb(dbPath);
    try {
      const findings = rawDb.prepare(`
        SELECT f.*, r.owner as repo_owner, r.name as repo_name,
               ae.verdict, ae.confidence, ae.validation_method, ae.reasoning,
               ae.analyst_reviewed, ae.analyst_verdict
        FROM findings f
        JOIN repositories r ON f.repo_id = r.id
        LEFT JOIN ai_evaluations ae ON ae.finding_id = f.id
        WHERE f.repo_id = ? OR r.owner || '/' || r.name = ?
        LIMIT ?
      `).all(repoId, repoId, limit);

      console.log(`Findings for repo ${repoId} (Local DB - ${findings.length}):\n`);
      findings.forEach((f: any, i: number) => {
        const formatted = {
          ...f,
          eval: f.verdict ? {
            verdict: f.verdict,
            confidence: f.confidence,
            validation_method: f.validation_method,
            reasoning: f.reasoning,
            analyst_reviewed: f.analyst_reviewed,
            analyst_verdict: f.analyst_verdict
          } : null
        };
        console.log(`${format_finding(formatted, i)}\n`);
      });
    } finally {
      rawDb.close();
    }
  } else {
    const data = await fetch_api(`/api/repos/${encodeURIComponent(repoId)}/findings?limit=${limit}`);
    const findings = data.findings ?? [];
    console.log(`Findings for repo ${repoId} (${findings.length}):\n`);
    findings.forEach((f: any, i: number) => {
      console.log(`${format_finding(f, i)}\n`);
    });
  }
}

async function cmd_queue(limit = 100, local = false, dbPath = '') {
  if (local) {
    const rawDb = getLocalDb(dbPath);
    try {
      const queue = rawDb.prepare(`
        SELECT f.*, r.owner as repo_owner, r.name as repo_name,
               ae.verdict, ae.confidence, ae.validation_method, ae.reasoning,
               ae.analyst_reviewed, ae.analyst_verdict
        FROM findings f
        JOIN repositories r ON f.repo_id = r.id
        LEFT JOIN ai_evaluations ae ON ae.finding_id = f.id
        WHERE ae.verdict = 'NEEDS_HUMAN_REVIEW'
        LIMIT ?
      `).all(limit);

      console.log(`Analyst review queue (Local DB - ${queue.length}):\n`);
      queue.forEach((f: any, i: number) => {
        const formatted = {
          ...f,
          eval: f.verdict ? {
            verdict: f.verdict,
            confidence: f.confidence,
            validation_method: f.validation_method,
            reasoning: f.reasoning,
            analyst_reviewed: f.analyst_reviewed,
            analyst_verdict: f.analyst_verdict
          } : null
        };
        console.log(`${format_finding(formatted, i)}\n`);
      });
    } finally {
      rawDb.close();
    }
  } else {
    const data = await fetch_api(`/api/review-queue?limit=${limit}`);
    const queue = data.queue ?? [];
    console.log(`Analyst review queue (${queue.length}):\n`);
    queue.forEach((f: any, i: number) => {
      console.log(`${format_finding(f, i)}\n`);
    });
  }
}

async function cmd_runs(limit = 10, local = false, dbPath = '') {
  if (local) {
    const rawDb = getLocalDb(dbPath);
    try {
      const runs = rawDb.prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
      console.log(`Recent scan runs (Local DB - ${runs.length}):\n`);
      runs.forEach((r: any, i: number) => {
        console.log(`${format_scan_run(r, i)}\n`);
      });
    } finally {
      rawDb.close();
    }
  } else {
    const data = await fetch_api(`/api/scan-runs?limit=${limit}`);
    const runs = data.runs ?? [];
    console.log(`Recent scan runs (${runs.length}):\n`);
    runs.forEach((r: any, i: number) => {
      console.log(`${format_scan_run(r, i)}\n`);
    });
  }
}

async function cmd_stats(local = false, dbPath = '') {
  if (local) {
    const rawDb = getLocalDb(dbPath);
    try {
      const totalRepos = (rawDb.prepare(`SELECT COUNT(*) as count FROM repositories`).get() as any).count;
      const criticalFindings = (rawDb.prepare(`SELECT COUNT(*) as count FROM ai_evaluations WHERE verdict = 'TRUE_POSITIVE'`).get() as any).count;
      const analystQueueCount = (rawDb.prepare(`SELECT COUNT(*) as count FROM ai_evaluations WHERE verdict = 'NEEDS_HUMAN_REVIEW'`).get() as any).count;
      const lastScan = rawDb.prepare(`SELECT MAX(completed_at) as last FROM scan_runs`).get() as any;

      console.log('RepoScout local stats:\n');
      console.log(`  Total repos: ${totalRepos}`);
      console.log(`  Critical findings (TP, high/critical): ${criticalFindings}`);
      console.log(`  Analyst queue: ${analystQueueCount}`);
      console.log(`  Last scan: ${lastScan?.last ?? 'never'}`);
    } finally {
      rawDb.close();
    }
  } else {
    const data = await fetch_api('/api/stats');
    console.log('RepoScout dashboard stats:\n');
    console.log(`  Total repos: ${data.totalRepos}`);
    console.log(`  Critical findings (TP, high/critical): ${data.criticalFindings}`);
    console.log(`  Analyst queue: ${data.analystQueueCount}`);
    console.log(`  Last scan: ${data.lastScanAt ?? 'never'}`);
  }
}

async function cmd_scan(repoSlug: string, depth = 5, dbPath = '', maxFindings = 10) {
  const [owner, name] = repoSlug.split('/') as [string, string];
  if (!owner || !name) {
    throw new Error('Invalid repo slug format. Use: owner/repo');
  }

  // Load environment
  const envVars = loadDotEnv();
  const tokens: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = envVars[`GITHUB_TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  if (tokens.length === 0) {
    throw new Error('No GITHUB_TOKEN_* found in .env');
  }

  let tokenIdx = 0;
  const nextToken = (): string => tokens[tokenIdx++ % tokens.length]!;

  // Verify Ollama
  try {
    const probe = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (e) {
    throw new Error(`Cannot reach Ollama at ${OLLAMA_BASE}: ${e}`);
  }

  const rawDb = getLocalDb(dbPath);
  const d1 = makeD1(rawDb);
  const kv = makeKV(rawDb);
  const ai = makeOllamaAI();
  const env = { DB: d1, CACHE: kv, AI: ai };

  // Register / Upsert repository
  const repoUrl = `https://github.com/${owner}/${name}`;
  const repoRow = await d1.prepare(`
    INSERT INTO repositories (id, owner, name, url, source, last_scan_status)
    VALUES (?, ?, ?, ?, 'manual', 'RUNNING')
    ON CONFLICT(owner, name) DO UPDATE SET last_scan_status = 'RUNNING'
    RETURNING id
  `).bind(crypto.randomUUID(), owner, name, repoUrl).first<{ id: string }>();

  if (!repoRow) {
    throw new Error(`Failed to upsert repository ${owner}/${name}`);
  }
  const activeRepoId = repoRow.id;

  const patterns = JSON.parse(readFileSync(join(ROOT, 'src/scan-worker/patterns.json'), 'utf8'));
  const pipeline = createScanValidationGraph(env);
  const scanRunId = crypto.randomUUID();

  await d1.prepare(`INSERT INTO scan_runs (id, started_at, status) VALUES (?, datetime('now'), 'RUNNING')`)
    .bind(scanRunId).run();

  console.log(`\nScanning ${owner}/${name} locally...`);
  const commits = await getLast5Commits(owner, name, nextToken());
  const limitCommits = commits.slice(0, depth);
  console.log(`  Depth: Scanning last ${limitCommits.length} edits (commits)...`);

  const allMatchesMap = new Map<string, any>();
  let filesScannedTotal = 0;
  const errorsList: string[] = [];
  const scanStart = Date.now();

  for (let idx = 0; idx < limitCommits.length; idx++) {
    const sha = limitCommits[idx]!;
    console.log(`    → Scanning edit ${idx + 1}/${limitCommits.length} (commit ${sha.slice(0, 7)})`);
    try {
      const result = await scanRepo(owner, name, nextToken(), patterns, sha);
      filesScannedTotal += result.filesScanned;
      if (result.errors) errorsList.push(...result.errors);
      for (const m of result.matches) {
        const key = `${m.filePath}:${m.lineNumber}:${m.patternId}:${m.matchedText}`;
        if (!allMatchesMap.has(key)) {
          allMatchesMap.set(key, { ...m, commitSha: sha });
        }
      }
    } catch (e) {
      console.error(`      [!] failed scanning commit ${sha.slice(0, 7)}: ${e}`);
      errorsList.push(`Commit ${sha.slice(0, 7)} scan failed: ${e}`);
    }
  }

  const matches = Array.from(allMatchesMap.values());
  const scanTime = Date.now() - scanStart;

  console.log(`  Files scanned : ${filesScannedTotal} (across all edits)`);
  console.log(`  Unique matches: ${matches.length}`);
  console.log(`  Scan time     : ${scanTime}ms`);
  if (errorsList.length) console.log(`  errors: ${errorsList.slice(0, 3).join('; ')}`);

  await d1.prepare(`UPDATE repositories SET last_scan_status = 'COMPLETED', last_scan_at = datetime('now') WHERE id = ?`)
    .bind(activeRepoId).run();

  const verdicts: Record<string, number> = { TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0 };
  const matchesSlice = matches.slice(0, maxFindings); // Run LangGraph on configured max findings
  let evaluated = 0;

  for (const match of matchesSlice) {
    const findingId = crypto.randomUUID();

    // Persist finding
    let activeFindingId: string = findingId;
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
        findingId, scanRunId, activeRepoId,
        match.filePath,
        `https://github.com/${owner}/${name}/blob/${match.commitSha || 'HEAD'}/${match.filePath}#L${match.lineNumber}`,
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

    if (!match.rawMatchedText) {
      console.warn(`  ⚠ Warning: match.rawMatchedText is missing for ${match.filePath}:${match.lineNumber}`);
    }

    // LangGraph pipeline
    let finalState: any;
    try {
      finalState = await pipeline.invoke({
        findingId: activeFindingId,
        repoName: `${owner}/${name}`,
        filePath: match.filePath,
        lineNumber: match.lineNumber,
        matchedText: match.matchedText,
        rawMatchedText: match.rawMatchedText || match.matchedText,
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
      console.error(`  [!] LangGraph pipeline failed: ${e}`);
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
      evaluated++;
      verdicts[finalState.verdict] = (verdicts[finalState.verdict] ?? 0) + 1;

      const icon = finalState.verdict === 'TRUE_POSITIVE' ? '🔴' : 
                   finalState.verdict === 'NEEDS_HUMAN_REVIEW' ? '🟡' : '⚪';
      console.log(`  ${icon} ${match.severity.padEnd(8)} ${match.patternId.padEnd(30)} ${match.filePath}:${match.lineNumber}  [conf:${finalState.confidenceScore.toFixed(2)}]`);
    } catch (e) {
      console.error(`  [!] evaluation persist failed: ${e}`);
    }
  }

  await d1.prepare(`
    UPDATE scan_runs SET
      status = 'COMPLETED',
      completed_at = datetime('now'),
      total_repos_scanned = 1,
      total_findings = ?,
      true_positives = ?,
      needs_human_review = ?,
      false_positives = ?
    WHERE id = ?
  `).bind(
    matches.length,
    verdicts.TRUE_POSITIVE || 0,
    verdicts.NEEDS_HUMAN_REVIEW || 0,
    verdicts.FALSE_POSITIVE || 0,
    scanRunId
  ).run();

  rawDb.close();

  console.log(`\nScan finished. Results saved to local DB: ${dbPath}`);
}

async function cmd_workflow(lookbackHours = 24, dbPath = '', maxRepos = 3, maxFindings = 10) {
  const globalStart = Date.now();
  console.log('\n================================================================');
  console.log(`   REPOSCOUT CRAWLER + LANGGRAPH PIPELINE WORKFLOW (LOCAL DB)`);
  console.log('================================================================\n');

  // Load environment
  const envVars = loadDotEnv();
  const tokens: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = envVars[`GITHUB_TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  if (tokens.length === 0) {
    throw new Error('No GITHUB_TOKEN_* found in .env');
  }

  let tokenIdx = 0;
  const nextToken = (): string => tokens[tokenIdx++ % tokens.length]!;

  // Verify Ollama
  try {
    const probe = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (e) {
    throw new Error(`Cannot reach Ollama at ${OLLAMA_BASE}: ${e}`);
  }

  const rawDb = getLocalDb(dbPath);
  const d1 = makeD1(rawDb);
  const kv = makeKV(rawDb);
  const ai = makeOllamaAI();
  const env = { DB: d1, CACHE: kv, AI: ai };

  // Set lookback window
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  await kv.put('crawler:since', since);
  console.log(`✓ Set crawler lookup window: since >= ${since}`);

  // Run Crawler
  console.log('\n[Phase 1] Running GitHub Search crawler...');
  const crawlResult = await discoverRepos(env as any, nextToken());
  console.log(`  Discovered : ${crawlResult.reposDiscovered} new repositories`);
  console.log(`  Updated    : ${crawlResult.reposUpdated} updated repositories`);
  console.log(`  Eligible   : ${crawlResult.reposEligible.length} repositories for scan`);

  if (crawlResult.reposEligible.length === 0) {
    console.log('\n⚠️ No eligible repositories found in the last 24 hours.');
    rawDb.close();
    return;
  }

  // Scan discovered repositories
  const reposToScan = crawlResult.reposEligible.slice(0, maxRepos);
  console.log(`\n[Phase 2] Scanning a sample of ${reposToScan.length} discovered repositories...`);

  const patterns = JSON.parse(readFileSync(join(ROOT, 'src/scan-worker/patterns.json'), 'utf8'));
  const pipeline = createScanValidationGraph(env);
  const scanRunId = crypto.randomUUID();

  await d1.prepare(`INSERT INTO scan_runs (id, started_at, status) VALUES (?, datetime('now'), 'RUNNING')`)
    .bind(scanRunId).run();

  let totalFilesScanned = 0;
  let totalFindings = 0;
  let totalEvaluated = 0;
  const summaries: any[] = [];

  for (const repoId of reposToScan) {
    const repo = await d1.prepare(`SELECT * FROM repositories WHERE id = ?`).bind(repoId).first<any>();
    if (!repo) continue;

    console.log(`\n────────────────────────────────────────────────────────────────`);
    console.log(`Scanning ${repo.owner}/${repo.name}...`);

    const scanStart = Date.now();
    const commits = await getLast5Commits(repo.owner, repo.name, nextToken());
    console.log(`  Depth: Scanning last ${commits.length} edits (commits)...`);

    const allMatchesMap = new Map<string, any>();
    let filesScannedTotal = 0;
    const errorsList: string[] = [];

    for (let idx = 0; idx < commits.length; idx++) {
      const sha = commits[idx]!;
      try {
        const result = await scanRepo(repo.owner, repo.name, nextToken(), patterns, sha);
        filesScannedTotal += result.filesScanned;
        if (result.errors) errorsList.push(...result.errors);
        for (const m of result.matches) {
          const key = `${m.filePath}:${m.lineNumber}:${m.patternId}:${m.matchedText}`;
          if (!allMatchesMap.has(key)) {
            allMatchesMap.set(key, { ...m, commitSha: sha });
          }
        }
      } catch (e) {
        errorsList.push(`Commit ${sha.slice(0, 7)} scan failed: ${e}`);
      }
    }

    const matches = Array.from(allMatchesMap.values());
    const scanTime = Date.now() - scanStart;
    totalFilesScanned += filesScannedTotal;
    totalFindings += matches.length;

    console.log(`  Files scanned : ${filesScannedTotal} (across all edits)`);
    console.log(`  Unique matches: ${matches.length}`);
    console.log(`  Scan time     : ${scanTime}ms`);

    await d1.prepare(`UPDATE repositories SET last_scan_status = 'COMPLETED', last_scan_at = datetime('now') WHERE id = ?`)
      .bind(repoId).run();

    const verdicts: Record<string, number> = { TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0 };
    const matchesSlice = matches.slice(0, maxFindings);

    for (const match of matchesSlice) {
      const findingId = crypto.randomUUID();
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
          `https://github.com/${repo.owner}/${repo.name}/blob/${match.commitSha || 'HEAD'}/${match.filePath}#L${match.lineNumber}`,
          match.lineNumber,
          match.matchedText,
          match.context.split('\n')[0] ?? '',
          JSON.stringify(match.context.split('\n')),
          match.patternId, match.templateId, match.severity,
        ).first<{ id: string }>();
        const activeFindingId = row?.id ?? findingId;

        const finalState = await pipeline.invoke({
          findingId: activeFindingId,
          repoName: `${repo.owner}/${repo.name}`,
          filePath: match.filePath,
          lineNumber: match.lineNumber,
          matchedText: match.matchedText,
          rawMatchedText: match.rawMatchedText || match.matchedText,
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
        verdicts[finalState.verdict] = (verdicts[finalState.verdict] ?? 0) + 1;

        const icon = finalState.verdict === 'TRUE_POSITIVE' ? '🔴' : 
                     finalState.verdict === 'NEEDS_HUMAN_REVIEW' ? '🟡' : '⚪';
        console.log(`  ${icon} ${match.severity.padEnd(8)} ${match.patternId.padEnd(30)} ${match.filePath}:${match.lineNumber}  [conf:${finalState.confidenceScore.toFixed(2)}]`);
      } catch (e) {
        console.error(`  [!] Error processing match: ${e}`);
      }
    }

    summaries.push({ repo: `${repo.owner}/${repo.name}`, filesScanned: filesScannedTotal, matches: matches.length, evaluated: matchesSlice.length, scanMs: scanTime, verdicts, errors: errorsList });
  }

  const aggregateVerdicts = { TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0 };
  for (const s of summaries) {
    aggregateVerdicts.TRUE_POSITIVE += s.verdicts.TRUE_POSITIVE || 0;
    aggregateVerdicts.NEEDS_HUMAN_REVIEW += s.verdicts.NEEDS_HUMAN_REVIEW || 0;
    aggregateVerdicts.FALSE_POSITIVE += s.verdicts.FALSE_POSITIVE || 0;
  }

  await d1.prepare(`
    UPDATE scan_runs SET
      status = 'COMPLETED',
      completed_at = datetime('now'),
      total_repos_scanned = ?,
      total_findings = ?,
      true_positives = ?,
      needs_human_review = ?,
      false_positives = ?
    WHERE id = ?
  `).bind(
    reposToScan.length,
    totalFindings,
    aggregateVerdicts.TRUE_POSITIVE,
    aggregateVerdicts.NEEDS_HUMAN_REVIEW,
    aggregateVerdicts.FALSE_POSITIVE,
    scanRunId
  ).run();

  const elapsedSec = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log('\n================================================================');
  console.log('   WORKFLOW SCAN SUMMARY REPORT (LOCAL DB)');
  console.log('================================================================');
  console.log(`  Elapsed Time       : ${elapsedSec}s`);
  console.log(`  Repos Discovered   : ${crawlResult.reposDiscovered}`);
  console.log(`  Sample Repos Scanned: ${summaries.length}`);
  console.log(`  Files Scanned      : ${totalFilesScanned}`);
  console.log(`  Total Match Findings: ${totalFindings}`);
  console.log(`  LangGraph Evaluated: ${totalEvaluated}`);
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`  Verdicts:`);
  console.log(`    🔴 TRUE_POSITIVE     : ${aggregateVerdicts.TRUE_POSITIVE}`);
  console.log(`    🟡 NEEDS_HUMAN_REVIEW: ${aggregateVerdicts.NEEDS_HUMAN_REVIEW}`);
  console.log(`    ⚪ FALSE_POSITIVE    : ${aggregateVerdicts.FALSE_POSITIVE}`);
  console.log('================================================================\n');

  rawDb.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  
  // Extract options
  const localIdx = args.findIndex(a => a === '--local' || a === '-l');
  const local = localIdx !== -1;
  if (localIdx !== -1) args.splice(localIdx, 1);

  const dbIdx = args.findIndex(a => a === '--db');
  let dbPath = join(ROOT, 'reposcout-local.sqlite');
  if (dbIdx !== -1) {
    if (args[dbIdx + 1]) {
      dbPath = args[dbIdx + 1]!;
      args.splice(dbIdx, 2);
    } else {
      args.splice(dbIdx, 1);
    }
  }

  const maxReposIdx = args.findIndex(a => a === '--max-repos' || a === '-r');
  let maxRepos = 3;
  if (maxReposIdx !== -1) {
    if (args[maxReposIdx + 1]) {
      maxRepos = parseInt(args[maxReposIdx + 1]!, 10) || 3;
      args.splice(maxReposIdx, 2);
    } else {
      args.splice(maxReposIdx, 1);
    }
  }

  const maxFindingsIdx = args.findIndex(a => a === '--max-findings' || a === '-f');
  let maxFindings = 10;
  if (maxFindingsIdx !== -1) {
    if (args[maxFindingsIdx + 1]) {
      maxFindings = parseInt(args[maxFindingsIdx + 1]!, 10) || 10;
      args.splice(maxFindingsIdx, 2);
    } else {
      args.splice(maxFindingsIdx, 1);
    }
  }

  const cmd = args[0];

  try {
    switch (cmd) {
      case 'repos':
        await cmd_repos(parseInt(args[1] || '') || 50, local, dbPath);
        break;
      case 'findings':
        if (!args[1]) throw new Error('repo-cli findings <repoId> [limit]');
        await cmd_findings(args[1], parseInt(args[2] || '') || 100, local, dbPath);
        break;
      case 'queue':
        await cmd_queue(parseInt(args[1] || '') || 100, local, dbPath);
        break;
      case 'runs':
        await cmd_runs(parseInt(args[1] || '') || 10, local, dbPath);
        break;
      case 'stats':
        await cmd_stats(local, dbPath);
        break;
      case 'scan':
        if (!args[1]) throw new Error('repo-cli scan <owner/repo> [depth]');
        await cmd_scan(args[1], parseInt(args[2] || '') || 5, dbPath, maxFindings);
        break;
      case 'workflow':
        await cmd_workflow(parseInt(args[1] || '') || 24, dbPath, maxRepos, maxFindings);
        break;
      default:
        console.log(`RepoScout CLI - Local & Remote Query Tool

Usage:
  repo-cli repos [limit] [--local] [--db <path>]                  List monitored repos (default 50)
  repo-cli findings <repoId> [limit] [--local] [--db <path>]      Findings + AI verdicts for a repo
  repo-cli queue [limit] [--local] [--db <path>]                  Analyst review queue (default 100)
  repo-cli runs [limit] [--local] [--db <path>]                   Recent scan run history (default 10)
  repo-cli stats [--local] [--db <path>]                          Dashboard summary counters
  
Local Scan & Workflow Commands:
  repo-cli scan <owner/repo> [depth] [--db <path>] [--max-findings <n>]
                                                                  Scan a repo locally & evaluate using Ollama
  repo-cli workflow [lookbackHours] [--db <path>] [--max-repos <n>] [--max-findings <n>]
                                                                  Run the crawler + scan + pipeline workflow locally

Examples:
  repo-cli repos 20 --local
  repo-cli findings kzoou2/kzoou2 --local
  repo-cli scan trufflesecurity/test_keys 3 --max-findings 5
  repo-cli workflow 12 --max-repos 5 --max-findings 20
`);
    }
  } catch (err: any) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
