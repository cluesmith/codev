# Review: Cloud Tower Client (Tunnel & Registration)

## Summary

Replaced cloudflared integration with a built-in HTTP/2 role-reversal tunnel client that connects directly to codevos.ai via WebSocket (TICK-001). The implementation spans 7 phases across 25 files, adding 6,845 lines and removing 443 lines (net +6,402). The tunnel client uses `node:http2`, `node:http`, `node:https`, and the `ws` library for WebSocket transport.

## Spec Compliance

- [x] `af tower register` successfully registers a tower with codevos.ai
- [x] Tower automatically connects to codevos.ai on startup (when registered)
- [x] HTTP requests proxied through tunnel reach localhost:4100 and return correct responses
- [x] WebSocket connections (xterm.js terminals) work through the tunnel
- [x] Tower reconnects automatically after network disruption or machine sleep/wake
- [x] Tower stops retrying on authentication failures (circuit breaker)
- [x] `af tower deregister` removes registration and stops connection attempts
- [x] cloudflared integration code removed from tower-server
- [x] Tower operates normally without registration (local-only mode)
- [x] All existing tests pass; new tests cover tunnel client behavior
- [x] SSRF prevention: tunnel ONLY proxies to localhost:4100
- [x] Tunnel path blocking: `/api/tunnel/*` requests rejected before proxying
- [x] Exponential backoff with jitter (1s -> 60s cap) for transient failures
- [x] Rate limiting: 60s first retry, escalates to 5-minute intervals
- [x] `af tower status` extended with cloud registration info
- [x] CloudStatus component in tower dashboard

## Deviations from Plan

- **Phase 3 (Tunnel Client)**: Metadata delivery uses a dual mechanism instead of the plan's single H2 POST (which was architecturally impossible since the tower is the H2 server and cannot initiate requests). The implementation uses: (1) GET `/__tower/metadata` handler for codevos.ai H2 client polling, and (2) outbound HTTPS POST to `${serverUrl}/api/tower/metadata` for proactive push when metadata changes.

- **Phase 5 (CLI Commands)**: `af tower register` does not auto-launch a browser or run a local callback server. The registration flow uses a simpler approach: the CLI generates a token via the codevos.ai API and prompts the user to paste the token. The plan allowed for this fallback pattern ("if callback fails, prompt for token").

- **Phase 7 (E2E Tests)**: Rate limiting behavior tested via mock server instead of against real codevos.ai. Triggering real rate limits requires environment-specific knowledge of threshold configuration and could interfere with concurrent tests. Client-side rate_limited response handling is validated through the mock server. Documented in the test file header.

## Lessons Learned

### What Went Well

- **Zero-dependency tunnel**: Using only `node:http2`, `node:net`, `node:tls` eliminated dependency management concerns. The H2 role-reversal pattern works reliably.
- **TCP proxy test pattern**: Creating a transparent TCP proxy between client and server to simulate connection drops was an effective technique for testing reconnection without needing to control the remote server process.
- **MockTunnelServer**: The mock server created in Phase 3 proved invaluable throughout Phases 4-7 for fast, deterministic testing without external dependencies.
- **Phase-by-phase implementation**: The 7-phase split worked well — each phase was independently testable and reviewable.
- **ctx.skip() for conditional E2E tests**: Using vitest's `ctx.skip()` instead of early `return` properly reports tests as "skipped" rather than silently passing, making test suite health more visible.

### Challenges Encountered

- **HTTP/2 ServerHttp2Session limitations**: Cannot initiate requests from the server side. Resolved with dual mechanism: H2 GET polling (in-tunnel) + outbound HTTPS POST (out-of-band).
- **Codex review loop**: Codex consistently requested changes across 10 iterations in Phase 7, while Gemini and Claude approved. Recurring concerns (auto-start codevos.ai, rate limiting E2E) were either addressed or documented as impractical. The loop resolved when the keystroke latency measurement was added to the E2E WebSocket test.
- **Tower dashboard CSS**: Integrating CloudStatus into the existing dashboard required careful CSS work to maintain the compact layout across desktop and mobile views.
- **Tunnel integration test flakiness**: `detects config file changes in watched directory` was intermittently flaky due to filesystem watcher timing. Not related to tunnel changes but occasionally caused `porch done` failures.

### What Would Be Done Differently

- **Address metadata delivery limitation earlier**: The META frame workaround should have been identified during spec validation, not discovered during Phase 3 implementation.
- **Set iteration limits for 2/3 approval**: When 2 of 3 reviewers consistently approve, the third reviewer's recurring concerns should be evaluated against a threshold to prevent infinite iteration loops.
- **Shared test utilities**: The `waitFor` helper was duplicated across 3 test files. A shared `test-utils.ts` would reduce duplication, though test file self-containment is also valuable.

### Methodology Improvements

- **Porch convergence policy**: Consider auto-advancing when 2/3 reviewers approve for 3+ consecutive iterations and the dissenting reviewer's concerns are documented.
- **Non-functional test guidance**: The plan should explicitly state whether non-functional benchmarks (latency, memory) run against mock or real servers, to avoid review disagreements.

