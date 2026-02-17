### Iteration 1 Reviews
- gemini: REQUEST_CHANGES — Missing tests for SessionManager.createSession() and integration tests for the full lifecycle.
- codex: REQUEST_CHANGES — Phase-2 has a functional stale-socket cleanup bug and missing coverage for required SessionManager lifecycle behaviors.
- claude: APPROVE — Phase 2 delivers a well-implemented ShepherdClient, SessionManager, and schema migration with solid test coverage; auto-restart tests can be added in Phase 3 integration.

### Builder Response to Iteration 1
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


### Iteration 2 Reviews
- gemini: APPROVE — Robust implementation of SessionManager, ShepherdClient, and ShepherdProcess with comprehensive tests covering lifecycle, race conditions, and error handling. Addressed previous feedback effectively.
- codex: REQUEST_CHANGES — Phase 2 is close and prior iteration concerns were largely addressed, but there are still lifecycle/error-path bugs that can crash Tower or leak shepherds.
- claude: APPROVE — Phase 2 is complete with comprehensive ShepherdClient, SessionManager, schema migration, and 98 passing tests covering all plan deliverables and prior-iteration fixes.

### Builder Response to Iteration 2
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


### Iteration 3 Reviews
- gemini: APPROVE — robust implementation of Phase 2 deliverables with comprehensive test coverage and verified fixes for error handling and lifecycle management.
- codex: REQUEST_CHANGES — Phase 2 is close, but SessionManager still leaks dead sessions on natural exit, which can leave stale state and block stale-socket cleanup.
- claude: APPROVE — Phase 2 delivers a well-implemented ShepherdClient, SessionManager, and schema migration with comprehensive tests; all prior-iteration concerns have been addressed in code.

### Builder Response to Iteration 3
# Phase 2 Iteration 3 — Rebuttals and Fixes

One Codex concern addressed. Fixed in commit following this file.

## Addressed: Dead sessions never removed from SessionManager on natural exit (Codex)

Fixed. Added `removeDeadSession()` helper that clears restart timers, deletes from the sessions map, and unlinks the socket file. Three call sites:
1. `createSession` exit handler: removes session when `restartOnExit` is false
2. `reconnectSession` exit handler: always removes (reconnected sessions have no auto-restart options)
3. `setupAutoRestart`: removes session when `maxRestarts` is exhausted

Also fixed: restart reset timer is now only started when `restartOnExit` is true (was unconditionally started before).

Added test "removes session from map when process exits and restartOnExit is false" that verifies natural exit cleanup — session is removed from `listSessions()` and `getSessionInfo()` returns null.


### Iteration 4 Reviews
- gemini: APPROVE — Phase 2 is complete with robust SessionManager, ShepherdClient, and comprehensive tests addressing all previous feedback.
- codex: REQUEST_CHANGES — Phase 2 is close, but a remaining `'close'`/shepherd-crash lifecycle gap can leak dead sessions and is not test-covered.
- claude: APPROVE — Phase 2 delivers a complete, well-tested ShepherdClient, SessionManager, and schema migration with all prior-iteration concerns addressed in code.

### Builder Response to Iteration 4
# Phase 2 Iteration 4 — Rebuttals and Fixes

One Codex concern addressed. Fixed in commit following this file.

## Addressed: Missing 'close' event handling causes dead session leak on shepherd crash (Codex)

Fixed. SessionManager now listens for `'close'` event on ShepherdClient in both `createSession` and `reconnectSession`. When the shepherd dies without sending an EXIT frame (e.g., crash, SIGKILL), the socket closes and the `'close'` event fires. The handler:
1. Checks if the session is still in the map (not already cleaned up by exit/kill)
2. Calls `removeDeadSession()` to clear timers, delete from map, and unlink socket
3. Emits `'session-error'` with "Shepherd disconnected unexpectedly"

Added test "removes session from map when shepherd disconnects without EXIT" that creates a session, shuts down the shepherd (simulating crash), and verifies the session is removed from the map and the error is emitted.


### Iteration 5 Reviews
- gemini: APPROVE — Phase 2 is complete with robust SessionManager, ShepherdClient, and comprehensive tests addressing all previous feedback.
- codex: REQUEST_CHANGES — Phase 2 is largely complete, but `getProcessStartTime()` has a real error-path that can throw and break session reconnect/reconciliation instead of failing safely.
- claude: APPROVE — Phase 2 is complete with well-structured ShepherdClient, SessionManager, and schema migration; all prior-iteration concerns verified as addressed; comprehensive test coverage across unit and integration levels.

### Builder Response to Iteration 5
# Phase 2 Iteration 5 — Rebuttals and Fixes

One Codex concern addressed. Fixed in commit following this file.

## Addressed: getProcessStartTime() can throw instead of returning null (Codex)

Fixed. Wrapped the entire function body in a try/catch that resolves null on any synchronous throw. This handles edge cases like EPERM where execFile could theoretically throw before invoking its callback. The function now safely returns null for any failure path, preventing session reconnect/reconciliation from breaking.


### Iteration 6 Reviews
- gemini: APPROVE — Robust implementation of SessionManager and ShepherdClient with comprehensive tests covering lifecycle, error handling, and all previous feedback.
- codex: REQUEST_CHANGES — Phase 2 is close, but shutdown semantics kill shepherds instead of disconnecting, no protocol version-mismatch handling, and missing stop/reconnect/replay integration tests.
- claude: APPROVE — Phase 2 delivers a complete, well-tested ShepherdClient, SessionManager, and schema migration with all prior-iteration concerns addressed.

### Builder Response to Iteration 6
# Phase 2 Iteration 6 — Rebuttals and Fixes

Three Codex concerns addressed. Fixed in commit following this file.

## Addressed: SessionManager.shutdown() kills shepherds instead of disconnecting (Codex)

Fixed. `shutdown()` now disconnects clients and clears the session map without killing shepherd processes. Per spec: "When Tower intentionally stops, Tower closes its socket connections to shepherds. Shepherds continue running." Added test "disconnects clients but leaves shepherd processes alive".

## Addressed: No protocol version-mismatch handling (Codex)

Fixed. Added `version` field to `WelcomeMessage`, ShepherdProcess includes `PROTOCOL_VERSION` in WELCOME, and ShepherdClient.connect() checks version: older → reject, newer → warn and continue, match → normal. Added three version mismatch tests.

## Addressed: Missing integration tests for stop/reconnect/replay (Codex)

Fixed. Added integration test that connects → writes data → shutdown (disconnect only) → reconnect to same shepherd → verify replay data contains previous output.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
