// lib/db.ts
// D1 query helpers for RepoScout dashboard pages.
// All functions accept env.DB (D1Database) and return typed results.

import type { Severity, Verdict } from "@/src/lib/types";

// ---------------------------------------------------------------------------
// Row shapes returned from D1
// ---------------------------------------------------------------------------

export interface RepoRow {
  id: string;
  owner: string;
  name: string;
  url: string;
  risk_score: number;
  high_severity_findings: number;
  critical_severity_findings: number;
  last_scan_at: string | null;
  last_scan_status: string;
}

export interface FindingRow {
  id: string;
  repo_id: string;
  file_path: string;
  file_url: string;
  line_number: number;
  matched_text: string;
  line_content: string;
  context: string;
  pattern_id: string;
  template_id: string;
  severity: Severity;
  detected_at: string;
}

export interface EvalRow {
  id: string;
  finding_id: string;
  verdict: Verdict; // effective verdict: analyst_verdict if set, otherwise AI verdict
  ai_verdict: Verdict; // original AI-assigned verdict, always reflects the pipeline output
  confidence: number;
  validation_method: string;
  validation_status: string;
  reasoning: string;
  external_response: string | null;
  evaluated_at: string;
  analyst_reviewed: number;
  analyst_verdict: string | null;
}

export interface ScanRunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  total_repos_scanned: number;
  total_findings: number;
  true_positives: number;
  needs_human_review: number;
  false_positives: number;
  status: string;
}

// Combined finding + eval for the inspector / review queue
export interface FindingWithEval extends FindingRow {
  eval: EvalRow | null;
  repo_owner: string;
  repo_name: string;
  /** Number of completed scan runs that have occurred since this finding was first detected.
   *  Computed by the DB query: used to drive the NEW tag (new = scans_since_detected <= 6). */
  scans_since_detected: number;
}

// ---------------------------------------------------------------------------
// Dashboard summary counters
// ---------------------------------------------------------------------------

export interface DashboardStats {
  totalRepos: number;
  criticalFindings: number;
  analystQueueCount: number;
  lastScanAt: string | null;
}

