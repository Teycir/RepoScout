// app/api/trigger/route.ts
// POST /api/trigger — manual scan trigger for dev / on-demand runs.
// Uses Workers Service Binding (SCAN_WORKER) or falls back to SCAN_WORKER_URL.
// Response: { scanRunId, status, message }

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
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
  badRequest,
  handlePreflight,
  corsHeaders,
  ALLOWED_ORIGINS,
} from '@/lib/validate';

export const runtime = 'edge';

// Per-IP: 1 request per 5 minutes — this triggers GitHub API + zipball scans.
const TRIGGER_LIMIT  = 1;
const TRIGGER_WINDOW = 5 * 60; // seconds

// Global: 5 scans per 5 minutes across all IPs — stops distributed abuse
// (e.g. botnet rotating source IPs to bypass the per-IP cap above).
const GLOBAL_TRIGGER_LIMIT  = 5;
const GLOBAL_TRIGGER_WINDOW = 5 * 60;

interface TriggerBody {
  repoId?:  string;   // optional — scan one repo; omit to scan all
  dryRun?:  boolean;  // optional — match only, don't write to D1
}

export async function POST(req: NextRequest) {
  // --- structural guards (before any I/O) ---
  const corsErr = requireSameOrigin(req, ALLOWED_ORIGINS);
  if (corsErr) return corsErr;

  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;

  const sizeErr = requireMaxBodySize(req);
  if (sizeErr) return sizeErr;

  let body: TriggerBody = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return badRequest('Request body must be a JSON object');
  }
  if (body.repoId !== undefined && typeof body.repoId !== 'string') {
    return badRequest('repoId must be a string');
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    return badRequest('dryRun must be a boolean');
  }

  let env: Record<string, unknown> = {};
  let hasCfContext = false;
  try {
    const ctx = await getCloudflareContext();
    env = ctx.env as unknown as Record<string, unknown>;
    hasCfContext = true;
  } catch { /* dev: no CF context */ }

  const cache = env['CACHE'] as KVNamespace | undefined;

  if (cache) {
    const ip = getClientIp(req);

    // Per-IP limit
    const perIp = await checkRateLimit(cache, `trigger:${ip}`, TRIGGER_LIMIT, TRIGGER_WINDOW);
    if (!perIp.ok) return rateLimitedResponse(perIp);

    // Global limit — catches distributed abuse from many IPs each issuing
    // their own one-per-5-minutes request.
    const global = await checkGlobalRateLimit(
      cache, 'trigger', GLOBAL_TRIGGER_LIMIT, GLOBAL_TRIGGER_WINDOW,
    );
    if (!global.ok) return rateLimitedResponse(global);
  } else if (hasCfContext) {
    // Prod context but CACHE binding missing — fail closed. This endpoint
    // triggers real external API calls and must never run unrate-limited.
    return missingCacheResponse(true)!;
  }
  // else: local dev, no CF context → allow through.

  const cors = corsHeaders(req, ALLOWED_ORIGINS);

  // -- Option A: Workers Service Binding --
  const serviceBinding = env['SCAN_WORKER'] as {
    fetch: (req: Request) => Promise<Response>;
  } | undefined;

  if (serviceBinding?.fetch) {
    try {
      const r = await serviceBinding.fetch(
        new Request('https://scan-worker.internal/api/trigger', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        })
      );
      return NextResponse.json(await r.json(), { status: r.status, headers: cors });
    } catch (err) {
      console.error('[api/trigger] service binding error:', err);
    }
  }

  // -- Option B: HTTP fetch to SCAN_WORKER_URL --
  const scanWorkerUrl =
    (env['SCAN_WORKER_URL'] as string | undefined) ?? process.env.SCAN_WORKER_URL;

  if (scanWorkerUrl) {
    try {
      const r = await fetch(`${scanWorkerUrl}/api/trigger`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      return NextResponse.json(await r.json(), { status: r.status, headers: cors });
    } catch (err) {
      console.error('[api/trigger] fetch error:', err);
      return NextResponse.json(
        { error: 'Scan worker unreachable' },
        { status: 502, headers: cors }
      );
    }
  }

  return NextResponse.json(
    {
      error: 'Scan worker not configured',
      hint:  'Add SCAN_WORKER service binding in wrangler.jsonc [[services]] or set SCAN_WORKER_URL env var',
    },
    { status: 501, headers: cors }
  );
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['POST', 'OPTIONS']);
}

// GET /api/trigger — health check
export async function GET() {
  return NextResponse.json({
    ok:      true,
    service: 'RepoScout trigger endpoint',
    usage:   'POST with optional { repoId, dryRun }',
  });
}
