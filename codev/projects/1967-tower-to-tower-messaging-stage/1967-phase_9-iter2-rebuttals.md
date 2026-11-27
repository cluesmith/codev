# Phase 9, iteration 2: response to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH). Every point is taken; none is
disputed.

## Changed: a file over 48 KiB was refused before Tower's checks (codex 1)

Right, and the same gap codex 2 found in iteration 1, on a path I missed. `readFileContent`
refused a `--message-file` (and a `--file` attachment) over 48 KiB before the recipient was
known. So an oversized file for another Tower with remote messaging off was told "too
large", and a CRLF file that fits once normalised was refused.

- **`afx send`:** whether the recipient is on another Tower is now decided before any file
  is read. For one, a file's size is left to Tower's sender, in the contract's order and on
  the body once normalised. A local recipient, and every `--all` send, keeps the 48 KiB
  limit with the words it had.
- **The one bound left:** a file larger than any request Tower reads (1 MiB, which
  `parseJsonBody` drops unanswered) is refused before any call: `Message file too large: N
  bytes (Tower takes no request over 1048576 bytes)`. The 1 MiB is now one constant,
  `MAX_REQUEST_BODY_BYTES`, beside `MAX_MESSAGE_BYTES`, and `parseJsonBody` takes its
  default from it.
- **Tests** (`peer-send-cli.test.ts`):
  - an over-48 KiB `--message-file` with remote messaging off is refused as off, by Tower;
  - a CRLF file over 48 KiB as written but under it once normalised is sent as written;
  - a `--file` attachment that takes the body over 48 KiB reaches Tower;
  - a file over 1 MiB is refused with no call, while a local recipient and `--all` keep the
    48 KiB refusal.

## Changed: the byte count for a remote send was taken before normalising (codex 2, claude 1)

Both reviews raised it. I had read `bodyLength` as the body as typed, as for a local send,
and recorded that in the thread. The better reading is theirs. For a remote send the
48 KiB check runs on the normalised body, and the receiving Tower stores that body, so
"(N bytes)" should count those bytes.

- **Sender:** each delivered or held result carries `bytes`: the body's UTF-8 length as
  stored and sent, once normalised.
- **Route:** it reports that count as `bodyLength`.
- **Tests:**
  - `peer-sender.test.ts`: a CRLF body counts its normalised bytes, and every delivered
    and held answer carries the count;
  - `tower-routes.test.ts`: the CRLF case reports the sender's count, not the typed length.

## Changed: the SDK read a refusal's fields but not an answer's (claude 2)

`readRemoteRefusal` checked each field's type, but a delivered or held answer's `remote`
went through as it came.

- **SDK:** `readRemoteAnswer` now reads it the same way: no `remote` without a string
  `peer`, and each other field only if it has its type. So "the SDK reads `detail` as text
  only" holds for answers as well as refusals.
- **Tests** in `tower-client-send.test.ts`.

## Changed: the held-on-fault line ended in its error code (claude 3)

The words say the message is stored and must not be sent again, and they are the line now.

- **SDK:** it gives a `REMOTE_HELD_ON_FAULT` failure its `message` as the error, as it does
  for `REMOTE_REFUSED`, and keeps the code in `errorCode`.
- **Output:** `afx send` prints `[error] Message stored and held on this Tower — …` with
  nothing after it.
- **Tests** in `tower-client-send.test.ts` and `peer-send-cli.test.ts`.

## For the review phase: phases 8 and 9's readings (claude 4)

As in iteration 1: they go into the review document in the review phase. That now
includes the architect's ruling on the held-on-fault words and the `bodyLength` reading
changed here.

## Verification after the changes

- **Layer A, the changed files:** 442 tests across six codev files pass, and so do the
  SDK's 24 send tests.
- **Type-check:** clean for the new and changed tests. The errors left are the older ones
  in `tower-routes.test.ts`, as before.
- **Layer A in full:** 10 887 passed, 116 skipped, in 477 files, 242.4 s.
- **Layer B:** `peer-send.e2e.test.ts` after the build, at load 3.8: 20 of 20 in 60.9 s.
