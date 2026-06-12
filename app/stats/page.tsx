// app/stats/page.tsx — RepoScout Statistics Dashboard
// Server component: fetches FullStats from D1, passes to client chart components.

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getFullStats } from '@/lib/db';
import type { FullStats } from '@/lib/db';
import Link from 'next/link';
import { ArrowLeft, Download } from 'lucide-react';
import { StatsCharts } from './StatsCharts';

export const runtime  = 'edge';
export const revalidate = 60;
export const metadata = { title: 'Statistics' };

// ---------------------------------------------------------------------------
// Fallback empty stats for local dev (no CF context)
// ---------------------------------------------------------------------------
const EMPTY_STATS: FullStats = {
  severity:      [],
  verdicts:      { true_positives: 0, false_positives: 0, needs_review: 0, pending: 0, analyst_reviewed: 0 },
  topRepos:      [],
  scanTrends:    [],
  totalFindings: 0,
  totalRepos:    0,
  scansRun:      0,
};

// ---------------------------------------------------------------------------
// Stat card (server-rendered)
// ---------------------------------------------------------------------------
function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="border border-neon-red/15 rounded-lg px-5 py-4 bg-dark-bg/60">
      <div className="text-[10px] font-mono text-neon-red/40 uppercase tracking-widest mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums text-neon-red font-mono">{value}</div>
      {sub && <div className="text-[10px] text-white/25 font-mono mt-0.5">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default async function StatsPage() {
  let stats = EMPTY_STATS;
  try {
    const { env } = await getCloudflareContext();
    stats = await getFullStats(env.DB);
  } catch { /* dev fallback */ }

  const precision = stats.totalFindings > 0
    ? Math.round((stats.verdicts.true_positives / stats.totalFindings) * 100)
    : 0;

  return (
    <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <Link href="/"
            className="inline-flex items-center gap-1.5 text-neon-red/40 hover:text-neon-red/70
              text-xs font-mono transition-colors">
            <ArrowLeft size={11} />back
          </Link>
          <div>
            <h1 className="text-base font-bold font-mono text-neon-red tracking-wide">
              // statistics
            </h1>
            <p className="text-[10px] text-white/25 font-mono">
              aggregated across all repos · {stats.scansRun} scans completed
            </p>
          </div>
        </div>

        {/* Global download buttons */}
        <div className="flex items-center gap-2">
          <a href="/api/report?format=json"
            className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-1.5 rounded
              border border-neon-red/20 text-neon-red/50 bg-neon-red/5
              hover:bg-neon-red/10 hover:border-neon-red/35 hover:text-neon-red
              transition-all">
            <Download size={10} />
            JSON report
          </a>
          <a href="/api/report?format=csv"
            className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-1.5 rounded
              border border-neon-red/20 text-neon-red/50 bg-neon-red/5
              hover:bg-neon-red/10 hover:border-neon-red/35 hover:text-neon-red
              transition-all">
            <Download size={10} />
            CSV report
          </a>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <StatCard label="total findings"   value={stats.totalFindings} />
        <StatCard label="confirmed leaks"  value={stats.verdicts.true_positives}
                  sub={`${precision}% detection rate`} />
        <StatCard label="analyst queue"    value={stats.verdicts.needs_review} />
        <StatCard label="repos monitored"  value={stats.totalRepos} />
      </div>

      {/* Client charts */}
      <StatsCharts stats={stats} />
    </main>
  );
}
