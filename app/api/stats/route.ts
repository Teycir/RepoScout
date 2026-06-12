// app/api/stats/route.ts
// GET /api/stats — dashboard summary counters.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getDashboardStats } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rateLimit';

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
    }

    const stats = await getDashboardStats(env.DB);
    return NextResponse.json(stats);
  } catch (err) {
    console.error('[api/stats]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}
