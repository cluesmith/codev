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
| 3 | Builder tab, Claude exits, clicks X | Tab closes immediately, no confirmation |
| 4 | Builder tab, Claude still running, clicks X | Confirmation dialog appears |
| 5 | Shell tab, Shift+click X | Tab closes immediately (existing bypass behavior) |

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

### Initial Analysis (2026-01-26)

Analysis confirmed the root cause: Bugfix #132's fix checks the wrong process (ttyd instead of tmux). The plan's proposed fix using `tmuxSessionExists` is correct and leverages existing infrastructure.

No multi-agent consultation needed for this spec - it's a targeted bugfix for an existing but incomplete fix, with clear root cause analysis and straightforward solution.
