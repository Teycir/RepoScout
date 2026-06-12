// app/api/review/route.ts
// POST /api/review — analyst triage endpoint.
// Updates ai_evaluations: analyst_reviewed = 1, analyst_verdict = verdict.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { markAnalystReviewed } from '@/lib/db';
import {
  checkRateLimit,
  checkGlobalRateLimit,
  getClientIp,
  rateLimitedResponse,
  missingCacheResponse,
} from '@/lib/rateLimit';
import {
  requireJsonContentType,
  requireMaxBodySize,
  requireSameOrigin,
  isValidUuid,
  isValidVerdict,
  badRequest,
  methodNotAllowed,
  handlePreflight,
  corsHeaders,
  ALLOWED_ORIGINS,
} from '@/lib/validate';
import type { Verdict } from '@/src/lib/types';

export const runtime = 'edge';

// Per-IP: 30 triage decisions per minute (legitimate analyst workflow pace)
const REVIEW_LIMIT  = 30;
const REVIEW_WINDOW = 60; // seconds
// Global: 200 triage decisions per minute across all IPs combined
const GLOBAL_REVIEW_LIMIT  = 200;
const GLOBAL_REVIEW_WINDOW = 60;

export async function POST(req: NextRequest) {
  // --- structural guards (before any I/O) ---
  const corsErr     = requireSameOrigin(req, ALLOWED_ORIGINS);
  if (corsErr) return corsErr;

  const ctErr       = requireJsonContentType(req);
  if (ctErr) return ctErr;

  const sizeErr     = requireMaxBodySize(req);
  if (sizeErr) return sizeErr;

  // --- parse body ---
  let body: { evalId?: unknown; findingId?: unknown; verdict?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Prevent prototype pollution and unexpected types
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return badRequest('Request body must be a JSON object');
  }

  const { evalId, verdict } = body;

  // --- field validation ---
  if (!isValidUuid(evalId)) {
    return badRequest('evalId must be a valid UUID');
  }
  if (!isValidVerdict(verdict)) {
    return badRequest(
      'verdict must be one of: TRUE_POSITIVE, FALSE_POSITIVE, NEEDS_HUMAN_REVIEW',
    );
  }

  // --- rate limiting (after validation, before CF context) ---
  let env: Record<string, unknown> = {};
  try {
    const ctx = await getCloudflareContext();
    env = ctx.env as unknown as Record<string, unknown>;
  } catch { /* dev: no CF context */ }

  const cache = env['CACHE'] as KVNamespace | undefined;

  if (!cache) {
    // Write endpoint — fail closed when KV is unavailable
    return missingCacheResponse(true)!;
  }

  const ip = getClientIp(req);

  // Per-IP limit
  const perIp = await checkRateLimit(cache, `review:${ip}`, REVIEW_LIMIT, REVIEW_WINDOW);
  if (!perIp.ok) return rateLimitedResponse(perIp);

  // Global limit — catches distributed write abuse from many IPs
  const global = await checkGlobalRateLimit(
    cache, 'review', GLOBAL_REVIEW_LIMIT, GLOBAL_REVIEW_WINDOW,
  );
  if (!global.ok) return rateLimitedResponse(global);

  // --- DB write ---
  try {
    const db = (env['DB'] as D1Database | undefined);
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });

    const updated = await markAnalystReviewed(db, evalId as string, verdict as Verdict);
    if (!updated) {
      return NextResponse.json(
        { error: 'evalId not found' },
        { status: 404, headers: corsHeaders(req, ALLOWED_ORIGINS) },
      );
    }

    return NextResponse.json(
      { ok: true, evalId, verdict },
      {
        headers: {
          'RateLimit-Limit':     String(REVIEW_LIMIT),
          'RateLimit-Remaining': String(perIp.remaining),
          'RateLimit-Reset':     String(perIp.resetAt),
          ...corsHeaders(req, ALLOWED_ORIGINS),
        },
      },
    );
  } catch (err) {
    console.error('[api/review]', err);
    return NextResponse.json({ error: 'D1 update failed' }, { status: 500 });
  }
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['POST', 'OPTIONS']);
}

export async function GET() {
  return methodNotAllowed(['POST']);
}
