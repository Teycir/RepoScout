// tests/engine.e2e.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Local end-to-end test suite for the RepoScout scan engine.
// Exercises every major subsystem in-process: scanner, entropy, types, and the
// LangGraph AI-verification pipeline.  No Cloudflare Worker runtime, no external
// services, no better-sqlite3.
//
// Usage:
//   npx tsx --test tests/engine.e2e.test.ts
//   npm run test:e2e
// ─────────────────────────────────────────────────────────────────────────────

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dir     = dirname(__filename);
const ROOT      = join(__dir, '..');

// ── Engine imports (tsx resolves .js → .ts automatically) ────────────────────
import { scanSource, shouldSkipPath, isLikelyPlaceholder } from '../src/lib/scanner.js';
import {
  calculateEntropy,
  findHighEntropyStrings,
  detectCharset,
  charsetThreshold,
  isHighEntropy,
  isHighEntropyCharsetAware,
  calculateCharsetAwareEntropy,
} from '../src/lib/entropy.js';
import {
  severityWeight,
  riskLevel,
  maskSecret,
  severityBreakdown,
  totalRiskScore,
  findingRiskScore,
} from '../src/lib/types.js';
import type { Template, Match } from '../src/lib/types.js';
import {
  createScanValidationGraph,
  persistEvaluation,
} from '../src/scan-worker/pipeline.js';

// ── Load real patterns once ───────────────────────────────────────────────────
const ALL_PATTERNS: Template[] = JSON.parse(
  readFileSync(join(ROOT, 'src/scan-worker/patterns.json'), 'utf8'),
);

// ─────────────────────────────────────────────────────────────────────────────
// In-memory mocks  (zero native dependencies)
// ─────────────────────────────────────────────────────────────────────────────

class FakeKV {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null>       { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void>             { this.store.delete(key); }
  async list(_?: unknown)                              { return { keys: [], list_complete: true, caches: { default: 'none' } } as any; }
  async getWithMetadata(key: string)                   { return { value: this.store.get(key) ?? null, metadata: null, cacheStatus: null } as any; }
  peek(key: string)                                    { return this.store.get(key); }
  clear()                                              { this.store.clear(); }
}

class FakeD1 {
  captured: Array<{ sql: string; args: unknown[] }> = [];

  prepare(sql: string) {
    const self = this;
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...a: unknown[]) { bound = [...a]; return stmt; },
      async run() {
        self.captured.push({ sql, args: bound });
        return { results: [], success: true, meta: { changes: 1, last_row_id: self.captured.length, changed_db: true, duration: 0, rows_read: 0, rows_written: 1, size_after: 0 } };
      },
      async first<T>(): Promise<T | null>  { return null; },
      async all<T>()                       { return { results: [] as T[], success: true, meta: {} }; },
      _run()                               { return stmt.run(); },
    };
    return stmt as D1PreparedStatement;
  }
  async dump()                           { return new ArrayBuffer(0); }
  async batch<T>(stmts: D1PreparedStatement[]) {
    return Promise.all(stmts.map((s: any) => s._run())) as any;
  }
  async exec(sql: string) { return { count: 0, duration: 0 }; }

  last()  { return this.captured.at(-1) ?? null; }
  clear() { this.captured = []; }
}

class FakeAI {
  nextVerdict    = 'NEEDS_HUMAN_REVIEW';
  nextConfidence = 0.3;
  nextReasoning  = 'Stub AI — ambiguous match';

  async run(_model: string, input: { messages: { role: string; content: string }[] }) {
    const last = input.messages.at(-1)?.content ?? '';
    if (last.includes('access_granted'))
      return { response: JSON.stringify({ access_granted: 'Full API access', blast_radius: 'All user data', remediation: 'Revoke token immediately' }) };
    if (last.includes('"found"'))
      return { response: JSON.stringify({ found: false, value: null, reasoning: 'Not found in stub context' }) };
    return {
      response: JSON.stringify({
        verdict:    this.nextVerdict,
        reasoning:  this.nextReasoning,
        confidence: this.nextConfidence,
      }),
    };
  }
}

