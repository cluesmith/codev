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
