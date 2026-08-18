# bugfix-1519 — Dashboard E2E red on main since #1421

Issue: the schedule-only **Playwright** dashboard-e2e suite makes keyless Tower
requests. #1421 put every non-public Tower route behind the shared local key; its
in-PR fix keyed only the **vitest** harness (`vitest-e2e-setup.ts` + `towerWsProtocols`),
which the Playwright harness never touches. First scheduled run after merge → 27 failed.

## Investigate phase — findings

Auth model (verified in `packages/codev/src/agent-farm/utils/server-utils.ts`):
- Public (keyless GET): `/health`, `/api/version`, `/`, `/index.html`, and the SPA shell
  under `/workspace/<enc>/` (static assets only). Every `api/`/`ws/`/`file` subpath is keyed.
- HTTP key: `codev-tower-key` header. WS key: `codev-key.<key>` subprotocol
  (`terminalWsProtocols()` in `packages/types/src/websocket.ts`).
- **Injection path is HEALTHY** (`tower-routes.ts:injectWebKey`): both the front page
  (`tower.html`) and SPA `index.html` are served with `window.__CODEV_TOWER_KEY__` set.
  So real-UI `page.goto` tests get a keyed shell and the SPA presents the key. The
  architect's datum (front-page h1 passed, `.instance` list failed) is explained by the
  **setup** failure below, not an injection bug.

Root-cause call sites (all in the Playwright harness — none in the workflow yaml):

