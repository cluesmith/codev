# Builder thread: pir-1150

PIR builder for issue #1150 (removed sibling architect resurrects after Tower recovery).

## 2026-07-08 — Plan phase

Investigated the resurrection path end to end:

- Confirmed the two silent catches in `removeArchitect` (tower-instances.ts:1175-1180) and the unconditional `addArchitect()` in the sibling reconcile loop (687-699).
- Key finding beyond the issue text: `reconcileTerminalSessions`' Phase 2 sweep deletes ALL stale `terminal_sessions` rows at boot, and the architect exit handlers delete them on every clean `afx workspace stop` too. So the issue's strict "terminal_sessions row OR jsonl" gate would prune legitimate Codex/Gemini siblings (they never carry a session_id) on every stop/start, regressing Spec 786 Phase 3 persistence.
- Plan therefore refines the gate: session-less harnesses are treated as live (their respawn is always fresh, so no conversation can resurrect and no RC2 crash-loop is possible); session-capable rows require jsonl evidence via a new optional harness `session.sessionExists()` (keeps Claude specifics out of Tower).
- Also making `removeArchitect` retryable: a retry after partial removal currently returns "not found" even though the zombie row is the thing needing deletion. The not-found branch will purge a persisted row if one exists.
- WAL-loss residual window (removal committed, power lost before fsync) is not closable by any liveness check; mitigated by `synchronous = FULL` (Part 3) and documented in the plan.

Plan written to `codev/plans/1150-afx-removed-sibling-architect-.md`. Sitting at plan-approval gate.

## 2026-07-11 — Plan revision after reviewer challenge

Reviewer questioned whether the silent try/catch was really the cause (SQLite write failures are rare) and asked whether a backup mechanism could be recovering architects. Investigation confirmed the hunch: the #1118 state.db consolidation (shipped ~2026-07-01, one week before the reports) is a deterministic resurrection vector. Pre-#1118 `getDb()` was cwd-dependent, so removals could delete from the wrong state.db file; the #1118 boot one-off and the prescribed satellite sweep (`afx db consolidate --apply`) then merge those stale snapshots into global.db, and `upsertArchitect`'s upsert-if-newer treats a deleted row (absent from global.db) as a plain insert. No tombstones.

Plan updated: Understanding now ranks the three injection paths by probability (consolidation > WAL loss > swallowed delete), Risks now states honestly that the liveness gate cannot stop a resurrected row whose jsonl still exists (retryable purge is the remedy there) and flags consolidation's missing tombstone concept as a possible follow-up issue. The fix parts themselves are unchanged: gate the consumer, make removal loud and retryable, close the WAL window.

## 2026-07-11 — Rebased on main; plan rechecked against #1145

Rebased onto origin/main, picking up PR #1160 (Issue #1145), which landed in the same code area:

- #1145 added `verifySessionOwnership()` (claude-session-discovery.ts) and `session.verifyOwnership?()` (harness.ts), and wired `resolveArchitectLaunch` to verify a stored id before resuming; stale ids degrade to a fresh spawn. It also removed the architect jsonl-discovery fallback in launchInstance.
- Consequences: the RC2 crash-loop half of #1150's symptom is already fixed; the resurrection half is not (the reconcile loop still respawns every persisted row, and a dead registration now self-heals into a fresh-id registration on every launch, so pruning is still needed).
- Plan simplified: Part 2 reuses #1145's primitives instead of adding `sessionFileExists` / `session.sessionExists?`; the liveness helper goes in tower-utils.ts next to `sessionIsOwned` (harness resolution stays out of tower-instances.ts, which #1145 de-imported). Line references refreshed post-rebase. Parts 1 and 3 unchanged.

## 2026-07-11 — Implement phase

Plan approved; implemented in four commits:

- `siblingRegistrationIsLive()` in tower-utils.ts (exempts session-less harnesses, requires jsonl evidence via #1145's verifyOwnership otherwise) + reconcile-loop gate and prune in tower-instances.ts, with `hasArchitectTerminalSession()` as the terminal-evidence check.
- removeArchitect: delete failures collected and surfaced (`success: false` with retry guidance); not-found branch purges a persisted zombie registration so the command is retryable and doubles as manual recovery.
- db/index.ts: `synchronous = FULL`.
- Tests: 6 new in tower-instances.test.ts (prune vs respawn x3, removal failure surfacing x2, stale purge + not-found), 5 new in tower-utils.test.ts for the liveness helper.

Build gotcha worth remembering: `pnpm --filter @cluesmith/codev build | tail` masked a real build failure (pipeline exit code is tail's). Core must be built first; root `pnpm build` orders it correctly. A first full-suite run also showed 32 failures across 7 files that all traced to the missing skeleton copy (fresh worktree, failed build), not to the diff; consolidate.test.ts passes in isolation.
