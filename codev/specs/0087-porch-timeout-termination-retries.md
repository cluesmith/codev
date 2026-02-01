---
approved: 2026-02-01
validated: [gemini, codex, claude]
---

# Specification: Porch Timeout, Termination, and Retries

## Metadata
- **ID**: 0087
- **Status**: specified
- **Created**: 2026-02-01
- **Protocol**: SPIDER

## Clarifying Questions Asked

1. **Q**: What's the primary failure mode? **A**: Claude (Agent SDK worker) hangs indefinitely during `buildWithSDK()`. The `for await` message stream stalls and porch blocks forever.
2. **Q**: Should we also protect the outer loop? **A**: Yes — the `while(true)` in run.ts has no circuit breaker. A series of SDK failures could loop indefinitely.
3. **Q**: What about the AWAITING_INPUT signal? **A**: Porch's `--single-phase` mode returns control to the builder when a gate is pending, but there's no EXIT_AWAITING_INPUT signal wired up for the build phase itself (when Claude needs human input mid-build).

## Problem Statement

Porch's build loop (`run.ts`) has no timeout or retry logic for its primary worker (`buildWithSDK` in `claude.ts`). When the Agent SDK message stream hangs — due to API rate limits, network issues, or Claude entering an unrecoverable state — porch blocks indefinitely with no way to recover. The user must manually kill the process.

This contrasts with the consultation system (`runConsult`), which already has 3 retries, exponential backoff, and a 1-hour timeout per model.

## Current State

| Component | Timeout | Retry | Circuit Breaker |
|-----------|---------|-------|-----------------|
| `buildWithSDK` (Agent SDK) | None | None | None |
| `while(true)` main loop | None | None | None |
| `runConsult` (consult CLI) | 1 hour | 3x with backoff | None |
| Build-verify iterations | None | Manual (max iterations) | None |

**Specific vulnerabilities:**
- **Line 430 of run.ts**: `await buildWithSDK(prompt, outputPath, projectRoot)` — blocks forever if Agent SDK stream stalls
- **Line 53 of claude.ts**: `for await (const message of query({...}))` — no per-message timeout, only `maxTurns: 200`
- **Line 115 of run.ts**: `while (true)` — no maximum iteration count or overall timeout

## Desired State

1. **Build timeout**: Each `buildWithSDK` call has a configurable timeout (default 15 minutes). On timeout, the worker is killed and porch can retry.
2. **Build retry**: Failed builds (timeout or SDK error) are retried up to N times with exponential backoff before giving up.
3. **Circuit breaker**: After K consecutive failures across the main loop, porch halts with exit code 2 and a clear error message, then returns. Circuit breaker state is ephemeral (resets on porch restart).
4. **AWAITING_INPUT**: When the worker's output contains `<signal>BLOCKED:` or `<signal>AWAITING_INPUT</signal>`, porch detects this by scanning `buildWithSDK` output, writes `AWAITING_INPUT` to porch state (`status.yaml`), prints a message to stderr (`[PORCH] Worker needs human input — check output file`), and returns with exit code 3. The calling builder (or `--single-phase` caller) is responsible for surfacing this to the human. On next `porch run`, if state is AWAITING_INPUT, porch resumes from the same phase/iteration.

## Stakeholders
- **Primary Users**: Builders running porch in strict mode (`af spawn -p`)
- **Secondary Users**: Human architects monitoring builder progress
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `buildWithSDK` times out after configurable duration (default 15 min)
- [ ] Timed-out builds are retried up to 3 times with backoff (5s, 15s, 30s)
- [ ] Main loop halts with exit code 2 after 5 consecutive build failures (circuit breaker)
- [ ] AWAITING_INPUT signal detected in worker output → state written, exit code 3
- [ ] On resume after AWAITING_INPUT, porch continues from same phase/iteration
- [ ] Retries do not corrupt porch state — `build_complete` stays false until a successful build
- [ ] Partially-written artifacts from failed builds are preserved (not deleted) for debugging
- [ ] `--single-phase` and `--single-iteration` modes work correctly with timeout/retry
- [ ] All existing porch unit tests continue to pass
- [ ] New unit tests cover timeout, retry, circuit breaker, and AWAITING_INPUT paths
- [ ] Consultation timeout/retry logic remains unchanged