function makeEnv(opts?: { verdict?: string; confidence?: number }) {
  const kv = new FakeKV();
  const ai = new FakeAI();
  if (opts?.verdict    !== undefined) ai.nextVerdict    = opts.verdict;
  if (opts?.confidence !== undefined) ai.nextConfidence = opts.confidence;
  const db = new FakeD1();
  return {
    CACHE: kv as unknown as KVNamespace,
    AI:    ai as unknown as Ai,
    DB:    db as unknown as D1Database,
    _kv: kv, _ai: ai, _db: db,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function tpl(id: string): Template {
  const t = ALL_PATTERNS.find(p => p.id === id);
  assert.ok(t, `Template '${id}' not found in patterns.json`);
  return t!;
}

/** Scan source against a subset of patterns and return results. */
function scanWith(source: string, ...ids: string[]): Match[] {
  return scanSource(source, ids.map(tpl), { filePath: 'test-fixture.ts' });
}

// ── Token fixtures: valid format, clearly not real credentials ───────────────
//    Each must match the pattern but be obviously synthetic.

/** GitHub PAT  ghp_[0-9a-zA-Z]{36} */
const GH_PAT  = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1L2m3N4o5P6q7R8s9';  // 40 chars after ghp_ = wait, need 36

// 36-char alphanumeric suffix
const GH_SUFFIX_36 = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8'; // 36
const GITHUB_PAT   = 'ghp_' + GH_SUFFIX_36;

/** Stripe secret  sk_(live|test)_[0-9a-zA-Z]{24,} */
const STRIPE_KEY   = 'sk_' + 'live_TestFakeKeyAbcXyzDefGhiJkl012';

/** Anthropic key  sk-ant-api03-[a-zA-Z0-9_-]{95} */
const ANTHROPIC_KEY = 'sk-ant-api03-' + 'a'.repeat(95);

/** OpenAI key  sk-[a-zA-Z0-9]{48} */
const OPENAI_KEY    = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3X4'; // 48

/** Slack bot token  xoxb-{10,13}-{10,13}-[a-zA-Z0-9]{24,} */
const SLACK_BOT     = 'xoxb-' + '1234567890-9876543210-ABCDEFGHIJabcdefghij1234';

/** SendGrid  SG.[a-zA-Z0-9_-]{22}.[a-zA-Z0-9_-]{43} */
const SENDGRID_KEY  = 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43);

/** AWS Access Key ID  AKIA[A-Z0-9]{16}  (not the example value) */
const AWS_KEY_ID    = 'AKIAZFAKEACCESSKEYID';  // AKIA + 16 chars

/** High-entropy random-looking string for entropy tests */
const HIGH_ENTROPY  = 'r7Xm2Kp9QzL4Ws1vBnTfHjY8cUe6aN3Dg5oi0Rk';


// ── Convenience: look up Anthropic template (confirmed exists in patterns.json) ──
const ANTHROPIC_TPL: Template | undefined = ALL_PATTERNS.find(p => p.id === 'anthropic-api-key');

// Pattern ID that has no registered validator → returns UNVERIFIABLE without any
// network calls, and doesn't trigger contextInference (not shopify/algolia/firebase/okta/braintree)
const NO_NET_PATTERN_ID = 'unknown-credentials';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Path Filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('1. shouldSkipPath – path filtering', () => {
  test('skips node_modules paths', () => {
    assert.ok(shouldSkipPath('node_modules/some-lib/index.js'));
    assert.ok(shouldSkipPath('app/node_modules/foo.ts'));
  });

  test('skips binary / asset extensions', () => {
    assert.ok(shouldSkipPath('public/logo.png'));
    assert.ok(shouldSkipPath('fonts/Roboto.woff2'));
    assert.ok(shouldSkipPath('dist/bundle.wasm'));
    assert.ok(shouldSkipPath('chunks/vendor.map'));
  });

  test('skips build / generated directories', () => {
    assert.ok(shouldSkipPath('.next/server/pages/index.js'));
    assert.ok(shouldSkipPath('target/release/myapp'));
    assert.ok(shouldSkipPath('.git/config'));
  });

  test('does NOT skip normal source files', () => {
    assert.ok(!shouldSkipPath('src/lib/scanner.ts'));
    assert.ok(!shouldSkipPath('app/api/repos/route.ts'));
    assert.ok(!shouldSkipPath('README.md'));
    assert.ok(!shouldSkipPath('.env.example'));
  });

  test('does NOT skip dotenv or config files', () => {
    assert.ok(!shouldSkipPath('config/secrets.yaml'));
    assert.ok(!shouldSkipPath('.env'));
    assert.ok(!shouldSkipPath('docker-compose.yml'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Placeholder Detection
// ─────────────────────────────────────────────────────────────────────────────

describe('2. isLikelyPlaceholder – false-positive suppression', () => {
  test('detects placeholder / your_key / example terms', () => {
    assert.ok(isLikelyPlaceholder('sk_live_placeholder_key_here'));
    assert.ok(isLikelyPlaceholder('your_key_here'));
    assert.ok(isLikelyPlaceholder('YOUR_KEY'));
    assert.ok(isLikelyPlaceholder('REPLACE_ME_WITH_REAL_TOKEN'));
  });

  test('detects fake / mock / sample / demo terms', () => {
    assert.ok(isLikelyPlaceholder('sk_fake_key_abc123'));
    assert.ok(isLikelyPlaceholder('mock-token-here'));
    assert.ok(isLikelyPlaceholder('sample_api_key_value'));
    assert.ok(isLikelyPlaceholder('demo-secret-1234'));
  });

  test('detects low-entropy repeating hex', () => {
    // very few unique chars → clearly not a real secret
    assert.ok(isLikelyPlaceholder('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(isLikelyPlaceholder('1111111111111111111111111111111111'));
  });

  test('does NOT flag high-entropy tokens as placeholders', () => {
    assert.ok(!isLikelyPlaceholder(HIGH_ENTROPY));
    assert.ok(!isLikelyPlaceholder(GITHUB_PAT));
    assert.ok(!isLikelyPlaceholder(ANTHROPIC_KEY));
    assert.ok(!isLikelyPlaceholder(SENDGRID_KEY));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Entropy Engine
// ─────────────────────────────────────────────────────────────────────────────

describe('3. Entropy engine', () => {
  test('calculateEntropy → 0 for empty string', () => {
    assert.equal(calculateEntropy(''), 0);
  });

  test('calculateEntropy → 0 for single repeated character', () => {
    assert.equal(calculateEntropy('aaaaaaa'), 0);
  });

  test('calculateEntropy → ~1.0 for perfectly balanced binary string', () => {
    const bits = '01'.repeat(20); // equal 0 and 1
    const e = calculateEntropy(bits);
    assert.ok(Math.abs(e - 1.0) < 0.001, `expected ~1.0, got ${e}`);
  });

  test('calculateEntropy → > 4.5 for high-entropy random string', () => {
    const e = calculateEntropy(HIGH_ENTROPY);
    assert.ok(e > 4.5, `expected > 4.5, got ${e}`);
  });

  test('detectCharset: all-hex string → "hex"', () => {
    assert.equal(detectCharset('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), 'hex');
  });

  test('detectCharset: base64-like string → "base64"', () => {
    const b64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='; // valid base64
    assert.equal(detectCharset(b64), 'base64');
  });

  test('detectCharset: letters+digits no special chars → "alphanumeric"', () => {
    assert.equal(detectCharset('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'), 'alphanumeric');
  });

  test('charsetThreshold: correct thresholds per charset', () => {
    assert.equal(charsetThreshold('hex'), 3.5);
    assert.equal(charsetThreshold('alphanumeric'), 4.0);
    assert.equal(charsetThreshold('base64'), 4.5);
    assert.equal(charsetThreshold('mixed'), 5.0);
  });

  test('isHighEntropy: strings shorter than 16 chars always false', () => {
    assert.ok(!isHighEntropy('secretABCDEF', 2.0));
  });

  test('isHighEntropy: random 40-char token above 4.0 threshold', () => {
    assert.ok(isHighEntropy(HIGH_ENTROPY, 4.0));
  });

  test('isHighEntropy: low-diversity string below threshold', () => {
    assert.ok(!isHighEntropy('aaaaaaaabbbbbbbbcccccccc', 4.0));
  });

  test('isHighEntropyCharsetAware: high-entropy token passes (normalised > 0.75)', () => {
    assert.ok(isHighEntropyCharsetAware(HIGH_ENTROPY));
  });

  test('isHighEntropyCharsetAware: repeating pattern fails', () => {
    assert.ok(!isHighEntropyCharsetAware('abcabcabcabcabcabcabcabc'));
  });

  test('calculateCharsetAwareEntropy returns [0–1 normalised, charset]', () => {
    const [norm, charset] = calculateCharsetAwareEntropy(HIGH_ENTROPY);
    assert.ok(norm > 0.70, `expected norm > 0.70, got ${norm}`);
    assert.ok(['alphanumeric', 'base64', 'mixed'].includes(charset),
      `unexpected charset: ${charset}`);
  });

  test('findHighEntropyStrings extracts high-entropy substring', () => {
    const src = `const TOKEN = "${HIGH_ENTROPY}"; // random`;
    const hits = findHighEntropyStrings(src, 4.0);
    assert.ok(hits.length >= 1, 'expected at least one high-entropy hit');
    const match = hits.find(h => h.text === HIGH_ENTROPY);
    assert.ok(match, 'expected HIGH_ENTROPY token to be found');
    assert.ok(match!.entropy > 4.0, `entropy ${match!.entropy} should exceed 4.0`);
  });

  test('findHighEntropyStrings: low-entropy source → no hits', () => {
    const src = 'const a = "hello world"; const b = "test";';
    const hits = findHighEntropyStrings(src, 4.0);
    assert.equal(hits.length, 0);
  });

  test('findHighEntropyStrings respects maxResults cap', () => {
    // build source with many high-entropy tokens
    const tokens = Array.from({ length: 20 }, (_, i) =>
      HIGH_ENTROPY.slice(0, -2) + i.toString().padStart(2, '0')
    );
    const src = tokens.join(' ');
    const hits = findHighEntropyStrings(src, 4.0, 5);
    assert.ok(hits.length <= 5, `expected <= 5 results, got ${hits.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Types & Risk Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('4. Types & risk helpers', () => {
  test('severityWeight: all five tiers', () => {
    assert.equal(severityWeight('critical'), 100);
    assert.equal(severityWeight('high'),      40);
    assert.equal(severityWeight('medium'),    15);
    assert.equal(severityWeight('low'),        5);
    assert.equal(severityWeight('info'),       1);
  });

  test('riskLevel: bucket boundaries', () => {
    assert.equal(riskLevel(0),   'None');
    assert.equal(riskLevel(1),   'Low');
    assert.equal(riskLevel(5),   'Low');
    assert.equal(riskLevel(6),   'Medium');
    assert.equal(riskLevel(15),  'Medium');
    assert.equal(riskLevel(16),  'High');
    assert.equal(riskLevel(30),  'High');
    assert.equal(riskLevel(31),  'Critical');
    assert.equal(riskLevel(999), 'Critical');
  });

  test('maskSecret: short (≤ 8 chars) → fully masked', () => {
    assert.equal(maskSecret('abc'),       '***');
    assert.equal(maskSecret('12345678'),  '********');
  });

  test('maskSecret: long token → prefix***suffix', () => {
    const masked = maskSecret('ghp_ABCDEFGHIJKLMNOP');
    assert.ok(masked.startsWith('ghp_'), `expected ghp_ prefix, got ${masked}`);
    assert.ok(masked.includes('***'), 'expected *** in masked output');
    assert.ok(masked.endsWith('NOP'), `expected NOP suffix, got ${masked}`);
  });

  test('maskSecret: GITHUB_PAT fixture – prefix & suffix preserved', () => {
    const masked = maskSecret(GITHUB_PAT);
    assert.ok(masked.startsWith('ghp_'));
    assert.ok(masked.includes('***'));
    assert.ok(masked.endsWith(GH_SUFFIX_36.slice(-4)));
  });

  test('findingRiskScore: TRUE_POSITIVE doubles severity weight', () => {
    assert.equal(findingRiskScore('critical', 'TRUE_POSITIVE'), 200);
    assert.equal(findingRiskScore('high',     'TRUE_POSITIVE'),  80);
    assert.equal(findingRiskScore('medium',   'TRUE_POSITIVE'),  30);
    assert.equal(findingRiskScore('low',      'TRUE_POSITIVE'),  10);
  });

  test('findingRiskScore: FALSE_POSITIVE always 0', () => {
    assert.equal(findingRiskScore('critical', 'FALSE_POSITIVE'), 0);
    assert.equal(findingRiskScore('high',     'FALSE_POSITIVE'), 0);
    assert.equal(findingRiskScore('info',     'FALSE_POSITIVE'), 0);
  });

  test('findingRiskScore: NEEDS_HUMAN_REVIEW = 1× weight', () => {
    assert.equal(findingRiskScore('critical', 'NEEDS_HUMAN_REVIEW'), 100);
    assert.equal(findingRiskScore('high',     'NEEDS_HUMAN_REVIEW'),  40);
    assert.equal(findingRiskScore('medium',   'NEEDS_HUMAN_REVIEW'),  15);
  });

  test('severityBreakdown counts correctly', () => {
    const mkM = (s: string) => ({ severity: s } as any as Match);
    const matches = [
      mkM('critical'), mkM('critical'),
      mkM('high'),
      mkM('medium'), mkM('medium'), mkM('medium'),
      mkM('low'),
      mkM('info'),
    ];
    const bd = severityBreakdown(matches);
    assert.equal(bd.critical, 2);
    assert.equal(bd.high,     1);
    assert.equal(bd.medium,   3);
    assert.equal(bd.low,      1);
    assert.equal(bd.info,     1);
  });

  test('totalRiskScore sums severity weights (ignores verdict)', () => {
    const mkM = (s: string) => ({ severity: s } as any as Match);
    // critical(100) + high(40) + low(5) = 145
    const matches = [mkM('critical'), mkM('high'), mkM('low')];
    assert.equal(totalRiskScore(matches), 145);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Pattern Scanner
// ─────────────────────────────────────────────────────────────────────────────

describe('5. Pattern scanner', () => {
  test('anthropic-api-key template exists in patterns.json', () => {
    assert.ok(ANTHROPIC_TPL, 'anthropic-api-key must exist in patterns.json');
    assert.equal(ANTHROPIC_TPL!.severity, 'critical');
  });

  test('detects ANTHROPIC_KEY in source, sets correct fields', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = `const API_KEY = '${ANTHROPIC_KEY}';`;
    const matches = scanSource(src, [ANTHROPIC_TPL], { filePath: 'config.ts' });
    assert.ok(matches.length >= 1, 'expected at least one match');
    const m = matches[0]!;
    assert.equal(m.templateId, 'anthropic-api-key');
    assert.equal(m.severity,   'critical');
    assert.equal(m.filePath,   'config.ts');
    assert.ok(m.lineNumber >= 1);
    assert.ok(m.matchedText.includes('***'), 'matchedText should be masked');
    assert.equal(m.rawMatchedText, ANTHROPIC_KEY, 'rawMatchedText should be unmasked');
    assert.equal(m.entropyScore, null, 'regex matches have null entropyScore');
  });

  test('reports correct line number for multi-line source', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = `// line 1\n// line 2\nconst KEY = '${ANTHROPIC_KEY}';`;
    const matches = scanSource(src, [ANTHROPIC_TPL], { filePath: 'f.ts' });
    assert.ok(matches.length >= 1);
    assert.equal(matches[0]!.lineNumber, 3);
  });

  test('provides context lines above and below the match', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = ['// header A', '// header B', `const K = '${ANTHROPIC_KEY}';`, '// footer'].join('\n');
    const matches = scanSource(src, [ANTHROPIC_TPL], { filePath: 'f.ts' });
    assert.ok(matches.length >= 1);
    const ctx = matches[0]!.context;
    assert.ok(ctx.includes('header') || ctx.includes('footer'), 'context should include surrounding lines');
  });

  test('placeholder suppression – token containing "placeholder" not matched', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const raw = 'sk-ant-api03-' + 'placeholder'.padEnd(95, 'x');
    const src = `const KEY = '${raw}';`;
    const matches = scanSource(src, [ANTHROPIC_TPL], { filePath: 'f.ts' });
    assert.equal(matches.length, 0, 'placeholder must be suppressed');
  });

  test('inline suppression – secretscout:ignore on same line', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = `const KEY = '${ANTHROPIC_KEY}'; // secretscout:ignore`;
    const matches = scanSource(src, [ANTHROPIC_TPL], { filePath: 'f.ts' });
    assert.equal(matches.length, 0, 'suppressed line should yield no matches');
  });

  test('secretscout:ignore-next suppresses the following line', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = ['// secretscout:ignore-next', `const KEY = '${ANTHROPIC_KEY}';`].join('\n');
    const matches = scanSource(src, [ANTHROPIC_TPL], { filePath: 'f.ts' });
    assert.equal(matches.length, 0, 'next-line suppression should work');
  });

  test('deduplicates when same template passed twice', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = `const KEY = '${ANTHROPIC_KEY}';`;
    const matches = scanSource(src, [ANTHROPIC_TPL, ANTHROPIC_TPL], { filePath: 'f.ts' });
    const dedupKeys = new Set(matches.map(m => `${m.lineNumber}:${m.column}:${m.patternId}`));
    assert.equal(dedupKeys.size, matches.length, 'no duplicate entries should exist');
  });

  test('respects maxMatches option', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const lines = Array.from({ length: 20 }, (_, i) =>
      `const K${i} = 'sk-ant-api03-${'a'.repeat(94)}${i % 10}';`
    ).join('\n');
    const matches = scanSource(lines, [ANTHROPIC_TPL], { filePath: 'f.ts', maxMatches: 3 });
    assert.ok(matches.length <= 3, `expected <= 3 matches, got ${matches.length}`);
  });

  test('empty source → no matches', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    assert.equal(scanSource('', [ANTHROPIC_TPL]).length, 0);
  });

  test('empty template list → no matches', () => {
    const src = `const KEY = '${ANTHROPIC_KEY}';`;
    assert.equal(scanSource(src, []).length, 0);
  });

  test('full ALL_PATTERNS scan detects Anthropic key', () => {
    if (!ANTHROPIC_TPL) { assert.ok(true, 'skip'); return; }
    const src = `const KEY = '${ANTHROPIC_KEY}';`;
    const matches = scanSource(src, ALL_PATTERNS, { filePath: 'secrets.ts' });
    const found = matches.find(m => m.templateId === 'anthropic-api-key');
    assert.ok(found, 'Anthropic key must be detected when scanning with all patterns');
  });

  test('patterns.json sanity: all templates have id, name, severity, and ≥1 pattern', () => {
    assert.ok(ALL_PATTERNS.length > 0, 'patterns.json must not be empty');
    const validSeverities = new Set(['info', 'low', 'medium', 'high', 'critical']);
    for (const t of ALL_PATTERNS) {
      assert.ok(t.id,   `template missing id`);
      assert.ok(t.name, `template ${t.id} missing name`);
      assert.ok(t.patterns.length > 0, `template ${t.id} has no patterns`);
      assert.ok(validSeverities.has(t.severity), `template ${t.id} invalid severity: ${t.severity}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Pipeline – Heuristic Filter
// ─────────────────────────────────────────────────────────────────────────────

describe('6. Pipeline – heuristic filter', () => {
  test('placeholder rawMatchedText → FALSE_POSITIVE, riskScore=0, heuristic method', async () => {
    const env = makeEnv();
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke({
      findingId:           'test-heuristic-fp',
      repoName:            'test-repo',
      filePath:            'config.ts',
      lineNumber:          1,
      matchedText:         'sk-ant-***-fake',
      rawMatchedText:      'sk-ant-api03-' + 'placeholder'.padEnd(95, 'x'),
      lineContent:         'const KEY = "sk-ant-placeholder";',
      surroundingContext:  '// dev stub',
      patternId:           'anthropic-api-key',
      templateId:          'anthropic-api-key',
      severity:            'critical',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'heuristic' as const,
    });
    assert.equal(result.verdict, 'FALSE_POSITIVE');
    assert.equal(result.validationMethod, 'heuristic');
    assert.equal(result.confidenceScore, 1.0);
    assert.equal(result.riskScore, 0);
    assert.equal(result.isHeuristicPlaceholder, true);
    // LLM quota must be untouched (heuristic path bypasses LLM)
    const today = new Date().toISOString().slice(0, 10);
    const quota = env._kv.peek(`llm_quota:${today}`);
    assert.equal(quota, undefined, 'heuristic path must not increment LLM quota');
  });

  test('low-entropy hex rawMatchedText → FALSE_POSITIVE via heuristic', async () => {
    const env = makeEnv();
    const graph = createScanValidationGraph(env);
    const lowEntropyHex = 'a'.repeat(36); // all same char, few unique
    const result = await graph.invoke({
      findingId:           'test-heuristic-hex',
      repoName:            'test-repo',
      filePath:            'f.ts',
      lineNumber:          1,
      matchedText:         '****',
      rawMatchedText:      lowEntropyHex,
      lineContent:         `const H = "${lowEntropyHex}";`,
      surroundingContext:  '',
      patternId:           'anthropic-api-key',
      templateId:          'anthropic-api-key',
      severity:            'high',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'heuristic' as const,
    });
    assert.equal(result.verdict, 'FALSE_POSITIVE');
    assert.equal(result.riskScore, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Pipeline – LLM Classifier (stubbed AI)
// ─────────────────────────────────────────────────────────────────────────────

describe('7. Pipeline – LLM classifier (FakeAI)', () => {
  // helper: build a standard real-looking state for pipeline tests
  function makeState(override: Record<string, unknown> = {}) {
    return {
      findingId:           'test-llm-base',
      repoName:            'owner/repo',
      filePath:            'src/secrets.ts',
      lineNumber:          7,
      matchedText:         SENDGRID_KEY.slice(0, 4) + '***',
      rawMatchedText:      SENDGRID_KEY,
      lineContent:         `const SG = "${SENDGRID_KEY}";`,
      surroundingContext:  `const SG = "${SENDGRID_KEY}";`,
      patternId:           NO_NET_PATTERN_ID,  // no validator → UNVERIFIABLE, no network
      templateId:          NO_NET_PATTERN_ID,
      severity:            'high',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'llm' as const,
      ...override,
    };
  }

  test('default FakeAI (confidence=0.3) → NEEDS_HUMAN_REVIEW, LLM quota incremented', async () => {
    const env = makeEnv({ verdict: 'NEEDS_HUMAN_REVIEW', confidence: 0.3 });
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke(makeState());

    assert.equal(result.verdict, 'NEEDS_HUMAN_REVIEW');
    assert.ok(result.riskScore >= 0, 'riskScore should be non-negative');
    // riskScore = high(40) * 1.0 = 40 for NEEDS_HUMAN_REVIEW
    assert.equal(result.riskScore, 40);

    const today = new Date().toISOString().slice(0, 10);
    const quotaRaw = env._kv.peek(`llm_quota:${today}`);
    assert.ok(quotaRaw !== undefined, 'LLM quota key must exist after run');
    assert.ok(parseInt(quotaRaw!, 10) >= 1, 'quota should be >= 1');
  });

  test('FakeAI TRUE_POSITIVE (confidence=0.95) → riskScore=80 + [Impact] in reasoning', async () => {
    const env = makeEnv({ verdict: 'TRUE_POSITIVE', confidence: 0.95 });
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke(makeState({ findingId: 'test-llm-tp' }));

    assert.equal(result.verdict, 'TRUE_POSITIVE');
    // findingRiskScore('high', 'TRUE_POSITIVE') = 40 * 2.0 = 80
    assert.equal(result.riskScore, 80);
    // impactSummary node appends [Impact] tag
    assert.ok(result.aiReasoning?.includes('[Impact]'),
      `expected [Impact] in aiReasoning, got: ${result.aiReasoning}`);
    assert.equal(result.validationMethod, 'llm');
  });

  test('exhausted LLM quota → NEEDS_HUMAN_REVIEW without AI call (mentions quota)', async () => {
    const env = makeEnv({ verdict: 'TRUE_POSITIVE', confidence: 0.95 });
    // Pre-fill quota to cap
    const today = new Date().toISOString().slice(0, 10);
    await env._kv.put(`llm_quota:${today}`, '450');

    const graph = createScanValidationGraph(env);
    const result = await graph.invoke(makeState({ findingId: 'test-quota', severity: 'medium' }));

    assert.equal(result.verdict, 'NEEDS_HUMAN_REVIEW');
    assert.ok(result.aiReasoning?.toLowerCase().includes('quota'),
      `expected "quota" in reasoning, got: ${result.aiReasoning}`);
    // quota key should still be 450 (not incremented – quota gate prevented the call)
    const quotaAfter = env._kv.peek(`llm_quota:${today}`);
    assert.equal(quotaAfter, '450', 'quota should not have changed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Pipeline – Risk Scorer
// ─────────────────────────────────────────────────────────────────────────────

describe('8. Pipeline – risk scorer', () => {
  test('FALSE_POSITIVE → riskScore=0 regardless of severity', async () => {
    const env = makeEnv();
    const graph = createScanValidationGraph(env);
    // Placeholder triggers FALSE_POSITIVE via heuristic (avoids network)
    const result = await graph.invoke({
      findingId:           'test-risk-fp',
      repoName:            'r',
      filePath:            'f.ts',
      lineNumber:          1,
      matchedText:         '***',
      rawMatchedText:      'sk-ant-api03-' + 'dummy'.padEnd(95, '0'),
      lineContent:         '',
      surroundingContext:  '',
      patternId:           'anthropic-api-key',
      templateId:          'anthropic-api-key',
      severity:            'critical',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'heuristic' as const,
    });
    assert.equal(result.verdict, 'FALSE_POSITIVE');
    assert.equal(result.riskScore, 0,
      `FALSE_POSITIVE riskScore must be 0, got ${result.riskScore}`);
  });

  test('NEEDS_HUMAN_REVIEW + critical → riskScore=100 (1× multiplier)', async () => {
    const env = makeEnv({ verdict: 'NEEDS_HUMAN_REVIEW', confidence: 0.3 });
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke({
      findingId:           'test-risk-nhr-crit',
      repoName:            'r',
      filePath:            'f.ts',
      lineNumber:          1,
      matchedText:         SENDGRID_KEY.slice(0, 4) + '***',
      rawMatchedText:      SENDGRID_KEY,
      lineContent:         `const K = "${SENDGRID_KEY}";`,
      surroundingContext:  '',
      patternId:           NO_NET_PATTERN_ID,
      templateId:          NO_NET_PATTERN_ID,
      severity:            'critical',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'llm' as const,
    });
    assert.equal(result.verdict, 'NEEDS_HUMAN_REVIEW');
    assert.equal(result.riskScore, 100);  // critical(100) × 1.0
  });

  test('TRUE_POSITIVE + low → riskScore=10 (2× multiplier)', async () => {
    const env = makeEnv({ verdict: 'TRUE_POSITIVE', confidence: 0.9 });
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke({
      findingId:           'test-risk-tp-low',
      repoName:            'r',
      filePath:            'f.ts',
      lineNumber:          1,
      matchedText:         SLACK_BOT.slice(0, 4) + '***',
      rawMatchedText:      SLACK_BOT,
      lineContent:         `const S = "${SLACK_BOT}";`,
      surroundingContext:  '',
      patternId:           NO_NET_PATTERN_ID,
      templateId:          NO_NET_PATTERN_ID,
      severity:            'low',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'llm' as const,
    });
    assert.equal(result.verdict, 'TRUE_POSITIVE');
    assert.equal(result.riskScore, 10);  // low(5) × 2.0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. persistEvaluation
// ─────────────────────────────────────────────────────────────────────────────

describe('9. persistEvaluation', () => {
  test('inserts correct fields into ai_evaluations', async () => {
    const { _db, DB } = makeEnv();
    await persistEvaluation(DB, {
      findingId:        'finding-abc-123',
      verdict:          'TRUE_POSITIVE',
      confidence:       0.95,
      validationMethod: 'llm',
      validationStatus: 'ACTIVE',
      reasoning:        'Pattern matched confirmed live credential.',
      riskScore:        200,
    });
    const last = _db.last();
    assert.ok(last, 'FakeD1 should have captured a SQL statement');
    assert.ok(last.sql.toLowerCase().includes('ai_evaluations'), 'SQL must target ai_evaluations table');
    assert.ok(last.sql.toLowerCase().includes('insert'),          'SQL must be an INSERT');
    assert.ok(last.args.includes('finding-abc-123'),              'args must include findingId');
    assert.ok(last.args.includes('TRUE_POSITIVE'),                'args must include verdict');
    assert.ok(last.args.includes('llm'),                          'args must include validationMethod');
    assert.ok(last.args.includes('ACTIVE'),                       'args must include validationStatus');
    assert.ok(last.args.includes(0.95),                           'args must include confidence');
  });

  test('SQL includes ON CONFLICT upsert clause', async () => {
    const { _db, DB } = makeEnv();
    await persistEvaluation(DB, {
      findingId:        'finding-upsert-test',
      verdict:          'FALSE_POSITIVE',
      confidence:       0.9,
      validationMethod: 'heuristic',
      validationStatus: 'FALSE_POSITIVE',
      reasoning:        'Low-entropy placeholder.',
      riskScore:        0,
    });
    const last = _db.last();
    assert.ok(last!.sql.includes('ON CONFLICT'),
      'SQL must contain ON CONFLICT upsert clause');
  });

  test('two calls capture two statements', async () => {
    const { _db, DB } = makeEnv();
    const base = {
      verdict:          'FALSE_POSITIVE' as const,
      confidence:       0.8,
      validationMethod: 'heuristic',
      validationStatus: 'FALSE_POSITIVE',
      reasoning:        'mock',
      riskScore:        0,
    };
    await persistEvaluation(DB, { ...base, findingId: 'f-001' });
    await persistEvaluation(DB, { ...base, findingId: 'f-002' });
    assert.equal(_db.captured.length, 2, 'should have 2 captured statements');
    assert.ok(_db.captured[0]!.args.includes('f-001'));
    assert.ok(_db.captured[1]!.args.includes('f-002'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Full E2E Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('10. Full e2e integration', () => {
  test('placeholder → FALSE_POSITIVE → riskScore=0 → KV quota untouched', async () => {
    const env = makeEnv();
    env._kv.clear();
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke({
      findingId:           'e2e-placeholder-run',
      repoName:            'owner/repo',
      filePath:            'src/config.ts',
      lineNumber:          42,
      matchedText:         'sk-ant-***-fake',
      rawMatchedText:      'sk-ant-api03-' + 'placeholder'.padEnd(95, 'x'),
      lineContent:         'const KEY = "sk-ant-placeholder";',
      surroundingContext:  '// dev stub\nconst KEY = "placeholder";',
      patternId:           'anthropic-api-key',
      templateId:          'anthropic-api-key',
      severity:            'critical',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'heuristic' as const,
    });

    assert.equal(result.verdict,          'FALSE_POSITIVE');
    assert.equal(result.riskScore,         0);
    assert.equal(result.validationMethod, 'heuristic');
    assert.equal(result.confidenceScore,   1.0);

    const today = new Date().toISOString().slice(0, 10);
    const quota = env._kv.peek(`llm_quota:${today}`);
    assert.equal(quota, undefined, 'heuristic path must not write LLM quota KV key');
  });

  test('real token → NEEDS_HUMAN_REVIEW → persist to FakeD1 correctly', async () => {
    const env = makeEnv({ verdict: 'NEEDS_HUMAN_REVIEW', confidence: 0.4 });
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke({
      findingId:           'e2e-persist-run',
      repoName:            'owner/repo',
      filePath:            'src/secrets.ts',
      lineNumber:          7,
      matchedText:         SENDGRID_KEY.slice(0, 4) + '***',
      rawMatchedText:      SENDGRID_KEY,
      lineContent:         `const SG = "${SENDGRID_KEY}";`,
      surroundingContext:  `const SG = "${SENDGRID_KEY}";`,
      patternId:           NO_NET_PATTERN_ID,
      templateId:          NO_NET_PATTERN_ID,
      severity:            'high',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'llm' as const,
    });

    assert.equal(result.verdict, 'NEEDS_HUMAN_REVIEW');

    // Now persist the result and verify DB capture
    env._db.clear();
    await persistEvaluation(env.DB, {
      findingId:        'e2e-persist-run',
      verdict:          result.verdict,
      confidence:       result.confidenceScore,
      validationMethod: result.validationMethod ?? 'llm',
      validationStatus: result.validationStatus ?? 'UNVERIFIABLE',
      reasoning:        result.aiReasoning ?? '',
      riskScore:        result.riskScore,
    });

    const last = env._db.last();
    assert.ok(last, 'DB should capture the persist INSERT');
    assert.ok(last.args.includes('e2e-persist-run'), 'findingId should be in args');
    assert.ok(last.args.includes(result.verdict),    'verdict should be in args');
    // riskScore for NEEDS_HUMAN_REVIEW + high = 40 * 1.0 = 40
    assert.equal(result.riskScore, 40);
  });

  test('TRUE_POSITIVE run → impact summary + riskScore + DB persist all correct', async () => {
    const env = makeEnv({ verdict: 'TRUE_POSITIVE', confidence: 0.92 });
    const graph = createScanValidationGraph(env);
    const result = await graph.invoke({
      findingId:           'e2e-tp-full',
      repoName:            'owner/repo',
      filePath:            'infra/deploy.sh',
      lineNumber:          15,
      matchedText:         GITHUB_PAT.slice(0, 4) + '***',
      rawMatchedText:      GITHUB_PAT,
      lineContent:         `export GH_PAT="${GITHUB_PAT}"`,
      surroundingContext:  `# deploy token\nexport GH_PAT="${GITHUB_PAT}"`,
      patternId:           NO_NET_PATTERN_ID,
      templateId:          NO_NET_PATTERN_ID,
      severity:            'critical',
      isHeuristicPlaceholder: false,
      validationStatus:    'UNVERIFIABLE' as const,
      verdict:             'NEEDS_HUMAN_REVIEW' as const,
      aiReasoning:         '',
      confidenceScore:     0,
      riskScore:           0,
      validationMethod:    'llm' as const,
    });

    assert.equal(result.verdict,     'TRUE_POSITIVE');
    assert.equal(result.riskScore,    200);          // critical(100) × 2.0
    assert.ok(result.aiReasoning?.includes('[Impact]'),
      `[Impact] must appear in aiReasoning: "${result.aiReasoning}"`);

    // Persist and verify
    env._db.clear();
    await persistEvaluation(env.DB, {
      findingId:        'e2e-tp-full',
      verdict:          result.verdict,
      confidence:       result.confidenceScore,
      validationMethod: result.validationMethod ?? 'llm',
      validationStatus: result.validationStatus ?? 'ACTIVE',
      reasoning:        result.aiReasoning ?? '',
      riskScore:        result.riskScore,
    });

    const last = env._db.last();
    assert.ok(last, 'persist must write to DB');
    assert.ok(last.args.includes('TRUE_POSITIVE'), 'DB args must include TRUE_POSITIVE verdict');
    assert.ok(last.args.includes('e2e-tp-full'),   'DB args must include the findingId');
  });
});
