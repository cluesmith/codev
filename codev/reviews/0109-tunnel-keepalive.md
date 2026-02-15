# Review: Tunnel Keepalive (Heartbeat & Dead Connection Detection)

## Summary

Added WebSocket ping/pong heartbeat to `TunnelClient` to detect silently dead connections and trigger automatic reconnection. The implementation sends a WebSocket ping every 30 seconds and declares the connection dead if no pong is received within 10 seconds, triggering the existing reconnection logic.

## Spec Compliance

- [x] Tower sends WebSocket pings every 30 seconds while tunnel is connected
- [x] If no pong within 10 seconds, tunnel state transitions to `disconnected` and reconnection begins
- [x] Logs `Tunnel heartbeat: pong timeout, reconnecting` at warn level on dead connection
- [x] Normal pongs do not generate log noise (silent success)
- [x] Heartbeat timers are cleaned up on disconnect (no leaked intervals)
- [x] Existing reconnection logic (exponential backoff, circuit breaker) applies after heartbeat-triggered disconnects
- [x] `startHeartbeat()` is idempotent — no duplicate timers or listeners
- [x] Stale WebSocket guard prevents timeout from previous connection triggering reconnect on new connection
- [x] `ws.ping()` errors are caught — do not crash the process
- [x] Unit tests cover all 10 specified scenarios

## Deviations from Spec

1. **Logging**: Spec code sample uses `logger.warn()` but the file has no logger module. Used `console.warn()` to match existing patterns. Functionally equivalent.

2. **Listener cleanup**: Spec says "No explicit `removeListener()` is needed" (section 5). Plan added `removeAllListeners('pong')` in `stopHeartbeat()` with a `heartbeatWs` tracking property to prevent listener accumulation on duplicate `startHeartbeat()` calls to the same ws. This is a defensive improvement over the spec.

3. **Pong timeout on ping throw**: Spec code returns early in the catch block, skipping timeout scheduling. Implementation falls through to arm the pong timeout even when `ws.ping()` throws, ensuring dead connection detection when `readyState` reports `OPEN` but the socket is in a bad state. Caught by Codex review.

## Lessons Learned

### What Went Well
- The spec was very detailed with code samples, making implementation straightforward
- 3-way consultation caught real issues (test file path, logger, ping-throw timeout, listener idempotency, test quality)
- Two-phase plan (implementation, then tests) was the right granularity for a single-file change

### Challenges Encountered
- **Mock WebSocket recursion**: The mock's `removeAllListeners` override initially called itself recursively. Fixed by saving a reference to the original before overriding.
- **Fake timer interaction with scheduleReconnect**: Advancing timers by `PONG_TIMEOUT_MS` also triggered the reconnect timer's backoff (1.5s < 10s), changing state to `connecting`. Fixed by restructuring the concurrent test to verify timer state rather than advancing time past the reconnect threshold.
- **Claude worktree visibility**: Claude's Phase 2 iter 1 review read from `main` instead of the feature branch worktree, producing a false positive claiming no code existed.

### What Would Be Done Differently
- Export heartbeat constants from the start (planned for test use) rather than noting it as a Phase 2 detail
- Write mock WebSocket as a reusable test helper if more tunnel tests are anticipated

## Technical Debt
- None introduced. The change is narrowly scoped and uses existing patterns.

## Follow-up Items
- Server-side read deadline and optional server-side ping (documented in spec for codevos.ai team, not part of this PR)
- Manual test: sleep/wake Mac and verify reconnect within ~40 seconds
