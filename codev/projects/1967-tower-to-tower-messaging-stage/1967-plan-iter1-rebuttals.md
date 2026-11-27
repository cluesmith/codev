# Plan 1967, iteration 1: responses to review

Codex asked for changes, and Claude commented. I checked every point against the tree before taking
it. All were accepted and nothing is disputed. The plan now has thirteen phases.

## Codex (REQUEST_CHANGES)

1. **Playwright could reuse the live Tower.** Accepted, and verified: `playwright.config.ts` falls
   back to port 4100 with `reuseExistingServer: true`. Phase 12 adds `playwright.peers.config.ts`,
   modelled on `playwright.decisions.config.ts`:
   - it refuses to start unless `TOWER_TEST_PORT` is set and is not 4100, and unless
     `CODEV_AGENT_FARM_DIR` and `SHELLPER_SOCKET_DIR` are throwaway directories (the database lives
     in the agent-farm directory);
   - it always starts a fresh Tower (`reuseExistingServer: false`) and skips the default global
     setup;
   - the default config ignores the peers suites;
   - the exact invocation is in the file's header, and an acceptance criterion checks the refusals.
2. **"One module" against the independent stand-in.** Accepted. The invariant and its structural test
   now cover production files only. They explicitly exempt `__tests__/` directories, where the
   stand-in and the tests that craft raw requests live, and say why (choice 2).
3. **Raw schema equality is not viable.** Accepted, and verified: v17 and v18 append columns. Phase 3
   now compares normalised schemas:
   - tables;
   - columns by name (`PRAGMA table_xinfo`: type, nullability, default, primary-key position);
   - foreign keys and unique constraints;
   - indexes with their columns, uniqueness and partial clause;
   - `CHECK` expressions with whitespace normalised.

   `mailbox`'s `CHECK`s are asserted unchanged by the migration.
4. **`OverviewData` and the scope of the counts.** Accepted. Phase 11 names `OverviewData` in
   `packages/types/src/api.ts`. All three counts are workspace-scoped as `heldCount` is:
   - `heldCount` keeps its meaning and now excludes `release_hold = 1`;
   - `heldForReleaseCount` counts remote mail for recipients in the workspace;
   - `waitingForPeerCount` counts `peer_outbox` rows whose *sending* workspace is this one.

   For that, `peer_outbox` now stores the sending workspace path (phase 3).

## Claude (COMMENT)

1. **The wrong file for the held counts.** Accepted, and verified. Phase 11 now names
   `servers/overview.ts`, where the counts are computed and `OverviewData` is assembled, the fallback
   object in `servers/tower-routes.ts`, and `OverviewData`. Phase 12 names every `apps/web` consumer:
   `src/lib/api.ts`, `src/components/App.tsx`, `src/lib/heldMail.ts`, `HeldCountBadge.tsx`, and the
   tests `heldMail.test.ts` and `HeldCountBadge.test.tsx`.
2. **`not-registered` depends on #1871.** Accepted, and verified: deregistration on `main` deletes
   `cloud-config.json`.
   - Phase 8 builds the half that needs no marker: a key the cloud rejects (`401`) refuses as
     `not-registered`.
   - The pre-call check against #1871's marker is written against whatever marker #1871 lands.
   - If #1871 has not merged by phase 13, that check and its scenario are named in the review as
     waiting for it, and the architect is told.
   - The Executive Summary's dependency section and the risk row now say this.
3. **The harness cannot pre-write `cloud-config.json` through `startTower`.** Accepted, and
   verified.
   - Phase 2 spawns each Tower directly, following `bugfix-1515-tower-isolation.e2e.test.ts`. The
     harness owns the agent-farm directory, with `cloud-config.json` and `local-key` written before
     the spawn, a socket directory and a throwaway `HOME`, and it cleans them up itself.
   - The same directories serve the restart that phase 9 needs, and the throwaway `HOME` keeps test
     Towers away from the owner's `~/.codev/config.json`.
4. **R's 50-undelivered cap has no criterion.** Accepted. Phase 6 now asserts both of R's limits on an
   injected clock: the 31st message in a minute with `retryAfterSec`; the 51st undelivered with no
   `retryAfterSec`; and acceptance again once one is delivered or dismissed.
5. **Phase 8 oversized; phase 6 less so.** Accepted, with the split the reviewer suggested:
   - **Phase 8** is the outbox and the sender's checks, proven in-process (layer A, including the
     pipeline test);
   - **Phase 9** is the routing in `tower-messages.ts`, the CLI and the layer B headline scenarios;
   - discovery moves out of phase 6 into its own **phase 10**, with R's answer and `afx peer show`
     together.

   Phases 9 to 11 became 11 to 13, and every table and cross-reference was renumbered.
6. **Path and type imprecisions.** Accepted:
   - `utils/agent-names.ts`;
   - `held-for-release` joins the reason union in `packages/types/src/api.ts`;
   - `packages/sdk/src/hold-verdict.ts` renders it by name instead of falling back to a bare `held`
     (phase 3).
7. **Where the `*.e2e.test.ts` exclusion comes from.** Accepted. Choice 4 now attributes it to
   `vitest.config.ts`'s exclude list, which porch's `--exclude` adds to. Phase 2 has a criterion: run
   porch's exact command once with the new `two-towers-harness.e2e.test.ts` in place and confirm it
   does not run.

## Also changed

- `afx peer list` (phase 7) no longer claims the not-verifying, clock and cloud-error marks before
  phase 8 sets them. They are added to its output in phase 11, with a criterion.
