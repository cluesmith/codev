# pir-811 thread

## 2026-05-27 — plan phase

Read issue #811 (group backlog by area). Investigated:
- `OverviewBacklogItem.area: string` already on the wire (added by #819).
- `parseArea` (singular) is policy-free — does NOT privilege `area/cross-cutting` (explicit decision + regression test in #819).
- `parseAreaLabels` (plural) does NOT exist. The "helper issue" referenced as Related in #811 was #819, which CLOSED with a different shape (singular projection on the server, no resolvePrimaryArea helper).

Design tension: AC #2 wants cross-cutting in its own top group, but the singular `area` field can't distinguish `[area/cross-cutting]` from `[area/auth, area/cross-cutting]` (the latter projects to `auth`).

Resolution chosen: lean on the issue body's own convention guidance — "Tag it `area/cross-cutting` only (don't list every individual area)". Under this convention, singular `area === 'cross-cutting'` is sufficient detection. Avoids re-litigating #819's wire-shape decision. Documented the alternative (`crossCutting: boolean` or `areas: string[]`) in the plan's Risks section as a follow-up if the convention proves brittle.

Plan written to `codev/plans/811-vscode-group-backlog-by-area.md`. Ready for plan-approval gate.

## 2026-05-27 — implement phase

Plan-approval gate approved. Implemented the area-grouping refactor:

- `views/backlog.ts`: added pure `groupBacklogByArea(items)` helper (cross-cutting first, alphabetical specifics, Uncategorized last; empty groups omitted; within-group order preserved). Refactored `BacklogProvider` to two-level (`getChildren()` returns groups when called with no element, rows when called with a `BacklogGroupTreeItem`). Constructor now takes `vscode.Memento` for expansion-state persistence.
- `views/backlog-tree-item.ts`: added `BacklogGroupTreeItem` class. Uses stable `id` (`backlog-group:<areaName>`) so VSCode preserves item identity across SSE-driven `onDidChangeTreeData` refreshes — which keeps the user's expand/collapse choice persistent visually as well as via the workspaceState write-back.
- `extension.ts`: passed `context.workspaceState` to `BacklogProvider`; wired `backlogView.onDidExpandElement` / `onDidCollapseElement` to call `setGroupExpanded()` so user choices persist.
- `test/backlog.test.ts`: 8 new tests for `groupBacklogByArea` covering empty input, lone cross-cutting, lone Uncategorized, full ordering, omitted empty groups, within-group order preservation, multi-item-per-area, and the defensive empty-string-area fallback.

Test results:
- `pnpm --filter codev-vscode test`: 91 pass (8 new groupBacklogByArea + all pre-existing).
- `pnpm build` (full workspace): green.
- `pnpm --filter @cluesmith/codev test`: first run showed 17 flakes in unrelated suites (cron-cli, etc.); re-run clean at 3173 pass. Not caused by this PIR — my changes are entirely in `packages/vscode/`.

Ready for dev-approval gate.

## 2026-05-27 — implement phase, revision 1

User correction at the dev-approval gate: hardcoding `'cross-cutting'` into the view bakes a repo-specific convention into framework code. Replaced with a per-repo VSCode setting `codev.backlog.priorityAreas: string[]` — areas listed here get pinned to the top in the listed order; default `[]` is pure alphabetical. Mirrors the framework-neutral discipline #819 already established at the parser layer.

Also dropped the defensive `item.area || UNCATEGORIZED_AREA` coercion in `groupBacklogByArea` — the wire contract from #819 guarantees `area` is always a populated string, so the fallback is dead defense. Removed the corresponding empty-string-area test case.

Changes:
- `views/backlog.ts`: `groupBacklogByArea(items, priorityAreas = [])`; new `readPriorityAreas()` reads the setting; new `refresh()` for config-change re-render.
- `extension.ts`: subscribed `onDidChangeConfiguration` for `codev.backlog.priorityAreas` to call `backlogProvider.refresh()`.
- `package.json`: registered the `codev.backlog.priorityAreas` setting.
- `test/backlog.test.ts`: dropped cross-cutting and empty-string fixtures; added `priorityAreas pins listed areas`, `Uncategorized stays last even when listed in priorityAreas` (defensive guard), `priorityAreas entries that match no present area are skipped silently`.

Test results: `pnpm --filter codev-vscode test` → 92 pass.

## 2026-05-27 — review phase

PR #886 opened with the review file as body. Single advisory 3-way consultation pass:
- Gemini: APPROVE
- Codex: APPROVE
- Claude: COMMENT (one cosmetic — `void` prefix on a fire-and-forget Promise; matches my own `feedback_no_void_floating_promise` convention)

Addressed Claude's nit in `9ace0fcb` (dropped the `void` prefix). pr gate now pending; architect notified.

## 2026-05-27 — review phase, revision 2

Architect reconsideration during pr-gate review: drop the `codev.backlog.priorityAreas` mechanism entirely. Rationale: solving a problem we don't have; configurable shape conflated coordination with rank. Better to remove than ship + maintain.

Changes:
- `views/backlog.ts`: `groupBacklogByArea` no longer takes `priorityAreas`; pure alphabetical specifics + `Uncategorized` last. Dropped `readPriorityAreas()`, `refresh()`.
- `extension.ts`: dropped the `onDidChangeConfiguration` listener for `codev.backlog.priorityAreas`.
- `package.json`: dropped the `codev.backlog.priorityAreas` setting registration.
- `test/backlog.test.ts`: dropped three priorityAreas-related tests; renamed "default ordering is alphabetical specifics then Uncategorized last" → "alphabetical specifics then Uncategorized last".
- Plan + review docs revised to remove all priorityAreas references; alternatives section now documents both the cross-cutting hardcoding and the priorityAreas configurable as rejected.

Test results: `pnpm --filter codev-vscode test` → 90 pass.

Sibling PIR #818 (builders-tree grouping) is still in plan phase. The same simpler design applies there; the architect will flag this when their plan lands so both views ship byte-identical.

## 2026-05-27 — re-run CMAP after architect reconsideration

Iter-2 verdicts (Codex failed first attempt on transient DNS; retried successfully):
- Gemini: APPROVE
- Codex: REQUEST_CHANGES — flagged unresolved `(+TBD / -TBD)` placeholders in the review's Files Changed section and a `<sha>` placeholder in the commit list. Real finding (I left placeholders when rewriting the review for the priorityAreas removal). Fixed in `2ced3f9d`: filled in real diff stats from `git diff --stat origin/main...HEAD` and the final commit sha. PR body re-synced via `gh pr edit`.
- Claude: APPROVE

Architect re-notified with REQUEST_CHANGES disposition (single-pass — no automatic re-review).
