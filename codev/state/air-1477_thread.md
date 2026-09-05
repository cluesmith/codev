# air-1477 — AIR builder thread

## Issue
#1477 — Test coverage: mailbox owner-resolution wiring (`escalateHeldToOwner`) and
`cleanupBuilder()` held-row dismissal. Pure test-coverage work, no production change.

## Contributor constraint (architect, 2026-09-05)
We are NOT cluesmith/codev maintainers. Open the PR, get it reviewed, then PARK: do not merge,
do not close the issue, do not clean up the worktree.

## Orientation

Architect pre-verified both premises against main; my own reading agrees:

- `escalateHeldToOwner` lives at `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:405` and
  is reachable only through the exported `makeDeliveryPorts` (`:292`), which is documented as safe
  to call before Tower is up. `send-delivery.test.ts` only ever stubs the port, so the live
  resolution path (architect-skip, affinity → `main` → first-registered, supersede-keyed enqueue)
  had no test.
- `cleanupBuilder`'s dismissal call site is `commands/cleanup.ts:389`. The existing
  `spec-1313-cleanup-dismiss.test.ts` says in its own header that it re-implements the seam and
  that "the full `cleanupBuilder` ... is out of scope here" — so the invocation was uncovered.

Both new tests are NEW files (pir-1473 is concurrently touching mailbox-delivery.ts /
session-submit.ts / tower-routes.ts and shared test files — no overlap by construction).

## Approach

Substitute only the DB singleton. `vi.mock('../db/index.js')` returning an in-memory
`GLOBAL_SCHEMA` database makes `getDb()`/`getGlobalDb()` the same handle, which is exactly the
Issue #1118 production shape — so `state.ts` (registry), `tower-messages.ts`
(`resolveAgentInRegistry`) and `db/mailbox.ts` all run for REAL against seeded rows. Precedent:
`spec-755-lookup-builder.test.ts`.

For the cleanup test, only the side-effecting collaborators are stubbed (git via `utils/shell`,
Tower client, forge, `ps` via `node:child_process`, state writes). `db/mailbox.ts` and
`utils/workspace-path.ts` stay real, so the assertions are about rows the production path actually
transitioned — including the normalized-workspace round-trip, which a raw `config.workspaceRoot`
would fail.

## Log

- 2026-09-05: `pnpm install` needed in the worktree (no node_modules at spawn).
- 2026-09-05: Implementation done. Two new test files, 11 tests, all passing; `tsc --noEmit` clean.
- 2026-09-05: **Mutation-verified** the tests actually bind the wiring (sources restored after):
  - deleting `dismissHeldForAgent(...)` from `cleanup.ts:389` → 3 failures
  - dropping the `sender` arg from `resolveAgentInRegistry('architect', ws, info.toAgent)` → 1 failure
  - deleting the `getArchitectByName` architect-skip guard → 1 failure
  The skip-guard mutation initially did NOT fail, because the downstream self-notify guard
  (`owner.agent === info.toAgent`) absorbed it in a single-architect workspace. Sharpened the test
  to register `main` AND `zeta` and starve `zeta`, so the two guards are distinguishable. Worth
  keeping in mind: a passing test is not evidence of coverage until you break the thing.
- 2026-09-05: Full unit suite: 12 suites failed on the first run, ALL environmental (fresh worktree
  had no `packages/codev/skeleton/` and no `dist/`). After `pnpm bundle-assets` + `npx tsc` all 12
  pass. Nothing related to this change.
- 2026-09-05: 3-way review. Gemini APPROVE; applied both of its suggestions — close the
  better-sqlite3 handle in `afterAll`, and make the "no `main`" fallback test discriminating about
  `getArchitects`' `ORDER BY id` tie-break (it previously registered a single architect and so
  passed vacuously). Codex + Claude reviews pending.
- 2026-09-05: Codex + Claude reviews landed and converged. Applied every actionable finding:
  - **`scheduleDrain` glue was uncovered** (both reviewers, independently). The drainer is never
    started in a unit test, so `scheduleDrain` no-ops and deleting the call left all tests green.
    Added a spy on the exported `getMailboxDrainer()` singleton asserting the drain targets the
    resolved OWNER, not the starving agent. Mutation-verified.
  - **Self-notify guard claim was false.** `owner.agent === info.toAgent` is unreachable under the
    real resolver (resolving to an architect requires it registered, which the architect-skip
    already caught). Corrected the comment rather than mocking a path to a dead branch.
  - **`TowerClient` stub was backwards**: implemented `killTerminal` (never called — test builders
    have no terminalId) and omitted `refreshOverview` (called at cleanup.ts:422), so every test
    silently ran the Tower-unreachable branch. Added `refreshOverview`.
  - **`findStarvingAgents(db, 9999)`** — the second arg is `now`, not an age threshold; 9999 read
    like one and pinned nothing. Dropped it.
  - Added: cross-workspace scoping for the cleanup dismissal (#1118 invariant), cross-workspace
    owner resolution, and `clearHeldOwnerNotice` key specificity.
  - Renamed the non-fatal test to describe what it actually simulates (a global.db failure, not a
    targeted mailbox failure).
- 2026-09-05: **Production observation for the maintainer — flagged, not fixed** (test-only AIR).
  `resolveRegistryArchitect` takes `architects[0]` from `getArchitects`, which is `ORDER BY id`,
  i.e. ALPHABETICAL by architect name. The doc comments there and in `mailbox-wiring.ts` say
  "first-registered", and `loadState` (`ORDER BY (id != 'main'), started_at`) and the live resolver
  (registry insertion order) both implement it that way. So an offline hold can name a different
  architect than a live send would. Deterministic, low-impact, but a genuine divergence. The test
  pins current behaviour and says so explicitly, so the discrepancy is visible rather than silent.
- 2026-09-05: Final: 13 tests, 5 mutation points verified (workspace scope, sender affinity,
  architect-skip, scheduleDrain target, clear-notice key).
