# Plan 1967, iteration 3: responses to review

Both reviewers asked for changes. I checked every point against the tree and took all of them.
Nothing is disputed.

## Codex (REQUEST_CHANGES)

1. **The first two inserts must be atomic.** Accepted. Phase 6 inserts the `peer_accepted` row and
   the mailbox row in one SQLite transaction, `peer_accepted` first.
   - Its primary key (peer Tower id, message id) decides a race between two arrivals of one
     message. The conflicting insert rolls back and is answered as a duplicate, or as a `mismatch`
     if the payload hash differs.
   - The gate attempt is made only after the commit.
   - New criteria inject a failure before the first insert, between the two, after both but before
     the commit (neither row survives, and a retry is accepted once), and after the commit (both
     survive, and a retry is a duplicate). Two concurrent arrivals of one message produce one row.
2. **Unverified requests never reach the receiver's records.** Accepted.
   - Phase 5 adds a second injected hook to the tunnel client. Every request that reaches the entry
     point produces exactly one structured event: the session, the step that ended it, the outcome,
     the sending Tower only after step 2, and the request id and kind only after step 4. The event
     never carries the secret, the statement, the MAC or the body.
   - Phase 6 wires the hook to the record (the session and `unverified` before step 2, aggregated
     per minute) and to the clock surface (step 7).
   - Both phases have criteria covering a failure at each of steps 1 to 8.

## Claude (REQUEST_CHANGES)

1. **Set-based dismissals bypass the accepted-once mirror.** Accepted, and verified:
   `dismissHeldForAgent` (`db/mailbox.ts`, called by `afx cleanup`) dismisses every held row for an
   agent in one statement, and builders can receive remote mail.
   - The mirror now covers every status-writing statement in `db/mailbox.ts`, single-row and
     set-based. The set-based ones join `peer_accepted` to the rows they actually changed.
   - Only real changes are mirrored. A guarded update that changes nothing rewrites nothing.
   - `superseded` is stated to be unreachable for remote rows, because remote inserts leave
     `supersede_key` NULL, and a test asserts it.
   - New criteria: each status-writing statement is tested against a remote row, and a listing test
     fails when a new one appears without such a test. `afx cleanup` of a builder with remote mail
     held leaves `peer_accepted` reporting `dismissed`, and a duplicate gets `refused`,
     `dismissed`.
2. **The three-shell Windows check had no target.** Accepted, and verified: `windows.yml` runs
   every step under `shell: bash`, and nothing probes `afx://`.
   - Phase 5 adds an `--argv` section to `scripts/windows-probe.mjs`.
   - It adds three steps to the workflow's `probe` job (`shell: bash`, `pwsh`, `cmd`), each typing
     two addresses unquoted and failing unless both arrive byte for byte.
   - Phase 5's Windows run is the first to run it, and phase 13 runs it again. The risk row and
     both tables were corrected.
3. **Scope of phase 3's grep.** Accepted. It covers non-test source files under `packages/*/src`,
   the scope phase 1 uses. The one-off script under `packages/codev/scripts/` is outside it.
4. **The prune pass lives in `mailbox-delivery.ts`.** Accepted, and verified (`pruneTerminal` at
   boot and periodically). Phase 4 resolves the setting in `mailbox-wiring.ts` and runs the peer
   prune in `mailbox-delivery.ts`, threaded through like `retentionDays`.
5. **`release_hold` after release.** Accepted. Release clears it, and dismissal clears it in the
   same statement. So `release_hold = 1` only ever goes with `status = 'held'`. A criterion asserts
   this after release, delivery and dismissal.
6. **Playwright evaluates the config in every worker.** Accepted. The config reuses paths already
   in its environment and calls `mkdtemp` only when there are none, which happens only in the main
   process. A test loads the config module twice and finds one set of directories.
7. **The layer-A precedent.** Accepted. It now cites `tunnel-integration.test.ts` and
   `tunnel-client.test.ts`, which run inside porch's check.
8. **Dead mock code.** Accepted. Phase 5 removes `mock-tunnel-server.ts`'s `lastMetadata` and its
   `POST /api/tower/metadata` handler together with the push they served.
