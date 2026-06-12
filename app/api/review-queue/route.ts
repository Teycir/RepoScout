// app/api/review-queue/route.ts
// GET /api/review-queue?limit=100 — NEEDS_HUMAN_REVIEW findings awaiting analyst triage.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getAnalystQueue } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse, missingCacheResponse } from '@/lib/rateLimit';
import { corsHeaders, handlePreflight, ALLOWED_ORIGINS } from '@/lib/validate';

export const runtime = 'edge';

const READ_LIMIT  = 60;
const READ_WINDOW = 60; // seconds — 60 req/min per IP
const MAX_LIMIT   = 500;

export async function GET(req: NextRequest) {
  try {
    const { env } = await getCloudflareContext();

    const cache = (env as unknown as Record<string, unknown>)['CACHE'] as KVNamespace | undefined;
    if (cache) {
      const ip = getClientIp(req);
      const result = await checkRateLimit(cache, `review-queue:${ip}`, READ_LIMIT, READ_WINDOW);
      if (!result.ok) return rateLimitedResponse(result);
    } else if (env.DB) {
      // CF context present (prod) but CACHE binding missing → misconfiguration.
      // Fail closed rather than serving an unrate-limited D1 query.
      return missingCacheResponse(true)!;
    }
    // else: no CF context at all → local dev, allow through.

    const limitParam = req.nextUrl.searchParams.get('limit');
    let limit = limitParam ? parseInt(limitParam, 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const queue = await getAnalystQueue(env.DB, limit);
    return NextResponse.json({ queue }, { headers: corsHeaders(req, ALLOWED_ORIGINS) });
  } catch (err) {
    console.error('[api/review-queue]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}

// This OPTIONS handler implements CORS preflight request handling.
// When a browser makes a cross-origin request, it first sends an OPTIONS request
// to check if the actual request is allowed. This handler responds with appropriate
// CORS headers to indicate which origins, methods, and headers are permitted.
// It delegates to the handlePreflight utility function, passing:
// - req: the incoming OPTIONS request
// - ALLOWED_ORIGINS: list of origins permitted to access this endpoint
// - ['GET', 'OPTIONS']: HTTP methods allowed for this endpoint
export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
}}
