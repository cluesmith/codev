# Phase 2 Iteration 6 — Rebuttals and Fixes

Three Codex concerns addressed. Fixed in commit following this file.

## Addressed: SessionManager.shutdown() kills shepherds instead of disconnecting (Codex)

Fixed. `shutdown()` now disconnects clients and clears the session map without killing shepherd processes. Per spec: "When Tower intentionally stops, Tower closes its socket connections to shepherds. Shepherds continue running." The method is now synchronous (`void` instead of `Promise<void>`) and iterates sessions to disconnect clients and clear restart timers.

Added test "disconnects clients but leaves shepherd processes alive" that verifies shutdown disconnects the client, clears the session map, and a new client can still connect to the shepherd.

## Addressed: No protocol version-mismatch handling (Codex)

Fixed. Three changes:
1. Added `version` field to `WelcomeMessage` interface in shepherd-protocol.ts
2. ShepherdProcess now includes `PROTOCOL_VERSION` in WELCOME response
3. ShepherdClient.connect() checks version after receiving WELCOME:
   - If shepherd version < Tower version → reject with error (stale shepherd)
   - If shepherd version > Tower version → emit 'version-warning' event, continue
   - If versions match → continue normally

Added three version mismatch tests:
- "disconnects when shepherd version is older than Tower version"
- "connects and emits version-warning when shepherd version is newer"
- "connects normally when versions match"

## Addressed: Missing integration tests for stop/reconnect/replay (Codex)

Fixed. Added integration test "disconnects Tower connection, reconnects, and receives replay" that:
1. Connects to a mock shepherd via SessionManager
2. Simulates PTY output ("hello world")
3. Calls `manager.shutdown()` to disconnect (shepherd stays alive)
4. Creates a new SessionManager and reconnects to the same shepherd
5. Verifies replay data contains the output from before disconnect
