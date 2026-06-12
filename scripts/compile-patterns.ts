#!/usr/bin/env tsx
// scripts/compile-patterns.ts
// Walks secretscout/templates/**/*.yaml (excluding /others/) and emits
// src/scan-worker/patterns.json for the scan worker to import at runtime.
//
// Usage:
//   npx tsx scripts/compile-patterns.ts
//   npx tsx scripts/compile-patterns.ts --include-others   (include non-default templates)
//   npx tsx scripts/compile-patterns.ts --templates-dir /custom/path

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, extname, dirname } from 'path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types (mirrors secretscout-types/src/lib.rs)
// ---------------------------------------------------------------------------

type PatternKind = 'regex' | 'fancy-regex' | 'literal' | 'entropy';
type Severity    = 'info' | 'low' | 'medium' | 'high' | 'critical';

interface RawPattern {
  id:      string;
  pattern: string;
  message: string;
  kind?:   PatternKind;
}

interface RawTemplate {
  id:                 string;
  name:               string;
  description:        string;
  severity:           Severity;
  tags:               string[];
  patterns:           RawPattern[];
  entropy_threshold?: number;
  require_all?:       boolean;
  proximity_bytes?:   number;
}

interface CompiledPattern {
  id:              string;
  pattern:         string;
  message:         string;
  kind:            PatternKind;
  caseInsensitive: boolean;   // true → scanner uses /gmi instead of /gm
}

