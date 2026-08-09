# air-1370 — Cloud Disconnect hardening

Protocol: AIR (strict). Issue #1370.

## Premise correction (found before writing code)

The issue names `apps/web/src/components/CloudStatus.tsx` as "the only production
caller" of `POST /api/tunnel/disconnect`. It isn't a caller at all in practice —
the component has **zero importers** anywhere in the repo (spec 579 documented
that it was written but never wired into `App.tsx`).

The actual callers are:

| Caller | Confirmation before this PR |
|---|---|
| `packages/codev/templates/tower.html` — the live Tower homepage header | a bare `confirm('This will disconnect from Codev Cloud. Continue?')` |
| VS Code command `codev.disconnectTunnel` ("Codev: Disconnect Tunnel") | **none** — palette entry → `signalTunnel('disconnect')` → the POST |
| `afx tower disconnect` CLI | deletes local config first, so it cannot produce the observed log signature |
| `CloudStatus.tsx` (React) | none, but unreachable — no importers |

The VS Code palette command is the strongest accidental-trigger candidate for
the two incidents: a fuzzy palette match plus Enter deregisters the tower with
no prompt, and its success toast ("Tunnel disconnected") understates that the
tower was deregistered and its credentials deleted.

Reported to the architect via `afx send` before implementing; architect verified
independently (`extension.ts:1307`, no confirmation) and confirmed the scope.

## What was already in place

Proposed fix #3 (defense in depth) largely existed: `TunnelClient` blocks
`/api/tunnel/*` on the proxy side (`isBlockedPath`, 403), with tests in
`tunnel-edge-cases.test.ts`. This PR adds the *second* layer on the Tower side
rather than re-doing the first.

## What was built

1. Confirmation at all three UI call sites, each naming the real consequences
   (deregisters server-side, deletes local credentials, re-OAuth to return).
2. Source attribution logging on `POST /api/tunnel/connect|disconnect` —
   remote address, user-agent, origin, and local-vs-tunnel. Control characters
   are stripped so a hostile header cannot forge log lines.
3. Tower-side rejection of tunnel-proxied management requests, keyed off a
   `x-codev-tunnel-proxy` header that `TunnelClient` stamps (stripping any
   inbound copy, so the cloud side can neither forge nor suppress it).
4. The optional flap guard: Disconnect is held disabled for 2s after any tunnel
   state change, in both the React component and `tower.html`, so the click
   target stops swapping under the cursor during an uplink flap.

## Environment note

The worktree had no `node_modules` — `porch check`'s build failed with
`TS2688: Cannot find type definition file for 'node'` in `packages/core`,
unrelated to the change. Fixed by running `pnpm install --frozen-lockfile` in
the worktree. (Briefly symlinked main's `node_modules` to run targeted tests
first; removed those symlinks before installing so nothing could write through
them into the main checkout.)

## Verification

- `packages/codev` build + full suite via `porch check 1370`
- `apps/web` vitest (CloudStatus)
- `apps/vscode` `tsc --noEmit`

## Incident #3 (22:29:15Z) — root cause found

Architect reported a third full deregistration **with the laptop lid closed**,
which exonerates every click-gated caller and kills the misclick theory.
Reprioritized per instruction: attribution logging first, defense-in-depth as
the actual fix, plus a new cloud-edge authentication audit.

### The bypass

`tower-routes.ts:2063` — `handleWorkspaceRoutes` strips the workspace prefix and
dispatches to the *same* `handleTunnelEndpoint`:

```ts
if (subPath.startsWith('api/tunnel/')) {
  const tunnelSub = subPath.slice('api/tunnel/'.length);
  await handleTunnelEndpoint(req, res, tunnelSub);
}
```

`isBlockedPath` only tested `normalized.startsWith('/api/tunnel/')` — root-anchored.
So the workspace-scoped form sails through:

| Path | Tunnel blocklist |
|---|---|
| `/api/tunnel/disconnect` | BLOCKED |
| `/workspace/<base64url>/api/tunnel/disconnect` | **ALLOWED THROUGH TUNNEL** |

A request arriving over the h2-over-websocket tunnel on that path reaches
`handleTunnelEndpoint`, deregisters the tower server-side and deletes the local
credentials. No local user required — consistent with a lid-closed incident.

Fixed by matching an `api/tunnel/` segment at any depth. The Tower-side rejection
added earlier is the more robust layer: it keys off the stamped
`x-codev-tunnel-proxy` header and is enforced inside `handleTunnelEndpoint`,
where both dispatch paths converge, so it holds even if a third route appears.

### Authentication audit (new scope item) — NOT properly gated

- `isRequestAllowed()` (`server-utils.ts:80`) unconditionally returns `true`. Its
  own comment: "security is handled by the server binding to localhost only."
- The tunnel invalidates that premise — `TunnelClient` proxies cloud-originated
  requests *into* `localhost:4100`, so localhost binding no longer implies a
  local actor.
- No `401` exists anywhere in the Tower server. The `codev-web-key` / `authFetch`
  machinery in `tower.html` sends headers Tower never checks.

So all authentication for tunnel-borne requests lives at the codevos.ai edge,
outside this repo. If the public `/t/<tower>/` URL is reachable unauthenticated,
an internet actor reaches every Tower API endpoint — not only the tunnel ones.
That check has to happen cloud-side; I could not verify it from here.

### Open question

Nothing in this repo auto-calls disconnect, so what at the edge issued the POST
during the reconnect storm is still unknown. Recommended the cloud-side access
log for `/workspace/*/api/tunnel/disconnect` around 22:29:15Z.
