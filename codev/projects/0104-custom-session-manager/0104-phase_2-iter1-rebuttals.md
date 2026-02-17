# Phase 2 Iteration 1 — Rebuttals and Fixes

All legitimate concerns addressed. Fixed in commit following this file.

## Addressed: cleanupStaleSockets deletes live sockets (Codex)

Fixed. `cleanupStaleSockets()` now probes each socket with a test connection before deleting. If a shepherd is still listening on the socket, the connection succeeds and the socket is preserved. Only sockets where connection is refused (no listener) are deleted. Added a new test "does not delete sockets with live shepherds" that verifies a running shepherd's socket survives cleanup.

## Addressed: Missing createSession tests (Gemini, Codex)

Fixed. Added two integration tests that spawn a real shepherd-main.js process:
- "spawns a shepherd and returns connected client" — validates PID, startTime, and connection state
- "create → write → read → kill → verify cleanup" — full lifecycle using /bin/cat for echo verification

## Addressed: Missing killSession and auto-restart tests (Gemini, Codex)

Fixed. Added three new test sections:
- "killSession: kills session and cleans up" — verifies session removal from map
- "sends SPAWN frame on exit when restartOnExit is true" — verifies SPAWN is processed by shepherd
- "respects maxRestarts limit" — integration test with real shepherd, exit 1 command, maxRestarts=2, verifies error emitted

## Addressed: Pre-WELCOME DATA frames crash client (discovered during integration testing)

Fixed. ShepherdClient now buffers frames received before WELCOME during handshake and replays them after WELCOME is resolved. This handles the race where PTY output arrives at the socket before the HELLO/WELCOME handshake completes. Added test "buffers frames received before WELCOME and delivers them after".

## Disputed: Migration approach (Codex)

Codex noted the plan says "PRAGMA table_info" but implementation uses `_migrations` versioning. This is an intentional deviation: the codebase already uses `_migrations` versioning for all 5 existing migrations (v1-v5). Adding v6 with the same pattern is consistent and correct. Using `PRAGMA table_info` would be inconsistent with established patterns. The plan's suggestion was a guideline, not a mandate.
