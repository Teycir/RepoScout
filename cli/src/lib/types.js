"use strict";
// src/lib/types.ts
// TypeScript port of secretscout-types/src/lib.rs
// Single source of truth for all domain types shared across scanner, validator, pipeline, and UI.
Object.defineProperty(exports, "__esModule", { value: true });
exports.severityWeight = severityWeight;
exports.verdictMultiplier = verdictMultiplier;
exports.findingRiskScore = findingRiskScore;
exports.maskSecret = maskSecret;
exports.severityBreakdown = severityBreakdown;
exports.totalRiskScore = totalRiskScore;
exports.riskLevel = riskLevel;
// ---------------------------------------------------------------------------
// Severity helpers (mirrors Rust impl)
// ---------------------------------------------------------------------------
const SEVERITY_WEIGHT = {
    critical: 100,
    high: 40,
    medium: 15,
    low: 5,
    info: 1,
};
const VERDICT_MULTIPLIER = {
    TRUE_POSITIVE: 2.0,
    NEEDS_HUMAN_REVIEW: 1.0,
    FALSE_POSITIVE: 0.0,
};
function severityWeight(s) {
    return SEVERITY_WEIGHT[s];
}
function verdictMultiplier(v) {
    return VERDICT_MULTIPLIER[v];
}
function findingRiskScore(severity, verdict) {
    return severityWeight(severity) * verdictMultiplier(verdict);
}
function maskSecret(secret) {
    if (secret.length <= 8)
        return '*'.repeat(secret.length);
    const prefix = secret.slice(0, 4);
    const suffix = secret.slice(-4);
    return `${prefix}***${suffix}`;
}
function severityBreakdown(matches) {
    const b = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const m of matches)
        b[m.severity]++;
    return b;
}
function totalRiskScore(matches) {
    return matches.reduce((s, m) => s + severityWeight(m.severity), 0);
}
function riskLevel(score) {
    if (score === 0)
        return 'None';
    if (score <= 5)
        return 'Low';
    if (score <= 15)
        return 'Medium';
    if (score <= 30)
        return 'High';
    return 'Critical';
}
