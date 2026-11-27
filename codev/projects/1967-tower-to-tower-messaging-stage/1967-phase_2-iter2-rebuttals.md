# Phase 2, iteration 2: response to review feedback

Codex: REQUEST_CHANGES (1 point, new; iteration 1's unknown-field point is not raised again).
Claude: APPROVE (HIGH), agreeing with iteration 1's rebuttal after checking the spec text, with
seven minor observations. Nothing is disputed this round.

## Codex 1: `PUT /api/peer/state` is read with a 4 096-byte cap the contract does not set — ACCEPTED, changed

Confirmed. The contract's size constants are the message text (49 152), the statement header
(4 096), the payload (102 400) and the answer (65 536); section 7 says "The sizes and times are
protocol constants (above), not limits C sets", and none is given for the switch-state body. The
stand-in's cap was its own, and with section 0's unknown-field rule it refused a valid report
whose unknown field was long. A new limit would be a contract change to agree with the cloud,
which this phase does not make.

- `handleState` reads the body whole; the header comment says the stand-in sets no size limit
  on this body, and why.
- Test: a report of "off" with an unknown field of 20 000 characters (over 4 096 bytes) answers
  204 and the listing shows "off". The 400 cases are unchanged.

## Claude's observations

1. **Empty `x-codev-peer-to` is `400 malformed`, not listed among the readings** — changed: the
   header's list of readings now says a missing or empty `x-codev-peer-to` is malformed rather
   than `404 unknown-tower` at step 5.
2. **`handleState` counts before the 400, so a flood of malformed reports never gets a 429** —
   not changed. It is the documented order (a bad body before the limits, as the relay answers
   its header checks before its limits), and the review notes it is self-consistent.
3. **`answer-delay` does not count against `relayTimeoutMs`** — changed (documentation): the
   fault's description says the delay starts after R's answer is in, and that a forward held
   past the timeout uses `answer-late` or a short `relayTimeoutMs`.
4. **`inFlight` counts calls that fail before step 2** — documented, not changed. What a test
   checks with it is how many calls S has open to R at once, which includes calls C then
   refuses; the doc comment now says so, and that a call naming no recipient, or not of kind
   `message`, is not counted.
5. **A one-time `replay-statement` or `wrong-secret` fault can be spent on a call that then
   answers 503** — changed: the `tower-offline` re-check now runs before any forward fault is
   taken.
6. **No `enableConnectProtocol` on the stand-in's HTTP/2 client** — not changed: nothing proxies
   a WebSocket through the tunnel here, and the header already says the `/t/` proxy is left out.
7. **Slugs unique per account, not globally as in today's cloud** — not changed: the stand-in
   models the target state (codev-cloud #22), as the review agrees.

Tests: `stand-in-relay.test.ts` and `seeded-generator.test.ts`, 57 passing, about 1.4 s.
