# Phase 3 Iteration 2 Rebuttals

## Codex Feedback

### Issue 1 (Critical): Tower shutdown can delete persistent shepherd session rows
**Verdict: ALREADY FIXED (prior context)**

This was already addressed. `TerminalManager.shutdown()` calls `session.detachShepherd()` for shepherd-backed sessions, which calls `removeAllListeners()` on the shepherd client before the socket is disconnected. This prevents the `close→exit(-1)→deleteTerminalSession()` chain.

Test `detaches listeners so client close does not trigger exit event` (tower-shepherd-integration.test.ts) verifies this: after `manager.shutdown()`, `client.simulateClose()` does NOT trigger the exit event.

### Issue 2 (High): Fallback still creates tmux sessions
**Verdict: DISPUTED — intentional dual-mode per plan (same as iteration 1)**

The plan explicitly says Phase 3 supports dual-mode: "Support dual-mode operation (existing tmux sessions still work during transition)." Phase 4 (tmux Removal and Cleanup) removes all tmux creation paths. Creating tmux as a fallback during Phase 3 is by design.

The `persistent: !!activeTmuxSession` for tmux-backed fallback sessions is correct — tmux sessions ARE persistent (they survive restart), just through the old mechanism.

### Issue 3 (Medium): Integration tests don't test tower-server
**Verdict: DISPUTED — scope mismatch (same as iteration 1)**

Tower-server HTTP handler testing (architect creation flow, reconciliation, graceful degradation) requires a running Tower server instance and is E2E test scope, not unit/integration test scope. The plan's test section says "E2E Tests (Playwright): Run existing terminal E2E test suite" for these paths.

The integration tests cover the PtySession ↔ ShepherdClient contract which is the testable boundary for Phase 3.
