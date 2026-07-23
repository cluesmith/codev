# PIR Review: Shellper Husk Sweep + Fleet Memory Observability

Fixes #1227

## Summary

macOS memory-pressure kills (jetsam) were traced to Codev's own process fleet: shellper wrapper processes whose PTY child already exited ("husks") were permanently unreapable, because the existing `killOrphanedShellpers()` unconditionally protects any shellper whose socket still responds — and a husk's socket always responds. This PR adds a second, stricter sweep (unregistered AND childless AND aged past a grace period) on three triggers (Tower startup, an hourly in-process timer, and an on-demand `afx tower sweep-husks` CLI command with dry-run/`--apply` semantics), plus fleet-wide RSS and unregistered-shellper-count observability in `/health` and `afx status`. Idle-architect hibernation (the issue's proposal item 2) was explicitly excluded per architect scoping and is flagged as a follow-up spec.

## Files Changed

- `packages/codev/src/agent-farm/servers/process-census.ts` (+44 / -0) — new
- `packages/codev/src/agent-farm/servers/shellper-husk-sweep.ts` (+173 / -0) — new
- `packages/codev/src/agent-farm/commands/tower-sweep-husks.ts` (+92 / -0) — new
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+36 / -0)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+137 / -1)
- `packages/codev/src/terminal/session-manager.ts` (+21 / -2)
- `packages/core/src/tower-client.ts` (+55 / -0)
- `packages/codev/src/agent-farm/lib/tower-client.ts` (+3 / -0)
- `packages/codev/src/agent-farm/cli.ts` (+16 / -0)
- `packages/codev/src/agent-farm/commands/status.ts` (+29 / -2)
- `packages/codev/src/agent-farm/__tests__/process-census.test.ts` (+79 / -0) — new
- `packages/codev/src/agent-farm/__tests__/shellper-husk-sweep.test.ts` (+190 / -0) — new
- `packages/codev/src/agent-farm/__tests__/shellper-husk-sweep.e2e.test.ts` (+177 / -0) — new
- `packages/codev/src/agent-farm/__tests__/tower-routes-husks.e2e.test.ts` (+142 / -0) — new
- `packages/codev/src/agent-farm/__tests__/tower-sweep-husks.test.ts` (+117 / -0) — new
- `packages/codev/src/agent-farm/__tests__/status-fleet-observability.test.ts` (+132 / -0) — new

16 files changed, 1438 insertions(+), 5 deletions(-).

## Commits

