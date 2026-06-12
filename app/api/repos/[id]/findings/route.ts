// app/api/repos/[id]/findings/route.ts
// GET /api/repos/:id/findings?limit=100 — all findings + AI evaluations for a repo.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getFindingsForRepo } from '@/lib/db';
import { checkRateLimit, getClientIp, rateLimitedResponse, missingCacheResponse } from '@/lib/rateLimit';
import { corsHeaders, handlePreflight, ALLOWED_ORIGINS } from '@/lib/validate';

export const runtime = 'edge';

const READ_LIMIT  = 60;
const READ_WINDOW = 60; // seconds — 60 req/min per IP
const MAX_LIMIT   = 500;

interface RouteParams { params: Promise<{ id: string }>; }

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  try {
    const { env } = await getCloudflareContext();

    const cache = (env as unknown as Record<string, unknown>)['CACHE'] as KVNamespace | undefined;
    if (cache) {
      const ip = getClientIp(req);
      const result = await checkRateLimit(cache, `findings:${ip}`, READ_LIMIT, READ_WINDOW);
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

    const findings = await getFindingsForRepo(env.DB, id, limit);
    return NextResponse.json({ repoId: id, findings }, { headers: corsHeaders(req, ALLOWED_ORIGINS) });
  } catch (err) {
    console.error('[api/repos/[id]/findings]', err);
    return NextResponse.json({ error: 'D1 query failed' }, { status: 500 });
  }
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
}
