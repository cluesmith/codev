# bugfix-1586 — tower: cloud-proxied requests are 401'd

Issue #1586. Second half of the #1421 regression (Tower API auth, 3.3.1).
First half was the OAuth callback (#1570, fixed in 3.3.2); this half is every
request arriving *through* the tunnel.

## INVESTIGATE (2026-09-02)

### Reproduced against the live local Tower (:4100)

| Request | Result |
|---|---|
| `GET /` — Host localhost, no key | 200 (public dashboard shell) |
| `GET /` — `Host: cloud.codevos.ai`, no key | **401** |
| `GET /api/state` — Host localhost, + key | 404 (route absent in this build; auth passed) |
| `GET /api/state` — `Host: cloud.codevos.ai`, + key | **401** |
| `GET /api/projects` — Host localhost, no key | **401** |

Both failure modes from the issue reproduce independently: the Host guard
rejects `cloud.codevos.ai` even *with* a valid key, and keyed routes reject a
request that carries no key even *with* an allowed Host. So both must be fixed;
neither alone unblocks cloud access.

### Root cause (confirmed in code)

`packages/codev/src/agent-farm/lib/tunnel-client.ts`

1. **`proxyHttpRequest` (:809–:830) forwards `Host` verbatim.** The header loop
   copies every non-pseudo, non-hop-by-hop inbound header into the localhost
   `http.request`, including `host: cloud.codevos.ai`. `isAllowedHost()`
   (`utils/server-utils.ts:269`) accepts only loopback hostnames, configured
   `CODEV_TOWER_ALLOWED_ORIGINS` hostnames, and (bridge mode) IP literals — so
   it rejects the cloud authority, and `isRequestAllowed()` (:310) runs that
   guard *before* the public-route allowlist, which is why even `GET /` 401s.

   The comment on `handleWebSocketConnect` (:737–:741) claiming "the HTTP proxy
   path already lets Node default Host to localhost" is false: Node only
   defaults `Host` when no `host` header is supplied, and the cloud edge always
   supplies one.

2. **No local key is stamped.** `stampProxyMarker` (:87) stamps only
   `x-codev-tunnel-proxy`. Tower gives that marker no auth exemption — it is
   used solely for `/api/tunnel/*` refusal and log attribution
   (`servers/tower-tunnel.ts:319`, `describeSource`). So every keyed route 401s
   even once Host is fixed.

Trust model is unchanged (arch.md §Tower API Authentication): the cloud edge
authenticates the remote *user*; the local key authenticates *local actors*.
`TunnelClient` runs inside the Tower process — it is a local actor and
legitimately holds the key.

### Fix shape (as prescribed in the issue)

In `tunnel-client.ts`, extend the existing stamp helper so Host + marker + key
cannot drift:

1. Drop any inbound `host`; set `Host: localhost:<localPort>`.
2. Strip any inbound `codev-tower-key` / legacy `codev-web-key` (anti-forgery,
   same pattern as `stampProxyMarker`), then stamp `getExpectedKey()` from
   `utils/server-utils.ts` (shares Tower's cache, honours `CODEV_TOWER_KEY`).
   No import cycle: server-utils imports only `codev-core/auth` + `codev-types`.
3. Fix the misleading WS-path comment; pin that the browser's
   `Sec-WebSocket-Protocol: codev-key.<KEY>` subprotocol survives the
   H2 CONNECT → localhost upgrade.
4. Leave the `/api/tunnel/*` refusal untouched — the key stamp must not let a
   cloud actor reach management routes.

### Scope

Well inside BUGFIX: one helper + two call sites in one file, plus tests. Tests
go in `__tests__/tunnel-edge-cases.test.ts`, whose echo server already reflects
request headers back (existing marker tests use it), and `helpers/mock-tunnel-server.ts`
already supports per-request headers and `sendConnect`.

<signal>PHASE_COMPLETE</signal>

## FIX (2026-09-02)

`stampProxyMarker` → `stampLocalHeaders(headers, localPort)` in
`lib/tunnel-client.ts`. It now owns four headers outright — strips any inbound
copy of `host`, `codev-tower-key`, `codev-web-key`, `x-codev-tunnel-proxy`,
then stamps `Host: localhost:<port>`, the marker, and `getExpectedKey()`. Fails
closed: no readable key → no key header → Tower rejects, as before.

Both proxy paths call it. The WS path loses its hand-rolled Host handling (the
shared helper does it) and its false comment about Node defaulting Host.

**Only 46 insertions / 13 deletions in one file.** No Tower-side exemption was
added — the key check stays the single choke point, and `/api/tunnel/*` refusal
is untouched (asserted in both root and workspace-scoped forms).

### Regression tests — `__tests__/bugfix-1586-tunnel-auth.test.ts`

Runs the **real `isRequestAllowed`** in the local server rather than an echo
server, so authorization is pinned end-to-end.

| Test | pre-fix | post-fix |
|---|---|---|
| keyed `/api/state` with cloud Host, no key | FAIL 401 | PASS 200 |
| public `/` with cloud Host | FAIL 401 | PASS 200 |
| forged key/legacy-key/marker replaced not forwarded | FAIL 401 | PASS 200 |
| `/api/tunnel/disconnect` + workspace-scoped form still 403 | PASS | PASS |
| browser `codev-key.<KEY>` subprotocol survives H2 CONNECT | PASS | PASS |

3 of 5 fail without the fix. The last two are invariant pins (per issue items
3 and 4), expected green both ways.

Gotcha: an H2 CONNECT stream rejects a `host` header (`NGHTTP2_PROTOCOL_ERROR`)
— authority travels as `:authority` there. Noted in the test.

Worktree had no `node_modules`; `pnpm install --frozen-lockfile` plus building
`codev-types`/`codev-core` was needed before vitest could resolve imports.

## CMAP (2026-09-02) — 3× APPROVE, HIGH confidence

gemini APPROVE · codex APPROVE · claude APPROVE. No blocking issues from any
lane. Claude raised three non-blocking items, all addressed:

- **Per-session remote credential** — filed as #1589 (the follow-up the issue
  itself designates as out of scope, cc @amrmelsayed).
- **Fail-closed branch untested** — added a sixth test: with `ensureLocalKey`
  throwing, the local server sees the request with *no* `codev-tower-key` and a
  localhost Host, and rejects it 401. This pins that the forged inbound key is
  stripped even when we have nothing to stamp in its place — the branch the
  commit message claims but nothing previously exercised.
- **Branch behind main** — merged `origin/main` (porch records only, no code).

CI on PR #1588: all 7 checks green.

## MERGED (2026-09-03)

PR #1588 merged 11:21 UTC by @amrmelsayed (owner-approved lane) as
`3591ad1d3`. Issue #1586 auto-closed by the `Fixes` line; completion stats
posted as a comment.

Amr also pushed `db08a16bc` onto the branch before merging — an arch.md
Decision 8 entry recording the Host + local-key stamping. Merged into the
branch here so nothing was lost.

`porch approve ... pr` failed its first run: it commits state then pushes, and
the push was rejected non-fast-forward because of that unseen commit. The gate
approval *was* already committed locally, so the fix was to merge origin and
push — not to re-run approve. Worth knowing: a partial `porch approve` failure
is a push failure, not a state failure; check `git log` before assuming the
approval didn't take.

Porch commits after the merge are stranded on the branch and need a records PR:
`d6ed709b2` (pr gate-approved), `623fd2577` (PR #1588 merged),
`b760f1205` (protocol complete), plus this thread update.

Field verification through the real cloud edge remains open and is
architect-driven post-release — I cannot exercise cloud.codevos.ai from here.
