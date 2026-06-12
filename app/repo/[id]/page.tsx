// app/repo/[id]/page.tsx — FindingsInspector
// Glassmorphic cards · severity-first ranking · NEW tag · discovery date · min-severity filter.

'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { motion, useMotionTemplate, useMotionValue } from 'framer-motion';
import {
  ArrowLeft, ExternalLink, CheckCircle, HelpCircle,
  Download, Sparkles, Calendar, Info, SlidersHorizontal, EyeOff,
} from 'lucide-react';
import type { FindingWithEval } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Severity config — defined first so the hook and filter bar can reference it
// ---------------------------------------------------------------------------

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

type SevKey = (typeof SEV_ORDER)[number];

// ---------------------------------------------------------------------------
// Min-severity persistence
// ---------------------------------------------------------------------------

const LS_KEY = 'reposcout:min-severity';
const DEFAULT_MIN: SevKey = 'medium';

function useMinSeverity(): [SevKey, (s: SevKey) => void] {
  const [minSev, setMinSev] = useState<SevKey>(DEFAULT_MIN);

  // Hydrate from localStorage once on mount (SSR-safe)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LS_KEY) as SevKey | null;
      if (stored && SEV_ORDER.includes(stored)) setMinSev(stored);
    } catch {}
  }, []);

  const persist = useCallback((s: SevKey) => {
    setMinSev(s);
    try { localStorage.setItem(LS_KEY, s); } catch {}
  }, []);

  return [minSev, persist];
}

// ---------------------------------------------------------------------------
// Severity display config
// ---------------------------------------------------------------------------

const SEV_CFG: Record<SevKey, {
  label: string;
  dot: string;
  badge: string;
  border: string;
  glow: string;
  icon: string;
}> = {
  critical: {
    label: 'CRITICAL',
    dot:   'bg-neon-red',
    badge: 'bg-neon-red/15 text-neon-red border border-neon-red/40',
    border:'border-neon-red/35',
    glow:  'shadow-[0_0_24px_rgba(255,26,26,0.18)]',
    icon:  'text-neon-red',
  },
  high: {
    label: 'HIGH',
    dot:   'bg-neon-amber',
    badge: 'bg-neon-amber/15 text-neon-amber border border-neon-amber/40',
    border:'border-neon-amber/30',
    glow:  'shadow-[0_0_20px_rgba(255,170,0,0.14)]',
    icon:  'text-neon-amber',
  },
  medium: {
    label: 'MEDIUM',
    dot:   'bg-yellow-400',
    badge: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30',
    border:'border-yellow-500/20',
    glow:  '',
    icon:  'text-yellow-400',
  },
  low: {
    label: 'LOW',
    dot:   'bg-neon-red/40',
    badge: 'bg-neon-red/5 text-neon-red/50 border border-neon-red/15',
    border:'border-white/8',
    glow:  '',
    icon:  'text-neon-red/50',
  },
  info: {
    label: 'INFO',
    dot:   'bg-white/20',
    badge: 'bg-white/5 text-white/30 border border-white/10',
    border:'border-white/5',
    glow:  '',
    icon:  'text-white/30',
  },
};

// ---------------------------------------------------------------------------
// Verdict helpers
// ---------------------------------------------------------------------------

function VerdictBadge({ verdict, confidence }: { verdict?: string | null; confidence?: number | null }) {
  if (!verdict) return <span className="text-[9px] text-white/20 font-mono">— pending —</span>;
  if (verdict === 'TRUE_POSITIVE') return (
    <span className="flex items-center gap-1 text-[9px] text-neon-red font-mono">
      <CheckCircle size={9} /> TRUE POSITIVE
      {confidence != null && <span className="text-neon-red/45">({(confidence * 100).toFixed(0)}%)</span>}
    </span>
  );
  if (verdict === 'FALSE_POSITIVE') return (
    <span className="text-neon-red/35 text-[9px] font-mono">— false positive —</span>
  );
  if (verdict === 'NEEDS_HUMAN_REVIEW') return (
    <span className="flex items-center gap-1 text-[9px] text-neon-amber font-mono">
      <HelpCircle size={9} /> NEEDS REVIEW
      {confidence != null && <span className="text-neon-amber/45">({(confidence * 100).toFixed(0)}%)</span>}
    </span>
  );
  return <span className="text-[9px] text-white/30 font-mono">{verdict}</span>;
}

