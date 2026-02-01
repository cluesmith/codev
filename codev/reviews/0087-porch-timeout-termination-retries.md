# Review: porch-timeout-termination-retries

## Summary
Added timeout, retry, circuit breaker, and AWAITING_INPUT detection to porch's build loop. Three files changed: `claude.ts` (timeout wrapper via Promise.race), `run.ts` (retry loop, circuit breaker, AWAITING_INPUT signal detection/resume), `types.ts` (new state fields). 25 new unit tests across 3 test files, plus 6 existing tests in claude.test.ts continue passing.

## Spec Compliance
- [x] `buildWithSDK` times out after configurable duration (default 15 min) — `buildWithTimeout` uses `Promise.race`
- [x] Timed-out builds retried up to 3 times with backoff (5s, 15s, 30s) — retry loop in `run.ts` lines 483-493
- [x] Main loop halts with exit code 2 after 5 consecutive build failures (circuit breaker) — lines 149-152
- [x] AWAITING_INPUT signal detected in worker output → state written, exit code 3 — lines 502-514
- [x] On resume after AWAITING_INPUT, porch continues from same phase/iteration — lines 127-146
- [x] Retries do not corrupt porch state — `build_complete` stays false until successful build (tested)
- [x] Partially-written artifacts from failed builds preserved — distinct output files per attempt
- [x] `--single-phase` and `--single-iteration` modes work correctly with timeout/retry — lines 535-542
- [x] All existing porch unit tests continue to pass — 6/6 in claude.test.ts
- [x] New unit tests cover timeout, retry, circuit breaker, and AWAITING_INPUT paths — 25 tests
- [x] Consultation timeout/retry logic unchanged — `runConsult` untouched

## Deviations from Plan
- **Phase 1-3 merged into single commit**: The initial implementation committed all three phases together (timeout + retry + circuit breaker + AWAITING_INPUT) rather than separate commits. This was pragmatic since the changes are interdependent.
- **Constants placement**: BUILD_* constants are at the top of `run()` scope (line 90-93), not alongside CONSULT_* constants as planned. This is actually better — they're near their usage.
- **Resume guard uses SHA-256 hash**: Plan mentioned "output hasn't changed" check but didn't specify mechanism. Implementation uses SHA-256 hash comparison stored in state, which is robust.
- **AWAITING_INPUT regex uses `^` and `m` flag**: More precise than the plan's simple `includes()` approach, reducing false positives.

## Lessons Learned

### What Went Well
- Mirroring the existing `runConsult` retry pattern made the design straightforward
- The Promise.race timeout approach works cleanly without requiring Agent SDK AbortController support
- Test mocking strategy (shared state mock with writeState/readState) effectively simulates the run loop's state management
- Distinct output files per retry attempt (`-try-N.txt`) provides good debugging capability

### Challenges Encountered
- **setTimeout mocking**: Tests needed to mock setTimeout to avoid real delays. Solved by replacing with 0ms timers while preserving the real setTimeout reference.
- **process.exit mocking**: Tests mock `process.exit` to throw, allowing assertion of exit codes without actually exiting.

### What Would Be Done Differently
- Would add integration-level test that exercises the full flow (build → timeout → retry → success → verify) with a real (but fast) mock
- The AWAITING_INPUT regex anchors to line start (`^`) with multiline flag — could miss signals embedded mid-line, though this matches the spec's signal format

### Methodology Improvements
- SPIDER phases 1-3 could have been planned as a single phase since the changes are tightly coupled
- The spec's test scenarios section was very helpful for driving test implementation

## Technical Debt
- `buildWithTimeout`'s abandoned SDK stream on timeout may briefly leak resources until GC (documented in spec as accepted risk)
- Constants are module-level but not exported — if per-phase configuration is needed later, these need to move to protocol.json
- The `process.exit()` calls in the run loop make the function hard to compose; future refactor could return exit codes instead

## Follow-up Items
- Monitor memory usage in production to verify abandoned streams don't leak significantly
- Consider adding per-phase timeout configuration in protocol.json (spec identified this as future work)
- Add e2e test for timeout/retry behavior with real Agent SDK (currently only unit tested with mocks)

## Final Consultation (PR-Ready)

### Codex (REQUEST_CHANGES)
Raised two issues, both addressed in implementation but not originally reflected in the plan document:
1. **Stream termination on timeout**: Plan now documents the Promise.race abandonment strategy as accepted trade-off (distinct output files per attempt prevent overlapping writes).
2. **AWAITING_INPUT resume guard missing from plan**: Plan updated to include SHA-256 hash-based resume guard that was already implemented in code.

### Gemini (APPROVE)
- Approved with HIGH confidence
- Noted resume guard simplification (actually implemented with hash check)
- Noted output filename changes need downstream tool compatibility (verified — downstream uses `actualOutputPath` from successful attempt)
