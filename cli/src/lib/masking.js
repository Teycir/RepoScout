"use strict";
// src/lib/masking.ts
// Port of secretscout-core/src/utils/masking.rs
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskSecret = maskSecret;
exports.maskTokenDisplay = maskTokenDisplay;
exports.maskInLine = maskInLine;
exports.maskContext = maskContext;
/**
 * Mask a secret for safe display.
 * Shows first 4 + last 4 chars, replaces middle with ***.
 * Strings ≤ 8 chars are fully masked.
 */
function maskSecret(secret) {
    if (secret.length <= 8)
        return '*'.repeat(secret.length);
    const prefix = secret.slice(0, 4);
    const suffix = secret.slice(-4);
    return `${prefix}***${suffix}`;
}
/**
 * Mask for display in UI — preserves token type prefix legibility.
 * e.g. ghp_U2JF...oIWT  (8 prefix chars + last 4)
 */
function maskTokenDisplay(token) {
    if (token.length <= 12)
        return maskSecret(token);
    const prefix = token.slice(0, 8);
    const suffix = token.slice(-4);
    return `${prefix}...${suffix}`;
}
/**
 * Mask a secret within a larger string (e.g. a line of code).
 * Replaces every occurrence of `secret` with its masked form.
 */
function maskInLine(line, secret) {
    if (!secret || secret.length < 4)
        return line;
    return line.split(secret).join(maskSecret(secret));
}
/**
 * Mask a context block (array of lines) by replacing all occurrences of secret.
 */
function maskContext(lines, secret) {
    return lines.map((l) => maskInLine(l, secret));
}
