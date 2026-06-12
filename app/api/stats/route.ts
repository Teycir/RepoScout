// app/api/stats/route.ts
// GET /api/stats — dashboard summary counters.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getDashboardStats } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse, missingCacheResponse } from '@/lib/rateLimit';
import { corsHeaders, handlePreflight, ALLOWED_ORIGINS } from '@/lib/validate';

export const runtime = 'edge';

const READ_LIMIT  = 60;
const READ_WINDOW = 60; // seconds — 60 req/min per IP

export async function GET(req: NextRequest) {
  try {
    const { env } = await getCloudflareContext();

    const cache = (env as unknown as Record<string, unknown>)['CACHE'] as KVNamespace | undefined;
    if (cache) {
      const ip = getClientIp(req);
      const result = await checkRateLimit(cache, `stats:${ip}`, READ_LIMIT, READ_WINDOW);
      if (!result.ok) return rateLimitedResponse(result);
    } else if (env.DB) {
      // CF context present (prod) but CACHE binding missing → misconfiguration.
      // Fail closed rather than serving an unrate-limited D1 query.
      return missingCacheResponse(true)!;
    }
    // else: no CF context at all → local dev, allow through.

    const stats = await getDashboardStats(env.DB);
    return NextResponse.json(stats, { headers: corsHeaders(req, ALLOWED_ORIGINS) });
  } catch (err) {
    console.error('[api/stats]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
}
