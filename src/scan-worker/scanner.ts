// src/scan-worker/scanner.ts
// Zipball streaming scanner — streams a GitHub repo archive and runs
// the SecretScout pattern engine on each file entry.
//
// Two scan modes (selected automatically):
//   1. Zipball   — for repos ≤ LARGE_REPO_KB (50 MB); single request, streaming fflate decompress
//   2. Git Trees — for repos > LARGE_REPO_KB;  recursive tree listing + per-file blob fetches

import { Unzip, UnzipInflate } from 'fflate';
import { scanSource, shouldSkipPath } from '../lib/scanner.js';
import type { Match, Template, ScanError } from '../lib/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ZIPBALL_SIZE     = 150 * 1024 * 1024; // 150 MB hard abort
const MAX_MATCHES_PER_SCAN = 2_000;
const MAX_FILE_BYTES       = 10 * 1024 * 1024;  // 10 MB per file
const LARGE_REPO_KB        = 50_000;             // 50 MB in KB (GitHub repo.size unit)
const MAX_REPO_SIZE_KB     = 500_000;            // 500 MB in KB (skip scans above this)
// TREE_BATCH_SIZE: Balance between parallelism and rate-limit consumption.
// 5 concurrent requests × 20 batches = 100 API calls (leaves ~4900 quota).
// Lower = slower scans but safer rate-limit margin.
const TREE_BATCH_SIZE      = 5;

// Per-request timeout, ported from secretscout-core's GitHubFetcher
// (Client::builder().timeout(Duration::from_secs(30))). Without this, a
// slow/stalled connection on the zipball or tree fetch hangs the scan
// indefinitely with no error and no progress.
const REQUEST_TIMEOUT_MS   = 30_000;

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip',
  '.tar', '.gz', '.wasm', '.bin', '.dll', '.so',
  '.exe', '.dylib', '.map',
]);

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
  errors:        ScanError[];
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  const errors: ScanError[] = [];
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      errors:       [{ code: 'NETWORK_ERROR', message: `HTTP ${res.status} fetching zipball for ${owner}/${repo}`, context: { status: res.status } }],
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
          errors.push({ code: 'DECOMPRESS_ERROR', message: `Decompress error in ${filePath}`, context: { error: String(_err) } });
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

            const source = new TextDecoder('utf-8', { fatal: false } as any).decode(buf);
            const hits   = scanSource(source, templates, { filePath, maxMatches: 100 });

            for (const m of hits) {
              if (allMatches.length < MAX_MATCHES_PER_SCAN) allMatches.push(m);
            }
            filesScanned++;
          } catch (e) {
            errors.push({ code: 'SCAN_ERROR', message: `Scan error in ${filePath}`, context: { error: String(e) } });
          }
        }
      };

      file.start();
    };

    const reader = res.body!.getReader();

    // Stall guard for the streaming read loop, ported from secretscout-server's
    // scan stall watchdog (SCAN_STALL_TIMEOUT). AbortSignal.timeout() on the
    // initial fetch() only covers connect + headers — once the body stream
    // is open, an individual reader.read() can hang indefinitely on a slow
    // or dead connection with no error surfaced. Race each read against a
    // timeout so a stalled stream fails fast instead of hanging the scan.
    function readWithTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
      return new Promise((res2, rej2) => {
        const timer = setTimeout(
          () => rej2(new Error(`stream stalled — no data for ${REQUEST_TIMEOUT_MS}ms`)),
          REQUEST_TIMEOUT_MS,
        );
        reader.read().then(
          (r) => { clearTimeout(timer); res2(r); },
          (e) => { clearTimeout(timer); rej2(e); },
        );
      });
    }

    function pump(): void {
      readWithTimeout().then(({ done, value }) => {
        if (done) {
          unzip.push(new Uint8Array(0), true);
          resolve();
          return;
        }
        if (bytesRead > MAX_ZIPBALL_SIZE) {
          errors.push({ code: 'FILE_TOO_LARGE', message: `${owner}/${repo}: zipball exceeded 150 MB — scan truncated` });
          reader.cancel().catch(() => undefined);
          resolve();
          return;
        }
        unzip.push(value!);
        pump();
      }).catch((e) => {
        errors.push({ code: 'TIMEOUT', message: `${owner}/${repo}: zipball stream error`, context: { error: String(e) } });
        reader.cancel().catch(() => undefined);
        // Resolve (not reject) so a stalled stream degrades to "0 matches,
        // 1 error" for this commit rather than aborting the whole scan run.
        resolve();
      });
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
  const errors: ScanError[] = [];
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
      errors.push({ code: 'REPO_TOO_LARGE', message: `${owner}/${repo}: tree truncated by GitHub — very large repo, some files skipped` });
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

    const MAX_TREE_FILES_TO_SCAN = 100;
    if (tree.length > MAX_TREE_FILES_TO_SCAN) {
      errors.push({ code: 'REPO_TOO_LARGE', message: `${owner}/${repo}: repository has ${tree.length} files. Git Trees scanning is capped at first ${MAX_TREE_FILES_TO_SCAN} files to prevent rate-limit exhaustion.` });
      tree = tree.slice(0, MAX_TREE_FILES_TO_SCAN);
    }
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
    let minRemaining = Infinity;
    let lastResetIso: string | null = null;
    
    await Promise.all(
      batch.map(async (entry) => {
        if (allMatches.length >= MAX_MATCHES_PER_SCAN) return;
        try {
          const { body, rateLimit: rl } = await githubGet(
            `/repos/${owner}/${repo}/contents/${entry.path}`,
            githubToken,
          );
          // Track minimum remaining across parallel requests
          if (rl.remaining < minRemaining) {
            minRemaining = rl.remaining;
            lastResetIso = rl.resetIso;
          }

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
    
    // Update rateLimit with minimum from this batch
    if (minRemaining !== Infinity) {
      rateLimit = { remaining: minRemaining, resetIso: lastResetIso };
    }
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

  if (repoSizeKb > MAX_REPO_SIZE_KB) {
    const errorMsg = `Repository ${owner}/${repo} is too large (${Math.round(repoSizeKb / 1024)} MB, limit: ${MAX_REPO_SIZE_KB / 1024} MB) — scan skipped to prevent API quota exhaustion`;
    console.warn(`[scanner] ${errorMsg}`);
    return {
      matches: [],
      filesScanned: 0,
      bytesRead: 0,
      errors: [errorMsg],
      rateLimit: { remaining: 4999, resetIso: null },
    };
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

/**
 * @deprecated Use scanRepo() which auto-selects the optimal scan mode.
 * @internal This function is maintained for backwards compatibility only.
 * It will be removed in the next major version (v2.0.0).
 * 
 * Migration: Replace `scanZipball(zipUrl, token, templates)` with
 * `scanRepo(owner, repo, token, templates)`.
 */
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
