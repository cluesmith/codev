# Plan: Codex SDK Integration

## Metadata
- **ID**: 0120
- **Status**: draft
- **Specification**: codev/specs/0120-codex-sdk-integration.md
- **Created**: 2026-02-15

## Executive Summary

Replace the Codex CLI subprocess in `consult/index.ts` with `@openai/codex-sdk`, mirroring the existing Claude Agent SDK integration pattern. The SDK provides typed streaming events (`item.completed`, `turn.completed`) that eliminate JSONL parsing, enable real-time streaming, and give structured usage data directly.

## Success Metrics
- [ ] Codex consultations use `@openai/codex-sdk` instead of subprocess
- [ ] Real-time text streaming to stdout (like Claude SDK does)
- [ ] Review text captured directly from SDK events — no JSONL file extraction
- [ ] Usage data (tokens, cost) extracted from SDK structured events
- [ ] Metrics recording works correctly (duration, tokens, cost, exit code)
- [ ] System prompt / role passed via SDK config option (`experimental_instructions_file`)
- [ ] Read-only sandbox mode preserved via SDK config (`sandbox: 'read-only'`)
- [ ] Existing `consult -m codex` CLI interface unchanged
- [ ] `extractReviewText()` codex branch removed (no longer needed)
- [ ] `extractCodexUsage()` simplified or removed
- [ ] All existing tests updated, new SDK integration tests added

