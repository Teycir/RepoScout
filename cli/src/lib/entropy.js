"use strict";
// src/lib/entropy.ts
// Port of secretscout-core/src/entropy.rs
// Shannon entropy calculation + charset-aware thresholds.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTROPY_WORD_REGEX = void 0;
exports.detectCharset = detectCharset;
exports.charsetSize = charsetSize;
exports.charsetThreshold = charsetThreshold;
exports.calculateEntropy = calculateEntropy;
exports.calculateCharsetAwareEntropy = calculateCharsetAwareEntropy;
exports.getThreshold = getThreshold;
exports.isHighEntropy = isHighEntropy;
exports.isHighEntropyCharsetAware = isHighEntropyCharsetAware;
exports.isBase64Like = isBase64Like;
exports.isHexLike = isHexLike;
exports.findHighEntropyStrings = findHighEntropyStrings;
// ---------------------------------------------------------------------------
// Charset detection
// ---------------------------------------------------------------------------
function detectCharset(s) {
    if (isHexLike(s))
        return 'hex'; // pure hex digits: check before base64/alnum
    if (/^[a-zA-Z0-9]+$/.test(s))
        return 'alphanumeric'; // no special chars → not base64
    if (isBase64Like(s))
        return 'base64';
    return 'mixed';
}
function charsetSize(charset) {
    switch (charset) {
        case 'hex': return 16;
        case 'alphanumeric': return 62;
        case 'base64': return 64;
        case 'mixed': return 95;
    }
}
/** Charset-appropriate entropy threshold — mirrors Charset::threshold() in Rust */
function charsetThreshold(charset) {
    switch (charset) {
        case 'hex': return 3.5;
        case 'alphanumeric': return 4.0;
        case 'base64': return 4.5;
        case 'mixed': return 5.0;
    }
}
// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------
/** Raw Shannon entropy: 0.0 (no randomness) → ~6.0 (maximum for base64) */
function calculateEntropy(s) {
    if (!s)
        return 0;
    const freq = new Map();
    for (const ch of s)
        freq.set(ch, (freq.get(ch) ?? 0) + 1);
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
function calculateCharsetAwareEntropy(s) {
    const charset = detectCharset(s);
    const shannon = calculateEntropy(s);
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
function getThreshold(s) {
    return charsetThreshold(detectCharset(s));
}
/** Returns true if `s` has high Shannon entropy above `threshold`. */
function isHighEntropy(s, threshold) {
    if (s.length < 16)
        return false;
    return calculateEntropy(s) >= threshold;
}
/** Charset-aware high-entropy check — normalised > 0.75 = high entropy. */
function isHighEntropyCharsetAware(s) {
    if (s.length < 16)
        return false;
    const [normalised] = calculateCharsetAwareEntropy(s);
    return normalised >= 0.75;
}
// ---------------------------------------------------------------------------
// Charset predicates
// ---------------------------------------------------------------------------
function isBase64Like(s) {
    if (s.length < 16)
        return false;
    const base64Chars = [...s].filter((c) => /[a-zA-Z0-9+/=]/.test(c)).length;
    return base64Chars / s.length >= 0.9;
}
function isHexLike(s) {
    if (s.length < 16)
        return false;
    return /^[a-fA-F0-9]+$/.test(s);
}
// ---------------------------------------------------------------------------
// Regex for finding candidate high-entropy words in source text
// Mirrors ENTROPY_WORD_REGEX in scanner.rs
// ---------------------------------------------------------------------------
exports.ENTROPY_WORD_REGEX = /[a-zA-Z0-9+/=_-]{16,}/g;
/** Extract all candidate high-entropy substrings from a source string. */
function findHighEntropyStrings(source, threshold, maxResults = 500) {
    const results = [];
    const re = new RegExp(exports.ENTROPY_WORD_REGEX.source, 'g');
    let match;
    while ((match = re.exec(source)) !== null) {
        if (results.length >= maxResults)
            break;
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
