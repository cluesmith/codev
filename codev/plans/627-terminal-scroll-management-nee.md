# Plan: Terminal Scroll Management Architectural Consolidation

## Metadata
- **ID**: plan-627-terminal-scroll-management
- **Status**: draft
- **Specification**: codev/specs/627-terminal-scroll-management-nee.md
- **Created**: 2026-03-18

## Executive Summary

Replace the three competing scroll mechanisms in Terminal.tsx (safeFit, post-flush setTimeout, scroll monitor) with a single `ScrollController` class. The controller uses explicit lifecycle phases (initial-load → buffer-replay → interactive) and event-driven design to eliminate polling, magic thresholds, and timing races.

The implementation is broken into 3 phases: (1) create the ScrollController class with tests, (2) integrate it into Terminal.tsx replacing existing scroll code, (3) update existing tests and add phase transition tests.

## Success Metrics
- [ ] All specification criteria met (10 success criteria from spec)
- [ ] All existing scroll-related tests pass (Terminal.fit-scroll, Terminal.replay-scroll, Terminal.scroll)
- [ ] New unit tests for ScrollController with >90% coverage
- [ ] No 200ms setInterval, no 350ms setTimeout hack, no magic thresholds
- [ ] Zero regressions in terminal scroll behavior

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "scroll_controller", "title": "Phase 1: ScrollController Class"},
    {"id": "terminal_integration", "title": "Phase 2: Terminal.tsx Integration"},
    {"id": "test_update", "title": "Phase 3: Test Suite Update"}
  ]
}
```

## Phase Breakdown

### Phase 1: ScrollController Class
**Dependencies**: None

#### Objectives
- Create a standalone `ScrollController` class that encapsulates all scroll state management
- Make it fully testable in isolation (no React, no DOM dependencies beyond what's injected)

#### Deliverables
- [ ] `packages/codev/dashboard/src/lib/scrollController.ts` — the ScrollController class
- [ ] `packages/codev/dashboard/__tests__/scrollController.test.ts` — unit tests for the class
- [ ] All unit tests pass

#### Implementation Details

**File: `packages/codev/dashboard/src/lib/scrollController.ts`**

The `ScrollController` class accepts injected dependencies (xterm Terminal instance, FitAddon, container element getter) and owns all scroll state.

**Constructor parameters:**
```typescript
interface ScrollControllerOptions {
  term: Terminal;                           // xterm Terminal instance
  fitAddon: FitAddon;                       // FitAddon for fit() calls
  getContainer: () => HTMLElement | null;    // Container element getter (for visibility checks)
  debug?: boolean;                          // Enable structured logging (default: false)
}
```

**Internal state:**
```typescript
type Phase = 'initial-load' | 'buffer-replay' | 'interactive';