## Configuration

All settings are constants in `run.ts` (alongside existing `CONSULT_TIMEOUT_MS` etc.). No CLI flags, env vars, or protocol.json changes for v1 — keep it simple.

| Constant | Default | Purpose |
|----------|---------|---------|
| `BUILD_TIMEOUT_MS` | `15 * 60 * 1000` (15 min) | Max duration for a single `buildWithSDK` call |
| `BUILD_MAX_RETRIES` | `3` | Max retry attempts per build invocation |
| `BUILD_RETRY_DELAYS` | `[5000, 15000, 30000]` | Backoff delays between retries (ms) |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive build failures before halting |

Future: if per-phase configuration is needed, these can be moved to protocol.json. For now, constants are sufficient.

## Constraints

### Technical Constraints
- Agent SDK `query()` returns an async iterator. Cancellation requires wrapping with `AbortController` or `Promise.race`.
- Agent SDK may not support `AbortSignal` natively — may need process-level timeout wrapper.
- Must not break `--single-phase` or `--single-iteration` modes.
- Must preserve existing consultation retry logic (already working well).

### Business Constraints
- Must ship before v2.0.0 stable (porch reliability is a release blocker)
- Changes should be minimal and focused — no refactoring of existing working code

## Assumptions
- Agent SDK `query()` async iterator can be abandoned (garbage collected) without leaking resources, or can be cancelled via AbortController
- The 15-minute default timeout is sufficient for any legitimate build phase (spec writing, implementation, review)
- Exponential backoff delays (5s, 15s, 30s) are appropriate for transient API failures

## Solution Approaches

### Approach 1: Promise.race Timeout Wrapper (Recommended)
**Description**: Wrap `buildWithSDK` with `Promise.race` against a timeout promise. On timeout, return a failure result. Add retry loop around the call site in run.ts. Add circuit breaker counter to the main loop.

**Pros**:
- Minimal changes to existing code (wrapper pattern)
- Matches the proven pattern already used by `runConsult`
- No dependency on Agent SDK supporting AbortController

**Cons**:
- Abandoned SDK streams may leak resources briefly until GC
- Timeout kills the entire build, not individual stalled messages

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: AbortController Integration
**Description**: Pass an `AbortSignal` to the Agent SDK `query()` call. This would allow clean cancellation of the stream.

**Pros**:
- Clean cancellation, no resource leaks
- Per-message timeout possible

**Cons**:
- Requires Agent SDK to support AbortSignal (unverified)
- More invasive changes to claude.ts
- If SDK doesn't support it, falls back to Approach 1 anyway

**Estimated Complexity**: Medium
**Risk Level**: Medium

## Open Questions

### Critical (Blocks Progress)
- [x] Does Agent SDK `query()` support AbortSignal? → Check at implementation time, fall back to Approach 1 if not

### Important (Affects Design)
- [ ] Should circuit breaker state persist across porch restarts? (Probably not — fresh start should reset)
- [ ] Should timeout be configurable per-phase in protocol.json? (Nice but not required for v1)

## Performance Requirements
- Timeout detection must fire within 1 second of deadline
- Retry backoff should not exceed 60 seconds per attempt
- Circuit breaker should halt within 1 loop iteration of threshold

## Security Considerations
- No new security surface — all changes are internal control flow

## Test Scenarios

