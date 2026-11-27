# Phase 2, iteration 1: response to review feedback

Codex: REQUEST_CHANGES (1 point). Claude: APPROVE (HIGH), with five minor observations. Each
point was checked against the contract (spec, Wire Contract, revision 4) and the code before
acting.

Both lanes report the working tree changing during the review, naming
`codev/plans/1967-tower-to-tower-messaging-stage.md`. That was me: the architect asked, while the
reviews ran, that a limit of the harness be written down under what waits for `verify-approval`
(below). No consultant wrote to the tree.

## Disputed: `PUT /api/peer/state` accepts a body with a field it does not know (codex 1) — NOT CHANGED

Codex reads section 2's "a body that is not this object" as "a body with any key besides
`remoteMessaging`", and asks that `{"remoteMessaging":"on","later":true}` be `400 malformed`.

The contract says the opposite, in its general rules (section 0, above section 1): "Receivers
ignore fields they do not know, everywhere in this contract. A change of meaning raises the
protocol version." C is the receiver of this body, so it ignores `later` and records "on". The
same rule covers the handshake's `peer` field, the statement (the shared vector "an unknown field:
verified (receivers ignore fields they do not know)", agreed with the cloud) and R's answer.
Refusing one here alone would make the switch-state report the one message in the contract that a
later, additive field breaks, which is what the rule exists to prevent.

"A body that is not this object" keeps its meaning under that reading: a body that is not a JSON
object carrying `remoteMessaging` as `"on"` or `"off"`. The stand-in answers 400 to all of those,
and the test already lists them: not JSON, `[]`, `{}`, `null`, `"on"`, `"maybe"`, `true`, and an
empty body.

The test was written with `later: true` on purpose, to pin the rule. So that the reading cannot be
missed again:

- `handleState` now says, at the check, that a field it does not know is ignored as section 0
  requires, and that the 400 is for a body that is not the object;
- the test is renamed "answers 204 and records the switch …, ignoring a field it does not know
  (section 0)".

## Claude's observations — all ACCEPTED, changed

1. **`writeRecordUnchecked` changed the account every Tower on it shares.** Confirmed: a
   statement takes the sender's owner fields from `sender.account`, so breaking one Tower's
   record broke its peers' statements too, and the test worked around it by hand. Owner fields
   written unchecked now go to that Tower's own `ownerOverride`, which only the statements it
   sends use; `restoreRecord(towerId)` puts back the slug C last wrote by its rules and the
   account's owner fields. New test: with one Tower's record broken, its calls are
   `500 cloud-error` while the other direction of the pair is forwarded with the account's
   fields, and after the restore the first direction is forwarded again (under a slug renamed
   before the break, so the restore is shown to return C's last checked write). The step 9 test
   now restores through `restoreRecord`.
2. **`rotateKey`'s [r5] behaviour had no test.** New test: replacing the key closes the session
   (`session()` becomes `null`, a relay call to it is `503 tower-offline`), the old key is `401`,
   the new key authenticates, and the next connection gets a new secret.
3. **`lastIssued` was keyed by recipient only.** Now keyed `<from>><to>`. New test: two senders
   to one recipient, and the `replay-statement` fault replays the pair's own last statement, not
   the other sender's.
4. **`forward.answer` was not kept on the `tower-error` path.** It now keeps what had arrived
   when C stopped reading: status and headers, and the body read before the size went over the
   cap (empty when the headers failed). The 502 test checks the recorded status for every case
   and that no recorded body is over 65 536 bytes.
5. **Wall time not recorded.** Measured and recorded in the fix commit and the thread:
   `stand-in-relay.test.ts` and `seeded-generator.test.ts` together run in about 1.4 s (57
   tests), against the plan's one-minute budget for all of layer A's additions. Phase 1's
   commits did not record it either; its files are left as they are.

## Also recorded this round, at the architect's direction

- The plan's phase 2 section and its scenario table now say that a restarted test Tower ends the
  terminals of its temp-directory workspaces, so layer B shows the database, `peer_outbox` and
  `peer_accepted` surviving and delivery resuming to an agent activated again, but not mail
  reaching a terminal that itself survived the restart. That waits for the real-Tower walkthrough
  at `verify-approval`. The harness's workspaces stay in the temp directory.
