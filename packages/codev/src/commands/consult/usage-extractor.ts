/**
 * Usage extraction from structured model output
 *
 * Extracts token counts, cost, and review text from Claude SDK results.
 * All parsing is wrapped in try/catch — returns null on failure, never throws.
 *
 * Codex usage and review text are captured directly from SDK events in
 * runCodexConsultation() — no JSONL parsing needed.
 *
 * Gemini: Since --output-format json was removed (Spec 325), Gemini outputs
 * plain text. Usage extraction returns null; review text is the raw output.
 */

export interface UsageData {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

// Minimal type for the SDK result fields we need — avoids importing the full SDK type
export interface SDKResultLike {
  type: 'result';
  subtype: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function extractClaudeUsage(sdkResult: SDKResultLike): UsageData {
  const usage = sdkResult.usage;
  return {
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.cache_read_input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    costUsd: sdkResult.total_cost_usd ?? null,
  };
}

/**
 * Extract token counts and cost from structured model output.
 * Returns null if extraction fails entirely (logs warning to stderr).
 */
export function extractUsage(model: string, _output: string, sdkResult?: SDKResultLike): UsageData | null {
  try {
    if (model === 'claude' && sdkResult) {
      return extractClaudeUsage(sdkResult);
    }
    // Gemini: --output-format json removed (Spec 325), no structured usage data available
    // Codex: usage is captured directly from SDK events in runCodexConsultation()
    return null;
  } catch (err) {
    console.error(`[warn] Failed to extract usage for ${model}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Extract plain-text review content from structured model output.
 * Returns null if extraction fails (caller should fall back to raw output).
 */
export function extractReviewText(model: string, _output: string): string | null {
  // Gemini: outputs plain text directly (--output-format json removed in Spec 325)
  // Claude and Codex: text is captured directly by their SDK streaming loops
  // All models: return null so caller uses raw output as-is
  return null;
}
