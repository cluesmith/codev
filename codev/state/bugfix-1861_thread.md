# bugfix-1861 thread — Decisions tab to second position

## Investigate (2026-10-27)
- Reproduced by reading `apps/web/src/hooks/useTabs.ts` `buildTabs()`: fixed tabs are seeded as
  `[work, analytics]`, then Team is pushed (when `teamEnabled`), then Decisions (when
  `showDecisions`). So Decisions lands 3rd or 4th. The existing test
  `useTabs.decisions.test.ts` pins that order (`work, analytics, team, decisions, architect`).
- Index assumptions checked: `TabBar.tsx`, `MobileLayout.tsx`, `ArchitectTabStrip.tsx` just map
  over the array; `App.tsx` filters by `type`; `useTabs` fallbacks use `tabs[0]` (still Work)
  and the explicit `'architect'` id. The Playwright Decisions suite finds tabs by role+name.
  Persistence/deep links are by `id`. No position dependency anywhere.
- Docs (`agent-farm.md` Decisions tab section) do not state a position, so there's nothing to update.
- Scope: a few lines in `buildTabs()` plus a test. Well within BUGFIX.

## Fix (2026-10-27)
- `buildTabs()` now seeds `[work]`, pushes Decisions (when `showDecisions`), then Analytics, then
  Team (when `teamEnabled`). Nothing else changed: same tab objects, same gating.
- Regression test: `useTabs.decisions.test.ts` replaces the old order test with an `it.each`
  over decisions × team. Against the old `buildTabs()` the two decisions-on cases fail; with the
  fix all 10 pass.
- Browser check: added a Playwright test to the isolated Decisions suite
  (`decisions-tab.test.ts`) asserting the right-pane strip reads Work, Decisions, Analytics, Team
  for a workspace with the file + a 2-person team, and Work, Analytics without the file. All 13
  tests in the suite pass on a throwaway Tower; the screenshot shows the new order.
- Surprise: on this Mac's Node v26, 9 apps/web test files (Terminal*, VirtualKeyboard,
  architect-toolbar) fail with `localStorage.getItem` undefined: Node 25+'s built-in Web
  Storage global shadows jsdom's. CI is Node 20. With `NODE_OPTIONS=--no-experimental-webstorage`
  all 40 web files pass. Unrelated to this change; not touched.
- Checks: `npm run build` ok; `npm test` 341 files / 7141 tests pass.

## PR (2026-10-27)
- PR #1862 opened. CMAP: gemini=APPROVE, codex=APPROVE, claude=APPROVE (all HIGH, no key issues).
- `consult --type pr` from this worktree first failed with "Multiple projects found" (auto-detect
  doesn't narrow across the many `codev/projects/` dirs); passing `--issue 1861` fixed it.
- Claude's non-blocking note: the Spec 1819 plan and the spir-1819 thread still say "after Team".
  Left as-is: they're point-in-time records, and live docs never stated a position.
