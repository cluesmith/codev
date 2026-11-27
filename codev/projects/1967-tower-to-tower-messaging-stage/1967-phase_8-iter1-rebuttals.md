# Phase 8, iteration 1: response to the review

Both reviewers approved: codex APPROVE (HIGH), with no issues, and claude APPROVE (HIGH), with
five comments it marked non-blocking. Each comment is answered below.

## Claude

1. **`Decision.heldReason` is computed and asserted but never read.** Taken. `decide()` now
   returns `{ act: 'accept' }` for both `delivered` and `held`. The row stores the answer's own
   reason, as it did before. The test's assertion is updated, and the now-unused
   `PeerHeldReason` import is gone.
2. **A blocked queue persists no reason, so phase 11's `afx inbox` would show the last
   answer's reason.** Carried to phase 11, in the thread.
   - Phase 8 deliberately writes nothing to the row: a blocked look is not an attempt.
   - Phase 11 will show why a peer's queue is paused (`remote-off`, `not-connected`,
     `not-registered`, `no-relay`) as a line worked out from this Tower's state, beside each
     row's last answer.
3. **`enqueue` throws synchronously when stopped, while every other failure rejects.** Taken.
   - It now returns a rejected promise.
   - The doc comment says when it rejects, and that the row stays held either way.
   - A new test covers it: the send is rejected, no call is made, and the row is sent once the
     outbox starts.
4. **The record is written before the registration check, so a discarded answer appears in
   the log with its outcome.** Not changed. Carried to phase 11 as a note for `afx peer log`.
   - Section 8 records every relay call, and the record describes the call: what was sent and
     what came back. It does not describe the row.
   - Recording the answer as `registration-changed` would lose what the cloud actually said.
   - The row's own state, held with `registration-changed`, is where the discard shows. Phase
     11's log will show the two side by side.
5. **`towerOf(row)` can throw inside two log calls.** No change; the reviewer recommended none.
   The stored address always comes from the parser, so a throw there means the database is
   corrupt. `failed()` reports that loudly and keeps the mail held.

## Verification

After the changes, the three phase 8 test files pass: 133 tests in 2.2 s. The package
type-checks, and so does the changed test under the temporary tsconfig, which I then deleted.
