// app/api/review/route.ts
// POST /api/review — analyst triage endpoint.
// Updates ai_evaluations: analyst_reviewed = 1, analyst_verdict = verdict.

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { markAnalystReviewed } from '@/lib/db';
import type { Verdict } from '@/src/lib/types';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  let body: { evalId?: string; findingId?: string; verdict?: Verdict };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { evalId, verdict } = body;

  if (!evalId || !verdict) {
    return NextResponse.json(
      { error: 'evalId and verdict are required' },
      { status: 400 }
    );
  }

  const ALLOWED: Verdict[] = ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_HUMAN_REVIEW'];
  if (!ALLOWED.includes(verdict)) {
    return NextResponse.json(
      { error: `verdict must be one of ${ALLOWED.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const { env } = await getCloudflareContext();
    await markAnalystReviewed(env.DB, evalId, verdict);
    return NextResponse.json({ ok: true, evalId, verdict });
  } catch (err) {
    console.error('[api/review]', err);
    return NextResponse.json({ error: 'D1 update failed' }, { status: 500 });
  }
}
