// src/lib/scanner.ts
// Port of secretscout-core/src/scanner.rs
// Scans source text against compiled templates, returns masked Match objects.

import type { Template, Pattern, Match, Severity } from './types.js';
import { maskSecret } from './masking.js';
import {
  calculateEntropy,
  getThreshold,
  isHighEntropy,
  findHighEntropyStrings,
} from './entropy.js';

// ---------------------------------------------------------------------------
// Constants — mirrors scanner.rs limits
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE        = 10 * 1024 * 1024; // 10 MB
const MAX_MATCHES_PER_FILE = 500;
const MAX_MATCH_LENGTH     = 500;
const MAX_LINE_LENGTH      = 1_000;            // skip lines longer than this
const CONTEXT_LINES        = 5;               // lines above + below match

// Paths to skip entirely
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.wasm',
  '.woff', '.woff2', '.ttf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.lock', '.map',
]);

const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', '.next', '.open-next', 'target',
  '__pycache__', '.git', '.github',
]);

// Inline suppression markers (case-insensitive)
const SUPPRESS_CURRENT = ['secretscout:ignore', 'secretscout:ignore-line', 'gitleaks:allow', 'nosec'];
const SUPPRESS_NEXT    = 'secretscout:ignore-next';

// SSH / PEM public key patterns — suppress to avoid false positives
const SSH_PUB_RE  = /^\s*(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/]+=*/m;
const PEM_PUB_RE  = /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PUBLIC KEY-----/;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = filePath.slice(lastDot).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

function findSuppressedLines(lines: string[]): Set<number> {
  const suppressed = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const lower = (lines[i] ?? '').toLowerCase();
    const lineNum = i + 1; // 1-indexed
    if (lower.includes(SUPPRESS_NEXT)) {
      suppressed.add(lineNum + 1);
    } else if (SUPPRESS_CURRENT.some((p) => lower.includes(p))) {
      suppressed.add(lineNum);
    }
  }
  return suppressed;
}