### Note on system prompt delivery
The spec says "System prompt / role passed via SDK options (not temp file)." The Codex SDK does not support inline system prompts — it only accepts instructions via `experimental_instructions_file` config, which requires a file path. This is an SDK limitation, not a design choice. The temp file is written, passed as a config key to the SDK constructor, and cleaned up in the `finally` block. This is equivalent to how the Claude SDK receives its `systemPrompt` option — the Codex SDK just requires a file path instead of a string.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Install SDK and implement runCodexConsultation"},
    {"id": "phase_2", "title": "Clean up JSONL parsing and update tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Install SDK and implement runCodexConsultation
**Dependencies**: None

#### Objectives
- Add `@openai/codex-sdk` dependency
- Create a new `runCodexConsultation()` function that mirrors `runClaudeConsultation()`
- Wire it into the `runConsultation()` dispatcher, replacing the Codex subprocess path
- Remove Codex from `MODEL_CONFIGS` (no longer CLI-based) and add to `SDK_MODELS`

#### Deliverables
- [ ] `@openai/codex-sdk` added to `packages/codev/package.json`
- [ ] `runCodexConsultation()` function in `consult/index.ts`
- [ ] Codex routing updated in `runConsultation()` to use SDK path
- [ ] Real-time streaming via `thread.runStreamed()` events (destructured `{ events }`)
- [ ] Usage extraction from `turn.completed` event's structured usage data
- [ ] System prompt passed via SDK config (`experimental_instructions_file` config key)
- [ ] Sandbox mode set via `config: { sandbox: 'read-only' }` on Codex constructor
- [ ] Model set via `config: { model: 'gpt-5.2-codex' }` on Codex constructor
- [ ] Dry-run mode updated for Codex SDK path
- [ ] Unit tests for `runCodexConsultation()` event handling and error paths

#### Implementation Details

**New function: `runCodexConsultation()`** in `consult/index.ts`:

```typescript
import { Codex } from '@openai/codex-sdk';

// Codex pricing for cost computation (same values as current SUBPROCESS_MODEL_PRICING)
const CODEX_PRICING = { inputPer1M: 2.00, cachedInputPer1M: 1.00, outputPer1M: 8.00 };

async function runCodexConsultation(
  queryText: string,
  role: string,
  workspaceRoot: string,
  outputPath?: string,
  metricsCtx?: MetricsContext,
): Promise<void> {
  const chunks: string[] = [];
  const startTime = Date.now();
  let usageData: UsageData | null = null;
  let errorMessage: string | null = null;
  let exitCode = 0;

  // Write role to temp file — SDK requires file path for instructions
  const tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
  fs.writeFileSync(tempFile, role);

  try {
    // Config keys match Codex CLI -c flags (TOML-style)
    // model, sandbox, and instructions all go in config
    const codex = new Codex({
      config: {
        model: 'gpt-5.2-codex',
        sandbox: 'read-only',
        experimental_instructions_file: tempFile,
        model_reasoning_effort: 'medium',
      },
    });

    const thread = codex.startThread({
      workingDirectory: workspaceRoot,
    });

    // runStreamed() returns { events } — destructure to get the async iterable
    const { events } = await thread.runStreamed(queryText);

    for await (const event of events) {
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'agent_message') {
          process.stdout.write(item.text);
          chunks.push(item.text);
        }
      }
      if (event.type === 'turn.completed') {
        // Structured usage data directly from SDK event
        const input = event.usage?.input_tokens ?? null;
        const cached = event.usage?.cached_input_tokens ?? null;
        const output = event.usage?.output_tokens ?? null;
        // Compute cost inline using pricing constants
        let cost: number | null = null;
        if (input !== null && cached !== null && output !== null) {
          const uncached = input - cached;
          cost = (uncached / 1_000_000) * CODEX_PRICING.inputPer1M
               + (cached / 1_000_000) * CODEX_PRICING.cachedInputPer1M
               + (output / 1_000_000) * CODEX_PRICING.outputPer1M;
        }
        usageData = { inputTokens: input, cachedInputTokens: cached, outputTokens: output, costUsd: cost };
      }
      if (event.type === 'turn.failed') {
        errorMessage = event.error?.message ?? 'Codex turn failed';
        exitCode = 1;
        throw new Error(errorMessage);
      }
    }

    // Write output file
    if (outputPath) {
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, chunks.join(''));
      console.error(`\nOutput written to: ${outputPath}`);
    }
  } catch (err) {
    if (!errorMessage) {
      errorMessage = (err instanceof Error ? err.message : String(err)).substring(0, 500);
      exitCode = 1;
    }
    throw err;
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    // Record metrics (always, even on error)
    if (metricsCtx) {
      const duration = (Date.now() - startTime) / 1000;
      recordMetrics(metricsCtx, {
        durationSeconds: duration,
        inputTokens: usageData?.inputTokens ?? null,
        cachedInputTokens: usageData?.cachedInputTokens ?? null,
        outputTokens: usageData?.outputTokens ?? null,
        costUsd: usageData?.costUsd ?? null,
        exitCode,
        errorMessage,
      });
    }
  }
}
```

**IMPORTANT: Verify SDK types before coding.** After `npm install @openai/codex-sdk`, inspect the actual TypeScript definitions for `Codex`, `Thread`, `ThreadOptions`, `CodexOptions`, and event types. The code sample above is based on SDK documentation and may need adjustments. Key things to verify:
1. Does `runStreamed()` return `{ events }` or a direct async iterable?
2. Does `startThread()` accept `model`/`sandboxMode`, or do these go in `config`?
3. Does the SDK handle `OPENAI_API_KEY` from `process.env` automatically?

**Changes to `runConsultation()` dispatcher:**
- Add `codex` to `SDK_MODELS` array: `const SDK_MODELS = ['claude', 'codex'];`
- Remove `codex` entry from `MODEL_CONFIGS` (no longer subprocess-based)
- Add Codex SDK path before the generic subprocess path, similar to the existing Claude block:

```typescript
if (model === 'codex') {
  if (dryRun) { /* print SDK info */ return; }
  await runCodexConsultation(query, role, workspaceRoot, outputPath, metricsCtx);
  logQuery(workspaceRoot, model, query, ...);
  return;
}
```

**Files to modify/create:**
- `packages/codev/package.json` — add `@openai/codex-sdk` dependency
- `packages/codev/src/commands/consult/index.ts` — add `runCodexConsultation()`, update routing

#### Acceptance Criteria
- [ ] `consult -m codex spec 120` uses the SDK (no `codex` subprocess spawned)
- [ ] Text streams to stdout in real-time during consultation
- [ ] Output file contains clean review text (not JSONL)
- [ ] Metrics DB records tokens and cost correctly
- [ ] Dry-run mode (`--dry-run`) prints SDK configuration details
- [ ] All builds pass (`npm run build`)

#### Test Plan
- **Unit Tests** (in `metrics.test.ts` or a new `codex-sdk.test.ts`):
  - **Cost computation**: given token counts (24763 input, 24448 cached, 122 output), verify `CODEX_PRICING` produces correct USD value
  - **Cost with null tokens**: if any token field is null, cost must be null
  - **Cost with cached tokens**: verify `uncachedInput = input - cached` is used for pricing
  - **Event stream text aggregation**: mock `runStreamed()` returning `item.completed` events with `agent_message` items; verify `chunks` array captures all text
  - **Event stream usage capture**: mock `turn.completed` event with `{ input_tokens, cached_input_tokens, output_tokens }`; verify `usageData` is populated correctly
  - **Error path — turn.failed**: mock `turn.failed` event; verify error is thrown, `exitCode = 1`, `errorMessage` captured, and metrics are still recorded in `finally`
  - **Error path — stream throw**: mock the async generator throwing an error; verify temp file cleanup and metrics recording still happen
  - **Temp file cleanup**: verify temp file is deleted in both success and error paths
- **Manual Testing**: Run `consult -m codex --dry-run general "hello"` to verify SDK path
- **Build**: Verify TypeScript compilation succeeds (`npm run build`)
- **Regression**: Verify `consult -m gemini --dry-run general "hello"` still works via subprocess
- **Regression**: Verify `consult -m claude --dry-run general "hello"` still works via SDK

#### Risks
- **Risk**: `@openai/codex-sdk` API may differ from documentation
  - **Mitigation**: Install SDK first, inspect actual TypeScript types before writing implementation. The plan includes explicit verification checklist.
- **Risk**: `experimental_instructions_file` config key may not work via SDK config
  - **Mitigation**: The SDK `config` option passes through as `-c key=value` to the Codex CLI. This is the same mechanism the current subprocess uses. Verify during implementation.
- **Risk**: API key not automatically picked up from `process.env`
  - **Mitigation**: SDK docs say it handles `OPENAI_API_KEY` / `CODEX_API_KEY` automatically. Verify during implementation; if needed, pass explicitly via `env` option.

---

### Phase 2: Clean up JSONL parsing and update tests
**Dependencies**: Phase 1

#### Objectives
- Remove dead Codex JSONL parsing code from `usage-extractor.ts`
- Remove Codex real-time JSONL streaming from subprocess handler
- Update existing tests to reflect the SDK-based architecture
- Add new tests for `runCodexConsultation()` error handling

#### Deliverables
- [ ] `extractCodexUsage()` removed from `usage-extractor.ts`
- [ ] `extractReviewText()` codex branch removed from `usage-extractor.ts`
- [ ] Codex JSONL streaming removed from subprocess `proc.stdout.on('data')` handler
- [ ] Codex-specific tests in `metrics.test.ts` updated or removed
- [ ] New tests for SDK-based Codex usage extraction added
- [ ] Codex `extractReviewText` tests updated (now returns null for codex, like claude)

#### Implementation Details

**Changes to `usage-extractor.ts`:**
1. Remove `extractCodexUsage()` function (lines 94-153)
2. Remove codex branch in `extractReviewText()` (lines 191-213)
3. Remove codex from `SUBPROCESS_MODEL_PRICING` — pricing is now owned by `CODEX_PRICING` constant in `index.ts` next to `runCodexConsultation()`. This follows the same pattern where Claude pricing comes from the SDK result directly. Each SDK-based model owns its own cost computation.
4. Update `extractUsage()` to remove codex branch — codex usage is now captured directly from SDK events (same as Claude)
5. `computeCost()` remains private in `usage-extractor.ts` (used only by Gemini now). No need to export it.

**Changes to subprocess handler in `index.ts`:**
1. Remove the `if (model === 'codex')` block inside `proc.stdout.on('data')` (lines 550-574) — this was the real-time JSONL streaming for codex
2. Remove `codexLineBuf` variable
3. The subprocess handler now only handles Gemini

**Changes to `metrics.test.ts`:**
1. Remove "extractUsage for Codex" test group — no longer parsing JSONL
2. Remove "Codex output unwrapping" test group — no longer extracting from JSONL
3. Remove "Codex mixed JSONL with non-JSON lines" test group — no JSONL to parse
4. Add test for Codex SDK-style usage extraction (direct from event data, not JSONL)

**Files to modify:**
- `packages/codev/src/commands/consult/usage-extractor.ts` — remove codex JSONL parsing
- `packages/codev/src/commands/consult/index.ts` — clean up subprocess handler
- `packages/codev/src/commands/consult/__tests__/metrics.test.ts` — update tests

#### Acceptance Criteria
- [ ] No JSONL parsing code remains for Codex
- [ ] `extractReviewText('codex', ...)` returns null (like Claude)
- [ ] `extractUsage('codex', ...)` no longer exists or returns null (usage from SDK events)
- [ ] All tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] No dead code: `codexLineBuf`, codex JSONL streaming block removed

