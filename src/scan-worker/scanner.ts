// src/scan-worker/scanner.ts
// Zipball streaming scanner — streams a GitHub repo archive and runs
// the SecretScout pattern engine on each file entry.
//
// Two scan modes (selected automatically):
//   1. Zipball   — for repos ≤ LARGE_REPO_KB (50 MB); single request, streaming fflate decompress
//   2. Git Trees — for repos > LARGE_REPO_KB;  recursive tree listing + per-file blob fetches

import { Unzip, UnzipInflate } from 'fflate';
import { scanSource, shouldSkipPath } from '../lib/scanner.js';
import type { Match, Template } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ZIPBALL_SIZE     = 150 * 1024 * 1024; // 150 MB hard abort
const MAX_MATCHES_PER_SCAN = 2_000;
const MAX_FILE_BYTES       = 10 * 1024 * 1024;  // 10 MB per file
const LARGE_REPO_KB        = 50_000;             // 50 MB in KB (GitHub repo.size unit)
const TREE_BATCH_SIZE      = 5;                  // concurrent blob fetches

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip',
  '.tar', '.gz', '.wasm', '.bin', '.dll', '.so',
  '.exe', '.dylib', '.map',
]);

// ---------------------------------------------------------------------------
// PAT pool helpers
// ---------------------------------------------------------------------------

export interface TokenRow {
  id: string;
  token_hash: string;
  masked_token: string;
  is_active: number;
  rate_limit_remaining: number;
  rate_limit_reset: string | null;
  last_used_at: string | null;
}

export async function pickNextToken(
  db: D1Database,
): Promise<{ token: string; row: TokenRow } | null> {
  const row = await db
    .prepare(
      `SELECT * FROM scan_tokens
       WHERE is_active = 1
         AND (rate_limit_reset IS NULL OR rate_limit_reset <= datetime('now'))
       ORDER BY rate_limit_remaining DESC
       LIMIT 1`
    )
    .first<TokenRow>();
  return row ? { token: row.masked_token, row } : null;
}

export async function recordTokenUsage(
  db: D1Database,
  tokenId: string,
  remaining: number,
  reset: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE scan_tokens
       SET rate_limit_remaining = ?,
           rate_limit_reset     = ?,
           last_used_at         = datetime('now')
       WHERE id = ?`
    )
    .bind(remaining, reset, tokenId)
    .run();
}

// ---------------------------------------------------------------------------
// Rate-limit header extraction
// ---------------------------------------------------------------------------

export interface RateLimitInfo {
  remaining: number;
  resetIso: string | null;
}

/**
 * Reads x-ratelimit-remaining and x-ratelimit-reset from any GitHub API
 * response and returns them in the shape expected by recordTokenUsage().
 * Falls back gracefully when headers are absent (e.g. redirect responses).
 */
function extractRateLimit(res: Response): RateLimitInfo {
  const rawRemaining = res.headers.get('x-ratelimit-remaining');
  const rawReset     = res.headers.get('x-ratelimit-reset');

  const remaining = rawRemaining != null ? parseInt(rawRemaining, 10) : 4999;
  const resetIso  = rawReset != null
    ? new Date(parseInt(rawReset, 10) * 1000).toISOString()
    : null;

  return { remaining: isNaN(remaining) ? 4999 : remaining, resetIso };
}

// ---------------------------------------------------------------------------
// Shared result type
// ---------------------------------------------------------------------------

export interface ZipballScanResult {
  matches:       Match[];
  filesScanned:  number;
  bytesRead:     number;
  errors:        string[];
  rateLimit:     RateLimitInfo;   // from the primary GitHub request
}

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

async function githubGet(
  path: string,
  token: string,
): Promise<{ body: unknown; rateLimit: RateLimitInfo }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization:  `Bearer ${token}`,
      'User-Agent':   'RepoScout-Scanner/1.0',
      Accept:         'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} → HTTP ${res.status}`);
  }
  const body = await res.json();
  return { body, rateLimit: extractRateLimit(res) };
}

// ---------------------------------------------------------------------------
// Mode 1 — Zipball streaming scan
// ---------------------------------------------------------------------------

