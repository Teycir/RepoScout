// app/api/repos/route.ts
// GET /api/repos?limit=50 — repository risk grid, ordered by risk_score DESC.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRepositories } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rateLimit';

export const runtime = 'edge';

const READ_LIMIT  = 60;
const READ_WINDOW = 60; // seconds — 60 req/min per IP
const MAX_LIMIT   = 200;

export async function GET(req: NextRequest) {
  try {
    const { env } = await getCloudflareContext();

    const cache = (env as unknown as Record<string, unknown>)['CACHE'] as KVNamespace | undefined;
    if (cache) {
      const ip = getClientIp(req);
      const result = await checkRateLimit(cache, `repos:${ip}`, READ_LIMIT, READ_WINDOW);
      if (!result.ok) return rateLimitedResponse(result);
    }

    const limitParam = req.nextUrl.searchParams.get('limit');
    let limit = limitParam ? parseInt(limitParam, 10) : 50;
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const repos = await getRepositories(env.DB, limit);
    return NextResponse.json({ repos });
  } catch (err) {
    console.error('[api/repos]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}
