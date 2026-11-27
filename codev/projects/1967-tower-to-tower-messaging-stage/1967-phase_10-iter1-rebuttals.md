# Phase 10, iteration 1: response to review

Reviews: codex REQUEST_CHANGES (HIGH), claude APPROVE (HIGH). Codex's point is taken. Claude's
notes are each taken, or answered below. Nothing is disputed.

## Changed: a query's relay call records its payload size (codex 1)

Right. Contract section 8 says the sending Tower records "every relay call it makes ... the
payload size". `recordQuery` always wrote `payloadSize: null`. Now:

- the relay call a query makes records its payload's size, `payload.bytes.length`;
- a refusal before any call is made still records null, as a message's does. That covers
  this Tower's own checks, an unknown Tower, and a call the cloud client declines. The
  outbox, likewise, records only calls it makes.

R already recorded the received payload's size for every kind.

Tests:

- `peer-discovery.test.ts` checks the size on the answered call's record and on a refused
  call's record, and checks null on each pre-call refusal. Both checks of a call fail with
  the fix removed.
- `peer-discovery.e2e.test.ts` checks that both Towers record the same non-zero size for one
  query.

## Changed: `shownLines([])` (claude 3)

`Math.max()` of an empty list is `-Infinity`. It is harmless today, since `padEnd` ignores
it and the only caller handles the empty list first. The width now starts at 0, and a test
checks that the empty list gives no lines.

## Answered, not changed

- **R's limit counts answered queries only (claude 1).** As claude says, this follows the
  contract's step order. The limit is step 15, and a query without a grant is refused at
  step 14 before it. A peer that keeps asking without a grant is therefore bounded by C's
  10 a minute per pair, not by R. Each minute's refused queries become one counted record
  row. The thread records this for the architect.
- **Two clocks (claude 2).** `QueryLimit.take` reads `deps.now()` and the payload's
  freshness reads `request.receivedAt`. A message's step 15 does the same (receiver,
  `decide`), so the query path matches it rather than starting a convention of its own.
- **`QUERIES_PER_PEER_PER_MINUTE` in `discovery.ts` (claude 4).** It is a limit R enforces,
  not a wire constant, so it stays beside the code that enforces it.
- **`/api/peer/show` is reachable through the cloud's `/t/` proxy (claude 5).** This is
  intended, as claude reads it. The barrier is on `/__tower/peer`, and phase 12's Peers panel
  needs the `/api/peer/*` routes remotely. Phase 10 adds a read-only route under that prefix,
  and it changes nothing.
