# PIR Review: Tower `/ide/` prefix forward + `afx ide` lifecycle

Fixes #1668

## Summary

Tower can now forward a fixed `/ide/` prefix — HTTP and WebSocket — to a single local VS Code server-web process through the same tunnel that serves the dashboard, so a browser IDE runs behind Tower and the cloud proxy without taking the dashboard offline. A new `afx ide start|stop|status` lifecycle has Tower spawn/manage that server (workspace chosen per browser connection via `?folder=`), with runtime state in a `~/.agent-farm/ide-server.json` record — no config file, no database change. The forward is key-authenticated through Tower's existing choke point (a swappable seam for #1589) and injects the server's connection token so the workbench boots end-to-end through the relay.

## Files Changed

(vs merge-base; excludes commits the base branch absorbed after branching)

- `packages/codev/src/agent-farm/servers/ide-forward.ts` (+292 / -0) — new: prefix match, header hygiene, `x-forwarded-*` stamping, connection-token cookie injection, HTTP proxy, WS raw-pipe
- `packages/codev/src/agent-farm/servers/ide-server.ts` (+265 / -0) — new: spawn/stop/status/reconcile/respawn + local-only `/api/ide` endpoint
- `packages/codev/src/agent-farm/lib/ide-record.ts` (+142 / -0) — new: `~/.agent-farm/ide-server.json` record + connection token
- `packages/codev/src/agent-farm/commands/ide.ts` (+155 / -0) — new: `afx ide start|stop|status`
- `packages/codev/src/agent-farm/utils/server-utils.ts` (+37 / -0) — new `isForwardAuthorized` seam (no change to existing functions)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+16 / -0) — `/api/ide` + `/ide/*` dispatch, post-auth
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` (+20 / -0) — IDE WS branch before the generic gate
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+7 / -0) — boot reconcile wiring
- `packages/codev/src/agent-farm/lib/tunnel-client.ts` (+12 / -4) — block `/api/ide` from the tunnel
- `packages/codev/src/agent-farm/__tests__/ide-forward.test.ts`, `ide-forward-auth.test.ts`, `ide-record.test.ts`, `ide-forward-integration.test.ts` — new tests
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — cold-tier governance updates

## Commits

- `5501bd762` [PIR #1668] IDE server record, lifecycle, forward, and auth seam
- `2d22e1833` [PIR #1668] Wire /ide/ forward into Tower routing, WS upgrade, boot reconcile, tunnel block
- `0ad36f50b` [PIR #1668] afx ide start|stop|status
- `aa4c0dc0d` [PIR #1668] Tests: forward header hygiene, auth seam, record, HTTP+WS integration
- `08ed262cf` Merge remote-tracking branch 'origin/main' (brings in #1677 H2-window fix)
- `6bf0bbe73` [PIR #1668] Inject IDE connection-token cookie on the forward (fix cloud 403)
- `f121787ce` [PIR #1668] Tests: connection-token cookie injection + merge-not-clobber (HTTP+WS)
- (plus builder-thread commits)

## Test Results

- `pnpm --filter @cluesmith/codev build` (deps + tsc + assets): ✓ pass
- `vitest`: ✓ pass — 32 new IDE tests; no regressions across every touched suite (`tower-routes`, `tower-websocket`, `tunnel-client`, `tunnel-edge-cases`, `bugfix-1586-tunnel-auth`, `tower-tunnel`, `server-utils`, and the merged `bugfix-1677-tunnel-h2-window`). The `dev-approval` gate's `build` + `tests` checks both ran green.

### Verification (full evidence chain)

**Cloud 403 — root cause & fix.** codev-ide's first cloud run through `/t/<tower>/ide/` returned **403**: Tower spawns the server with `--connection-token-file` but the forward didn't present that token, and the token can't ride the browser's cookie jar through the relay (the server's `Set-Cookie` is `Path=/ide`, which never matches `/t/<tower>/ide/`). Fix: the forward injects `vscode-tkn=<token>` (from `~/.agent-farm/ide-connection-token`) into the `Cookie` header on both HTTP and WS upgrades, merging and never clobbering. The token boundary is kept, not disabled — dropping it would leave an unauthenticated any-folder IDE on direct `127.0.0.1:<port>`, bypassing Tower's key.

**Behavior matrix** (how each row is verified is stated per-row — not all are exercised through the full `handleRequest` stack; runnable locally via the stub recipe):

| Request | Result | Verified by |
| --- | --- | --- |
| `GET /ide/` (no key) | 401 (unauth SHOULD fail) | `isRequestAllowed` (existing tests) + `isPublicRoute('/ide/') === false` (unit) — `/ide/` rides the key choke point, no public carve-out |
| `GET /ide/` (key, no server) | 502 | integration test (no record → 502; dead recorded port → 502 on connect-refused) |
| `GET /ide/?folder=…` (key + server) | 200; `?folder` verbatim; `Cache-Control`/`ETag` preserved; `vscode-tkn` injected; Tower key / tunnel marker / `x-forwarded-port` stripped; Host → loopback | integration test (stub loopback, through `forwardIdeHttp`) |
| `WS /ide/?reconnectionToken=…` (key) | raw bidirectional pipe; `vscode-tkn` injected on the upstream upgrade | integration test (through `forwardIdeWebSocket`) |
| `GET /api/ide` (key) | lifecycle status JSON; blocked from the tunnel (local-only) | `isBlockedPath` unit tests (`/api/ide` blocked, `/ide/` not) |

> Note on scope of the integration harness: the stub-loopback tests drive `forwardIdeHttp` / `forwardIdeWebSocket` directly, so they assert the forward's own behavior (header hygiene, cookie, `?folder`, `Cache-Control`/`ETag`, WS pipe, 502). The **401** is a property of `isRequestAllowed` upstream of the forward, asserted via `isPublicRoute` rather than through a full `handleRequest` harness; the end-to-end 401 and the real-relay cache behavior were both confirmed on the cloud run.

**codev-ide local pass (fork side).** Keyed `GET :4100/ide/` + `Cookie: vscode-tkn` → 200; Playwright boot with key+cookie through the forward = full workbench ~5s, explorer populated (25 rows); local (non-tunnel) `remoteAuthority` resolution confirmed fine. codev-ide accepts #1668.

**Cloud pass (real relay, at 5ab46875a).** Amr reloaded `https://<relay>/t/<tower>/ide/` on the production relay: workbench boots; management socket **630 ms**, extension host **939 ms**; explorer populated; owner: "looking good". Remaining console anomalies were all fork-side / CDN — none in the forward. Cloud-leg latency is judged with **#1677** (H2 window starvation on the shared tunnel session) accounted for; #1677 is merged into this branch, and the forward itself is loopback-only and unaffected by that starvation.

