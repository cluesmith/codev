# Phase 8 — Iteration 1 review response (rebuttal)

**Verdicts:** Gemini REQUEST_CHANGES (HIGH), Codex REQUEST_CHANGES (HIGH), Claude APPROVE (HIGH).

**Disposition: concurrence.** Both REQUEST_CHANGES were valid and are about **test coverage**, not
logic — all three reviewers independently called the implementation itself correct (Gemini: "core logic
… looks solid and correctly integrates"; Codex: "wiring looks sound"; Claude: APPROVE, "clean,
well-tested … no body leakage"). I agreed with every point and fixed both; no disputes.

---

## Point 1 — Missing Playwright test for the dashboard indicator (Gemini; Codex issue 1)

**Reviewers:** Gemini ("the E2E test requirement is a hard constraint for UI work in this repository");
Codex ("Phase 8 explicitly called for Playwright coverage of the live dashboard indicator/attention
state, and I found no Playwright/e2e spec").

**Agreed — fixed.** I had wrongly assessed Playwright as infeasible in the worktree (I checked
`require.resolve('playwright')` from the repo root instead of `@playwright/test` from `packages/codev`,
and didn't check the browser cache). It is fully runnable: `@playwright/test ^1.58.0` is a devDep and
chromium is cached under `~/.cache/ms-playwright`. The 3-way review caught exactly the gap the
"trust the protocol" lesson exists for.

**Change:** added `packages/codev/src/agent-farm/__tests__/e2e/spec-1313-held-count-indicator.test.ts`,
mirroring the established `spec-823-builder-attribution.test.ts` route-stub pattern. It stubs
`/api/overview` and asserts, in a real browser against the built dashboard bundle:

- heldCount 0 → the badge is not rendered;
- heldCount 3, not escalated → "3 held", no `held-badge--attention` class / no pulsing dot;
- heldCount 1, escalated → "1 held", attention class + `held-dot--attention` present;
- **live update** → mutating the overview stub from 2/not-escalated to 4/escalated flips the badge
  **without a reload** (via the `useOverview` poll / SSE refetch) — proving "count updates live" and
  "escalation moves the indicator into its attention state" (plan Test Plan + spec criteria).

**Result: 4/4 pass (35.5s)** on real chromium. Run on an isolated fresh Tower (an unused port + an
isolated `$HOME` so the e2e's workspace-activation cannot touch the real Tower's `global.db`), which
serves this worktree's freshly-built `dashboard-dist` (the one carrying `HeldCountBadge`). Command:
`HOME=<tmp> PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright TOWER_TEST_PORT=<free> TOWER_ARCHITECT_CMD=bash
pnpm exec playwright test spec-1313-held-count-indicator`. (Like the other e2e specs, this is the
separate `playwright` harness — it is not part of porch's `npm test`/`npm run build` checks.)

## Point 2 — No test exercising the actual extension.ts badge/status-bar wiring (Codex issue 2)

**Reviewer:** Codex ("The VSCode coverage stops at pure helper/toast tests. There's no test exercising
the actual `extension.ts` badge/status-bar wiring … which is the core Phase 8 behavior").

**Agreed — fixed.** The held-fold logic (badge total + tooltip composition, status-bar text assembly,
`$(warning)` swap) lived inline in the `updateStatusBarCounts` / `updateActivityBadge` closures, which
aren't exported and were untested; only the small leaf helpers were.

**Change:** extracted that composition into two pure functions in `mailbox-indicators.ts` —
`composeStatusBarText(builderCount, blockedCount, idleCount, heldCount, escalated)` and
`composeActivityBadge(blockedCount, idleCount, heldCount)` (returns the `{value, tooltip}` badge or
`undefined` when nothing needs the user). The two extension closures now assign the result of these
tested functions (plus the thin `statusBarItem.backgroundColor` / `buildersView.badge` glue). Added
10 unit tests covering: segment order + `$(warning)` escalation swap; the **preserved** singular/plural
blocked-only and idle-only phrasing; blocked+idle compact phrasing; held folded into the total and the
tooltip clause join; and undefined-when-empty (incl. a negative/absent held count clamped so it can't
fabricate a badge). `mailbox-indicators` + toast tests now 34 pass (was 24); full VSCode `test:unit`
677 pass / 56 files.

## Claude (APPROVE) — minor note

Claude approved with a minor note that a Playwright smoke "would be the final belt-and-suspenders …
not blocking." That belt-and-suspenders is now the passing spec above.

---

## Verification after fixes

- VSCode: `check-types` clean; `pnpm compile` (check-types + eslint + esbuild) exit 0; `test:unit`
  **677 pass / 56 files**.
- Dashboard: unchanged since the last green run (**328 pass / 1 skip**); production vite build exit 0.
- Playwright dashboard e2e: **4/4 pass**.
- `porch check` (build + tests): re-run after the fixes.

No spec/plan deviations; the visibility-only, count-only, read-only invariants (Decision 8) are
untouched — the changes are additional tests plus a pure-function extraction of existing logic.
