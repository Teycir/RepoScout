// src/scan-worker/crawler.ts
// Autonomous GitHub crawler — discovers recently-pushed public repositories
// without requiring a manual seed list.
//
// Strategy:
//   1. Read the last-run cursor from KV ("crawler:since" key, ISO-8601).
//      On first run, defaults to 24 hours ago.
//   2. Page through GitHub Search API  (q=pushed:>SINCE is:public)
//      sorted by "updated", newest first — up to MAX_SEARCH_PAGES pages.
//   3. For repos already in D1: update pushed_at + mark for re-scan only if
//      pushed_at advanced (i.e. there are genuinely new commits).
//   4. For new repos: INSERT into repositories with source='crawler'.
//   5. Write the current run's start time as the new cursor into KV.
//
// GitHub Search rate limits:
//   Authenticated: 30 req/min (shared with the PAT pool).
//   Each search page = 1 request. We cap at MAX_SEARCH_PAGES = 5 → max 5
//   search requests per crawler run, well within budget.
//
// The crawler runs at the START of every scheduled scan, before the scan
// loop picks repos from D1.  This means newly-discovered repos are
// immediately eligible for scanning in the same cron invocation.

import type { Env } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SEARCH_PAGES    = 5;    // 5 pages × 30 items = up to 150 repos/run
const ITEMS_PER_PAGE      = 30;   // GitHub Search max per_page
const DEFAULT_LOOKBACK_H  = 24;   // hours to look back on first run
const KV_CURSOR_KEY       = 'crawler:since';
const KV_RUNID_KEY        = 'crawler:last_run_id';

// Topics / languages we actively want to scan — leave empty to scan everything.
// Having at least a language filter helps surface real code repos over mirrors.
const SEARCH_QUALIFIERS   = 'is:public -is:fork -is:archived language:JavaScript OR language:TypeScript OR language:Python OR language:Go OR language:Java OR language:Ruby OR language:PHP OR language:C OR language:C++ OR language:Rust OR language:Kotlin OR language:Swift';

// ---------------------------------------------------------------------------
// GitHub API types (minimal shape we need)
// ---------------------------------------------------------------------------

interface GitHubSearchItem {
  id:          number;
  full_name:   string;   // "owner/repo"
  html_url:    string;
  owner:       { login: string };
  name:        string;
  pushed_at:   string;   // ISO-8601
  size:        number;   // KB
  private:     boolean;
  fork:        boolean;
}

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubSearchItem[];
}

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export interface CrawlerResult {
  crawlerRunId:    string;
  reposDiscovered: number;   // net-new rows inserted
  reposUpdated:    number;   // existing rows whose pushed_at advanced
  reposEligible:   string[]; // repo IDs (D1 UUIDs) ready for immediate scan
  nextCursor:      string;   // ISO-8601 to persist for next run
  errors:          string[];
}

// ---------------------------------------------------------------------------
// Helper — build the GitHub Search query
// ---------------------------------------------------------------------------

function buildSearchQuery(since: string): string {
  // pushed:>SINCE  — repos with at least one push after this timestamp
  return `pushed:>${since} ${SEARCH_QUALIFIERS}`;
}

// ---------------------------------------------------------------------------
// Helper — safe GitHub Search fetch with rate-limit extraction
// ---------------------------------------------------------------------------

