// src/lib/env.ts
// Single source of truth for all environment variables.
// Import GITHUB_TOKENS (and others) from here — never read process.env directly elsewhere.
//
// For the scan worker (Cloudflare Workers runtime) secrets are injected via
// wrangler secrets / .dev.vars and accessed through the Env binding.
// For scripts (Node.js, tsx) we load from .env via this module.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// .env loader (Node/tsx only — no-op in Workers runtime)
// ---------------------------------------------------------------------------

function loadDotEnv(): Record<string, string> {
  // Workers runtime: process is undefined or has no cwd
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') return {};

  const candidates = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '.env.local'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const lines = readFileSync(candidate, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
    break; // first found wins
  }

  return process.env as Record<string, string>;
}

// Load once at module init (safe to call repeatedly — idempotent)
const env = loadDotEnv();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function get(key: string): string {
  const val = env[key] ?? process.env[key] ?? '';
  return val;
}

function getRequired(key: string): string {
  const val = get(key);
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function getNumbered(prefix: string, count: number): string[] {
  const results: string[] = [];
  for (let i = 1; i <= count; i++) {
    const val = get(`${prefix}_${i}`);
    if (val) results.push(val);
  }
  return results;
}

// ---------------------------------------------------------------------------
// GitHub PATs
// ---------------------------------------------------------------------------

export const GITHUB_TOKENS: readonly string[] = getNumbered('GITHUB_TOKEN', 10);

if (GITHUB_TOKENS.length === 0) {
  console.warn('[env] Warning: no GITHUB_TOKEN_* vars found — scanner will have no PATs');
}

// ---------------------------------------------------------------------------
// GrayhatWarfare keys
// ---------------------------------------------------------------------------

export const GRAYHATWARFARE_KEYS: readonly string[] = getNumbered('GRAYHATWARFARE', 18);

// ---------------------------------------------------------------------------
// URLScan keys
// ---------------------------------------------------------------------------

export const URLSCAN_KEYS: readonly string[] = getNumbered('URLSCAN', 12);

// ---------------------------------------------------------------------------
// ProtonVPN (optional)
// ---------------------------------------------------------------------------

export const PROTONVPN_USERNAME: string = get('PROTONVPN_USERNAME');
export const PROTONVPN_PASSWORD: string = get('PROTONVPN_PASSWORD');

// ---------------------------------------------------------------------------
// Cloudflare resource IDs (non-secret — safe to commit)
// ---------------------------------------------------------------------------

export const CF_ACCOUNT_ID    = 'b1dea8ea21722d03763e3eff6ab8c5c1';
export const CF_D1_DATABASE   = 'reposcout';
export const CF_D1_ID         = '67fa825b-9f3e-478c-99d2-3e5cc1b0f3de';
export const CF_KV_ID         = 'ed3c323de9cc48a4b332beec939597a4';
export const CF_SUMMARY_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
