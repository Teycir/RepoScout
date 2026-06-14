// src/lib/types.ts
// TypeScript port of secretscout-types/src/lib.rs
// Single source of truth for all domain types shared across scanner, validator, pipeline, and UI.

export { maskSecret } from './masking.js';

// ---------------------------------------------------------------------------
// Database interface (generic)
// ---------------------------------------------------------------------------

export interface Database {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): Promise<ExecResult>;
  batch<T>(statements: PreparedStatement[]): Promise<QueryResult<T>[]>;
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  run<T = unknown>(): Promise<QueryResult<T>>;
  all<T = unknown>(): Promise<QueryResult<T>>;
  get?<T = unknown>(): Promise<T | null>;
  first?<T = unknown>(colName?: string): Promise<T | null>;
}

export async function fetchFirstRow<T>(stmt: PreparedStatement): Promise<T | null> {
  if (stmt.first) {
    return await stmt.first<T>();
  }
  if (stmt.get) {
    return await stmt.get<T>();
  }
  throw new Error("PreparedStatement has no first() or get() method");
}

export interface QueryResult<T = unknown> {
  success: boolean;
  results: T[];
  meta?: {
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
  };
}

export interface ExecResult {
  count: number;
  duration: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

export interface AiService {
  run(model: string, inputs: any): Promise<any>;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export type ErrorCode = 
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'VALIDATION_FAILED'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'FILE_TOO_LARGE'
  | 'REPO_TOO_LARGE'
  | 'DECOMPRESS_ERROR'
  | 'SCAN_ERROR'
  | 'UNKNOWN';

export interface ScanError {
  code: ErrorCode;
  message: string;
  context?: any;
}

// ---------------------------------------------------------------------------
// Templates & Patterns
// ---------------------------------------------------------------------------

export type PatternKind = 'regex' | 'fancy-regex' | 'literal' | 'entropy';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Pattern {
  id:              string;
  pattern:         string;
  message:         string;
  kind:            PatternKind;
  caseInsensitive?: boolean;   // true → compile with /gmi instead of /gm
}

export interface Template {
  id:               string;
  name:             string;
  description:      string;
  severity:         Severity;
  tags:             string[];
  patterns:         Pattern[];
  entropyThreshold: number | null;   // for Entropy kind patterns
  requireAll:       boolean;         // composite mode: all patterns must match
  proximityBytes:   number;          // composite mode: max distance between matches
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

export interface CodeSnippet {
  before:          string;
  vulnerableLine:  string;
  after:           string;
  lineStart:       number;
}

export interface Match {
  templateId:      string;
  patternId:       string;
  filePath:        string;
  lineNumber:      number;
  column:          number;
  matchedText:     string;    // masked: ghp_xxxx...xxxx
  rawMatchedText:  string;    // unmasked — never sent to UI or logs
  context:         string;    // 3 lines above + match line + 3 below
  codeSnippet:     CodeSnippet | null;
  severity:        Severity;
  message:         string;
  entropyScore:    number | null;
  confidence:      number;    // 0.0–1.0, set by cascade
  validationStatus: string | null;
}

export interface SeverityBreakdown {
  critical: number;
  high:     number;
  medium:   number;
  low:      number;
  info:     number;
}

export interface ScanResult {
  repoUrl:    string;
  owner:      string;
  repoName:   string;
  matches:    Match[];
  scanTimeMs: number;
}

// ---------------------------------------------------------------------------
// Verdict & Validation
// ---------------------------------------------------------------------------

export type Verdict          = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'NEEDS_HUMAN_REVIEW';
export type ValidationStatus = 'ACTIVE' | 'REVOKED' | 'UNVERIFIABLE' | 'FALSE_POSITIVE';
export type ValidationMethod = 'api_test' | 'llm' | 'heuristic';

export interface ValidationResult {
  status:    ValidationStatus;
  message:   string;
  checkedAt: string;  // ISO-8601
}

// ---------------------------------------------------------------------------
// Severity helpers (mirrors Rust impl)
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high:     40,
  medium:   15,
  low:      5,
  info:     1,
};

const VERDICT_MULTIPLIER: Record<Verdict, number> = {
  TRUE_POSITIVE:      2.0,
  NEEDS_HUMAN_REVIEW: 1.0,
  FALSE_POSITIVE:     0.0,
};

export function severityWeight(s: Severity): number {
  return SEVERITY_WEIGHT[s];
}

export function verdictMultiplier(v: Verdict): number {
  return VERDICT_MULTIPLIER[v];
}

export function findingRiskScore(severity: Severity, verdict: Verdict): number {
  return severityWeight(severity) * verdictMultiplier(verdict);
}



export function severityBreakdown(matches: Match[]): SeverityBreakdown {
  const b: SeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const m of matches) b[m.severity]++;
  return b;
}

export function totalRiskScore(matches: Match[]): number {
  return matches.reduce((s, m) => s + severityWeight(m.severity), 0);
}

export function riskLevel(score: number): 'None' | 'Low' | 'Medium' | 'High' | 'Critical' {
  if (score === 0)    return 'None';
  if (score <= 5)     return 'Low';
  if (score <= 15)    return 'Medium';
  if (score <= 30)    return 'High';
  return 'Critical';
}

// ---------------------------------------------------------------------------
// Worker Env binding interface
// ---------------------------------------------------------------------------

export interface Env {
  DB:    Database;
  CACHE: CacheStore;
  AI:    AiService;
  SUMMARY_MODEL?:            string;
  SCAN_MAX_CONCURRENT_REPOS?: string;
}
