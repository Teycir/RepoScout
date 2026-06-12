// src/scan-worker/index.ts
// Cloudflare Worker entry — fetch (manual trigger) + scheduled (hourly cron).

import type { Env, Template } from "../lib/types.js";
import { scanRepo, pickNextToken, recordTokenUsage } from "./scanner.js";
import { createScanValidationGraph, persistEvaluation } from "./pipeline.js";
import { recalculateRepoMetrics } from "../../lib/db.js";
import templates from "./patterns.json";

const COMPILED_TEMPLATES = templates as Template[];
const MAX_CONCURRENT_REPOS = 3;

// ---------------------------------------------------------------------------
// Raw token injection
// Raw PATs are injected as GITHUB_TOKEN_1 … GITHUB_TOKEN_10 wrangler secrets.
// We read them from env at runtime (not from D1, which stores only hashes).
// ---------------------------------------------------------------------------

function getRawTokens(env: Env & Record<string, string>): string[] {
  const tokens: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = env[`GITHUB_TOKEN_${i}`];
    if (t) tokens.push(t);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Round-robin token picker
// Uses D1's rate-limit-aware selection; falls back to sequential env order.
// ---------------------------------------------------------------------------

let tokenFallbackIndex = 0;

async function getNextToken(
  env: Env & Record<string, string>,
  rawTokens: string[],
): Promise<{ token: string; tokenId: string | null }> {
  try {
    const row = await pickNextToken(env.DB);
    if (row) {
      // Match raw token by masked suffix (last 4 chars of masked_token after "****")
      // masked_token format: "ghp_****abcd" — suffix is the last 4 visible chars
      const suffix = row.row.masked_token.slice(-4);
      const matched = rawTokens.find((t) => t.endsWith(suffix));
      if (matched) return { token: matched, tokenId: row.row.id };
      // Suffix match failed (hash-only storage) — fall through to index-based
    }
  } catch {
    // D1 unavailable — fall through to env-based round-robin
  }
  const idx = tokenFallbackIndex % rawTokens.length;
  tokenFallbackIndex++;
  return { token: rawTokens[idx] ?? rawTokens[0]!, tokenId: null };
}

// ---------------------------------------------------------------------------
// Main scan loop
// ---------------------------------------------------------------------------

async function runScan(
  env: Env & Record<string, string>,
  repoId?: string,
): Promise<void> {
  const rawTokens = getRawTokens(env);
  if (rawTokens.length === 0) {
    console.error(
      "[scan-worker] No GITHUB_TOKEN_* secrets found — aborting scan",
    );
    return;
  }

  // Pick repos from D1 — optionally filter to a single repo
  const query = repoId
    ? env.DB.prepare(
        `SELECT id, owner, name, url, last_scan_at FROM repositories
         WHERE id = ? AND last_scan_status != 'RUNNING'`,
      ).bind(repoId)
    : env.DB.prepare(
        `SELECT id, owner, name, url, last_scan_at FROM repositories
         WHERE last_scan_status != 'RUNNING'
         ORDER BY last_scan_at ASC NULLS FIRST
         LIMIT ?`,
      ).bind(MAX_CONCURRENT_REPOS);

  const { results: repos } = await query.all<{
    id: string;
    owner: string;
    name: string;
    url: string;
    last_scan_at: string | null;
  }>();

  if (repos.length === 0) {
    console.log("[scan-worker] No repos to scan");
    return;
  }

  // Create scan run record
  const scanRunId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO scan_runs (id, started_at, status) VALUES (?, datetime('now'), 'RUNNING')`,
  )
    .bind(scanRunId)
    .run();

  let totalFindings = 0,
    truePositives = 0,
    needsReview = 0,
    falsePositives = 0;

  const pipeline = createScanValidationGraph({
    DB: env.DB,
    CACHE: env.CACHE,
    AI: env.AI,
  });

  // Scan each repo sequentially (Workers CPU budget)
  for (const repo of repos) {
    // Mark repo as scanning
    await env.DB.prepare(
      `UPDATE repositories SET last_scan_status = 'RUNNING' WHERE id = ?`,
    )
      .bind(repo.id)
      .run();

    const { token, tokenId } = await getNextToken(env, rawTokens);

    console.log(`[scan-worker] Scanning ${repo.owner}/${repo.name}`);

    const { matches, filesScanned, errors, rateLimit } = await scanRepo(
      repo.owner,
      repo.name,
      token,
      COMPILED_TEMPLATES,
    );

    if (errors.length > 0) {
      console.warn(
        `[scan-worker] ${errors.length} errors in ${repo.owner}/${repo.name}:`,
        errors.slice(0, 3),
      );
    }

    console.log(
      `[scan-worker] ${repo.owner}/${repo.name}: ${matches.length} matches in ${filesScanned} files`,
    );
    totalFindings += matches.length;

    // Sync rate-limit headers back to D1 so the token pool stays accurate
    if (tokenId) {
      try {
        await recordTokenUsage(
          env.DB,
          tokenId,
          rateLimit.remaining,
          rateLimit.resetIso,
        );
      } catch {
        /* non-critical */
      }
    }

    // Persist each match + run through pipeline
    for (const match of matches) {
      const findingId = crypto.randomUUID();
      const fileUrl = `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${match.filePath}#L${match.lineNumber}`;

      // Persist finding — use ON CONFLICT DO UPDATE to ensure we don't duplicate rows
      // and we refresh scan_run_id and detected_at, returning the persistent/active finding ID.
      const row = await env.DB.prepare(
        `INSERT INTO findings
             (id, scan_run_id, repo_id, file_path, file_url, line_number, matched_text,
              line_content, context, pattern_id, template_id, severity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo_id, file_path, line_number, pattern_id, matched_text)
           DO UPDATE SET
             scan_run_id = excluded.scan_run_id,
             detected_at = excluded.detected_at
           RETURNING id`,
      )
        .bind(
          findingId,
          scanRunId,
          repo.id,
          match.filePath,
          fileUrl,
          match.lineNumber,
          match.matchedText, // already masked
          match.context.split("\n")[0] ?? "",
          JSON.stringify(match.context.split("\n")),
          match.patternId,
          match.templateId,
          match.severity,
        )
        .first<{ id: string }>();

      const activeFindingId = row?.id ?? findingId;

      // Run LangGraph pipeline
      const finalState = await pipeline.invoke({
        findingId: activeFindingId,
        repoName: `${repo.owner}/${repo.name}`,
        filePath: match.filePath,
        lineNumber: match.lineNumber,
        matchedText: match.matchedText,
        rawMatchedText: match.rawMatchedText,
        lineContent: match.context.split("\n")[0] ?? "",
        surroundingContext: match.context,
        patternId: match.patternId,
        templateId: match.templateId,
        severity: match.severity,
        isHeuristicPlaceholder: false,
        validationStatus: "UNVERIFIABLE" as const,
        verdict: "NEEDS_HUMAN_REVIEW" as const,
        aiReasoning: "",
        confidenceScore: 0,
        riskScore: 0,
        validationMethod: "heuristic" as const,
      });

      // Persist evaluation
      await persistEvaluation(env.DB, {
        findingId: activeFindingId,
        verdict: finalState.verdict,
        confidence: finalState.confidenceScore,
        validationMethod: finalState.validationMethod,
        validationStatus: finalState.validationStatus ?? "UNVERIFIABLE",
        reasoning: finalState.aiReasoning,
        riskScore: finalState.riskScore,
      });

      if (finalState.verdict === "TRUE_POSITIVE") truePositives++;
      else if (finalState.verdict === "NEEDS_HUMAN_REVIEW") needsReview++;
      else falsePositives++;
    }

    // Recalculate metrics dynamically directly from findings & evaluations
    await recalculateRepoMetrics(env.DB, repo.id);

    // Set last scan metadata
    await env.DB.prepare(
      `UPDATE repositories
         SET last_scan_at     = datetime('now'),
             last_scan_status = 'COMPLETED'
         WHERE id = ?`,
    )
      .bind(repo.id)
      .run();
  }

  // Close scan run
  await env.DB.prepare(
    `UPDATE scan_runs SET
         completed_at        = datetime('now'),
         total_repos_scanned = ?,
         total_findings      = ?,
         true_positives      = ?,
         needs_human_review  = ?,
         false_positives     = ?,
         status              = 'COMPLETED'
       WHERE id = ?`,
  )
    .bind(
      repos.length,
      totalFindings,
      truePositives,
      needsReview,
      falsePositives,
      scanRunId,
    )
    .run();

  console.log(
    `[scan-worker] Scan run ${scanRunId} complete: ` +
      `${totalFindings} findings across ${repos.length} repos`,
  );
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env & Record<string, string>,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/trigger") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed — use POST /api/trigger", {
          status: 405,
        });
      }
      let body: { repoId?: string; dryRun?: boolean } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body = full scan */
      }
      // Fire-and-forget; Workers runtime keeps the handler alive
      void runScan(env, body.repoId).catch((e) =>
        console.error("[scan-worker] Scan error:", e),
      );
      return Response.json({ ok: true, message: "Scan triggered" });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }

    return new Response("RepoScout Scan Worker — POST /api/trigger to scan", {
      status: 200,
    });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env & Record<string, string>,
  ): Promise<void> {
    console.log(
      `[scan-worker] Scheduled trigger at ${new Date().toISOString()}`,
    );
    await runScan(env);
  },
};
