-- migrations/003_resolved_findings.sql
-- Track when findings are resolved (no longer detected on re-scan)

ALTER TABLE findings ADD COLUMN resolved_at TEXT;

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_findings_resolved ON findings(resolved_at);

-- Index for active (unresolved) findings queries
CREATE INDEX IF NOT EXISTS idx_findings_unresolved ON findings(resolved_at) WHERE resolved_at IS NULL;
