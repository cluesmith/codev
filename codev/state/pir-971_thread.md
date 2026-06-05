# PIR #971 — web terminal session-unknown fast-path

## Plan phase (in progress)

Issue: web terminal can't fast-path a "session gone" reconnect because browsers
can't read a failed-upgrade HTTP 404 (they only see close 1006). VSCode/Node
already fast-paths via `classifyUpgradeError("Unexpected server response: 404")`.

Investigation findings:
- `classifyUpgradeError` (core, `reconnect-policy.ts:201`) already has a dormant
  object/`code` form (built #961). Object form only matches HTTP range 400–499.
- Tower rejects unknown sessions at upgrade stage at TWO sites:
  `tower-websocket.ts:163-167` (direct `/ws/terminal/:id`) and `:235-239`
  (workspace route). Two OTHER 404s (`:196`, `:248`) are routing errors, not
  session-unknown — left alone.
- VSCode adapter (`terminal-adapter.ts:185`) uses the STRING form via `error`
  event; its `close` handler ignores codes. So to avoid regressing it, Tower must
  keep the HTTP 404 for Node clients.
- Discriminator chosen: presence of `Origin` header. Browsers always send it on
  WS upgrade; the Node `ws` client sends none. Same pattern as CORS check at
  `tower-routes.ts:195`.
- Test harness exists: `tower-websocket.test.ts` mocks `wss.handleUpgrade` and
  emits `server.emit('upgrade', {url, headers}, socket, head)` — easy to assert
  both the 404-write (Node) and the close(4404) (browser) branches.

Design decisions:
- Shared constant `WS_CLOSE_SESSION_UNKNOWN = 4404` exported from core.
- Keep the 400–499 HTTP-range check in the object form (disjoint from WS code
  ranges, so harmless; preserves existing tests).
- Dashboard `onclose(event)` → `classifyUpgradeError({ code: event.code })`;
  permanent → immediate give-up + notice, refresh button remains recovery path.

Plan written to `codev/plans/971-web-terminal-adopt-session-unk.md`. Awaiting
plan-approval gate.

## Plan approved → rebased on main (18 commits), no target files changed, anchors verified.

## Implement phase (done, awaiting dev-approval)

Implemented exactly to plan:
- core `reconnect-policy.ts`: `WS_CLOSE_SESSION_UNKNOWN = 4404` export; added
  `code === 4404 → permanent` branch ahead of the kept 400-499 HTTP-range check;
  updated doc comment for the overloaded code meaning.
- Tower `tower-websocket.ts`: `rejectUnknownSession()` helper (Origin present →
  accept upgrade + `ws.close(4404, 'session-unknown')`; else HTTP 404). Wired both
  session-not-found sites (direct + workspace). Other routing-error 404s untouched.
- Dashboard `Terminal.tsx`: `onclose(event)` consults
  `classifyUpgradeError({ code: event.code })`; permanent → disconnected + notice,
  no retry. Transient 1006 still blind-retries.

Tests: core +2 cases (19 pass). Tower +2 browser-path cases, clarified 2 Node-path
cases (27 pass in file). Full codev suite: 3224 pass / 13 skip / 0 fail.

Note: a first full-suite run showed transient `session-manager.test.ts` failures
("Invalid shellper info JSON" — real-shellper subprocess spawn race under parallel
load). Verified independent: session-manager imports none of my files, passes in
isolation (67/67), and the re-run full suite is fully green. Pre-existing flakiness,
not caused by this change.

Builds: core ✓, codev ✓, dashboard ✓ (tsc + vite).

## dev-approval feedback: rehydration question (resolved, no code change)

Architect asked whether immediate give-up degrades UX vs blind retry, and whether
to fold a server-side rehydration check into the upgrade handler so 4404 only
fires for truly-gone sessions.

Investigation conclusion: a rehydration-before-4404 check would be DEAD CODE.
Both rehydration paths reassign the terminal id:
- startup reconcile: `tower-terminals.ts:646` createSessionRaw (new id) + `:669-672`
  delete old SQLite row, save under new id.
- on-the-fly reconnect: `:832` + `:868-872` deleteTerminalSession(oldId) → new id.
So after a Tower restart a persistent session returns under a NEW id; the OLD id
in the browser's WS URL is permanently dead. `getSession(oldId)` stays null
regardless of rehydration → 4404 is always truthful. Immediate give-up never
loses a recoverable connection. Recovery for the persistent case is a dashboard
state re-fetch (new id) + remount (Terminal effect keyed on wsPath), independent
of this change; 4404 makes it FASTER, not slower.

Decision (architect): ship as-is, no rehydration check. File a follow-up issue
for the genuine gap and tag it in the PR.

### TODO during PR (review) phase — file this issue, then reference it in the PR
Draft:
- Title: "terminal: stale tab on a pre-restart terminal id can't self-recover
  without a manual state re-fetch"
- Body: After a Tower restart, persistent (shellper-backed) sessions return under
  a NEW terminal id (reconnect paths reassign ids: tower-terminals.ts:646/669-672
  and :832/868-872). A browser/VSCode tab still holding the OLD id's WS URL gets
  a permanent close (4404, #971) / 404 and gives up correctly — but it can only
  reconnect once something re-fetches /api/state to learn the successor id and
  remounts the terminal. Today that relies on a user-driven refresh / incidental
  state poll. Follow-up: on a permanent terminal close, have the dashboard
  proactively re-fetch state and auto-remount onto the successor session id
  (and consider the same affordance for the VSCode terminal). Deferred from #971.
- Label: decide at filing — likely `area/dashboard` (dashboard-side fix), or
  `area/cross-cutting` if the VSCode-terminal affordance is folded in (single
  area/* per issue; cross-cutting used alone).
- Tag: reference the new issue number in the #971 PR body.
