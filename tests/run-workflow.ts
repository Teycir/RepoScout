#!/usr/bin/env npx tsx
// tests/run-workflow.ts
// ─────────────────────────────────────────────────────────────────────────────
// Workflow test:
//   1. Runs the crawler to discover public repos changed in the last 24 hours (all languages)
//   2. Scans a sample of the discovered repositories
//   3. Runs the LangGraph AI pipeline backed by Ollama to validate any findings
//   4. Generates a markdown and JSON report
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
import Database from 'better-sqlite3';

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

// D1-compatible async shim over better-sqlite3
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

// KV memory adapter
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

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const globalStart = Date.now();
  console.log('\n================================================================');
  console.log('   REPOSCOUT 24-HOUR CRAWLER + LANGGRAPH PIPELINE WORKFLOW');
  console.log('================================================================\n');

  // Load environment
  const envVars = loadDotEnv();
  const tokens: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = envVars[`GITHUB_TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  if (tokens.length === 0) {
    console.error('❌ No GITHUB_TOKEN_* found in .env');
    process.exit(1);
  }
  console.log(`✓ Loaded ${tokens.length} GitHub PAT(s)`);

  let tokenIdx = 0;
  const nextToken = (): string => tokens[tokenIdx++ % tokens.length]!;

  // Verify Ollama
  try {
    const probe = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    console.log(`✓ Ollama reachable — model: ${OLLAMA_MODEL}`);
  } catch (e) {
    console.error(`❌ Cannot reach Ollama at ${OLLAMA_BASE}: ${e}`);
    process.exit(1);
  }

  // Database path & setup
  const DB_PATH = join(__dir, 'workflow-run.sqlite');
  if (existsSync(DB_PATH)) {
    try { unlinkSync(DB_PATH); } catch {}
  }
  if (existsSync(`${DB_PATH}-shm`)) {
    try { unlinkSync(`${DB_PATH}-shm`); } catch {}
  }
  if (existsSync(`${DB_PATH}-wal`)) {
    try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  }

  const rawDb = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', 'schema.sql'), 'utf8'));
  applySchema(rawDb, readFileSync(join(ROOT, 'migrations', '002_crawler.sql'), 'utf8'));
  console.log(`✓ Database initialized at: ${DB_PATH}`);

  const d1 = makeD1(rawDb);
  const kv = makeKV(rawDb);
  const ai = makeOllamaAI();
  const env = { DB: d1, CACHE: kv, AI: ai };

  // Set the crawler cursor to look back exactly 24 hours ago
  const lookback24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await kv.put('crawler:since', lookback24h);
  console.log(`✓ Set crawler lookup window: since >= ${lookback24h}`);

  // Run Crawler
  console.log('\n[Phase 1] Running GitHub Search crawler...');
  const crawlResult = await discoverRepos(env, nextToken());
  console.log(`  Discovered : ${crawlResult.reposDiscovered} new repositories`);
  console.log(`  Updated    : ${crawlResult.reposUpdated} updated repositories`);
  console.log(`  Eligible   : ${crawlResult.reposEligible.length} repositories for scan`);
  if (crawlResult.errors.length > 0) {
    console.log(`  Warnings/Errors: ${crawlResult.errors.slice(0, 3).join('; ')}`);
  }

  if (crawlResult.reposEligible.length === 0) {
    console.log('\n⚠️ No eligible repositories found in the last 24 hours.');
    console.log('Skipping scan phase.');
    createEmptyReport(crawlResult.reposDiscovered, lookback24h);
    process.exit(0);
  }

  // Scan discovered repositories
  const maxRepos = parseInt(process.argv[2] || '') || crawlResult.reposEligible.length;
  const reposToScan = crawlResult.reposEligible.slice(0, maxRepos);
  console.log(`\n[Phase 2] Scanning ${reposToScan.length} discovered repositories...`);

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
    let repo: any = null;
    try {
      repo = await d1.prepare(`SELECT * FROM repositories WHERE id = ?`).bind(repoId).first<any>();
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
        console.log(`    → Scanning edit ${idx + 1}/${commits.length} (commit ${sha.slice(0, 7)})`);
        try {
          const result = await scanRepo(repo.owner, repo.name, nextToken(), patterns, sha);
          filesScannedTotal += result.filesScanned;
          if (result.errors) errorsList.push(...result.errors.map(e => e.message));
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
      totalFilesScanned += filesScannedTotal;
      totalFindings += matches.length;

      console.log(`  Files scanned : ${filesScannedTotal} (across all edits)`);
      console.log(`  Unique matches: ${matches.length}`);
      console.log(`  Scan time     : ${scanTime}ms`);
      if (errorsList.length) console.log(`  errors: ${errorsList.slice(0, 3).join('; ')}`);

      await d1.prepare(`UPDATE repositories SET last_scan_status = 'COMPLETED', last_scan_at = datetime('now') WHERE id = ?`)
        .bind(repoId).run();

      const verdicts: Record<string, number> = { TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0 };
      const matchesSlice = matches.slice(0, 10); // Run LangGraph on up to 10 findings per repo

      for (const match of matchesSlice) {
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
            `https://github.com/${repo.owner}/${repo.name}/blob/${match.commitSha || 'HEAD'}/${match.filePath}#L${match.lineNumber}`,
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
          totalEvaluated++;
          verdicts[finalState.verdict] = (verdicts[finalState.verdict] ?? 0) + 1;

          const icon = finalState.verdict === 'TRUE_POSITIVE' ? '🔴' : 
                       finalState.verdict === 'NEEDS_HUMAN_REVIEW' ? '🟡' : '⚪';
          console.log(`  ${icon} ${match.severity.padEnd(8)} ${match.patternId.padEnd(30)} ${match.filePath}:${match.lineNumber}  [conf:${finalState.confidenceScore.toFixed(2)}]`);
        } catch (e) {
          console.error(`  [!] evaluation persist failed: ${e}`);
        }
      }

      summaries.push({
        repo: `${repo.owner}/${repo.name}`,
        filesScanned: filesScannedTotal,
        matches: matches.length,
        evaluated: matchesSlice.length,
        scanMs: scanTime,
        verdicts,
        errors: errorsList
      });
    } catch (err) {
      const repoName = repo ? `${repo.owner}/${repo.name}` : `ID ${repoId}`;
      console.error(`\n[!] Error scanning repository ${repoName}: ${err}`);
      if (repo) {
        try {
          await d1.prepare(`UPDATE repositories SET last_scan_status = 'FAILED', last_scan_at = datetime('now') WHERE id = ?`)
            .bind(repoId).run();
        } catch (dbErr) {
          console.error(`  [!] Failed to update status to FAILED in DB: ${dbErr}`);
        }
      }
      summaries.push({
        repo: repoName,
        filesScanned: 0,
        matches: 0,
        evaluated: 0,
        scanMs: 0,
        verdicts: { TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0 },
        errors: [`Repository scan failed completely: ${err instanceof Error ? err.message : String(err)}`]
      });
    }
  }

  await d1.prepare(`UPDATE scan_runs SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?`)
    .bind(scanRunId).run();

  // ─────────────────────────────────────────────────────────────────────────────
  // Report Generation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n[Phase 3] Generating Reports...');

  const aggregateVerdicts = {
    TRUE_POSITIVE: 0,
    NEEDS_HUMAN_REVIEW: 0,
    FALSE_POSITIVE: 0
  };
  for (const s of summaries) {
    aggregateVerdicts.TRUE_POSITIVE += s.verdicts.TRUE_POSITIVE || 0;
    aggregateVerdicts.NEEDS_HUMAN_REVIEW += s.verdicts.NEEDS_HUMAN_REVIEW || 0;
    aggregateVerdicts.FALSE_POSITIVE += s.verdicts.FALSE_POSITIVE || 0;
  }

  const elapsedSec = ((Date.now() - globalStart) / 1000).toFixed(1);

  // Write JSON report
  const jsonReport = {
    timestamp: new Date().toISOString(),
    elapsedSeconds: Number(elapsedSec),
    lookbackCursor: lookback24h,
    summary: {
      discovered: crawlResult.reposDiscovered,
      updated: crawlResult.reposUpdated,
      eligible: crawlResult.reposEligible.length,
      scanned: reposToScan.length,
      filesScanned: totalFilesScanned,
      totalFindings,
      totalEvaluated,
      verdicts: aggregateVerdicts
    },
    scannedRepositories: summaries
  };

  const jsonPath = join(ROOT, 'tests', 'workflow-report.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`✓ JSON Report generated at: ${jsonPath}`);

  // Write Markdown report
  const markdownReport = `
# RepoScout 24-Hour Workflow Scan Report

* **Generated At**: ${jsonReport.timestamp}
* **Search Window**: Pushed in the last 24 hours (since \`${lookback24h}\`)
* **Total Elapsed Time**: ${elapsedSec}s
* **AI Model**: \`${OLLAMA_MODEL}\` via Ollama (\`${OLLAMA_BASE}\`)

## Summary Metrics

| Metric | Count |
|--------|-------|
| Repos Discovered | ${jsonReport.summary.discovered} |
| Repos Updated | ${jsonReport.summary.updated} |
| Total Repos Eligible | ${jsonReport.summary.eligible} |
| Sample Repos Scanned | ${jsonReport.summary.scanned} |
| Files Scanned | ${jsonReport.summary.filesScanned} |
| Total Match Findings | ${jsonReport.summary.totalFindings} |
| Pipeline Evaluated | ${jsonReport.summary.totalEvaluated} |

## LangGraph Verification Results

* 🔴 **TRUE_POSITIVE**: ${aggregateVerdicts.TRUE_POSITIVE}
* 🟡 **NEEDS_HUMAN_REVIEW**: ${aggregateVerdicts.NEEDS_HUMAN_REVIEW}
* ⚪ **FALSE_POSITIVE**: ${aggregateVerdicts.FALSE_POSITIVE}

## Scanned Repositories Details

${summaries.map(s => `
### ${s.repo}
* **Files Scanned**: ${s.filesScanned}
* **Raw Matches**: ${s.matches} (Evaluated top ${s.evaluated})
* **Scan Time**: ${s.scanMs}ms
* **Verdicts**:
  * 🔴 True Positives: ${s.verdicts.TRUE_POSITIVE || 0}
  * 🟡 Needs Review: ${s.verdicts.NEEDS_HUMAN_REVIEW || 0}
  * ⚪ False Positives: ${s.verdicts.FALSE_POSITIVE || 0}
${s.errors.length ? `* **Errors**: ${s.errors.join('; ')}` : ''}
`).join('\n')}
`;

  const mdPath = join(ROOT, 'tests', 'workflow-report.md');
  writeFileSync(mdPath, markdownReport.trim());
  console.log(`✓ Markdown Report generated at: ${mdPath}`);

  // Print Summary
  console.log('\n================================================================');
  console.log('   WORKFLOW SCAN SUMMARY REPORT');
  console.log('================================================================');
  console.log(`  Elapsed Time       : ${elapsedSec}s`);
  console.log(`  Repos Discovered   : ${jsonReport.summary.discovered}`);
  console.log(`  Sample Repos Scanned: ${jsonReport.summary.scanned}`);
  console.log(`  Files Scanned      : ${jsonReport.summary.filesScanned}`);
  console.log(`  Total Match Findings: ${jsonReport.summary.totalFindings}`);
  console.log(`  LangGraph Evaluated: ${jsonReport.summary.totalEvaluated}`);
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`  Verdicts:`);
  console.log(`    🔴 TRUE_POSITIVE     : ${aggregateVerdicts.TRUE_POSITIVE}`);
  console.log(`    🟡 NEEDS_HUMAN_REVIEW: ${aggregateVerdicts.NEEDS_HUMAN_REVIEW}`);
  console.log(`    ⚪ FALSE_POSITIVE    : ${aggregateVerdicts.FALSE_POSITIVE}`);
  console.log('================================================================\n');

  rawDb.close();
}

function createEmptyReport(discovered: number, lookback: string) {
  const jsonReport = {
    timestamp: new Date().toISOString(),
    elapsedSeconds: 0,
    lookbackCursor: lookback,
    summary: {
      discovered,
      updated: 0,
      eligible: 0,
      scanned: 0,
      filesScanned: 0,
      totalFindings: 0,
      totalEvaluated: 0,
      verdicts: { TRUE_POSITIVE: 0, NEEDS_HUMAN_REVIEW: 0, FALSE_POSITIVE: 0 }
    },
    scannedRepositories: []
  };
  const jsonPath = join(ROOT, 'tests', 'workflow-report.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));

  const mdPath = join(ROOT, 'tests', 'workflow-report.md');
  writeFileSync(mdPath, `# RepoScout 24-Hour Workflow Scan Report\n\nNo eligible repositories pushed/updated in the last 24 hours.`);
}

main().catch(e => {
  console.error('[Fatal Error]', e);
  process.exit(1);
});
