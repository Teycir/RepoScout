// app/api/crawler/route.ts
// GET /api/crawler — recent crawler run history + current KV cursor.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { checkRateLimit, getClientIp, rateLimitedResponse, missingCacheResponse } from '@/lib/rateLimit';
import { corsHeaders, handlePreflight, ALLOWED_ORIGINS } from '@/lib/validate';

export const runtime = 'edge';

const READ_LIMIT  = 60;
const READ_WINDOW = 60;

export async function GET(req: NextRequest) {
  try {
    const { env } = await getCloudflareContext();
    const cache = (env as unknown as Record<string, unknown>)['CACHE'] as KVNamespace | undefined;

    if (cache) {
      const ip = getClientIp(req);
      const result = await checkRateLimit(cache, `crawler:${ip}`, READ_LIMIT, READ_WINDOW);
      if (!result.ok) return rateLimitedResponse(result);
    } else if (env.DB) {
      return missingCacheResponse(true)!;
    }

    const url   = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);

    const [runs, cursor] = await Promise.all([
      env.DB
        .prepare(
          `SELECT id, started_at, completed_at, repos_discovered, repos_updated,
                  since_cursor, next_cursor, status
           FROM crawler_runs
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .bind(limit)
        .all(),
      cache ? cache.get('crawler:since') : Promise.resolve(null),
    ]);

    return NextResponse.json(
      { runs: runs.results, currentCursor: cursor },
      { headers: corsHeaders(req, ALLOWED_ORIGINS) },
    );
  } catch (err) {
    console.error('[api/crawler]', err);
    return NextResponse.json({ error: 'query failed' }, { status: 500 });
  }
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
}
