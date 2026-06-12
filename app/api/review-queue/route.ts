// app/api/review-queue/route.ts
// GET /api/review-queue?limit=100 — NEEDS_HUMAN_REVIEW findings awaiting analyst triage.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getAnalystQueue } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rateLimit';

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
    }

    const limitParam = req.nextUrl.searchParams.get('limit');
    let limit = limitParam ? parseInt(limitParam, 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) limit = 100;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const queue = await getAnalystQueue(env.DB, limit);
    return NextResponse.json({ queue });
  } catch (err) {
    console.error('[api/review-queue]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}
