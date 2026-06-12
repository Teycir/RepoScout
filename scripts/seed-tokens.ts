#!/usr/bin/env tsx
// scripts/seed-tokens.ts
// Seeds scan_tokens table from GITHUB_TOKEN_* vars in .env.
// Usage:
//   npx tsx scripts/seed-tokens.ts           # local D1
//   npx tsx scripts/seed-tokens.ts --remote  # remote D1

import { createHash, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

// Load tokens from .env via the central env module
import { GITHUB_TOKENS } from '../src/lib/env.js';

const REMOTE = process.argv.includes('--remote');

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe interpolation into a SQLite string literal. */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Validate a GitHub PAT format.
 * Classic PATs: ghp_[A-Za-z0-9]{36}
 * Fine-grained: github_pat_[A-Za-z0-9_]{82}
 * OAuth tokens: gho_[A-Za-z0-9]{36}
 * Actions:      ghs_[A-Za-z0-9]{36} / ghr_[A-Za-z0-9]{36}
 * Reject anything that doesn't look like a PAT to avoid surprises.
 */
const GITHUB_PAT_RE = /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})$/;

function validatePat(pat: string, index: number): void {
  if (!GITHUB_PAT_RE.test(pat)) {
    // Don't print the token itself — show its position only
    throw new Error(
      `GITHUB_TOKEN_${index + 1} does not match a known GitHub PAT format. ` +
      `Expected ghp_..., github_pat_..., gho_..., ghs_..., or ghr_...`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function maskToken(token: string): string {
  const prefix = token.slice(0, 8);
  const suffix = token.slice(-4);
  return `${prefix}...${suffix}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (GITHUB_TOKENS.length === 0) {
  console.error('❌  No GITHUB_TOKEN_* vars found in .env — aborting.');
  process.exit(1);
}

// Validate all PAT formats before touching the database
for (let i = 0; i < GITHUB_TOKENS.length; i++) {
  validatePat(GITHUB_TOKENS[i]!, i); // throws on invalid format — fast-fail before any SQL
}

console.log(`\n🔑  Seeding ${GITHUB_TOKENS.length} PAT(s) into scan_tokens (${REMOTE ? 'remote' : 'local'} D1)\n`);

const rows = GITHUB_TOKENS.map((pat) => ({
  id:           randomUUID(),
  token_hash:   sha256(pat),        // hex — safe, but escaped defensively below
  masked_token: maskToken(pat),     // alphanumeric + dots — escaped defensively below
}));

const values = rows
  .map((r) => {
    // SHA-256 hex and masked tokens (ghp_xxxx...yyyy) are structurally safe,
    // but we escape every interpolated value so this stays correct regardless
    // of future changes to sha256/maskToken output format.
    const id    = sqlEscape(r.id);
    const hash  = sqlEscape(r.token_hash);
    const masked = sqlEscape(r.masked_token);
    return `('${id}', '${hash}', '${masked}', 1, 5000, NULL, NULL, datetime('now'))`;
  })
  .join(',\n  ');

const sql = `INSERT OR IGNORE INTO scan_tokens
  (id, token_hash, masked_token, is_active, rate_limit_remaining, rate_limit_reset, last_used_at, created_at)
VALUES
  ${values};`;

const tmpFile = '/tmp/reposcout-seed-tokens.sql';
writeFileSync(tmpFile, sql);

const remoteFlag = REMOTE ? '--remote' : '';
const cmd = `wrangler d1 execute reposcout ${remoteFlag} --file=${tmpFile} --config=wrangler.jsonc`;

console.log(`Running: ${cmd}\n`);

try {
  execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });
  console.log(`\n✅  Seeded ${rows.length} token(s):`);
  rows.forEach((r) => console.log(`    ${r.masked_token}  [${r.id}]`));
} catch (e) {
  console.error('\n❌  Seed failed:', e);
  process.exit(1);
} finally {
  unlinkSync(tmpFile);
}
