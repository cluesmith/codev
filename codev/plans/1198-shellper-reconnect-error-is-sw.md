# PIR Plan: Fix swallowed shellper reconnect error (silent zombie terminals)

Issue: #1198

## Understanding

After a Tower restart, a persistent (shellper-backed) terminal can become a silent zombie: blank in every viewer, keystrokes and `afx send` messages dropped, yet reported as `running` with "Message sent" logged. The shellper and its Claude child stay healthy throughout.

I verified every claim in the issue against the code. The root cause chain is confirmed:

1. **The client swallows its own close event on error paths.** `packages/codev/src/terminal/shellper-client.ts:266-272`: `cleanup()` sets `this._connected = false` before destroying the socket. The socket's subsequent `'close'` event (`shellper-client.ts:153-163`) reads `wasConnected = this._connected`, which is already false, so `this.emit('close')` is skipped. Any post-handshake socket or parser error (`shellper-client.ts:131-145`) runs `safeEmitError(err)` then `cleanup()`, hitting exactly this path.
2. **Everything downstream hangs off that missing emission.** `session-manager.ts:291-300` (createSession) and `session-manager.ts:407-413` (reconnectSession) contain the ONLY code that logs `shellper disconnected unexpectedly` and calls `removeDeadSession`. `pty-session.ts:198-205` is the only code that transitions the PtySession to exited on socket death. Neither runs. The session stays in every map as a healthy-looking zombie.
3. **The error that WAS emitted goes nowhere.** session-manager re-emits it as `'session-error'` (`session-manager.ts:287,403`), which has zero consumers anywhere in the Tower layer (verified by grep across `packages/codev` and `packages/core`). Not logged, not acted on.
4. **Writes are silent no-ops by design.** `shellper-client.ts:274-282`: `write()`/`resize()` return void and do nothing when `!this._connected`. `pty-session.ts:306-316` propagates the void. The message router (`tower-routes.ts:1374-1380`) then logs "Message sent" for frames that were dropped.
5. **Contributing race:** `towerStop` (`packages/codev/src/agent-farm/commands/tower.ts:346-358`) sends SIGTERM and returns immediately, so `afx tower stop && afx tower start` overlaps the old Tower's teardown with the new Tower's adoption pass.

### Two additional findings from investigation