interface ScrollState {
  phase: Phase;
  viewportY: number;
  baseY: number;
  wasAtBottom: boolean;
  fitSuppressed: boolean;       // True during large writes
  isProgrammaticScroll: boolean; // True during controller-initiated scrolls
}
```

**Public methods:**
- `safeFit(): void` — Replaces the existing safeFit(). Phase-aware: skips during buffer-replay (fitSuppressed), preserves position during interactive, just fits during initial-load.
- `beginReplay(): void` — Transitions from initial-load to buffer-replay. Sets fitSuppressed=true.
- `endReplay(): void` — Transitions from buffer-replay to interactive. Sets fitSuppressed=false. Scrolls to bottom. Triggers a deferred fit.
- `enterInteractive(): void` — Transitions from initial-load directly to interactive (no replay case).
- `suppressFit(): void` / `unsuppressFit(): void` — General fit suppression (beginReplay/endReplay use internally).
- `scrollToBottom(): void` — Wrapper that sets isProgrammaticScroll before calling term.scrollToBottom().
- `isContainerVisible(): boolean` — Container visibility check (shared by all operations).
- `dispose(): void` — Cleans up the onScroll subscription.
- `get phase(): Phase` — Read-only access to current phase.
- `get state(): Readonly<ScrollState>` — Read-only snapshot of current state.

**onScroll handler (internal):**
- Subscribes to `term.onScroll` in constructor
- If `isProgrammaticScroll` → update internal state only, no corrections
- If phase is `initial-load` or `buffer-replay` → ignore entirely
- If phase is `interactive`:
  - If container not visible → ignore (display:none reset)
  - Otherwise → update viewportY, baseY, wasAtBottom from `term.buffer.active`
  - Update internal state *before* the event fires for scroll methods

**Structured logging:**
- When `debug=true`, logs via `console.debug()` with format: `[ScrollController] {action} {details}`
- Critical warnings (unexpected scroll-to-top in interactive) always log via `console.warn()`

#### Acceptance Criteria
- [ ] ScrollController can be instantiated with mock xterm/fitAddon
- [ ] Phase transitions work: initial-load → buffer-replay → interactive, initial-load → interactive
- [ ] safeFit() preserves scroll position in interactive phase
- [ ] safeFit() is a no-op when fitSuppressed=true
- [ ] safeFit() skips when container is invisible
- [ ] onScroll handler ignores events during non-interactive phases
- [ ] onScroll handler ignores events when container is invisible
- [ ] isProgrammaticScroll prevents onScroll from treating controller scrolls as user events
- [ ] endReplay() scrolls to bottom and triggers fit
- [ ] dispose() cleans up onScroll subscription

#### Test Plan
- **Unit Tests**: Test each method independently with mock xterm. Test phase transitions. Test onScroll filtering. Test visibility check gating.
- **Edge Cases**: scrollToLine to same position (no-op), endReplay when already interactive, safeFit with empty buffer, safeFit with stale scrollState after buffer clear.

#### Rollback Strategy
Phase 1 creates a new file only — no existing code is modified. Rollback = delete the file.

#### Risks
- **Risk**: ScrollController API doesn't map cleanly to Terminal.tsx integration points
  - **Mitigation**: Design API based on actual Terminal.tsx call sites (identified during spec analysis)

---

### Phase 2: Terminal.tsx Integration
**Dependencies**: Phase 1

#### Objectives
- Replace all existing scroll management code in Terminal.tsx with ScrollController usage
- Remove the 200ms scroll monitor, 350ms post-flush setTimeout, magic thresholds, and dual state tracking
- Preserve all existing behavior (scroll preservation on resize, tab switch, replay)

#### Deliverables
- [ ] Terminal.tsx updated: existing scroll code replaced with ScrollController
- [ ] No `setInterval` in scroll management
- [ ] No 350ms setTimeout hack
- [ ] No magic threshold values
- [ ] All existing functionality preserved

#### Implementation Details

**File: `packages/codev/dashboard/src/components/Terminal.tsx`**

**Removals (from the useEffect that sets up the terminal):**
- Lines 327-337: Remove `scrollState` object and `writingLargeChunk` flag declarations
- Lines 339-366: Remove onScroll handler with magic thresholds
- Lines 373-418: Remove standalone `safeFit()` function
- Lines 509-516: Remove 350ms post-flush setTimeout
- Lines 718-743: Remove 200ms scroll monitor setInterval

**Additions:**
- Import `ScrollController` from `../lib/scrollController.js`
- After creating the xterm Terminal and FitAddon instances, instantiate `ScrollController`:
  ```
  const scrollCtrl = new ScrollController({
    term, fitAddon, getContainer: () => containerRef.current
  });
  ```
- Replace `safeFit()` calls with `scrollCtrl.safeFit()`
- Replace `debouncedFit` to wrap `scrollCtrl.safeFit()` instead of the standalone function
- In `flushInitialBuffer()`:
  - Call `scrollCtrl.beginReplay()` before `term.write()`
  - In the `term.write()` callback: call `scrollCtrl.endReplay()` (replaces `writingLargeChunk=false` + `scrollToBottom()` + `scrollState.wasAtBottom=true` + `debouncedFit()`)
  - Remove the 350ms setTimeout entirely — `endReplay()` handles scroll-to-bottom and fit
  - After `endReplay()`, send the resize control message to PTY (the SIGWINCH that was in the 350ms timer)
- In the `ws.onmessage` handler: if first real message and not in replay phase, call `scrollCtrl.enterInteractive()`
- In cleanup: call `scrollCtrl.dispose()` and remove the `clearInterval(scrollMonitor)` and `scrollDisposable.dispose()`
- For visibility change handler: call `scrollCtrl.safeFit()` (via debouncedFit, same as before)

**Preserved (not touched):**
- `debouncedFit()` wrapper (still coalesces with 150ms debounce)
- ResizeObserver → debouncedFit flow
- Visibility change → debouncedFit flow
- Reconnection logic (seq tracking, initial buffer batching, DA filtering)
- `sendControl()` for PTY resize
- WebSocket management, PTY communication

#### Acceptance Criteria
- [ ] No `scrollState` object, `writingLargeChunk` flag, or standalone `safeFit()` in Terminal.tsx
- [ ] No `setInterval` for scroll monitoring
- [ ] No 350ms `setTimeout` in `flushInitialBuffer`
- [ ] No magic thresholds (`viewportY > 5`, `baseY > 10`, `lastMonitorViewportY > 10`)
- [ ] ScrollController is instantiated and disposed correctly
- [ ] Resize preserves scroll position (existing behavior)
- [ ] Buffer replay ends at bottom (existing behavior)
- [ ] Tab switch preserves scroll position (existing behavior)

#### Test Plan
- **Integration Tests**: Run existing Terminal.fit-scroll.test.tsx and Terminal.replay-scroll.test.tsx — all tests must pass
- **Manual Testing**: Resize while scrolled up, tab switch, reconnection replay

#### Rollback Strategy
Git revert the Terminal.tsx changes — Phase 1's ScrollController file can remain as unused code.

#### Risks
- **Risk**: Existing tests break due to changed internal structure
  - **Mitigation**: Phase 3 updates tests to match new structure while preserving test intent
- **Risk**: Timing difference in replay completion (callback vs 350ms)
  - **Mitigation**: The callback approach is more deterministic — if tests relied on exact 350ms timing, they'll be updated in Phase 3

---

### Phase 3: Test Suite Update
**Dependencies**: Phase 2

#### Objectives
- Update existing scroll tests to work with the new ScrollController architecture
- Add new tests for lifecycle phase transitions
- Ensure comprehensive coverage of the consolidated scroll system

#### Deliverables
- [ ] `Terminal.fit-scroll.test.tsx` updated for ScrollController
- [ ] `Terminal.replay-scroll.test.tsx` updated for ScrollController (especially the 350ms timer test)
- [ ] New test cases for phase transitions (initial-load → interactive, initial-load → buffer-replay → interactive)
- [ ] New test case for wasAtBottom tracking (user scrolls to bottom → resize → stays at bottom)
- [ ] New test case for no setInterval in scroll code
- [ ] All tests pass

#### Implementation Details

**Terminal.fit-scroll.test.tsx updates:**
- Tests should continue to work as-is since they test external behavior (scroll position after resize), not internal implementation
- The `simulateScroll` helper still works — it calls the onScroll callback which now goes through ScrollController
- If any test relies on the scroll monitor's behavior, update to test the same behavior through ScrollController

**Terminal.replay-scroll.test.tsx updates:**
- The test "calls scrollToBottom again after deferred fit + resize (350ms)" — this test verifies the 350ms setTimeout behavior. Update: the scrollToBottom now happens in the `term.write()` callback via `endReplay()`, not after a 350ms delay. The test should verify scrollToBottom is called after the write callback completes (which happens synchronously in the mock).
- The test "sends a forced resize to PTY after replay flush" — the SIGWINCH now fires after `endReplay()` in the write callback, not after 350ms. Update timing expectations.

**New test cases to add (in Terminal.fit-scroll.test.tsx or new file):**
1. **Phase transition: initial-load → interactive**: First normal message transitions to interactive, scroll tracking is active
2. **Phase transition: initial-load → buffer-replay → interactive**: Replay flow transitions correctly, scroll is at bottom after
3. **wasAtBottom preservation**: User at bottom, resize, stays at bottom (success criterion from spec)
4. **No setInterval**: Assert no `setInterval` used for scroll management (grep the built code or verify via timer tracking)
5. **Fit suppression during replay**: safeFit() returns early during buffer-replay phase

#### Acceptance Criteria
- [ ] All existing tests pass (may be modified but test intent preserved)
- [ ] New phase transition tests pass
- [ ] wasAtBottom test passes
- [ ] No test relies on 350ms setTimeout timing
- [ ] No test relies on 200ms setInterval behavior

#### Test Plan
- **Run full test suite**: `npm test` from packages/codev
- **Verify no regressions**: All Terminal.*.test.tsx files pass

#### Rollback Strategy
Tests can be reverted independently since they don't affect runtime behavior.

#### Risks
- **Risk**: Mock structure needs updating for ScrollController
  - **Mitigation**: ScrollController accepts injected dependencies — existing mocks work unchanged

---

## Dependency Map
```
Phase 1 (ScrollController) ──→ Phase 2 (Terminal.tsx Integration) ──→ Phase 3 (Test Suite Update)
```

Linear dependency chain — each phase builds on the previous.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Regression in scroll behavior after integration | Medium | High | Run all existing tests after Phase 2; fix in Phase 3 |
| onScroll event doesn't fire for some xterm operations | Low | Medium | Controller updates state before calling scroll methods |
| Timing differences break replay tests | Medium | Low | Update tests in Phase 3 to match callback-based approach |

## Validation Checkpoints
1. **After Phase 1**: ScrollController unit tests pass in isolation. Class API is stable.
2. **After Phase 2**: Terminal.tsx compiles. Existing tests run (some may fail due to timing changes).
3. **After Phase 3**: All tests pass. No regressions. Full coverage.

## Documentation Updates Required
- [ ] Update `codev/resources/arch.md` with ScrollController module description

## Notes

The skipped test in Terminal.fit-scroll.test.tsx (line 321, "buffer clear with stale scrollState.baseY") is a pre-existing flaky test. This will remain skipped — the ScrollController's phase-aware approach may actually fix the underlying issue, but verifying this is out of scope for this project.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
