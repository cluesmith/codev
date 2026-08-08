# bugfix-1372 — tunnel client wedges after sustained uplink flap

Issue #1372. Protocol: BUGFIX (strict). Branch `builder/bugfix-1372`.

---

## Investigate (2026-08-08)

### Reproduced

`tmp/`-scratch vitest repro: a `net` server that accepts the TCP connection and never
answers the HTTP upgrade — i.e. a post-flap half-open path (stale NAT/conntrack entry,
which is exactly what a 2-minute uplink flap leaves behind).

```
state after 6s:                       connecting
state after explicit connect():       connecting
state after resetCircuitBreaker():    connecting
```

Zero state transitions after the initial `disconnected → connecting`. Matches the observed
22:06:44Z wedge precisely, and reproduces the second half of the report too: **nothing the
tower can do to itself breaks the wedge.**

### Root cause — `connecting` is an unbounded state

`lib/tunnel-client.ts:369 doConnect()` does `new WebSocket(wsUrl)` with **no
`handshakeTimeout`** and arms **no watchdog**. Two sub-phases can hang forever:

1. TCP connect / TLS / HTTP upgrade — Node sets no socket timeout by default, and `ws`
   only enforces a handshake deadline when `handshakeTimeout` is passed. It isn't.
2. After `open`, `onWsOpen()` (line 399) sends the auth frame and waits on `message`. If
   the relay never replies, it waits forever.

Every recovery path is gated on *leaving* `connecting`, so none of them fire:

| Path | Why it can't help |
|---|---|
| `scheduleReconnect()` | only reached from `ws.on('error')` / `ws.on('close')` / pong timeout — a silent hang emits none of those |
| `startHeartbeat()` | armed only after `connected` (line 478), so ping/pong never covers `connecting` |
| `connect()` | early-returns when `state === 'connecting'` (line 193) — an external nudge is a no-op |
| `resetCircuitBreaker()` | only acts when `state === 'auth_failed'` (line 215) |

That is why `POST /api/tunnel/connect` recovered it instantly: `connectTunnel()`
(`tower-tunnel.ts:126`) `disconnect()`s the old client and constructs a **brand-new
`TunnelClient`**. The recovery came from replacing the object, not from
`resetCircuitBreaker()`.

### Contributing defects

