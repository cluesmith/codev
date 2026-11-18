# PIR Review: Open Codev IDE link over Codev Cloud

Fixes #1914

## Summary

The dashboard's **Open IDE** link only appeared on a locally opened dashboard: its availability poll (`GET /api/ide`) and its cookie mint (`POST /api/ide/session`) are local-only and tunnel-blocked by design, so over Codev Cloud the link never rendered. The IDE signal now rides `GET /api/status` (which the tunnel relays) as `ide: { available, viaTunnel }`, and `openIde()` skips the mint when the page came through the tunnel and navigates straight to `./ide/?folder=…`. For tunnel-borne responses the forward also scopes the IDE server's `vscode-tkn` cookie to `Path=/t/<tower-name>/ide`, so towers on the shared cloud origin cannot overwrite each other's cookie. The `api/ide` family stays blocked over the tunnel and the local path is unchanged.

## Files Changed

- `packages/codev/src/agent-farm/servers/ide-server.ts` (+17 / -0): `ideAvailability(viaTunnel)`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+13 / -5): `/api/status` carries `ide: { available, viaTunnel }`
- `packages/codev/src/agent-farm/servers/ide-forward.ts` (+82 / -18): `TokenCookiePolicy` (strip | scope) shared by the HTTP and WebSocket-101 relays; `scopeConnectionTokenSetCookie`; `tower_name` validation in `getPublicAuthority`
- `packages/codev/templates/tower.html` (+31 / -37): `refreshIdeStatus()` and its `./api/ide` poll removed; `refresh()` reads `data.ide`; `ideTargetUrl()`; tunnel-aware `openIde()`
- `packages/codev/src/agent-farm/__tests__/pir-1914-ide-cloud-availability.test.ts` (+218 / -0): new
- `packages/codev/src/agent-farm/__tests__/e2e/pir-1914-ide-link-cloud.test.ts` (+80 / -0): new Playwright suite
- `packages/codev/src/agent-farm/__tests__/ide-forward.test.ts` (+53 / -11)
- `packages/codev/src/agent-farm/__tests__/ide-forward-integration.test.ts` (+30 / -6)
- `packages/codev/src/agent-farm/__tests__/tower-routes.test.ts` (+38 / -1)
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md`: see below
- `codev/plans/1914-dashboard-open-codev-ide-link-.md`, `codev/state/pir-1914_thread.md`, porch `status.yaml`

## Commits

- `69c16a421` [PIR #1914] Dashboard: IDE link from the status poll; open over the tunnel without the mint
- `3bd697c04` [PIR #1914] Scope the tunnel-relayed vscode-tkn cookie to /t/<tower>/ide; validate tower_name
- `a6f1d9eba` [PIR #1914] /api/status carries the IDE signal (available, viaTunnel)
- `3bea1820b` Merge origin/main into builder/pir-1914 (brings bugfix #1922's test-harness env fix)
- `d6cdec389`, `c23f3bdd7`, `e199fdca6` plan draft and revisions; thread and porch commits

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass at the `dev-approval` check (porch) and in a post-merge run: 8182 passed, 108 skipped. 24 new or changed unit/integration tests (12 in the new `pir-1914` file, 5 cookie-scoping + tower-name tests in `ide-forward.test.ts`, 3 tunnel/local integration cases, 3 `/api/status` route tests, plus updates for the new policy signature).
- `tsc --noEmit`: ✓ clean
- Playwright (`e2e/pir-1914-ide-link-cloud.test.ts`, run against a throwaway Tower on port 14114 with its own `CODEV_AGENT_FARM_DIR` / `SHELLPER_SOCKET_DIR`): 3/3. Local: link visible, click mints then opens `/ide/?folder=…`. Tunnel: link visible, click opens `/ide/?folder=…` with **no** mint request. No IDE: no link.
- Manual: the owner approved `dev-approval` on the architect's local-path verification against a throwaway Tower. The cloud path has **not** been exercised against a live cloud-registered Tower; it is covered by the unit, integration and Playwright tests above, and a live-cloud check remains the owner's call.

## Architecture Updates

Cold tier only (`codev/resources/arch.md`, "IDE prefix forward"): the tunnel-path cookie sentence now says the relayed `vscode-tkn` is scoped to `Path=/t/<tower-name>/ide` (stripped with no usable authority, and Path is not an isolation boundary), and a new bullet records the dashboard's availability signal on `/api/status`, the local-vs-tunnel availability rule, the two open paths, and the `tower_name` character check. No hot-tier change: this is reference detail for one subsystem, not a cross-cutting rule.

## Lessons Learned Updates

Cold tier (`codev/resources/lessons-learned.md`, Testing):

- A scoped `@cluesmith:registry` in the machine's npm config makes `protocol-drift-audit.test.ts` fail deterministically, and an env override of the scope does not survive porch's `npm test` because pnpm's script runner re-exports the user npm config; an empty `npm_config_userconfig` for the run gets through without touching the owner's config.
- A request-interception glob for one path family (`**/ide/**`) also caught a sibling (`/api/ide/session`); match exact pathnames when asserting a request was or was not made.

No hot-tier lesson: both are narrow testing recipes.

## Things to Look At During PR Review

- **Security boundary unchanged.** `api/ide` and `api/ide/session` stay tunnel-blocked (`BLOCKED_PATH_SEGMENT` untouched) and the mint still 403s tunnel-borne requests. The `/ide` forward's authorization is unchanged: a request carrying the tunnel marker with no key and no forward cookie is refused (pinned in `pir-1914-ide-cloud-availability.test.ts`). The forward was already reachable over the tunnel with the cloud session; this change makes it discoverable, not newly reachable.
- **`viaTunnel` is a hint, not a credential.** It only selects the open path and the cookie policy. A local process forging the marker still needs the key to read `/api/status` or reach `/ide`.
- **Cookie Path is not isolation.** Scoping stops cross-tower overwrites on the shared origin; same-origin script on another tower's page could still read the cookie. Per-tower origin isolation would be a Codev Cloud decision, out of scope.
- **Prefix source after a cloud-side rename (architect integration review, REQUEST_CHANGES, fixed in `391155114`):** the stored `tower_name` goes stale after a rename (`TunnelClient` keeps only `towerId` from `auth_ok`), and Tower's forward used to overwrite the relay's correct `x-forwarded-prefix` with it, breaking the workbench's asset paths; the new cookie Path inherited the same stale source. For a tunnel-borne request, `getPublicAuthority(req.headers)` now takes the prefix from the relay-stamped inbound `x-forwarded-prefix` when it matches `^/t/[A-Za-z0-9._-]+/ide$`, falling back to the stored `tower_name`; that one prefix feeds both the stamp and the cookie Path. The inbound header is trusted only on a tunnel-borne request (Tower's own marker) and only after the pattern check; a local request never consults it. Unit tests cover a renamed slug (stamp and Path follow it), malformed or array values (fallback), a local request (ignored), and no cloud config (null); an integration test drives the real forward. Persisting the slug from `auth_ok` stays with #1871.
- **`tower_name` check** (`^[A-Za-z0-9._-]+$`) also hardens the pre-existing `x-forwarded-prefix` stamp (small adjacent fix). `afx tower connect` prompts for the name without validating it; normalized names pass. A non-conforming name loses Tower's prefix stamp (the cloud relay stamps its own) and the `vscode-tkn` cookie is stripped. Upstream auth is unaffected (Tower injects the token on every forwarded request), but over the tunnel that cookie is the browser workbench's token source (config injection is local-only), so the cloud workbench may not work for such a tower. It fails closed, and Tower now logs a WARN once per process when a tunnel-borne `/ide` request has no usable public authority (CMAP, Claude).
- **Behavior shift, locally:** the link now refreshes on the 5s status poll instead of on load/visibility; the condition (record present) is unchanged, and the dashboard no longer triggers the blocking `lsof` probe on load.
- **CMAP follow-ups applied (`3f96f723b`):** the new e2e test refuses to default to port 4100 (same rule as `issue-1482-held-popover-detail.test.ts`), and the fail-closed no-authority state is logged instead of silent. Consultation: codex APPROVE, claude COMMENT (these two items plus "confirm CI green"), gemini skipped (agy exited 3).
- **Over the tunnel the link needs a live port** (a loopback TCP connect per 5s poll, only when a record exists), because there is no mint there to respawn a dead server first.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1914 → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1914`
- **What to verify**:
  - Local `http://localhost:4100/` with an IDE server recorded (`afx ide status` / `afx ide start`): **Open IDE** shows; click → `POST api/ide/session` then the workbench opens.
  - Cloud `https://cloud.codevos.ai/t/<tower>/` on a cloud-registered Tower running this build: `api/status` returns `"ide":{"available":true,"viaTunnel":true}`; the link shows; click opens `…/t/<tower>/ide/?folder=…` with no `api/ide/session` request; the IDE tab's `vscode-tkn` cookie has Path `/t/<tower>/ide`; `afx ide stop` hides the link within one poll.
  - `…/t/<tower>/api/ide` is still refused over the cloud.

## Flaky Tests

None of these files is in this diff; all were left running, none skipped or edited.

- **Pre-existing deterministic (environmental), not flaky:** `packages/codev/src/__tests__/protocol-drift-audit.test.ts` "the REAL default lookup is offline-tolerant AND bounded when the registry is unreachable" (`:178`) fails on a machine whose npm config has a scoped `@cluesmith:registry`: the scoped registry overrides the test's `npm_config_registry=http://127.0.0.1:1`, so `npm view` returns `3.3.7` instead of null. An env override of the scope alone is not enough under porch, because pnpm's script runner re-exports the user npm config. Per the architect's ruling, porch runs here used a one-run empty `npm_config_userconfig`; the hermetic test fix is on the architect's filing list.
- `packages/codev/src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts` "recover-path entry uses the provided initial command; a crash then resumes the discovered id with the nudge": 5000ms timeout in a full run at load ~22; passed in isolation (recorded intermittent on main).
- `packages/codev/src/agent-farm/__tests__/bugfix-1267-launch-loop.test.ts:114` "keeps resuming across a CRASH": 5000ms timeout in full runs (including post-merge at load 20 to 35); passes in isolation.
- `packages/codev/src/agent-farm/__tests__/ide-command.test.ts` "ideInstall (Scenario 24) reports the installed server version on success" and `spec-1365-serializer-convergence.test.ts` "the drainer keeps delivering to OTHER agents while one terminal is held": 5000ms timeouts at load ~22; 63/63 in isolation.
- `packages/codev/src/commands/consult/__tests__/agy-auth-cache.test.ts` "spawns agy at most once across a 5-wide burst when unauthenticated": `expected 5 to be 1` under load (lock losers fail open after the 6s wait when the fake prober is slowed); 27/27 in isolation.
- Also seen as 5000ms timeouts under load in one pre-merge diagnostic run: `bugfix-1455-pr-create-concept.test.ts` (gitea), `doctor.test.ts` "should return 0 when all dependencies are installed", `claude-cli-lane.test.ts` (2), `tripwire-wiring.test.ts` "fires when the lane creates a file".
- Context: before merging main, tests started from a builder session inherited its shellper marker and Tower port; bugfix #1922's `vitest-setup.ts` change (merged in `3bea1820b`) drops them, and the post-merge full run had 1 timeout where the pre-merge run had 7.
