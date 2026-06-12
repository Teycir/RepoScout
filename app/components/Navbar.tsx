'use client';
// app/components/Navbar.tsx — RepoScout adapted from ArxivExplorer

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Shield, Activity, Users, AlertTriangle } from 'lucide-react';

export function Navbar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-neon-green/10
      bg-dark-bg/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
        {/* Logo */}
        <Link href="/" className="flex-shrink-0 flex items-center gap-2 group">
          <Shield size={16} className="text-neon-green group-hover:drop-shadow-[0_0_6px_#00ff41] transition-all" />
          <span className="text-neon-green font-mono font-bold text-sm tracking-widest uppercase
            group-hover:text-glow-green transition-all">
            Repo
          </span>
          <span className="text-white/60 font-mono font-light text-sm tracking-widest uppercase">
            Scout
          </span>
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-1 text-xs font-mono">
          <Link
            href="/"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors
              ${isActive('/') && pathname === '/'
                ? 'text-neon-green bg-neon-green/8'
                : 'text-neon-green/40 hover:text-neon-green/70'}`}
          >
            <Activity size={12} />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>

          <Link
            href="/review"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors
              ${isActive('/review')
                ? 'text-neon-amber bg-neon-amber/8'
                : 'text-neon-green/40 hover:text-neon-green/70'}`}
          >
            <AlertTriangle size={12} />
            <span className="hidden sm:inline">Review Queue</span>
          </Link>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-neon-green/30">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-dot-ping absolute inline-flex h-full w-full rounded-full bg-neon-green opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-neon-green" />
          </span>
          <span className="hidden sm:inline">scanning</span>
        </div>
      </div>
    </nav>
  );
}
