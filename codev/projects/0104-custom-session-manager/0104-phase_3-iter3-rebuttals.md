# Phase 3 Iteration 3 Rebuttals

## Gemini Feedback

### Observation (UX): Legacy tmux sessions show "persistence unavailable" warning
**Verdict: ACKNOWLEDGED — acceptable transitional quirk**

Gemini correctly identifies that tmux sessions show `persistent: false` in the dashboard since persistence is now derived from `shepherdBacked`. This is acceptable because:
1. Phase 4 removes all tmux creation paths
2. The warning is informational only, doesn't break functionality
3. Existing tmux sessions still work through reconciliation

## Codex Feedback

### Issue 1 (High): Kill paths bypass SessionManager.killSession()
**Verdict: INVALID — already fixed**

All kill paths already use the `killTerminalWithShepherd()` helper function (tower-server.ts line 1875) which:
1. Checks if the session is shepherd-backed
2. Calls `shepherdManager.killSession()` to disable auto-restart
3. Then calls `manager.killSession()` to kill the PtySession

Verified call sites:
- stopInstance architect kill → `killTerminalWithShepherd()` (line 1919)
- stopInstance shell kills → `killTerminalWithShepherd()` (line 1928)
- stopInstance builder kills → `killTerminalWithShepherd()` (line 1937)
- DELETE /api/terminals/:id → `killTerminalWithShepherd()` (line 2412)
- Tab close handler → `killTerminalWithShepherd()` (line 3236)

### Issue 2 (Medium): No integration test for kill/stop semantics
**Verdict: DISPUTED — scope mismatch**

Testing the tower-server kill routes (stopInstance, DELETE /api/terminals/:id, tab close) requires a running Tower server with HTTP endpoints. This is E2E test scope per the plan's test section.

The `killTerminalWithShepherd()` helper is a thin wrapper over two already-tested primitives:
- `SessionManager.killSession()` — tested in session-manager.test.ts
- `TerminalManager.killSession()` → `PtySession.kill()` — tested in tower-shepherd-integration.test.ts

## Changes Made This Iteration

### Remove tmux creation from all fallback paths (Codex iter 3 / Plan alignment)

Per the plan's "Graceful Degradation" section: when shepherd fails, fallback to non-persistent direct PTY sessions, NOT new tmux sessions. "Dual-mode" means handling EXISTING tmux sessions in reconciliation only.

Changed three fallback paths:
1. **Architect fallback** (tower-server.ts ~line 1826): Non-persistent `manager.createSession()` instead of `createTmuxSession()`
2. **POST /api/terminals fallback** (tower-server.ts ~line 2334): Non-persistent `manager.createSession()` instead of `createTmuxSession()`
3. **POST /api/tabs/shell fallback** (tower-server.ts ~line 2921): Non-persistent `manager.createSession()` instead of `createTmuxSession()`