## Review-round corrections (CMAP iteration 1)

The 3-way consultation returned APPROVE (Gemini) + two REQUEST_CHANGES (Codex, Claude), all accepted as correct and addressed on the branch:

- **Per-request `lsof` removed from the forward hot path (the leading fix).** `forwardIdeHttp` / `forwardIdeWebSocket` previously called `ensureIdeServerLive()` → `getProcessesOnPort()` (`execSync('lsof …')`, ~98 ms, synchronous) on **every** request, blocking Tower's whole event loop during a workbench boot. **Correcting my own earlier claim to the reviewer that non-IDE users were unaffected: they were** — an IDE boot would stall the dashboard, PTY streaming, and tunnel. The forward now resolves the port from the record (no scan) and lets the upstream connect error be the liveness signal: on `ECONNREFUSED`/`ECONNRESET` it fires an off-hot-path respawn and 502s. `lsof` is now cold-path only (status / reconcile / start-collision).
- **`stopIdeServer` restored the plan's SIGTERM → poll → SIGKILL escalation** and now deletes the record only after confirming exit (was: SIGTERM + immediate delete, which could leave a survivor to be re-adopted).
- **Start-on-a-different-port no longer orphans the old server** — `spawnIdeServer` stops a live server recorded on a different port before starting.
- **`0600` enforced on existing record/token files** via `chmodSync` (the `cloud-config.ts` pattern; `writeFileSync({mode})` only applies on creation).
- **Tests added**: `isBlockedPath` for `/api/ide` (blocked) vs `/ide/` (not) + the `/api/ideas` lookalike; `isPublicRoute` for `/ide/` and `/api/ide` (routed-auth 401); connect-refused → 502.
- **Open-IDE link builder**: deferred (the plan permitted it); recorded here as deferred so it isn't mistaken for shipped.

