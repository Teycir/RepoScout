'use client';
// app/components/BookmarksPanel.tsx
// Compact ambient strip on the dashboard (amber pills, newest first).
// Keeps in sync with BookmarkButton via the "reposcout:bookmarks-changed" event.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bookmark, X } from 'lucide-react';
import { getBookmarks, removeBookmark, broadcast, type BookmarkEntry } from './BookmarkButton';

export function BookmarksPanel() {
  const [entries, setEntries] = useState<BookmarkEntry[]>([]);
  const [mounted, setMounted] = useState(false);

  const refresh = () => setEntries(getBookmarks());

  useEffect(() => {
    setMounted(true);
    refresh();
    window.addEventListener('reposcout:bookmarks-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('reposcout:bookmarks-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const remove = (id: string) => {
    removeBookmark(id);
    refresh();
    broadcast();
  };

  if (!mounted || entries.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Bookmark size={10} style={{ fill: '#ffaa00', stroke: '#ffaa00' }} />
          <span className="text-[10px] font-mono text-neon-amber/60 uppercase tracking-widest">
            // bookmarked repos
          </span>
          <span className="text-[10px] text-white/20 font-mono">{entries.length}</span>
        </div>
        <Link
          href="/bookmarks"
          className="text-[9px] font-mono text-neon-amber/35 hover:text-neon-amber/70 transition-colors underline underline-offset-2"
        >
          manage →
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {entries.map((e) => (
          <div
            key={e.id}
            className="group flex items-center gap-1.5 border border-neon-amber/25 bg-neon-amber/5
              rounded-lg px-2.5 py-1.5 text-[10px] font-mono text-neon-amber/70
              hover:border-neon-amber/45 hover:bg-neon-amber/10 transition-all"
          >
            <Link href={`/repo/${e.id}`} className="hover:text-neon-amber transition-colors">
              {e.id}
            </Link>
            {e.comment && (
              <span className="text-neon-amber/30 truncate max-w-[120px]" title={e.comment}>
                · {e.comment}
              </span>
            )}
            <button
              onClick={() => remove(e.id)}
              title="Remove bookmark"
              className="text-neon-amber/30 hover:text-neon-red/60 transition-colors ml-0.5"
            >
              <X size={9} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