interface CompiledTemplate {
  id:               string;
  name:             string;
  description:      string;
  severity:         Severity;
  tags:             string[];
  patterns:         CompiledPattern[];
  entropyThreshold: number | null;
  requireAll:       boolean;
  proximityBytes:   number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INCLUDE_OTHERS = process.argv.includes('--include-others');
const TEMPLATES_DIR  = (() => {
  const idx = process.argv.indexOf('--templates-dir');
  return idx !== -1 && process.argv[idx + 1]
    ? process.argv[idx + 1]!
    : join(process.cwd(), '..', 'secretscout', 'templates');
})();
const OUT_FILE = join(process.cwd(), 'src', 'scan-worker', 'patterns.json');

const VALID_SEVERITIES = new Set<string>(['info', 'low', 'medium', 'high', 'critical']);
const VALID_KINDS      = new Set<string>(['regex', 'fancy-regex', 'literal', 'entropy']);

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function walkYamlFiles(dir: string, skipOthers: boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (skipOthers && entry.toLowerCase() === 'others') continue;
      files.push(...walkYamlFiles(full, skipOthers));
    } else if (stat.isFile() && (extname(entry) === '.yaml' || extname(entry) === '.yml')) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateTemplate(raw: unknown, filePath: string): RawTemplate | null {
  if (typeof raw !== 'object' || raw === null) {
    console.warn(`  ⚠ skip: not an object — ${filePath}`);
    return null;
  }
  const t = raw as Record<string, unknown>;

  if (typeof t['id'] !== 'string' || !t['id']) {
    console.warn(`  ⚠ skip: missing id — ${filePath}`);
    return null;
  }
  if (typeof t['severity'] !== 'string' || !VALID_SEVERITIES.has(t['severity'])) {
    console.warn(`  ⚠ skip: invalid severity "${t['severity']}" — ${filePath}`);
    return null;
  }
  if (!Array.isArray(t['patterns']) || t['patterns'].length === 0) {
    console.warn(`  ⚠ skip: no patterns — ${filePath}`);
    return null;
  }

  return raw as RawTemplate;
}

// ---------------------------------------------------------------------------
// Pattern normalisation — JS compatibility
// ---------------------------------------------------------------------------

/**
 * SecretScout uses `(?i)` as a leading flag in many Rust fancy-regex patterns.
 * JavaScript's RegExp does not support inline flags — `(?i)` is invalid.
 *
 * Strategy:
 *   1. Strip any leading `(?i)` or `(?im)` / `(?mi)` flag group.
 *   2. Track whether case-insensitive was requested.
 *   3. If `(?i)` appeared mid-pattern (not at position 0), that's unsalvageable
 *      with a simple strip — promote the kind to `fancy-regex` and note it so
 *      our scanner can add the `i` flag at compile time for those entries.
 *   4. Store a `caseInsensitive` boolean on the compiled pattern so the scanner
 *      knows to compile with `/gmi` instead of `/gm`.
 *
 * This mirrors what Rust's `fancy_regex::RegexBuilder::case_insensitive(true)` does.
 */
const LEADING_FLAGS_RE = /^\(\?([a-z]+)\)/;

function normalisePattern(raw: string, kind: PatternKind): {
  pattern: string;
  kind: PatternKind;
  caseInsensitive: boolean;
} {
  const leadingMatch = raw.match(LEADING_FLAGS_RE);
  if (leadingMatch) {
    const flags = leadingMatch[1]!;
    const caseInsensitive = flags.includes('i');
    const stripped = raw.slice(leadingMatch[0].length);
    return { pattern: stripped, kind, caseInsensitive };
  }

  // Check for mid-pattern (?i) — invalid in JS even with `i` flag
  if (raw.includes('(?i)')) {
    // Best effort: strip (?i) wherever it appears and enable i flag
    const stripped = raw.replaceAll('(?i)', '');
    return { pattern: stripped, kind: 'fancy-regex', caseInsensitive: true };
  }

  return { pattern: raw, kind, caseInsensitive: false };
}

function compileTemplate(raw: RawTemplate): CompiledTemplate {
  const patterns: CompiledPattern[] = raw.patterns
    .filter((p) => {
      if (typeof p.id !== 'string' || !p.id)            { console.warn(`    ⚠ pattern missing id in ${raw.id}`); return false; }
      if (typeof p.pattern !== 'string' || !p.pattern)  { console.warn(`    ⚠ empty pattern in ${raw.id}:${p.id}`); return false; }
      return true;
    })
    .map((p) => {
      const rawKind: PatternKind = VALID_KINDS.has(p.kind ?? '') ? (p.kind as PatternKind) : 'regex';
      const { pattern, kind, caseInsensitive } = normalisePattern(p.pattern, rawKind);
      return {
        id:              p.id,
        pattern,
        message:         p.message ?? '',
        kind,
        caseInsensitive,
      };
    });

  return {
    id:               raw.id,
    name:             raw.name ?? raw.id,
    description:      raw.description ?? '',
    severity:         raw.severity,
    tags:             Array.isArray(raw.tags) ? raw.tags : [],
    patterns,
    entropyThreshold: raw.entropy_threshold ?? null,
    requireAll:       raw.require_all ?? false,
    proximityBytes:   raw.proximity_bytes ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log(`\n🔍 Compiling SecretScout patterns`);
  console.log(`   Templates dir : ${TEMPLATES_DIR}`);
  console.log(`   Include others: ${INCLUDE_OTHERS}`);
  console.log(`   Output        : ${OUT_FILE}\n`);

  const yamlFiles = walkYamlFiles(TEMPLATES_DIR, !INCLUDE_OTHERS);
  console.log(`Found ${yamlFiles.length} YAML files\n`);

  const compiled: CompiledTemplate[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;

  for (const filePath of yamlFiles) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.warn(`  ⚠ parse error — ${filePath}: ${e}`);
      skipped++;
      continue;
    }

    const validated = validateTemplate(raw, filePath);
    if (!validated) { skipped++; continue; }

    if (seenIds.has(validated.id)) {
      console.warn(`  ⚠ duplicate id "${validated.id}" — skipping ${filePath}`);
      skipped++;
      continue;
    }

    seenIds.add(validated.id);
    compiled.push(compileTemplate(validated));
  }

  // Sort by severity weight descending so critical templates run first
  const SEVERITY_ORDER: Record<string, number> = {
    critical: 5, high: 4, medium: 3, low: 2, info: 1,
  };
  compiled.sort(
    (a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0)
  );

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(compiled, null, 2));

  const totalPatterns = compiled.reduce((s, t) => s + t.patterns.length, 0);
  console.log(`\n✅ Compiled ${compiled.length} templates / ${totalPatterns} patterns`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Output : ${OUT_FILE}\n`);

  // Breakdown by severity
  const bySeverity: Record<string, number> = {};
  for (const t of compiled) {
    bySeverity[t.severity] = (bySeverity[t.severity] ?? 0) + 1;
  }
  for (const [sev, count] of Object.entries(bySeverity).sort((a, b) => (SEVERITY_ORDER[b[0]] ?? 0) - (SEVERITY_ORDER[a[0]] ?? 0))) {
    console.log(`   ${sev.padEnd(10)}: ${count}`);
  }
}

main();