async function scanViaZipball(
  owner: string,
  repo: string,
  githubToken: string,
  templates: Template[],
  ref: string = 'HEAD',
): Promise<ZipballScanResult> {
  const allMatches: Match[] = [];
  const errors: string[] = [];
  let filesScanned = 0;
  let bytesRead    = 0;

  const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${ref}`;
  const res = await fetch(zipUrl, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      'User-Agent':  'RepoScout-Scanner/1.0',
      Accept:        'application/vnd.github.v3+json',
    },
    redirect: 'follow',
  });

  // Capture rate-limit headers from the initial (pre-redirect) response.
  // After a redirect the response object reflects the final hop; GitHub sets
  // x-ratelimit-* on the first 302, but fetch() with redirect:'follow' gives
  // us the final 200 — the headers are still present on the redirected URL.
  const rateLimit = extractRateLimit(res);

  if (!res.ok || !res.body) {
    return {
      matches:      [],
      filesScanned: 0,
      bytesRead:    0,
      errors:       [`HTTP ${res.status} fetching zipball for ${owner}/${repo}`],
      rateLimit,
    };
  }

  await new Promise<void>((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);

    unzip.onfile = (file) => {
      const filePath = file.name;

      if (shouldSkipPath(filePath)) { file.terminate?.(); return; }

      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      if (BINARY_EXTS.has(ext)) { file.terminate?.(); return; }

      const chunks: Uint8Array[] = [];
      let fileSize = 0;

      file.ondata = (_err, chunk, final) => {
        if (_err) {
          errors.push(`Decompress error in ${filePath}: ${_err}`);
          return;
        }

        fileSize  += chunk.length;
        bytesRead += chunk.length;

        if (fileSize > MAX_FILE_BYTES) {
          chunks.length = 0; // drop oversized file
        } else {
          chunks.push(chunk);
        }

        if (final && chunks.length > 0) {
          try {
            const buf = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            let off = 0;
            for (const c of chunks) { buf.set(c, off); off += c.length; }

            const source = new TextDecoder('utf-8', { fatal: false }).decode(buf);
            const hits   = scanSource(source, templates, { filePath, maxMatches: 100 });

            for (const m of hits) {
              if (allMatches.length < MAX_MATCHES_PER_SCAN) allMatches.push(m);
            }
            filesScanned++;
          } catch (e) {
            errors.push(`Scan error in ${filePath}: ${e}`);
          }
        }
      };

      file.start();
    };

    const reader = res.body!.getReader();

    function pump(): void {
      reader.read().then(({ done, value }) => {
        if (done) {
          unzip.push(new Uint8Array(0), true);
          resolve();
          return;
        }
        if (bytesRead > MAX_ZIPBALL_SIZE) {
          errors.push(`${owner}/${repo}: zipball exceeded 150 MB — scan truncated`);
          reader.cancel().catch(() => undefined);
          resolve();
          return;
        }
        unzip.push(value!);
        pump();
      }).catch(reject);
    }

    pump();
  });

  return { matches: allMatches, filesScanned, bytesRead, errors, rateLimit };
}

// ---------------------------------------------------------------------------
// Mode 2 — Git Trees API fallback (large repos > 50 MB)
// ---------------------------------------------------------------------------

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number;
  url:  string;
}

async function scanViaGitTrees(
  owner: string,
  repo: string,
  githubToken: string,
  templates: Template[],
  ref: string = 'HEAD',
): Promise<ZipballScanResult> {
  const allMatches: Match[] = [];
  const errors: string[] = [];
  let filesScanned = 0;
  let bytesRead    = 0;
  let rateLimit: RateLimitInfo = { remaining: 4999, resetIso: null };

  // Fetch full recursive tree
  const treePath = `/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  let tree: TreeEntry[];
  try {
    const { body, rateLimit: rl } = await githubGet(treePath, githubToken);
    rateLimit = rl;
    const data = body as { tree: TreeEntry[]; truncated: boolean };
    if (data.truncated) {
      errors.push(`${owner}/${repo}: tree truncated by GitHub — very large repo, some files skipped`);
    }
    tree = data.tree.filter(
      (e) =>
        e.type === 'blob' &&
        !shouldSkipPath(e.path) &&
        !(e.size > MAX_FILE_BYTES) &&
        (() => {
          const ext = e.path.slice(e.path.lastIndexOf('.')).toLowerCase();
          return !BINARY_EXTS.has(ext);
        })()
    );
  } catch (e) {
    return {
      matches:      [],
      filesScanned: 0,
      bytesRead:    0,
      errors:       [`Failed to fetch tree for ${owner}/${repo}: ${e}`],
      rateLimit,
    };
  }

  // Fetch blobs in batches of TREE_BATCH_SIZE
  for (let i = 0; i < tree.length; i += TREE_BATCH_SIZE) {
    if (allMatches.length >= MAX_MATCHES_PER_SCAN) break;

    const batch = tree.slice(i, i + TREE_BATCH_SIZE);
    await Promise.all(
      batch.map(async (entry) => {
        if (allMatches.length >= MAX_MATCHES_PER_SCAN) return;
        try {
          const { body, rateLimit: rl } = await githubGet(
            `/repos/${owner}/${repo}/contents/${entry.path}`,
            githubToken,
          );
          rateLimit = rl; // keep the most recent rate-limit reading

          const file = body as { content?: string; encoding?: string };
          if (!file.content || file.encoding !== 'base64') return;

          const decoded = atob(file.content.replace(/\n/g, ''));
          bytesRead += decoded.length;

          const hits = scanSource(decoded, templates, { filePath: entry.path, maxMatches: 100 });
          for (const m of hits) {
            if (allMatches.length < MAX_MATCHES_PER_SCAN) allMatches.push(m);
          }
          filesScanned++;
        } catch (e) {
          errors.push(`Blob fetch error for ${entry.path}: ${e}`);
        }
      })
    );
  }

  return { matches: allMatches, filesScanned, bytesRead, errors, rateLimit };
}