**(a) Fixing the close emission alone is hazardous.** Once `'close'` fires on error paths, the unexpected-close path runs `removeDeadSession` (which unlinks the shellper's socket file at `session-manager.ts:704-712`, even if the shellper is alive and listening) and PtySession emits `'exit'`, whose tower-side handler calls `deleteTerminalSession` (`tower-terminals.ts:803`, deletes the SQLite row). Net effect: a transient one-shot socket error against a healthy shellper would permanently orphan a live Claude conversation (no socket file, no DB row, no adoption on next restart). The fix must attempt reconnection before declaring death. This is the issue's item 5 ("re-run the reconnect for that session"), and it turns out to be a correctness requirement of item 1, not optional hardening.

**(b) Adoption races the REPLAY frame** (explains the architect's fleet-sweep comment: 6 healthy terminals blank at `total=0`). Both adoption call sites (`tower-terminals.ts:750` and `tower-terminals.ts:962`) call `client.getReplayData()` synchronously right after `connect()` resolves. The shellper sends REPLAY after WELCOME, often in a separate socket read, so the replay is frequently not there yet and the ring buffer starts empty. `waitForReplay()` exists on the client (`shellper-client.ts:310-325`) and is unused at both sites.

## Proposed Change

Six pieces, in the issue's priority order plus the two findings above.

### 1. Fix the swallowed close (shellper-client.ts)

Add two private flags:

- `_everConnected`: set true at handshake success (next to `_connected = true`), never cleared by `cleanup()`.
- `_intentionalDisconnect`: set true in `disconnect()` before calling `cleanup()`.

The socket `'close'` handler emits `'close'` when `_everConnected && !_intentionalDisconnect` (then clears `_everConnected` so the emission is one-shot).

Semantics preserved exactly where they matter:

- Intentional `disconnect()` (Tower shutdown, killSession, detach) emits nothing, same as today. `SessionManager.shutdown()` and `killSession()` stay safe without relying on handler-ordering luck.
- Remote hangup post-handshake emits `'close'`, same as today.
- Error-then-cleanup now also emits `'close'`. This is the fix.
- Handshake-phase failures (version mismatch, invalid WELCOME) still only reject the connect promise, no `'close'` emission, since `_everConnected` was never set.

`afx attach` (`commands/attach.ts:196`) already listens for `'close'` and currently hangs silently on an error-path close. It gets fixed for free.

### 2. Reconnect-in-place before declaring death (session-manager.ts)

Refactor the duplicated client wiring in `createSession` (lines 274-300) and `reconnectSession` (lines 395-413) into one private `wireClientEvents(sessionId, session)` method, and change the unexpected-close behavior:

On `'close'` with the session still in the map:

1. Log `Session <id> shellper connection lost unexpectedly` (the trace that was missing).
2. If the shellper process is still alive (`isProcessAlive(pid)` plus start-time match, the same PID-reuse guard `reconnectSession` already uses) and the socket file still exists: attempt a bounded reconnect, up to 3 attempts with 500ms / 1s / 2s backoff. On success: replace `session.client`, re-wire events via `wireClientEvents`, log success, and emit a new event `'session-reconnected', sessionId, client`.
3. If the process is dead, the socket is gone, or all attempts fail: the existing dead path, unchanged (`removeDeadSession` + `'session-error'`).

Loop guard: a per-session `reconnectAttemptCount` plus `lastReconnectAt` timestamp. The count resets when a reconnected client survives longer than 30s; if a session burns through 3 consecutive recovery rounds without a 30s-stable connection, take the dead path. This prevents a pathological shellper (accepts connects, then drops them) from spinning forever.

### 3. Re-attach the reconnected client to the PtySession (pty-session.ts + tower-server.ts)

Two coordinated edits:

- **pty-session.ts:198-205**: on client `'close'` (with no EXIT seen), do not tear down immediately. Start a grace timer (15s, longer than the session-manager retry window of ~3.5s plus connect timeouts) before setting `exitCode = -1` / emitting `'exit'` / `cleanupShellper()`. `attachShellper()` cancels the pending timer when a new client arrives. This mirrors the existing `_restartCleanupTimeout` pattern in the same file (lines 158-189), and prevents the destructive `deleteTerminalSession` from racing a successful reconnect.
- **tower-server.ts** (next to the SessionManager construction at line 373): subscribe to `'session-reconnected'` and re-attach: look up the PtySession by sessionId and call `attachShellper(newClient, Buffer.alloc(0), pid, shellperSessionId)`. Replay data is deliberately empty on re-attach: the ring buffer already holds the session history, and re-pushing the shellper's replay would duplicate output for connected viewers. `attachShellper` is already idempotent for re-attach (Issue #1047 Fix E removes stale listeners).

### 4. Consume and log 'session-error' (tower-server.ts)

Same place: `shellperManager.on('session-error', (sessionId, err) => log('ERROR', ...))`. A reconnect that dies permanently now always leaves an ERROR line in the Tower log.

### 5. Make towerStop wait (commands/tower.ts)

After the SIGTERM loop (`tower.ts:346-353`): poll each PID with `process.kill(pid, 0)` every 200ms, up to 8s. Any survivor gets SIGKILL. Print "Tower stopped" only once all PIDs are gone (with a note if escalation happened). `afx tower stop && afx tower start` then serializes instead of overlapping, removing the adoption-vs-teardown race that likely minted the observed zombie.

### 6. Make write/resize failure observable (shellper-client.ts, pty-session.ts, tower-routes.ts)

- `ShellperClient.write()/resize()` return `boolean` (false when not connected). `IShellperClient` interface updated accordingly.
- `PtySession.write()/resize()` return `boolean`, propagating the client's return (pty-backed path: true when the pty write happens).
- New `PtySession.writable` getter: shellper-backed sessions report `shellperClient.connected && status === 'running'`; pty-backed report `pty != null && status === 'running'`.
- Message router (`tower-routes.ts` handleSendMessage): after resolving the session, if `!session.writable`, respond 503 `{ error: 'TERMINAL_NOT_WRITABLE' }` and log at ERROR (`Message DROPPED: ...`) instead of writing into the void and logging "Message sent". The deferred-delivery flush path (`tower-routes.ts:111`) gets the same guard, logging a drop instead of silently flushing to a dead session.

With piece 2 in place a dropped message should be rare (the client self-heals), but when it does happen the sender now gets a hard error instead of a false success, and `afx send` surfaces it to the caller.

### 7. Wait for REPLAY during adoption (tower-terminals.ts)

Both call sites (`tower-terminals.ts:750` and `:962`): replace `client.getReplayData() ?? Buffer.alloc(0)` with `await client.waitForReplay()`. Resolves immediately when the frame already arrived; waits up to 500ms otherwise; returns an empty buffer when the shellper genuinely has nothing to replay (it only sends REPLAY for non-empty buffers). Fixes the blank-until-poked terminals from the fleet sweep and makes `total=0` a much stronger zombie signal for future diagnosis. Worst-case adoption cost: +500ms per batch of 5 for terminals with empty replay buffers.

### Out of scope (proposed follow-up issue)

PING/PONG heartbeat-based zombie detection (first half of the issue's item 5). Reconnect-on-close covers the entire observed failure class (the client always sees an error or close when its socket dies; the heartbeat only adds coverage for a hung-but-open socket). Worth its own issue rather than riding this one.

## Files to Change

- `packages/codev/src/terminal/shellper-client.ts:131-163, 262-297` — close-emission flags; boolean returns for write/resize; interface update
- `packages/codev/src/terminal/session-manager.ts:240-307, 350-421, 704-712` — extract shared `wireClientEvents`; bounded reconnect-in-place on unexpected close; `'session-reconnected'` event
- `packages/codev/src/terminal/pty-session.ts:119-206, 305-331` — close grace timer cancelled by `attachShellper`; boolean write/resize; `writable` getter
- `packages/codev/src/agent-farm/servers/tower-server.ts:~373` — subscribe to `'session-error'` (ERROR log) and `'session-reconnected'` (re-attach + INFO log)
- `packages/codev/src/agent-farm/servers/tower-terminals.ts:750, 962` — `await client.waitForReplay()` in both adoption paths
- `packages/codev/src/agent-farm/servers/tower-routes.ts:~111, ~1307-1389` — `writable` guard, 503 + ERROR-log on drop, in both immediate and deferred-flush paths
- `packages/codev/src/agent-farm/commands/tower.ts:~346-358` — poll-for-exit with SIGKILL escalation in `towerStop`
- `packages/codev/src/terminal/__tests__/shellper-client.test.ts` — new close-emission cases
- `packages/codev/src/terminal/__tests__/session-manager.test.ts` — reconnect-in-place cases
- `packages/codev/src/terminal/__tests__/pty-session-attach.test.ts` — grace-timer and re-attach cases; mock client updates for the interface change

## Risks & Alternatives Considered

- **Risk: new `'close'` emissions reach existing listeners on paths that never saw them before** (shutdown, killSession, detach). Mitigated by the `_intentionalDisconnect` flag: `disconnect()` keeps today's emit-nothing behavior, so only genuinely unexpected closes gain the emission. Consumers audited: session-manager (guards on `sessions.has`), pty-session (grace timer added), attach.ts (wants the event; currently bug-hangs without it).
- **Risk: reconnect loop against a flapping shellper.** Mitigated by the attempt cap plus 30s-stability reset described in piece 2; exhaustion falls through to the existing dead path.
- **Risk: re-attach duplicates output.** Mitigated by passing empty replay on re-attach (ring buffer already has history). The 15s PtySession grace timer only delays the *unexpected-death* teardown; real EXIT frames are unaffected (separate event).
- **Risk: `waitForReplay` slows adoption.** Bounded at 500ms per empty-replay terminal, batched 5-way; ~2s worst case for a 20-terminal fleet. Acceptable against the alternative (blank terminals).
- **Alternative: emit `'close'` unconditionally from `cleanup()`.** Rejected: fires on intentional disconnects and handshake failures, breaking shutdown()/killSession() semantics and double-firing with connect() rejections.
- **Alternative: heartbeat-driven zombie detection instead of reconnect-on-close.** Rejected for this PR: heavier (periodic timers per session, threshold tuning) and it detects the state instead of preventing it. Proposed as follow-up.
- **Alternative: have the message router probe liveness end-to-end (write + echo check).** Rejected: intrusive (injects bytes), racy, and the `writable` check plus self-healing reconnect covers the realistic failure class.

## Test Plan

Unit tests (vitest, existing harnesses with mini-shellper socket servers):

- shellper-client: error-path close DOES emit `'close'` (post-handshake socket error, then assert `'close'` fired); `disconnect()` does NOT emit `'close'`; handshake failure does not emit `'close'`; `write()` returns false when disconnected, true when connected.
- session-manager: unexpected socket close with shellper alive → client reconnects in place, `'session-reconnected'` emitted, session stays in map, socket file NOT unlinked; unexpected close with shellper dead → existing dead path (`removeDeadSession` + `'session-error'`); reconnect exhaustion → dead path.
- pty-session: unexpected client close → no immediate 'exit'; `attachShellper` with new client within grace window cancels teardown and I/O resumes; grace expiry without re-attach → 'exit' emitted as before; `writable` reflects client connectivity.

Build + full test suite: `pnpm --filter @cluesmith/codev build && pnpm --filter @cluesmith/codev test` (run from the worktree).

Manual verification for the dev-approval gate (reviewer, on the running worktree build):

1. `pnpm build && pnpm -w run local-install` to run the patched Tower.
2. Baseline: every persistent terminal's `GET /api/terminals/:id/output` returns `total>=1` right after restart (piece 7: no more blank-until-poked terminals with non-empty shellper buffers).
3. Simulated transient error: pick a session's shellper socket, kill the Tower-side TCP connection (e.g. `gdb`/`lsof` fd close, or easier: send a malformed frame by connecting a second raw client and observing; simplest reliable repro is SIGSTOP the shellper, write to it until the socket errors, SIGCONT). Expected: Tower log shows `connection lost unexpectedly` then `re-established`; terminal keeps working; no restart needed.
4. Zombie-drop observability: with a session forced dead (SIGKILL its shellper), `afx send` to it must return an error, and the Tower log must show `Message DROPPED` / ERROR, never "Message sent".
5. `afx tower stop` returns only after the process exits: `afx tower stop && lsof -i :4100` shows nothing; `afx tower stop && afx tower start` no longer overlaps (no port-in-use retry lines in the new log).
