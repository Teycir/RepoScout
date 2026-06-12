'use client';
// app/review/TriageButtons.tsx
// Client component: one-click triage buttons that POST to /api/review.
// Optimistically shows confirmation state on success, then refreshes the queue.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';

type TriageVerdict = 'TRUE_POSITIVE' | 'FALSE_POSITIVE';

interface Props {
  evalId:    string;
  findingId: string;
}

export function TriageButtons({ evalId, findingId }: Props) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [chosen, setChosen] = useState<TriageVerdict | null>(null);

  async function handleTriage(verdict: TriageVerdict) {
    if (state === 'loading' || state === 'done') return;
    setState('loading');
    setChosen(verdict);
    try {
      const res = await fetch('/api/review', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ evalId, findingId, verdict }),
      });
      if (!res.ok) throw new Error(await res.text());
      setState('done');
      // Refresh the server component so the triaged card drops off the queue.
      router.refresh();
    } catch (err) {
      console.error('[triage]', err);
      setState('error');
    }
  }

  if (state === 'done') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] font-mono">
        <CheckCircle size={11} className={chosen === 'TRUE_POSITIVE' ? 'text-neon-red' : 'text-neon-red/60'} />
        <span className={chosen === 'TRUE_POSITIVE' ? 'text-neon-red/60' : 'text-neon-red/40'}>
          marked {chosen === 'TRUE_POSITIVE' ? 'true positive' : 'false positive'}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => handleTriage('TRUE_POSITIVE')}
        disabled={state === 'loading'}
        className="flex items-center gap-1 text-[10px] font-mono px-3 py-1.5 rounded
          border border-neon-red/25 text-neon-red/60 bg-neon-red/5
          hover:bg-neon-red/10 hover:border-neon-red/40 hover:text-neon-red
          disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {state === 'loading' && chosen === 'TRUE_POSITIVE'
          ? <Loader2 size={9} className="animate-spin" />
          : <XCircle size={9} />}
        confirm leak
      </button>

      <button
        onClick={() => handleTriage('FALSE_POSITIVE')}
        disabled={state === 'loading'}
        className="flex items-center gap-1 text-[10px] font-mono px-3 py-1.5 rounded
          border border-neon-red/15 text-neon-red/40 bg-neon-red/5
          hover:bg-neon-red/10 hover:border-neon-red/30 hover:text-neon-red/70
          disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {state === 'loading' && chosen === 'FALSE_POSITIVE'
          ? <Loader2 size={9} className="animate-spin" />
          : <CheckCircle size={9} />}
        false positive
      </button>

      {state === 'error' && (
        <span className="text-[9px] text-neon-red/50 font-mono">error — retry</span>
      )}
    </div>
  );
}
