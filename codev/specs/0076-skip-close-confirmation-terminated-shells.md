# Spec 0076: Skip Close Confirmation for Terminated Shells

## Problem Statement

When a user clicks the X button to close a shell/builder tab in the Agent Farm dashboard, a confirmation dialog appears even if the shell has already terminated. This is unnecessary and annoying - users expect terminated shells to close immediately without confirmation.

### Root Cause

Bugfix #132 (PR #138) attempted to fix this by checking `isProcessRunning(util.pid)` before showing the confirmation. However, this approach is incomplete:

1. `util.pid` is the PID of the **ttyd** process, not the shell itself
2. ttyd runs `tmux attach-session -t <session>` and stays alive as long as there's a WebSocket client connected
3. When the shell inside tmux exits, the tmux session terminates, but ttyd continues running
4. Therefore `isProcessRunning(ttyd_pid)` returns `true` even after the shell has exited
5. The confirmation dialog still appears for terminated shells

### Correct Fix

Check if the **tmux session** exists using `tmuxSessionExists(util.tmuxSession)` instead of checking if the ttyd process is running. This correctly detects when the shell has terminated, regardless of ttyd's state.

## Requirements

### MUST

1. **Skip confirmation for terminated shells**: When user clicks X on a shell tab whose tmux session has ended, close immediately without confirmation
2. **Skip confirmation for terminated builders**: Same behavior for builder tabs
3. **Show confirmation for active shells**: When shell is still running, show confirmation dialog as before
4. **Preserve fallback behavior**: If `tmuxSession` field is unavailable (e.g., corrupted state), fall back to `isProcessRunning(pid)` check

### SHOULD

1. Maintain backwards compatibility with existing state files that may not have `tmuxSession` field

### Acceptance Criteria

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | Shell tab, user types `exit`, clicks X | Tab closes immediately, no confirmation |
| 2 | Shell tab, shell still running, clicks X | Confirmation dialog appears |
| 3 | Builder tab, Claude exits (normal or crash), clicks X | Tab closes immediately, no confirmation |
| 4 | Builder tab, Claude still running, clicks X | Confirmation dialog appears |
| 5 | Shell tab, Shift+click X | Tab closes immediately (existing bypass behavior) |

**Note on #3**: Whether Claude exits normally or crashes, the tmux session is destroyed in both cases, so the behavior is identical.

## Testing Strategy

### Static Verification
Add E2E tests that grep the compiled JavaScript to verify `tmuxSessionExists` is called for both shell and builder tabs. This matches existing testing patterns in `tests/e2e/dashboard.bats`.

### Manual Testing Checklist
| Test | Steps | Expected |
|------|-------|----------|
| Terminated shell | `af util` → type `exit` → click X | Tab closes without dialog |
| Active shell | `af util` → run `sleep 100` → click X | Dialog appears |
| Terminated builder | Spawn builder → type `exit` → click X | Tab closes without dialog |
| Active builder | Spawn builder → leave running → click X | Dialog appears |
| Shift+click bypass | Active shell → Shift+click X | Tab closes without dialog |

### Automated Testing
- Run existing test suite: `npm test` in `packages/codev`
- Run E2E tests: `bats tests/e2e/dashboard.bats`
- All existing tests must continue to pass

**Scope Note**: Dynamic API tests with server lifecycle are out of scope for this bugfix. The fix is a single-line change using existing infrastructure; static verification plus manual testing provides adequate coverage.

## Security Considerations

### Session Name Source
The `tmuxSession` field is:
- Generated internally by the application (not from user input)
- Created in controlled code paths (`spawn.ts`, `kickoff.ts`, `start.ts`)
- Never exposed to or modifiable by external users

### Shell Command Safety
The `tmuxSessionExists()` helper:
- Passes the session name to tmux via a properly quoted shell command
- Does not accept user-controlled input
- Uses a fixed command template: `tmux has-session -t "${sessionName}"`

