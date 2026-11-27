# Phase 9, iteration 1: response to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH).

Both reviews warn that `.builder-state.md` changed while they ran. I made that change: I
updated my own untracked state file just after starting the two lanes. Nothing a reviewer
reads changed. It was still against the standing order not to touch the tree while lanes
run, and I have not done it since.

## codex

### 1. The route trims the message before the sender sees it — not changed

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

### 2. The 48 KiB limit is checked before the sender's ordered checks — changed

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

### 3. The headline path never shows delivery through the gate — changed

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

## claude (APPROVE; the comments taken or answered)

### 1. The receiving Tower's `detail` is never printed — changed

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

### 2. An outbox rejection reaches the caller as a 500 — not changed

`Outbox.enqueue` rejects only when the outbox has stopped (Tower is shutting down) or when
its own look at the queue threw. Either way the row is stored and held, and `afx inbox`
lists it. But this Tower cannot promise it will be sent: a look that threw may throw again.
Answering `held` would hide a fault behind a success-shaped answer. The project's rule is to
fail loudly, so the caller gets the error, and the held row is there to see and dismiss.

### 3. Phases 8 and 9's readings are not yet in the review document — not changed now

They are in the thread, phase by phase, written to be copied. The review document is
written in the review phase, as its header says. Phase 9's readings, and the two changes
above, go there with phase 8's.

### 4. "2 held message(s)" — changed

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