### Functional Tests
1. **Build timeout**: Mock `buildWithSDK` to hang; verify porch retries 3 times then gives up
2. **Build retry success**: Mock first call to fail, second to succeed; verify retry works and circuit breaker resets
3. **Circuit breaker trip**: Mock 5 consecutive failures across loop iterations; verify porch exits with code 2 and error message
4. **Circuit breaker reset**: Verify counter resets to 0 after a successful build
5. **Normal operation**: Verify no behavioral change when builds succeed normally
6. **Single-phase mode**: Verify timeout/retry works correctly with `--single-phase`
7. **Single-iteration mode**: Verify timeout/retry works correctly with `--single-iteration`
8. **AWAITING_INPUT detection**: Mock worker output containing `<signal>BLOCKED:needs approval</signal>`; verify porch writes AWAITING_INPUT to state and exits with code 3
9. **AWAITING_INPUT resume**: Set state to AWAITING_INPUT; run porch; verify it resumes from same phase/iteration
10. **Partial artifacts preserved**: Mock build that writes partial file then times out; verify file still exists after retry
11. **State not corrupted on retry**: Verify `build_complete` stays false and `iteration` doesn't increment during retries of the same build

### Non-Functional Tests
1. Verify timeout fires within expected window (not early, not late)
2. Verify retry backoff delays are correct (5s, 15s, 30s)

## Dependencies
- **Internal**: `packages/codev/src/commands/porch/claude.ts`, `packages/codev/src/commands/porch/run.ts`, `packages/codev/src/commands/porch/types.ts`
- **External**: `@anthropic-ai/claude-agent-sdk` (Agent SDK)

## References
- Existing consultation retry logic: `run.ts` lines 531-561
- Agent SDK docs: `packages/codev/src/commands/porch/claude.ts`
- Project tracking: `codev/projectlist.md` (0087)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Agent SDK stream leaks on abandon | Medium | Low | GC handles it; monitor memory in e2e tests |
| Timeout too aggressive for large builds | Low | Medium | Make configurable, default 15 min is generous |
| Retry masks persistent failures | Low | Medium | Circuit breaker halts after threshold |

## Implementation Notes

### Behavioral changes from current code
- **Failed builds no longer proceed to verification.** Currently, `run.ts` sets `build_complete = true` regardless of `result.success`. After this change, failed builds trigger retry logic instead. Only successful builds (or exhausted retries) proceed.
- **Output files use attempt numbering.** Currently, `buildWithSDK` overwrites the output file. With retries, each attempt gets a distinct file: `{id}-{phase}-iter-{n}-try-{m}.txt`. Failed attempt logs are preserved for debugging.

### Type changes
- `ProjectState` in `types.ts` needs a new optional field (e.g., `awaiting_input?: boolean`) or the `phase` state machine needs an AWAITING_INPUT sub-state. The simpler approach: add `awaiting_input: boolean` (default false) to state, checked at the top of the main loop.

### AWAITING_INPUT resume guard
- To prevent infinite resume loops (run → AWAITING_INPUT → exit → restart → same AWAITING_INPUT), porch must check on resume: if state is AWAITING_INPUT and the worker output hasn't changed since last run, halt with a message asking the human to resolve the blocker before restarting.

### General
- The consultation system (`runConsult`) already implements the exact pattern we want (timeout + retry + backoff). We should mirror that approach for `buildWithSDK`.
- Constants should be defined alongside the existing `CONSULT_TIMEOUT_MS`, `CONSULT_MAX_RETRIES`, `CONSULT_RETRY_DELAYS` for consistency.

## Expert Consultation
**Date**: 2026-02-01
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro

### Codex (REQUEST_CHANGES → Addressed)
1. AWAITING_INPUT underspecified → Added signal detection, exit code 3, state field, resume behavior
2. Configuration surface undefined → Added Configuration section with constants table
3. Circuit breaker UX unclear → Added exit code 2 and reset behavior
4. Partial progress on retry → Added success criterion: artifacts preserved, state not corrupted
5. Missing test scenarios → Added tests 8-11 covering AWAITING_INPUT, resume, partial artifacts, state integrity

### Gemini (COMMENT → Addressed)
1. types.ts needs update → Added to Implementation Notes and Dependencies
2. Output file overwritten on retry → Added attempt numbering scheme in Implementation Notes
3. Flow logic change not explicit → Added "Behavioral changes" section clarifying failed builds don't proceed to verify
4. AWAITING_INPUT resume loop risk → Added resume guard in Implementation Notes

---

## Amendments

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
