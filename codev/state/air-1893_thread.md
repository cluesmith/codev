# air-1893 thread — afx status shows each builder's live state

## 2026-11-23 — implement

- Root cause of "implementing / init" everywhere: `afx spawn` writes state.db `status: implementing, phase: init` once and nothing ever updates it. `afx status` rendered those columns.
- Most of the data already existed: Tower's overview `discoverBuilders` reads each worktree's own `status.yaml` (phase, pending gate, `requested_at`), and `handleOverview` stamps `lastDataAt` and `heldCount`. So the default table is display wiring. I call `discoverBuilders` directly from the CLI (it's a pure fs read), so Phase and Gate work with Tower down too; only Last active needs Tower.
- Architect pointed me at the issue's newest comment: a second adopter wanted last-turns / API-error / running processes behind `afx status --activity`, everything in `--json`, read-only, "unknown" per field. Told the architect it would run a bit past AIR's ~300 LOC; they said proceed in AIR, keep existing `--json` fields (only add), make "unknown" a tested path (codex/agy builders), keep the process census read-only and time-bounded.
- Transcript: `<worktree>/.builder-session-id` is the canonical pinned Claude session id (the launch loop is its sole writer). No pin file → unknown; I deliberately did NOT fall back to "newest jsonl in the dir", since a `claude` reviewer run in the worktree could be the newest file.
- Processes: rooted at the builder terminal's `shellper_pid` (global.db `terminal_sessions`), one cross-platform census read for all builders, raced against a 3s bound. Classifier looks at the *program* word (skipping interpreters/flags), not every argv word — the agent's own argv carries its prompt, which mentions consult/vitest.
- Machine load was 18–29 (three sibling builders spawned alongside); waited for <18 before install/tests per the architect.