### Fail-Open Behavior
If tmux is unavailable or the check fails:
- `tmuxSessionExists()` returns `false` (session treated as not running)
- Tab closes without confirmation (dialog skipped)
- This is acceptable because: if tmux is broken, the shell is unusable anyway, so closing without confirmation is safe and expected behavior
- No security exposure from failure mode

**Note**: The fallback to `isProcessRunning(pid)` only applies when `tmuxSession` is unavailable (missing field). If the field exists but tmux has an error, `tmuxSessionExists()` returns `false`.

### Impact Assessment
This change only affects UX (confirmation dialog vs immediate close). It does not:
- Terminate processes without user consent (user explicitly clicked X)
- Expose internal state or credentials
- Allow unauthorized access to shells

## Technical Context

### Architecture

```
User clicks X → dialogs.js:closeTab()
                    ↓
        fetch(/api/tabs/:id/running)
                    ↓
  dashboard-server.ts (lines 1489-1530)
                    ↓
       isProcessRunning(util.pid)  ← WRONG: checks ttyd
                    ↓ (should be)
       tmuxSessionExists(util.tmuxSession)  ← CORRECT: checks shell
```

### Files to Modify

- `packages/codev/src/agent-farm/servers/dashboard-server.ts` (lines 1501-1520)

### Existing Helpers

- `tmuxSessionExists(sessionName: string): boolean` - Already exists at line 338
- Both `Builder` and `UtilTerminal` types have `tmuxSession?: string` field

## Consultation Log

### First Consultation (Iteration 1, 2026-01-26)

**Gemini (APPROVE - HIGH confidence)**:
- Well-analyzed problem and solution
- Correctly identifies distinction between ttyd wrapper and actual shell process
- Approved without changes

**Claude (APPROVE - HIGH confidence)**:
- Well-written bugfix specification with clear problem statement
- Architecture diagram helpful
- Acceptance criteria testable and unambiguous
- Minor observation: Acceptance criteria #3 should clarify normal vs crash exit
- All edge cases appropriately covered with fail-open behavior

**Codex (REQUEST_CHANGES - HIGH confidence)**:
- Solid scope and requirements
- **Issue 1**: Missing explicit testing strategy describing how acceptance scenarios will be validated
- **Issue 2**: No discussion of security/safety considerations for the tmux session checks

### Changes Made (Iteration 2)

1. **Added Testing Strategy section**: Explicit testing plan with static verification, manual testing checklist, and automated testing approach. Matches existing project patterns.

2. **Added Security Considerations section**: Documents session name source (internal, not user-controlled), shell command safety, fail-open behavior, and impact assessment.

3. **Clarified acceptance criteria #3**: Added "(normal or crash)" to make explicit that both exit modes result in tmux session destruction. Added explanatory note.

### Not Incorporated

None - all reviewer feedback was addressed.

### Second Consultation (Iteration 2, 2026-01-26)

**Gemini (REQUEST_CHANGES - HIGH confidence)**:
- Found logical contradiction in "Fail-Open Behavior" section
- If `tmuxSessionExists()` returns `false`, dialog is **skipped**, not shown
- Requested correction to accurately reflect behavior

**Codex (APPROVE - HIGH confidence)**:
- Spec and plan are complete, feasible, and aligned with project testing/security expectations
- Ready for implementation

**Claude (APPROVE - HIGH confidence)**:
- Well-analyzed bugfix spec with clear diagnosis
- Targeted solution using existing infrastructure
- Comprehensive coverage of edge cases and security considerations

### Changes Made (Iteration 2 → Final)

1. **Fixed Fail-Open Behavior description**: Corrected the contradiction - when tmux fails, dialog is skipped (not shown). Added explanation that this is acceptable since a broken tmux means the shell is unusable anyway.

2. **Added clarifying note**: Explained distinction between "tmuxSession field missing" (fallback to PID) vs "tmux command fails" (returns false, dialog skipped).
