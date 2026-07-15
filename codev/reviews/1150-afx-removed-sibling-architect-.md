# PIR Review: Removed sibling architect resurrects after Tower recovery

Fixes #1150

## Summary

Deliberately removed sibling architects were coming back to life (with their old conversation resumed) after machine crashes and recovery events, because `launchInstance`'s reconciliation loop respawned every persisted `architect` row with no liveness check, and several mechanisms could leave or re-create rows for removed architects. This PR gates sibling respawn on liveness evidence (a matching `terminal_sessions` row, or a resumable session artifact verified through #1145's harness `session.verifyOwnership`; session-less harnesses exempt) and prunes dead registrations; makes `remove-architect` surface DB delete failures instead of swallowing them, and purge stale registration rows on retry; and switches `global.db` to `synchronous = FULL` so a committed removal cannot be rolled back by an OS crash.

A plan-review finding worth preserving: the issue's original root-cause ranking (swallowed SQLite errors, WAL loss) was reversed during review. The dominant injection path for the July reports was the #1118 state.db consolidation (shipped one week before the reports), whose upsert-if-newer merge re-inserts rows deleted from `global.db` since the snapshot, because deletion leaves no tombstone. The rare-event defects were fixed too, but the consumer-side liveness gate is what covers all injection paths at once.

## Files Changed

- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+85 / -2) — liveness gate + prune in the sibling reconcile loop, `hasArchitectTerminalSession()` helper, `removeArchitect` failure surfacing + stale-row purge
- `packages/codev/src/agent-farm/servers/tower-utils.ts` (+29 / -0) — `siblingRegistrationIsLive()` (reuses #1145's `session.verifyOwnership`)
- `packages/codev/src/agent-farm/db/index.ts` (+8 / -2) — `synchronous = FULL`
- `packages/codev/src/agent-farm/__tests__/tower-instances.test.ts` (+274 / -0) — prune vs respawn, removal failure surfacing, stale-row purge tests
- `packages/codev/src/agent-farm/__tests__/tower-utils.test.ts` (+52 / -0) — `siblingRegistrationIsLive` unit tests
- `codev/plans/1150-afx-removed-sibling-architect-.md` (+109) — plan (with plan-review revisions)
- `codev/state/pir-1150_thread.md` (+40) — builder thread
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — governance updates (this commit)

## Commits

- `69499e07` [PIR #1150] Plan draft
- `9dc054fb` [PIR #1150] Plan revised: rank #1118 consolidation as primary resurrection vector
- `fd02adb1` [PIR #1150] Plan rechecked post-rebase: reuse #1145 ownership-verification primitives
- `a985270e` [PIR #1150] Gate sibling reconciliation on liveness evidence; prune dead registrations
- `0c393573` [PIR #1150] Surface removeArchitect DB delete failures; purge stale registrations on retry
- `3f124f91` [PIR #1150] SQLite synchronous=FULL: close the WAL-loss window for committed removals
- `e2e08d28` [PIR #1150] Tests: liveness gate, prune vs respawn, removal failure surfacing, stale-row purge
- `2d189b9b` [PIR #1150] Thread: implement phase notes

## Test Results

- Root `pnpm build`: pass (types → core → codev, incl. copy-skeleton)
- `pnpm test` (packages/codev): pass — 3463 passed, 48 skipped, 0 failed (11 new tests)
- Porch checks (build + tests): pass at `porch done`
- Manual verification: reviewed and approved at the dev-approval gate, including discussion of prune-vs-respawn semantics, the two-table design, and a measured `synchronous = FULL` cost of ~26µs per commit (500-write benchmark, NORMAL 0.008ms vs FULL 0.033ms per write on APFS SSD)

## Architecture Updates

Routed to the COLD tier (`codev/resources/arch.md`), updated in this commit:

- Multi-architect lifecycle: "Graceful start" now documents the liveness-gated respawn; "Remove" documents loud failure + stale-row purge.
- Persistence layers: reframed as desired state (`architect`) vs runtime state (`terminal_sessions`), fixed the stale schema line (added `session_id`, missing since #832), and added the consumers-must-not-trust-row-existence caveat.
- Technology stack: better-sqlite3 line now records `synchronous = FULL` with the measured cost and rationale.

No HOT tier (`arch-critical.md`) changes: the existing "state lives in global.db / never modify by hand" fact already covers the always-on essence; the liveness-gate mechanics are subsystem reference detail. Cap and map unchanged.

## Lessons Learned Updates

Routed to the COLD tier (`codev/resources/lessons-learned.md`), updated in this commit:

- Architecture: desired-state rows + deletion-as-removal are fragile against state replay (no tombstones); defend by making deletes loud and gating the consumer on evidence.
- Debugging: correlate newly recurring symptoms with what shipped just before the report window; enumerate all writers of the corrupted state (the reviewer's probability challenge reversed the issue's root-cause ranking).
- Testing: piping a build through `tail` masks its exit code; fresh worktrees need the root build before any suite result is trustworthy.

No HOT tier (`lessons-critical.md`) changes: closest existing entries ("verify reviewer/plan claims against the actual file", "single source of truth") already cover the always-on versions; nothing here displaces a current top-10 entry.

## Things to Look At During PR Review

- **Consultation finding (codex, REQUEST_CHANGES — fixed)**: the initial purge branch in `removeArchitect` deleted only the stale `architect` registration row, not leftover `terminal_sessions` rows, so a removal where *only* the terminal-session delete had failed was not retryable (retry reported "not found" while the stale runtime row remained) — a deviation from the approved plan, which specified purging both layers. Fixed: the purge branch now finds and deletes matching `terminal_sessions` rows (`findArchitectTerminalSessionIds`) alongside the registration row, and treats either layer's presence as purgeable. Two regression tests pin it (stale-terminal-row-only retry; both-layers purge). Claude's verdict was APPROVE with no issues. PIR's consultation is single-pass, so this fix was not independently re-reviewed — please eyeball the purge branch (`tower-instances.ts`, the `!terminalId` block in `removeArchitect`) at the `pr` gate.
- The deliberate deviation from the issue's fix sketch: the strict "terminal_sessions row OR jsonl" rule would prune legitimate Codex/Gemini siblings on every stop/start (their rows never carry a `session_id` and terminal rows are wiped on stop), so session-less harnesses are treated as live (`siblingRegistrationIsLive`, rule documented in the function comment).
- The known residual gap, stated in the plan's Risks: a resurrected row whose conversation jsonl still exists on disk passes the gate (indistinguishable from a legitimate sibling). The retryable `remove-architect` purge is the remedy; the consolidation-tombstone question is flagged as a possible follow-up.
- Behavior change: legacy pre-#832 rows (`session_id = NULL`, Claude harness) and long-idle siblings whose jsonl was pruned by Claude's retention are now pruned instead of respawned fresh; recovery is one `add-architect`.
- `removeArchitect` now returns `success: false` after the terminal is already dead when a registry delete fails; the error text explains the state and the retry path.
- Related follow-up filed during review: #1176 (reconcile doesn't self-repair orphaned architect registry rows, the mirror direction).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1150 → **Review Diff**
- **Run locally**: `pnpm build && pnpm -w run local-install`, then:
  - Insert a dead registration: `sqlite3 ~/.agent-farm/global.db "INSERT OR REPLACE INTO architect (workspace_path, id, pid, port, cmd, started_at, terminal_id, session_id) VALUES ('<workspace>', 'ghost', 0, 0, 'claude', datetime('now'), NULL, 'deadbeef-0000-0000-0000-000000000000')"`
  - `afx workspace stop && afx workspace start` → expect the "Pruned dead sibling architect registration 'ghost'" log and no ghost in `afx status`.
  - Spec 786 persistence intact: `afx workspace add-architect --name tmp`, stop, start → tmp resurrects with its conversation.
  - Removal durability: `afx workspace remove-architect --name tmp`, stop, start → stays gone.

## Flaky Tests

None skipped. (An initial full-suite run showed 32 failures across 7 files; all traced to an unbuilt fresh worktree — missing core dist and skeleton copy — not to this diff, and were green after the root build.)
