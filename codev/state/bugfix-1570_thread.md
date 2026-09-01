# bugfix-1570 — Tower cloud OAuth callback 401'd by the local-key check

Issue #1570. Regression from PR #1421 (advisory GHSA-xvjp-7748-v88v, shipped 3.3.1).

## Investigate (2026-08-31)

**Reproduced** in a temporary vitest against the real auth helpers (worktree needed
`pnpm install` + `pnpm --filter "@cluesmith/codev^..." build` first — deps are not
symlinked into `.builders/`):

```
isPublicRoute('GET', '/api/tunnel/connect/callback')                  -> false
isRequestAllowed(GET /api/tunnel/connect/callback?nonce=x&token=y)    -> false
```

That is exactly the 401 the issue reports: `handleRequest` (tower-routes.ts:256)
rejects before `handleTunnelEndpoint` (tower-routes.ts:281-283) ever dispatches.

**Root cause** — `isPublicRoute()` in
`packages/codev/src/agent-farm/utils/server-utils.ts` allowlists only `/health`,
`/api/version`, the dashboard shell, `/workspace/<enc>/` static assets and the
annotator shell/vendor files. The cloud OAuth callback is a top-level *browser
navigation* (cross-site redirect from cloud.codevos.ai), so it structurally cannot
carry the `codev-tower-key` header — same structural reason the annotator shell has
its carve-out.

**Why the carve-out is safe** — the route is already self-authenticating. The handler
(`tower-tunnel.ts:373`) requires `token` + `nonce`, and `consumePendingRegistration`
(`lib/nonce-store.ts`) is single-use with a 5-minute TTL; the nonce can only be minted
by an *authenticated* `POST /api/tunnel/connect`. Without a valid nonce the handler
returns 400 "Invalid or expired registration link" and no registration happens.

**Exact-match is sufficient**: the callback URL is built as
`${origin}/api/tunnel/connect/callback?nonce=…` (tower-tunnel.ts:490) where `origin`
is a URL origin (default `http://localhost:<port>`), so the pathname is always
exactly `/api/tunnel/connect/callback`. No prefix carve-out needed or wanted.

**Scope**: one allowlist branch + comment, three test cases, two doc updates. Well
under the BUGFIX ceiling.

## Fix (2026-08-31)

One branch in `isPublicRoute()`:

```ts
if (pathname === '/api/tunnel/connect/callback') return true;
```

with a comment giving the *why* (header-less cross-site navigation; the nonce is the
credential; never widen to an `/api/tunnel/` prefix), plus a rewritten allowlist doc
comment framing the whole list as "paths a browser navigation reaches."

Tests:
- `request-auth.test.ts` — `isPublicRoute` allows the exact callback path and rejects
  `POST /api/tunnel/connect`, `GET /api/tunnel/connect`, `GET/POST` on status and
  disconnect, `/api/tunnel/connect/callback/extra`, `/api/tunnel/`, and `POST` on the
  callback path itself; `isRequestAllowed` end-to-end keyless equivalents.
- `tower-tunnel.test.ts` — an unknown nonce still 400s and calls neither `redeemToken`
  nor `writeCloudConfig`, proving the now-public route is nonce-gated.

**Fails-without / passes-with verified**: with `server-utils.ts` reverted to HEAD, the two
new auth tests fail (`expected false to be true`); with the fix they pass.

Docs: `arch.md` §8 key-model bullet + the invariant at line 110 now list the OAuth
callback among the header-less browser-navigation entry points, and add the review
lesson (enumerate header-less entry points, not just the API surface).

### Worktree note (not a code problem)

A first full-suite run showed 67 failures across 12 files (adopt, update,
hot/cold-tier materialization, protocol-drift-audit, session-manager, …). All were
`Error: Skeleton directory not found` — a fresh worktree has no
`packages/codev/skeleton/`, which `pnpm build`'s `copy-skeleton` step creates. Verified
pre-existing by reverting `arch.md` and re-running (same failures). After
`pnpm --filter @cluesmith/codev build`: **0 failures, full suite green.**