#### Test Plan
- **Unit Tests**: Run existing test suite, verify updated tests pass
- **Integration**: Verify `consult -m codex --dry-run` still works
- **Regression**: Ensure `consult -m gemini` still works via subprocess path

#### Risks
- **Risk**: Removing codex from SUBPROCESS_MODEL_PRICING affects cost computation
  - **Mitigation**: Pricing is owned by `CODEX_PRICING` constant in `index.ts` (added in Phase 1). Remove the codex entry from `SUBPROCESS_MODEL_PRICING` in `usage-extractor.ts`. No shared utility needed — each SDK model owns its own cost computation.

---

## Dependency Map
```
Phase 1 (SDK + runCodexConsultation) ──→ Phase 2 (Cleanup + tests)
```

## Integration Points
### External Systems
- **@openai/codex-sdk**: New npm dependency
  - **Integration Type**: SDK (async generator streaming)
  - **Phase**: Phase 1
- **OpenAI API**: Codex SDK connects to OpenAI API (same as CLI did)
  - Uses `OPENAI_API_KEY` or `CODEX_API_KEY` env vars (inherited from process.env)

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| SDK API differs from docs | M | M | Install first, inspect TypeScript types before coding |
| Config key doesn't pass instructions | L | M | Config passes as `-c` flags to CLI; same mechanism as current subprocess |
| Streaming events have different shapes | L | H | Use SDK's exported types for type safety |
| API key not auto-detected | L | L | SDK docs say it handles `OPENAI_API_KEY`; verify, pass via `env` if needed |
| `turn.failed` event doesn't exist | L | M | Handle errors via try/catch on async generator as fallback |

## Validation Checkpoints
1. **After Phase 1**: `consult -m codex --dry-run general "test"` shows SDK info, build passes
2. **After Phase 2**: All tests pass, no dead code, build clean
