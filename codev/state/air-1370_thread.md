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
