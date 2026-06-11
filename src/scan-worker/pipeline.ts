// src/scan-worker/pipeline.ts
// Blueprint for the LangGraph-based AI Verification and Validation Pipeline

import { StateGraph, Annotation } from "@langchain/langgraph";

// Define the state schema for the scanning workflow
export const ScanFindingState = Annotation.Root({
  findingId: Annotation<string>(),
  repoName: Annotation<string>(),
  filePath: Annotation<string>(),
  lineNumber: Annotation<number>(),
  matchedText: Annotation<string>(),
  lineContent: Annotation<string>(), // The matching line of code
  surroundingContext: Annotation<string>(), // Surrounding 5 lines above/below
  patternId: Annotation<string>(),
  templateId: Annotation<string>(),
  severity: Annotation<'info' | 'low' | 'medium' | 'high' | 'critical'>(),
  isHeuristicPlaceholder: Annotation<boolean>(),
  validationStatus: Annotation<'ACTIVE' | 'REVOKED' | 'UNVERIFIABLE' | 'FALSE_POSITIVE'>(),
  aiClassification: Annotation<'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'SUSPICIOUS'>(),
  aiReasoning: Annotation<string>(),
  confidenceScore: Annotation<number>(),
});

type StateType = typeof ScanFindingState.State;

// Interface for Cloudflare Worker Environment bindings
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  AI: any; // Cloudflare Workers AI Binding
}

/**
 * 1. Context Gatherer Node
 * Extracts the matched token, imports, file extension, and context.
 */
async function gatherContextNode(state: StateType): Promise<Partial<StateType>> {
  console.log(`[LangGraph] Gathering context for pattern ${state.patternId} in ${state.filePath}`);
  
  // In a real execution, we would load the file content and slice lines around state.lineNumber
  // For the blueprint, we assume context is pre-loaded or retrieved here.
  return {
    surroundingContext: state.surroundingContext || "// Context not loaded",
    isHeuristicPlaceholder: false
  };
}

/**
 * 2. Heuristic Filter Node
 * Screens out generic tokens or placeholders (e.g. YOUR_API_KEY, ghp_XXXX)
 */
async function heuristicFilterNode(state: StateType): Promise<Partial<StateType>> {
  const text = state.matchedText.toLowerCase();
  
  // Common mock/placeholder terms
  const placeholders = ["placeholder", "example", "your_key", "xxxx", "test_key", "dummy"];
  const isPlaceholder = placeholders.some(p => text.includes(p)) || 
                        /^[a-f0-9]{32}$/i.test(state.matchedText) && new Set(text).size <= 4; // repeating chars

  if (isPlaceholder) {
    console.log("[LangGraph] Finding flagged as placeholder by heuristics.");
    return {
      isHeuristicPlaceholder: true,
      validationStatus: "FALSE_POSITIVE",
      aiClassification: "FALSE_POSITIVE",
      aiReasoning: "Matched heuristics for a placeholder or mock value.",
      confidenceScore: 1.0
    };
  }

  return { isHeuristicPlaceholder: false };
}

/**
 * 3. External API Validator Node (using fetch / curl-like checks)
 * Validates active credentials securely by sending actual requests.
 */
