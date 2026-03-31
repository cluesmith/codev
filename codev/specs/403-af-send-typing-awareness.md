---
approved: 2026-02-17
validated: [architect]
---

# Spec 403: afx send Typing Awareness

## Problem

When a builder sends a message via `afx send` while the architect is mid-sentence typing a prompt to Claude Code, the injected text corrupts their input. The message appears inline with whatever they're typing, mangling both the message and their work.

This is disruptive enough that architects learn to dread builder notifications.

## Solution

Make `afx send` aware of user typing activity and delay message delivery until the user is idle.

### Two Approaches to Evaluate

The builder should evaluate both approaches and recommend one based on implementation complexity and reliability.

#### Approach 1: Idle Detection

Track the timestamp of the last user input on each terminal session. When `afx send` targets a session, check if the user has typed recently. If so, buffer the message and deliver after an idle threshold.

**How it works**:

1. In `pty-manager.ts` WebSocket handler (line 256), record `lastInputTimestamp` on every `data` frame received from the browser
2. In `handleSend` (tower-routes.ts line 722), before writing:
   - Check `session.lastInputTimestamp`
   - If `Date.now() - lastInputTimestamp < IDLE_THRESHOLD_MS`, buffer the message
   - A timer checks buffered messages every 500ms and delivers when idle threshold is met
3. `IDLE_THRESHOLD_MS` defaults to 3000 (3 seconds of no keystrokes)

**Pros**:
- Simple to implement — just a timestamp + timer
- Works with any terminal application (not Claude-specific)

**Cons**:
- A 3-second thinking pause mid-sentence could trigger delivery
- Adds latency to every message even when user isn't typing
- Doesn't distinguish between "typing a long prompt" and "done and waiting"

#### Approach 2: Queue Until Submit

Buffer messages and deliver only after the user submits their current input (presses Enter to send a prompt). This detects the transition from "composing" to "waiting for output."

**How it works**:

1. Track a `typingState` per session: `idle` or `composing`
2. On any `data` frame from browser: set state to `composing`, update `lastInputTimestamp`
3. On detecting Enter/Return (`\r` or `\n`) in input stream: set state to `idle`, deliver any buffered messages after a short delay (200ms — let the submitted command start processing)
4. Timeout fallback: if `composing` for more than 30 seconds with no Enter, deliver anyway (user may have abandoned input)
5. In `handleSend`: if state is `composing`, buffer. If `idle`, deliver immediately.

**Concerns about Enter detection**:
- Enter in Claude Code = submit prompt (good, deliver after this)
- Enter in a text editor (vim, nano) = newline (bad, would trigger premature delivery)
- Enter in a shell = execute command (good)
- Multi-line Claude input uses Shift+Enter or paste, not bare Enter (good — bare Enter means submit)

The main risk is false positives when the user is in a sub-application (editor, less, etc.) where Enter doesn't mean "done typing." The timeout fallback mitigates this.

**Pros**:
- More precise — delivers at natural breakpoints
- No false triggers during thinking pauses
- Feels natural — message arrives right after you submit

**Cons**:
- Enter detection has edge cases (editors, multi-line input)
- More complex state machine
- Needs a timeout fallback for safety

### Implementation Details (Common to Both)

**Message buffer**: Per-session queue in TerminalManager or PtySession:

```typescript
interface BufferedMessage {
  formattedMessage: string;
  noEnter: boolean;
  timestamp: number;        // when it was buffered
  broadcastPayload: object; // for WebSocket notification after delivery
}
```

**Where to add the timestamp**: `PtySession` class — add a `lastInputAt: number` property updated from the WebSocket `data` frame handler in `pty-manager.ts:260`.

**Where to buffer**: `handleSend` in `tower-routes.ts` — instead of immediately calling `session.write()`, check typing state and either deliver or buffer.

**Where to flush**: A periodic check (500ms interval) in TerminalManager, or event-driven flush when state transitions to `idle`.

**Response to caller**: `afx send` should still return 200 immediately (message accepted), even if delivery is deferred. Add a `deferred: true` field to the response so the caller knows.

**Maximum buffer age**: Messages older than 60 seconds are delivered regardless of typing state. Stale messages are worse than interrupted typing.

## Scope

- Add input tracking to PtySession
- Add message buffering to handleSend
- Add flush mechanism (timer-based or event-driven)
- No changes to the `afx send` CLI itself (transparent to callers)
- No changes to the dashboard
- No changes to builder behavior

## Acceptance Criteria

- [ ] Messages are delayed when user is actively typing
- [ ] Messages are delivered promptly when user is idle
- [ ] Buffered messages include a maximum age (60s) after which they deliver regardless
- [ ] `afx send` returns 200 immediately with `deferred: true/false` indicator
- [ ] No messages are lost (buffer survives until delivery or max age)
- [ ] Works correctly when multiple messages arrive while user is typing (delivered in order)
- [ ] Approach selection is documented with rationale in the plan