async function searchPage(
  token: string,
  query: string,
  page: number,
): Promise<{ items: GitHubSearchItem[]; remaining: number; resetIso: string | null }> {
  const params = new URLSearchParams({
    q:        query,
    sort:     'updated',
    order:    'desc',
    per_page: String(ITEMS_PER_PAGE),
    page:     String(page),
  });

  const res = await fetch(
    `https://api.github.com/search/repositories?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent':  'RepoScout-Crawler/1.0',
        Accept:        'application/vnd.github.v3+json',
      },
    },
  );

  const rawRemaining = res.headers.get('x-ratelimit-remaining');
  const rawReset     = res.headers.get('x-ratelimit-reset');
  const remaining    = rawRemaining != null ? parseInt(rawRemaining, 10) : 25;
  const resetIso     = rawReset != null
    ? new Date(parseInt(rawReset, 10) * 1000).toISOString()
    : null;

  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub Search rate-limited (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`GitHub Search HTTP ${res.status}`);
  }

  const body = await res.json() as GitHubSearchResponse;
  return { items: body.items ?? [], remaining, resetIso };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function discoverRepos(
  env: Env & Record<string, string>,
  rawToken: string,
): Promise<CrawlerResult> {
  const crawlerRunId = crypto.randomUUID();
  const errors: string[] = [];
  let reposDiscovered = 0;
  let reposUpdated    = 0;
  const reposEligible: string[] = [];

  // ------------------------------------------------------------------
  // 1. Determine the "since" cursor — default to 24 h ago on first run
  // ------------------------------------------------------------------
  const runStartedAt = new Date().toISOString();

  let since: string;
  try {
    const stored = await env.CACHE.get(KV_CURSOR_KEY);
    if (stored) {
      since = stored;
    } else {
      const d = new Date();
      d.setHours(d.getHours() - DEFAULT_LOOKBACK_H);
      since = d.toISOString();
    }
  } catch {
    const d = new Date();
    d.setHours(d.getHours() - DEFAULT_LOOKBACK_H);
    since = d.toISOString();
  }

  // ------------------------------------------------------------------
  // 2. Log the crawler run start in D1
  // ------------------------------------------------------------------
  try {
    await env.DB.prepare(
      `INSERT INTO crawler_runs (id, started_at, since_cursor, status)
       VALUES (?, datetime('now'), ?, 'RUNNING')`,
    ).bind(crawlerRunId, since).run();
  } catch (e) {
    errors.push(`Failed to create crawler_run record: ${e}`);
  }

  // ------------------------------------------------------------------
  // 3. Page through GitHub Search
  // ------------------------------------------------------------------
  const query        = buildSearchQuery(since.slice(0, 10)); // YYYY-MM-DD is enough
  const allItems: GitHubSearchItem[] = [];

  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    try {
      const { items, remaining } = await searchPage(rawToken, query, page);

      if (items.length === 0) break; // no more results

      allItems.push(...items);

      // Back off if we're burning through rate limit
      if (remaining < 5) {
        errors.push(`Crawler: search rate limit low (${remaining} remaining) — stopping early at page ${page}`);
        break;
      }
    } catch (e) {
      errors.push(`Crawler: search page ${page} failed: ${e}`);
      break; // stop paging on error
    }
  }

  // Deduplicate by full_name (same repo can appear on multiple pages if
  // updated between requests)
  const seen = new Set<string>();
  const uniqueItems = allItems.filter(item => {
    if (seen.has(item.full_name)) return false;
    seen.add(item.full_name);
    return true;
  });

  // ------------------------------------------------------------------
  // 4. Upsert into D1 repositories table
  // ------------------------------------------------------------------
  for (const item of uniqueItems) {
    // Skip forks and private repos (belt-and-suspenders, qualifiers already filter)
    if (item.private || item.fork) continue;

    const owner = item.owner.login;
    const name  = item.name;
    const url   = item.html_url;
    const pushedAt = item.pushed_at;

    try {
      // Check if repo already exists
      const existing = await env.DB
        .prepare(`SELECT id, pushed_at, last_scan_status FROM repositories WHERE owner = ? AND name = ?`)
        .bind(owner, name)
        .first<{ id: string; pushed_at: string | null; last_scan_status: string }>();

      if (existing) {
        // Repo already tracked — only re-queue if pushed_at advanced
        const prevPushed = existing.pushed_at ?? '1970-01-01T00:00:00Z';
        const hasNewPush = new Date(pushedAt) > new Date(prevPushed);

        if (hasNewPush && existing.last_scan_status !== 'RUNNING') {
          await env.DB
            .prepare(
              `UPDATE repositories
               SET pushed_at       = ?,
                   crawled_at      = datetime('now'),
                   last_scan_status = 'PENDING',
                   updated_at      = datetime('now')
               WHERE id = ?`,
            )
            .bind(pushedAt, existing.id)
            .run();

          reposUpdated++;
          reposEligible.push(existing.id);
        }
      } else {
        // Brand-new repo — insert it
        const newId = crypto.randomUUID();
        await env.DB
          .prepare(
            `INSERT INTO repositories
               (id, owner, name, url, source, pushed_at, crawled_at, last_scan_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'crawler', ?, datetime('now'), 'PENDING', datetime('now'), datetime('now'))`,
          )
          .bind(newId, owner, name, url, pushedAt)
          .run();

        reposDiscovered++;
        reposEligible.push(newId);
      }
    } catch (e) {
      errors.push(`Crawler: upsert failed for ${owner}/${name}: ${e}`);
    }
  }

  // ------------------------------------------------------------------
  // 5. Advance the KV cursor to now (so next run only sees newer pushes)
  // ------------------------------------------------------------------
  const nextCursor = runStartedAt;
  try {
    // TTL = 30 days — crawler state should survive Workers KV evictions
    await env.CACHE.put(KV_CURSOR_KEY, nextCursor, { expirationTtl: 30 * 24 * 60 * 60 });
    await env.CACHE.put(KV_RUNID_KEY,  crawlerRunId, { expirationTtl: 30 * 24 * 60 * 60 });
  } catch (e) {
    errors.push(`Crawler: failed to persist KV cursor: ${e}`);
  }

  // ------------------------------------------------------------------
  // 6. Close the crawler_run record
  // ------------------------------------------------------------------
  try {
    await env.DB
      .prepare(
        `UPDATE crawler_runs
         SET completed_at     = datetime('now'),
             repos_discovered = ?,
             repos_updated    = ?,
             next_cursor      = ?,
             status           = 'COMPLETED'
         WHERE id = ?`,
      )
      .bind(reposDiscovered, reposUpdated, nextCursor, crawlerRunId)
      .run();
  } catch (e) {
    errors.push(`Crawler: failed to close crawler_run: ${e}`);
  }

  console.log(
    `[crawler] Run ${crawlerRunId}: +${reposDiscovered} new, ` +
    `${reposUpdated} re-queued, ${reposEligible.length} eligible for scan. ` +
    `since=${since.slice(0, 16)}`,
  );

  return {
    crawlerRunId,
    reposDiscovered,
    reposUpdated,
    reposEligible,
    nextCursor,
    errors,
  };
}
