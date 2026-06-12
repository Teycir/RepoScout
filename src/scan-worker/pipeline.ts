// src/scan-worker/pipeline.ts
// LangGraph 5-node AI verification pipeline.
// Upgraded to spec: NEEDS_HUMAN_REVIEW verdict, conditional edges, KV quota guard.

import { StateGraph, Annotation } from "@langchain/langgraph";
import { validateCredential } from "../lib/validator.js";
import { isLikelyPlaceholder } from "../lib/scanner.js";
import { findingRiskScore } from "../lib/types.js";
import type { Severity, Verdict } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Env binding interface
// ---------------------------------------------------------------------------

export interface PipelineEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  AI: Ai;
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
// KV quota guard — mirrors ArxivExplorer llm_quota:{date} pattern
// Cap: 263 LLM calls/day on Workers AI free tier
// ---------------------------------------------------------------------------

const LLM_DAILY_CAP = 263;

async function checkLlmQuota(cache: KVNamespace): Promise<boolean> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `llm_quota:${date}`;
  const raw = await cache.get(key);
  const used = raw ? parseInt(raw, 10) : 0;
  return used < LLM_DAILY_CAP;
}

async function incrementLlmQuota(cache: KVNamespace): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `llm_quota:${date}`;
  const raw = await cache.get(key);
  const next = (raw ? parseInt(raw, 10) : 0) + 1;
  // TTL = 26 hours to ensure cleanup
  await cache.put(key, String(next), { expirationTtl: 26 * 60 * 60 });
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
// Node 4 — Workers AI LLM Classifier
// ---------------------------------------------------------------------------

async function llmClassificationNode(
  state: StateType,
  env: PipelineEnv,
): Promise<Partial<StateType>> {
  const quotaOk = await checkLlmQuota(env.CACHE);
  if (!quotaOk) {
    return {
      verdict: "NEEDS_HUMAN_REVIEW",
      aiReasoning:
        "Daily LLM quota exhausted — queued for manual analyst review.",
      confidenceScore: 0.0,
      validationMethod: "llm",
    };
  }

  const model = env.SUMMARY_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
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
    const parsed = JSON.parse(text) as {
      verdict: Verdict;
      reasoning: string;
      confidence: number;
    };

    // Increment quota only after we know the response parsed successfully.
    await incrementLlmQuota(env.CACHE);

    // Confidence < 0.65 → escalate to analyst
    const verdict: Verdict =
      parsed.confidence < 0.65
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
}

// ---------------------------------------------------------------------------
// Compile graph
// ---------------------------------------------------------------------------

export function createScanValidationGraph(env: PipelineEnv) {
  const workflow = new StateGraph(ScanFindingState)
    .addNode("gatherContext", gatherContextNode)
    .addNode("heuristicFilter", heuristicFilterNode)
    .addNode("apiValidation", (s) => apiValidationNode(s))
    .addNode("llmClassification", (s) => llmClassificationNode(s, env))
    .addNode("riskScorer", riskScorerNode)

    .addEdge("__start__", "gatherContext")
    .addEdge("gatherContext", "heuristicFilter")
    .addConditionalEdges("heuristicFilter", routeAfterHeuristic, {
      riskScorer: "riskScorer",
      apiValidation: "apiValidation",
    })
    .addConditionalEdges("apiValidation", routeAfterApiValidation, {
      riskScorer: "riskScorer",
      llmClassification: "llmClassification",
    })
    .addEdge("llmClassification", "riskScorer")
    .addEdge("riskScorer", "__end__");

  return workflow.compile();
}
