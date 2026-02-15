/**
 * Usage extraction from structured model output
 *
 * Extracts token counts, cost, and review text from Claude SDK results,
 * Gemini JSON output, and Codex JSONL output. All parsing is wrapped in
 * try/catch — returns null on failure, never throws.
 */

// Static pricing for subprocess models (Claude provides exact cost via SDK)
const SUBPROCESS_MODEL_PRICING: Record<string, {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}> = {
  codex:  { inputPer1M: 2.00, cachedInputPer1M: 1.00, outputPer1M: 8.00 },
  gemini: { inputPer1M: 1.25, cachedInputPer1M: 0.315, outputPer1M: 10.00 },
};

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

function computeCost(
  model: string,
  inputTokens: number | null,
  cachedInputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null) {
    return null;
  }

  const pricing = SUBPROCESS_MODEL_PRICING[model];
  if (!pricing) return null;

  const uncachedInput = inputTokens - cachedInputTokens;
  return (
    (uncachedInput / 1_000_000) * pricing.inputPer1M +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
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

function extractGeminiUsage(output: string): UsageData | null {
  const parsed = JSON.parse(output);
  const models = parsed?.stats?.models;
  if (!models || typeof models !== 'object') return null;

  // Take the first (and typically only) model entry
  const modelKeys = Object.keys(models);
  if (modelKeys.length === 0) return null;

  const tokens = models[modelKeys[0]]?.tokens;
  if (!tokens) return null;

  const inputTokens = typeof tokens.prompt === 'number' ? tokens.prompt : null;
  const cachedInputTokens = typeof tokens.cached === 'number' ? tokens.cached : null;
  const outputTokens = typeof tokens.candidates === 'number' ? tokens.candidates : null;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: computeCost('gemini', inputTokens, cachedInputTokens, outputTokens),
  };
}

function extractCodexUsage(output: string): UsageData | null {
  const lines = output.split('\n').filter(l => l.trim());
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let foundTurn = false;
  // Track whether any turn is missing a required field — if so, that total is unknowable
  let inputMissing = false;
  let cachedMissing = false;
  let outputMissing = false;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      // Skip non-JSON lines (e.g. progress output, debug messages)
      continue;
    }
    if (event.type === 'turn.completed') {
      foundTurn = true;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (!usage) {
        // Turn completed without usage data — all totals are unknowable
        inputMissing = true;
        cachedMissing = true;
        outputMissing = true;
        continue;
      }
      if (typeof usage.input_tokens === 'number') {
        totalInput += usage.input_tokens;
      } else {
        inputMissing = true;
      }
      if (typeof usage.cached_input_tokens === 'number') {
        totalCached += usage.cached_input_tokens;
      } else {
        cachedMissing = true;
      }
      if (typeof usage.output_tokens === 'number') {
        totalOutput += usage.output_tokens;
      } else {
        outputMissing = true;
      }
    }
  }

  if (!foundTurn) return null;

  const inputTokens = inputMissing ? null : totalInput;
  const cachedInputTokens = cachedMissing ? null : totalCached;
  const outputTokens = outputMissing ? null : totalOutput;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: computeCost('codex', inputTokens, cachedInputTokens, outputTokens),
  };
}

/**
 * Extract token counts and cost from structured model output.
 * Returns null if extraction fails entirely (logs warning to stderr).
 */
export function extractUsage(model: string, output: string, sdkResult?: SDKResultLike): UsageData | null {
  try {
    if (model === 'claude' && sdkResult) {
      return extractClaudeUsage(sdkResult);
    }
    if (model === 'gemini') {
      return extractGeminiUsage(output);
    }
    if (model === 'codex') {
      return extractCodexUsage(output);
    }
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
export function extractReviewText(model: string, output: string): string | null {
  try {
    if (model === 'gemini') {
      const parsed = JSON.parse(output);
      if (typeof parsed?.response === 'string') {
        return parsed.response;
      }
      return null;
    }

    if (model === 'codex') {
      const lines = output.split('\n').filter(l => l.trim());
      const textParts: string[] = [];

      for (const line of lines) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          // Skip non-JSON lines (e.g. progress output, debug messages)
          continue;
        }
        // Codex JSONL: two known formats
        // Format A (Agent SDK): {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
        if (event.type === 'item.completed') {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'agent_message' && typeof item.text === 'string') {
            textParts.push(item.text);
          }
        }
        // Format B (Responses API): {"type":"message","role":"assistant","content":"..."}
        if (event.type === 'message' && event.role === 'assistant') {
          if (typeof event.content === 'string') {
            textParts.push(event.content);
          } else if (Array.isArray(event.content)) {
            for (const block of event.content) {
              if (typeof block === 'string') {
                textParts.push(block);
              } else if ((block as Record<string, unknown>)?.type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
                textParts.push((block as Record<string, unknown>).text as string);
              }
            }
          }
        }
      }

      return textParts.length > 0 ? textParts.join('') : null;
    }

    // Claude uses SDK — text is already captured by the SDK streaming loop
    return null;
  } catch (err) {
    console.error(`[warn] Failed to extract review text for ${model}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
