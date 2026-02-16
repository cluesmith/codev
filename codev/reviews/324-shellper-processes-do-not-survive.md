# Review: Bugfix #324 — Shellper Processes Do Not Survive Tower Restart

## Summary

Fixed shellper processes dying when Tower restarts. Root cause was a pipe-based stdio dependency — shellper stderr was piped to Tower, and when Tower exited, the broken pipe caused unhandled EPIPE errors that crashed the shellper.

## Root Cause Analysis

**Spawn configuration in `session-manager.ts`:**
```typescript
stdio: ['ignore', 'pipe', 'pipe']  // stderr piped to Tower
```

When Tower exited via `process.exit(0)`:
1. The stderr pipe's read end closed
2. Shellper's next async write to `process.stderr` triggered EPIPE
3. Node.js delivered this as an unhandled `'error'` event on the stream
4. No error handler existed → process crashed

Despite `detached: true` and `child.unref()`, the pipe FD created a parent→child lifecycle dependency.

## Fix

**Two-part approach:**

1. **Primary fix** (`session-manager.ts`): Redirect shellper stderr to a log file (`socketPath.replace('.sock', '.log')`) instead of a pipe. File FDs have no parent dependency.

2. **Defense-in-depth** (`shellper-main.ts`): Add `stream.on('error', () => {})` handlers on `process.stdout` and `process.stderr` at startup to prevent crashes from any future stdio issues.

## Files Changed

| File | Change |
|------|--------|
| `session-manager.ts` | Redirect stderr to file FD; add .log cleanup; add explicit exit logging |
| `shellper-main.ts` | Add defensive error handlers on stdout/stderr |
| `shellper-survive-parent-exit.test.ts` | New regression test (2 cases) |
| `session-manager.test.ts` | Update 3 stderr tail tests for new behavior |

## Test Results

- 211 terminal tests pass (0 failures)
- 2 new regression tests:
  - File-based stderr: shellper survives parent exit
  - Error handler: shellper survives broken pipe with forced post-break write

## Consultation Results

| Model | Verdict | Confidence | Key Feedback |
|-------|---------|------------|--------------|
| Gemini | APPROVE | HIGH | Clean fix, proper FD lifecycle, noted dead code for cleanup |
| Codex | COMMENT | MEDIUM | Suggested strengthening broken-pipe test (addressed) |
| Claude | APPROVE | HIGH | Thorough analysis, no issues found |

## Lessons Learned

1. **`detached: true` is necessary but not sufficient** — any pipe-based stdio creates a lifecycle dependency between parent and child processes. Use file FDs or `'ignore'` for truly independent children.

2. **Node.js async EPIPE is dangerous** — when a writable stream is connected to a broken pipe, Node.js delivers EPIPE as an `'error'` event. Without a handler, this crashes the process. Always add error handlers on process stdio streams for long-lived daemon processes.

3. **Defense-in-depth matters** — the file-based stderr is the primary fix, but the error handlers protect against regressions if someone accidentally changes the spawn configuration back to pipes.
