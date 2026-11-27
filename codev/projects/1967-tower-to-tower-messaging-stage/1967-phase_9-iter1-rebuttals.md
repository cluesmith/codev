# Phase 9, iteration 1: response to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH).

Both reviews warn that `.builder-state.md` changed while they ran. I made that change: I
updated my own untracked state file just after starting the two lanes. Nothing a reviewer
reads changed. It was still against the standing order not to touch the tree while lanes
run, and I have not done it since.

## Disputed: the route trims the message before the sender sees it (codex 1)

*The architect checked this against `main` (the same trim, `tower-routes.ts` line 2499) and agreed it stays.*

`handleSend` has trimmed every message, local or remote, since before this spec
(`body.message.trim()`). That trim decides what "the message" is for every `afx send`,
`bodyLength` included. Phase 9 hands the sender the same message a local send would get.

The contract asks the sender for two things before it serialises the body: Decision 7's
line-ending rule, and removing its listed code points. Then it stores those exact bytes
and resends them on every retry. All of that holds: the trim happens once, before
anything is stored, and every retry sends the stored bytes. The spec does not say the
remote path must keep the leading and trailing whitespace a local send drops.

Keeping it only for remote sends would make the same command type different text
depending on where the recipient is. Changing it for all sends changes every local
`afx send` and belongs in its own issue.

## Changed: the 48 KiB limit was checked before the sender's ordered checks (codex 2)

This was right. `/api/send` and `afx send` both refused a body over 48 KiB before the
sender ran its checks. So an oversized send with remote messaging off was told "too large"
when contract section 4 says "remote messaging is off". The route also measured the body
before normalising it, so a body that fits once CRLF becomes LF was refused.

- **Route:** for an address naming another Tower, it now leaves the size to the sender's
  check 6, in its order and on the normalised body. The request is still capped by
  `parseJsonBody`. An address naming this Tower's own name, which the sender hands back
  as `local`, is still refused at the local limit.
- **CLI:** it no longer checks the size of a body whose recipient is on another Tower.
  A local recipient is still refused before any call.
- **Tests** (`tower-routes.test.ts`, `peer-send-cli.test.ts`):
  - an over-large body with remote messaging off is refused as `remote-off`, through the
    route and through the CLI;
  - a body over 48 KiB as sent but under it once normalised reaches the sender;
  - an over-large body to this Tower's own name is `MESSAGE_TOO_LARGE`;
  - a local over-large body is still refused by the CLI with no call.

## Changed: the headline path never showed delivery through the gate (codex 3)

Also right. The architects were inert terminals, so the headline case showed acceptance
and the frame, not delivery. The case now uses a `live` workspace on each Tower whose
architects run an echo program named `claude`, so the gate resolves claude's profile from
the launch command. The test draws a clean claude composer before each send.

- **mbp to devvm:** refused until devvm grants, then
  `[ok] Message delivered to afx://devvm/live:architect (32 bytes)`, and devvm's mailbox row
  is `delivered`.
- **The reply:** devvm sends the footer's command exactly as printed. It is refused until mbp
  grants, then delivered the same way.

The other cases keep inert recipients: what they test is the sender and the outbox, not the
gate.

## Changed: the receiving Tower's `detail` was never printed (claude 1)

Spec section on stage 3 risks: "R's `detail` text reaches the sending agent's context
through the CLI's output. Between Towers of one owner that is intended." This version's
receiving Tower sends no `detail`, but a later one may, and it was being dropped.

- The sender already makes it printable (`printableDetail`: control characters stripped,
  length capped).
- The route now passes it on, in the refusal as `detail` and in an answer as
  `remote.detail`. The top-level `detail` stays the local gate's verdict (#1482), so the two
  are never read as one another.
- The SDK reads it (text only).
- `afx send` prints it after this Tower's words: `[error] Refused by devvm: …
  (devvm says: …)` for a refusal, and `[info] devvm says: …` after a delivery or a hold.
- Tests in `tower-routes.test.ts`, `tower-client-send.test.ts` and `peer-send-cli.test.ts`.

## Changed, by the architect's ruling: an outbox rejection reached the caller as a bare error (claude 2)

I first answered that this stays an error. The architect ruled that it may stay one, but not
in these words. `Sender.send` let the outbox's rejection through as it was, so the sending
agent saw `outbox: a message was queued after the outbox stopped`, and nothing said the
message was stored. An agent that sees a bare error sends again, and the recipient gets the
message twice.

`Outbox.enqueue` rejects in two cases. The outbox has stopped (Tower is shutting down), or
its attempt failed in this Tower. In both the row stays held, and it is sent once the outbox
runs. Now:

- The sender catches the rejection in the one place the message id is known, logs an ERROR,
  and throws `PeerSendHeldOnFaultError`.
- That error's one message (`heldOnFaultMessage`): `Message stored and held on this Tower —
  mailbox id <id> — but not sent to <peer> now: <this Tower is stopping | a fault in this
  Tower, named in Tower's log>. It is sent when that clears. Do not send it again. See or
  dismiss it with: afx inbox`.
- The route answers it as a `503` with `error: REMOTE_HELD_ON_FAULT`, the words, the
  `mailboxId` and the `peer`. `afx send` prints the words and exits 1. Its `--retry` resends
  only a refused connection, so this is never sent a second time.
- Tests, one per path, on the real outbox and sender (`peer-pipeline.test.ts`):
  - **stopped:** the words, the row held, the ERROR, then sent once by a restarted outbox;
  - **an attempt that failed in this Tower:** the same, then sent once at the next look.

  Plus the route's `503` (`tower-routes.test.ts`) and the CLI's line and exit
  (`peer-send-cli.test.ts`).
- `afx inbox` lists and dismisses mail waiting for a peer from plan phase 11, in this PR, as
  phase 8's waiting-cap refusal (`See them with: afx inbox`) already assumes.

## For the review phase: phases 8 and 9's readings are not yet in the review document (claude 3)

They are in the thread, phase by phase, written to be copied. The review document is
written in the review phase, as its header says. Phase 9's readings, and the two changes
above, go there with phase 8's.

## Changed: "2 held message(s)" (claude 4)

`1 held message for devvm goes before it.` and `2 held messages for devvm go before it.`,
with tests for both.

## Verification after the changes

- **Layer A:** the five files these changes touch pass (415 tests), and so does the SDK's
  send suite (22).
- **Type-check:** clean for the new and changed tests. The 14 errors in
  `tower-routes.test.ts` are all in older parts of that file, the same as in iteration 1.
- **Layer A, in full:** 10 879 passed, 116 skipped, in 477 files, 242.3 s.
- **Layer B:** `peer-send.e2e.test.ts`, run 3, after the build, at load 2: 20 of 20 in
  58.9 s, the headline path delivered both ways.