export async function getDashboardStats(
  db: D1Database,
): Promise<DashboardStats> {
  const [repos, critical, queue, lastScan] = await Promise.all([
    db.prepare("SELECT COUNT(*) as n FROM repositories").first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as n FROM findings f JOIN ai_evaluations e ON e.finding_id = f.id
       WHERE f.severity IN ('critical','high')
         AND COALESCE(e.analyst_verdict, e.verdict) = 'TRUE_POSITIVE'`,
      )
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) as n FROM ai_evaluations WHERE verdict = 'NEEDS_HUMAN_REVIEW' AND analyst_reviewed = 0",
      )
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT started_at FROM scan_runs WHERE status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1",
      )
      .first<{ started_at: string }>(),
  ]);

  return {
    totalRepos: repos?.n ?? 0,
    criticalFindings: critical?.n ?? 0,
    analystQueueCount: queue?.n ?? 0,
    lastScanAt: lastScan?.started_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Repository risk grid
// ---------------------------------------------------------------------------

export async function getRepositories(
  db: D1Database,
  limit = 50,
): Promise<RepoRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, owner, name, url, risk_score, high_severity_findings,
              critical_severity_findings, last_scan_at, last_scan_status
       FROM repositories
       ORDER BY risk_score DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<RepoRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Findings for a repo
// ---------------------------------------------------------------------------

export async function getFindingsForRepo(
  db: D1Database,
  repoId: string,
  limit = 100,
): Promise<FindingWithEval[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, e.id as eval_id, e.verdict, e.confidence, e.validation_method,
              e.validation_status, e.reasoning, e.external_response, e.evaluated_at,
              e.analyst_reviewed, e.analyst_verdict,
              r.owner as repo_owner, r.name as repo_name,
              (
                SELECT COUNT(*) FROM scan_runs s
                WHERE s.status = 'COMPLETED'
                  AND s.completed_at > f.detected_at
              ) AS scans_since_detected
       FROM findings f
       JOIN repositories r ON r.id = f.repo_id
       LEFT JOIN ai_evaluations e ON e.finding_id = f.id
       WHERE f.repo_id = ?
       ORDER BY
         CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         f.detected_at DESC
       LIMIT ?`,
    )
    .bind(repoId, limit)
    .all<any>();

  return results.map(reshapeWithEval);
}

// ---------------------------------------------------------------------------
// Analyst review queue
// ---------------------------------------------------------------------------

export async function getAnalystQueue(
  db: D1Database,
  limit = 100,
): Promise<FindingWithEval[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, e.id as eval_id, e.verdict, e.confidence, e.validation_method,
              e.validation_status, e.reasoning, e.external_response, e.evaluated_at,
              e.analyst_reviewed, e.analyst_verdict,
              r.owner as repo_owner, r.name as repo_name,
              (
                SELECT COUNT(*) FROM scan_runs s
                WHERE s.status = 'COMPLETED'
                  AND s.completed_at > f.detected_at
              ) AS scans_since_detected
       FROM findings f
       JOIN repositories r ON r.id = f.repo_id
       LEFT JOIN ai_evaluations e ON e.finding_id = f.id
       WHERE e.verdict = 'NEEDS_HUMAN_REVIEW' AND (e.analyst_reviewed = 0 OR e.analyst_reviewed IS NULL)
       ORDER BY
         CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         e.confidence DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<any>();

  return results.map(reshapeWithEval);
}

// ---------------------------------------------------------------------------
// Mark analyst reviewed
// ---------------------------------------------------------------------------

export async function recalculateRepoMetrics(
  db: D1Database,
  repoId: string,
): Promise<void> {
  // Recompute risk_score, high_severity_findings, critical_severity_findings
  // for this repo using the effective verdict (analyst override wins).
  // Severity weights: critical=100, high=40, medium=15, low=5, info=1
  // Verdict multipliers: TRUE_POSITIVE=2.0, NEEDS_HUMAN_REVIEW=1.0, FALSE_POSITIVE=0.0
  await db
    .prepare(
      `UPDATE repositories
       SET
         risk_score = (
           SELECT COALESCE(SUM(
             CASE COALESCE(e.analyst_verdict, e.verdict)
               WHEN 'TRUE_POSITIVE'      THEN 2.0
               WHEN 'NEEDS_HUMAN_REVIEW' THEN 1.0
               ELSE                           0.0
             END *
             CASE f.severity
               WHEN 'critical' THEN 100.0
               WHEN 'high'     THEN  40.0
               WHEN 'medium'   THEN  15.0
               WHEN 'low'      THEN   5.0
               ELSE                   1.0
             END
           ), 0.0)
           FROM findings f
           LEFT JOIN ai_evaluations e ON e.finding_id = f.id
           WHERE f.repo_id = ?
         ),
         high_severity_findings = (
           SELECT COUNT(*)
           FROM findings f
           LEFT JOIN ai_evaluations e ON e.finding_id = f.id
           WHERE f.repo_id = ?
             AND f.severity = 'high'
             AND COALESCE(e.analyst_verdict, e.verdict) = 'TRUE_POSITIVE'
         ),
         critical_severity_findings = (
           SELECT COUNT(*)
           FROM findings f
           LEFT JOIN ai_evaluations e ON e.finding_id = f.id
           WHERE f.repo_id = ?
             AND f.severity = 'critical'
             AND COALESCE(e.analyst_verdict, e.verdict) = 'TRUE_POSITIVE'
         ),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(repoId, repoId, repoId, repoId)
    .run();
}

export async function markAnalystReviewed(
  db: D1Database,
  evalId: string,
  verdict: Verdict,
): Promise<boolean> {
  // Step 1: stamp the override on the evaluation row
  const update = await db
    .prepare(
      `UPDATE ai_evaluations SET analyst_reviewed = 1, analyst_verdict = ? WHERE id = ?`,
    )
    .bind(verdict, evalId)
    .run();

  if (update.meta.changes === 0) return false; // evalId doesn't exist

  // Step 2: look up which repo owns this finding so we can resync its cached
  // counters. analyst_verdict supersedes verdict for display and risk purposes,
  // so we recompute both columns from the effective verdict (analyst_verdict
  // when set, otherwise verdict).
  const row = await db
    .prepare(
      `SELECT f.repo_id
       FROM ai_evaluations e
       JOIN findings f ON f.id = e.finding_id
       WHERE e.id = ?`,
    )
    .bind(evalId)
    .first<{ repo_id: string }>();

  if (!row) return true; // orphaned eval — update succeeded, nothing to resync

  await recalculateRepoMetrics(db, row.repo_id);
  return true;
}

// ---------------------------------------------------------------------------
// Rich stats for the /stats page
// ---------------------------------------------------------------------------

export interface SeverityStats {
  severity: string;
  total: number;
  true_positives: number;
  false_positives: number;
  needs_review: number;
}

export interface VerdictStats {
  true_positives:   number;
  false_positives:  number;
  needs_review:     number;
  pending:          number;
  analyst_reviewed: number;
}

export interface TopRiskyRepo {
  id:          string;
  owner:       string;
  name:        string;
  risk_score:  number;
  critical:    number;
  high:        number;
}

export interface ScanTrend {
  date:            string;
  total_findings:  number;
  true_positives:  number;
  false_positives: number;
}

export interface FullStats {
  severity:   SeverityStats[];
  verdicts:   VerdictStats;
  topRepos:   TopRiskyRepo[];
  scanTrends: ScanTrend[];
  totalFindings: number;
  totalRepos:    number;
  scansRun:      number;
}

export async function getFullStats(db: D1Database): Promise<FullStats> {
  const [severityRows, verdictRow, topRepoRows, trendRows, totals] = await Promise.all([
    // Severity breakdown with verdict splits
    db.prepare(`
      SELECT f.severity,
             COUNT(*) AS total,
             SUM(CASE WHEN COALESCE(e.analyst_verdict, e.verdict) = 'TRUE_POSITIVE'      THEN 1 ELSE 0 END) AS true_positives,
             SUM(CASE WHEN COALESCE(e.analyst_verdict, e.verdict) = 'FALSE_POSITIVE'     THEN 1 ELSE 0 END) AS false_positives,
             SUM(CASE WHEN COALESCE(e.analyst_verdict, e.verdict) = 'NEEDS_HUMAN_REVIEW' THEN 1 ELSE 0 END) AS needs_review
      FROM findings f
      LEFT JOIN ai_evaluations e ON e.finding_id = f.id
      GROUP BY f.severity
      ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                               WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END
    `).all<SeverityStats>(),

    // Global verdict counts
    db.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(e.analyst_verdict, e.verdict) = 'TRUE_POSITIVE'      THEN 1 ELSE 0 END) AS true_positives,
        SUM(CASE WHEN COALESCE(e.analyst_verdict, e.verdict) = 'FALSE_POSITIVE'     THEN 1 ELSE 0 END) AS false_positives,
        SUM(CASE WHEN COALESCE(e.analyst_verdict, e.verdict) = 'NEEDS_HUMAN_REVIEW' THEN 1 ELSE 0 END) AS needs_review,
        SUM(CASE WHEN e.id IS NULL                                                   THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN e.analyst_reviewed = 1                                         THEN 1 ELSE 0 END) AS analyst_reviewed
      FROM findings f
      LEFT JOIN ai_evaluations e ON e.finding_id = f.id
    `).first<VerdictStats>(),

    // Top 10 repos by risk score
    db.prepare(`
      SELECT id, owner, name, risk_score,
             critical_severity_findings AS critical,
             high_severity_findings     AS high
      FROM repositories
      ORDER BY risk_score DESC
      LIMIT 10
    `).all<TopRiskyRepo>(),

    // Last 14 scan-run trend points
    db.prepare(`
      SELECT DATE(started_at) AS date,
             SUM(total_findings)  AS total_findings,
             SUM(true_positives)  AS true_positives,
             SUM(false_positives) AS false_positives
      FROM scan_runs
      WHERE status = 'COMPLETED'
      GROUP BY DATE(started_at)
      ORDER BY date DESC
      LIMIT 14
    `).all<ScanTrend>(),

    // Totals
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM findings)      AS totalFindings,
        (SELECT COUNT(*) FROM repositories)  AS totalRepos,
        (SELECT COUNT(*) FROM scan_runs WHERE status = 'COMPLETED') AS scansRun
    `).first<{ totalFindings: number; totalRepos: number; scansRun: number }>(),
  ]);

  return {
    severity:      severityRows.results,
    verdicts:      verdictRow ?? { true_positives: 0, false_positives: 0, needs_review: 0, pending: 0, analyst_reviewed: 0 },
    topRepos:      topRepoRows.results,
    scanTrends:    trendRows.results.reverse(), // oldest → newest for chart
    totalFindings: totals?.totalFindings ?? 0,
    totalRepos:    totals?.totalRepos    ?? 0,
    scansRun:      totals?.scansRun      ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Recent scan runs
// ---------------------------------------------------------------------------

export async function getRecentScanRuns(
  db: D1Database,
  limit = 10,
): Promise<ScanRunRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?`)
    .bind(limit)
    .all<ScanRunRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function reshapeWithEval(row: any): FindingWithEval {
  // analyst_verdict, when set, is the authoritative verdict for UI rendering.
  // Use it as the displayed verdict so overridden findings move sections.
  const effectiveVerdict: Verdict =
    (row.analyst_verdict as Verdict) ?? (row.verdict as Verdict);

  const evalRow: EvalRow | null = row.eval_id
    ? {
        id: row.eval_id,
        finding_id: row.id,
        verdict: effectiveVerdict, // ← effective (analyst wins)
        ai_verdict: row.verdict as Verdict, // ← original pipeline verdict
        confidence: row.confidence,
        validation_method: row.validation_method,
        validation_status: row.validation_status,
        reasoning: row.reasoning,
        external_response: row.external_response,
        evaluated_at: row.evaluated_at,
        analyst_reviewed: row.analyst_reviewed,
        analyst_verdict: row.analyst_verdict,
      }
    : null;

  return {
    id: row.id,
    repo_id: row.repo_id,
    file_path: row.file_path,
    file_url: row.file_url,
    line_number: row.line_number,
    matched_text: row.matched_text,
    line_content: row.line_content,
    context: row.context,
    pattern_id: row.pattern_id,
    template_id: row.template_id,
    severity: row.severity,
    detected_at: row.detected_at,
    repo_owner: row.repo_owner,
    repo_name: row.repo_name,
    scans_since_detected: row.scans_since_detected ?? 0,
    eval: evalRow,
  };
}
