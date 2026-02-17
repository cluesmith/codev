# Phase 2 Iteration 4 — Rebuttals and Fixes

One Codex concern addressed. Fixed in commit following this file.

## Addressed: Missing 'close' event handling causes dead session leak on shepherd crash (Codex)

Fixed. SessionManager now listens for `'close'` event on ShepherdClient in both `createSession` and `reconnectSession`. When the shepherd dies without sending an EXIT frame (e.g., crash, SIGKILL), the socket closes and the `'close'` event fires. The handler:
1. Checks if the session is still in the map (not already cleaned up by exit/kill)
2. Calls `removeDeadSession()` to clear timers, delete from map, and unlink socket
3. Emits `'session-error'` with "Shepherd disconnected unexpectedly"

Added test "removes session from map when shepherd disconnects without EXIT" that creates a session, shuts down the shepherd (simulating crash), and verifies the session is removed from the map and the error is emitted.
