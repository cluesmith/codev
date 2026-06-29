# PIR Review: Multi-architect conversation resume via persisted per-architect session ID

Fixes #832

## Summary

Tower now revives **every** architect — `main` and named siblings (Spec 755) — into its own prior Claude conversation after a reboot, restart, or in-process crash, instead of only `main`. Each architect row persists an agent-neutral `session_id` generated at spawn; every revive surface reads it back and resumes via `--resume`. This removes #830's conservative `getArchitects() <= 1` guard that disabled `main`'s resume whenever any sibling existed, and closes the silent-context-loss path where a specialised sibling (reviewer, demos, …) would come back as a generic architect that had lost its first-message brief.

## Files Changed

`git diff --stat` against the merge-base (`0065189`):

- `codev/plans/832-multi-architect-conversation-r.md` (+321 / -0)
- `codev/projects/832-multi-architect-conversation-r/status.yaml` (+22 / -0)
- `codev/state/pir-832_thread.md` (+294 / -0)
- `packages/codev/src/agent-farm/db/schema.ts` (+1 / -0)
- `packages/codev/src/agent-farm/db/index.ts` (+20 / -0) — migration v12
- `packages/codev/src/agent-farm/db/types.ts` (+2 / -0)
- `packages/codev/src/agent-farm/types.ts` (+4 / -0)
- `packages/codev/src/agent-farm/state.ts` (+10 / -0)
- `packages/codev/src/agent-farm/utils/harness.ts` (+19 / -0) — `session` capability
- `packages/codev/src/agent-farm/servers/tower-utils.ts` (+48 / -0) — `resolveArchitectLaunch`
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+108 / -? net) — main + sibling spawn/revive
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` (+41 / -?) — both restart-bake sites
- `packages/codev/src/agent-farm/__tests__/tower-utils.test.ts` (+75 / -0)
- `packages/codev/src/agent-farm/__tests__/state.test.ts` (+54 / -0)
- `packages/codev/src/agent-farm/__tests__/harness.test.ts` (+17 / -0)
- `packages/codev/src/agent-farm/__tests__/claude-session-discovery.test.ts` (+5 / -0)
- `codev/resources/lessons-learned.md` (+1 lesson, this commit)

Net: 16 source/test files, **+976 / -65**. (The plan/thread/status files are process artifacts.)

## Commits

`git log main..HEAD --oneline` (implementation commits; porch `chore` commits omitted):

- `274fbdc4` [PIR #832] Drop backfill layer; restore sole-architect jsonl fallback for main
- `6fac1649` [PIR #832] Backfill: read session id off the command line, drop lsof correlation
- `50002398` [PIR #832] Log a 'Resuming architect <name> session <id>…' line at each resume site
- `7dbf0bc6` [PIR #832] Backfill via Tower (Option B): narrow setter route + TowerClient
- `a1079f62` [PIR #832] Persist agent-neutral session_id on architect rows (schema + migration v12 + state setters)
- `c654b185` [PIR #832] Add HarnessProvider.session capability (Claude impl)
- `2305b588` [PIR #832] Rewrite resolveArchitectLaunch: stored-id resume via harness, mint+return on fresh
- … (full history on the branch; the two transitional-backfill arcs above were superseded by `274fbdc4`)

> **Note on the commit arc:** earlier commits built a transitional *backfill* (script + Tower setter route + `TowerClient` method + live-process `lsof`/cmdline capture) to bridge pre-#832 running architects. At the dev-approval gate this was found to be unworkable for siblings and unnecessary for `main`, and **fully removed** in `274fbdc4`. The net diff carries none of it. See "Things to Look At" and the plan's Revision note 2.

## Test Results

- `pnpm build` (core + codev): ✓ pass
- `pnpm test` (from the worktree): ✓ **3389 passed | 48 skipped**
- New tests cover: `session_id` round-trip + removal-clears-id + two-siblings-distinct (`state.test.ts`); migration v12 adds the column with legacy rows reading back null; `resolveArchitectLaunch` resume / fresh / no-session / sibling-isolation (`tower-utils.test.ts`); `CLAUDE_HARNESS.session` produces `--session-id` / `--resume` while Codex/Gemini omit it (`harness.test.ts`); `findLatestSessionId` discovery (`claude-session-discovery.test.ts`).
- Manual verification (human, at `dev-approval`): reviewed the running worktree; the live `--all --dry-run` backfill run (before that path was removed) empirically confirmed the root-cause finding that drove the final design (Claude holds no jsonl fd open).

## Architecture Updates

No `arch.md` change. Architect-revival mechanics live in code (`resolveArchitectLaunch` + the spawn/revive sites) and are documented in this review and the plan; the predecessor #830 mechanism was likewise never lifted into `arch.md`, so adding it now would be per-spec noise. The change *reinforces* the existing hot-tier invariant "state lives in state.db (single source of truth)" — the architect's resumable identity is now a column on its row — rather than altering any documented invariant. The `arch-critical.md` hot tier is unchanged (no new always-on system-shape fact; the cap is preserved).

## Lessons Learned Updates

Routed one lesson to **COLD** `codev/resources/lessons-learned.md` → Architecture (`[From #832]`): a recovery mechanism that keys off a process holding a resource *open* (fd/lock) is only as sound as that assumption — verify it empirically before building on it (Claude closes its session jsonl between writes; `lsof` against a live architect falsified the whole capture subsystem in minutes, and it had passed unit tests only because the tests exercised the fallback). Corollary: don't delete a working self-recovery path to rebuild it as a bridge that can't cover the hard case. Not hot-tier: it's a spec-narrow design lesson, and the hot `lessons-critical.md` already carries the general "captured raw data beats speculation" rule it specialises. Hot tier unchanged (cap preserved).

## Things to Look At During PR Review

- **The design pivot (`274fbdc4`) is the crux.** The branch history builds and then *removes* an entire transitional backfill layer. Confirm the net diff contains no orphans: no `scripts/backfill-architect-sessions.ts`, no `setArchitectSessionId` (state/route/TowerClient), no `captureRunningClaudeSession`/`extractSessionIdFromCmdline`. A repo-wide grep for those symbols should be empty outside `dist/`.
- **The `getArchitects() <= 1` check changed meaning, not just location.** In #830 it gated resume *wholesale* (the bug: any sibling → main spawns fresh). Now it gates *only* the legacy jsonl fallback in `launchInstance`; stored-UUID resume applies regardless of architect count. The issue's acceptance criterion literally says "remove the guard" — we kept a `<= 1` check but repurposed it. Worth a careful read of `tower-instances.ts` `launchInstance` against the plan's Revision note 2 to confirm the reinterpretation is sound.
- **Self-migration on first revival.** `resolveArchitectLaunch` returns the resolved `sessionId`, and every caller persists it. A legacy sole-`main` row therefore resumes via jsonl-discovery *and* gains a stored id in the same revival. Confirm the persist happens on the resume branch, not only the fresh branch.
- **Siblings never use jsonl-discovery** (`addArchitect` passes `storedSessionId ?? null`) and the shellper-restart sites have no jsonl fallback (matching #830). Both intentionally self-heal once for legacy rows — verify this is deliberate, not an omission.
- **Migration v12** is an additive `ALTER TABLE architect ADD COLUMN session_id TEXT` in try/catch (idempotent). Old binaries ignore the nullable column.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-832` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-832` (from the main workspace root)
- **What to verify** (maps to the plan's Test Plan):
  - **Go-forward multi-architect resume**: spawn `main` + a named sibling under this code (ids stored at spawn), `afx workspace stop` + `afx workspace start`; each resumes its own conversation and the sibling keeps its brief. Watch Tower logs for `Resuming architect '<name>' session <id8>…` at each site.
  - **Legacy sole-`main` bridge**: a single-`main` workspace with a pre-#832 row (no stored id) resumes via `findLatestSessionId`, and the row then carries a stored id (self-migration) so the next restart takes the exact-id path.
  - **Removal**: `afx workspace remove-architect <name>` then re-add → starts fresh (row deletion clears `session_id`).
