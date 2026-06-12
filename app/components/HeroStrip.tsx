'use client';
// app/components/HeroStrip.tsx
// Live counters: total repos, critical findings, analyst queue, scan timing.

import { useEffect, useState } from 'react';
import { Shield, AlertTriangle, Clock, Users, CalendarClock } from 'lucide-react';
import type { DashboardStats } from '@/lib/db';

function CounterCard({
  label, value, icon: Icon, color = 'red',
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: 'red' | 'amber';
}) {
  const colors = {
    red:   'text-neon-red   border-neon-red/20   bg-neon-red/5',
    amber: 'text-neon-amber border-neon-amber/20 bg-neon-amber/5',
  };
  return (
    <div className={`flex flex-col gap-1 border rounded px-4 py-3 ${colors[color]}`}>
      <div className="flex items-center gap-2 text-[10px] opacity-60 uppercase tracking-widest">
        <Icon size={10} />
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums animate-count-slide">{value}</div>
    </div>
  );
}

/** Format a UTC ISO string to a short local date+time, e.g. "12 Jun · 08:04" */
function formatScanDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** Returns "Xm ago", "Xh ago", or "Xd ago" relative to now */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diffMs / 60_000);
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ScanTimingCard({ lastScanAt }: { lastScanAt: string | null }) {
  const [nextLeft, setNextLeft] = useState('--:--:--');
  const [relAge,   setRelAge]   = useState<string | null>(null);

  useEffect(() => {
    function tick() {
      // --- next scan countdown (cron fires at :00 every 8 h: 00, 08, 16 UTC) ---
      const now  = new Date();
      const utcH = now.getUTCHours();
      const nextH = utcH < 8 ? 8 : utcH < 16 ? 16 : 24; // next boundary in UTC hours
      const next = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        nextH % 24, 0, 0, 0,
      ));
      if (nextH === 24) next.setUTCDate(next.getUTCDate() + 1);
      const diff  = next.getTime() - now.getTime();
      const hh    = Math.floor(diff / 3_600_000).toString().padStart(2, '0');
      const mm    = Math.floor((diff % 3_600_000) / 60_000).toString().padStart(2, '0');
      const ss    = Math.floor((diff % 60_000) / 1_000).toString().padStart(2, '0');
      setNextLeft(`${hh}:${mm}:${ss}`);

      // --- relative age of last scan ---
      if (lastScanAt) setRelAge(relativeTime(lastScanAt));
    }
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [lastScanAt]);

  const formattedDate = lastScanAt ? formatScanDate(lastScanAt) : null;

  return (
    <div className="flex flex-col border border-neon-red/20 bg-neon-red/5 rounded px-4 py-3 text-neon-red gap-2">
      {/* ── Last scan ── */}
      <div>
        <div className="flex items-center gap-1.5 text-[10px] opacity-60 uppercase tracking-widest mb-0.5">
          <CalendarClock size={10} />
          last scan
        </div>
        {formattedDate ? (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold font-mono leading-tight">{formattedDate}</span>
            <span className="text-[11px] opacity-50 font-mono">{relAge}</span>
          </div>
        ) : (
          <span className="text-sm opacity-40 font-mono">never</span>
        )}
      </div>

      {/* ── divider ── */}
      <div className="border-t border-neon-red/15" />

      {/* ── Next scan countdown ── */}
      <div>
        <div className="flex items-center gap-1.5 text-[10px] opacity-60 uppercase tracking-widest mb-0.5">
          <Clock size={10} />
          next scan
        </div>
        <div className="text-xl font-bold tabular-nums font-mono leading-tight">{nextLeft}</div>
      </div>
    </div>
  );
}

export function HeroStrip({ stats }: { stats: DashboardStats }) {
  return (
    <section className="mb-8">
      <div className="mb-6">
        <h1 className="text-neon-red font-bold text-xl tracking-wide mb-1">
          <span className="text-glow-red">REPO</span>
          <span className="text-white/70">SCOUT</span>
          <span className="text-neon-red/40 text-sm ml-3 font-normal">// secret scanner</span>
        </h1>
        <p className="text-neon-red/30 text-xs">
          SecretScout patterns · LangGraph AI pipeline · Cloudflare Workers
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CounterCard
          label="repos monitored"
          value={stats.totalRepos}
          icon={Shield}
          color="red"
        />
        <CounterCard
          label="critical findings"
          value={stats.criticalFindings}
          icon={AlertTriangle}
          color="red"
        />
        <CounterCard
          label="analyst queue"
          value={stats.analystQueueCount}
          icon={Users}
          color="amber"
        />
        <ScanTimingCard lastScanAt={stats.lastScanAt} />
      </div>
    </section>
  );
}
