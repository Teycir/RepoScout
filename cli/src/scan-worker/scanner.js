"use strict";
// src/scan-worker/scanner.ts
// Zipball streaming scanner — streams a GitHub repo archive and runs
// the SecretScout pattern engine on each file entry.
//
// Two scan modes (selected automatically):
//   1. Zipball   — for repos ≤ LARGE_REPO_KB (50 MB); single request, streaming fflate decompress
//   2. Git Trees — for repos > LARGE_REPO_KB;  recursive tree listing + per-file blob fetches
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickNextToken = pickNextToken;
exports.recordTokenUsage = recordTokenUsage;
exports.scanRepo = scanRepo;
exports.scanZipball = scanZipball;
const fflate_1 = require("fflate");
const scanner_js_1 = require("../lib/scanner.js");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_ZIPBALL_SIZE = 150 * 1024 * 1024; // 150 MB hard abort
const MAX_MATCHES_PER_SCAN = 2_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const LARGE_REPO_KB = 50_000; // 50 MB in KB (GitHub repo.size unit)
const TREE_BATCH_SIZE = 5; // concurrent blob fetches
const BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip',
    '.tar', '.gz', '.wasm', '.bin', '.dll', '.so',
    '.exe', '.dylib', '.map',
]);
async function pickNextToken(db) {
    const row = await db
        .prepare(`SELECT * FROM scan_tokens
       WHERE is_active = 1
         AND (rate_limit_reset IS NULL OR rate_limit_reset <= datetime('now'))
       ORDER BY rate_limit_remaining DESC
       LIMIT 1`)
        .first();
    return row ? { token: row.masked_token, row } : null;
}
async function recordTokenUsage(db, tokenId, remaining, reset) {
    await db
        .prepare(`UPDATE scan_tokens
       SET rate_limit_remaining = ?,
           rate_limit_reset     = ?,
           last_used_at         = datetime('now')
       WHERE id = ?`)
        .bind(remaining, reset, tokenId)
        .run();
}
/**
 * Reads x-ratelimit-remaining and x-ratelimit-reset from any GitHub API
 * response and returns them in the shape expected by recordTokenUsage().
 * Falls back gracefully when headers are absent (e.g. redirect responses).
 */
