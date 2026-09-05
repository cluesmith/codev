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

## Review round 2 (PR #1625, architect 3-way CMAP)

Verdicts: gemini APPROVE-HIGH, codex COMMENT-MEDIUM, claude REQUEST_CHANGES-HIGH. One blocker.

**The blocker was real, and it was mine.** `air-1477-cleanup-dismiss-invocation.test.ts`'s
"normalizes the configured workspaceRoot" test was VACUOUS. I reproduced it before fixing:
stripping `normalizeWorkspacePath` from `cleanup.ts:389` left all 4 tests green.

Two independent mistakes stacked:
1. `workspaceRoot` was already `realpathSync`'d at creation, so `normalizeWorkspacePath` on it was
   the identity.
2. The "non-canonical" override `join(workspaceRoot, 'nested', '..')` collapses LEXICALLY inside
   `path.join` — no filesystem access — so it was byte-identical to `workspaceRoot` before
   normalization was ever reached.

So `config.workspaceRoot === WS` in every test, and the assertion I described as "only reachable
because the call site normalizes" was reachable no matter what. My inline comment and the matching
PR-description line were both false as written.

Fix: the fixture now creates a real dir as `WS` and a SYMLINK to it as `workspaceRoot`, and the
symlink is what `getConfig()` returns — so every test in the file now traverses the normalization,
not just one. A symlink cannot be resolved lexically; only `realpathSync` gets from one to the
other. Added a guard (`expect(workspaceRoot).not.toBe(WS)`) so the fixture cannot silently
degenerate again. Confirmed by mutation: the fixed test now FAILS (3 tests) without
`normalizeWorkspacePath`.

Lesson worth keeping: I "verified" this test by mutation in round 1 — but only mutated the *call*,
never the *argument*. Deleting `dismissHeldForAgent` failed the test, which felt like proof, so I
never asked whether the normalization specifically was pinned. A mutation sweep is only as good as
the set of mutations you think to try, and the ones you skip are exactly the ones you were already
confident about.

Also fixed (both confirmed by reading the source):
- `scheduleDrain.mockRestore()` was the last statement of its `it` body, so a failed assertion
  above it would leak the spy into later tests. Moved to an `afterEach` (`vi.restoreAllMocks()`).
- The architect fixture used `new Date().toISOString()` for both architects, which can tie. Now
  takes an explicit `startedAt`, and the id-order test registers `zeta` with the EARLIER timestamp
  so id order and registration order genuinely disagree. Confirmed by mutation: switching
  `getArchitects` to `ORDER BY started_at` now fails that test (it would not have before).

Non-blocking, done: cross-referenced `spec-1313-cleanup-dismiss.test.ts`'s header to the invocation
test so the seam-vs-wiring split is discoverable from either side.

Non-blocking, NOT done, with reasons:
- `scheduleDrain`'s workspace argument is genuinely unpinnable from outside:
  `resolveRegistryArchitect` returns the workspace it was asked about, so `owner.workspacePath` and
  `info.workspacePath` are equal by construction. Documented in a comment rather than faked.
- `loadConfig(homedir())` hermeticity is inherited from production (`ensureDrainer`) and
  try/catch-guarded; fixing it would need a production change.
- The `spec-755-lookup-builder.test.ts` `GLOBAL_SCHEMA` follow-up is explicitly for MAINTAIN.

Architect is holding the `resolveRegistryArchitect` id-order issue for the human — I am NOT filing
it. My test keeps pinning current behaviour with the divergence comment unchanged, as instructed.

Mutation sweep now 7 points, all caught: strip normalize / drop workspace scope / delete dismissal
call / drop sender affinity / delete architect-skip / retarget scheduleDrain / getArchitects
registration order.

## Protocol completion (round 3)

Architect verified the round-2 fixes independently and requested no further changes; all three of
my declines were accepted with their stated reasons. But the AIR protocol itself was still
incomplete — `porch status 1477` showed PHASE: implement with build/tests "not yet run". A PR being
open is not the same as the protocol being done, and #1477's checkbox in the #1483 tracking issue
can't be ticked until it is.

- `porch check 1477` → build ✓ (13.4s), tests ✓ (28.7s).
- `porch done 1477` → advanced implement → **pr**.
- PR phase criteria: `pr_exists`, `e2e_tests`.
- Running the PR-stage 3-way CMAP (`--type pr`) as instructed. This is a DIFFERENT review from the
  architect's integration CMAP on the PR — different stage, different prompt — so it is not skipped
  on the grounds that the PR was already reviewed.

### PR-stage CMAP verdicts

**gemini APPROVE (HIGH)** — no issues. **codex COMMENT (HIGH)** — one real doc inaccuracy.
**claude APPROVE (HIGH)** — none blocking, three minor items.

Claude re-ran three mutations itself against real source (restoring after) and reproduced my
claimed counts exactly. It also checked CI is ubuntu+macos only, so the symlink fixture has no
Windows exposure — a platform risk I had not thought to check when I chose symlinks.

Acted on:
- **Stale size disclosure** (codex): PR body said 511 lines; actual is 544 (248 + 296), or 550
  added lines counting the cross-reference. That was my round-1 number left unrevised after round 2
  grew the files — the same class of error as the false normalization claim, just cosmetic this
  time. Corrected, with a note saying it was corrected.
- **Stale-symlink EEXIST hazard** (claude): the module-scope `symlinkSync` uses a PID-derived name,
  so a hard-killed run strands the link and a later run drawing the same PID dies at COLLECTION —
  losing the whole file with an opaque error, not one test. Added `rmSync(..., { force: true })`
  before it. Verified the primitive both ways: EEXIST without, idempotent with.

NOT acted on, deliberately:
- Claude flagged that the `resolveRegistryArchitect` ORDER BY id divergence has no filed issue and
  "dies with this review thread". The concern is right, but the architect explicitly holds that one
  for the human and told me not to file it. Raised it with them instead of acting. A reviewer being
  correct does not override an explicit instruction about whose call it is.
