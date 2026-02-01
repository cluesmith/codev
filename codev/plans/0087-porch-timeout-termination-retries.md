---
approved: 2026-02-01
validated: [gemini, codex, claude]
---

# Implementation Plan: Porch Timeout, Termination, and Retries

## Overview

Add timeout, retry, and circuit breaker logic to porch's build loop, mirroring the proven pattern already used by `runConsult`. Three files change: `claude.ts` (timeout wrapper), `run.ts` (retry loop + circuit breaker + AWAITING_INPUT), `types.ts` (state field).

```json
{"phases": [{"id": "phase_1", "title": "Build Timeout in claude.ts"}, {"id": "phase_2", "title": "Retry Loop + Circuit Breaker in run.ts"}, {"id": "phase_3", "title": "AWAITING_INPUT Detection"}, {"id": "phase_4", "title": "Tests"}]}
```

## Phase 1: Build Timeout + Retry in claude.ts

**Files:**
- `packages/codev/src/commands/porch/claude.ts`

**Changes:**
1. Add `buildWithTimeout` wrapper function that uses `Promise.race` to race `buildWithSDK` against a timeout:
   ```
   Promise.race([buildWithSDK(prompt, outputPath, cwd), timeoutPromise(BUILD_TIMEOUT_MS)])
   ```
2. On timeout, return `{ success: false, output: '[TIMEOUT]', ... }` — do NOT throw
3. Export `buildWithTimeout` as the new public API; keep `buildWithSDK` as internal
4. Accept `timeoutMs` parameter (default `BUILD_TIMEOUT_MS`) for testability

**No retry logic here** — retry lives in run.ts (caller), matching the runConsult pattern where `runConsultOnce` is the single-attempt function and `runConsult` adds retry.

**Stream abandonment on timeout**: The `Promise.race` approach means the underlying Agent SDK async iterator is abandoned (not explicitly cancelled) when the timeout fires. The spec documents this as an accepted trade-off — the iterator will be garbage collected, and each retry writes to a distinct output file, so there's no risk of overlapping writes.

## Phase 2: Retry Loop + Circuit Breaker in run.ts

**Files:**
- `packages/codev/src/commands/porch/run.ts`

**Changes:**

### Constants (alongside existing CONSULT_* constants, ~line 531)
```typescript
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;     // 15 minutes
const BUILD_MAX_RETRIES = 3;
const BUILD_RETRY_DELAYS = [5000, 15000, 30000];
const CIRCUIT_BREAKER_THRESHOLD = 5;
```

### Retry wrapper (~line 430, replacing direct `buildWithSDK` call)
Add `runBuildWithRetry()` function (mirrors `runConsult` pattern):
```
for attempt in 0..BUILD_MAX_RETRIES:
  result = buildWithTimeout(prompt, outputPath, cwd)
  if result.success: return result
  if attempt < max: sleep(delay[attempt]), log retry
return failed result
```

Output file naming: `{id}-{phase}-iter-{n}-try-{m}.txt` — each attempt gets a distinct file.

### Circuit breaker (top of while loop)
Add `consecutiveFailures` counter (ephemeral, not persisted):
- Increment on build failure (after all retries exhausted)
- Reset to 0 on any successful build
- If `>= CIRCUIT_BREAKER_THRESHOLD`: log error, `process.exit(2)`

### Flow change (~line 440-456)
Currently: `build_complete = true` regardless of `result.success`, then verification runs.
After: Only set `build_complete = true` if result is successful. On exhausted retries, do NOT set `build_complete = true` — increment circuit breaker counter and `continue` (loop back to top, where breaker check halts if threshold reached). Failed builds never proceed to verification.

## Phase 3: AWAITING_INPUT Detection

**Files:**
- `packages/codev/src/commands/porch/run.ts`
- `packages/codev/src/commands/porch/types.ts`

**Changes:**

### types.ts
Add to `ProjectState`:
```typescript
awaiting_input?: boolean;  // Worker signaled it needs human input
```

### run.ts — Detection (after buildWithTimeout returns)
Scan `result.output` for `<signal>BLOCKED:` or `<signal>AWAITING_INPUT</signal>`. If found:
1. Set `state.awaiting_input = true`, write state
2. Log message to stderr: `[PORCH] Worker needs human input — check output file: <path>`
3. `process.exit(3)`

### run.ts — Resume guard (top of while loop, after state read)
If `state.awaiting_input === true`:
1. **Hash comparison**: If `state.awaiting_input_output` and `state.awaiting_input_hash` exist, read the output file and compute its SHA-256 hash. If the hash matches the stored hash, the human hasn't resolved the blocker — log error and `process.exit(3)`.
2. If hash differs (or no hash stored): Log `[PORCH] Resuming from AWAITING_INPUT state`, clear `state.awaiting_input`, `state.awaiting_input_output`, and `state.awaiting_input_hash`, write state, and continue normally (re-run build phase).

### types.ts — Additional state fields for resume guard
```typescript
awaiting_input_output?: string;  // Output file path when AWAITING_INPUT was set
awaiting_input_hash?: string;    // SHA-256 hash of output for resume guard
```

## Phase 4: Tests

**Files:**
- `packages/codev/src/commands/porch/__tests__/timeout-retry.test.ts` (new)

**Test cases** (using vitest, mocking `buildWithSDK`):
1. `buildWithTimeout` returns timeout result after deadline
2. `buildWithTimeout` returns normal result before deadline
3. Retry succeeds on second attempt
4. All retries exhausted → failure propagated
5. Circuit breaker trips after N consecutive failures
6. Circuit breaker resets after success
7. AWAITING_INPUT signal detected in output → state written
8. Resume from AWAITING_INPUT state clears flag and continues
9. Output files use attempt numbering (no overwrite)
10. `build_complete` stays false during retries
11. `--single-phase` mode works with retry
12. `--single-iteration` mode works with retry

## Verification

- `npx vitest run src/commands/porch/` — all existing + new tests pass
- `npx tsc --noEmit` — clean compile
- `npm run build` — succeeds
