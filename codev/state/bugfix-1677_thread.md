# Builder thread — bugfix-1677

Issue #1677: tower tunnel — small RPCs starve behind large transfers on the shared H2
session (Node default 64 KB windows). Field trace: 39 s explorer `resolve` through the relay.

## INVESTIGATE (2026-09-12)

### Root cause (confirmed, not assumed)
The tower runs an HTTP/2 *server* over the tunnel WebSocket in
`packages/codev/src/agent-farm/lib/tunnel-client.ts`. The relay (cloud.codevos.ai on Railway)
is the H2 *client*. Both browser WebSockets are multiplexed as two H2 streams over ONE
relay↔tower H2 session. Three tower-side defaults cause head-of-line blocking:

1. `http2.createServer({ settings: { enableConnectProtocol: true } })` (line 704–706) — no
   `initialWindowSize`, so the tower advertises a **65535 B (64 KB)** per-stream receive window.
2. The `'session'` handler (line 709–718) never calls `session.setLocalWindowSize(...)`, so the
   **connection-level** receive window stays at Node's 64 KB default. → a large upload on one
   stream (the 1.3 MB extension registry) exhausts the shared 64 KB session window, so a tiny
   RPC *request* (~100 B) on the other stream can't even reach the tower for many RTTs.
3. `new WebSocket(...)` (line 536) uses ws's default `perMessageDeflate: true` (confirmed at
   ws@8.20.0 `lib/websocket.js:665`) → CPU-bound inflate/deflate of large DATA frames on the
   same event loop delays small outbound frames.

### Empirical confirmation (scratchpad, throwaway)
- Node H2 defaults: peer `initialWindowSize=65535`, client connection window
  `remoteWindowSize=65535` — exactly the reporter's "64 KB defaults".
- With `settings.initialWindowSize=1MB` + `session.setLocalWindowSize(...)`: peer advertises
  1 MB, connection window rises to the set value. **Both are observable from the H2 client
  (relay/mock) side** → a deterministic, non-flaky regression guard is possible.

### Scope decision: fits BUGFIX
Fix is one file (`tunnel-client.ts`) + one new test file, well under 300 LOC, no architecture
change. Signalling PHASE_COMPLETE.

### Fix plan (implement phase)
- Add `settings.initialWindowSize = <≥1 MB const>` to the tower's `http2.createServer`.
- In the `'session'` handler call `session.setLocalWindowSize(<≥1 MB const>)`.
- Pass `perMessageDeflate: false` to `new WebSocket(...)`.
- Named constants for the window sizes; keep default `maxSessionMemory` (10 MB) — 1 MB windows
  fit comfortably.
- Regression test via `MockTunnelServer`: assert `remoteSettings.initialWindowSize` and
  `state.remoteWindowSize` ≥ constant (fails at 65535 without fix). May add a small accessor on
  the mock to expose the H2 session.

### Boundary / hand-off note
- The relay end (`http2.connect` on Railway) is a **separate deployment, not in this repo** —
  only the mock uses `http2.connect` here. The tower-side fix removes the **inbound** session-
  window HOL (relay→tower: the 1.3 MB upload that delayed the RPC request). The **outbound**
  reply trickle (tower→relay) is governed by the *relay's* receive window and needs a matching
  change there. Will flag to architect for #1668 / codev-ide#36 sequencing.
- Do NOT touch #1588 header stamping or #1644 write-edge chunking (adjacent, load-bearing).

## FIX (2026-09-12)

Implemented in `packages/codev/src/agent-farm/lib/tunnel-client.ts` (one source file):
- `settings.initialWindowSize = TUNNEL_H2_STREAM_WINDOW_SIZE` (1 MiB) on `http2.createServer`.
- `session.setLocalWindowSize(TUNNEL_H2_SESSION_WINDOW_SIZE)` (4 MiB) in the `'session'` handler.
- `perMessageDeflate: false` on the tunnel `new WebSocket(...)`.
- Two exported window constants with a rationale comment (kept < Node's 10 MB
  `maxSessionMemory`, so no buffer-budget change).

Regression test: `__tests__/bugfix-1677-tunnel-h2-window.test.ts` (3 cases) reads the
advertised windows back from the mock relay (H2 client) — `remoteSettings.initialWindowSize`
and `state.remoteWindowSize` — and asserts per-message deflate is not negotiated when the relay
offers it. Added `perMessageDeflate` option + `getLatestH2Session()` /
`getLatestNegotiatedExtensions()` accessors to `helpers/mock-tunnel-server.ts`.

Verified fails-without / passes-with: reverting the three behavioral changes (constants kept)
makes all 3 cases fail (window assertions + deflate negotiated); restored → all pass.
- `npx tsc --noEmit`: clean.
- Existing tunnel suites: tunnel-client / tunnel-edge-cases / bugfix-1586 / tunnel-integration /
  tower-tunnel all green (202 tests).
- `porch check`: build ✓ (10s), tests ✓ (38s), ALL CHECKS PASSED.

Note: this is `packages/codev` product source, NOT a `codev/`/`codev-skeleton/` template, so the
skeleton-mirroring rule does not apply.

## CREATE PR (2026-09-12)

PR #1678 opened: https://github.com/cluesmith/codev/pull/1678 (`Fixes #1677`).

3-way CMAP on the PR (`--type pr`), all **APPROVE / HIGH**:
- gemini: APPROVE — no issues.
- codex: APPROVE — no issues.
- claude: APPROVE — 5 minor/non-blocking caveats. Acted on three cheaply (commit c1dbf4733):
  settle guard on the per-stream window test, reframed the perMessageDeflate comment as
  defence-in-depth (the relay is the ws *server*, default off — so likely a prod no-op but
  correct as defence), removed a redundant static assertion. Skipped: the unreachable
  `setLocalWindowSize` destroyed-session guard (already covered by the `ws !== this.ws` early
  return; adding it would be dead code).

**Open decision for the architect (claude's caveat #1):** the PR says `Fixes #1677`, which
auto-closes on merge — but this fixes only the tower *inbound* half; the relay *outbound* half +
the issue's end-to-end field acceptance signal are out of this repo. Per the architect's lane
note this is "the ruling on #1677" with cloud-leg verification tracked in #1668 / codev-ide#36,
so I kept `Fixes`. Architect can switch to `Refs #1677` at the gate if they'd rather keep it
open pending the relay change. Flagged in the handoff notification.

Handoff: sent architect the PR link + 3 verdicts, then `porch done` to fire the `pr` gate.
Waiting for `porch approve bugfix-1677 pr` (human) — a CMAP APPROVE is not merge authorization.

**Gate decision (architect main, 2026-09-12):** switch PR body `Fixes #1677` → `Refs #1677`.
Rationale: only the inbound half is in-repo; the relay outbound half + the issue's end-to-end
field re-test remain, so closure follows field verification (verify-before-close discipline).
Amended PR #1678 body accordingly (now `Refs #1677`, zero auto-close keywords). Still HOLDING at
the pr gate — Amr's approval comes next; do NOT merge until then.
