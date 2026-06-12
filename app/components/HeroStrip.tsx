'use client';
// app/components/HeroStrip.tsx
// Live counters: total repos, critical findings, analyst queue, next scan countdown.

import { useEffect, useState } from 'react';
import { Shield, AlertTriangle, Clock, Users } from 'lucide-react';
import type { DashboardStats } from '@/lib/db';

function CounterCard({
  label, value, icon: Icon, color = 'green',
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: 'green' | 'red' | 'amber';
}) {
  const colors = {
    green: 'text-neon-green border-neon-green/20 bg-neon-green/5',
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

function NextScanCountdown({ lastScanAt }: { lastScanAt: string | null }) {
  const [timeLeft, setTimeLeft] = useState('--:--:--');

  useEffect(() => {
    function compute() {
      // Cron fires at :00 every hour
      const now = new Date();
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      const diffMs = next.getTime() - now.getTime();
      const hh = Math.floor(diffMs / 3_600_000).toString().padStart(2, '0');
      const mm = Math.floor((diffMs % 3_600_000) / 60_000).toString().padStart(2, '0');
      const ss = Math.floor((diffMs % 60_000) / 1_000).toString().padStart(2, '0');
      setTimeLeft(`${hh}:${mm}:${ss}`);
    }
    compute();
    const id = setInterval(compute, 1_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-1 border border-neon-green/20 bg-neon-green/5 rounded px-4 py-3 text-neon-green">
      <div className="flex items-center gap-2 text-[10px] opacity-60 uppercase tracking-widest">
        <Clock size={10} />
        next scan
      </div>
      <div className="text-2xl font-bold tabular-nums font-mono">{timeLeft}</div>
    </div>
  );
}

export function HeroStrip({ stats }: { stats: DashboardStats }) {
  return (
    <section className="mb-8">
      <div className="mb-6">
        <h1 className="text-neon-green font-bold text-xl tracking-wide mb-1">
          <span className="text-glow-green">REPO</span>
          <span className="text-white/70">SCOUT</span>
          <span className="text-neon-green/40 text-sm ml-3 font-normal">// secret scanner</span>
        </h1>
        <p className="text-neon-green/30 text-xs">
          SecretScout patterns · LangGraph AI pipeline · Cloudflare Workers
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <CounterCard
          label="repos monitored"
          value={stats.totalRepos}
          icon={Shield}
          color="green"
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
        <NextScanCountdown lastScanAt={stats.lastScanAt} />
      </div>
    </section>
  );
}