- **A. Harness setup cascade** — `e2e/global-setup.ts` uses node global `fetch`
  (NOT a Playwright context, so `use.extraHTTPHeaders` won't reach it) for keyless
  `POST /api/launch` and `GET /workspace/<enc>/api/state`. Both now 401 → workspace never
  activated → no architect terminal / no instances → `element(s) not found` across the
  WHOLE suite. This is the dominant failure.
- **B. Direct-API tests** — `request.get/post/delete` and `page.request.*` to `/api/state`,
  `/api/team`, `/api/overview`, `/api/tabs/*` in dashboard-bugs, dashboard-terminals,
  team-tab, tower-integration, work-view-backlog → keyless → 401.
- **C. Raw WS tests** — `dashboard-terminals.test.ts:70,101` do `new WebSocket(url)` inside
  `page.evaluate` with no subprotocol → keyless handshake → rejected.
- **D. `page.route('**/api/state', route.fetch())`** (architect-pane-layout, spec-823,
  team-tab, spec-1313) — replays the browser's own (key-injected) request, and merges
  onto `{}` if base 401s. Resilient; not the cause. Extra-header fix makes them doubly safe.

Workflow check (`.github/workflows/dashboard-e2e.yml`): NO keyless curl/API setup steps —
Tower start + activation happen entirely inside Playwright's webServer + global-setup.
So the architect's "category 2" (workflow setup) is clean.

## Planned fix (implement phase) — ~3 files, well under 300 LOC

1. `playwright.config.ts`: add `use.extraHTTPHeaders = { [TOWER_KEY_HEADER]: ensureLocalKey() }`.
   One place keys every `request.*` / `page.request.*` / navigation — mirrors how
   `vitest-e2e-setup.ts` wrapped fetch once instead of threading 90 call sites. Fixes B (+D).
2. `e2e/global-setup.ts`: key its two raw-fetch calls (launch + state poll) with the header.
   Fixes A. `launchWorkspaceWithRetry` already takes an injectable `fetchFn` — good for testing.
3. `dashboard-terminals.test.ts`: build subprotocol from `window.__CODEV_TOWER_KEY__` in the
   two `page.evaluate` WS opens (mirror the real dashboard client). Fixes C.

Regression test (vitest, runs in REQUIRED CI so it can actually gate):
- Assert `global-setup` attaches `codev-tower-key` to its launch/state requests (capture via
  mock `fetchFn`), and that `playwright.config.ts` `use.extraHTTPHeaders` carries a 64-hex key.
  Fails without the fix, passes with it.

Validation note: the suite is schedule-only, so PR CI can't prove it. Local `reuseExistingServer`
targets the LIVE :4100 Tower (architect's caution — do NOT start a second :4100 / drive the live
one). Will validate via the vitest regression test + a dispatched `workflow_dispatch` run (or an
isolated non-4100 Tower if feasible) and state the method in the PR.

Scope verdict: focused, no architecture change → stays in BUGFIX.

## Fix phase — implemented

Changes (all product code under `packages/codev`, no skeleton mirror):
1. `playwright.config.ts` — `use.extraHTTPHeaders = { [TOWER_KEY_HEADER]: ensureLocalKey() }`.
   Keys every `request.*` / `page.request.*` / navigation in one place. Fixes B (+ hardens D).
2. `e2e/global-setup.ts` — new exported `towerAuthHeaders()`; attach it to the launch POST
   and the state-poll GET (both run outside Playwright contexts). Fixes A (the cascade).
3. `e2e/dashboard-terminals.test.ts` — offer `terminalWsProtocols(ensureLocalKey())` as the
   subprotocol on the two raw `new WebSocket()` opens in `page.evaluate`. Fixes C.
4. NEW `__tests__/bugfix-1519-e2e-auth.test.ts` — vitest regression test (runs in REQUIRED CI):
   asserts the launch POST and the config both present a 64-hex `codev-tower-key`.

Verification:
- Regression test: 3/3 pass with fix; reverting the two source changes → 2 fail (proves it pins).
- Targeted `tsc` on all 4 changed files: clean.
- `pnpm build` (codev): pass.
- Adjacent suites (bugfix-1519 + bugfix-773 + request-auth): 42/42 pass.
- Full default `pnpm vitest run`: running in background.

Validation caveat for PR: dashboard-e2e is schedule-only, so PR CI can't turn it green.
Did NOT run the Playwright suite locally (it would target the LIVE :4100 Tower / real
architect sessions — architect's caution). Will note in the PR that validation was via the
vitest regression test + a dispatched `workflow_dispatch` run of dashboard-e2e.yml.

## PR phase — CMAP round 1 + revision

PR #1520 opened. CMAP round 1: gemini=APPROVE (HIGH), claude=APPROVE (HIGH),
codex=REQUEST_CHANGES (HIGH). Codex's real point: global `use.extraHTTPHeaders` attaches
the key to EVERY origin, not just Tower — broader than a real client (same-origin only) and
a latent cross-origin key-disclosure vector. (Verified no cross-origin browser request exists
in the suite today, so not an active leak — but the issue's own lesson is "don't defer the
auth fast-follow," so I scoped it now rather than punting.)

Revision (round 2): scoped the key to Tower-bound traffic only, one source of truth.
- NEW `e2e/tower-key.ts` (pure, no Playwright import): `towerAuthHeaders()` + `towerWsProtocols()`.
- NEW `e2e/tower-auth.ts`: Playwright fixtures — `request` fixture is a Tower-scoped keyed
  APIRequestContext; browser page fetches rely on same-origin injection (shipped behavior).
- `playwright.config.ts`: REMOVED global `extraHTTPHeaders` (no all-origins header).
- Direct-API tests import the scoped `test` from `./tower-auth.js`; `page.request` sites
  (tower-integration, work-view-backlog) pass `{ headers: towerAuthHeaders() }` explicitly.
- `dashboard-terminals.test.ts` WS uses `towerWsProtocols()` (consolidation, claude#2).
- `global-setup.ts`: extracted `waitForArchitectReady()` (testable), imports the shared helper.
- Regression test strengthened: pins launch (A), state poll (A), request-header token (B),
  WS subprotocol token (C); uses `toBe(ensureLocalKey())` not a hex regex (claude#1: avoids
  CODEV_TOWER_KEY false-fail). 5 assertions; reverting either global-setup key → 2 fail.

Net result: the key never touches a non-Tower origin — mirrors the shipped same-origin design.
Also filed-for-architect (do NOT self-file): claude#6 suggests a `pull_request` paths-filtered
trigger so this schedule-only suite gets a real gate (closes the class, not just the instance).
Re-running CMAP on the revised PR before notifying.
