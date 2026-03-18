# Specification: Terminal Scroll Management Architectural Consolidation

## Metadata
- **ID**: spec-627-terminal-scroll-management
- **Status**: draft
- **Created**: 2026-03-17
- **GitHub Issue**: #627

## Clarifying Questions Asked

The GitHub issue provides extensive analysis. Key questions derived from the issue and codebase review:

1. **Q: What are all the competing scroll mechanisms?**
   A: Three mechanisms compete — `safeFit()` (save/restore around fit), post-flush `setTimeout` (350ms delay scrollToBottom), and scroll monitor (200ms `setInterval` auto-correction). All three share a single `scrollState` object but update/read it at different times, creating race conditions.

2. **Q: What is the dual source-of-truth problem?**
   A: xterm's `buffer.active.viewportY`/`baseY` resets to 0 during `display:none` transitions (tab switches, panel collapse). An external `scrollState` object was added (Bugfix #560) to track "true" scroll position, but now both are used inconsistently — some code reads from xterm, some from `scrollState`.

3. **Q: What are the lifecycle phases where scroll behavior should differ?**
   A: Three distinct phases: (a) initial-load — terminal just mounted, no content yet; (b) buffer-replay — reconnection replaying buffered content, should always end at bottom; (c) interactive — user is actively working, scroll position should be preserved across resize/tab-switch.

4. **Q: Can the polling-based scroll monitor be replaced?**
   A: Yes. xterm.js provides `onScroll` events. The 200ms `setInterval` was added because `onScroll` rejection guards prevented legitimate corrections. With a proper state machine, the `onScroll` handler can both reject spurious resets AND trigger corrections, eliminating the need for polling.

5. **Q: What are the magic thresholds and why are they problematic?**
   A: The onScroll handler uses `viewportY > 5` and `baseY > 10` as thresholds to distinguish "real" scroll events from spurious resets. These are arbitrary and can reject real events (e.g., user scrolled to line 3) or accept spurious ones (terminal with exactly 5 lines of scrollback).

## Problem Statement

