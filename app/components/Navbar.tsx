'use client';
// app/components/Navbar.tsx — RepoScout

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Shield, Activity, AlertTriangle, BarChart2, Download, Bookmark } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getBookmarks } from './BookmarkButton';

function BookmarkCount() {
  const [count,   setCount]   = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const sync = () => setCount(getBookmarks().length);
    setMounted(true);
    sync();
    window.addEventListener('reposcout:bookmarks-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('reposcout:bookmarks-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  if (!mounted || count === 0) return null;

  return (
    <span className="ml-1 tabular-nums text-[8px] font-bold px-1 py-px rounded-full
      bg-neon-amber/20 text-neon-amber border border-neon-amber/30 leading-none">
      {count}
    </span>
  );
}

export function Navbar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-neon-red/10
      bg-dark-bg/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">

        {/* Logo */}
        <Link href="/" className="flex-shrink-0 flex items-center gap-2 group">
          <Shield size={16} className="text-neon-red group-hover:drop-shadow-[0_0_6px_#ff1a1a] transition-all" />
          <span className="text-neon-red font-mono font-bold text-sm tracking-widest uppercase
            group-hover:text-glow-red transition-all">
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
                ? 'text-neon-red bg-neon-red/8'
                : 'text-neon-red/40 hover:text-neon-red/70'}`}
          >
            <Activity size={12} />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>

          <Link
            href="/review"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors
              ${isActive('/review')
                ? 'text-neon-amber bg-neon-amber/8'
                : 'text-neon-red/40 hover:text-neon-red/70'}`}
          >
            <AlertTriangle size={12} />
            <span className="hidden sm:inline">Review Queue</span>
          </Link>

          <Link
            href="/stats"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors
              ${isActive('/stats')
                ? 'text-neon-red bg-neon-red/8'
                : 'text-neon-red/40 hover:text-neon-red/70'}`}
          >
            <BarChart2 size={12} />
            <span className="hidden sm:inline">Stats</span>
          </Link>

          <Link
            href="/bookmarks"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors
              ${isActive('/bookmarks')
                ? 'text-neon-amber bg-neon-amber/8'
                : 'text-neon-red/40 hover:text-neon-amber/60'}`}
          >
            <Bookmark
              size={12}
              style={isActive('/bookmarks') ? { fill: '#ffaa00', stroke: '#ffaa00' } : {}}
            />
            <span className="hidden sm:inline">Bookmarks</span>
            <BookmarkCount />
          </Link>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Global report download */}
        <a href="/api/report?format=csv"
          className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded
            border border-neon-red/15 text-neon-red/30 hover:text-neon-red/60
            hover:border-neon-red/30 transition-all">
          <Download size={10} />
          report
        </a>

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-neon-red/30">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-dot-ping absolute inline-flex h-full w-full rounded-full bg-neon-red opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-neon-red" />
          </span>
          <span className="hidden sm:inline">scanning</span>
        </div>

      </div>
    </nav>
  );
}
