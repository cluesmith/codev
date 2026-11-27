# Phase 3, iteration 1: response to review

Codex asked for changes (3 points); claude approved with notes. All three codex points are
accepted and fixed. No point is disputed.

## Codex

### 1. A row held for release kept its gate detail, so it could read `held-for-release:user-text`

Accepted. `db/mailbox.ts` now has `reportedDetail(row)` next to `reportedReason(row)`: it reports
no detail while a held row carries `release_hold = 1`, and the row's own detail otherwise. The
row keeps its detail underneath, so once released it reads as before (`busy:user-text`). Both
inbox routes (`GET /api/inbox` and `GET /api/inbox/:id`) report the pair through these two
functions.

I chose to suppress the detail rather than clear it. Clearing it would lose the gate's last
verdict, which the row reports again after release.

Tests:
- `peer-storage-migration.test.ts`: "reports no gate detail while held for release, and its own
  again once released". It also runs the pair through the SDK's `formatVerdict` and expects
  `held-for-release`, then `busy:user-text`.
- `inbox-routes.test.ts`: "held for release (Spec 1967)" drives both routes through
  `handleRequest` on a real in-memory mailbox. Before the fix, the routes returned the raw
  `detail`, so this test would have failed.

### 2. `resolveOutbox` COALESCEd `last_reason`, so `delivered` could sit beside `tower-offline`

Accepted. When an answer ends the row (`outcome` is not null), it now replaces the last
answer's outcome and reason as a pair, a null reason included. When no answer ends it (a
dismissal or an expiry, `outcome: null`), the last answer's pair is kept, because it is still
the last thing the peer said. A resolution with no answer may not carry a reason of its own;
the store throws if one does.

The outbox test now expects `lastOutcome: 'delivered', lastReason: null` after
`tower-offline` → delivered. It also covers the no-answer case: a refused reason with
`outcome: null`, then a dismissal that keeps `unavailable` / `no-answer`.

### 3. Requiring a reason at insert departed from the plan (`reason = NULL`, `release_hold = 1`)

Accepted. I'm back to the plan's representation:
- `RemoteEnqueueInput.reason` is `MailboxReason | null` again.
- Mail held for release is stored `reason = NULL, release_hold = 1`. `enqueueRemote` refuses
  `releaseHold: true` together with a reason, since such mail has had no gate attempt.
- A row is never told a verdict it did not receive. The mailbox keeps NULL until a gate attempt
  sets a reason, including after release.

What a duplicate is told is decided in one place, `acceptedStateOf`. A held row with no gate
verdict yet (accepted and not yet attempted, or released and not yet attempted) answers `held`
with reason `busy`. That is the contract's own answer for an accepted message whose write has
not started, so it is the answer the receiver gives at that moment either way. It lives only in
`peer_accepted`, never in the mailbox row, so nothing "resurfaces after release": release leaves
the row's reason NULL, and the first gate attempt sets the real one.

Tests: "a row with no gate verdict yet is NULL in the mailbox and busy to a duplicate", "refuses
mail held for release that claims a gate reason", and "a row released before any gate attempt
keeps no reason, and a duplicate is told busy". The enqueueRemote mirror test now checks the
held-for-release row is `reason: null, release_hold: 1` in the mailbox.

The thread's earlier note ("phase 6 passes busy at insert") is replaced: phase 6 inserts with
`reason: null`.

## Claude (approved; notes taken)

1. **`checkedState` allowed `held` with a null reason.** Fixed. It now refuses that case as well
   as its inverse, on every write (`insertAccepted`, `mirrorAcceptedState`) and on every read
   (`toAccepted` goes through it). A bad row now fails where it is written, not when a duplicate
   arrives. Tested on write, on mirror, and on a row corrupted by hand and then read.
2. **`writeListing` throws on raw cloud values.** Kept as is; the store stays strict. Recorded in
   the thread as a phase 7 handoff: `peer/cloud-client.ts` normalises the listing before caching
   it.
3. **`payloadSize` was checked with the epoch-ms helper.** Fixed with a `nonNegativeInt` helper,
   which `epochMs` now wraps. Tested for the exact message.
4. **Badge and popover can disagree by the held-for-release count until phases 11 and 12.**
   Recorded in the thread for phase 12.
5. **Layer A wall time missing from the thread.** It is in the phase 3 commit message (45 tests,
   1.36 to 1.50 s over three runs), and it is now recorded in the thread too.

## Verification

- `peer-storage-migration.test.ts`: 51 passed. `inbox-routes.test.ts`: 28 passed.
- The 10 neighbouring suites (mailbox, inbox, peer contract, Spec 1313 migration and others):
  461 passed.
- `tsc --noEmit` on the package is clean. A scratch type-check of the two edited test files
  finds nothing in the new code; it shows only 3 pre-existing errors in `inbox-routes.test.ts`'s
  `makeRes` helper, which I did not touch.
