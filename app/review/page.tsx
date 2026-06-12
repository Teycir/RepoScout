// app/review/page.tsx — AnalystQueue
// Lists all NEEDS_HUMAN_REVIEW findings sorted by severity.
// One-click triage buttons call /api/review to update analyst_reviewed in D1.

import Link from 'next/link';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getAnalystQueue } from '@/lib/db';
import type { FindingWithEval } from '@/lib/db';
import { ArrowLeft, ExternalLink, HelpCircle } from 'lucide-react';
import { TriageButtons } from './TriageButtons';

export const runtime = 'edge';
export const revalidate = 0;

export const metadata = { title: 'Review Queue' };

function SeverityBadge({ sev }: { sev: string }) {
  const cfg: Record<string, string> = {
    critical: 'bg-neon-red/15 text-neon-red border border-neon-red/30',
    high:     'bg-neon-amber/15 text-neon-amber border border-neon-amber/30',
    medium:   'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
    low:      'bg-neon-red/5 text-neon-red/50 border border-neon-red/10',
    info:     'bg-white/5 text-white/30 border border-white/10',
  };
  return (
    <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded ${cfg[sev] ?? cfg['info']}`}>
      {sev}
    </span>
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 60 ? 'bg-neon-amber/60' :
    pct >= 40 ? 'bg-yellow-500/50' :
    'bg-white/20';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-0.5 bg-white/5 rounded-full overflow-hidden w-16">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] text-white/30 font-mono tabular-nums">{pct}%</span>
    </div>
  );
}

function MiniSnippet({ context, lineNumber }: { context: string; lineNumber: number }) {
  let lines: string[];
  try {
    const parsed = JSON.parse(context);
    lines = Array.isArray(parsed) ? parsed : [context];
  } catch {
    lines = context.split('\n');
  }
  const hitIndex = Math.floor(lines.length / 2);
  const start = Math.max(0, hitIndex - 1);
  const slice = lines.slice(start, start + 3);
  return (
    <pre className="text-[10px] font-mono bg-black/30 border border-white/5 rounded p-2 overflow-x-auto leading-4 my-2">
      {slice.map((line, i) => {
        const absLine = lineNumber - (hitIndex - start) + i;
        const isHit = i === hitIndex - start;
        return (
          <div key={i}
            className={`flex gap-2 ${isHit ? 'bg-neon-amber/8 border-l border-neon-amber/40 -mx-2 px-2' : ''}`}>
            <span className="select-none text-white/15 w-5 text-right shrink-0 tabular-nums">
              {absLine > 0 ? absLine : ''}
            </span>
            <span className={isHit ? 'text-neon-amber/70' : 'text-white/35'}>{line || ' '}</span>
          </div>
        );
      })}
    </pre>
  );
}

function QueueCard({ f }: { f: FindingWithEval }) {
  return (
    <div className="border border-neon-amber/15 rounded-lg p-4 bg-dark-bg/60 backdrop-blur-sm
      hover:border-neon-amber/25 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-neon-red/40 mb-0.5 flex-wrap">
            <Link href={`/repo/${f.repo_id}`}
              className="hover:text-neon-red/70 transition-colors">
              {f.repo_owner}/{f.repo_name}
            </Link>
            <span className="text-white/15">·</span>
            <span className="text-white/30">{f.file_path}:{f.line_number}</span>
            {f.file_url && (
              <a href={f.file_url} target="_blank" rel="noopener noreferrer"
                className="text-neon-red/20 hover:text-neon-red/50 transition-colors">
                <ExternalLink size={9} />
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-[11px] font-mono text-neon-amber/70
              bg-neon-amber/5 border border-neon-amber/15 px-2 py-0.5 rounded">
              {f.matched_text}
            </code>
            <SeverityBadge sev={f.severity} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          {f.eval?.confidence != null && <ConfidenceBar score={f.eval.confidence} />}
          {f.eval?.validation_method && (
            <div className="text-[9px] text-white/20 font-mono mt-1">via {f.eval.validation_method}</div>
          )}
        </div>
      </div>

      {f.context && <MiniSnippet context={f.context} lineNumber={f.line_number} />}

      {f.eval?.reasoning && (
        <p className="text-[10px] text-white/40 font-mono leading-relaxed mb-3 line-clamp-2">
          {f.eval.reasoning}
        </p>
      )}

      <div className="flex gap-3 mb-3 flex-wrap">
        <span className="text-[9px] text-white/15 font-mono">
          template: <span className="text-white/30">{f.template_id}</span>
        </span>
        <span className="text-[9px] text-white/15 font-mono">
          pattern: <span className="text-white/30">{f.pattern_id}</span>
        </span>
      </div>

      <TriageButtons evalId={f.eval?.id ?? ''} findingId={f.id} />

      <div className="mt-2 text-[9px] text-white/10 font-mono">
        detected {new Date(f.detected_at).toLocaleString()}
      </div>
    </div>
  );
}

export default async function ReviewQueuePage() {
  let queue: FindingWithEval[] = [];
  try {
    const { env } = await getCloudflareContext();
    queue = await getAnalystQueue(env.DB);
  } catch { /* dev fallback */ }

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
      <Link href="/"
        className="inline-flex items-center gap-1.5 text-neon-red/40 hover:text-neon-red/70
          text-xs font-mono mb-6 transition-colors">
        <ArrowLeft size={11} />back to dashboard
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <HelpCircle size={16} className="text-neon-amber" />
        <div>
          <h1 className="text-base font-bold font-mono text-neon-amber tracking-wide">Analyst Review Queue</h1>
          <p className="text-[10px] text-white/25 font-mono mt-0.5">AI confidence below threshold — manual triage required</p>
        </div>
        <div className="ml-auto text-neon-amber text-xl font-bold tabular-nums font-mono">{queue.length}</div>
      </div>

      {queue.length === 0 ? (
        <div className="border border-neon-amber/10 rounded-lg p-12 text-center">
          <div className="text-neon-amber/20 text-sm font-mono mb-2">// queue is empty</div>
          <p className="text-white/20 text-xs font-mono">
            All findings have been reviewed or no NEEDS_HUMAN_REVIEW verdicts exist.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {queue.map((f) => <QueueCard key={f.id} f={f} />)}
        </div>
      )}
    </main>
  );
}
