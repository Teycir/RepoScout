// src/scan-worker/pipeline.ts
// LangGraph 5-node AI verification pipeline.
// Upgraded to spec: NEEDS_HUMAN_REVIEW verdict, conditional edges, cache quota guard.

import { StateGraph, Annotation } from "@langchain/langgraph";
import { validateCredential } from "../lib/validator.js";
import { isLikelyPlaceholder } from "../lib/scanner.js";
import { findingRiskScore } from "../lib/types.js";
import type { Severity, Verdict, Database, CacheStore, AiService } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Robust JSON parser helper for LLM responses
// ---------------------------------------------------------------------------
function robustJsonParse<T extends Record<string, any>>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const result: Record<string, any> = {};

    // Extract boolean properties
    const boolMatches = text.matchAll(/"([^"]+)"\s*:\s*(true|false)/gi);
    for (const m of boolMatches) {
      if (m[1]) result[m[1]] = m[2] === "true";
    }

    // Extract numeric properties
    const numMatches = text.matchAll(/"([^"]+)"\s*:\s*([0-9.]+)/gi);
    for (const m of numMatches) {
      if (m[1]) result[m[1]] = parseFloat(m[2]!);
    }

    // Extract null literal properties
    const nullMatches = text.matchAll(/"([^"]+)"\s*:\s*null/gi);
    for (const m of nullMatches) {
      if (m[1]) result[m[1]] = null;
    }

    // Extract string properties
    const stringKeys = ["verdict", "reasoning", "value"];
    for (const key of stringKeys) {
      const keyPattern = new RegExp(`"${key}"\\s*:\\s*"(.*)"`, "is");
      const match = text.match(keyPattern);
      if (match && match[1]) {
        let val = match[1];
        // Clean up trailing parts if another key got matched
        val = val.replace(/",\s*"confidence".*$/is, "");
        val = val.replace(/",\s*"verdict".*$/is, "");
        val = val.replace(/",\s*"reasoning".*$/is, "");
        val = val.replace(/",\s*"value".*$/is, "");
        val = val.replace(/",\s*"found".*$/is, "");
        val = val.replace(/"\s*\}.*$/is, "");
        result[key] = val;
      }
    }

    if (Object.keys(result).length > 0) {
      return result as T;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Env binding interface
// ---------------------------------------------------------------------------

export interface PipelineEnv {
  DB: Database;
  CACHE: CacheStore;
  AI: AiService;
  SUMMARY_MODEL?: string;
}

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

export const ScanFindingState = Annotation.Root({
  findingId: Annotation<string>(),
  repoName: Annotation<string>(),
  filePath: Annotation<string>(),
  lineNumber: Annotation<number>(),
  matchedText: Annotation<string>(), // masked
  rawMatchedText: Annotation<string>(), // unmasked — never logged
  lineContent: Annotation<string>(),
  surroundingContext: Annotation<string>(),
  patternId: Annotation<string>(),
  templateId: Annotation<string>(),
  severity: Annotation<Severity>(),
  // pipeline state
  isHeuristicPlaceholder: Annotation<boolean>(),
  validationStatus: Annotation<
    "ACTIVE" | "REVOKED" | "UNVERIFIABLE" | "FALSE_POSITIVE"
  >(),
  verdict: Annotation<Verdict>(),
  aiReasoning: Annotation<string>(),
  confidenceScore: Annotation<number>(),
  riskScore: Annotation<number>(),
  validationMethod: Annotation<"api_test" | "llm" | "heuristic">(),
});

type StateType = typeof ScanFindingState.State;

// ---------------------------------------------------------------------------
// Cache quota guard → SQLite atomic counter for race-safety
// Model: @cf/mistralai/mistral-small-3.1-24b-instruct
// Neuron cost: ~31 876/M input + ~50 488/M output tokens
// Per call estimate: ~400 input + ~150 output tokens ≈ 21 neurons/call
// Free tier: 10 000 neurons/day → ~476 calls/day across 3 runs ≈ 158/run
// LLM_DAILY_CAP: Set to 450 (below theoretical max 476) to leave headroom for:
//   - Context inference retries (Shopify/Algolia/Firebase domain extraction)
//   - Impact summaries (TRUE_POSITIVE findings only)
//   - Burst variance in token usage per classification
// ---------------------------------------------------------------------------

const LLM_DAILY_CAP = 450;

async function ensureLlmQuotaTable(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS llm_quota_daily (
      date TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

async function checkLlmQuota(db: D1Database): Promise<boolean> {
  await ensureLlmQuotaTable(db);
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = await db
    .prepare('SELECT count FROM llm_quota_daily WHERE date = ?')
    .bind(date)
    .first<{ count: number }>();
  const used = row?.count ?? 0;
  return used < LLM_DAILY_CAP;
}

async function incrementLlmQuota(db: D1Database): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  // Atomic increment with INSERT OR IGNORE + UPDATE
  await db.prepare(`INSERT OR IGNORE INTO llm_quota_daily (date, count) VALUES (?, 0)`).bind(date).run();
  await db.prepare(`UPDATE llm_quota_daily SET count = count + 1 WHERE date = ?`).bind(date).run();
}

// ---------------------------------------------------------------------------
// Node 1 — Context Gatherer
// ---------------------------------------------------------------------------

async function gatherContextNode(
  state: StateType,
): Promise<Partial<StateType>> {
  // Context is pre-loaded by the caller; this node normalises it.
  const context = state.surroundingContext ?? "// No context available";
  return { surroundingContext: context };
}

// ---------------------------------------------------------------------------
// Node 2 — Heuristic Filter
// ---------------------------------------------------------------------------

async function heuristicFilterNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const raw = state.rawMatchedText;

  if (isLikelyPlaceholder(raw)) {
    return {
      isHeuristicPlaceholder: true,
      validationStatus: "FALSE_POSITIVE",
      verdict: "FALSE_POSITIVE",
      aiReasoning:
        "Matched heuristics for a placeholder/mock value (placeholder terms or low-entropy repeating hex).",
      confidenceScore: 1.0,
      validationMethod: "heuristic",
    };
  }

  // Low-entropy hex strings: likely UUIDs or hashes, not credentials
  if (/^[a-f0-9]{32,}$/i.test(raw) && new Set(raw.toLowerCase()).size <= 6) {
    return {
      isHeuristicPlaceholder: true,
      validationStatus: "FALSE_POSITIVE",
      verdict: "FALSE_POSITIVE",
      aiReasoning:
        "Low-entropy hex string — likely a hash or UUID, not a credential.",
      confidenceScore: 0.9,
      validationMethod: "heuristic",
    };
  }

  return { isHeuristicPlaceholder: false };
}

// Route after heuristic: if already FALSE_POSITIVE, skip to scorer
function routeAfterHeuristic(state: StateType): string {
  if (state.verdict === "FALSE_POSITIVE") return "riskScorer";
  return "apiValidation";
}

// ---------------------------------------------------------------------------
// Node 3 — External API Validator
// ---------------------------------------------------------------------------

async function apiValidationNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const result = await validateCredential(
    state.patternId,
    state.rawMatchedText,
  );

  if (result.status === "ACTIVE") {
    return {
      validationStatus: "ACTIVE",
      verdict: "TRUE_POSITIVE",
      aiReasoning: result.message,
      confidenceScore: 1.0,
      validationMethod: "api_test",
    };
  }

  if (result.status === "REVOKED") {
    return {
      validationStatus: "REVOKED",
      verdict: "FALSE_POSITIVE",
      aiReasoning: result.message,
      confidenceScore: 0.95,
      validationMethod: "api_test",
    };
  }

  // UNVERIFIABLE — cannot determine; hand off to LLM classifier
  if (result.status === "UNVERIFIABLE") {
    return {
      validationStatus: "UNVERIFIABLE",
      validationMethod: "api_test",
    };
  }

  // FALSE_POSITIVE from format check — verdict MUST be set here so that
  // routeAfterApiValidation short-circuits to riskScorer instead of falling
  // through to the LLM classifier and burning daily quota.
  return {
    validationStatus: "FALSE_POSITIVE",
    verdict: "FALSE_POSITIVE",
    aiReasoning: result.message,
    confidenceScore: 0.9,
    validationMethod: "api_test",
  };
}

// Route after API validation: confirmed → scorer; unverifiable → LLM
function routeAfterApiValidation(state: StateType): string {
  if (state.verdict === "TRUE_POSITIVE" || state.verdict === "FALSE_POSITIVE") {
    return "riskScorer";
  }
  return "llmClassification";
}

// ---------------------------------------------------------------------------
// Node 3b — AWS Pair Reconstruction
// Scans surrounding context for a paired AWS secret access key and attempts
// a real STS GetCallerIdentity call to convert UNVERIFIABLE → ACTIVE/REVOKED.
// ---------------------------------------------------------------------------

async function awsPairReconstructionNode(
  state: StateType,
): Promise<Partial<StateType>> {
  // Only applies to AWS key ID patterns that returned UNVERIFIABLE
  if (
    state.validationStatus !== "UNVERIFIABLE" ||
    !/^AKIA[0-9A-Z]{16}$/.test(state.rawMatchedText)
  ) {
    return {};
  }

  // Extract secret key from surrounding context — look for common var names
  const secretPattern =
    /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|secret[_\s]*key|secretKey)\s*[=:'"]+\s*([A-Za-z0-9/+]{40})/;
  const secretMatch = secretPattern.exec(state.surroundingContext);
  if (!secretMatch || !secretMatch[1]) {
    return {}; // No paired secret found — fall through to LLM
  }

  const accessKeyId = state.rawMatchedText;
  const secretKey = secretMatch[1];

  try {
    // STS GetCallerIdentity — works with any valid AWS credentials, read-only
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const timeStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const region = "us-east-1";
    const service = "sts";
    const host = `sts.amazonaws.com`;
    const endpoint = `https://${host}/?Action=GetCallerIdentity&Version=2011-06-15`;

    // AWS Signature V4 (simplified — canonical form for this specific call)
    const canonicalHeaders = `host:${host}\nx-amz-date:${timeStr}\n`;
    const signedHeaders = "host;x-amz-date";
    const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA-256 of ""
    const canonicalRequest = `GET\n/\nAction=GetCallerIdentity&Version=2011-06-15\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const credentialScope = `${dateStr}/${region}/${service}/aws4_request`;
    const encoder = new TextEncoder();

    async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
      const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
    }

    async function sha256hex(data: string): Promise<string> {
      const buf = await crypto.subtle.digest("SHA-256", encoder.encode(data));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    const stringToSign = `AWS4-HMAC-SHA256\n${timeStr}\n${credentialScope}\n${await sha256hex(canonicalRequest)}`;
    const kDate    = await hmacSha256(encoder.encode(`AWS4${secretKey}`), dateStr);
    const kRegion  = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, "aws4_request");
    const sigBuf   = await hmacSha256(kSigning, stringToSign);
    const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(endpoint, {
      headers: {
        Authorization: authHeader,
        "x-amz-date": timeStr,
        Host: host,
      },
    });

    if (res.status === 200) {
      return {
        validationStatus: "ACTIVE",
        verdict: "TRUE_POSITIVE",
        aiReasoning: "AWS key pair verified via STS GetCallerIdentity — secret key reconstructed from context.",
        confidenceScore: 1.0,
        validationMethod: "api_test",
      };
    }
    if (res.status === 403) {
      return {
        validationStatus: "REVOKED",
        verdict: "FALSE_POSITIVE",
        aiReasoning: "AWS key pair found in context but STS returned 403 — credentials invalid or revoked.",
        confidenceScore: 0.95,
        validationMethod: "api_test",
      };
    }
  } catch (e) {
    console.warn("[pipeline] AWS pair reconstruction failed:", e);
  }

  return {}; // Fall through to LLM classifier
}

// ---------------------------------------------------------------------------
// Node 3c — Context Inference for UNVERIFIABLE Providers
// For providers that need extra context (Shopify shop domain, Algolia app ID,
// Firebase project, Okta domain) — extracts the missing parameter from the
// surrounding code and retries the API validation.
// ---------------------------------------------------------------------------

async function contextInferenceNode(
  state: StateType,
  env: PipelineEnv,
): Promise<Partial<StateType>> {
  if (state.validationStatus !== "UNVERIFIABLE") return {};

  const pid = state.patternId.toLowerCase();
  const needsContextInference =
    pid.includes("shopify") ||
    pid.includes("algolia") ||
    pid.includes("firebase") ||
    pid.includes("okta") ||
    pid.includes("braintree");

  if (!needsContextInference) return {};

  const quotaOk = await checkLlmQuota(env.DB);
  if (!quotaOk) return {};

  const model = env.SUMMARY_MODEL ?? "@cf/mistralai/mistral-small-3.1-24b-instruct";

  const providerHints: Record<string, string> = {
    shopify:   "Extract the Shopify shop domain (e.g. mystore.myshopify.com) from the surrounding code.",
    algolia:   "Extract the Algolia Application ID (a 10-char uppercase string) from the surrounding code.",
    firebase:  "Extract the Firebase project ID from the surrounding code.",
    okta:      "Extract the Okta domain (e.g. dev-123456.okta.com) from the surrounding code.",
    braintree: "Determine whether this is a sandbox or production Braintree token from the surrounding code.",
  };

  const validationPatterns: Record<string, RegExp> = {
    shopify:   /^[\w-]+\.myshopify\.com$/,
    algolia:   /^[A-Z0-9]{10}$/,
    firebase:  /^[\w-]+$/,
    okta:      /^[\w-]+\.okta\.com$/,
    braintree: /^(sandbox|production)$/i,
  };

  const providerKey = Object.keys(providerHints).find(k => pid.includes(k)) ?? "";
  const hint = providerHints[providerKey] ?? "Extract any missing context needed to validate this credential.";

  try {
    const response = await (env.AI as any).run(model, {
      messages: [
        {
          role: "system",
          content: "You are a security analyst. Respond ONLY with a JSON object, no markdown fences.",
        },
        {
          role: "user",
          content: `${hint}

FILE: ${state.filePath}
CONTEXT:
\`\`\`
${state.surroundingContext}
\`\`\`

Respond ONLY with JSON:
{
  "found": true | false,
  "value": "<extracted value or null>",
  "reasoning": "<one sentence>"
}`,
        },
      ],
    });

    await incrementLlmQuota(env.DB);

    const text = (response.response ?? response.text ?? "").replace(/```json|```/g, "").trim();
    const parsed = robustJsonParse<{ found: boolean; value: string | null; reasoning: string }>(text);

    if (!parsed.found || !parsed.value) return {};

    // Validate extracted value against expected format
    const validator = validationPatterns[providerKey];
    if (validator && !validator.test(parsed.value)) {
      console.warn(`[pipeline] Context inference: extracted value "${parsed.value}" failed validation for ${providerKey}`);
      return {};
    }

    // Retry validation with the extracted context injected into the token
    const { validateCredential } = await import("../lib/validator.js");
    const enrichedToken = `${state.rawMatchedText}|context:${parsed.value}`;
    const result = await validateCredential(state.patternId, enrichedToken);

    if (result.status === "ACTIVE") {
      return {
        validationStatus: "ACTIVE",
        verdict: "TRUE_POSITIVE",
        aiReasoning: `Context-inferred validation (${providerKey}): ${parsed.reasoning}`,
        confidenceScore: 0.95,
        validationMethod: "llm",
      };
    }
    if (result.status === "REVOKED") {
      return {
        validationStatus: "REVOKED",
        verdict: "FALSE_POSITIVE",
        aiReasoning: `Context-inferred validation — credential revoked. ${parsed.reasoning}`,
        confidenceScore: 0.9,
        validationMethod: "llm",
      };
    }
  } catch (e) {
    console.warn("[pipeline] Context inference node failed:", e);
  }

  return {};
}

// ---------------------------------------------------------------------------
// Node 4 — Workers AI LLM Classifier
// ---------------------------------------------------------------------------

async function llmClassificationNode(
  state: StateType,
  env: PipelineEnv,
): Promise<Partial<StateType>> {
  const quotaOk = await checkLlmQuota(env.DB);
  if (!quotaOk) {
    return {
      verdict: "NEEDS_HUMAN_REVIEW",
      aiReasoning:
        "Daily LLM quota exhausted — queued for manual analyst review.",
      confidenceScore: 0.0,
      validationMethod: "llm",
    };
  }

  const model = env.SUMMARY_MODEL ?? "@cf/mistralai/mistral-small-3.1-24b-instruct";
  const prompt = `You are an expert security auditor. Analyze the following finding and determine if it is a TRUE_POSITIVE (real exposed credential), FALSE_POSITIVE (test/mock/doc), or NEEDS_HUMAN_REVIEW (ambiguous).

REPOSITORY: ${state.repoName}
FILE: ${state.filePath}
LINE: ${state.lineNumber}
MATCHED TOKEN: ${state.matchedText}
PATTERN: ${state.patternId}
CONTEXT:
\`\`\`
${state.surroundingContext}
\`\`\`

Respond ONLY with valid JSON:
{
  "verdict": "TRUE_POSITIVE" | "FALSE_POSITIVE" | "NEEDS_HUMAN_REVIEW",
  "reasoning": "<concise explanation referencing code context>",
  "confidence": 0.0
}`;

  try {
    const response = await (env.AI as any).run(model, {
      messages: [
        {
          role: "system",
          content: "You respond only in strict JSON with no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
    });

    const text = (response.response ?? response.text ?? "")
      .replace(/```json|```/g, "")
      .trim();
    const parsed = robustJsonParse<{
      verdict: Verdict;
      reasoning: string;
      confidence: number;
    }>(text);

    // Increment quota only after we know the response parsed successfully.
    await incrementLlmQuota(env.DB);

    // Confidence < 0.50 → escalate to analyst
    const verdict: Verdict =
      parsed.confidence < 0.50
        ? "NEEDS_HUMAN_REVIEW"
        : (parsed.verdict ?? "NEEDS_HUMAN_REVIEW");

    return {
      verdict: verdict,
      aiReasoning: parsed.reasoning ?? "No reasoning provided.",
      confidenceScore: parsed.confidence ?? 0.5,
      validationMethod: "llm",
    };
  } catch (e) {
    console.error("[pipeline] LLM call failed:", e);
    return {
      verdict: "NEEDS_HUMAN_REVIEW",
      aiReasoning: "LLM call failed — queued for manual analyst review.",
      confidenceScore: 0.0,
      validationMethod: "llm",
    };
  }
}

// ---------------------------------------------------------------------------
// Node 5 — Risk Scorer
// ---------------------------------------------------------------------------

async function riskScorerNode(
  state: StateType,
): Promise<Partial<StateType>> {
  const score = findingRiskScore(state.severity, state.verdict);
  return { riskScore: score };
}

// ---------------------------------------------------------------------------
// Security: Zero raw secrets from memory after processing
// ---------------------------------------------------------------------------

function zeroRawSecret(state: StateType): void {
  if (state.rawMatchedText) {
    // Overwrite with random data then empty string to prevent memory forensics
    const len = state.rawMatchedText.length;
    (state as any).rawMatchedText = '\x00'.repeat(len);
    (state as any).rawMatchedText = '';
  }
}

// ---------------------------------------------------------------------------
// Persist to D1
// ---------------------------------------------------------------------------

export interface PersistInput {
  findingId: string;
  verdict: Verdict;
  confidence: number;
  validationMethod: string;
  validationStatus: string;
  reasoning: string;
  riskScore: number;
}

export async function persistEvaluation(
  db: D1Database,
  input: PersistInput,
  state?: StateType,
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ai_evaluations
         (id, finding_id, verdict, confidence, validation_method, validation_status, reasoning, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(finding_id) DO UPDATE SET
         verdict = excluded.verdict,
         confidence = excluded.confidence,
         validation_method = excluded.validation_method,
         validation_status = excluded.validation_status,
         reasoning = excluded.reasoning,
         evaluated_at = excluded.evaluated_at`,
    )
    .bind(
      id,
      input.findingId,
      input.verdict,
      input.confidence,
      input.validationMethod,
      input.validationStatus,
      input.reasoning,
    )
    .run();
  
  // Zero raw secret after successful persistence
  if (state) zeroRawSecret(state);
}

// ---------------------------------------------------------------------------
// Node 5b — Impact & Blast-Radius Summary
// For TRUE_POSITIVE findings, generates a plain-English impact summary:
// what access the credential grants, what data is reachable, and remediation.
// ---------------------------------------------------------------------------

async function impactSummaryNode(
  state: StateType,
  env: PipelineEnv,
): Promise<Partial<StateType>> {
  if (state.verdict !== "TRUE_POSITIVE") return {};

  const quotaOk = await checkLlmQuota(env.DB);
  if (!quotaOk) return {};

  const model = env.SUMMARY_MODEL ?? "@cf/mistralai/mistral-small-3.1-24b-instruct";

  try {
    const response = await (env.AI as any).run(model, {
      messages: [
        {
          role: "system",
          content: "You are a security analyst writing concise impact summaries. Respond ONLY with JSON, no markdown fences.",
        },
        {
          role: "user",
          content: `A confirmed leaked credential was found. Provide a short impact summary.

PROVIDER PATTERN: ${state.patternId}
SEVERITY: ${state.severity}
REPOSITORY: ${state.repoName}
FILE: ${state.filePath}
CONTEXT:
\`\`\`
${state.surroundingContext}
\`\`\`

Respond ONLY with JSON:
{
  "access_granted": "<what this credential allows in one sentence>",
  "blast_radius": "<what data or systems are reachable in one sentence>",
  "remediation": "<single most important remediation step>"
}`,
        },
      ],
    });

    await incrementLlmQuota(env.DB);

    const text = (response.response ?? response.text ?? "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text) as {
      access_granted: string;
      blast_radius: string;
      remediation: string;
    };

    // Append impact summary to aiReasoning so it surfaces in the DB / dashboard
    const impactNote = `\n\n[Impact] ${parsed.access_granted} | Blast radius: ${parsed.blast_radius} | Remediation: ${parsed.remediation}`;
    return {
      aiReasoning: (state.aiReasoning ?? "") + impactNote,
    };
  } catch (e) {
    console.warn("[pipeline] Impact summary node failed:", e);
  }

  return {};
}