- `ff25c080` [PIR #1227] Plan draft
- `ce24667f` [PIR #1227] Plan revised
- `7c01cf97` [PIR #1227] Add process-census + shellper-husk-sweep predicate
- `6a622dbe` [PIR #1227] Wire startup + hourly husk-sweep triggers into Tower
- `f4a9ee56` [PIR #1227] Add husk preview/sweep routes + fleet observability in /health
- `af130187` [PIR #1227] Extend TowerClient with husk preview/sweep + fleet health fields
- `73895847` [PIR #1227] Add afx tower sweep-husks CLI command
- `d2af62fc` [PIR #1227] Surface fleet RSS + unregistered shellper count in afx status
- `69bb42f3` [PIR #1227] Correct stale give-up-reap comment re: husk sweep eligibility

## Test Results

- `porch check` (build + tests): ✓ both pass
- `tsc --noEmit` clean across `packages/core` and `packages/codev`
- Unit tests: 98+ passing across `process-census.test.ts`, `shellper-husk-sweep.test.ts`, `tower-sweep-husks.test.ts`, `status-fleet-observability.test.ts`, plus the full existing `session-manager.test.ts` regression suite (79 tests, unmodified behavior)
- E2E (real Tower process, real `ps`/signals, no mocks):
  - `shellper-husk-sweep.e2e.test.ts` — creates a genuine husk (deletes its `terminal_sessions` row, kills its PTY child directly), confirms the periodic timer reaps it on the next tick; separately confirms graceful shutdown clears the new interval without hanging
  - `tower-routes-husks.e2e.test.ts` — confirms `GET /api/shellpers/husks` lists a genuine husk without touching it, `/health` reports it under `unregisteredShellperCount`, and `POST /api/shellpers/husks/sweep` then actually reaps it
  - Existing `shellper-cleanup.e2e.test.ts` regression suite: unmodified, still passing
- Manual: `afx tower sweep-husks` (preview and `--apply`/`-y`), `afx status` (human + `--json`) reviewed at the `dev-approval` gate

## Architecture Updates

Added a "Husk sweep (Issue #1227)" paragraph to `codev/resources/arch.md`'s "Orphan Session Detection" section — the existing text there stated shellpers are "never killed" during the SQLite sweep, which is no longer the complete picture now that a second, stricter sweep exists for exactly the case that policy leaves permanently unreaped. Routed to the **cold** tier (`arch.md`), not `arch-critical.md`: this is subsystem-specific mechanism detail, not a cross-cutting fact that should change unrelated implementation decisions, and the hot tier's existing "Agent Farm Internals" map entry already points here.

## Lessons Learned Updates

Added one entry to `codev/resources/lessons-learned.md` under "Debugging and Root Cause Analysis" (cold tier — the section already holds this exact class of JS falsy-coercion footgun, e.g. the `[From 0107]` `body && body.name` entry): `parsed || fallbackDefault` silently discards a legitimate `0` override, since `0` is falsy in JS. I hit this for real — `SHELLPER_HUSK_GRACE_MS=0` (set by my own E2E test for an immediate-eligibility grace period) silently reverted to the 1-hour default, and only a real running-process assertion caught it, not a unit test mocking the parse. Fixed with `Number.isNaN(parsed) ? fallbackDefault : parsed` for both the grace-period and sweep-interval env vars (`tower-server.ts`, `shellper-husk-sweep.ts`'s `resolveHuskGraceMs`).

## Things to Look At During PR Review

- **Design choice: a sibling function, not an edit to `killOrphanedShellpers`.** I deliberately did not modify the existing, well-tested `killOrphanedShellpers()` in place — its "responsive socket protects" behavior is still correct and needed for the reconnectable case; the new `sweepShellperHusks()` is strictly additive and covers only the gap. Rationale is documented in the plan's Risks & Alternatives section.
- **The `0 || default` bug** (see Lessons Learned above) — worth a close look at `resolveHuskGraceMs()` in `shellper-husk-sweep.ts` and the parallel fix in `tower-server.ts`'s `huskSweepIntervalMs` parsing, since this class of bug is easy to reintroduce.
- **Codex review (iteration 1) found a real defect, fixed in `3a5083e3`: `process-census.ts` originally used `execFileSync`, called synchronously from the `/health` HTTP handler — blocking Tower's entire event loop (all open terminals' WebSocket traffic) for the duration of every `ps` call.** This is a previously-fixed anti-pattern in this exact codebase (`lessons-learned.md:160`), reintroduced by this PR. Rewrote `listProcessCensus()` to use non-blocking `execFile` (matching `session-manager.ts`'s existing async convention), added a regression test (`process-census.test.ts`: `'never calls the synchronous execFileSync API'`) that fails against the pre-fix code. Full detail and a second, related fix (a redundant double `ps` scan in `handleHuskPreview`, also flagged independently by claude's own review) in `codev/projects/1227-codev-process-fleet-drives-mac/1227-review-iter1-rebuttals.md`. Per PIR's single-pass design this fix was **not** independently re-reviewed by either model — please verify it at this gate.
- **`afx tower sweep-husks` UX** mirrors `afx workspace recover` exactly (dry-run default, `--apply`, `-y`/`--yes`, same `confirm()` helper) per explicit architect direction mid-plan-review — not an independent design choice, so please check it actually matches that precedent rather than just looking reasonable in isolation.
- **`fleetRssKb` scope**: sums every in-scope shellper *and its direct children* (the full process-group tree), computed from one `ps` scan, regardless of DB-registration state — so a not-yet-swept husk still counts toward the visible number. This is explicitly advisory/observational, not used anywhere as a decision input (confirmed in conversation during the dev-approval gate review).
- **PID-reuse defense**: `computeRegisteredShellperPids` validates each DB row's `shellper_pid` against the live process's actual start time (2000ms tolerance, same constant `SessionManager.reconnectSession` already uses) before counting it as registered — a stale row whose PID was reused by an unrelated process correctly falls through to "unregistered."

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1227 → **Review Diff**
- **Run dev**: `afx dev pir-1227`
- **What to verify**:
  - `afx tower sweep-husks` with no flags previews only (nothing killed); `--apply` alone prompts for confirmation; `--apply --yes` reaps without prompting
  - `afx status` shows `Fleet RSS` and `Unregistered Shellpers` lines when Tower is running; `afx status --json` carries a `fleet: { rssKb, unregisteredShellperCount }` field (explicit `null`s, not omitted keys, when Tower is down)
  - `GET /health` on a running Tower includes `fleetRssKb` and `unregisteredShellperCount`
  - Tower starts and stops cleanly with the new interval in place (`SIGTERM` exits promptly, no hang)

## Flaky Tests

None encountered.
