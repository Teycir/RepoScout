// lib/validate.ts
// Centralised input validation helpers for all API routes.
// Nothing here performs I/O — pure validation against structural rules.

import type { Verdict } from '@/src/lib/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// RFC 4122 UUID v4 — the only ID format this app generates (crypto.randomUUID)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum allowed Content-Length for write endpoints (bytes).
// JSON bodies for /api/review and /api/trigger are tiny; 8 KB is generous.
export const MAX_BODY_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

/** Returns true if `v` is a valid RFC 4122 v4 UUID string. */
export function isValidUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ---------------------------------------------------------------------------
// Verdict validation
// ---------------------------------------------------------------------------

const ALLOWED_VERDICTS = new Set<Verdict>([
  'TRUE_POSITIVE',
  'FALSE_POSITIVE',
  'NEEDS_HUMAN_REVIEW',
]);

/** Returns true if `v` is one of the three allowed triage verdicts. */
export function isValidVerdict(v: unknown): v is Verdict {
  return typeof v === 'string' && ALLOWED_VERDICTS.has(v as Verdict);
}

// ---------------------------------------------------------------------------
// Content-Type enforcement
// ---------------------------------------------------------------------------

/**
 * Returns a 415 response if the request Content-Type is not application/json.
 * Call this before `req.json()` on all write endpoints.
 */
export function requireJsonContentType(req: Request): Response | null {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    return Response.json(
      { error: 'Content-Type must be application/json' },
      { status: 415 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body size guard
// ---------------------------------------------------------------------------

/**
 * Returns a 413 response if Content-Length exceeds maxBytes.
 * Note: Content-Length may be absent (chunked transfer). This is a fast-path
 * pre-check only — the actual body read in routes is already bounded by the
 * Workers runtime's request size limits (~100 MB), but rejecting here avoids
 * waiting for the full body read before returning an error.
 */
export function requireMaxBodySize(req: Request, maxBytes = MAX_BODY_BYTES): Response | null {
  const cl = req.headers.get('content-length');
  if (cl !== null) {
    const len = parseInt(cl, 10);
    if (Number.isFinite(len) && len > maxBytes) {
      return Response.json(
        { error: `Request body too large (max ${maxBytes} bytes)` },
        { status: 413 },
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CORS guard for write endpoints
// ---------------------------------------------------------------------------

/**
 * Returns a 403 response if the Origin header is present but does not match
 * the allowed list. Browsers always send Origin on cross-origin requests;
 * direct API calls (curl, CLI) typically omit it, so we only block when Origin
 * is explicitly set to something not in the allow-list.
 *
 * Pass `allowedOrigins` as a Set of exact origins (e.g. "https://example.com").
 * Passing an empty set blocks all cross-origin browser requests.
 */
export function requireSameOrigin(
  req: Request,
  allowedOrigins: Set<string>,
): Response | null {
  const origin = req.headers.get('origin');
  if (origin === null) return null; // non-browser / same-origin → allow
  if (allowedOrigins.has(origin)) return null;
  return Response.json(
    { error: 'Forbidden' },
    { status: 403 },
  );
}

// ---------------------------------------------------------------------------
// CORS for read endpoints + preflight handling
// ---------------------------------------------------------------------------

/**
 * Returns CORS response headers if `Origin` is present and allowed.
 * For GET routes we still want browsers on other origins to be able to read
 * (e.g. a separate frontend Worker) — but only from the allow-list.
 * Returns {} (no CORS headers) for same-origin/non-browser requests, which
 * is safe: browsers only need these headers for cross-origin reads.
 */
export function corsHeaders(
  req: Request,
  allowedOrigins: Set<string>,
): Record<string, string> {
  const origin = req.headers.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
    };
  }
  return {};
}

/**
 * Standard OPTIONS preflight handler. Returns 204 with CORS headers if the
 * Origin is allowed, 403 otherwise. Use for routes that accept cross-origin
 * browser requests.
 */
export function handlePreflight(
  req: Request,
  allowedOrigins: Set<string>,
  allowedMethods: string[],
): Response {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins.has(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  origin,
      'Access-Control-Allow-Methods': allowedMethods.join(', '),
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
      'Vary':                          'Origin',
    },
  });
}

// ---------------------------------------------------------------------------
// Shared CORS allow-list — single source of truth across all routes.
// Extend if embedding the dashboard elsewhere. Direct API calls (curl, CLI
// tools, service bindings) omit Origin and bypass these checks entirely.
// ---------------------------------------------------------------------------

export const ALLOWED_ORIGINS = new Set([
  'https://reposcout-web.workers.dev',
]);

// ---------------------------------------------------------------------------
// Standard error helpers
// ---------------------------------------------------------------------------

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export function methodNotAllowed(allowed: string[]): Response {
  return Response.json(
    { error: `Method not allowed. Allowed: ${allowed.join(', ')}` },
    {
      status: 405,
      headers: { Allow: allowed.join(', ') },
    },
  );
}
