'use client';
// app/components/BookmarkButton.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Storage schema (localStorage key: "reposcout:bookmarks-v2")
//   BookmarkEntry[]  – JSON array, newest first
//
// Limits / guards
//   MAX_ENTRIES   50  – oldest entry evicted when exceeded
//   MAX_COMMENT   500 chars per comment
//   MAX_STORE     48 KB  – refuse write if serialised size would exceed this
//                          (localStorage quota is typically 5 MB per origin;
//                           we stay well under to leave room for other keys)
//
// Migration
//   Old key "reposcout:bookmarks" (string[]) is imported once then deleted.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';
import { Bookmark } from 'lucide-react';

// ── Constants ─────────────────────────────────────────────────────────────────

export const LS_KEY        = 'reposcout:bookmarks-v2';
const LS_KEY_LEGACY        = 'reposcout:bookmarks';
export const MAX_ENTRIES   = 50;
export const MAX_COMMENT   = 500;   // characters
const MAX_STORE_BYTES      = 48 * 1024; // 48 KB
const EV                   = 'reposcout:bookmarks-changed';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BookmarkEntry {
  id:        string;   // repo id
  addedAt:   string;   // ISO-8601
  comment:   string;   // user note, may be empty
}

// ── Low-level store helpers ───────────────────────────────────────────────────

/** Read & validate the store. Never throws. */
export function readStore(): BookmarkEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is BookmarkEntry =>
        e && typeof e.id === 'string' &&
        typeof e.addedAt === 'string' &&
        typeof e.comment === 'string',
    );
  } catch {
    return [];
  }
}

/** Write to store with size guard. Returns false if the write was refused. */
function writeStore(entries: BookmarkEntry[]): boolean {
  try {
    const serialised = JSON.stringify(entries);
    if (serialised.length > MAX_STORE_BYTES) return false;
    localStorage.setItem(LS_KEY, serialised);
    return true;
  } catch {
    return false;
  }
}

/** Broadcast change event to all listeners on this page (cross-tab via 'storage'). */
export function broadcast() {
  window.dispatchEvent(new Event(EV));
}

// ── Migration from v1 (string[]) ──────────────────────────────────────────────

function migrateOnce(): void {
  try {
    if (localStorage.getItem(LS_KEY)) return; // v2 already exists
    const legacy = localStorage.getItem(LS_KEY_LEGACY);
    if (!legacy) return;
    const ids: unknown = JSON.parse(legacy);
    if (!Array.isArray(ids)) return;
    const entries: BookmarkEntry[] = (ids as string[])
      .filter((id) => typeof id === 'string')
      .slice(0, MAX_ENTRIES)
      .map((id) => ({ id, addedAt: new Date().toISOString(), comment: '' }));
    writeStore(entries);
    localStorage.removeItem(LS_KEY_LEGACY);
  } catch {
    // Silent — migration is best-effort
  }
}

// ── Public API (used by page + panel + button) ────────────────────────────────

/** Returns all bookmark entries, newest first. */
export function getBookmarks(): BookmarkEntry[] {
  migrateOnce();
  return readStore();
}

/** True if `id` is currently bookmarked. */
export function isBookmarked(id: string): boolean {
  return getBookmarks().some((e) => e.id === id);
}

/**
 * Toggle bookmark for `id`.
 * Returns { bookmarked, full } where `full` means the store is at MAX_ENTRIES
 * and the add was refused.
 */
export function toggleBookmark(id: string): { bookmarked: boolean; full: boolean } {
  const entries = getBookmarks();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx !== -1) {
    // Remove
    writeStore(entries.filter((_, i) => i !== idx));
    return { bookmarked: false, full: false };
  }
  // Add — enforce cap
  if (entries.length >= MAX_ENTRIES) {
    return { bookmarked: false, full: true };
  }
  const next: BookmarkEntry[] = [
    { id, addedAt: new Date().toISOString(), comment: '' },
    ...entries,
  ];
  const ok = writeStore(next);
  return { bookmarked: ok, full: !ok };
}

