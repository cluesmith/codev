# Review: Cloud Tower Client (Tunnel & Registration)

## Summary

Replaced cloudflared integration with a built-in HTTP/2 role-reversal tunnel client that connects directly to codevos.ai. The implementation spans 7 phases across 25 files, adding 6,845 lines and removing 443 lines (net +6,402). The tunnel client uses only Node.js built-in modules (`node:http2`, `node:net`, `node:tls`, `node:http`) with zero third-party tunnel dependencies.

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

- **Phase 3 (Tunnel Client)**: Metadata delivery uses META frame + GET polling instead of H2 server-initiated POST. The HTTP/2 `ServerHttp2Session` API cannot initiate requests to the client — it can only respond to incoming requests. The workaround sends metadata as a custom frame type, which the server acknowledges. A GET polling endpoint provides a backup path. Documented in `tunnel-client.ts:177-195`.

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

- **HTTP/2 ServerHttp2Session limitations**: Cannot initiate requests from the server side. Resolved by using custom META frames for metadata delivery with GET polling as backup.
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

- CI pipeline integration for E2E tests (start codevos.ai in CI, run tunnel E2E suite)
- 24-hour stability soak test (deferred per plan — impractical in automated testing)
- `af tower register --reauth` flow (re-authentication without re-registration)
- Production TLS testing against live codevos.ai (local dev uses plain TCP)

## Stats

- **Commits**: 39
- **Files changed**: 25
- **Lines added**: 6,845
- **Lines removed**: 443
- **Test files**: 10 (new or modified)
- **Total tunnel-related tests**: 109 (96 passing + 13 conditional E2E skipped when codevos.ai unavailable)
- **Phases**: 7 (all complete)
- **Total iterations across all phases**: ~40
