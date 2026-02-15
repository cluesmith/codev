# Review: Consolidate Shellper Session Creation

## Summary

Extracted duplicated session creation defaults (cols, rows, restartOnExit) from 7 call sites across 5 files into a single `defaultSessionOptions()` factory function in `terminal/index.ts`. Pure refactor with zero behavior change.

## Spec Compliance

- [x] All shellper session creation flows through one shared function for default options
- [x] No raw `cols: DEFAULT_COLS, rows: DEFAULT_ROWS` literals outside the factory function (except `shellper-process.ts` class member defaults and `tower-routes.ts` post-spread override, both by design)
- [x] Existing tests pass without modification (behavior unchanged)
- [x] `spawn-worktree.ts` uses the same constants for its HTTP body
- [x] Detached shellper sections removed from spec (deferred to separate project)

## Deviations from Plan

- **Env setup excluded from factory**: The spec mentioned "common env setup" but the plan correctly identified that env patterns vary significantly across call sites. The factory focuses on truly common defaults: cols, rows, and restartOnExit.
- **`shellper-process.ts` excluded**: Uses `DEFAULT_COLS`/`DEFAULT_ROWS` as class member defaults, not session creation. Constants remain exported for this use.

## Implementation Details

### Phase 1: Create Factory Function
- Added `SessionDefaults` interface and `defaultSessionOptions()` function to `terminal/index.ts`
- Accepts `Partial<SessionDefaults>` overrides via spread
- 6 unit tests covering defaults, overrides, and object identity

### Phase 2: Refactor Call Sites
- **tower-routes.ts**: 2 call sites — spread defaults, preserve `cols || DEFAULT_COLS` falsy-check
- **tower-instances.ts**: 1 call site — spread with restart overrides
- **spawn-worktree.ts**: 1 call site — destructure cols/rows for HTTP body
- **pty-manager.ts**: 2 call sites — `createSession` uses defaults variable with `??`, `createSessionRaw` destructures
- **session-manager.ts**: 1 call site — spread with reconnect restart options

## Lessons Learned

### What Went Well
- Clear plan with explicit per-call-site instructions prevented behavioral regressions
- The plan's risk callouts (falsy vs nullish checks, undefined spread danger) were accurate and prevented bugs
- Factory function pattern is simple and easy to verify

### Challenges Encountered
- **Porch codex JSONL parsing bug**: Codex output uses OpenAI Agent SDK JSONL format that porch's verdict parser can't parse, defaulting to REQUEST_CHANGES. This caused 12+ unnecessary consultation iterations across both phases. The actual codex verdict was always APPROVE.
- **Claude reviewer read wrong filesystem**: In iteration 3, Claude claimed the implementation didn't exist — it was reading files from the main branch rather than the worktree.

### What Would Be Done Differently
- Fix the codex JSONL parsing issue in porch before starting the next project to avoid wasted consultation cycles
- The max_iterations safety net (7) eventually allowed progression but burned significant time and API costs

### Methodology Improvements
- Porch should handle the codex JSONL format in `usage-extractor.ts` to avoid false positive REQUEST_CHANGES
- Consider adding a "builder override" mechanism for when all reviewers actually approve but parsing fails

## Technical Debt
- None introduced. Pure refactor.

## Follow-up Items
- Fix codex JSONL parsing in porch (separate issue)
- Detached shellper process deferred to spec 0118 or future project