/**
 * Update the comment for a bookmark.
 * Silently truncates to MAX_COMMENT chars.
 * Returns false if the entry doesn't exist or the write was refused.
 */
export function setComment(id: string, comment: string): boolean {
  const entries = getBookmarks();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const trimmed = comment.slice(0, MAX_COMMENT);
  const next = entries.map((e, i) => (i === idx ? { ...e, comment: trimmed } : e));
  return writeStore(next);
}

/** Remove one bookmark by id. */
export function removeBookmark(id: string): void {
  writeStore(getBookmarks().filter((e) => e.id !== id));
}

/** Wipe all bookmarks. */
export function clearAllBookmarks(): void {
  writeStore([]);
}

/** Serialised byte count of current store. */
export function storeSizeBytes(): number {
  try {
    const raw = localStorage.getItem(LS_KEY) ?? '[]';
    return raw.length; // UTF-16 LE in spec, but chars ≈ bytes for ASCII content
  } catch {
    return 0;
  }
}

// ── BookmarkButton component ──────────────────────────────────────────────────

interface Props {
  repoId:   string;
  variant?: 'icon' | 'button';
  className?: string;
}

export function BookmarkButton({ repoId, variant = 'icon', className = '' }: Props) {
  const [bookmarked, setBookmarked]   = useState(false);
  const [flash,      setFlash]        = useState(false);
  const [fullWarn,   setFullWarn]     = useState(false);

  // Hydrate on mount (SSR-safe) and keep in sync with other button instances
  useEffect(() => {
    const sync = () => setBookmarked(isBookmarked(repoId));
    sync();
    window.addEventListener(EV,       sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EV,       sync);
      window.removeEventListener('storage', sync);
    };
  }, [repoId]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const { bookmarked: now, full } = toggleBookmark(repoId);
      if (full) {
        setFullWarn(true);
        setTimeout(() => setFullWarn(false), 2500);
        return;
      }
      setBookmarked(now);
      setFlash(true);
      setTimeout(() => setFlash(false), 600);
      broadcast();
    },
    [repoId],
  );

  const isIcon = variant === 'icon';

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        title={
          fullWarn
            ? `Limit reached (${MAX_ENTRIES} max)`
            : bookmarked
            ? 'Remove bookmark'
            : 'Bookmark this repo'
        }
        aria-pressed={bookmarked}
        className={[
          'flex items-center gap-1.5 transition-all duration-200',
          isIcon ? 'p-1 rounded' : 'text-[10px] font-mono px-3 py-1.5 rounded border',
          fullWarn
            ? isIcon
              ? 'text-neon-red/70'
              : 'text-neon-red/70 border-neon-red/40 bg-neon-red/8'
            : bookmarked
            ? isIcon
              ? 'text-neon-amber'
              : 'text-neon-amber border-neon-amber/40 bg-neon-amber/8 hover:bg-neon-amber/14'
            : isIcon
            ? 'text-white/20 hover:text-neon-amber/60'
            : 'text-neon-red/40 border-neon-red/20 bg-neon-red/5 hover:text-neon-amber/70 hover:border-neon-amber/30',
          flash ? 'scale-110' : 'scale-100',
          className,
        ].join(' ')}
      >
        <Bookmark
          size={isIcon ? 12 : 10}
          style={bookmarked ? { fill: '#ffaa00', stroke: '#ffaa00' } : {}}
        />
        {!isIcon && (
          <span>{fullWarn ? `limit (${MAX_ENTRIES})` : bookmarked ? 'Bookmarked' : 'Bookmark'}</span>
        )}
      </button>

      {/* Overflow warning tooltip */}
      {fullWarn && isIcon && (
        <div className="absolute right-0 top-6 z-50 whitespace-nowrap text-[9px] font-mono
          bg-dark-bg border border-neon-red/30 text-neon-red/70 px-2 py-1 rounded shadow-lg pointer-events-none">
          limit reached ({MAX_ENTRIES})
        </div>
      )}
    </div>
  );
}
