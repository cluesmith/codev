# pir-1917 thread — two cursors in the Windows architect terminal (Spec 1658 M2)

## 2026-11-18 — plan

- Cause found, and it is neither of the issue's two candidates. The ConPTY stream hides the cursor correctly
  (the M15 ghost-idle capture ends `?25l`, hidden cursor parked at 39,119), and xterm.js honours it.
  Tower's viewer-attach snapshot (`SessionScreen.serialize()`, `@xterm/addon-serialize` 0.14)
  does not serialize DECTCEM, so every dashboard attach/reload re-shows the hidden cursor where
  ConPTY parked it. On macOS the same loss is invisible: the hidden cursor sits on claude's ghost
  cell.
- The six committed `conpty-claude-*` captures are all visible-cursor, one-cursor screens; only the
  M15 `claude-conpty-ghost-idle` replay shows the software cursor.
- Plan: `serialize()` appends `?25l`/`?25h` from the emulator's own state (private
  `_core.coreService.isCursorHidden`, pinned by a test, falls back to today's behaviour). Server-side
  only; no dashboard/ConPTY change.

## 2026-11-18 — implement

- Plan approved. `SessionScreen.serialize()` now appends `?25l`/`?25h` from a new `cursorHidden` getter
  (private `_core.coreService.isCursorHidden`, `undefined` fallback = old behaviour).
- 5 new tests in `session-screen-serialize.test.ts`. With the append disabled, the three state tests fail
  (ConPTY ghost-idle, macOS ghost, reused client); with it, 141/141 across the session-screen,
  replay-snapshot, attach-replay, render-gate and ConPTY replay suites.
- M2 entry in the 1658 review records the cause.
- Plan commit e9045587c carries a Co-Authored-By trailer from before the owner's no-attribution
  ruling; I asked the architect whether to rewrite it. All later commits have none.
- Local porch `tests` check fails on 7 unrelated tests (temp-dir EPERM in cold-tier/update tests, a #1691 tower-start assertion);
  Windows CI on this branch is green on Node 22 and 24 (run 44208299681; the first Node 22 attempt hit a vitest
  worker crash with all tests passing, and the re-run passed). Blocked on porch's check; Tower is down so
  the architect hasn't been told.
- 00:19Z: my local full-suite run stopped the live Tower (architect attributes it to launchers.windows.test.ts).
  Architect's orders: no full-suite runs locally, never run launchers.windows.test.ts, don't touch Tower, run
  only targeted files. Holding at porch's tests check for a ruling on the pre-existing Windows failures.

## 2026-11-18 — rebase onto #1926, tests check

- Rebased onto origin/main 075a24b99 (#1926) and force-pushed with lease. The no-full-suite rule is lifted.
- `porch done` ~04:50Z: build passed (76.6s); tests check timed out at 300s (391.6s), with other builders'
  full-suite runs overlapping. Live Tower PID 29272 before and after (it survived). Now waiting for the
  architect's 'go pir-1917' (runs are serialized: 1920, 1921, 1917, 1919).
- Two test-orphan shellpers from this worktree's dist, parent gone. Left alone on the architect's order:
  - PID 20476, created 11:31 local: `node .builders/pir-1917/packages/codev/dist/terminal/shellper-main.js`
    command `C:\Program Files\Git\bin\bash.exe -c "node dev-server.cjs"`, cwd
    `~/.agent-farm/test-workspaces/codev-1658-p6-EOuHsQ/ws` (the 00:19Z launchers.windows run).
  - PID 41076, created 15:50 local: same shellper-main.js, command `cmd.exe /d /q /k "echo MARK-1658-A"`,
    cwd `C:\Users\amr` (this run).
