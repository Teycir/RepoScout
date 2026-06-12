#!/usr/bin/env tsx
// scripts/seed-repos.ts
// Seeds the `repositories` table with repos to monitor.
//
// Usage:
//   npx tsx scripts/seed-repos.ts                 # local D1 (dev)
//   npx tsx scripts/seed-repos.ts --remote         # remote D1 (prod)
//   npx tsx scripts/seed-repos.ts --remote --clear # wipe + re-seed
//
// Edit the REPOS array below before running.
// Each entry is "owner/name" — the full GitHub repo slug.

import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe interpolation into a SQLite string literal. */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Validate a GitHub repo slug (owner/name).
 * GitHub only allows [A-Za-z0-9._-] in owner/org names and [A-Za-z0-9._-] in
 * repo names. Reject anything outside that to prevent malformed SQL.
 */
const GITHUB_SLUG_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

function validateSlug(slug: string): void {
  if (!GITHUB_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid GitHub slug "${slug}" — only alphanumerics, dots, hyphens, and underscores are allowed.`
    );
  }
}

// ---------------------------------------------------------------------------
// ✏️  Edit this list to add / remove monitored repositories
// ---------------------------------------------------------------------------

const REPOS: string[] = [
  // Public repos for initial testing — add your own
  'vercel/next.js',
  'cloudflare/workers-sdk',
  'langchain-ai/langchainjs',
  'anthropics/anthropic-sdk-python',
  'openai/openai-python',
  // Add more: 'owner/repo'
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REMOTE = process.argv.includes('--remote');
const CLEAR  = process.argv.includes('--clear');
const FLAG   = REMOTE ? '--remote' : '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(sql: string): void {
  const tmp = '/tmp/reposcout-seed-repos.sql';
  writeFileSync(tmp, sql);
  const cmd = `wrangler d1 execute reposcout ${FLAG} --file=${tmp} --config=wrangler.jsonc`;
  try {
    execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n📦  Seeding ${REPOS.length} repo(s) into repositories table`);
console.log(`    Target  : ${REMOTE ? 'remote D1' : 'local D1'}`);
if (CLEAR) console.log('    Mode    : CLEAR + re-seed\n');
else       console.log('    Mode    : INSERT OR IGNORE (safe to re-run)\n');

// Validate all slugs before touching the database
for (const slug of REPOS) {
  validateSlug(slug); // throws on invalid input — fast-fail before any SQL
}

if (CLEAR) {
  console.log('⚠️   Clearing repositories table…');
  exec(`DELETE FROM repositories;`);
}

const rows = REPOS.map((slug) => {
  const [owner, name] = slug.split('/') as [string, string];
  const id  = randomUUID();
  const url = `https://github.com/${owner}/${name}`;
  return { id, owner, name, url };
});

const values = rows
  .map((r) => {
    // sqlEscape wraps single quotes inside the literal (e.g. O'Reilly → O''Reilly).
    // UUIDs and GitHub-validated owner/name/url are already safe, but we escape
    // defensively so the function stays correct if validation logic ever changes.
    const id    = sqlEscape(r.id);
    const owner = sqlEscape(r.owner);
    const name  = sqlEscape(r.name);
    const url   = sqlEscape(r.url);
    return `('${id}', '${owner}', '${name}', '${url}', 0.0, 0, 0, NULL, 'PENDING', datetime('now'), datetime('now'))`;
  })
  .join(',\n  ');

const sql = `INSERT OR IGNORE INTO repositories
  (id, owner, name, url, risk_score, high_severity_findings, critical_severity_findings,
   last_scan_at, last_scan_status, created_at, updated_at)
VALUES
  ${values};`;

exec(sql);

console.log(`\n✅  Seeded ${rows.length} repo(s):`);
rows.forEach((r) => console.log(`    ${r.owner}/${r.name}  [${r.id}]`));
console.log();
