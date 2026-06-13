# RepoScout CLI

CLI tool designed for AI assistants (Claude, ChatGPT, etc.) to query RepoScout's secret-scanning findings, run local secret scanning, execute the LangGraph evaluation pipeline using Ollama, and query the local SQLite database.

## Installation

```bash
# Local development
cd cli
npm run build
npm link
```

## Usage

The CLI supports two modes of operation:
1. **API Mode** (Default) — Queries the live HTTP API of a deployed RepoScout instance.
2. **Local Mode** (`--local` / `-l`) — Queries a local SQLite database directly without hitting the HTTP API.

### Remote & Local Query Commands

```bash
# List monitored repos by risk score
repo-cli repos 20 [--local] [--db <path>]

# Findings + AI verdicts for a specific repo (accepts slug or UUID)
repo-cli findings owner/repo 50 [--local] [--db <path>]

# Analyst review queue (NEEDS_HUMAN_REVIEW, untriaged)
repo-cli queue [--local] [--db <path>]

# Recent scan run history
repo-cli runs 5 [--local] [--db <path>]

# Dashboard summary counters
repo-cli stats [--local] [--db <path>]
```

### Local Scan & Workflow Commands

These commands execute the secret crawler and scanning workflow locally against an SQLite database using local CPU/GPU intelligence (via Ollama).

```bash
# Scan a specific repository locally
# depth: last N edits (commits) to scan (default: 5)
repo-cli scan owner/repo [depth] [--db <path>] [--max-findings <n>]

# Run the complete discovery crawler + scan + pipeline workflow locally
# lookbackHours: hours to look back for pushes (default: 24)
repo-cli workflow [lookbackHours] [--db <path>] [--max-repos <n>] [--max-findings <n>]
```

## Setup & Environment

To run local scans or the workflow command, ensure you have:

1. **GitHub PAT Rotation Pool**:
   Place up to 10 GitHub Personal Access Tokens in your `.env` file at the root of the project:
   ```bash
   GITHUB_TOKEN_1=ghp_...
   GITHUB_TOKEN_2=ghp_...
   ```
   The CLI automatically cycles through these tokens using round-robin rotation on every crawler run, commit fetch, and repository scan to bypass rate limits.

2. **Local AI Engine (Ollama)**:
   Ensure Ollama is running at `http://localhost:11434` with the `gemma4:latest` model pre-loaded:
   ```bash
   ollama run gemma4:latest
   ```

3. **Custom Database Location**:
   By default, local commands read and write to `reposcout-local.sqlite` at the project root. You can customize this by passing `--db <path>`.

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

## API Endpoints Used (Remote Mode)

- `GET /api/repos?limit=<n>` — Repository risk grid
- `GET /api/repos/<id>/findings?limit=<n>` — Findings for a repo
- `GET /api/review-queue?limit=<n>` — Triage queue
- `GET /api/scan-runs?limit=<n>` — Scan run history
- `GET /api/stats` — Dashboard summary

All read endpoints are rate-limited to 60 requests/minute per IP (no auth — see `lib/rateLimit.ts`).

## License

This project is licensed under the MIT License.
