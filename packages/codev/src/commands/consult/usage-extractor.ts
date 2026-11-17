/**
 * Usage extraction from structured model output
 *
 * Extracts token counts, cost, and review text from the claude lane's result event.
 *
 * - Claude: usage comes from the final `result` event of the `claude` CLI's stream-json output
 *   (total_cost_usd + usage).
 * - Codex: usage and review text are captured directly from SDK events in
 *   runCodexConsultation() — no parsing here.
 * - gemini (Antigravity `agy`) and hermes: CLI lanes that emit plain text with
 *   no token-usage data. Usage degrades gracefully to null (no cost row); the
 *   review IS the plain-text output (no extraction needed). See spec 778.
 */

export interface UsageData {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

// The fields of the `claude` CLI's stream-json `result` event that usage extraction reads.
export interface ClaudeResultLike {
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

function extractClaudeUsage(result: ClaudeResultLike): UsageData {
  const usage = result.usage;
  return {
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.cache_read_input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    costUsd: result.total_cost_usd ?? null,
  };
}

/**
 * Extract token counts and cost from structured model output.
 * Returns null when no token data is available (e.g. the plain-text CLI lanes),
 * so cost rows degrade gracefully rather than throwing.
 */
export function extractUsage(model: string, output: string, claudeResult?: ClaudeResultLike): UsageData | null {
  try {
    if (model === 'claude' && claudeResult) {
      return extractClaudeUsage(claudeResult);
    }
    // codex → captured from SDK events; gemini (agy) / hermes → plain text, no usage.
    return null;
  } catch (err) {
    console.error(`[warn] Failed to extract usage for ${model}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Extract plain-text review content from structured model output.
 * Claude/Codex capture text from their event streams; the gemini (agy) and hermes
 * CLI lanes emit plain text that the caller uses as-is. Returns null so callers
 * fall back to the raw output.
 */
export function extractReviewText(model: string, output: string): string | null {
  void model;
  void output;
  return null;
}
