#!/usr/bin/env node
/**
 * repo-cli.ts
 * CLI tool for AI assistants (Claude, ChatGPT, etc.) to query RepoScout findings
 *
 * Usage:
 *   repo-cli repos [limit]
 *   repo-cli findings <repoId> [limit]
 *   repo-cli queue [limit]
 *   repo-cli runs [limit]
 *   repo-cli stats
 */

const API_BASE = process.env.REPOSCOUT_API_BASE || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetch_api(endpoint: string) {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: string };
      if (body.error) detail = ` — ${body.error}`;
    } catch { /* non-JSON error body */ }
    throw new Error(`HTTP ${res.status}: ${res.statusText}${detail}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function format_repo(r: any, i: number) {
  const lines = [
    `[${i + 1}] ${r.owner}/${r.name}`,
    `    ID: ${r.id}`,
    `    Risk score: ${r.risk_score}`,
    `    Critical: ${r.critical_severity_findings}  High: ${r.high_severity_findings}`,
    `    Status: ${r.last_scan_status}`,
    `    Last scan: ${r.last_scan_at ?? 'never'}`,
    `    URL: ${r.url}`,
  ];
  return lines.join('\n');
}

function format_finding(f: any, i: number) {
  const lines = [
    `[${i + 1}] ${f.file_path}:${f.line_number}`,
    `    Repo: ${f.repo_owner}/${f.repo_name} (${f.repo_id})`,
    `    Matched: ${f.matched_text}`,
    `    Severity: ${f.severity}`,
    `    Template: ${f.template_id} / Pattern: ${f.pattern_id}`,
  ];
  if (f.eval) {
    lines.push(`    Verdict: ${f.eval.verdict} (${(f.eval.confidence * 100).toFixed(0)}% confidence, via ${f.eval.validation_method})`);
    if (f.eval.reasoning) lines.push(`    Reasoning: ${f.eval.reasoning}`);
    if (f.eval.analyst_reviewed) lines.push(`    Analyst override: ${f.eval.analyst_verdict}`);
  } else {
    lines.push(`    Verdict: — pending —`);
  }
  if (f.file_url) lines.push(`    URL: ${f.file_url}`);
  lines.push(`    Detected: ${f.detected_at}`);
  return lines.join('\n');
}

function format_scan_run(r: any, i: number) {
  const lines = [
    `[${i + 1}] ${r.id}`,
    `    Status: ${r.status}`,
    `    Started: ${r.started_at}`,
    `    Completed: ${r.completed_at ?? '—'}`,
    `    Repos scanned: ${r.total_repos_scanned}`,
    `    Findings: ${r.total_findings} (TP: ${r.true_positives}, needs review: ${r.needs_human_review}, FP: ${r.false_positives})`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmd_repos(limit = 50) {
  const data = await fetch_api(`/api/repos?limit=${limit}`);
  const repos = data.repos ?? [];
  console.log(`Repositories (${repos.length}):\n`);
  repos.forEach((r: any, i: number) => {
    console.log(`${format_repo(r, i)}\n`);
  });
}

async function cmd_findings(repoId: string, limit = 100) {
  const data = await fetch_api(`/api/repos/${encodeURIComponent(repoId)}/findings?limit=${limit}`);
  const findings = data.findings ?? [];
  console.log(`Findings for repo ${repoId} (${findings.length}):\n`);
  findings.forEach((f: any, i: number) => {
    console.log(`${format_finding(f, i)}\n`);
  });
}

async function cmd_queue(limit = 100) {
  const data = await fetch_api(`/api/review-queue?limit=${limit}`);
  const queue = data.queue ?? [];
  console.log(`Analyst review queue (${queue.length}):\n`);
  queue.forEach((f: any, i: number) => {
    console.log(`${format_finding(f, i)}\n`);
  });
}

async function cmd_runs(limit = 10) {
  const data = await fetch_api(`/api/scan-runs?limit=${limit}`);
  const runs = data.runs ?? [];
  console.log(`Recent scan runs (${runs.length}):\n`);
  runs.forEach((r: any, i: number) => {
    console.log(`${format_scan_run(r, i)}\n`);
  });
}

async function cmd_stats() {
  const data = await fetch_api('/api/stats');
  console.log('RepoScout dashboard stats:\n');
  console.log(`  Total repos: ${data.totalRepos}`);
  console.log(`  Critical findings (TP, high/critical): ${data.criticalFindings}`);
  console.log(`  Analyst queue: ${data.analystQueueCount}`);
  console.log(`  Last scan: ${data.lastScanAt ?? 'never'}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    switch (cmd) {
      case 'repos':
        await cmd_repos(parseInt(args[1]) || 50);
        break;
      case 'findings':
        if (!args[1]) throw new Error('repo-cli findings <repoId> [limit]');
        await cmd_findings(args[1], parseInt(args[2]) || 100);
        break;
      case 'queue':
        await cmd_queue(parseInt(args[1]) || 100);
        break;
      case 'runs':
        await cmd_runs(parseInt(args[1]) || 10);
        break;
      case 'stats':
        await cmd_stats();
        break;
      default:
        console.log(`RepoScout CLI - AI Assistant Tool

Usage:
  repo-cli repos [limit]              List monitored repos by risk score (default 50)
  repo-cli findings <repoId> [limit]  Findings + AI verdicts for a repo (default 100)
  repo-cli queue [limit]              Analyst review queue (default 100)
  repo-cli runs [limit]               Recent scan run history (default 10)
  repo-cli stats                      Dashboard summary counters

Examples:
  repo-cli repos 20
  repo-cli findings 3f9c1e2a-... 50
  repo-cli queue
  repo-cli runs 5
  repo-cli stats

Environment:
  REPOSCOUT_API_BASE   API endpoint (default: http://localhost:3000)
`);
    }
  } catch (err: any) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
