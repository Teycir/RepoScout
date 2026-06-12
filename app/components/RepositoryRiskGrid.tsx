'use client';
// app/components/RepositoryRiskGrid.tsx
// Cards sorted by risk_score desc with colour-coded risk meter + verdict badges.

import Link from 'next/link';
import { AlertTriangle, CheckCircle, Clock, GitBranch } from 'lucide-react';
import { riskLevel } from '@/src/lib/types';
import type { RepoRow } from '@/lib/db';
import DecryptedText from './DecryptedText';

function RiskMeter({ score }: { score: number }) {
  const level = riskLevel(score);
  const config = {
    None:     { bar: 0,    color: 'bg-neon-green/20', label: 'text-neon-green/40' },
    Low:      { bar: 20,   color: 'bg-neon-green/60', label: 'text-neon-green' },
    Medium:   { bar: 45,   color: 'bg-neon-amber/70', label: 'text-neon-amber' },
    High:     { bar: 70,   color: 'bg-neon-red/70',   label: 'text-neon-red' },
    Critical: { bar: 100,  color: 'bg-neon-red',      label: 'text-neon-red' },
  }[level];

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${config.color}`}
          style={{ width: `${Math.min(100, (score / 500) * 100)}%` }}
        />
      </div>
      <span className={`text-[10px] font-mono uppercase tracking-wide ${config.label}`}>
        {level}
      </span>
    </div>
  );
}

function SeverityBadge({ count, sev }: { count: number; sev: 'critical' | 'high' }) {
  if (count === 0) return null;
  return (
    <span className={`badge ${sev === 'critical' ? 'badge-red' : 'badge-amber'}`}>
      {sev === 'critical' ? '◆' : '▲'} {count} {sev}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === 'COMPLETED') return <CheckCircle size={10} className="text-neon-green/50" />;
  if (status === 'RUNNING')   return <Clock        size={10} className="text-neon-amber animate-pulse" />;
  if (status === 'FAILED')    return <AlertTriangle size={10} className="text-neon-red" />;
  return <span className="w-2 h-2 rounded-full bg-white/10" />;
}

function RepoCard({ repo }: { repo: RepoRow }) {
  const level = riskLevel(repo.risk_score);
  const borderColor = {
    None:     'border-white/5',
    Low:      'border-neon-green/15',
    Medium:   'border-neon-amber/20',
    High:     'border-neon-red/25',
    Critical: 'border-neon-red/40',
  }[level];

  return (
    <Link
      href={`/repo/${repo.id}`}
      className={`group block border rounded-lg p-4 bg-dark-bg/60 backdrop-blur-sm
        hover:bg-dark-bg/80 transition-all duration-200 ${borderColor}
        ${level === 'Critical' ? 'glow-red' : level === 'High' ? 'glow-amber' : 'glow-green'}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-neon-green/40 text-[10px] mb-0.5">
            <GitBranch size={9} />
            <span className="truncate">{repo.owner}</span>
          </div>
          <h3 className="font-bold text-sm text-white/90 truncate group-hover:text-neon-green transition-colors">
            <DecryptedText text={repo.name} animateOn="hover" speed={30} maxIterations={6} />
          </h3>
        </div>
        <StatusDot status={repo.last_scan_status} />
      </div>

      {/* Risk meter */}
      <RiskMeter score={repo.risk_score} />

      {/* Severity badges */}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <SeverityBadge count={repo.critical_severity_findings} sev="critical" />
        <SeverityBadge count={repo.high_severity_findings}     sev="high" />
        {repo.critical_severity_findings === 0 && repo.high_severity_findings === 0 && (
          <span className="text-[10px] text-white/20 font-mono">no high/critical findings</span>
        )}
      </div>

      {/* Last scan */}
      {repo.last_scan_at && (
        <div className="mt-2 text-[9px] text-white/20 font-mono">
          scanned {new Date(repo.last_scan_at).toLocaleString()}
        </div>
      )}
    </Link>
  );
}

export function RepositoryRiskGrid({ repos }: { repos: RepoRow[] }) {
  if (repos.length === 0) {
    return (
      <div className="border border-neon-green/10 rounded-lg p-12 text-center">
        <div className="text-neon-green/20 text-sm font-mono mb-2">// no repositories monitored yet</div>
        <div className="text-white/20 text-xs">
          Add repos to the D1 <code className="text-neon-green/30">repositories</code> table to start scanning.
        </div>
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[10px] font-mono text-neon-green/40 uppercase tracking-widest">
          // repository risk grid
        </h2>
        <span className="text-[10px] text-white/20 font-mono">{repos.length} repos</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
      </div>
    </section>
  );
}