2. **`auth_failed` is terminal.** `handleAuthError('invalid_api_key')` → `auth_failed`, and
   `scheduleReconnect()` returns early on that state forever (line 284). One misclassified
   auth error during a blip parks the tunnel permanently. (Issue ask #2.)
3. **No failure reason logged.** `handleConnectionError(_err)` (line 455) discards the
   error; `tower-tunnel.ts:142` logs bare `Tunnel: ${prev} → ${state}`. Hence "diagnosis
   archaeology". (Issue ask #3.)
4. **Backoff off-by-one + timer leak.** `handleConnectionError` and `handleAuthError` call
   `scheduleReconnect()` *before* `this.consecutiveFailures++`, so every delay is computed
   one attempt behind. `scheduleReconnect()` also doesn't clear an existing timer.

### On the ~4ms instant-fail cycles (issue observation 1, ask #4)

Consistent with the kernel refusing `connect()` outright — `ENETUNREACH`/`EHOSTUNREACH`,
no default route during the flap, DNS already cached. The socket errors in a few ms,
`handleConnectionError` fires, backoff schedules a retry. **That path is working as
designed**; the off-by-one just makes it retry a notch faster than intended.

Ask #4 (rebuild the client after K instant failures) is **not needed and I don't plan to
implement it**: `doConnect()` already builds a fresh `WebSocket` every attempt, and
`cleanup()` nulls the h2 server/session/stream. The only state the old client actually
carried across was the stuck `connecting` flag — the watchdog dissolves it. Adding a
rebuild path would be a second, redundant recovery mechanism. Flagging the reasoning here
rather than silently dropping the ask.

### Scope

Four focused changes in `lib/tunnel-client.ts` + a reason string threaded through the
state-change callback into `tower-tunnel.ts`. Well under the 300-LOC ceiling. Proceeding
with BUGFIX.

`<signal>PHASE_COMPLETE</signal>`

---

## Fix (2026-08-08)

Four changes in `lib/tunnel-client.ts`, one log line in `servers/tower-tunnel.ts`. ~115 LOC
of source, well inside the BUGFIX ceiling.

1. **`CONNECT_TIMEOUT_MS = 20_000` watchdog** armed in `doConnect()`, disarmed by `setState`
   on any transition out of `connecting` and by `cleanup()`. On fire: warn, tear down,
   `consecutiveFailures++`, `disconnected`, `scheduleReconnect()`. Covers both silent-hang
   phases (handshake and auth-response wait) with one timer.
2. **`AUTH_RETRY_INTERVAL_MS = 15 * 60_000` half-open** via `scheduleAuthRetry()`.
   `auth_failed` now leaves the state and retries once per interval; a genuinely revoked key
   fails again and re-parks, so the cycle is self-limiting.
3. **Reasons on every transition.** `setState(state, reason?)` → third callback arg →
   `Tunnel: connecting → disconnected (connect timeout after 20000ms)`. Close frames now
   carry their code and reason text; `handleConnectionError` no longer discards the error.
4. **Backoff ordering + timer hygiene.** `consecutiveFailures++` moved before every
   `scheduleReconnect()` call; `scheduleReconnect()` and the rate-limit path now
   `clearReconnectTimer()` first.

### Verification

Five regression tests in `__tests__/tunnel-client.test.ts` (`#1372 self-healing`). Verified
by mutation — each fix reverted individually, tests re-run:

| Mutation | Tests that fail |
|---|---|
| A: watchdog body `return`s early | watchdog test |
| B: `scheduleAuthRetry()` call removed | auth half-open test |
| C: `reason` dropped from listener call | watchdog + reason tests |
| D: `consecutiveFailures++` moved back after `scheduleReconnect()` | ordering test |

All four detected; all 5 pass with the fix restored. Build green.

The connect-watchdog test uses a real `net` blackhole server (accept, never answer the
upgrade) under `vi.useFakeTimers({ shouldAdvanceTime: true })`. The auth half-open test is
driven through the private handler with plain fake timers — mixing a 15-minute fake clock
with real socket I/O was flaky, and the heartbeat tests already established that idiom.

### CMAP round 1 (PR #1373)

| Lane | Verdict |
|---|---|
| gemini | APPROVE — no issues |
| claude | APPROVE — three minor, non-blocking |
| codex | **REQUEST_CHANGES** — one real defect |

**codex was right, and it's a defect my own watchdog introduced.** `onWsOpen`'s `onMessage`
had no `ws === this.ws` guard, unlike the `error`/`close` handlers. Before this PR nothing
tore an attempt down mid-flight, so the hole was latent; the watchdog makes it reachable —
an `auth_ok` queued before `cleanup()` could call `startH2Server()`, clobber the h2 handles
and flip state back to `connected` on a dead socket while a reconnect was already pending.
Exactly the "wedged internal state" the issue speculated about, and I'd have shipped it.

Fixed with stale guards in `onWsOpen`, `onMessage`, `startH2Server`, and the h2 `session`
callback (which destroys the late session). Regression test added; mutation-verified — with
the guard removed the test fails.

From claude, applied:
- `new WebSocket()` wrapped in try/catch. A synchronous throw would have left `connecting`
  unbounded with no watchdog armed — the same wedge class this PR exists to close.
- `sanitizeCloseReason()` strips control characters and caps length. The close-frame reason
  is remote-supplied and was being logged verbatim (log-forging vector).

### Correction to my own framing (claude's third point, verified)

I implied the auth breaker addresses the observed incident. It does not. `auth_failed` is
reachable **only** from an explicit `{type:'auth_error', reason:'invalid_api_key'}` JSON
frame. A Cloudflare 5xx/HTML body fails `JSON.parse` and routes to `handleConnectionError`
(transient, retries); a failed upgrade never opens the socket at all. So the issue's
hypothesis — "a proxy error page misclassified as an auth error" — cannot happen on this
code path. The half-open breaker is **defensive hardening, not the corrective fix**; the
watchdog is what resolves the reported wedge. PR body corrected to say so.

### Deliberately not done

Issue ask #4 (rebuild the client object after K instant failures). `doConnect()` already
builds a fresh `WebSocket` per attempt and `cleanup()` nulls the h2 server/session/stream —
the only cross-attempt state was the stuck `connecting` flag, which the watchdog dissolves.
A rebuild path would be a redundant second recovery mechanism. Reasoning recorded above
under Investigate; flagging rather than silently dropping.
