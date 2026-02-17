# Plan: af send Typing Awareness

## Metadata
- **ID**: plan-2026-02-17-af-send-typing-awareness
- **Status**: draft
- **Specification**: codev/specs/403-af-send-typing-awareness.md
- **Created**: 2026-02-17

## Executive Summary

**Selected approach: Idle Detection (Approach 1)**

Approach 1 (idle detection) is selected over Approach 2 (queue until submit) for these reasons:

1. **Simplicity**: Just a timestamp + timer — no state machine, no Enter detection
2. **Universality**: Works with any terminal application (editors, shells, Claude Code) without special-casing
3. **Fewer edge cases**: Approach 2's Enter detection is fragile — Enter in vim/nano means newline, not "done typing," and multi-line paste can contain `\r` characters
4. **Acceptable tradeoff**: A 3-second thinking pause mid-sentence _could_ trigger delivery, but this is rare and far less disruptive than the current behavior (message injected while actively typing). The 60-second max buffer age provides a safety net

The implementation adds `lastInputAt` tracking to PtySession, a per-session message buffer in a new `send-buffer.ts` module, and modifies `handleSend` to check idle state before delivering.

## Success Metrics
- [ ] Messages are delayed when user is actively typing (input within last 3 seconds)
- [ ] Messages are delivered promptly when user is idle (>3 seconds since last input)
- [ ] Buffered messages have a maximum age of 60 seconds, after which they deliver regardless
- [ ] `af send` returns 200 immediately with `deferred: true/false` indicator
- [ ] No messages are lost — buffer survives until delivery or max age
- [ ] Multiple messages arriving while user is typing are delivered in order
- [ ] All existing tests continue to pass

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "input_tracking", "title": "Phase 1: Input Tracking on PtySession"},
    {"id": "message_buffering", "title": "Phase 2: Message Buffering and Delivery"}
  ]
}
```

## Phase Breakdown

### Phase 1: Input Tracking on PtySession
**Dependencies**: None

#### Objectives
- Add user input timestamp tracking to PtySession so that downstream consumers can determine if a user is actively typing
- Wire both WebSocket input handlers to record input timestamps

#### Deliverables
- [ ] `lastInputAt` property and `recordUserInput()` method on PtySession
- [ ] `isUserIdle(thresholdMs: number)` convenience method on PtySession
- [ ] Both WebSocket handlers updated to call `recordUserInput()` on `data` frames
- [ ] Unit tests for input tracking

#### Implementation Details

**`packages/codev/src/terminal/pty-session.ts`**:
- Add private property `private _lastInputAt = 0` (epoch timestamp in ms)
- Add public method `recordUserInput(): void` that sets `_lastInputAt = Date.now()`
- Add public method `isUserIdle(thresholdMs: number): boolean` that returns `Date.now() - _lastInputAt >= thresholdMs`
- Add public getter `get lastInputAt(): number` for testing/debugging

**`packages/codev/src/terminal/pty-manager.ts`** (line ~260):
- In the `ws.on('message', ...)` handler, after decoding a `data` frame, call `session.recordUserInput()` before `session.write()`

**`packages/codev/src/agent-farm/servers/tower-websocket.ts`** (line ~73):
- Same change — call `session.recordUserInput()` on `data` frames before `session.write()`

#### Acceptance Criteria
- [ ] `session.isUserIdle(3000)` returns `true` when no input for 3+ seconds
- [ ] `session.isUserIdle(3000)` returns `false` immediately after `recordUserInput()`
- [ ] `recordUserInput()` updates `lastInputAt` to current timestamp
- [ ] Both WebSocket handlers call `recordUserInput()` on data frames
- [ ] All existing tests pass

#### Test Plan
- **Unit Tests**: Test `recordUserInput()`, `isUserIdle()`, and `lastInputAt` on a PtySession instance (mock the pty/shellper, test the timestamp logic)
- **Manual Testing**: Not needed — pure logic tests

#### Rollback Strategy
Revert the 3 files. No data migrations, no protocol changes.

#### Risks
- **Risk**: `recordUserInput()` called on every keystroke adds overhead
  - **Mitigation**: `Date.now()` is a fast call (~nanoseconds). No measurable impact.

---

### Phase 2: Message Buffering and Delivery
**Dependencies**: Phase 1

#### Objectives
- Buffer `af send` messages when the target session has an active user typing
- Deliver buffered messages when the user becomes idle or the max buffer age (60s) is reached
- Return `deferred: true/false` in the `af send` API response

#### Deliverables
- [ ] New module `send-buffer.ts` with `SendBuffer` class
- [ ] Modified `handleSend` in `tower-routes.ts` to use the buffer
- [ ] Flush timer that checks buffered messages every 500ms
- [ ] `deferred` field in API response
- [ ] Unit tests for SendBuffer
- [ ] Unit tests for deferred handleSend behavior

#### Implementation Details

**New file: `packages/codev/src/agent-farm/servers/send-buffer.ts`**:

```typescript
export interface BufferedMessage {
  sessionId: string;
  formattedMessage: string;
  noEnter: boolean;
  timestamp: number;          // Date.now() when buffered
  broadcastPayload: {
    type: string;
    from: { project: string; agent: string };
    to: { project: string; agent: string };
    content: string;
    metadata: Record<string, unknown>;
    timestamp: string;
  };
  logMessage: string;         // for ctx.log after delivery
}