// ---------------------------------------------------------------------------
// Public entry point — auto-selects mode based on repo size
// ---------------------------------------------------------------------------

/**
 * Scans a GitHub repository for secrets.
 *
 * Automatically selects zipball streaming (fast, one request) for repos under
 * 50 MB, and falls back to the Git Trees API (slower, N+1 requests) for larger
 * repos that would exceed the Worker memory limit.
 *
 * The returned `rateLimit` field contains the x-ratelimit-remaining /
 * x-ratelimit-reset values extracted from the primary GitHub response, ready
 * to be passed directly to `recordTokenUsage()`.
 */
export async function scanRepo(
  owner: string,
  repo: string,
  githubToken: string,
  templates: Template[],
  ref: string = 'HEAD',
): Promise<ZipballScanResult> {
  // Check repo size to decide which mode to use
  let repoSizeKb = 0;
  try {
    const { body } = await githubGet(`/repos/${owner}/${repo}`, githubToken);
    repoSizeKb = (body as { size?: number }).size ?? 0;
  } catch {
    // If we can't get metadata, attempt zipball anyway
  }

  if (repoSizeKb > LARGE_REPO_KB) {
    console.log(
      `[scanner] ${owner}/${repo} is ${repoSizeKb} KB > ${LARGE_REPO_KB} KB — using Git Trees API`
    );
    return scanViaGitTrees(owner, repo, githubToken, templates, ref);
  }

  return scanViaZipball(owner, repo, githubToken, templates, ref);
}

// ---------------------------------------------------------------------------
// Backwards-compatible alias (used by tests / legacy callers)
// ---------------------------------------------------------------------------

/** @deprecated Use scanRepo() which auto-selects the optimal scan mode. */
export async function scanZipball(
  zipUrl: string,
  githubToken: string,
  templates: Template[],
): Promise<ZipballScanResult> {
  // Extract owner/repo from the zipball URL:
  // https://api.github.com/repos/{owner}/{repo}/zipball/HEAD
  const match = zipUrl.match(/\/repos\/([^/]+)\/([^/]+)\/zipball/);
  if (match) {
    const [, owner, repo] = match as [string, string, string];
    return scanViaZipball(owner, repo, githubToken, templates);
  }
  // Fallback: construct a dummy result — caller should migrate to scanRepo()
  return {
    matches:      [],
    filesScanned: 0,
    bytesRead:    0,
    errors:       [`scanZipball: could not parse owner/repo from URL: ${zipUrl}`],
    rateLimit:    { remaining: 4999, resetIso: null },
  };
}
