# Phase 2 Iteration 2 — Rebuttals and Fixes

All three Codex concerns addressed. Fixed in commit following this file.

## Addressed: Unhandled 'error' emissions crash Tower (Codex)

Fixed. Added `safeEmitError()` method to ShepherdClient that checks `this.listenerCount('error') > 0` before emitting. All three post-handshake error emission sites now use `safeEmitError()` instead of raw `this.emit('error', ...)`:
- Socket error after handshake (line 84)
- Parser error (line 93)
- Invalid EXIT payload (line 170)

Added test "does not crash when error emitted with no listener" that sends a malformed EXIT frame to a connected client with no error listener attached, verifying the process survives.

## Addressed: createSession leaks orphaned shepherds on partial failure (Codex)

Fixed. Post-spawn setup (waitForSocket + client.connect) is now wrapped in try/catch with rollback. On failure, the orphaned shepherd is killed via `process.kill(pid, 'SIGKILL')` and the socket file is cleaned up before re-throwing the error.

## Addressed: Restart counter reset timer bypasses maxRestarts (Codex)

Fixed with two changes:
1. The reset timer is now **canceled on exit** in `setupAutoRestart()`, preventing the counter from resetting while the process is down. It's only restarted after the SPAWN command is sent.
2. `startRestartResetTimer()` now enforces `Math.max(resetAfter, restartDelay)` as the effective reset window, preventing misconfiguration where `restartResetAfter < restartDelay`.

## Note: Claude consultation timed out

The Claude iteration 2 consultation hit max_turns (agent exceeded turn limit while reading files). Two of three consultations returned results: Gemini APPROVE, Codex REQUEST_CHANGES (addressed above).
