# PIR Plan: Web terminal session-unknown fast-path (browser-visible Tower close code)

## Understanding

The VSCode (Node `ws`) terminal already fast-paths a "this session no longer exists" reconnect: Tower rejects an unknown session at the **HTTP-upgrade stage** (`tower-websocket.ts` → `socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy()`), Node's `ws` client surfaces that as an `Error` with message `"Unexpected server response: 404"`, and `classifyUpgradeError(err.message)` (core, #961) returns `permanent` → the adapter gives up immediately instead of burning its 6-attempt backoff budget (`terminal-adapter.ts:185`).

The **web terminal cannot do this today.** A browser `WebSocket` whose *upgrade* fails only gets `onerror` + `onclose` with code `1006` and **no access to the HTTP status** — browsers deliberately hide failed-upgrade response details from JS. So `Terminal.tsx`'s `onclose` (`Terminal.tsx:525-546`) treats every close identically and blind-retries through the full 6-attempt budget before showing `disconnected`.

The fix has three coordinated parts (all called out in the issue):

1. **Tower** must give a browser something it *can* read: accept the WS upgrade and immediately close with an **app-range close code** (`4404`) for the session-unknown case — while keeping the HTTP-stage `404` for Node clients so the VSCode fast-path (#936) does not regress.
2. **Classifier** (`classifyUpgradeError`) must recognize the WS close code `4404`. Its object form currently only matches the *HTTP* range `400 ≤ code < 500`, which a *WebSocket* close code like `4404` never falls into.
3. **Dashboard** (`Terminal.tsx`) must consult `classifyUpgradeError({ code: event.code })` in `onclose` and give up immediately on a `permanent` verdict.

The pure-logic seam (`classifyUpgradeError` object/`code` form) already exists in core (#961 built it but deliberately left it dormant); this issue makes it live end-to-end.

## Proposed Change

### Part 1 — Tower: browser-visible close code for session-unknown (`tower-websocket.ts`)

The two session-not-found sites (direct route `:163-167`, workspace route `:235-239`) currently do `socket.write('HTTP/1.1 404 …'); socket.destroy()`. Replace each with a call to a small helper that **discriminates browser vs Node client**:

```ts
import { WS_CLOSE_SESSION_UNKNOWN } from '@cluesmith/codev-core/reconnect-policy';

/**
 * Reject an upgrade to an unknown terminal session.
 * - Browser clients (Origin header present) can't read a failed-upgrade HTTP
 *   status — they only see close 1006. Accept the upgrade and immediately close
 *   with an app-range code (4404) the dashboard reads via CloseEvent.code (#971).
 * - Node `ws` clients (no Origin) keep the HTTP-stage 404: the VSCode terminal
 *   relies on the "Unexpected server response: 404" upgrade error (#936).
 */
function rejectUnknownSession(req, socket, head, wss) {
  if (req.headers.origin) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(WS_CLOSE_SESSION_UNKNOWN, 'session-unknown');
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
}
```

**Discriminator = presence of the `Origin` header.** Browsers always send `Origin` on a WS upgrade; the Node `ws` client in `terminal-adapter.ts` constructs `new WebSocket(url)` with no headers, so it never sends one. This mirrors the existing `req.headers.origin` inspection already used for CORS in `tower-routes.ts:195`. If a browser somehow arrives without `Origin`, it degrades gracefully to today's blind-retry (no worse than current behavior).

Scope note: only the **two session-not-found** rejections become `4404`. The genuine routing-error rejections (non-`/workspace/` path `:196`, unhandled WS route `:248`, missing/invalid encoded path `400`s) stay as HTTP rejections — they are programmer/routing errors, not the stale-session case.

### Part 2 — Classifier: recognize the WS close code (`reconnect-policy.ts`)

- Export a named constant: `export const WS_CLOSE_SESSION_UNKNOWN = 4404;` (single source of truth shared by Tower and the dashboard).
- In `classifyUpgradeError`'s object form, add a branch: `if (reason.code === WS_CLOSE_SESSION_UNKNOWN) return 'permanent';`.
- **Keep** the existing `400 ≤ code < 500` HTTP-range check. WS close codes are never in `400–499` (valid WS codes are `1000–1015`, `3000–3999`, `4000–4999`), so keeping it cannot misclassify a browser `CloseEvent.code`, and it preserves the documented/tested object-`code` contract for any future Node code-form caller. Update the doc comment to spell out the dual meaning (HTTP status *or* WS close code).

### Part 3 — Dashboard: wire `onclose` to the classifier (`Terminal.tsx`)

Change `ws.onclose = () => { … }` (`:525`) to `ws.onclose = (event) => { … }` and, before the existing `backoff.recordFailure()` blind-retry logic, add:

```ts
if (classifyUpgradeError({ code: event.code }) === 'permanent') {
  setConnStatus('disconnected');
  term.write('\r\n\x1b[31m[Codev: This terminal session no longer exists. Press the refresh button to reconnect.]\x1b[0m\r\n');
  return;
}
```

This gives up immediately (no `recordFailure`, no `setTimeout` retry) on a `4404` close, while leaving the transient `1006`/normal-drop path untouched (still blind-retries with the 6-attempt budget). The existing refresh affordance (`reconnectRef`, `:668`) still works as the manual recovery path — matching the VSCode #939/#961 affordance. Import `classifyUpgradeError` alongside the existing `BackoffController` import (`:15`).

## Files to Change

- `packages/core/src/reconnect-policy.ts` — add `WS_CLOSE_SESSION_UNKNOWN = 4404` export; add the `code === 4404` branch in `classifyUpgradeError`; update the doc comment.
- `packages/core/src/__tests__/reconnect-policy.test.ts` — add cases: `{ code: 4404 }` → permanent; non-4404 WS codes (`4500`, `1000`, `1001`) → transient; existing 404/1006 cases unchanged.
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` — add `rejectUnknownSession` helper; call it at the two session-not-found sites (`:163-167`, `:235-239`); import `WS_CLOSE_SESSION_UNKNOWN` from core.
- `packages/codev/src/agent-farm/__tests__/tower-websocket.test.ts` — extend the unknown-session tests: `headers: {}` (Node) still writes `HTTP/1.1 404`; `headers: { origin: '…' }` (browser) calls `wss.handleUpgrade` and the callback closes with `(4404, 'session-unknown')`. Cover both direct and workspace routes.
- `packages/dashboard/src/components/Terminal.tsx` — import `classifyUpgradeError`; change `onclose` to read `event.code` and fast-path on `permanent`.

## Risks & Alternatives Considered

- **Risk: VSCode/Node fast-path regression.** Mitigated by the `Origin` discriminator — Node clients keep getting the HTTP `404` upgrade rejection, so the `"Unexpected server response: 404"` error path (#936) is byte-for-byte unchanged. Verified by the Node-side test (`headers: {}` → `socket.write` 404).
- **Risk: `Origin` is an imperfect discriminator.** A future Node client that sets `Origin` would get `4404` instead of the 404 error; its `close` handler (which ignores codes) would then blind-retry-then-give-up (slower, not broken). Acceptable: the only Node client today (`terminal-adapter.ts`) sends no `Origin`. Documented as a known limitation.
- **Alternative: switch Tower to `4404` for *all* clients and update the VSCode adapter to read the close code.** Rejected — broader blast radius, and it would regress an already-deployed VSCode extension under version skew (old extension relies on the 404 error, which would stop firing). The issue explicitly requires preserving the Node 404 path.
- **Alternative: drop the `400–499` HTTP-range check from the object form.** Rejected — keeping it is harmless (disjoint from WS code ranges) and preserves the existing object-`code` contract/tests. No reason to remove.
- **Non-goal:** emitting `4404` when a session is destroyed *while a browser is attached* (mid-stream kill). The reconnect attempt that follows already hits the session-not-found path and gets `4404`, matching the VSCode sequence (one transient retry, then fast give-up). Not expanding scope here.

## Test Plan

**Unit — core** (`pnpm --filter @cluesmith/codev-core test`):
- `classifyUpgradeError({ code: 4404 })` → `permanent`.
- `classifyUpgradeError({ code: 4500 })`, `{ code: 1000 }`, `{ code: 1001 }`, `{ code: 1006 }` → `transient`.
- Existing string-form / `{ code: 404 }` / `{ code: 500 }` cases stay green.

**Unit — Tower** (`pnpm --filter @cluesmith/codev test`):
- Unknown session + `headers: {}` → `socket.write('HTTP/1.1 404 Not Found\r\n\r\n')` (Node path preserved), both direct and workspace routes.
- Unknown session + `headers: { origin: 'http://localhost:5173' }` → `wss.handleUpgrade` invoked, callback closes ws with `(4404, 'session-unknown')`.

**Manual (dev-approval gate — run the worktree):**
1. `afx dev pir-971`, open the dashboard, open a terminal session.
2. Kill that session Tower-side (`afx` kill / Tower restart of just that PTY).
3. **Web terminal**: status icon flips to `disconnected` promptly (one transient retry at most, no full ~30s/6-attempt backoff); the give-up notice appears; the refresh button still reconnects.
4. **VSCode terminal** (regression check): same session-kill still fast-paths to the red "session no longer exists" notice with the reconnect link — behavior unchanged.
- Cross-surface: confirm a genuine transient drop (e.g. brief Tower restart that *re-creates* the session) still recovers via blind retry on both surfaces.
