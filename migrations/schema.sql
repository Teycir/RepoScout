-- migrations/schema.sql
-- RepoScout D1 schema — aligned with SPECIFICATION.md

-- Monitored repositories
CREATE TABLE IF NOT EXISTS repositories (
  id                         TEXT PRIMARY KEY,
  owner                      TEXT NOT NULL,
  name                       TEXT NOT NULL,
  url                        TEXT NOT NULL,
  risk_score                 REAL    DEFAULT 0.0,
  high_severity_findings     INTEGER DEFAULT 0,
  critical_severity_findings INTEGER DEFAULT 0,
  last_scan_at               TEXT,
  last_scan_status           TEXT    DEFAULT 'PENDING',
  created_at                 TEXT    DEFAULT (datetime('now')),
  updated_at                 TEXT    DEFAULT (datetime('now'))
);

-- Scan execution log
CREATE TABLE IF NOT EXISTS scan_runs (
  id                   TEXT PRIMARY KEY,
  started_at           TEXT NOT NULL,
  completed_at         TEXT,
  total_repos_scanned  INTEGER DEFAULT 0,
  total_findings       INTEGER DEFAULT 0,
  true_positives       INTEGER DEFAULT 0,
  needs_human_review   INTEGER DEFAULT 0,
  false_positives      INTEGER DEFAULT 0,
  status               TEXT NOT NULL  -- 'RUNNING' | 'COMPLETED' | 'FAILED'
);

-- Individual secret findings
CREATE TABLE IF NOT EXISTS findings (
  id           TEXT PRIMARY KEY,
  scan_run_id  TEXT NOT NULL,
  repo_id      TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  file_url     TEXT NOT NULL,
  line_number  INTEGER NOT NULL,
  matched_text TEXT NOT NULL,  -- masked: ghp_xxxx...xxxx
  line_content TEXT NOT NULL,
  context      TEXT NOT NULL,  -- 5 lines above/below as JSON array
  pattern_id   TEXT NOT NULL,
  template_id  TEXT NOT NULL,
  severity     TEXT NOT NULL,  -- 'info'|'low'|'medium'|'high'|'critical'
  detected_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(repo_id)     REFERENCES repositories(id) ON DELETE CASCADE
);

-- AI evaluation results
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id                TEXT PRIMARY KEY,
  finding_id        TEXT NOT NULL UNIQUE,
  verdict           TEXT NOT NULL,  -- 'TRUE_POSITIVE'|'FALSE_POSITIVE'|'NEEDS_HUMAN_REVIEW'
  confidence        REAL NOT NULL,
  validation_method TEXT NOT NULL,  -- 'api_test'|'llm'|'heuristic'
  validation_status TEXT NOT NULL,  -- 'ACTIVE'|'REVOKED'|'UNVERIFIABLE'|'FALSE_POSITIVE'
  reasoning         TEXT NOT NULL,
  external_response TEXT,           -- masked API response snippet
  evaluated_at      TEXT DEFAULT (datetime('now')),
  analyst_reviewed  INTEGER DEFAULT 0,  -- 1 once a human triaged it
  analyst_verdict   TEXT,               -- human override if different from AI
  FOREIGN KEY(finding_id) REFERENCES findings(id) ON DELETE CASCADE
);

-- GitHub PAT rotation pool (up to 10 tokens)
CREATE TABLE IF NOT EXISTS scan_tokens (
  id                   TEXT PRIMARY KEY,
  token_hash           TEXT NOT NULL UNIQUE,  -- SHA-256 of raw PAT
  masked_token         TEXT NOT NULL,          -- e.g. ghp_xxxx...1234
  is_active            INTEGER DEFAULT 1,
  rate_limit_remaining INTEGER DEFAULT 5000,
  rate_limit_reset     TEXT,                   -- ISO-8601 datetime
  last_used_at         TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_repositories_risk      ON repositories(risk_score DESC);

-- Dedup guard: the same secret (same repo/file/line/pattern/masked text) must
-- not accumulate duplicate rows across repeated scans. crypto.randomUUID()
-- ids never collide on their own, so INSERT OR IGNORE relies on this index
-- to actually ignore re-detections of a persisting secret.
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedup   ON findings(repo_id, file_path, line_number, pattern_id, matched_text);

CREATE INDEX IF NOT EXISTS idx_findings_repo           ON findings(repo_id);
CREATE INDEX IF NOT EXISTS idx_findings_scan_run       ON findings(scan_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity       ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_evaluations_verdict     ON ai_evaluations(verdict);
CREATE INDEX IF NOT EXISTS idx_evaluations_reviewed    ON ai_evaluations(analyst_reviewed);
CREATE INDEX IF NOT EXISTS idx_tokens_active           ON scan_tokens(is_active, rate_limit_remaining DESC);
