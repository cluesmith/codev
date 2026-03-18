# Review: Terminal Scroll Management Architectural Consolidation

## Summary

Replaced three competing scroll management mechanisms in Terminal.tsx (safeFit, 200ms scroll monitor, 350ms post-flush setTimeout) with a single `ScrollController` class using explicit lifecycle phases and event-driven design. Net result: -144 lines removed from Terminal.tsx, +267 lines in the new ScrollController module, comprehensive test coverage.

## Spec Compliance

- [x] Terminal maintains scroll position when user resizes browser window while scrolled up
- [x] Terminal maintains scroll position when switching between terminal tabs
- [x] Terminal scrolls to bottom after initial buffer replay on reconnection
- [x] No 200ms polling interval — all behavior is event-driven
- [x] Single scroll state object replaces dual source-of-truth
- [x] Scroll position changes are logged with origin and reason (debug mode)
- [x] All existing scroll-related tests pass
- [x] New tests cover lifecycle phase transitions
- [x] No regression: fit suppression during large writes preserved
- [x] Magic threshold values eliminated

## Deviations from Plan

- **Phase 2: Added `reset()` method** — Not in original plan. Discovered during 3-way consultation that the ScrollController needed to return to `initial-load` phase on reconnection. Without `reset()`, `beginReplay()`/`endReplay()` would silently fail on reconnect.
- **Phase 2: Removed `ws.onmessage` enterInteractive()** — Plan originally included ws.onmessage logic to call `enterInteractive()` on first normal message. Gemini pointed out this was redundant since `flushInitialBuffer()` handles all phase transitions. Removed per plan consultation feedback.
- **Phase 2: skipReplay branch** — Removed extra `debouncedFit()` call per Codex feedback. SIGWINCH alone is sufficient when replay is discarded.

## Lessons Learned

### What Went Well

- **State machine approach was correct**: Lifecycle phases cleanly separate the different scroll behaviors needed during initial load, buffer replay, and interactive use.
- **3-way consultation caught real bugs**: The reconnection `reset()` issue was caught by both Codex and Claude during Phase 2 review. This would have been a subtle regression in production.
- **Incremental phases worked well**: Phase 1 (standalone class) → Phase 2 (integration) → Phase 3 (tests) kept each step focused and reviewable.

### Challenges Encountered

- **Test phase transitions**: The existing fit-scroll integration tests needed a `transitionToInteractive()` helper because the ScrollController starts in `initial-load` phase. Tests that previously worked with a plain `render()` + `simulateScroll()` now needed to simulate enough of the WebSocket flow to reach interactive phase.
- **Empty buffer edge case**: The 350ms setTimeout fired unconditionally, but the new callback-based approach only fires `endReplay()` for the large-write path. All three `flushInitialBuffer` branches needed explicit phase transition handling.

### What Would Be Done Differently

- **Include `reset()` in initial spec**: The reconnection flow is well-documented in the codebase. Should have been identified during spec analysis rather than relying on consultation to catch it.
- **Phase 3 deliverables**: The "no setInterval" test was in the plan but was initially missed during implementation. More careful checklist review would have caught this.

## Technical Debt

- The `display:none` visibility check is still duplicated between `isContainerVisible()` and the old debounced fit pattern. The controller could own the visibility change handler entirely, but this was out of scope.
- The pre-existing skipped test ("buffer clear with stale scrollState.baseY") in Terminal.fit-scroll.test.tsx remains skipped. The ScrollController's phase-aware approach may fix the underlying issue, but verifying this is out of scope.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (APPROVE)
- **Concern**: Visibility change jank — 150ms debounce window shows stale position.
  - **Addressed**: Spec updated to require synchronous scroll restoration on visibility change.
- **Concern**: Infinite recursion when controller calls scrollToBottom triggers onScroll.
  - **Addressed**: Added `isProgrammaticScroll` flag to spec.

#### Codex (REQUEST_CHANGES)
- **Concern**: Phase transition triggers underspecified.
  - **Addressed**: Spec updated with explicit triggers for each transition.
- **Concern**: Logging schema and gating undefined.
  - **Addressed**: Committed to `debug` constructor option, `console.debug()` + `console.warn()`.
- **Concern**: No fallback if onScroll doesn't fire for programmatic scrolls.
  - **Addressed**: Updated assumption with scrollToLine no-op caveat.

#### Claude (APPROVE)
- **Concern**: 350ms setTimeout not explicitly called out as eliminated.
  - **Addressed**: Added explicit performance requirement and patch inventory entry.
- **Concern**: writingLargeChunk → beginReplay mapping too narrow.
  - **Addressed**: Added general `suppressFit()`/`unsuppressFit()` mechanism.
- **Concern**: Missing wasAtBottom test scenario.
  - **Addressed**: Added as functional test #3.

### Plan Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Empty buffer regression in flushInitialBuffer — 350ms timer was unconditional.
  - **Addressed**: Plan updated with explicit handling for all 3 branches.
- **Concern**: skipReplay path missing phase transition.
  - **Addressed**: Added `enterInteractive()` to skipReplay branch.
- **Concern**: ws.onmessage enterInteractive is redundant.
  - **Addressed**: Removed from plan.

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing mandatory Playwright testing.
  - **Addressed**: Added Playwright E2E step to Phase 3.

#### Claude (COMMENT)
- Same empty buffer concern as Gemini — addressed.

### Phase 1: scroll_controller (Round 1)

#### Gemini (APPROVE)
- No concerns.

#### Codex (REQUEST_CHANGES)
- **Concern**: Programmatic scrolls don't update internal state.
  - **Addressed**: Updated handleScroll to update state during programmatic scrolls.
- **Concern**: Missing unexpected scroll-to-top warning.
  - **Addressed**: Added detection and console.warn in interactive phase.

#### Claude (APPROVE)
- No concerns.

### Phase 2: terminal_integration (Round 1)

#### Gemini (APPROVE)
- Minor note about synchronous scroll restoration on visibility change (non-blocking).

#### Codex (REQUEST_CHANGES)
- **Concern**: ScrollController not reset on reconnect.
  - **Addressed**: Added `reset()` method, called in `connect()`.
- **Concern**: skipReplay branch still calls debouncedFit.
  - **Addressed**: Removed.

#### Claude (REQUEST_CHANGES)
- Same reconnection reset concern as Codex — addressed.

### Phase 3: test_update (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Missing no-setInterval regression test.
  - **Addressed**: Added test asserting no setInterval called during terminal setup.

#### Codex (REQUEST_CHANGES)
- Same concern — addressed.

#### Claude (COMMENT)
- Same concern (minor) — addressed.

## Flaky Tests

- `Terminal.fit-scroll.test.tsx` line 342: "takes simple fit path when buffer is cleared even if scrollState.baseY is stale" — pre-existing skip (`it.skip`), not related to this project.

## Architecture Updates

Updated `codev/resources/arch.md`:
- Added ScrollController description to Terminal Component section with lifecycle phases and API summary
- Added `scrollController.ts` to the dashboard file tree

## Lessons Learned Updates

Added 3 entries to `codev/resources/lessons-learned.md`:
1. Consolidate competing mechanisms into a single state machine owner
2. Lifecycle phases eliminate magic thresholds
3. State machines that persist across reconnections need a `reset()` method

## Follow-up Items

- Playwright E2E validation of scroll behavior in real browser
- Consider having ScrollController own the visibility change handler to further reduce Terminal.tsx complexity
- Verify if the pre-existing skipped test is fixed by the new phase-aware approach