function isSshPublicKeyMatch(rawText: string, context: string): boolean {
  if (SSH_PUB_RE.test(rawText) || SSH_PUB_RE.test(context)) return true;
  if (PEM_PUB_RE.test(context)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

function getContext(lines: string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - CONTEXT_LINES);
  const end   = Math.min(lines.length, lineIndex + CONTEXT_LINES + 1);
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// Match builder
// ---------------------------------------------------------------------------

function buildMatch(
  templateId: string,
  patternId:  string,
  severity:   Severity,
  message:    string,
  rawText:    string,
  lines:      string[],
  lineIndex:  number,   // 0-based
  colOffset:  number,
  isEntropy:  boolean,
): Match {
  return {
    templateId,
    patternId,
    filePath:        '',   // filled in by scan()
    lineNumber:      lineIndex + 1,
    column:          colOffset,
    matchedText:     maskSecret(rawText),
    rawMatchedText:  rawText,
    context:         getContext(lines, lineIndex),
    codeSnippet:     null,
    severity,
    message,
    entropyScore:    isEntropy ? calculateEntropy(rawText) : null,
    confidence:      0,    // set by cascade
    validationStatus: null,
  };
}

// ---------------------------------------------------------------------------
// Placeholder / false-positive suppression (mirrors cascade.rs heuristics)
// ---------------------------------------------------------------------------

const PLACEHOLDER_TERMS = [
  'placeholder', 'example', 'your_key', 'your_token', 'my_key',
  'xxxx', 'test_key', 'dummy', 'sample', 'replace_me', 'insert_key',
  'your-', 'fake', 'mock', 'demo',
];

export function isLikelyPlaceholder(text: string): boolean {
  const lower = text.toLowerCase();
  if (PLACEHOLDER_TERMS.some((t) => lower.includes(t))) return true;
  // Low-entropy hex (repeating nibbles)
  if (/^[a-f0-9]{32,}$/i.test(text) && new Set(lower).size <= 5) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface ScanOptions {
  filePath?: string;
  maxMatches?: number;
}

export function scanSource(
  source: string,
  templates: Template[],
  options: ScanOptions = {},
): Match[] {
  const filePath   = options.filePath ?? '';
  const maxMatches = options.maxMatches ?? MAX_MATCHES_PER_FILE;

  if (source.length > MAX_FILE_SIZE) return [];

  const lines       = source.split('\n');
  const suppressed  = findSuppressedLines(lines);
  const allMatches: Match[] = [];
  const seen        = new Set<string>(); // dedup key: lineNum:col:patternId

  for (const template of templates) {
    if (allMatches.length >= maxMatches) break;

    const templateMatches: Match[] = [];

    if (template.requireAll && template.patterns.length > 1) {
      // Composite mode: all patterns must match within proximityBytes of each other
      templateMatches.push(...scanComposite(source, lines, template));
    } else {
      for (const pattern of template.patterns) {
        if (allMatches.length + templateMatches.length >= maxMatches) break;
        const hits = scanPattern(source, lines, template, pattern);
        templateMatches.push(...hits);
      }
    }

    for (const m of templateMatches) {
      if (suppressed.has(m.lineNumber)) continue;
      if (isSshPublicKeyMatch(m.rawMatchedText, m.context)) continue;
      if (isLikelyPlaceholder(m.rawMatchedText)) continue;

      const key = `${m.lineNumber}:${m.column}:${m.patternId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      allMatches.push({ ...m, filePath });
      if (allMatches.length >= maxMatches) break;
    }
  }

  // Sort by line number
  allMatches.sort((a, b) => a.lineNumber - b.lineNumber);
  return allMatches;
}

// ---------------------------------------------------------------------------
// Pattern-level scan
// ---------------------------------------------------------------------------

function scanPattern(
  source:   string,
  lines:    string[],
  template: Template,
  pattern:  Pattern,
): Match[] {
  const matches: Match[] = [];

  switch (pattern.kind) {
    case 'regex':
    case 'fancy-regex': {
      let re: RegExp;
      try {
        // Use /gmi when the template marks caseInsensitive (stripped from (?i) prefix by compile-patterns)
        const flags = pattern.caseInsensitive ? 'gmi' : 'gm';
        re = new RegExp(pattern.pattern, flags);
      } catch {
        return [];
      }
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        if (matches.length >= MAX_MATCHES_PER_FILE) break;
        const rawText = m[0];
        if (rawText.length > MAX_MATCH_LENGTH) continue;
        const lineIndex = source.slice(0, m.index).split('\n').length - 1;
        const lineStart = source.lastIndexOf('\n', m.index) + 1;
        const col       = m.index - lineStart;
        if ((lines[lineIndex]?.length ?? 0) > MAX_LINE_LENGTH) continue;
        matches.push(buildMatch(
          template.id, pattern.id, template.severity,
          pattern.message, rawText, lines, lineIndex, col, false,
        ));
        // Prevent infinite loops on zero-length matches
        if (m[0].length === 0) re.lastIndex++;
      }
      break;
    }

    case 'literal': {
      let idx = 0;
      while (idx < source.length) {
        if (matches.length >= MAX_MATCHES_PER_FILE) break;
        const pos = source.indexOf(pattern.pattern, idx);
        if (pos === -1) break;
        const rawText = pattern.pattern;
        if (rawText.length > MAX_MATCH_LENGTH) { idx = pos + 1; continue; }
        const lineIndex = source.slice(0, pos).split('\n').length - 1;
        const lineStart = source.lastIndexOf('\n', pos) + 1;
        if ((lines[lineIndex]?.length ?? 0) > MAX_LINE_LENGTH) { idx = pos + 1; continue; }
        matches.push(buildMatch(
          template.id, pattern.id, template.severity,
          pattern.message, rawText, lines, lineIndex, pos - lineStart, false,
        ));
        idx = pos + rawText.length;
      }
      break;
    }

    case 'entropy': {
      const threshold = template.entropyThreshold ?? 4.5;
      const hits = findHighEntropyStrings(source, threshold, MAX_MATCHES_PER_FILE);
      for (const hit of hits) {
        if (matches.length >= MAX_MATCHES_PER_FILE) break;
        if (hit.text.length > MAX_MATCH_LENGTH) continue;
        const lineIndex = source.slice(0, hit.start).split('\n').length - 1;
        const lineStart = source.lastIndexOf('\n', hit.start) + 1;
        if ((lines[lineIndex]?.length ?? 0) > MAX_LINE_LENGTH) continue;
        matches.push(buildMatch(
          template.id, pattern.id, template.severity,
          pattern.message, hit.text, lines, lineIndex, hit.start - lineStart, true,
        ));
      }
      break;
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Composite mode (require_all + proximity_bytes)
// ---------------------------------------------------------------------------

function scanComposite(
  source:   string,
  lines:    string[],
  template: Template,
): Match[] {
  // Collect match positions for each pattern
  const perPattern: Array<Array<{ start: number; end: number; rawText: string }>> = [];

  for (const pattern of template.patterns) {
    const positions: Array<{ start: number; end: number; rawText: string }> = [];

    if (pattern.kind === 'literal') {
      let idx = 0;
      while (idx < source.length) {
        const pos = source.indexOf(pattern.pattern, idx);
        if (pos === -1) break;
        positions.push({ start: pos, end: pos + pattern.pattern.length, rawText: pattern.pattern });
        idx = pos + pattern.pattern.length;
      }
    } else {
      let re: RegExp;
      try { re = new RegExp(pattern.pattern, 'gm'); } catch { continue; }
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        positions.push({ start: m.index, end: m.index + m[0].length, rawText: m[0] });
        if (m[0].length === 0) re.lastIndex++;
      }
    }

    perPattern.push(positions);
  }

  if (perPattern.some((pp) => pp.length === 0)) return [];

  const results: Match[] = [];
  const anchors = perPattern[0]!;
  const proximity = template.proximityBytes || Infinity;

  for (const anchor of anchors) {
    const allNearby = perPattern.slice(1).every((others) =>
      others.some(
        (o) => Math.abs(o.start - anchor.start) <= proximity || Math.abs(o.end - anchor.end) <= proximity
      )
    );
    if (!allNearby) continue;

    const lineIndex = source.slice(0, anchor.start).split('\n').length - 1;
    const lineStart = source.lastIndexOf('\n', anchor.start) + 1;
    results.push(buildMatch(
      template.id,
      template.patterns[0]!.id,
      template.severity,
      template.patterns[0]!.message,
      anchor.rawText,
      lines,
      lineIndex,
      anchor.start - lineStart,
      false,
    ));
    if (results.length >= MAX_MATCHES_PER_FILE) break;
  }

  return results;
}