async function apiValidationNode(state: StateType, env: Env): Promise<Partial<StateType>> {
  if (state.validationStatus === "FALSE_POSITIVE") return {};

  const token = state.matchedText;
  
  // Check pattern IDs to determine which active validation to run
  if (state.patternId.includes("github-pat")) {
    try {
      // Perform curl-like fetch test against GitHub endpoint
      const res = await fetch("https://api.github.com/user", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "RepoScout-Validator/1.0"
        }
      });
      
      if (res.status === 200) {
        return { validationStatus: "ACTIVE", aiClassification: "TRUE_POSITIVE" };
      } else if (res.status === 401) {
        return { validationStatus: "REVOKED", aiClassification: "FALSE_POSITIVE" };
      }
    } catch (err) {
      console.warn("[LangGraph] GitHub API test failed to connect: ", err);
    }
  }

  if (state.patternId.includes("stripe-key")) {
    try {
      const res = await fetch("https://api.stripe.com/v1/charges", {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      // Stripe returns 401 for bad keys and 200/400 for valid ones depending on params
      if (res.status !== 401) {
        return { validationStatus: "ACTIVE", aiClassification: "TRUE_POSITIVE" };
      } else {
        return { validationStatus: "REVOKED", aiClassification: "FALSE_POSITIVE" };
      }
    } catch (err) {
      console.warn("[LangGraph] Stripe API test failed: ", err);
    }
  }

  // Fallback: If no API matches or verification was inconclusive
  return { validationStatus: "UNVERIFIABLE" };
}

/**
 * 4. LLM Classifier Node (Cloudflare Workers AI)
 * Invokes Llama-3.1-8b-instruct to analyze finding context
 */
async function llmClassificationNode(state: StateType, env: Env): Promise<Partial<StateType>> {
  // If already verified active/revoked, skip LLM inference to save tokens
  if (state.validationStatus === "ACTIVE" || state.validationStatus === "REVOKED") {
    return {
      aiClassification: state.validationStatus === "ACTIVE" ? "TRUE_POSITIVE" : "FALSE_POSITIVE",
      aiReasoning: `Verified via active API connection test. Status: ${state.validationStatus}`,
      confidenceScore: 1.0
    };
  }

  const prompt = `
  You are an expert security auditor. Analyze the following code finding to determine if it is a TRUE POSITIVE (actual exposed credential or dangerous pattern) or a FALSE POSITIVE (test key, mock data, documentation example, or unrelated string).

  REPOSITORY: ${state.repoName}
  FILE PATH: ${state.filePath}
  LINE NUMBER: ${state.lineNumber}
  MATCHED TEXT: ${state.matchedText}
  RULE ID: ${state.patternId}
  SURROUNDING CODE CONTEXT:
  \`\`\`
  ${state.surroundingContext}
  \`\`\`

  Output your response in strict JSON format:
  {
    "classification": "TRUE_POSITIVE" | "FALSE_POSITIVE" | "SUSPICIOUS",
    "reasoning": "A concise explanation of why this is or is not a vulnerability, referencing imports, context clues, or code structure.",
    "confidence": 0.0 to 1.0
  }
  `;

  try {
    // Run LLM inference via Cloudflare Workers AI
    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "You are a JSON-only response assistant." },
        { role: "user", content: prompt }
      ]
    });

    const result = JSON.parse(response.response || response.text);
    return {
      aiClassification: result.classification,
      aiReasoning: result.reasoning,
      confidenceScore: result.confidence
    };
  } catch (err) {
    console.error("[LangGraph] Cloudflare Workers AI call failed:", err);
    return {
      aiClassification: "SUSPICIOUS",
      aiReasoning: "Failed to evaluate via LLM. Flagged for manual review.",
      confidenceScore: 0.5
    };
  }
}

/**
 * 5. Risk Scorer Node
 * Calculates final score adjustments based on the severity and AI findings
 */
async function riskScorerNode(state: StateType): Promise<Partial<StateType>> {
  // Score calculations will be handled here to update state logs
  console.log(`[LangGraph] Scoring finished for ${state.findingId}. Result: ${state.aiClassification}`);
  return {};
}

// Compile nodes into the LangGraph workflow
export function createScanValidationGraph(env: Env) {
  const workflow = new StateGraph(ScanFindingState)
    .addNode("gatherContext", gatherContextNode)
    .addNode("heuristicFilter", heuristicFilterNode)
    .addNode("apiValidation", (state) => apiValidationNode(state, env))
    .addNode("llmClassification", (state) => llmClassificationNode(state, env))
    .addNode("riskScorer", riskScorerNode)
    
    // Define edges
    .addEdge("__start__", "gatherContext")
    .addEdge("gatherContext", "heuristicFilter")
    .addEdge("heuristicFilter", "apiValidation")
    .addEdge("apiValidation", "llmClassification")
    .addEdge("llmClassification", "riskScorer")
    .addEdge("riskScorer", "__end__");

  return workflow.compile();
}
