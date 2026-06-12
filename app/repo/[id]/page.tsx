// app/repo/[id]/page.tsx — FindingsInspector
// Per-repo detail page: all findings with code context, AI verdict, masked token.

import Link from "next/link";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getFindingsForRepo } from "@/lib/db";
import type { FindingWithEval } from "@/lib/db";
import { ArrowLeft, ExternalLink, CheckCircle, HelpCircle } from "lucide-react";

export const runtime = "edge";
export const revalidate = 30;

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ sev }: { sev: string }) {
  const cfg: Record<string, string> = {
    critical: "bg-neon-red/15 text-neon-red border border-neon-red/30",
    high: "bg-neon-amber/15 text-neon-amber border border-neon-amber/30",
    medium: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
    low: "bg-neon-red/5 text-neon-red/50 border border-neon-red/10",
    info: "bg-white/5 text-white/30 border border-white/10",
  };
  return (
    <span
      className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded ${cfg[sev] ?? cfg["info"]}`}
    >
      {sev}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Verdict badge
// ---------------------------------------------------------------------------

function VerdictBadge({
  verdict,
  confidence,
}: {
  verdict: string | null | undefined;
  confidence: number | null | undefined;
}) {
  if (!verdict) {
    return (
      <span className="text-[9px] text-white/20 font-mono">— pending —</span>
    );
  }
  if (verdict === "TRUE_POSITIVE") {
    return (
      <span className="flex items-center gap-1 text-[9px] text-neon-red font-mono">
        <CheckCircle size={9} />
        TRUE POSITIVE
        {confidence != null && (
          <span className="text-neon-red/50">
            ({(confidence * 100).toFixed(0)}%)
          </span>
        )}
      </span>
    );
  }
  if (verdict === "FALSE_POSITIVE") {
    return (
      <span className="text-neon-red/40 text-[9px] font-mono">— false positive —</span>
    );
  }
  if (verdict === "NEEDS_HUMAN_REVIEW") {
    return (
      <span className="flex items-center gap-1 text-[9px] text-neon-amber font-mono">
        <HelpCircle size={9} />
        NEEDS REVIEW
        {confidence != null && (
          <span className="text-neon-amber/50">
            ({(confidence * 100).toFixed(0)}%)
          </span>
        )}
      </span>
    );
  }
  return <span className="text-[9px] text-white/30 font-mono">{verdict}</span>;
}

// ---------------------------------------------------------------------------
// Code snippet block — renders context lines with hit line highlighted
// ---------------------------------------------------------------------------

function CodeSnippet({
  context,
  lineNumber,
}: {
  context: string;
  lineNumber: number;
}) {
  let lines: string[];
  try {
    const parsed = JSON.parse(context);
    lines = Array.isArray(parsed) ? parsed : [context];
  } catch {
    lines = context.split("\n");
  }
  const hitIndex = Math.floor(lines.length / 2);

  return (
    <pre className="text-[11px] font-mono bg-black/40 border border-white/5 rounded p-3 overflow-x-auto leading-5 my-3">
      {lines.map((line, i) => {
        const absLine = lineNumber - hitIndex + i;
        const isHit = i === hitIndex;
        return (
          <div
            key={i}
            className={`flex gap-2 ${
              isHit
                ? "bg-neon-red/8 border-l-2 border-neon-red/50 -mx-3 px-3"
                : ""
            }`}
          >
            <span className="select-none text-white/15 w-6 text-right shrink-0 tabular-nums">
              {absLine > 0 ? absLine : ""}
            </span>
            <span className={isHit ? "text-neon-red/80" : "text-white/45"}>
              {line || " "}
            </span>
          </div>
        );
      })}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Single finding card
// ---------------------------------------------------------------------------

function FindingCard({ f }: { f: FindingWithEval }) {
  const verdict = f.eval?.verdict;
  const borderColor =
    verdict === "TRUE_POSITIVE"
      ? "border-neon-red/30"
      : verdict === "NEEDS_HUMAN_REVIEW"
        ? "border-neon-amber/25"
        : verdict === "FALSE_POSITIVE"
          ? "border-white/5"
          : "border-white/8";

  return (
    <div
      className={`border rounded-lg p-4 bg-dark-bg/60 backdrop-blur-sm ${borderColor}`}
    >
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-neon-red/60 text-[11px] font-mono break-all">
              {f.file_path}
              <span className="text-white/25">:{f.line_number}</span>
            </span>
            {f.file_url && (
              <a
                href={f.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[9px] text-neon-red/25
                  hover:text-neon-red/55 transition-colors shrink-0"
              >
                <ExternalLink size={9} />
                GitHub
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <code
              className="text-[11px] font-mono text-neon-amber/70
              bg-neon-amber/5 border border-neon-amber/15 px-2 py-0.5 rounded"
            >
              {f.matched_text}
            </code>
            <SeverityBadge sev={f.severity} />
          </div>
        </div>
        <div className="shrink-0 pt-0.5">
          <VerdictBadge
            verdict={f.eval?.verdict}
            confidence={f.eval?.confidence}
          />
        </div>
      </div>

      <div className="flex gap-3 mb-2 flex-wrap">
        <span className="text-[9px] text-white/20 font-mono">
          template: <span className="text-white/35">{f.template_id}</span>
        </span>
        <span className="text-[9px] text-white/20 font-mono">
          pattern: <span className="text-white/35">{f.pattern_id}</span>
        </span>
        {f.eval?.validation_method && (
          <span className="text-[9px] text-white/20 font-mono">
            method:{" "}
            <span className="text-white/35">{f.eval.validation_method}</span>
          </span>
        )}
      </div>

      {f.context && (
        <CodeSnippet context={f.context} lineNumber={f.line_number} />
      )}

      {f.eval?.reasoning && (
        <div className="border-t border-white/5 pt-3 mt-1">
          <div className="text-[9px] text-neon-red/25 uppercase tracking-widest mb-1 font-mono">
            // ai reasoning
          </div>
          <p className="text-[11px] text-white/45 font-mono leading-relaxed">
            {f.eval.reasoning}
          </p>
        </div>
      )}

      {f.eval?.analyst_reviewed === 1 &&
        f.eval.analyst_verdict &&
        f.eval.analyst_verdict !== f.eval.ai_verdict && (
          <div className="mt-2 flex items-center gap-1.5 border-t border-white/5 pt-2">
            <span className="text-[9px] text-neon-red/30 font-mono">
              analyst override:
            </span>
            <span className="text-[9px] text-neon-red font-mono font-bold">
              {f.eval.analyst_verdict}
            </span>
          </div>
        )}

      <div className="mt-2 text-[9px] text-white/15 font-mono">
        detected {new Date(f.detected_at).toLocaleString()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk summary header
// ---------------------------------------------------------------------------

function Stat({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}) {
  return (
    <div className="text-center">
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[9px] text-white/25 font-mono uppercase">
        {label}
      </div>
    </div>
  );
}

function RiskHeader({
  owner,
  name,
  url,
  findings,
}: {
  owner: string;
  name: string;
  url: string;
  findings: FindingWithEval[];
}) {
  const critCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  const tpCount = findings.filter(
    (f) => f.eval?.verdict === "TRUE_POSITIVE",
  ).length;
  const nhrCount = findings.filter(
    (f) => f.eval?.verdict === "NEEDS_HUMAN_REVIEW",
  ).length;
  return (
    <div className="border border-neon-red/10 rounded-lg p-5 bg-dark-bg/40 mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-neon-red/30 text-[10px] font-mono mb-0.5">
            {owner} /
          </div>
          <h1 className="text-xl font-bold text-white font-mono">{name}</h1>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-neon-red/25 text-[10px] font-mono
                hover:text-neon-red/55 mt-0.5 transition-colors"
            >
              <ExternalLink size={9} />
              {url}
            </a>
          )}
        </div>
        <div className="flex gap-4 flex-wrap">
          <Stat value={critCount} label="critical" color="text-neon-red" />
          <Stat value={highCount} label="high" color="text-neon-amber" />
          <Stat value={tpCount} label="confirmed" color="text-neon-red" />
          <Stat value={nhrCount} label="needs review" color="text-neon-amber" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section grouper
// ---------------------------------------------------------------------------

function Section({
  title,
  count,
  titleColor,
  findings,
  dim = false,
}: {
  title: string;
  count: number;
  titleColor: string;
  findings: FindingWithEval[];
  dim?: boolean;
}) {
  return (
    <section
      className={`mb-8 ${dim ? "opacity-35 hover:opacity-65 transition-opacity duration-300" : ""}`}
    >
      <div className="flex items-center justify-between mb-3">
        <h2
          className={`text-[10px] font-mono uppercase tracking-widest ${titleColor}`}
        >
          {title}
        </h2>
        <span className="text-[10px] text-white/20 font-mono">{count}</span>
      </div>
      <div className="flex flex-col gap-3">
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RepoDetailPage({ params }: PageProps) {
  const { id } = await params;
  let findings: FindingWithEval[] = [];
  try {
    const { env } = await getCloudflareContext();
    findings = await getFindingsForRepo(env.DB, id);
  } catch {
    /* dev fallback */
  }

  const repoOwner = findings[0]?.repo_owner ?? "";
  const repoName = findings[0]?.repo_name ?? id;
  const repoUrl = repoOwner
    ? `https://github.com/${repoOwner}/${repoName}`
    : "";

  const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity),
  );
  const truePositives = sorted.filter(
    (f) => f.eval?.verdict === "TRUE_POSITIVE",
  );
  const needsReview = sorted.filter(
    (f) => f.eval?.verdict === "NEEDS_HUMAN_REVIEW",
  );
  const pending = sorted.filter((f) => !f.eval);
  const falsePositives = sorted.filter(
    (f) => f.eval?.verdict === "FALSE_POSITIVE",
  );

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-neon-red/40 hover:text-neon-red/70
          text-xs font-mono mb-6 transition-colors"
      >
        <ArrowLeft size={11} />
        back to dashboard
      </Link>

      {findings.length === 0 ? (
        <div className="border border-neon-red/10 rounded-lg p-12 text-center">
          <div className="text-neon-red/20 text-sm font-mono mb-2">
            // no findings for this repository
          </div>
          <p className="text-white/20 text-xs font-mono">
            Either the scan has not run yet, or no secrets were detected.
          </p>
        </div>
      ) : (
        <>
          <RiskHeader
            owner={repoOwner}
            name={repoName}
            url={repoUrl}
            findings={findings}
          />
          {truePositives.length > 0 && (
            <Section
              title="// confirmed credentials"
              count={truePositives.length}
              titleColor="text-neon-red/60"
              findings={truePositives}
            />
          )}
          {needsReview.length > 0 && (
            <Section
              title="// needs analyst review"
              count={needsReview.length}
              titleColor="text-neon-amber/60"
              findings={needsReview}
            />
          )}
          {pending.length > 0 && (
            <Section
              title="// pending evaluation"
              count={pending.length}
              titleColor="text-white/20"
              findings={pending}
            />
          )}
          {falsePositives.length > 0 && (
            <Section
              title="// false positives"
              count={falsePositives.length}
              titleColor="text-white/15"
              findings={falsePositives}
              dim
            />
          )}
        </>
      )}
    </main>
  );
}
