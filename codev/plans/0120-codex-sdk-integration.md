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
- [ ] System prompt / role passed via SDK config (not temp file)
- [ ] Read-only sandbox mode preserved via `sandboxMode` thread option
- [ ] Existing `consult -m codex` CLI interface unchanged
- [ ] `extractReviewText()` codex branch removed (no longer needed)
- [ ] `extractCodexUsage()` simplified or removed
- [ ] All existing tests updated, new SDK integration tests added

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
- [ ] Real-time streaming via `thread.runStreamed()` events
- [ ] Usage extraction from `turn.completed` event's structured usage data
- [ ] System prompt passed via SDK config (`experimental_instructions_file` or inline)
- [ ] Sandbox mode set via `sandboxMode: 'read-only'` thread option
- [ ] Dry-run mode updated for Codex SDK path

#### Implementation Details

**New function: `runCodexConsultation()`** in `consult/index.ts`:

```typescript
import { Codex } from '@openai/codex-sdk';
// Uses typed events: ItemCompletedEvent, TurnCompletedEvent

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

  // Write role to temp file for experimental_instructions_file config
  const tempFile = path.join(tmpdir(), `codev-role-${Date.now()}.md`);
  fs.writeFileSync(tempFile, role);

  try {
    const codex = new Codex({
      config: {
        experimental_instructions_file: tempFile,
        model_reasoning_effort: 'medium',
      },
    });

    const thread = codex.startThread({
      model: 'gpt-5.2-codex',
      sandboxMode: 'read-only',
      workingDirectory: workspaceRoot,
    });

    const streamedTurn = await thread.runStreamed(queryText);

    for await (const event of streamedTurn) {
      if (event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'agent_message') {
          process.stdout.write(item.text);
          chunks.push(item.text);
        }
      }
      if (event.type === 'turn.completed') {
        // Structured usage data directly from event
        usageData = {
          inputTokens: event.usage?.input_tokens ?? null,
          cachedInputTokens: event.usage?.cached_input_tokens ?? null,
          outputTokens: event.usage?.output_tokens ?? null,
          costUsd: null, // Compute from tokens + pricing table
        };
        // Compute cost if all token data present
        if (usageData.inputTokens !== null && usageData.cachedInputTokens !== null && usageData.outputTokens !== null) {
          usageData.costUsd = computeCostFromTokens('codex', usageData);
        }
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

    // Record metrics
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
- **Manual Testing**: Run `consult -m codex --dry-run general "hello"` to verify SDK path
- **Build**: Verify TypeScript compilation succeeds

#### Risks
- **Risk**: `@openai/codex-sdk` API may differ from documentation
  - **Mitigation**: Install SDK first, inspect types before writing implementation
- **Risk**: `experimental_instructions_file` config key may not work via SDK config
  - **Mitigation**: Fall back to writing temp file and passing path, same as current approach

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
3. Remove codex from `SUBPROCESS_MODEL_PRICING` (pricing now computed inline in `runCodexConsultation`)
4. Update `extractUsage()` to remove codex branch — codex usage is now captured directly from SDK events (same as Claude)
5. Export `computeCost()` (currently private) so `runCodexConsultation()` can use it, or move pricing computation into the new function

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
  - **Mitigation**: Move pricing constants into `runCodexConsultation()` or keep them in a shared location

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
| SDK API differs from docs | M | M | Install first, inspect TypeScript types |
| Config key doesn't pass instructions | L | M | Use temp file approach (same as current) |
| Streaming events have different shapes | L | H | Use SDK's exported types for type safety |

## Validation Checkpoints
1. **After Phase 1**: `consult -m codex --dry-run general "test"` shows SDK info, build passes
2. **After Phase 2**: All tests pass, no dead code, build clean
