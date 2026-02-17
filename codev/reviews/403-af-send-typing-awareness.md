# Review: af-send-typing-awareness

## Summary

Implemented typing-aware message delivery for `af send`. When a user is actively typing in a terminal session, incoming messages are buffered and delivered after a 3-second idle period (or 60-second max age). This prevents message injection from corrupting the architect's in-progress input.

## Spec Compliance

- [x] Messages are delayed when user is actively typing
- [x] Messages are delivered promptly when user is idle (3s threshold)
- [x] Buffered messages include a maximum age (60s) after which they deliver regardless
- [x] `af send` returns 200 immediately with `deferred: true/false` indicator
- [x] No messages are lost (buffer survives until delivery or max age; force flush on shutdown)
- [x] Works correctly when multiple messages arrive while typing (delivered in order)
- [x] Approach selection documented with rationale in plan

## Approach Selection

Selected **Approach 1: Idle Detection** over Approach 2 (Queue Until Submit). Rationale:
- Simpler to implement (timestamp + timer vs. state machine + Enter detection)
- No edge cases with editors (vim/nano Enter) or sub-applications
- 3-second threshold is a reasonable trade-off — most typing pauses are shorter
- Works with any terminal application, not just Claude Code

## Implementation Summary

### Phase 1: Input Tracking on PtySession
- Added `_lastInputAt`, `recordUserInput()`, `isUserIdle(thresholdMs)`, `lastInputAt` to `PtySession`
- Called `recordUserInput()` on data frames in `pty-manager.ts` and `tower-websocket.ts`
- Included raw-input fallback paths per consultation feedback

### Phase 2: Message Buffering and Delivery
- Created `SendBuffer` class in `send-buffer.ts` with per-session queuing
- Modified `handleSend` in `tower-routes.ts` to check idle state and defer/deliver
- Added `startSendBuffer()`/`stopSendBuffer()` lifecycle wiring in `tower-server.ts`
- Interrupt (`Ctrl+C`) bypasses buffering entirely
- Force flush on graceful shutdown ensures no message loss

## Deviations from Plan

No deviations. Implementation followed the plan exactly.

## Test Coverage

- `typing-awareness.test.ts`: 11 tests for PtySession input tracking
- `send-buffer.test.ts`: 10 tests for SendBuffer (enqueue, idle delivery, typing suppression, max-age override, ordered delivery, dead sessions, force flush, multi-session independence)
- `tower-routes.test.ts`: 3 new tests for deferred/immediate/interrupt delivery paths
- `tower-websocket.test.ts`: 2 new tests (recordUserInput assertion, control frame exclusion)

Total: 26 new tests. Full suite: 1590 tests passing.

## Lessons Learned

### What Went Well
- Clean separation of SendBuffer as a standalone testable class with injected dependencies
- Consultation feedback was consistent across all three models, making triage straightforward
- PtySession changes were minimal and non-invasive

### Challenges Encountered
- **`consult` multi-project disambiguation**: The `--project-id` flag doesn't work when multiple project directories exist in `codev/projects/`. Workaround: used `--prompt-file` mode. This is a known `consult` CLI bug.
- **Async in sync callback**: Initial tower-server.ts wiring used `await import()` in a non-async callback. Resolved by co-locating delivery logic with the route handler via `startSendBuffer()`/`stopSendBuffer()` exports.

### What Would Be Done Differently
- Would define `startSendBuffer()`/`stopSendBuffer()` pattern from the start rather than initially trying to wire a callback from tower-server.ts

## Technical Debt

None identified. The implementation is clean and self-contained.

## Follow-up Items

- Consider Approach 2 (Queue Until Submit) as a future enhancement if 3-second idle threshold proves insufficient in practice
- The `consult --project-id` disambiguation bug should be fixed separately
