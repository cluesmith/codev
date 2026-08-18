# PIR Review: Clickable held-mail counter with a held-messages popover

Fixes #1450

## Summary

The dashboard header's held-mail counter ("2 held") was inert text, so learning *what* was held
meant dropping to `afx inbox` in a terminal. It is now a disclosure button — dotted underline,
`aria-expanded`/`aria-controls` — that opens a panel listing each held message as `from → to`
with its age and why-held reason. Server-side this reuses the existing `handleInboxList` behind a
new workspace-scoped `GET /api/inbox` branch; no new handler and no new projection, so the
metadata-only redaction rule and CLI-only dismissal (Spec 1313 decision 8) are untouched.

The one genuinely subtle part is that **the badge count and the list disagree by design** — see
*Things to Look At*.

## Files Changed

- `apps/web/src/components/HeldCountBadge.tsx` (+219 / -…) — span → disclosure button, grouped popover, generation-guarded lazy fetch
- `apps/web/src/index.css` (+125 / -0) — underline affordance, popover panel, z-index tier
- `apps/web/src/lib/heldMail.ts` (+48 / -0) — new; `formatHeldAge` / `formatHeldDuration` / `isScheduled`
- `apps/web/src/lib/api.ts` (+19 / -0) — `fetchInbox`
- `apps/web/src/components/App.tsx` (+8 / -3) — wire `loadMessages`
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+30 / -3) — `workspaceOverride` param + workspace-scoped branch
- `packages/types/src/api.ts` (+46 / -0) — `HeldMessage`
- `packages/types/src/index.ts` (+1 / -0) — export it
- `apps/web/__tests__/HeldCountBadge.test.tsx` (+386 / -…) — 20 new cases, 5 originals kept unchanged
- `apps/web/__tests__/heldMail.test.ts` (+59 / -0) — new
- `packages/codev/src/agent-farm/__tests__/inbox-routes.test.ts` (+168 / -0) — 13 new route cases
- `packages/codev/scripts/issue-1450-dashboard-evidence.mts` (+370 / -0) — new; real-browser evidence harness
- `codev/plans/1450-dashboard-make-the-held-mail-c.md`, `codev/state/pir-1450_thread.md`, `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — artifacts and governance

## Commits

- `b6c15774e` [PIR #1450] Plan draft
- `934e9354e` [PIR #1450] Plan revised: Held/Scheduled split, a11y disclosure pattern, isolated-Tower Playwright
- `5a782c0b7` [PIR #1450] Plan: use AF_TEST_DB isolation seam for the evidence Tower (not a HOME redirect)
- `d70e3503f` [PIR #1450] feat: clickable held-mail counter with a held-messages popover

## Test Results

- `pnpm build`: ✓ pass
- `pnpm test` (`@cluesmith/codev`): ✓ 4916 passed, 48 skipped, **0 failures**
- `apps/web` (`pnpm --filter @cluesmith/codev-web test`): ✓ 371 passed, 1 skipped, 33 files — **37 new tests**
  - Note: the root `test` script runs only the `codev` package; web tests need the filtered command.
- **Manual, real browser**: `packages/codev/scripts/issue-1450-dashboard-evidence.mts` — 23/23 checks
  in headless Chromium against an isolated Tower (worktree build, port 14700, `NODE_ENV=test` +
  `AF_TEST_DB`). Real workspace, real shellper PTYs painted with an occupied composer, real
  `POST /api/send` held by the render gate, real built SPA. Asserts the underline affordance,
  `aria-expanded` toggling, `from → to` rows, the Held/Scheduled grouping,
  `GET .../api/inbox` returning **200**, Held-group length === badge count, popover stacking over
  a live terminal, and Escape-closes-with-focus-return.
- **Human review at the `dev-approval` gate**: the reviewer exercised an interactive instance of
  that same environment personally (2 held + 1 scheduled fixture) and approved.

## Architecture Updates

Routed **COLD only** (`codev/resources/arch.md`). Neither hot file was touched: both are at their
10-entry cap, and nothing here is a cross-cutting invariant worth displacing an existing entry —
these are subsystem facts about Tower's routing and the mailbox, which is what the cold archive is
for.

Two additions:

1. **Agent Farm Internals → "Two route tables, and why a 'working' endpoint can still 404 for the
   dashboard."** `tower-routes.ts` dispatches through two independent tables — the Tower-level
   `ROUTES` map (`/api/<thing>`, used by the CLI) and `handleWorkspaceRoutes`
   (`/workspace/<b64>/api/<thing>`, used by the dashboard, whose `getApiBase()` returns `'./'`).
   Registering in one does not register in the other, which is exactly why this issue existed:
   `GET /api/inbox` had backed `afx inbox` since Spec 1313 while `./api/inbox` 404'd for the
   dashboard. Also records why workspace-scoped handlers take a `workspaceOverride` that **wins
   over** `?workspace=`, and that the exact-vs-prefix match is a security boundary.
2. **Mailbox section** — the count/list asymmetry, written as "do not 'fix' it" (details below),
   including the corollary that a scheduled-only state is invisible to the badge by design.

## Lessons Learned Updates

Routed **COLD only** (`codev/resources/lessons-learned.md` → Testing). Both entries are about
browser-test technique — useful, but not the always-injected kind, and the hot file is at cap.

1. **A browser assertion can pass while proving nothing — assert its precondition in the same
   test.** My z-index check confirmed the popover was on top at its centre point and was green
   and worthless: `querySelector('.xterm')` had returned the *left* pane's terminal, which can
   never overlap a top-right panel, so the actual hazard (xterm's WebGL canvas painting over an
   unlayered element) was never exercised. The fix asserts the setup — "a terminal genuinely
   overlaps this rect" — before asserting the property. Same shape as #1401's guard lesson.
2. **Two Playwright mechanics specific to this dashboard**: `waitUntil: 'networkidle'` can never
   fire (the SSE stream at `/api/events` stays open for the page's lifetime), and a lazily-fetched
   panel must be waited on by its *loaded* content or assertions read the "Loading…" state. Plus:
   assert the **status code** of the endpoint under test, because an auth failure renders as a
   tidy error state that looks like a working UI.

## Things to Look At During PR Review

**1. The Held/Scheduled split — the part that took two attempts to get right.**
My first plan asserted that pre-due `--delay` rows "already inflate `heldCount`". That was
backwards, and the architect's review caught it. Verified against `db/mailbox.ts`:

- `heldSummaryForWorkspace` (`:215-227`) — the badge count — filters
  `not_before IS NULL OR not_before <= now`.
- `listHeld` (`:113-124`) — behind `GET /api/inbox` — has **no** such filter.

So `heldCount <= inbox.length`, always, deliberately: a scheduled send is "scheduled, not stuck"
and must not raise an attention indicator. A naive popover would say "2 held" and list 3 rows. The
panel therefore **groups**: `Held (N)` where N is exactly the badge count, above a secondary
`Scheduled (M)` with a countdown and explanatory copy. Groups render only when non-empty, so the
ordinary case looks like one plain list. Pinned by a unit test (1 due + 1 pre-due at `count={1}`)
and re-verified live in the browser run, which reproduced exactly that fixture.

**2. Accepted edge case, not an oversight.** With 0 due and 1 scheduled row, `heldCount` is 0, the
badge does not render, and that row is unreachable from the dashboard. That is the existing
contract — the badge is an *attention* indicator — and `afx inbox` remains the surface that sees
it. Surfacing it would mean rendering a badge whose count is 0. Documented on the component, on
the `HeldMessage` type, and in arch.md; changing it is a change to what the badge counts.

**3. The exact-match on `'inbox'` is load-bearing.** `inbox/:id` returns the message **body** and
`inbox/:id/dismiss` mutates. Both must stay unreachable under the workspace prefix for the
"metadata-only, read-only" claim to hold. Three tests pin that (both 404, and the row survives a
POST) rather than leaving it to inspection.

**4. `formatHeldAge`, not `formatDuration`.** `apps/web/src/lib/open-files-shells-utils.ts:2-10`
already exports a `formatDuration` with different semantics (minute granularity, `<1m` floor) and
existing callers. The new helper is second-granularity to match `afx inbox`, so it is separately
named rather than merged — two same-named formatters with different output in one `lib/` is a
trap. It is a deliberate ~10-line port, not an import: the web app must not cross the
server/client isolation boundary (#1189), and `codev-types` is a types-only devDependency.

**5. Fetch lifecycle.** Loads on open and on `count` change while open (the count is SSE-driven, so
a change means the mailbox moved). Each load carries a generation counter; stale responses are
discarded — React 19 would not warn about the open→close→open race. And while the panel is open
the component stays mounted even at `count <= 0`, because `useOverview` polls every 2.5s and the
last row being delivered would otherwise unmount the button and drop focus to `<body>`. The
closed-at-zero contract is unchanged, so the original zero-state tests pass untouched.

**6. Not a dialog.** Deliberately the WAI-ARIA *disclosure* pattern (`aria-expanded` +
`aria-controls` + a real `<ul>`), not `role="dialog"` — a dialog role without moving focus in is
announced inconsistently, and this panel should not steal focus from the terminals.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1450` → **Review Diff**
- **Run the browser evidence** (needs an out-of-tree Playwright; see the script header):
  ```bash
  pnpm build
  npm install playwright-core --prefix /tmp/pw
  PW_CORE=/tmp/pw/node_modules/playwright-core \
  PW_CHROMIUM=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
  node --experimental-strip-types packages/codev/scripts/issue-1450-dashboard-evidence.mts
  ```
  It stands up and tears down its own isolated Tower on port 14700; the live Tower on 4100 and the
  real `global.db` are never touched.
- **What to verify**:
  - The counter is underlined and reads as interactive; clicking opens the panel.
  - Rows show `from → to` (a null sender renders `?`, matching `afx inbox`), with age and reason.
  - With a `--delay` send in flight, `Held (N)` matches the badge and `Scheduled (M)` is separate.
  - Escape closes and returns focus to the counter; click-outside closes; a terminal behind the
    panel does not paint over it.
  - On a normally-running dashboard, the union of both groups matches `afx inbox -w <workspace>`
    row for row, and the Held group alone matches the badge count.

## Flaky Tests

None. No pre-existing failures were encountered in the full suite (4916 passed), so nothing was
skipped or quarantined.

## Scope Note

Out of scope and unchanged, per the plan: VSCode's `mailbox-indicators.ts` (the issue is titled
*Dashboard*); mobile (`MobileLayout` does not render the badge today); dismiss/show-body from the
UI (Spec 1313 decision 8 and the redaction rule); and `codev-skeleton/` (this is product code, not
framework files, so there is no skeleton twin to mirror).
