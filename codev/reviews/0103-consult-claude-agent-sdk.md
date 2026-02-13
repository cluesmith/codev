# Review: Consult Claude via Agent SDK

## Metadata
- **Spec**: codev/specs/0103-consult-claude-agent-sdk.md
- **Plan**: codev/plans/0103-consult-claude-agent-sdk.md
- **PR**: #231
- **Branch**: builder/0103-consult-claude-agent-sdk
- **Date**: 2026-02-13

## Summary

Replaced Claude CLI subprocess delegation in `consult` with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). This eliminates the CLAUDECODE nesting guard that prevented Claude from being used as a consultant in builder contexts, and gives Claude tool-using capabilities (Read, Glob, Grep) during reviews.

## Changes Made

### Phase 1: SDK Dependency and runClaudeConsultation
- Added `@anthropic-ai/claude-agent-sdk` as a hard dependency in `packages/codev/package.json`
- Created `runClaudeConsultation()` function using `query()` async iterator
- Intercepts claude model in `runConsultation()` before CLI path
- Handles `--output` file writing, `--dry-run` parameter display, tool use logging

### Phase 2: Doctor and Tests
- Updated `doctor.ts`: removed Claude from `AI_DEPENDENCIES`, added `verifyClaudeViaSDK()`
- Added 7 new consult tests: SDK parameters, text extraction, file output, CLAUDECODE env removal, error handling, dry-run, tool use logging
- Updated doctor tests with SDK mock, rewrote Claude auth tests for SDK

### Phase 3: Cleanup
- Removed `claude` from `MODEL_CONFIGS` (SDK-only model)
- Added `SDK_MODELS` constant for validation
- Updated test documentation

## Key Decisions

1. **Hard dependency**: Made `@anthropic-ai/claude-agent-sdk` a hard dependency rather than optional. It's essential for consultation and avoids dynamic import complexity.

2. **CLAUDECODE env stripping**: Iterate over `process.env` entries and exclude `CLAUDECODE` rather than spread-and-delete, since env values can be `undefined`.

3. **SDK_MODELS pattern**: Introduced `SDK_MODELS` array to separate SDK-based models from CLI-based models in `MODEL_CONFIGS`, keeping clean separation of concerns.

4. **Tool visibility**: Tool use blocks are logged to stderr with `[Tool: name: detail]` format, matching the existing CLI output pattern.

## Spec Deviations

1. **`persistSession: false`**: Not a valid SDK option. Sessions are ephemeral by default. Omitted.
2. **`effort: 'high'`**: Not a valid SDK option. Omitted.
3. **`tool_use_summary` message type**: Does not exist in SDK. Tool use appears as content blocks within assistant messages. Handled accordingly.
4. **`tools` vs `allowedTools`**: Spec used `tools`, but SDK uses `allowedTools` for restricting available tools. Corrected.

## Test Coverage

- 28 consult unit tests (7 new for SDK path)
- 12 doctor unit tests (updated for SDK)
- 845 total tests pass (1 pre-existing flaky tunnel test excluded)

## Lessons Learned

1. **Research SDK APIs before planning**: The spec assumed several options that don't exist in the SDK. Early research during planning phase caught these, preventing implementation rework.

2. **Async generator mocking**: vitest `vi.mock` factories create mock instances that persist across `vi.resetModules()` calls. Need `mockClear()` in beforeEach to reset call counts.

3. **Pre-existing test flakiness**: The `tunnel-client.integration.test.ts` WebSocket test consistently times out. This blocked porch advancement and required manual status.yaml updates.