The Terminal component in `packages/codev/dashboard/src/components/Terminal.tsx` has accumulated 6+ separate bugfix patches (#423, #442, #451, #522, #560, #573, #625) that each address scroll/resize symptoms independently. These patches now fight each other:

- **safeFit()** saves and restores scroll position around `fitAddon.fit()` calls using an external `scrollState` object
- **Post-flush setTimeout** fires 350ms after buffer replay to call `scrollToBottom()` and force `scrollState.wasAtBottom = true`
- **Scroll monitor** polls every 200ms via `setInterval` to detect and auto-correct scroll-to-top resets

The result is a system where:
1. A resize triggers `safeFit()` which restores position
2. The scroll monitor may detect the position change and "correct" it
3. If this was after a reconnection, the 350ms timer may fire and override both
4. The `onScroll` handler may reject the resulting scroll event as "spurious"

The current symptom: after the #625 fix, the terminal scrolls to the top instead of maintaining position after resize/tab-switch.

## Current State

The scroll management code spans ~120 lines across Terminal.tsx (lines 327-418, 494-516, 718-743) with the following structure:

**Mechanism 1 — safeFit() (lines 373-418):**
- Wraps `fitAddon.fit()` with scroll position save/restore
- Reads from external `scrollState`, not xterm buffer
- Has a `writingLargeChunk` early-return guard
- Falls back to `scrollToBottom()` when state seems corrupted

**Mechanism 2 — Post-flush setTimeout (lines 509-516):**
- Fires 350ms after initial buffer replay
- Unconditionally calls `scrollToBottom()` and sets `scrollState.wasAtBottom = true`
- Also sends a resize control message to the PTY

**Mechanism 3 — Scroll monitor (lines 724-743):**
- 200ms `setInterval` polling loop
- Detects `viewportY` transition to 0 when `lastMonitorViewportY > 10` and `baseY > 10`
- Auto-corrects using `scrollState`

**Shared state — scrollState object (line 333):**
- `{ viewportY: 0, baseY: 0, wasAtBottom: true }`
- Updated by `onScroll` handler (lines 345-366)
- Read by all three mechanisms
- Has three rejection guards with magic thresholds (`viewportY > 5`, `baseY > 0`, `baseY > 10`)

**Additional complexity:**
- `writingLargeChunk` flag (line 337) gates `safeFit()` during large writes
- `debouncedFit()` (lines 424-430) with 150ms debounce wraps `safeFit()`
- Container visibility checks duplicated in all three mechanisms
- ResizeObserver triggers `debouncedFit()` (line 709)
- Visibility change triggers `debouncedFit()` (line 714)

## Desired State

A single, unified scroll management system that:

1. **Has one source of truth** — a scroll controller object that owns all scroll state and position changes
2. **Uses explicit lifecycle phases** — initial-load, buffer-replay, and interactive — with clear rules for each
3. **Is event-driven** — reacts to xterm events and ResizeObserver, no polling
4. **Consolidates all scroll logic** — one place to understand, debug, and modify scroll behavior
5. **Produces structured logs** — every scroll position change is logged with who changed it and why
6. **Eliminates magic thresholds** — uses lifecycle phase awareness instead of arbitrary numbers to distinguish real vs spurious events

## Stakeholders
- **Primary Users**: Developers using Codev terminals who scroll through build output, logs, and command history
- **Secondary Users**: All Codev dashboard users who resize windows or switch tabs
- **Technical Team**: Codev maintainers who need to understand and debug scroll behavior

## Success Criteria
- [ ] Terminal maintains scroll position when user resizes browser window while scrolled up in history
- [ ] Terminal maintains scroll position when switching between terminal tabs
- [ ] Terminal scrolls to bottom after initial buffer replay on reconnection
- [ ] No 200ms polling interval — all behavior is event-driven
- [ ] Single scroll state object replaces dual source-of-truth (external scrollState + xterm buffer)
- [ ] Scroll position changes are logged with origin (who) and reason (why)
- [ ] All existing scroll-related tests pass (Terminal.fit-scroll, Terminal.replay-scroll, Terminal.scroll)
- [ ] New tests cover lifecycle phase transitions (initial-load → buffer-replay → interactive)
- [ ] No regression: `writingLargeChunk` protection during large writes is preserved
- [ ] Magic threshold values (`viewportY > 5`, `baseY > 10`, `lastMonitorViewportY > 10`) are eliminated

## Constraints

### Technical Constraints
- Must use xterm.js APIs (`onScroll`, `buffer.active.viewportY`, `buffer.active.baseY`, `scrollToBottom`, `scrollToLine`)
- Must work with `FitAddon` which triggers buffer reflow on `fit()`
- Must handle `display:none` transitions that cause xterm buffer state to reset to 0
- The `writingLargeChunk` guard must be preserved — `fitAddon.fit()` mid-write causes garbled rendering
- The `debouncedFit()` pattern should be preserved to coalesce multiple resize triggers
- Must not break reconnection flow (seq-based resume, initial buffer batching, DA sequence filtering)

### Scope Constraints
- This spec covers scroll position management only
- Reconnection logic (#442, #451) is out of scope — only the scroll-related parts of reconnection are in scope
- WebSocket management, PTY communication, and terminal rendering are out of scope
- File path link decorations and virtual keyboard are out of scope

## Assumptions
- xterm.js `onScroll` fires reliably for programmatic scroll changes (scrollToBottom, scrollToLine) — **caveat**: `scrollToLine()` to the same line is a no-op and won't fire `onScroll`. The controller must update internal state *before* calling scroll methods, not rely solely on the event to confirm.
- xterm.js `buffer.active.viewportY` correctly reports 0 during display:none (this is the known behavior we must handle)
- ResizeObserver fires with 0x0 dimensions when container becomes hidden
- The 350ms post-flush delay is a timing hack that can be replaced with event-driven completion detection

## Solution Approaches

### Approach 1: ScrollController State Machine (Recommended)

**Description**: Extract all scroll management into a dedicated `ScrollController` class with explicit lifecycle phases and event-driven state transitions.

The ScrollController:
- Owns a single `ScrollState` with phase (`initial-load` | `buffer-replay` | `interactive`), `viewportY`, `baseY`, and `wasAtBottom`
- Provides methods: `safeFit()`, `onScrollEvent()`, `beginReplay()`, `endReplay()`, `scrollToBottom()`
- Subscribes to xterm's `onScroll` internally
- Logs all state transitions with structured metadata
- Container visibility checks happen once in the controller, not duplicated

Phase-specific behavior:
- **initial-load**: All scroll events ignored. No fit corrections. Transitions to `buffer-replay` when `beginReplay()` is called (from `flushInitialBuffer()`), or directly to `interactive` when the first normal WebSocket message arrives without a replay phase.
- **buffer-replay**: Scroll events ignored (replay writes will generate many). `safeFit()` deferred (fit suppression active). Transitions to `interactive` when `endReplay()` is called from the `term.write()` completion callback — this replaces the 350ms setTimeout with deterministic callback-based detection.
- **interactive**: Full scroll tracking active. `safeFit()` preserves position. Spurious reset detection uses phase awareness (not thresholds). Container visibility checks gate all operations.

**Fit suppression**: The controller exposes a general `suppressFit()`/`unsuppressFit()` mechanism (used by `beginReplay()`/`endReplay()` internally). This ensures fit suppression works for any large write, not just replay — e.g., if large paste support is added in the future.

**Programmatic scroll guard**: When the controller calls `term.scrollToBottom()` or `term.scrollToLine()`, it sets an internal `isProgrammaticScroll` flag before the call and clears it after. This prevents the `onScroll` handler from treating controller-initiated scrolls as user events, avoiding infinite recursion or state bouncing.

**Pros**:
- Single source of truth
- Clear phase-based behavior eliminates timing races
- Event-driven eliminates polling
- Testable in isolation
- Structured logging built-in
- Easy to reason about and debug

**Cons**:
- Largest refactor of the three approaches
- Risk of regression during transition
- Need to carefully handle all edge cases the patches addressed

**Estimated Complexity**: Medium-High
**Risk Level**: Medium

### Approach 2: Minimal Consolidation (Keep Mechanisms, Unify State)

**Description**: Keep the three mechanisms but extract them into a single module with a shared state object and clear ownership rules.

- Move `scrollState`, `onScroll` handler, `safeFit`, and scroll monitor into a `scrollManager.ts` module
- Add phase tracking as a field on the shared state
- Replace magic thresholds with phase checks
- Keep the 200ms polling as a safety net but add phase guards

**Pros**:
- Smaller diff
- Lower regression risk
- Preserves battle-tested mechanisms

**Cons**:
- Three mechanisms still compete
- Polling still exists
- Timing races still possible between mechanisms
- Doesn't solve the architectural problem, just moves it

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 3: xterm.js Decoration API Approach

**Description**: Use xterm.js's marker/decoration API to anchor scroll position to a specific line, letting xterm handle position preservation natively across reflows.

**Pros**:
- Leverages xterm's built-in capabilities
- Minimal custom scroll management code

**Cons**:
- Decoration API isn't designed for scroll anchoring
- Still need custom handling for display:none transitions
- Still need replay phase management
- Most of the complexity remains

**Estimated Complexity**: Medium
**Risk Level**: High (unproven approach)

## Recommended Approach

**Approach 1: ScrollController State Machine**

The current architecture's fundamental problem is that three independent mechanisms compete without coordination. Approaches 2 and 3 don't address this root cause. The ScrollController provides:

1. **Phase awareness** eliminates timing races — during buffer-replay, scroll events are ignored entirely, so there's no need for magic thresholds or the 200ms correction loop
2. **Event-driven design** eliminates polling — the write callback from `term.write()` signals replay completion, not a 350ms setTimeout
3. **Single ownership** eliminates dual source-of-truth — the controller owns scroll state and is the only thing that reads/writes it

## Open Questions

### Critical (Blocks Progress)
- [x] None — the issue analysis is thorough and the codebase is well-understood

### Important (Affects Design)
- [x] Should the ScrollController be a class or a plain factory function returning an interface? **Decision: Class** — provides encapsulation, testability, and clear lifecycle (constructor/dispose).
- [x] Should structured scroll logs be gated behind a debug flag, or always-on? **Decision: Gated behind a `debug` constructor option** (default `false`). Logs use `console.debug()` so they're filterable in browser devtools. Critical warnings (e.g., unexpected scroll-to-top in interactive phase) always log via `console.warn()`.

### Nice-to-Know (Optimization)
- [ ] Can the 150ms debounce on fit() be reduced now that phase awareness prevents spurious fits during replay?

## Performance Requirements
- **No polling**: Replace 200ms setInterval with event-driven approach
- **No timing hacks**: The 350ms post-flush setTimeout (lines 509-516) is explicitly eliminated — replaced by the `term.write()` completion callback triggering `endReplay()`, which transitions the controller to interactive phase and calls `scrollToBottom()` deterministically
- **Fit debounce**: Maintain <=150ms debounce for resize coalescing
- **No jank**: Scroll position restoration must happen synchronously after fit() — no visible jump. For visibility change events, the controller should synchronously restore scroll position from its tracked state even if the actual `fitAddon.fit()` is debounced

## Security Considerations
- No security implications — this is purely UI scroll management
- No user data or authentication involved

## Test Scenarios

### Functional Tests
1. **Interactive resize**: User scrolled to line N, window resizes, scroll position preserved at line N
2. **Interactive resize at bottom**: User at bottom, window resizes, stays at bottom
3. **User scrolls to bottom then resize**: User manually scrolls to bottom, `wasAtBottom` tracked correctly, resize stays at bottom
4. **Tab switch preservation**: User scrolled up, switches to another terminal tab and back, position preserved
5. **Buffer replay**: Reconnection replays buffered content, terminal ends at bottom
6. **Large write during resize**: Large buffer write while resize occurs — no garbled rendering (fit suppression active)
7. **Display:none transition**: Container hidden and shown — scroll position preserved
8. **Phase transitions**: initial-load → buffer-replay → interactive with correct behavior at each stage
9. **Direct to interactive**: First message is normal (no replay) → transitions straight from initial-load to interactive

### Non-Functional Tests
1. **No polling**: Verify no setInterval in scroll management code
2. **Log structure**: Verify scroll changes produce structured log entries with origin and reason
3. **Cleanup**: Verify all event listeners and subscriptions are properly disposed

## Dependencies
- **xterm.js**: `@xterm/xterm` — `onScroll`, `scrollToBottom`, `scrollToLine`, `buffer.active`
- **FitAddon**: `@xterm/addon-fit` — `fit()` method
- **ResizeObserver**: Browser API for container dimension changes

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Regression in scroll behavior | Medium | High | Comprehensive test suite covering all existing bugfix scenarios; keep existing tests passing |
| Edge case missed by phase model | Low | Medium | Structured logging enables rapid diagnosis; the three lifecycle phases cover all observed usage patterns |
| xterm.js onScroll not firing for some cases | Low | Medium | Verify during implementation; fallback to manual position check after programmatic scrolls |
| Display:none still causes issues | Medium | Medium | Phase-aware handler + container visibility check preserved from current code |

## Notes

### Patch Inventory (for reference during implementation)
| Bug | Current Patch | What the ScrollController Replaces |
|-----|--------------|-----------------------------------|
| #423 | safeFit() — save/restore scroll around fit() | ScrollController.safeFit() with phase awareness |
| #442, #451 | Reconnection with seq numbers, initial buffer batching | Out of scope (reconnection logic stays) — only scroll parts absorbed |
| #560 | External scrollState tracking | ScrollController owns the single source of truth |
| #573 | Reject fake scroll events (3 guards) + scroll monitor | Phase-aware onScroll handler eliminates both guards and monitor |
| #625 | writingLargeChunk flag defers fit | ScrollController.suppressFit()/unsuppressFit() (called by beginReplay/endReplay) replaces flag |
| — | 350ms post-flush setTimeout (lines 509-516) | Eliminated entirely — `term.write()` callback calls `endReplay()` which handles scroll-to-bottom deterministically |

## Expert Consultation

**Date**: 2026-03-17
**Models Consulted**: Gemini, Codex (GPT-5.2), Claude
**Round**: 1 (post-initial-draft)

### Gemini (APPROVE, HIGH confidence)
- **Visibility change jank**: Noted that `visibilitychange` → `debouncedFit()` has a 150ms window where viewport shows stale position. **Incorporated**: Spec now requires synchronous scroll restoration from tracked state on visibility change, even if fit is debounced.
- **Infinite recursion guard**: Controller's `scrollToBottom()`/`scrollToLine()` calls trigger `onScroll` events. **Incorporated**: Added `isProgrammaticScroll` flag to prevent the controller from reacting to its own scroll commands.

### Codex (REQUEST_CHANGES, MEDIUM confidence)
- **Phase transition triggers underspecified**: Wanted concrete definitions for what triggers each phase transition. **Incorporated**: Phase behavior section now specifies exact triggers: `beginReplay()` called from `flushInitialBuffer()`, `endReplay()` from `term.write()` callback, direct-to-interactive on first normal WebSocket message.
- **Logging schema and gating**: Wanted defined schema and toggle mechanism. **Incorporated**: Open questions section now commits to `debug` constructor option (default false), `console.debug()` for filterable logs, `console.warn()` for critical warnings.
- **onScroll fallback**: Wanted fallback if `onScroll` doesn't fire for programmatic scrolls. **Incorporated**: Updated assumption with caveat about scrollToLine no-ops; controller updates state before calling scroll methods.

### Claude (APPROVE, HIGH confidence)
- **350ms setTimeout not explicitly called out**: The most problematic timing hack was only implicitly eliminated. **Incorporated**: Added explicit performance requirement and patch inventory entry stating the 350ms setTimeout is eliminated by callback-based `endReplay()`.
- **writingLargeChunk → beginReplay mapping too narrow**: Fit suppression should work for any large write, not just replay. **Incorporated**: Added general `suppressFit()`/`unsuppressFit()` mechanism that `beginReplay()`/`endReplay()` uses internally.
- **Missing wasAtBottom test scenario**: No test for user scrolls to bottom → resize → stays at bottom. **Incorporated**: Added as functional test #3.

---

## Amendments

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
