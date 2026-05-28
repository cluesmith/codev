# PIR Review: VS Code Backlog Mine/All Toggle

Fixes #809

## Summary

The VS Code Backlog view now opens to **mine-only** by default, showing just issues assigned to the current GitHub user. A title-bar eye icon toggles to **show-all** and back, persisting the choice across reloads via the `codev.backlogShowAll` config flag. The implementation reuses the established two-commands-one-flag-paired-when-clauses convention used by `codev.buildersAutoCollapse` and `codev.buildersFileViewAsTree`, so the surface area cost is small and the toggle feels native alongside the existing view-title actions.

## Files Changed

- `codev/plans/809-vscode-backlog-view-toggle-bet.md` (+62 / -0) — PIR plan
- `codev/state/pir-809_thread.md` (+22 / -0) — builder thread log
- `packages/vscode/package.json` (+25 / -0) — command, menu, config declarations
- `packages/vscode/src/extension.ts` (+20 / -0) — command registrations, context-key mirror, refresh wiring
- `packages/vscode/src/views/backlog.ts` (+36 / -1) — `refresh()`, filter application, empty-state placeholder, `readBacklogShowAll`
- `packages/vscode/src/views/backlog-filter.ts` (+21 / -0) — new pure helper `filterMine` (vscode-free, so vitest can import it)
- `packages/vscode/src/__tests__/backlog-filter.test.ts` (+53 / -0) — 5 unit tests covering filter behavior

## Commits

```
46def516 [PIR #809] Plan: correct test file path and unit-test scope
f4b10b3c [PIR #809] Plan draft
be662790 [PIR #809] vscode: backlog mine/all toggle
063eb09e [PIR #809] Thread: log implement phase
```

(Phase-transition commits authored by porch are omitted from this list — they carry no source changes.)

## Test Results

- `pnpm check-types` (vscode): ✓
- `pnpm lint` (vscode): ✓
- `pnpm test:unit` (vscode vitest): ✓ 100 tests, 5 new (`filterMine` suite)
- `pnpm build` (root): ✓
- `pnpm test` (root): ✓ 3188 pass / 13 pre-existing skips
- Manual verification at `dev-approval` gate: approved by the architect after exercising the toggle in a live VS Code window

## Architecture Updates

No changes to `codev/resources/arch.md`. This PR adds a view-level toggle to an existing tree provider — it follows the existing convention for `codev.buildersAutoCollapse` / `codev.buildersFileViewAsTree` and introduces no new architectural pattern. The arch doc already explains the broader sidebar architecture; a third instance of the same pattern doesn't change that description.

## Lessons Learned Updates

No changes to `codev/resources/lessons-learned.md`. The mechanics here (two commands + one config flag + setContext mirror + provider refresh) are already established in two prior callers; this is the third use of the same pattern, not a new lesson. If a fourth-or-fifth use lands later, that may be the right time to encode "toggle convention" as an explicit lesson — but a single feature implementing an existing pattern doesn't merit a global lessons entry.

## Things to Look At During PR Review

- **`filterMine` lives in its own file** (`views/backlog-filter.ts`) rather than next to `spawnableBacklog` in `backlog.ts`. The reason is purely test ergonomics: vitest tests in `src/__tests__/` cannot import from any module that pulls in the `vscode` runtime, and `backlog.ts` does (`import * as vscode from 'vscode'`). Other pure helpers in the codebase live in `@cluesmith/codev-core` for the same reason; an in-package file keeps this one's scope narrow (only the Backlog view uses it).
- **The empty-state placeholder gate is triple-guarded**: `items.length === 0 && !readBacklogShowAll() && !!data.currentUser`. The third clause matters — without it, a user who isn't signed into `gh` could see "no items assigned to you" even though we don't actually know who they are. The filter itself is a no-op in that case (returns all items), but the placeholder branch was a separate decision and needed its own guard.
- **The icon-swap behavior in `makeRow` is unchanged.** In show-all mode the `account` icon still distinguishes assigned items from the rest, per the issue's "no regression" criterion. In mine-only mode every visible row is by definition assigned-to-you, so the `account` icon is redundant-but-informative — acceptable and consistent.
- **Vitest pickup confirmed**: `vitest.config.ts:16` only includes `src/__tests__/**`, not `src/test/**`. My plan originally pointed at the wrong test directory; a plan-refinement commit (`46def516`) landed before the implement phase to correct it.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VS Code sidebar → right-click builder `pir-809` → **View Diff**
- **Run dev server**: VS Code sidebar → right-click builder → **Run Dev Server**, or `afx dev pir-809`
- **What to verify** (mapped from the plan's Test Plan):
  1. Default state: Backlog view shows only items assigned to you, eye icon is `$(eye)`
  2. Click the eye → all items appear, icon flips to `$(eye-closed)`, the `account` icon still marks your items
  3. Click again → filtered back to yours
  4. Reload window — toggle state persists (Global config target)
  5. With zero assigned items and mine-only active, the placeholder row appears with the text `(no backlog items assigned to you — click the eye icon to see all)`
  6. If `gh` auth is broken so `currentUser` is null, the view falls back to showing all items regardless of toggle position
  7. Right-click context menu and click-to-view behavior on rows are unchanged
