// app/api/scan-runs/route.ts
// GET /api/scan-runs?limit=10 — recent scan run history.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRecentScanRuns } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rateLimit';

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
    }

    const limitParam = req.nextUrl.searchParams.get('limit');
    let limit = limitParam ? parseInt(limitParam, 10) : 10;
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const runs = await getRecentScanRuns(env.DB, limit);
    return NextResponse.json({ runs });
  } catch (err) {
    console.error('[api/scan-runs]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}
