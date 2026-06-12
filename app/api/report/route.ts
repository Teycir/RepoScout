// app/api/report/route.ts
// GET /api/report?format=json|csv          — global report (all repos)
// GET /api/report?repo=<id>&format=json|csv — scoped to one repo

import { NextRequest, NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { corsHeaders, handlePreflight, ALLOWED_ORIGINS } from '@/lib/validate';
import { checkRateLimit, getClientIp, rateLimitedResponse, missingCacheResponse } from '@/lib/rateLimit';

export const runtime = 'edge';

const READ_LIMIT  = 20;
const READ_WINDOW = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReportFinding {
  finding_id:        string;
  repo_owner:        string;
  repo_name:         string;
  file_path:         string;
  file_url:          string;
  line_number:       number;
  matched_text:      string;
  pattern_id:        string;
  template_id:       string;
  severity:          string;
  verdict:           string;
  ai_verdict:        string;
  confidence:        number | null;
  validation_method: string | null;
  analyst_reviewed:  number;
  analyst_verdict:   string | null;
  reasoning:         string | null;
  detected_at:       string;
}

// ---------------------------------------------------------------------------
// DB query
// ---------------------------------------------------------------------------

async function queryFindings(db: D1Database, repoId?: string): Promise<ReportFinding[]> {
  const where  = repoId ? 'WHERE f.repo_id = ?' : '';
  const { results } = await (repoId
    ? db.prepare(`
        SELECT f.id AS finding_id, r.owner AS repo_owner, r.name AS repo_name,
               f.file_path, f.file_url, f.line_number, f.matched_text,
               f.pattern_id, f.template_id, f.severity,
               COALESCE(e.analyst_verdict, e.verdict, 'PENDING') AS verdict,
               COALESCE(e.verdict, 'PENDING')                    AS ai_verdict,
               e.confidence, e.validation_method,
               COALESCE(e.analyst_reviewed, 0)                   AS analyst_reviewed,
               e.analyst_verdict, e.reasoning, f.detected_at
        FROM findings f
        JOIN repositories r ON r.id = f.repo_id
        LEFT JOIN ai_evaluations e ON e.finding_id = f.id
        ${where}
        ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
                 f.detected_at DESC
      `).bind(repoId)
    : db.prepare(`
        SELECT f.id AS finding_id, r.owner AS repo_owner, r.name AS repo_name,
               f.file_path, f.file_url, f.line_number, f.matched_text,
               f.pattern_id, f.template_id, f.severity,
               COALESCE(e.analyst_verdict, e.verdict, 'PENDING') AS verdict,
               COALESCE(e.verdict, 'PENDING')                    AS ai_verdict,
               e.confidence, e.validation_method,
               COALESCE(e.analyst_reviewed, 0)                   AS analyst_reviewed,
               e.analyst_verdict, e.reasoning, f.detected_at
        FROM findings f
        JOIN repositories r ON r.id = f.repo_id
        LEFT JOIN ai_evaluations e ON e.finding_id = f.id
        ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
                 f.detected_at DESC
      `)
  ).all<ReportFinding>();
  return results;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(findings: ReportFinding[], repoId: string | null) {
  const by_severity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let tp = 0, fp = 0, nhr = 0, pending = 0;
  for (const f of findings) {
    (by_severity as any)[f.severity] = ((by_severity as any)[f.severity] ?? 0) + 1;
    if      (f.verdict === 'TRUE_POSITIVE')      tp++;
    else if (f.verdict === 'FALSE_POSITIVE')     fp++;
    else if (f.verdict === 'NEEDS_HUMAN_REVIEW') nhr++;
    else                                          pending++;
  }
  return {
    generated_at:   new Date().toISOString(),
    repo_filter:    repoId,
    total_findings: findings.length,
    true_positives: tp, false_positives: fp, needs_review: nhr, pending,
    by_severity,
  };
}

// ---------------------------------------------------------------------------
// CSV serialiser
// ---------------------------------------------------------------------------

const CSV_COLS: (keyof ReportFinding)[] = [
  'repo_owner','repo_name','file_path','file_url','line_number','matched_text',
  'pattern_id','template_id','severity','verdict','ai_verdict','confidence',
  'validation_method','analyst_reviewed','analyst_verdict','reasoning','detected_at',
];

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(findings: ReportFinding[]): string {
  return [
    CSV_COLS.join(','),
    ...findings.map(f => CSV_COLS.map(c => cell(f[c])).join(',')),
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const { env } = await getCloudflareContext();
    const cache = (env as any)['CACHE'] as KVNamespace | undefined;
    if (cache) {
      const r = await checkRateLimit(cache, `report:${getClientIp(req)}`, READ_LIMIT, READ_WINDOW);
      if (!r.ok) return rateLimitedResponse(r);
    } else if (env.DB) {
      return missingCacheResponse(true)!;
    }

    const { searchParams } = req.nextUrl;
    const repoId = searchParams.get('repo') || undefined;
    const format = (searchParams.get('format') ?? 'json').toLowerCase();
    if (format !== 'json' && format !== 'csv')
      return NextResponse.json({ error: 'format must be json or csv' }, { status: 400 });

    const findings = await queryFindings(env.DB, repoId);
    const summary  = buildSummary(findings, repoId ?? null);
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug     = repoId ? `repo-${repoId.slice(0, 8)}` : 'global';
    const filename = `reposcout-${slug}-${ts}`;

    if (format === 'csv') {
      return new Response(toCSV(findings), {
        headers: {
          'Content-Type':        'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.csv"`,
          ...corsHeaders(req, ALLOWED_ORIGINS),
        },
      });
    }

    return NextResponse.json({ summary, findings }, {
      headers: {
        'Content-Disposition': `attachment; filename="${filename}.json"`,
        ...corsHeaders(req, ALLOWED_ORIGINS),
      },
    });
  } catch (err) {
    console.error('[api/report]', err);
    return NextResponse.json({ error: 'Report generation failed' }, { status: 500 });
  }
}

export async function OPTIONS(req: NextRequest) {
  return handlePreflight(req, ALLOWED_ORIGINS, ['GET', 'OPTIONS']);
}
