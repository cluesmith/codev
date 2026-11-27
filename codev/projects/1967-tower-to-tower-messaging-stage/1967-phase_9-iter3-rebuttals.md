# Phase 9, iteration 3: response to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH). Every point is taken; none is
disputed.

## Changed: the 1 MiB guard was measured on the file, not the request (codex 1, claude 2)

Right. Both reviews raised it. Iteration 2's guard compared each file's raw bytes with
Tower's request ceiling, but Tower applies that ceiling to the whole JSON request. The
envelope, JSON escaping, or a `--message-file` and a `--file` together could pass the
guard and still be dropped unanswered by `parseJsonBody`, which a sender sees as a
transport error.

- **The exact check is in the SDK**, where the request is built. `sendMessage` encodes the
  request once, measures its UTF-8 bytes (what `parseJsonBody` counts), and refuses one
  over the ceiling without calling Tower: `Not sent: the request would be N bytes, and
  Tower reads none over 1048576.`, with `errorCode: REQUEST_TOO_LARGE`. Every caller gets
  it, not only `afx send`.
- **One source for the ceiling.** `MAX_REQUEST_BODY_BYTES` is now in `codev-types`, as a
  literal. `parseJsonBody` takes its default from it, and the SDK mirrors it as it mirrors
  `REMOTE_REFUSED`, with the mirror's type checked against it.
- **The CLI's file check stays**, as a cheap refusal of a file that could never fit. The
  SDK's check is the exact one.
- **Tests:**
  - `tower-client-send.test.ts`: a request at exactly the ceiling is sent and one a byte
    past it is not; a message under the ceiling that escaping takes past it is not sent;
  - `peer-send-cli.test.ts`: a message file and an attachment that each fit, but not in
    one request, are refused with no call, exiting 1.

## Changed: a superseded reading in the thread (claude 1)

The thread's phase 9 "readings" list still said `bodyLength` is the body as typed. It is
struck through there now, pointing to iteration 2's reading, so the review document takes
the right one.

## Changed: "This takes a local address" (claude 3)

`LOCAL_ADDRESS_ONLY_MESSAGE`, which the agent lookup gives for an `afx://` address, now
reads `Finding an agent on this Tower takes a local address: …`.

## Not changed: a held answer without `remote` (claude 4)

The review's own reading: only a malformed answer reaches that fallback. Nothing to change.

## Verification after the changes

- **Layer A, the changed files:** 489 tests across five codev files pass, and so does the
  SDK's whole suite (458, its boundary tests included).
- **Type-check:** clean for both changed test files; the SDK build checks the mirror.
- **Layer A in full:** 10 888 passed, 116 skipped, in 477 files, 244.0 s.
- **Layer B:** `peer-send.e2e.test.ts` after the build, at load 3.1: 20 of 20 in 59.6 s.
