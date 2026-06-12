'use client';
// app/stats/StatsCharts.tsx
// Interactive chart panels rendered client-side using plain SVG + CSS.
// Zero external charting library needed — keeps the bundle lean.

import { useState } from 'react';
import Link from 'next/link';
import type { FullStats, SeverityStats, ScanTrend, TopRiskyRepo } from '@/lib/db';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
const SEV_COLOR: Record<string, string> = {
  critical: '#ff1a1a',
  high:     '#ffaa00',
  medium:   '#facc15',
  low:      'rgba(255,26,26,0.40)',
  info:     'rgba(255,255,255,0.20)',
};
const VERDICT_COLORS = {
  true_positives:  '#ff1a1a',
  false_positives: 'rgba(255,255,255,0.20)',
  needs_review:    '#ffaa00',
  pending:         'rgba(255,255,255,0.10)',
};

// ---------------------------------------------------------------------------
// Mini bar chart for severity breakdown
// ---------------------------------------------------------------------------
function SeverityChart({ rows }: { rows: SeverityStats[] }) {
  const max = Math.max(...rows.map(r => r.total), 1);
  return (
    <div className="border border-neon-red/10 rounded-lg p-5 bg-dark-bg/60">
      <h2 className="text-[10px] font-mono text-neon-red/40 uppercase tracking-widest mb-4">
        // findings by severity
      </h2>
      {rows.length === 0 && (
        <p className="text-white/20 text-xs font-mono">no data yet</p>
      )}
      <div className="flex flex-col gap-3">
        {rows.map(r => (
          <div key={r.severity} className="flex items-center gap-3">
            <span className="w-14 text-[10px] font-mono uppercase tracking-wide text-right"
              style={{ color: SEV_COLOR[r.severity] ?? '#fff' }}>
              {r.severity}
            </span>
            <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden relative">
              {/* stacked segments: TP / NHR / FP */}
              {(() => {
                const tp  = (r.true_positives  / r.total) * 100;
                const nhr = (r.needs_review    / r.total) * 100;
                const fp  = (r.false_positives / r.total) * 100;
                const barW = (r.total / max) * 100;
                return (
                  <div className="h-full flex" style={{ width: `${barW}%` }}>
                    <div style={{ width:`${tp}%`,  background: VERDICT_COLORS.true_positives }} />
                    <div style={{ width:`${nhr}%`, background: VERDICT_COLORS.needs_review   }} />
                    <div style={{ width:`${fp}%`,  background: VERDICT_COLORS.false_positives }} />
                  </div>
                );
              })()}
            </div>
            <span className="w-8 text-right text-[11px] font-mono text-white/40 tabular-nums">
              {r.total}
            </span>
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 mt-4 flex-wrap">
        {([['true_positives','Confirmed'],['needs_review','Needs review'],['false_positives','False positive']] as const).map(([k,label]) => (
          <span key={k} className="flex items-center gap-1.5 text-[10px] font-mono text-white/30">
            <span className="w-2 h-2 rounded-sm inline-block" style={{ background: VERDICT_COLORS[k] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut for verdict distribution
// ---------------------------------------------------------------------------
function VerdictDonut({ v }: { v: FullStats['verdicts'] }) {
  const total = v.true_positives + v.false_positives + v.needs_review + v.pending;
  const segments = [
    { label: 'Confirmed',     value: v.true_positives,  color: VERDICT_COLORS.true_positives },
    { label: 'Needs review',  value: v.needs_review,    color: VERDICT_COLORS.needs_review   },
    { label: 'False positive',value: v.false_positives, color: VERDICT_COLORS.false_positives },
    { label: 'Pending',       value: v.pending,          color: VERDICT_COLORS.pending         },
  ].filter(s => s.value > 0);

  // Build SVG arc paths
  const R = 60, r = 38, cx = 80, cy = 80;
  let angle = -Math.PI / 2;
  const paths = segments.map(s => {
    const slice = (s.value / Math.max(total, 1)) * 2 * Math.PI;
    const x1 = cx + R * Math.cos(angle);
    const y1 = cy + R * Math.sin(angle);
    angle += slice;
    const x2 = cx + R * Math.cos(angle);
    const y2 = cy + R * Math.sin(angle);
    const ix1 = cx + r * Math.cos(angle);
    const iy1 = cy + r * Math.sin(angle);
    angle -= slice;
    const ix2 = cx + r * Math.cos(angle);
    const iy2 = cy + r * Math.sin(angle);
    angle += slice;
    const large = slice > Math.PI ? 1 : 0;
    return {
      ...s,
      d: `M${x1},${y1} A${R},${R} 0 ${large},1 ${x2},${y2}
          L${ix1},${iy1} A${r},${r} 0 ${large},0 ${ix2},${iy2} Z`,
    };
  });

  return (
    <div className="border border-neon-red/10 rounded-lg p-5 bg-dark-bg/60">
      <h2 className="text-[10px] font-mono text-neon-red/40 uppercase tracking-widest mb-4">
        // verdict distribution
      </h2>
      <div className="flex items-center gap-6 flex-wrap">
        <svg width="160" height="160" viewBox="0 0 160 160">
          {paths.map((p, i) => (
            <path key={i} d={p.d} fill={p.color} opacity="0.85" />
          ))}
          <text x="80" y="76" textAnchor="middle" fill="#e0e0e0"
            fontSize="18" fontFamily="monospace" fontWeight="bold">{total}</text>
          <text x="80" y="91" textAnchor="middle" fill="rgba(255,255,255,0.3)"
            fontSize="9" fontFamily="monospace">total</text>
        </svg>
        <div className="flex flex-col gap-2">
          {segments.map(s => (
            <div key={s.label} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className="text-[11px] font-mono text-white/50">{s.label}</span>
              <span className="text-[11px] font-mono text-white/70 tabular-nums ml-auto pl-4">{s.value}</span>
            </div>
          ))}
          <div className="border-t border-white/5 pt-2 mt-1 text-[10px] font-mono text-neon-red/40">
            {v.analyst_reviewed} analyst reviewed
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline / area chart for scan trends
// ---------------------------------------------------------------------------
function TrendChart({ trends }: { trends: ScanTrend[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (trends.length === 0) {
    return (
      <div className="border border-neon-red/10 rounded-lg p-5 bg-dark-bg/60">
        <h2 className="text-[10px] font-mono text-neon-red/40 uppercase tracking-widest mb-4">
          // scan history
        </h2>
        <p className="text-white/20 text-xs font-mono">no scan data yet</p>
      </div>
    );
  }

  const W = 540, H = 120, PAD = 8;
  const maxVal = Math.max(...trends.map(t => t.total_findings), 1);
  const xStep  = (W - PAD * 2) / Math.max(trends.length - 1, 1);

  const pts = (key: keyof ScanTrend) =>
    trends.map((t, i) => ({
      x: PAD + i * xStep,
      y: H - PAD - ((Number(t[key]) / maxVal) * (H - PAD * 2)),
    }));

  const polyline = (points: {x:number,y:number}[]) =>
    points.map(p => `${p.x},${p.y}`).join(' ');

  const totalPts = pts('total_findings');
  const tpPts    = pts('true_positives');

  // Close path for filled area
  const areaPath = (points: {x:number,y:number}[]) =>
    `M${points[0].x},${H} ` +
    points.map(p => `L${p.x},${p.y}`).join(' ') +
    ` L${points[points.length-1].x},${H} Z`;

  return (
    <div className="border border-neon-red/10 rounded-lg p-5 bg-dark-bg/60">
      <h2 className="text-[10px] font-mono text-neon-red/40 uppercase tracking-widest mb-4">
        // scan history (last {trends.length} days)
      </h2>
      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ height: `${H}px` }}
          onMouseLeave={() => setHover(null)}
        >
          {/* Grid lines */}
          {[0.25, 0.5, 0.75, 1].map(f => (
            <line key={f}
              x1={PAD} y1={H - PAD - f * (H - PAD * 2)}
              x2={W - PAD} y2={H - PAD - f * (H - PAD * 2)}
              stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
          ))}

          {/* Total findings area */}
          <path d={areaPath(totalPts)} fill="rgba(255,26,26,0.06)" />
          <polyline points={polyline(totalPts)}
            fill="none" stroke="rgba(255,26,26,0.35)" strokeWidth="1.5" />

          {/* True positives line */}
          <polyline points={polyline(tpPts)}
            fill="none" stroke="#ff1a1a" strokeWidth="2" />

          {/* Hover dots + vertical line */}
          {hover !== null && (
            <>
              <line x1={totalPts[hover].x} y1={PAD}
                    x2={totalPts[hover].x} y2={H}
                stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <circle cx={totalPts[hover].x} cy={totalPts[hover].y}
                r="3" fill="rgba(255,26,26,0.5)" />
              <circle cx={tpPts[hover].x} cy={tpPts[hover].y}
                r="3" fill="#ff1a1a" />
            </>
          )}

          {/* Invisible hover targets */}
          {trends.map((_, i) => (
            <rect key={i}
              x={PAD + i * xStep - xStep / 2} y={0}
              width={xStep} height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>

        {/* Hover tooltip */}
        {hover !== null && (
          <div className="mt-2 text-[10px] font-mono text-white/50 flex gap-4 flex-wrap">
            <span className="text-white/30">{trends[hover].date}</span>
            <span>findings: <span className="text-neon-red/70">{trends[hover].total_findings}</span></span>
            <span>confirmed: <span className="text-neon-red">{trends[hover].true_positives}</span></span>
            <span>false+: <span className="text-white/40">{trends[hover].false_positives}</span></span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-white/30">
          <span className="w-4 h-0.5 inline-block" style={{ background: 'rgba(255,26,26,0.35)' }} />
          Total findings
        </span>
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-white/30">
          <span className="w-4 h-0.5 inline-block bg-neon-red" />
          Confirmed leaks
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top repos table
// ---------------------------------------------------------------------------
function TopReposTable({ repos }: { repos: TopRiskyRepo[] }) {
  if (repos.length === 0) return null;
  const maxScore = Math.max(...repos.map(r => r.risk_score), 1);
  return (
    <div className="border border-neon-red/10 rounded-lg p-5 bg-dark-bg/60">
      <h2 className="text-[10px] font-mono text-neon-red/40 uppercase tracking-widest mb-4">
        // top repos by risk score
      </h2>
      <div className="flex flex-col gap-2">
        {repos.map((r, i) => (
          <Link key={r.id} href={`/repo/${r.id}`}
            className="flex items-center gap-3 group hover:bg-white/3 rounded px-1 -mx-1 transition-colors">
            <span className="text-[10px] font-mono text-white/20 w-4 text-right">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[11px] font-mono text-neon-red/50 group-hover:text-neon-red/80 transition-colors truncate">
                  {r.owner}/{r.name}
                </span>
                {r.critical > 0 && (
                  <span className="text-[9px] font-mono px-1 rounded bg-neon-red/15 text-neon-red border border-neon-red/20">
                    {r.critical} crit
                  </span>
                )}
                {r.high > 0 && (
                  <span className="text-[9px] font-mono px-1 rounded bg-neon-amber/10 text-neon-amber border border-neon-amber/20">
                    {r.high} high
                  </span>
                )}
              </div>
              <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-neon-red/60"
                  style={{ width: `${(r.risk_score / maxScore) * 100}%` }} />
              </div>
            </div>
            <span className="text-[11px] font-mono tabular-nums text-neon-red/60 w-12 text-right shrink-0">
              {Math.round(r.risk_score)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------
export function StatsCharts({ stats }: { stats: FullStats }) {
  return (
    <div className="flex flex-col gap-4">
      {/* Row 1: severity + donut side-by-side on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SeverityChart rows={stats.severity} />
        <VerdictDonut  v={stats.verdicts}   />
      </div>

      {/* Row 2: trend (full width) */}
      <TrendChart trends={stats.scanTrends} />

      {/* Row 3: top repos */}
      <TopReposTable repos={stats.topRepos} />
    </div>
  );
}
