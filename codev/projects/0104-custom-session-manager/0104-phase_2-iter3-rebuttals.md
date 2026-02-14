# Phase 2 Iteration 3 — Rebuttals and Fixes

One Codex concern addressed. Fixed in commit following this file.

## Addressed: Dead sessions never removed from SessionManager on natural exit (Codex)

Fixed. Added `removeDeadSession()` helper that clears restart timers, deletes from the sessions map, and unlinks the socket file. Three call sites:
1. `createSession` exit handler: removes session when `restartOnExit` is false
2. `reconnectSession` exit handler: always removes (reconnected sessions have no auto-restart options)
3. `setupAutoRestart`: removes session when `maxRestarts` is exhausted

Also fixed: restart reset timer is now only started when `restartOnExit` is true (was unconditionally started before).

Added test "removes session from map when process exits and restartOnExit is false" that verifies natural exit cleanup — session is removed from `listSessions()` and `getSessionInfo()` returns null.
