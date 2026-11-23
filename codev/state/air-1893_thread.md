# air-1893 thread — afx status shows each builder's live state

## 2026-11-23 — implement

- Root cause of "implementing / init" everywhere: `afx spawn` writes state.db `status: implementing, phase: init` once and nothing ever updates it. `afx status` rendered those columns.
- Most of the data already existed: Tower's overview `discoverBuilders` reads each worktree's own `status.yaml` (phase, pending gate, `requested_at`), and `handleOverview` stamps `lastDataAt` and `heldCount`. So the default table is display wiring. I call `discoverBuilders` directly from the CLI (it's a pure fs read), so Phase and Gate work with Tower down too; only Last active needs Tower.
- Architect pointed me at the issue's newest comment: a second adopter wanted last-turns / API-error / running processes behind `afx status --activity`, everything in `--json`, read-only, "unknown" per field. Told the architect it would run a bit past AIR's ~300 LOC; they said proceed in AIR, keep existing `--json` fields (only add), make "unknown" a tested path (codex/agy builders), keep the process census read-only and time-bounded.
- Transcript: `<worktree>/.builder-session-id` is the canonical pinned Claude session id (the launch loop is its sole writer). No pin file → unknown; I deliberately did NOT fall back to "newest jsonl in the dir", since a `claude` reviewer run in the worktree could be the newest file.
- Processes: rooted at the builder terminal's `shellper_pid` (global.db `terminal_sessions`), one cross-platform census read for all builders, raced against a 3s bound. Classifier looks at the *program* word (skipping interpreters/flags), not every argv word — the agent's own argv carries its prompt, which mentions consult/vitest.
- Machine load was 18–29 (three sibling builders spawned alongside); waited for <18 before install/tests per the architect.

## 2026-11-23 — PR #1955

- porch's `tests` check failed three times. The first had one real failure (I'd edited the afx skill, so `generate-skill-hashes` was needed) plus three load-induced timeouts: bugfix-1267-launch-loop, ide-command, agy-auth-cache. The next two failed with no visible output: porch prints only the first five stderr lines, all npm warnings. The same command run exactly as porch runs it passed (8296/8296) twice; the next porch run passed. With three sibling suites running, the load average swung 15→35 within a minute.
- CMAP: codex REQUEST_CHANGES. Transcript text could carry ANSI/OSC sequences into the terminal: a real issue, fixed by stripping C0/C1 controls and bidi overrides in `oneLine`. claude APPROVE with nits: I fixed readTail's byte count, live-but-no-timestamp, the census bound vs ps's timeout, the untested SQL, empty turns, and the colored-cell padding in `logger.row` (pre-existing, fixed in place).
- Windows workflow dispatched on the branch: run 45250083057.
