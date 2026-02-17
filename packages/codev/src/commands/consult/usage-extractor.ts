/**
 * Usage extraction from structured model output
 *
 * Extracts token counts, cost, and review text from Claude SDK results
 * and Gemini JSON output. All parsing is wrapped in try/catch — returns
 * null on failure, never throws.
 *
 * Codex usage and review text are captured directly from SDK events in
 * runCodexConsultation() — no JSONL parsing needed.
 *
 * Gemini: Uses --output-format json to get structured output with
 * token counts in stats.models. Cost is computed from per-model pricing.
 */

// Gemini per-model pricing (USD per 1M tokens)
// Maps model name prefixes to pricing tiers.
// Longer prefixes must appear before shorter ones (e.g., flash-lite before flash).
const GEMINI_PRICING: Record<string, { inputPer1M: number; cachedInputPer1M: number; outputPer1M: number }> = {
  'gemini-3-pro':    { inputPer1M: 1.25,  cachedInputPer1M: 0.315,  outputPer1M: 5.00 },
  'gemini-2.5-pro':  { inputPer1M: 1.25,  cachedInputPer1M: 0.315,  outputPer1M: 5.00 },
  'gemini-3-flash':  { inputPer1M: 0.15,  cachedInputPer1M: 0.0375, outputPer1M: 0.60 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.075, cachedInputPer1M: 0.019, outputPer1M: 0.30 },
  'gemini-2.5-flash': { inputPer1M: 0.15, cachedInputPer1M: 0.0375, outputPer1M: 0.60 },
};
const GEMINI_DEFAULT_PRICING = { inputPer1M: 0.15, cachedInputPer1M: 0.0375, outputPer1M: 0.60 };

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

function getGeminiPricing(modelName: string): typeof GEMINI_DEFAULT_PRICING {
  for (const [prefix, pricing] of Object.entries(GEMINI_PRICING)) {
    if (modelName.startsWith(prefix)) return pricing;
  }
  return GEMINI_DEFAULT_PRICING;
}

function extractGeminiUsage(output: string): UsageData | null {
  const parsed = JSON.parse(output);
  const models = parsed?.stats?.models;
  if (!models || typeof models !== 'object') return null;

  const modelKeys = Object.keys(models);
  if (modelKeys.length === 0) return null;

  // Sum tokens and cost across all models (Gemini CLI may use multiple)
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let hasTokenData = false;

  for (const key of modelKeys) {
    const tokens = models[key]?.tokens;
    if (!tokens) continue;

    const input = typeof tokens.prompt === 'number' ? tokens.prompt : 0;
    const cached = typeof tokens.cached === 'number' ? tokens.cached : 0;
    const candidates = typeof tokens.candidates === 'number' ? tokens.candidates : 0;

    if (input > 0 || candidates > 0 || cached > 0) hasTokenData = true;

    totalInput += input;
    totalCached += cached;
    totalOutput += candidates;

    const pricing = getGeminiPricing(key);
    const uncached = Math.max(0, input - cached);
    totalCost += (uncached / 1_000_000) * pricing.inputPer1M
               + (cached / 1_000_000) * pricing.cachedInputPer1M
               + (candidates / 1_000_000) * pricing.outputPer1M;
  }

  if (!hasTokenData) return null;

  return {
    inputTokens: totalInput,
    cachedInputTokens: totalCached,
    outputTokens: totalOutput,
    costUsd: totalCost,
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
export function extractReviewText(model: string, output: string): string | null {
  try {
    if (model === 'gemini') {
      const parsed = JSON.parse(output);
      if (typeof parsed?.response === 'string') {
        return parsed.response;
      }
      return null;
    }

    // Claude and Codex: text is captured directly by their SDK streaming loops
    return null;
  } catch {
    return null;
  }
}
