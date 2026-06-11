-- schema.sql
-- RepoScout Cloudflare D1 Database Schema

-- Repositories monitored by the scanner
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  risk_score REAL DEFAULT 0.0,
  high_severity_findings INTEGER DEFAULT 0,
  critical_severity_findings INTEGER DEFAULT 0,
  last_scan_at TEXT,
  last_scan_status TEXT DEFAULT 'PENDING',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Scan execution logs
CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  total_repos_scanned INTEGER DEFAULT 0,
  total_findings INTEGER DEFAULT 0,
  status TEXT NOT NULL -- 'RUNNING', 'COMPLETED', 'FAILED'
);

-- Secret scanner findings
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  scan_run_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_url TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  matched_text TEXT NOT NULL, -- Masked for display: e.g. ghp_xxxx...xxxx
  line_content TEXT NOT NULL, -- The matching line of code
  context TEXT NOT NULL, -- Surrounding 5 lines above/below for UI rendering and AI check
  pattern_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  severity TEXT NOT NULL, -- 'info', 'low', 'medium', 'high', 'critical'
  detected_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

-- AI analysis and external check validation outcomes
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL, -- 'TRUE_POSITIVE', 'FALSE_POSITIVE', 'SUSPICIOUS'
  confidence REAL NOT NULL, -- 0.0 to 1.0
  validation_method TEXT NOT NULL, -- 'active_api_test', 'llm_heuristics', 'pattern'
  validation_status TEXT NOT NULL, -- 'ACTIVE', 'REVOKED', 'UNVERIFIABLE', 'FALSE_POSITIVE'
  reasoning TEXT NOT NULL,
  external_response TEXT, -- Masked API response (status, headers, or safe body snippets)
  evaluated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

-- Github PAT rotation pool
CREATE TABLE IF NOT EXISTS scan_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  masked_token TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  rate_limit_remaining INTEGER DEFAULT 5000,
  rate_limit_reset TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes to optimize queries on repository risk lists and latest scans
CREATE INDEX IF NOT EXISTS idx_repositories_risk ON repositories(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_findings_repo ON findings(repo_id);
CREATE INDEX IF NOT EXISTS idx_findings_scan_run ON findings(scan_run_id);
CREATE INDEX IF NOT EXISTS idx_ai_evaluations_classification ON ai_evaluations(classification);
