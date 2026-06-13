-- migrations/002_crawler.sql
-- Adds crawler tracking columns to repositories and a dedicated crawler_runs log.

-- Track where each repo came from and when the crawler last saw it
ALTER TABLE repositories ADD COLUMN source       TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE repositories ADD COLUMN crawled_at   TEXT;          -- last time crawler touched this row
ALTER TABLE repositories ADD COLUMN pushed_at    TEXT;          -- GitHub's pushed_at for change-detection

-- Index: crawler needs repos ordered by pushed_at to skip already-seen ones
CREATE INDEX IF NOT EXISTS idx_repositories_source    ON repositories(source);
CREATE INDEX IF NOT EXISTS idx_repositories_pushed    ON repositories(pushed_at DESC);

-- Crawler run log — one row per discovery pass
CREATE TABLE IF NOT EXISTS crawler_runs (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  repos_discovered INTEGER DEFAULT 0,   -- net-new repos inserted
  repos_updated    INTEGER DEFAULT 0,   -- existing repos whose pushed_at changed
  since_cursor     TEXT,                -- ISO-8601 timestamp used as ?since= for this run
  next_cursor      TEXT,                -- ISO-8601 to use next run
  status           TEXT NOT NULL        -- 'RUNNING' | 'COMPLETED' | 'FAILED'
);
