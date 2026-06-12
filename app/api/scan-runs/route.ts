// app/api/scan-runs/route.ts
// GET /api/scan-runs?limit=10 — recent scan run history.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRecentScanRuns } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse, missingCacheResponse } from '@/lib/rateLimit';
import { corsHeaders, handlePreflight, ALLOWED_ORIGINS } from '@/lib/validate';

export const runtime = 'edge';

const READ_LIMIT  = 60;
const READ_WINDOW = 60; // seconds — 60 req/min per IP
const MAX_LIMIT   = 100;

export async function GET(req: NextRequest) {
  try {
    const { env } = await getCloudflareContext();

    const cache = (env as unknown as Record<string, unknown>)['CACHE'] as KVNamespace | undefined;
    if (cache) {
      const ip = getClientIp(req);
      const result = await checkRateLimit(cache, `scan-runs:${ip}`, READ_LIMIT, READ_WINDOW);
      if (!result.ok) return rateLimitedResponse(result);
    } else if (env.DB) {
      // CF context present (prod) but CACHE binding missing → misconfiguration.
      // Fail closed rather than serving an unrate-limited D1 query.
      return missingCacheResponse(true)!;
    }
    // else: no CF context at all → local dev, allow through.

    const limitParam = req.nextUrl.searchParams.get('limit');
    let limit = limitParam ? parseInt(limitParam, 10) : 10;
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const runs = await getRecentScanRuns(env.DB, limit);
    return NextResponse.json({ runs }, { headers: corsHeaders(req, ALLOWED_ORIGINS) });
  } catch (err) {
    console.error('[api/scan-runs]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}

// This OPTIONS handler responds to preflight CORS requests from browsers.
// When a cross-origin request is made, browsers first send an OPTIONS request
// to check if the actual request is allowed. This handler uses the handlePreflight
// utility to validate the origin against ALLOWED_ORIGINS and specify which HTTP
// methods (GET, OPTIONS) are permitted for this endpoint.
export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
}
