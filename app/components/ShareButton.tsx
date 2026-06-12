'use client';
// app/components/ShareButton.tsx
// Copies a shareable URL to the clipboard and shows a brief toast.
// Used on repo cards (copies /repo/<id> URL) and the detail page header.

import { useCallback, useState } from 'react';
import { Share2, Check } from 'lucide-react';

interface Props {
  /** Full URL to share. Defaults to window.location.href if omitted. */
  url?: string;
  /** 'icon' = icon-only (card), 'button' = icon + label (detail page) */
  variant?: 'icon' | 'button';
  className?: string;
}

export function ShareButton({ url, variant = 'icon', className = '' }: Props) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const target = url ?? window.location.href;

      try {
        if (navigator.share) {
          await navigator.share({ url: target, title: 'RepoScout finding' });
        } else {
          await navigator.clipboard.writeText(target);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      } catch {
        // User cancelled share or clipboard denied — silently ignore
      }
    },
    [url],
  );

  const isIcon = variant === 'icon';

  return (
    <button
      onClick={handleClick}
      title={copied ? 'Copied!' : 'Copy link'}
      className={[
        'flex items-center gap-1.5 transition-all duration-200',
        isIcon
          ? 'p-1 rounded'
          : 'text-[10px] font-mono px-3 py-1.5 rounded border',
        copied
          ? isIcon
            ? 'text-neon-red'
            : 'text-neon-red border-neon-red/40 bg-neon-red/8'
          : isIcon
          ? 'text-white/20 hover:text-neon-red/60'
          : 'text-neon-red/40 border-neon-red/20 bg-neon-red/5 hover:text-neon-red hover:border-neon-red/35',
        className,
      ].join(' ')}
    >
      {copied ? (
        <Check size={isIcon ? 12 : 10} />
      ) : (
        <Share2 size={isIcon ? 12 : 10} />
      )}
      {!isIcon && (
        <span>{copied ? 'Copied!' : 'Share'}</span>
      )}
    </button>
  );
}
