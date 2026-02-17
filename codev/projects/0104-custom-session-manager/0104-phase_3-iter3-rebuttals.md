# Phase 3 Iteration 3 Rebuttals

## Gemini Feedback

### Observation (UX): Legacy tmux sessions show "persistence unavailable" warning
**Verdict: ACKNOWLEDGED — already addressed in iter 2**

The `isSessionPersistent()` helper (added in iteration 2) now checks BOTH `session.shepherdBacked` AND SQLite `tmux_session IS NOT NULL`, so tmux sessions correctly report `persistent: true` in `/api/state`. Gemini's observation was valid at the time but has been resolved.

## Codex Feedback

### Issue 1 (High): Kill paths bypass SessionManager.killSession()
**Verdict: VALID — FIXED**

Codex correctly identified that kill/stop flows only called `manager.killSession()` (PtySession-level) but not `shepherdManager.killSession()` (SessionManager-level), so auto-restart sessions could respawn after being "killed."

**Fix**:
1. Added `shepherdSessionId` tracking to PtySession — `attachShepherd()` now accepts an optional 4th parameter linking the PtySession to its SessionManager session ID.
2. Created `killTerminalWithShepherd()` helper in tower-server.ts that:
   - Checks if the session is shepherd-backed and has a `shepherdSessionId`
   - Calls `shepherdManager.killSession()` to clear the restart timer and disable auto-restart
   - Then calls `manager.killSession()` to kill the PtySession
3. Updated ALL kill paths to use the helper:
   - `stopInstance` — architect, shells, builders
   - `DELETE /api/terminals/:id`
   - `DELETE /api/tabs/:id` (tab close)
   - `POST /api/stop` (stop all)
4. Updated all 5 `attachShepherd()` call sites to pass `sessionId` as the 4th argument.

### Issue 2 (Medium): No integration test for kill/stop semantics
**Verdict: DISPUTED — scope mismatch (same as iter 1 and 2)**

This has been disputed in every iteration. tower-server.ts HTTP handlers and reconciliation require a running Tower instance to test properly. This is Playwright E2E test scope. The plan's test section mentions both unit/integration tests and E2E tests — the unit-testable core has 18 tests. E2E tests are a separate concern.

Added `shepherdSessionId` tracking test to verify PtySession correctly stores and exposes the session ID for kill path routing.
