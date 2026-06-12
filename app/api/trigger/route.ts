// app/api/trigger/route.ts
// POST /api/trigger — manual scan trigger for dev / on-demand runs.
// Uses Workers Service Binding (SCAN_WORKER) or falls back to SCAN_WORKER_URL.
// Response: { scanRunId, status, message }

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export const runtime = 'edge';

interface TriggerBody {
  repoId?:  string;   // optional — scan one repo; omit to scan all
  dryRun?:  boolean;  // optional — match only, don't write to D1
}

export async function POST(req: NextRequest) {
  let body: TriggerBody = {};
  try { body = await req.json(); } catch { /* empty body = full scan */ }

  let env: Record<string, unknown> = {};
  try {
    const ctx = await getCloudflareContext();
    env = ctx.env as unknown as Record<string, unknown>;
  } catch { /* dev: no CF context */ }

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
      return NextResponse.json(await r.json(), { status: r.status });
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
      return NextResponse.json(await r.json(), { status: r.status });
    } catch (err) {
      console.error('[api/trigger] fetch error:', err);
      return NextResponse.json(
        { error: 'Scan worker unreachable' },
        { status: 502 }
      );
    }
  }

  return NextResponse.json(
    {
      error: 'Scan worker not configured',
      hint:  'Add SCAN_WORKER service binding in wrangler.jsonc [[services]] or set SCAN_WORKER_URL env var',
    },
    { status: 501 }
  );
}

// GET /api/trigger — health check
export async function GET() {
  return NextResponse.json({
    ok:      true,
    service: 'RepoScout trigger endpoint',
    usage:   'POST with optional { repoId, dryRun }',
  });
}