// ---------------------------------------------------------------------------
// Code snippet
// ---------------------------------------------------------------------------

function CodeSnippet({ context, lineNumber }: { context: string; lineNumber: number }) {
  let lines: string[];
  try {
    const parsed = JSON.parse(context);
    lines = Array.isArray(parsed) ? parsed : [context];
  } catch {
    lines = context.split('\n');
  }
  const hitIndex = Math.floor(lines.length / 2);

  return (
    <pre className="text-[11px] font-mono bg-black/50 border border-white/5 rounded-lg p-3 overflow-x-auto leading-5 my-3">
      {lines.map((line, i) => {
        const absLine = lineNumber - hitIndex + i;
        const isHit = i === hitIndex;
        return (
          <div key={i} className={`flex gap-2 ${isHit ? 'bg-neon-red/8 border-l-2 border-neon-red/50 -mx-3 px-3' : ''}`}>
            <span className="select-none text-white/15 w-6 text-right shrink-0 tabular-nums">
              {absLine > 0 ? absLine : ''}
            </span>
            <span className={isHit ? 'text-neon-red/80' : 'text-white/40'}>{line || ' '}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Glassmorphic finding card (ArxivExplorer Card pattern)
// ---------------------------------------------------------------------------

const NEW_SCAN_THRESHOLD = 6; // tag disappears after the 7th scan

function FindingCard({ f }: { f: FindingWithEval }) {
  const sev = (SEV_CFG[f.severity as SevKey] ?? SEV_CFG.info);
  const verdict = f.eval?.verdict;
  const isNew = f.scans_since_detected <= NEW_SCAN_THRESHOLD;

  // Mouse-tracking glow (ArxivExplorer Card pattern)
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const rectRef = { current: null as DOMRect | null };

  function handleMouseEnter(e: React.MouseEvent) {
    rectRef.current = e.currentTarget.getBoundingClientRect();
  }
  function handleMouseMove(e: React.MouseEvent) {
    const r = rectRef.current ?? e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - r.left);
    mouseY.set(e.clientY - r.top);
  }

  const discoveredDate = new Date(f.detected_at);
  const discoveredFmt  = discoveredDate.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const discoveredTime = discoveredDate.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2, transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
      transition={{ duration: 0.3 }}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      className={`relative group rounded-xl border p-4
        bg-[rgba(10,10,10,0.55)] backdrop-blur-[14px]
        shadow-[0_4px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.04)]
        hover:shadow-[0_8px_40px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.07)]
        transition-all duration-300
        ${sev.border} ${sev.glow}`}
    >
      {/* Mouse-tracking radial glow */}
      <motion.div
        className="pointer-events-none absolute -inset-px rounded-xl opacity-0 transition duration-500 group-hover:opacity-100"
        style={{
          background: useMotionTemplate`radial-gradient(480px circle at ${mouseX}px ${mouseY}px, rgba(255,26,26,0.07), transparent 70%)`,
        }}
      />

      {/* Corner accents */}
      <span className="absolute top-0 left-0 w-3.5 h-3.5 border-t border-l border-neon-red/20 rounded-tl-xl
        group-hover:border-neon-red/45 group-hover:w-5 group-hover:h-5 transition-all duration-300 pointer-events-none" />
      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 border-b border-r border-neon-red/20 rounded-br-xl
        group-hover:border-neon-red/45 group-hover:w-5 group-hover:h-5 transition-all duration-300 pointer-events-none" />

      {/* ── Header row ── */}
      <div className="relative flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0 flex-1">
          {/* File path + GitHub link */}
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <span className="text-neon-red/55 text-[11px] font-mono break-all">
              {f.file_path}
              <span className="text-white/20">:{f.line_number}</span>
            </span>
            {f.file_url && (
              <a href={f.file_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-[9px] text-neon-red/25 hover:text-neon-red/60 transition-colors shrink-0">
                <ExternalLink size={9} /> GitHub
              </a>
            )}
          </div>

          {/* Token + severity badge + NEW tag */}
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-[11px] font-mono text-neon-amber/75
              bg-neon-amber/8 border border-neon-amber/20 px-2 py-0.5 rounded-md">
              {f.matched_text}
            </code>

            {/* Severity */}
            <span className={`flex items-center gap-1 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded ${sev.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${sev.dot}`} />
              {sev.label}
            </span>

            {/* NEW tag — ArxivExplorer-style */}
            {isNew && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono rounded-full
                border border-neon-red/55 bg-neon-red/12 text-neon-red font-bold animate-pulse">
                <Sparkles size={8} />
                NEW
              </span>
            )}
          </div>
        </div>

        {/* Verdict */}
        <div className="shrink-0 pt-0.5">
          <VerdictBadge verdict={verdict} confidence={f.eval?.confidence} />
        </div>
      </div>

      {/* ── Discovery date ── */}
      <div className="relative flex items-center gap-1.5 mb-2">
        <Calendar size={9} className="text-white/25 shrink-0" />
        <span className="text-[9px] text-white/30 font-mono">
          discovered <span className="text-white/50">{discoveredFmt}</span>
          <span className="text-white/20 ml-1">at {discoveredTime}</span>
          {isNew && (
            <span className="ml-2 text-neon-red/40">
              · {f.scans_since_detected === 0
                  ? 'first scan'
                  : `${f.scans_since_detected} scan${f.scans_since_detected === 1 ? '' : 's'} ago`}
            </span>
          )}
        </span>
      </div>

      {/* ── Meta row ── */}
      <div className="relative flex gap-3 mb-2 flex-wrap">
        <span className="text-[9px] text-white/18 font-mono">
          template: <span className="text-white/32">{f.template_id}</span>
        </span>
        <span className="text-[9px] text-white/18 font-mono">
          pattern: <span className="text-white/32">{f.pattern_id}</span>
        </span>
        {f.eval?.validation_method && (
          <span className="text-[9px] text-white/18 font-mono">
            method: <span className="text-white/32">{f.eval.validation_method}</span>
          </span>
        )}
      </div>

      {/* ── Code snippet ── */}
      {f.context && (
        <div className="relative">
          <CodeSnippet context={f.context} lineNumber={f.line_number} />
        </div>
      )}

      {/* ── AI reasoning ── */}
      {f.eval?.reasoning && (
        <div className="relative border-t border-white/5 pt-3 mt-1">
          <div className="flex items-center gap-1.5 text-[9px] text-neon-red/22 uppercase tracking-widest mb-1 font-mono">
            <Info size={9} />
            ai reasoning
          </div>
          <p className="text-[11px] text-white/42 font-mono leading-relaxed">
            {f.eval.reasoning}
          </p>
        </div>
      )}

      {/* ── Analyst override ── */}
      {f.eval?.analyst_reviewed === 1 && f.eval.analyst_verdict && f.eval.analyst_verdict !== f.eval.ai_verdict && (
        <div className="relative mt-2 flex items-center gap-1.5 border-t border-white/5 pt-2">
          <span className="text-[9px] text-neon-red/28 font-mono">analyst override:</span>
          <span className="text-[9px] text-neon-red font-mono font-bold">{f.eval.analyst_verdict}</span>
        </div>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Section: verdict group with severity-sorted findings
// ---------------------------------------------------------------------------

function Section({
  title, count, titleColor, findings, dim = false,
}: {
  title: string;
  count: number;
  titleColor: string;
  findings: FindingWithEval[];
  dim?: boolean;
}) {
  // Sort within the section by severity order, then by newest-first (NEW first)
  const sorted = [...findings].sort((a, b) => {
    const sevA = SEV_ORDER.indexOf(a.severity as SevKey);
    const sevB = SEV_ORDER.indexOf(b.severity as SevKey);
    if (sevA !== sevB) return sevA - sevB;
    // Within same severity: NEW findings first (fewer scans_since_detected = newer)
    return a.scans_since_detected - b.scans_since_detected;
  });

  return (
    <section className={`mb-10 ${dim ? 'opacity-35 hover:opacity-60 transition-opacity duration-300' : ''}`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className={`text-[10px] font-mono uppercase tracking-widest ${titleColor}`}>{title}</h2>
        <div className="flex items-center gap-3">
          {/* Severity breakdown mini pills */}
          {(['critical', 'high', 'medium', 'low'] as SevKey[]).map((s) => {
            const n = findings.filter(f => f.severity === s).length;
            if (n === 0) return null;
            return (
              <span key={s} className={`text-[8px] font-mono px-1.5 py-0.5 rounded ${SEV_CFG[s].badge}`}>
                {n} {s}
              </span>
            );
          })}
          <span className="text-[10px] text-white/18 font-mono">{count}</span>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {sorted.map((f) => <FindingCard key={f.id} f={f} />)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Risk header
// ---------------------------------------------------------------------------

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[9px] text-white/25 font-mono uppercase">{label}</div>
    </div>
  );
}

function RiskHeader({ owner, name, url, findings }: {
  owner: string; name: string; url: string; findings: FindingWithEval[];
}) {
  const critCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const tpCount   = findings.filter(f => f.eval?.verdict === 'TRUE_POSITIVE').length;
  const nhrCount  = findings.filter(f => f.eval?.verdict === 'NEEDS_HUMAN_REVIEW').length;
  const newCount  = findings.filter(f => f.scans_since_detected <= NEW_SCAN_THRESHOLD).length;

  return (
    <div className="border border-neon-red/12 rounded-xl p-5
      bg-[rgba(10,10,10,0.55)] backdrop-blur-[12px]
      shadow-[0_4px_24px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.04)] mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-neon-red/30 text-[10px] font-mono mb-0.5">{owner} /</div>
          <h1 className="text-xl font-bold text-white font-mono">{name}</h1>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-neon-red/25 text-[10px] font-mono hover:text-neon-red/55 mt-0.5 transition-colors">
              <ExternalLink size={9} /> {url}
            </a>
          )}
        </div>
        <div className="flex gap-5 flex-wrap">
          <Stat value={critCount}  label="critical"      color="text-neon-red" />
          <Stat value={highCount}  label="high"          color="text-neon-amber" />
          <Stat value={tpCount}    label="confirmed"     color="text-neon-red" />
          <Stat value={nhrCount}   label="needs review"  color="text-neon-amber" />
          {newCount > 0 && (
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-neon-red flex items-center gap-1 justify-center">
                <Sparkles size={14} className="animate-pulse" />
                {newCount}
              </div>
              <div className="text-[9px] text-white/25 font-mono uppercase">new</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Severity filter bar
// ---------------------------------------------------------------------------

const SEV_BUTTON_CFG: Record<SevKey, {
  active: string;
  idle: string;
  dot: string;
}> = {
  critical: {
    active: 'border-neon-red/60 bg-neon-red/18 text-neon-red shadow-[0_0_12px_rgba(255,26,26,0.2)]',
    idle:   'border-neon-red/15 bg-transparent text-neon-red/35 hover:border-neon-red/35 hover:text-neon-red/60',
    dot:    'bg-neon-red',
  },
  high: {
    active: 'border-neon-amber/55 bg-neon-amber/15 text-neon-amber shadow-[0_0_12px_rgba(255,170,0,0.18)]',
    idle:   'border-neon-amber/15 bg-transparent text-neon-amber/35 hover:border-neon-amber/35 hover:text-neon-amber/60',
    dot:    'bg-neon-amber',
  },
  medium: {
    active: 'border-yellow-500/50 bg-yellow-500/12 text-yellow-400 shadow-[0_0_10px_rgba(234,179,8,0.14)]',
    idle:   'border-yellow-500/15 bg-transparent text-yellow-400/30 hover:border-yellow-500/35 hover:text-yellow-400/55',
    dot:    'bg-yellow-400',
  },
  low: {
    active: 'border-white/25 bg-white/8 text-white/60',
    idle:   'border-white/8 bg-transparent text-white/22 hover:border-white/20 hover:text-white/40',
    dot:    'bg-white/40',
  },
  info: {
    active: 'border-white/18 bg-white/5 text-white/40',
    idle:   'border-white/6 bg-transparent text-white/16 hover:border-white/15 hover:text-white/30',
    dot:    'bg-white/25',
  },
};

function SeverityFilterBar({
  minSev, onChange, allFindings,
}: {
  minSev: SevKey;
  onChange: (s: SevKey) => void;
  allFindings: FindingWithEval[];
}) {
  const minIdx = SEV_ORDER.indexOf(minSev);
  // Count per severity across ALL findings (unfiltered)
  const counts = Object.fromEntries(
    SEV_ORDER.map(s => [s, allFindings.filter(f => f.severity === s).length])
  ) as Record<SevKey, number>;

  const hiddenCount = SEV_ORDER.slice(minIdx + 1).reduce((acc, s) => acc + counts[s], 0);

  return (
    <div className="mb-6">
      {/* Label row */}
      <div className="flex items-center gap-2 mb-2.5">
        <SlidersHorizontal size={10} className="text-neon-red/35" />
        <span className="text-[10px] font-mono text-neon-red/35 uppercase tracking-widest">
          min severity
        </span>
        <span className="text-[9px] font-mono text-white/18 ml-1">
          // click to set threshold — persisted in browser
        </span>
      </div>

      {/* Button row */}
      <div className="flex flex-wrap gap-2">
        {SEV_ORDER.map((sev, idx) => {
          const cfg = SEV_BUTTON_CFG[sev];
          const isActive = sev === minSev;
          const isAbove  = idx < minIdx; // currently visible
          return (
            <button
              key={sev}
              onClick={() => onChange(sev)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[10px] font-mono
                uppercase tracking-wider transition-all duration-200 font-semibold
                ${isActive ? cfg.active : cfg.idle}`}
            >
              {/* Active indicator: expanding left border or dot */}
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-200
                ${isActive || isAbove ? cfg.dot : 'bg-transparent border border-current opacity-30'}`} />
              {sev}
              {counts[sev] > 0 && (
                <span className={`text-[8px] tabular-nums opacity-60`}>{counts[sev]}</span>
              )}
              {isActive && (
                <span className="text-[8px] opacity-50 ml-0.5">↑ min</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Hidden findings notice */}
      {hiddenCount > 0 && (
        <div className="flex items-center gap-1.5 mt-2.5 text-[9px] font-mono text-white/22">
          <EyeOff size={9} />
          {hiddenCount} finding{hiddenCount !== 1 ? 's' : ''} hidden
          {' '}— below <span className="text-white/40 mx-0.5">{minSev}</span> threshold.
          <button
            onClick={() => onChange('info')}
            className="ml-1 text-neon-red/35 hover:text-neon-red/60 underline transition-colors"
          >
            show all
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner client component (receives pre-fetched data)
// ---------------------------------------------------------------------------

function FindingsView({ findings, repoOwner, repoName, repoUrl, repoId }: {
  findings: FindingWithEval[];
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  repoId: string;
}) {
  const [minSev, setMinSev] = useMinSeverity();

  // Severity-first global sort, then new-first within severity
  const sorted = [...findings].sort((a, b) => {
    const sevA = SEV_ORDER.indexOf(a.severity as SevKey);
    const sevB = SEV_ORDER.indexOf(b.severity as SevKey);
    if (sevA !== sevB) return sevA - sevB;
    return a.scans_since_detected - b.scans_since_detected;
  });

  // Apply min-severity filter — findings below threshold are excluded
  const minIdx   = SEV_ORDER.indexOf(minSev);
  const visible  = sorted.filter(f => SEV_ORDER.indexOf(f.severity as SevKey) <= minIdx);

  const truePositives  = visible.filter(f => f.eval?.verdict === 'TRUE_POSITIVE');
  const needsReview    = visible.filter(f => f.eval?.verdict === 'NEEDS_HUMAN_REVIEW');
  const pending        = visible.filter(f => !f.eval);
  const falsePositives = visible.filter(f => f.eval?.verdict === 'FALSE_POSITIVE');

  if (findings.length === 0) {
    return (
      <div className="border border-neon-red/10 rounded-xl p-12 text-center
        bg-[rgba(10,10,10,0.4)] backdrop-blur-[10px]">
        <div className="text-neon-red/20 text-sm font-mono mb-2">// no findings for this repository</div>
        <p className="text-white/20 text-xs font-mono">Either the scan has not run yet, or no secrets were detected.</p>
      </div>
    );
  }

  return (
    <>
      <RiskHeader owner={repoOwner} name={repoName} url={repoUrl} findings={findings} />

      <SeverityFilterBar
        minSev={minSev}
        onChange={setMinSev}
        allFindings={findings}
      />

      {truePositives.length > 0 && (
        <Section title="// confirmed credentials" count={truePositives.length}
          titleColor="text-neon-red/60" findings={truePositives} />
      )}
      {needsReview.length > 0 && (
        <Section title="// needs analyst review" count={needsReview.length}
          titleColor="text-neon-amber/60" findings={needsReview} />
      )}
      {pending.length > 0 && (
        <Section title="// pending evaluation" count={pending.length}
          titleColor="text-white/20" findings={pending} />
      )}
      {falsePositives.length > 0 && (
        <Section title="// false positives" count={falsePositives.length}
          titleColor="text-white/15" findings={falsePositives} dim />
      )}

      {visible.length === 0 && findings.length > 0 && (
        <div className="border border-white/5 rounded-xl p-10 text-center
          bg-[rgba(10,10,10,0.35)] backdrop-blur-[8px]">
          <EyeOff size={20} className="mx-auto mb-3 text-white/15" />
          <div className="text-white/25 text-sm font-mono mb-1">
            all findings are below <span className="text-white/45">{minSev}</span> threshold
          </div>
          <button
            onClick={() => setMinSev('info')}
            className="mt-2 text-[10px] font-mono text-neon-red/40 hover:text-neon-red/70
              underline transition-colors"
          >
            show all {findings.length} findings
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page — fetch on client side (we're a 'use client' module)
// ---------------------------------------------------------------------------

export default function RepoDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [findings, setFindings] = useState<FindingWithEval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/repos/${id}/findings?limit=200`)
      .then(r => r.json())
      .then((data: { findings?: FindingWithEval[] }) => {
        setFindings(data.findings ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  const repoOwner = findings[0]?.repo_owner ?? '';
  const repoName  = findings[0]?.repo_name  ?? id;
  const repoUrl   = repoOwner ? `https://github.com/${repoOwner}/${repoName}` : '';

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <Link href="/"
          className="inline-flex items-center gap-1.5 text-neon-red/40 hover:text-neon-red/70 text-xs font-mono transition-colors">
          <ArrowLeft size={11} /> back to dashboard
        </Link>
        <div className="flex items-center gap-2">
          <a href={`/api/report?repo=${id}&format=json`}
            className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-1.5 rounded
              border border-neon-red/20 text-neon-red/50 bg-neon-red/5
              hover:bg-neon-red/10 hover:border-neon-red/35 hover:text-neon-red transition-all">
            <Download size={10} /> JSON
          </a>
          <a href={`/api/report?repo=${id}&format=csv`}
            className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-1.5 rounded
              border border-neon-red/20 text-neon-red/50 bg-neon-red/5
              hover:bg-neon-red/10 hover:border-neon-red/35 hover:text-neon-red transition-all">
            <Download size={10} /> CSV
          </a>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="text-neon-red/30 font-mono text-xs animate-pulse">// loading findings…</div>
        </div>
      ) : (
        <FindingsView
          findings={findings}
          repoOwner={repoOwner}
          repoName={repoName}
          repoUrl={repoUrl}
          repoId={id}
        />
      )}
    </main>
  );
}
