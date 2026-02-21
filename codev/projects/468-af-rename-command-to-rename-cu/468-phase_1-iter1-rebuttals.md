# Phase 1 Iteration 1 Rebuttals

## Codex REQUEST_CHANGES

### 1. Missing env var injection for fallback shells

**Status**: Intentional deviation, no change needed.

The fallback path (non-shellper, non-persistent sessions) deliberately omits `SHELLPER_SESSION_ID` and `TOWER_PORT`. This is documented inline:

> "SHELLPER_SESSION_ID is not set for non-persistent sessions since they don't survive Tower restarts and rename wouldn't persist."

Rationale:
- The spec scopes env vars to "all new shellper sessions" — the fallback path is NOT a shellper session
- Non-persistent sessions can't persist label changes across restarts, making rename misleading
- If a user renames a non-persistent session and Tower restarts, the label is lost — confusing UX
- Both Gemini (APPROVE) and Claude (APPROVE) explicitly reviewed this deviation and accepted it as a reasonable technical tradeoff

The plan's suggestion to use `session.id` as `SHELLPER_SESSION_ID` in the fallback path would work mechanically, but creates a user-facing inconsistency: the rename would appear to succeed but the label wouldn't survive restarts.

### 2. No tests added

**Status**: Already addressed — test file exists.

`packages/codev/src/agent-farm/__tests__/terminal-label.test.ts` was created with 17 tests covering:
- GLOBAL_SCHEMA includes label column
- Migration v11 (ADD COLUMN on existing table)
- saveTerminalSession with label (store, null, replace)
- updateTerminalLabel (update, set from null, non-existent)
- getTerminalSessionById (with label, non-existent)
- getActiveShellLabels (filter by type, exclude nulls, scope to workspace)
- Label preservation during reconnection (carry over, null handling)
- Env var contract validation (UUID format, port string)

All 17 tests pass. The file wasn't in the initial diff reviewed by Codex, which is why it appeared missing. Claude's review (APPROVE) independently verified the test file exists and assessed it as "thorough" (372 lines).
