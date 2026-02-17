# Phase 3 Iteration 1 Rebuttals

## Codex Feedback

### Issue 1 (Critical): TerminalManager.shutdown() kills shepherd sessions
**Verdict: VALID — FIXED**

Codex correctly identified that `TerminalManager.shutdown()` iterates all sessions and calls `session.kill()`, which for shepherd-backed sessions sends SIGTERM to the shepherd. This contradicts the spec: "When Tower intentionally stops, Tower closes its socket connections to shepherds. Shepherds continue running."

**Fix**: Modified `shutdown()` to skip `session.kill()` for sessions where `session.shepherdBacked === true`. Added a dedicated test to verify no SIGTERM is sent during shutdown.

### Issue 2 (High): tmux still created in fallback paths
**Verdict: DISPUTED — intentional dual-mode design**

The plan explicitly calls for Phase 3 as a "dual-mode" phase where shepherd is primary and tmux is the fallback. Phase 4 (tmux Removal and Cleanup) removes tmux creation entirely. This is by design to ensure a safe transition path.

### Issue 3 (High): persistent prop not wired through dashboard
**Verdict: VALID — FIXED**

Codex correctly identified that while Terminal.tsx has a `persistent` prop and a warning banner, the prop was never actually passed from the API through to the component.

**Fix**:
- Added `persistent` field to `/api/state` response (architect, builders, shells)
- Added `persistent` to dashboard API types (`Builder`, `UtilTerminal`, `ArchitectState`)
- Added `persistent` to `Tab` interface in `useTabs.ts`
- Wired `persistent` through `buildTabs()` from state data
- Passed `persistent` from tabs to Terminal components in `renderTerminal()` and `renderPersistentContent()`

### Issue 4 (Medium): Integration tests don't cover Tower behaviors
**Verdict: DISPUTED — scope mismatch**

The integration tests cover PtySession + ShepherdClient integration which is the unit-testable core of Phase 3. Testing actual tower-server.ts HTTP handlers and reconciliation against a real Tower instance is E2E test scope, not unit test scope. The tower-server changes are tested through the build succeeding and existing tests passing.
