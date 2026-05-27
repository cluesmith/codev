# PIR-818: Group Builders Tree by Area

## 2026-05-27 — plan phase

Drafted `codev/plans/818-vscode-group-builders-in-the-t.md`.

Key reconciliation point with the merged #819: the wire is `OverviewBuilder.area: string` (single, projected via `parseArea` — first-alphabetical-area wins), **not** the `areas: string[]` shape the original #818 description assumed. Consequences captured in the plan:

- Each builder lives in exactly one area at the parser level → grouping is a simple `groupBy(b.area)`.
- The original `cross-cutting` *resolution-time privilege* is gone (per #819's final design — parser is policy-free). Honoured the *intent* at the **group-ordering** layer instead: when a `cross-cutting` group exists because at least one builder projects to it, its header sorts first. Documented as a deliberate inheritance from #819, flagged in Risks for review.
- "Render only non-empty groups" chosen as default (issue mock shows `Uncategorized (0)` as a teaching aid; treating that literally would be UI noise). Flagged for review override.

Sharing extracted to `@cluesmith/codev-core`: a `sortAreaGroups(areas: string[])` helper so the same ordering rule is byte-shared with #811 (backlog) when it lands — not just byte-described.

Awaiting plan-approval gate review.

## 2026-05-27 — plan revised after architect directive

Architect updated the issue body and directed a rebase on main to pick up #886 (#811's merged backlog grouping). Rebased cleanly. Read the revised body + the merged `views/backlog.ts` / `views/backlog-tree-item.ts` / `test/backlog.test.ts`.

Rewrote the plan to mirror #886's actually-shipped shape exactly:

- Dropped the `codev.buildersGroupByArea` config flag and the paired enable/disable toggle commands entirely (backlog has no toggle either).
- Dropped the `sortAreaGroups` core extraction (#886 inlined the sort in `groupBacklogByArea`; matching that).
- Dropped any privilege for `cross-cutting` (framework-neutrality discipline; pure alphabetical with `Uncategorized` last).
- Added the single-`Uncategorized` flatten optimization (`backlog.ts:124-126`) so unlabeled repos see zero visual regression.
- Added per-group expand/collapse persistence via `workspaceState` under `codev.buildersGroupExpansion` (paired with backlog's `codev.backlogGroupExpansion`).
- Constructor widened to accept `workspaceState: vscode.Memento`; `onDidExpand/CollapseElement` wired in `extension.ts` immediately after `buildersView` creation, mirroring lines 261-271.

Only structural divergence from backlog: the accordion's `reveal()` requires a real `getParent` chain in grouping mode. Solved with a `Map<builderId, BuilderGroupTreeItem>` populated by `rootChildren()` (empty in single-Uncategorized flatten mode, so accordion semantics are unchanged on that branch).

Wire-field note: revised issue body says `OverviewBuilder.areas[]` (plural) but #886 reads `item.area` (single). Plan mirrors the shipped reality, with a sentence flagging the discrepancy in case the architect wants to roll the wire shape forward to plural — that'd be a separate change against #819 anyway.