## Technical Debt

- `waitFor` utility duplicated across `tunnel-e2e.test.ts`, `tunnel-edge-cases.test.ts`, and `tunnel-client.integration.test.ts`
- Dynamic `import('vitest')` for `vi.spyOn` in E2E test could use the top-level import instead
- E2E tests require manual codevos.ai startup; CI integration deferred

## Follow-up Items

- **TICK-001 (WebSocket transport)**: ✅ **COMPLETED** — Rewrote tunnel-client.ts to use WebSocket (`ws` library) + `createWebSocketStream()` instead of raw TCP/TLS. Auth is now JSON messages over WebSocket matching the codevos.ai server protocol. All 13 E2E tests pass against the real codevos.ai server. Found and fixed a WebSocket close race condition (stale WS close events could destroy new connections after disconnect+reconnect).
- CI pipeline integration for E2E tests (start codevos.ai in CI, run tunnel E2E suite)
- 24-hour stability soak test (deferred per plan — impractical in automated testing)
- `af tower register --reauth` flow (re-authentication without re-registration)

### TICK-001 E2E Results (against codevos.ai localhost:3000)

| Test | Result | Time |
|------|--------|------|
| Full lifecycle (register→connect→proxy→verify) | ✅ PASS | 1.7s |
| Auth failure (circuit breaker) | ✅ PASS | 1.6s |
| Reconnect after disconnect | ✅ PASS | 3.3s |
| Auto-reconnect after server drop | ✅ PASS | 4.2s |
| Rapid reconnection (3 cycles) | ✅ PASS | 6.4s |
| Metadata delivery | ✅ PASS | 1.6s |
| HTTP proxy with echo body | ✅ PASS | 1.6s |
| Tower deregistration | ✅ PASS | 6.9s |
| SSE streaming | ✅ PASS | 1.7s |
| WebSocket proxy upgrade | ✅ PASS | 11.6s |
| **Tunnel latency: p50=12ms, p95=33ms** | ✅ PASS | 1.9s |

## Review Iteration 2 — Codex Feedback

Codex requested changes on two issues. Both fixed:

1. **SSRF blocklist bypass via percent-encoded paths**: `isBlockedPath()` now percent-decodes and normalizes the path (via `decodeURIComponent` + `new URL().pathname`) before checking the `/api/tunnel/` prefix. Prevents bypass via `%2F`, `%2f`, `%61` encoding, and `..` dot segments. 5 new test cases added covering encoded slash, case-variant encoding, dot segments, and encoded characters.

2. **Config watcher not starting when Tower boots before registration**: `connectTunnel()` now calls `startConfigWatcher()` after creating the tunnel client. This ensures the config directory watcher is established even if it failed at boot time (because `~/.agent-farm/` didn't exist yet). `startConfigWatcher()` is already idempotent (calls `stopConfigWatcher()` first), so redundant calls are safe.

## Review Iteration 3 — Codex Feedback (Fixed)

Codex requested changes on two issues. Both valid and now addressed:

1. **CloudStatus URL routing**: Codex correctly identified that `apiUrl('api/tunnel/status')` would prefix `/project/<encoded>/` when the dashboard is viewed from a project context, causing tunnel API calls to 404. **Fixed**: Changed all three tunnel API calls (`fetchTunnelStatus`, `connectTunnel`, `disconnectTunnel`) to use root-relative paths (`/api/tunnel/status`, etc.) instead of `apiUrl()`, since these are tower-level endpoints, not project-scoped.

2. **Metadata push**: Codex correctly noted that `sendMetadata` only cached metadata without proactively delivering it. While the plan's "outbound H2 POST" is architecturally impossible (tower is the H2 server), the concern about passive-only delivery was valid. **Fixed**: Added dual metadata mechanism — (1) GET `/__tower/metadata` handler for H2 polling (in-tunnel), and (2) outbound HTTPS POST to `${serverUrl}/api/tower/metadata` when metadata changes while connected (best-effort, out-of-band). Plan updated to document this approach.

Gemini and Claude also noted the plan document still referenced TCP/TLS transport from pre-TICK-001. **Fixed**: Updated plan Phase 3 connection flow, metadata protocol, reconnection, and mock server descriptions to reflect WebSocket transport.

## Merge Resolution

The merge from `main` into the builder branch re-introduced cloudflared code that was removed in Phase 2, along with a dead `getBasePortForProject` function (removed by Spec 0098 on main). Both were cleaned up in the review phase.

## Stats

- **Commits**: 39
- **Files changed**: 25
- **Lines added**: 6,845
- **Lines removed**: 443
- **Test files**: 10 (new or modified)
- **Total tunnel-related tests**: 109 (96 passing + 13 conditional E2E skipped when codevos.ai unavailable)
- **Phases**: 7 (all complete)
- **Total iterations across all phases**: ~40
