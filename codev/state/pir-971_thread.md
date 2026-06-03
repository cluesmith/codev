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