## Architecture Updates

**COLD** — added an "IDE prefix forward (Issue #1668)" subsection under `## Integration Points` in `codev/resources/arch.md`: the single-server + `?folder=` model, the HTTP vs raw-WS split, the post-auth `isForwardAuthorized` seam (#1589 swap point, no per-folder authz), the two auth boundaries (Tower key for the forward, connection token for direct-to-backend) and cookie injection, header hygiene, the local-only `/api/ide`, and the `~/.agent-farm/ide-server.json` record (no config file, no DB change).

Not routed **HOT**: this is a self-contained new capability, not a fact a contributor must consult before unrelated cross-cutting work, so it does not warrant an always-injected entry (and the hot file is capped). The one always-on invariant it touches — "every non-public route rides the key choke point" — already exists in `arch-critical.md`; `/ide/` conforms to it rather than changing it.

## Lessons Learned Updates

**COLD** — added to `codev/resources/lessons-learned.md`:
- *Security*: two independent auth boundaries can guard the same backend by different paths — don't collapse one to fix a symptom (the `--without-connection-token` trap); and a backend cookie scoped to its own base path won't survive a relay that remounts it (inject at the proxy, merging not clobbering).
- *Architecture*: reverse-proxying a WebSocket upgrade must re-add the hop-by-hop `Connection`/`Upgrade` that header hygiene strips, and forward the client's `Sec-WebSocket-Key` — caught only by a stub-loopback integration test through the real forward code, which the build and pure unit tests missed.

Not routed **HOT**: the strongest cross-cutting lesson here ("verify the real user path end-to-end") already exists in `lessons-critical.md`; these are spec-narrow proxy/auth recipes. This PR is itself a case study for that hot lesson — two defects (the WS hop-by-hop strip, the connection-token 403) were invisible to build+unit tests and surfaced only through integration and cloud runs.

## Things to Look At During PR Review

- **`ide-forward.ts` WS path**: the `Connection`/`Upgrade` re-add and `Sec-WebSocket-Key` forwarding, plus the 101-response reconstruction in `rebuildUpgradeResponse`.
- **Auth seam ordering**: in `tower-websocket.ts`, the IDE branch is checked *before* the generic `isWebSocketAllowed` (which requires a subprotocol key the workbench never offers). Confirm no non-IDE WS route can match `matchIdePrefix`.
- **Cookie merge** (`mergeConnectionTokenCookie`): never-clobber semantics and array-valued `Cookie` handling.
- **Tunnel blocklist regex** change in `tunnel-client.ts`: `/api/ide` blocked, `/ide/` forward deliberately not.
- **`ensureIdeServerLive`** respawn guard (single in-flight respawn) and the boot reconcile being fire-and-forget/post-readiness.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1668` → **Review Diff**
- **What to verify** (maps to the plan's Test Plan):
  - Run `vitest src/agent-farm/__tests__/ide-` — the forward/auth/record/integration suites (stub loopback; no external systems).
  - With this branch installed as Tower (`pnpm -w run local-install` from the worktree) + any local server on `:8200`: `afx ide start --server-path /bin/true` (adopts the port) → `afx ide status`; keyed vs unkeyed `curl http://localhost:4100/ide/` (200 vs 401); `curl -H "codev-tower-key: $(cat ~/.agent-farm/local-key)" http://localhost:4100/api/ide`.
  - Full browser workbench boot is the cloud `/t/<tower>/ide/` leg (verified above), because `/ide/` is key-authed and a local browser can't attach the key.

## Notes / Dependency

- The full in-browser boot through Tower is authenticated by the tunnel stamping the key (#1588); local browsers can't, by design (§D2). Cloud-leg latency is to be read with #1677 accounted for.
- Out of scope (separate future lane): install-on-demand (`afx ide install`) and its artifact-base-url knob.
