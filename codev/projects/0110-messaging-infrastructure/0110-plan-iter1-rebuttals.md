## Disputed: Legacy write-path broadcast (Codex)

Codex argues that broadcast should also fire when the old `POST /api/terminals/:id/write` endpoint is used, citing spec line 106: "When `af send` writes to a terminal via the API... Tower also broadcasts."

This is a false positive. The spec explicitly introduces `POST /api/send` as the **replacement** for the old write-to-terminal approach (spec lines 145-163: "Replace the current approach (af send resolves terminal ID locally, then calls writeTerminal) with a structured endpoint"). Phase 4 of the plan migrates `af send` to use `POST /api/send` exclusively.

The old `writeTerminal` endpoint (`POST /api/terminals/:id/write`) is preserved for **backwards compatibility** with other callers (e.g., dashboard direct writes, old CLI versions), but it is not the `af send` path. Adding broadcast to every `writeTerminal` call would be incorrect — it would fire on terminal resize data, keyboard input, and other non-message writes.

The spec's intent is clear: structured messages go through `POST /api/send` → broadcast. Raw terminal writes go through `writeTerminal` → no broadcast. No change needed.

## Disputed: Worktree/branch rename (Codex) — Partially Accepted

Codex correctly identified that the original plan changed worktree paths and branch names. This has been fixed in iteration 2: worktree paths and branch names are now unchanged. Only the `builderId` stored in state.db and used for agent addressing is updated to the new format.
