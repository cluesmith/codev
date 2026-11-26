# Plan 1967, iteration 2: responses to review

Codex asked for changes, and Claude commented. I checked every point against the tree and took
all of them. Nothing is disputed.

## Codex (REQUEST_CHANGES)

1. **Accepted-once state must outlive mailbox retention.** Accepted, and verified: `pruneTerminal`
   deletes delivered and dismissed rows after `mailbox.retentionDays`, which can be shorter than the
   protocol's 30 days.
   - `peer_accepted` now carries the message's current state and reason itself. It is written in
     the same transaction as every status change of the remote mailbox row it names.
   - A duplicate is answered from `peer_accepted` alone, and the row is pruned only after its
     30-day expiry.
   - Phase 3 tests the transaction (rolled back together), and that a 1-day mailbox retention
     leaves the accepted-once state in place.
   - Phase 6 adds the approved spec's short-retention scenario: a retry on day 5 of a message
     delivered on day 1, with its mailbox row already pruned, answers `delivered` with
     `duplicate: true`. A message past its lifetime is `expired`.
2. **The Playwright guard and cleanup.** Accepted. `playwright.peers.config.ts` no longer takes its
   directories from the caller:
   - It creates an agent-farm directory, a socket directory and a `HOME` with `mkdtemp`, once, in
     Playwright's main process. Its workers inherit them through the environment.
   - It resolves each path with `realpath` and refuses any that is not under the system temp
     directory, or is or contains `~/.agent-farm`, the default socket directory or the real home.
   - Its `globalTeardown` removes exactly what it created.
   - The invocation needs only `TOWER_TEST_PORT`, which must not be 4100.
   - A unit test covers the path check, and a criterion checks that nothing remains after a run.
3. **Replay after `no-grant` was claimed in phase 5, before grants exist.** Accepted. Phase 5 now
   tests that a statement whose first presentation was refused by its stub handler cannot be
   presented again; the statement is used up whatever the outcome. The real `no-grant` replay is in
   phase 6, with a retry under a new statement after the grant is added. The scenario table says 5
   and 6.

## Claude (COMMENT)

1. **The grant mode's flags.** Accepted. Phase 4 carries
   `afx peer grant … [--deliver | --hold]`:
   - deliver is the default for my own Towers (Decision 4; walkthrough step 4);
   - `--hold` is the only way to reach phase 6's held-for-release path;
   - both flags together are refused;
   - `afx peer grants` shows the mode.

   Each has a criterion.
2. **Do not pull the held-count suite out of the default run.** Accepted, and verified: it
   route-mocks `/api/state` and `/api/overview`. It is extended in place and stays in the default
   run. Only `peers-panel.test.ts` goes through the peers config. `testIgnore` becomes an array, and
   `PEERS_SUITE` is exported beside `DECISIONS_SUITE`.
3. **Seeded database versus route mocks.** Accepted, keeping one real case:
   - the panel's marked states come from route-mocking its one read-only route;
   - one case reads the real route unmocked, on a fresh Tower with the switch off and a cloud with
     no relay, so the route itself is exercised and not only its rendering;
   - the custom seeding setup is dropped.
4. **No pruning for records and resolved outbox rows.** Accepted.
   - Phase 3's store gains a prune that is never shorter than 30 days. It removes records, resolved
     outbox rows and expired accepted-once rows, and never a held outbox row.
   - Phase 4 adds `peer.recordRetentionDays` (default 30, raised to 30 if set lower) beside
     `mailbox.retentionDays`, and runs the prune in the existing prune pass.
5. **Nits.** Both accepted.
   - (a) The claim now reads "every query that reads held mail", and names the
     `canonicalize-workspace-paths.ts` update. Phase 3's test greps for any `mailbox` statement
     outside the two files, so the claim is checked.
   - (b) Phase 7 has a criterion that `afx peer list` works with the switch off and says so.

## Also changed: contract revision 4

The architect relayed a cloud correction while this round ran. It was committed separately to the
spec as revision 4 (`68cff8fe4`). The plan now reflects it:

- the stand-in enforces the 600-a-minute ceiling across every `/api/peer/…` route, and answers a
  bad switch-state body with `400 malformed` (phase 2);
- a query that gets the ceiling's `429` is refused and never held (phase 10);
- a message that gets it is handled like any other `429` (phase 8).
