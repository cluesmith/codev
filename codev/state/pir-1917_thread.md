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