function extractRateLimit(res) {
    const rawRemaining = res.headers.get('x-ratelimit-remaining');
    const rawReset = res.headers.get('x-ratelimit-reset');
    const remaining = rawRemaining != null ? parseInt(rawRemaining, 10) : 4999;
    const resetIso = rawReset != null
        ? new Date(parseInt(rawReset, 10) * 1000).toISOString()
        : null;
    return { remaining: isNaN(remaining) ? 4999 : remaining, resetIso };
}
// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------
async function githubGet(path, token) {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'RepoScout-Scanner/1.0',
            Accept: 'application/vnd.github.v3+json',
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
async function scanViaZipball(owner, repo, githubToken, templates, ref = 'HEAD') {
    const allMatches = [];
    const errors = [];
    let filesScanned = 0;
    let bytesRead = 0;
    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${ref}`;
    const res = await fetch(zipUrl, {
        headers: {
            Authorization: `Bearer ${githubToken}`,
            'User-Agent': 'RepoScout-Scanner/1.0',
            Accept: 'application/vnd.github.v3+json',
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
            matches: [],
            filesScanned: 0,
            bytesRead: 0,
            errors: [`HTTP ${res.status} fetching zipball for ${owner}/${repo}`],
            rateLimit,
        };
    }
    await new Promise((resolve, reject) => {
        const unzip = new fflate_1.Unzip();
        unzip.register(fflate_1.UnzipInflate);
        unzip.onfile = (file) => {
            const filePath = file.name;
            if ((0, scanner_js_1.shouldSkipPath)(filePath)) {
                file.terminate?.();
                return;
            }
            const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
            if (BINARY_EXTS.has(ext)) {
                file.terminate?.();
                return;
            }
            const chunks = [];
            let fileSize = 0;
            file.ondata = (_err, chunk, final) => {
                if (_err) {
                    errors.push(`Decompress error in ${filePath}: ${_err}`);
                    return;
                }
                fileSize += chunk.length;
                bytesRead += chunk.length;
                if (fileSize > MAX_FILE_BYTES) {
                    chunks.length = 0; // drop oversized file
                }
                else {
                    chunks.push(chunk);
                }
                if (final && chunks.length > 0) {
                    try {
                        const buf = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
                        let off = 0;
                        for (const c of chunks) {
                            buf.set(c, off);
                            off += c.length;
                        }
                        const source = new TextDecoder('utf-8', { fatal: false }).decode(buf);
                        const hits = (0, scanner_js_1.scanSource)(source, templates, { filePath, maxMatches: 100 });
                        for (const m of hits) {
                            if (allMatches.length < MAX_MATCHES_PER_SCAN)
                                allMatches.push(m);
                        }
                        filesScanned++;
                    }
                    catch (e) {
                        errors.push(`Scan error in ${filePath}: ${e}`);
                    }
                }
            };
            file.start();
        };
        const reader = res.body.getReader();
        function pump() {
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
                unzip.push(value);
                pump();
            }).catch(reject);
        }
        pump();
    });
    return { matches: allMatches, filesScanned, bytesRead, errors, rateLimit };
}
async function scanViaGitTrees(owner, repo, githubToken, templates, ref = 'HEAD') {
    const allMatches = [];
    const errors = [];
    let filesScanned = 0;
    let bytesRead = 0;
    let rateLimit = { remaining: 4999, resetIso: null };
    // Fetch full recursive tree
    const treePath = `/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
    let tree;
    try {
        const { body, rateLimit: rl } = await githubGet(treePath, githubToken);
        rateLimit = rl;
        const data = body;
        if (data.truncated) {
            errors.push(`${owner}/${repo}: tree truncated by GitHub — very large repo, some files skipped`);
        }
        tree = data.tree.filter((e) => e.type === 'blob' &&
            !(0, scanner_js_1.shouldSkipPath)(e.path) &&
            !(e.size > MAX_FILE_BYTES) &&
            (() => {
                const ext = e.path.slice(e.path.lastIndexOf('.')).toLowerCase();
                return !BINARY_EXTS.has(ext);
            })());
    }
    catch (e) {
        return {
            matches: [],
            filesScanned: 0,
            bytesRead: 0,
            errors: [`Failed to fetch tree for ${owner}/${repo}: ${e}`],
            rateLimit,
        };
    }
    // Fetch blobs in batches of TREE_BATCH_SIZE
    for (let i = 0; i < tree.length; i += TREE_BATCH_SIZE) {
        if (allMatches.length >= MAX_MATCHES_PER_SCAN)
            break;
        const batch = tree.slice(i, i + TREE_BATCH_SIZE);
        await Promise.all(batch.map(async (entry) => {
            if (allMatches.length >= MAX_MATCHES_PER_SCAN)
                return;
            try {
                const { body, rateLimit: rl } = await githubGet(`/repos/${owner}/${repo}/contents/${entry.path}`, githubToken);
                rateLimit = rl; // keep the most recent rate-limit reading
                const file = body;
                if (!file.content || file.encoding !== 'base64')
                    return;
                const decoded = atob(file.content.replace(/\n/g, ''));
                bytesRead += decoded.length;
                const hits = (0, scanner_js_1.scanSource)(decoded, templates, { filePath: entry.path, maxMatches: 100 });
                for (const m of hits) {
                    if (allMatches.length < MAX_MATCHES_PER_SCAN)
                        allMatches.push(m);
                }
                filesScanned++;
            }
            catch (e) {
                errors.push(`Blob fetch error for ${entry.path}: ${e}`);
            }
        }));
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
async function scanRepo(owner, repo, githubToken, templates, ref = 'HEAD') {
    // Check repo size to decide which mode to use
    let repoSizeKb = 0;
    try {
        const { body } = await githubGet(`/repos/${owner}/${repo}`, githubToken);
        repoSizeKb = body.size ?? 0;
    }
    catch {
        // If we can't get metadata, attempt zipball anyway
    }
    if (repoSizeKb > LARGE_REPO_KB) {
        console.log(`[scanner] ${owner}/${repo} is ${repoSizeKb} KB > ${LARGE_REPO_KB} KB — using Git Trees API`);
        return scanViaGitTrees(owner, repo, githubToken, templates, ref);
    }
    return scanViaZipball(owner, repo, githubToken, templates, ref);
}
// ---------------------------------------------------------------------------
// Backwards-compatible alias (used by tests / legacy callers)
// ---------------------------------------------------------------------------
/** @deprecated Use scanRepo() which auto-selects the optimal scan mode. */
async function scanZipball(zipUrl, githubToken, templates) {
    // Extract owner/repo from the zipball URL:
    // https://api.github.com/repos/{owner}/{repo}/zipball/HEAD
    const match = zipUrl.match(/\/repos\/([^/]+)\/([^/]+)\/zipball/);
    if (match) {
        const [, owner, repo] = match;
        return scanViaZipball(owner, repo, githubToken, templates);
    }
    // Fallback: construct a dummy result — caller should migrate to scanRepo()
    return {
        matches: [],
        filesScanned: 0,
        bytesRead: 0,
        errors: [`scanZipball: could not parse owner/repo from URL: ${zipUrl}`],
        rateLimit: { remaining: 4999, resetIso: null },
    };
}