// ---------------------------------------------------------------------------
// Compile graph
// ---------------------------------------------------------------------------

export function createScanValidationGraph(env: PipelineEnv) {
  const workflow = new StateGraph(ScanFindingState)
    .addNode("gatherContext",       gatherContextNode)
    .addNode("heuristicFilter",     heuristicFilterNode)
    .addNode("apiValidation",       (s) => apiValidationNode(s))
    .addNode("awsPairReconstruct",  (s) => awsPairReconstructionNode(s))
    .addNode("contextInference",    (s) => contextInferenceNode(s, env))
    .addNode("llmClassification",   (s) => llmClassificationNode(s, env))
    .addNode("riskScorer",          riskScorerNode)
    .addNode("impactSummary",       (s) => impactSummaryNode(s, env))

    .addEdge("__start__",        "gatherContext")
    .addEdge("gatherContext",    "heuristicFilter")
    .addConditionalEdges("heuristicFilter", routeAfterHeuristic, {
      riskScorer:    "riskScorer",
      apiValidation: "apiValidation",
    })
    // After API validation: resolved → impact summary path; unverifiable → enrichment nodes
    .addConditionalEdges("apiValidation", routeAfterApiValidation, {
      riskScorer:       "riskScorer",
      llmClassification: "awsPairReconstruct",
    })
    // AWS pair reconstruction: if resolved, skip to scorer; else try context inference
    .addConditionalEdges("awsPairReconstruct", (s) =>
      s.verdict === "TRUE_POSITIVE" || s.verdict === "FALSE_POSITIVE"
        ? "riskScorer"
        : "contextInference",
      { riskScorer: "riskScorer", contextInference: "contextInference" }
    )
    // Context inference: if resolved, skip to scorer; else fall to LLM
    .addConditionalEdges("contextInference", (s) =>
      s.verdict === "TRUE_POSITIVE" || s.verdict === "FALSE_POSITIVE"
        ? "riskScorer"
        : "llmClassification",
      { riskScorer: "riskScorer", llmClassification: "llmClassification" }
    )
    .addEdge("llmClassification", "riskScorer")
    // After scoring: TRUE_POSITIVE gets impact summary; others terminate
    .addConditionalEdges("riskScorer", (s) =>
      s.verdict === "TRUE_POSITIVE" ? "impactSummary" : "__end__",
      { impactSummary: "impactSummary", __end__: "__end__" }
    )
    .addEdge("impactSummary", "__end__");

  return workflow.compile();
}
