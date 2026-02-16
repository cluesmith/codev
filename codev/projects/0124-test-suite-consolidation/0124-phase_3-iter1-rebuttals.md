# Phase 3 — Rebuttal (Iteration 1)

## Consultation Results
- **Gemini**: APPROVE
- **Codex**: REQUEST_CHANGES
- **Claude**: APPROVE

## Responses

### 1. tunnel-edge-cases.test.ts not reduced to ~13 tests (Codex)

**Disagree — plan's estimate was based on misattributed tests.** The plan said to remove "backoff cap, simple timeout, reconnect count tests" from tunnel-edge-cases.test.ts, but those tests don't exist in that file. The backoff/cap tests are in `tunnel-client.test.ts` (the `calculateBackoff` describe block). The plan miscategorized which tests lived where.

The 21 remaining tests in tunnel-edge-cases.test.ts are all substantive integration tests:
- Malformed auth responses (2) — tests `invalid_auth_frame` and `internal_error` error types
- Disconnect after auth (1) — unique server-drops-after-auth-OK scenario
- Rapid connect/disconnect cycles (2) — resource leak prevention
- Blocked path enforcement through tunnel (2) — real enforcement, not just unit function tests
- Concurrent proxied connections (1) — load test with 50 simultaneous requests
- State listener error isolation (1) — verifies throwing listeners don't crash client
- Double connect/disconnect idempotency (3) — important invariant tests
- Uptime accuracy (2) — lifecycle timing tests
- Streaming response (1) — chunked/SSE proxy verification
- Rate limiting (1) — transient error handling
- Connection close mid-request (1) — graceful failure during active proxy
- Config edge cases (4) — missing key, missing URL, config deletion, empty towerId

None of these are trivial. Removing any would lose real coverage. The spec says "when in doubt, keep the test" — and none of these are doubtful.

The net removal shortfall (16 vs 35-50 target) will be compensated in Phase 4 (trivial test removal), which targets 60-80 tests and can be expanded.

## Conclusion

No changes made. The edge-cases file was reduced by what could be safely removed (5 tests: 3 benchmarks + 2 duplicates). The remaining tests are substantive and should be kept per spec guidance.
