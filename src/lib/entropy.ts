// src/lib/entropy.ts
// Port of secretscout-core/src/entropy.rs
// Shannon entropy calculation + charset-aware thresholds.

export type Charset = 'base64' | 'hex' | 'alphanumeric' | 'mixed';

// ---------------------------------------------------------------------------
// Charset detection
// ---------------------------------------------------------------------------

export function detectCharset(s: string): Charset {
  if (isBase64Like(s)) return 'base64';
  if (isHexLike(s))    return 'hex';
  if (/^[a-zA-Z0-9]+$/.test(s)) return 'alphanumeric';
  return 'mixed';
}

export function charsetSize(charset: Charset): number {
  switch (charset) {
    case 'hex':          return 16;
    case 'alphanumeric': return 62;
    case 'base64':       return 64;
    case 'mixed':        return 95;
  }
}

/** Charset-appropriate entropy threshold — mirrors Charset::threshold() in Rust */
export function charsetThreshold(charset: Charset): number {
  switch (charset) {
    case 'hex':          return 3.5;
    case 'alphanumeric': return 4.0;
    case 'base64':       return 4.5;
    case 'mixed':        return 5.0;
  }
}

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

/** Raw Shannon entropy: 0.0 (no randomness) → ~6.0 (maximum for base64) */
export function calculateEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const len = s.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Charset-aware entropy: returns [normalised 0–1, charset].
 * Mirrors calculate_charset_aware_entropy() in Rust.
 */
export function calculateCharsetAwareEntropy(s: string): [number, Charset] {
  const charset    = detectCharset(s);
  const shannon    = calculateEntropy(s);
  const maxEntropy = Math.log2(charsetSize(charset));
  const normalised = maxEntropy > 0 ? shannon / maxEntropy : 0;
  return [normalised, charset];
}

// ---------------------------------------------------------------------------
// Threshold helpers
// ---------------------------------------------------------------------------

/**
 * Get the effective entropy threshold for a string.
 * Callers can only raise the floor, never lower it.
 */
export function getThreshold(s: string): number {
  return charsetThreshold(detectCharset(s));
}

/** Returns true if `s` has high Shannon entropy above `threshold`. */
export function isHighEntropy(s: string, threshold: number): boolean {
  if (s.length < 16) return false;
  return calculateEntropy(s) >= threshold;
}

/** Charset-aware high-entropy check — normalised > 0.75 = high entropy. */
export function isHighEntropyCharsetAware(s: string): boolean {
  if (s.length < 16) return false;
  const [normalised] = calculateCharsetAwareEntropy(s);
  return normalised >= 0.75;
}

// ---------------------------------------------------------------------------
// Charset predicates
// ---------------------------------------------------------------------------

export function isBase64Like(s: string): boolean {
  if (s.length < 16) return false;
  const base64Chars = [...s].filter(
    (c) => /[a-zA-Z0-9+/=]/.test(c)
  ).length;
  return base64Chars / s.length >= 0.9;
}

export function isHexLike(s: string): boolean {
  if (s.length < 16) return false;
  return /^[a-fA-F0-9]+$/.test(s);
}

// ---------------------------------------------------------------------------
// Regex for finding candidate high-entropy words in source text
// Mirrors ENTROPY_WORD_REGEX in scanner.rs
// ---------------------------------------------------------------------------

export const ENTROPY_WORD_REGEX = /[a-zA-Z0-9+/=_-]{16,}/g;

/** Extract all candidate high-entropy substrings from a source string. */
export function findHighEntropyStrings(
  source: string,
  threshold: number,
  maxResults = 500,
): Array<{ start: number; end: number; text: string; entropy: number }> {
  const results: Array<{ start: number; end: number; text: string; entropy: number }> = [];
  const re = new RegExp(ENTROPY_WORD_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    if (results.length >= maxResults) break;
    const text = match[0];
    const charsetThresh = getThreshold(text);
    const effectiveThresh = Math.max(charsetThresh, threshold);
    const entropy = calculateEntropy(text);
    if (entropy >= effectiveThresh) {
      results.push({ start: match.index, end: match.index + text.length, text, entropy });
    }
  }

  return results;
}
