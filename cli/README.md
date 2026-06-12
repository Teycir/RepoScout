# RepoScout CLI

CLI tool designed for AI assistants (Claude, ChatGPT, etc.) to query RepoScout's secret-scanning findings, analyst review queue, and scan history.

## Installation

```bash
# Local development
cd cli
npm run build
chmod +x repo-cli.js
npm link
```

## Usage

```bash
# List monitored repos by risk score
repo-cli repos 20

# Findings + AI verdicts for a specific repo
repo-cli findings 3f9c1e2a-... 50

# Analyst review queue (NEEDS_HUMAN_REVIEW, untriaged)
repo-cli queue

# Recent scan run history
repo-cli runs 5

# Dashboard summary counters
repo-cli stats
```

## For AI Assistants

This CLI provides structured, read-only access to:
- **Repos**: Monitored repositories ranked by risk score, with critical/high finding counts and last scan status
- **Findings**: Per-repo secret findings with masked matched text, severity, AI verdict (TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_HUMAN_REVIEW), confidence, and reasoning
- **Queue**: Findings awaiting human analyst triage
- **Runs**: Scan execution history with totals broken down by verdict
- **Stats**: Dashboard-level summary (total repos, critical findings, queue size, last scan time)

All matched secrets are returned pre-masked (e.g. `ghp_xxxx...1234`) — `rawMatchedText` is never exposed via the API.

## Environment Variables

```bash
# Override API endpoint (default: http://localhost:3000)
export REPOSCOUT_API_BASE=https://your-deployment.workers.dev
```

## Output Format

Clean, parseable text output optimized for AI consumption:
```
[1] owner/repo-name
    ID: 3f9c1e2a-...
    Risk score: 140
    Critical: 1  High: 2
    Status: COMPLETED
    Last scan: 2026-06-12T10:00:00Z
    URL: https://github.com/owner/repo-name
```

```
[1] src/config.ts:42
    Repo: owner/repo-name (3f9c1e2a-...)
    Matched: ghp_xxxx...1234
    Severity: critical
    Template: github-pat / Pattern: github-pat-classic
    Verdict: TRUE_POSITIVE (100% confidence, via api_test)
    Reasoning: GitHub PAT verified via /user
    URL: https://github.com/owner/repo-name/blob/HEAD/src/config.ts#L42
    Detected: 2026-06-12T09:45:00Z
```

## API Endpoints Used

- `GET /api/repos?limit=<n>` — Repository risk grid
- `GET /api/repos/<id>/findings?limit=<n>` — Findings for a repo
- `GET /api/review-queue?limit=<n>` — Analyst triage queue
- `GET /api/scan-runs?limit=<n>` — Recent scan runs
- `GET /api/stats` — Dashboard summary

All read endpoints are rate-limited to 60 requests/minute per IP (no auth — see `lib/rateLimit.ts`).