export class SendBuffer {
  private buffers = new Map<string, BufferedMessage[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleThresholdMs: number;
  private readonly maxBufferAgeMs: number;

  constructor(opts?: { idleThresholdMs?: number; maxBufferAgeMs?: number }) {
    this.idleThresholdMs = opts?.idleThresholdMs ?? 3000;
    this.maxBufferAgeMs = opts?.maxBufferAgeMs ?? 60_000;
  }

  /** Buffer a message for deferred delivery */
  enqueue(msg: BufferedMessage): void { ... }

  /** Start the periodic flush timer */
  start(getSession: (id: string) => PtySession | undefined,
        deliver: (session: PtySession, msg: BufferedMessage) => void,
        log: (level: string, message: string) => void): void { ... }

  /** Stop the flush timer and deliver all remaining messages */
  stop(): void { ... }

  /** Check and deliver messages for sessions that are now idle or aged out */
  flush(getSession, deliver, log): void { ... }

  /** Number of buffered messages (for testing) */
  get pendingCount(): number { ... }
}
```

The `flush()` method iterates all buffered sessions. For each:
1. Get the session via `getSession(sessionId)`
2. If session is gone → discard messages (session died)
3. If `session.isUserIdle(idleThresholdMs)` → deliver all messages in order
4. If any message's `timestamp + maxBufferAgeMs < Date.now()` → deliver all messages in order (max age exceeded)
5. Otherwise → keep buffered

**`packages/codev/src/agent-farm/servers/tower-routes.ts`**:

Modify `handleSend` (lines 641-754):

1. After resolving the session (line 691), check `session.isUserIdle(IDLE_THRESHOLD_MS)`
2. If **idle** → deliver immediately (existing path), respond with `{ ok: true, deferred: false, ... }`
3. If **not idle** → enqueue into `SendBuffer`, respond with `{ ok: true, deferred: true, ... }`
4. The broadcast and log happen at delivery time (either immediately or when flushed)

Extract the delivery logic (lines 722-744) into a helper function `deliverMessage(session, msg)` that both immediate delivery and flush can call.

The `SendBuffer` singleton is created at module level and started when the tower server initializes. The `getSession` callback uses `getTerminalManager().getSession()`.

**Response contract change** (line 748-753):
```typescript
// Before:
{ ok: true, terminalId, resolvedTo }

// After:
{ ok: true, terminalId, resolvedTo, deferred: boolean }
```

#### Acceptance Criteria
- [ ] Messages are buffered when `session.isUserIdle()` returns false
- [ ] Buffered messages are delivered when user becomes idle (checked every 500ms)
- [ ] Messages older than 60 seconds are delivered regardless of typing state
- [ ] Multiple buffered messages for the same session are delivered in order
- [ ] `af send` returns `deferred: true` when message is buffered
- [ ] `af send` returns `deferred: false` when message is delivered immediately
- [ ] Broadcast happens at delivery time, not at buffer time
- [ ] Messages for dead sessions are discarded (no error, no leak)
- [ ] SendBuffer cleanup runs on tower shutdown
- [ ] All existing tests pass

#### Test Plan
- **Unit Tests (send-buffer.test.ts)**:
  - Enqueue + immediate flush when session is idle
  - Enqueue + deferred flush when session is active
  - Max age triggers delivery regardless of typing state
  - Multiple messages delivered in order
  - Dead session messages are discarded
  - start/stop lifecycle
- **Unit Tests (tower-routes.test.ts updates)**:
  - handleSend returns `deferred: false` when session is idle
  - handleSend returns `deferred: true` when session has recent input
- **Manual Testing**: Send `af send` while typing in dashboard terminal, verify message arrives after pause

#### Rollback Strategy
Revert `send-buffer.ts`, revert `tower-routes.ts` changes. No data migrations.

#### Risks
- **Risk**: 500ms flush interval adds up to 500ms latency to message delivery
  - **Mitigation**: Acceptable tradeoff. Messages arrive within 500ms of the user going idle, which is imperceptible.
- **Risk**: Buffer grows unbounded if many messages arrive
  - **Mitigation**: 60-second max age ensures delivery. In practice, builders send ~1-2 messages at a time.
- **Risk**: Existing tests mock `session.write()` and may not expect `deferred` in response
  - **Mitigation**: Update affected test assertions to include `deferred` field.

## Dependency Map
```
Phase 1: Input Tracking ──→ Phase 2: Message Buffering
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| False idle detection during thinking pauses | M | L | 3s threshold; 60s max age as safety net | Builder |
| Timer leak on tower shutdown | L | M | Stop timer in cleanup; tests verify | Builder |
| Race between flush and handleSend | L | L | Single-threaded Node.js event loop; no race possible | Builder |

## Validation Checkpoints
1. **After Phase 1**: Verify `isUserIdle()` works correctly in isolation via unit tests
2. **After Phase 2**: Verify end-to-end flow: send while typing → deferred → idle → delivered
3. **Before PR**: All existing tests pass, new tests cover core paths

## Documentation Updates Required
- [ ] No user-facing docs needed (transparent to `af send` callers)
- [ ] arch.md update for new `send-buffer.ts` module

## Notes
- The `interrupt` option in `handleSend` should bypass buffering — if the caller explicitly wants to interrupt, the message should be delivered immediately regardless of typing state
- Control messages (resize, ping) should NOT update `lastInputAt` — only actual data input counts
