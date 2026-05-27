# PIR Plan: vscode — group backlog tree by area

## Understanding

The vscode Backlog tree (`packages/vscode/src/views/backlog.ts:27`) renders open GitHub issues as a flat list. As the repo grows, scanning the list mixes work across every product surface with no axis that mirrors how engineers coordinate. Issue #811 asks for two-level grouping by the `area/*` label namespace established by #819.

The wire already carries everything we need: `OverviewBacklogItem.area: string` (required, never `undefined`) was added by #819, projected server-side via `parseArea(issue.labels)`. The parser returns the first-alphabetical `area/*` value (with the `area/` prefix stripped), or the literal `'Uncategorized'` when no `area/*` labels are present. **The parser is policy-free** — it does NOT privilege `area/cross-cutting` (see #819's regression-guard test at `packages/codev/src/__tests__/github.test.ts:333-341`). That policy decision lives in the consumer.

This PIR matches the parser's policy-free posture in the view: alphabetical specific areas, `Uncategorized` always last, no privileged label names. Coordination of overlapping work is a separate concern from group rank — the grouping itself surfaces the per-area picture engineers need.

## Proposed Change

Convert `BacklogProvider` from a flat `TreeDataProvider<TreeItem>` into a two-level provider:

- **Root level** (`getChildren()` with no element) → one `BacklogGroupTreeItem` per non-empty area group, ordered: alphabetical specific areas → `Uncategorized`. Label format: `<area> (<count>)`.
- **Group level** (`getChildren(groupItem)`) → the existing `BacklogTreeItem` rows for that group, in the same intra-group order the flat view uses today (mine-first then rest, both preserving the server's order).

Single-`Uncategorized` collapses to flat rendering: when the grouped output is exactly one group AND that group is `Uncategorized`, the view skips the header and returns rows directly. This is the zero-cost migration property for repos that haven't adopted `area/*` labels yet.

Add a pure helper `groupBacklogByArea(items)` (in `views/backlog.ts`) that takes `OverviewBacklogItem[]` and returns an ordered array of `{ area, items }`. Pure-functional, no VSCode dependency → unit-testable.

Group expansion state persists per area name via `vscode.Memento` (`context.workspaceState`). Default: all groups expanded. The provider reads the persisted map on each `getChildren()` root call and writes back via `onDidExpandElement` / `onDidCollapseElement` on the `TreeView`.

The Mine/All toggle (#809) is orthogonal — when it ships, its filter applies before `groupBacklogByArea` and groups are recomputed automatically.

## Files to Change

- `packages/vscode/src/views/backlog.ts` — refactor `BacklogProvider.getChildren()` to dispatch on element type; add `groupBacklogByArea(items)` exported helper (alphabetical specific areas, `Uncategorized` last, empty groups omitted). Constructor takes `vscode.Memento` for expansion-state persistence. Existing `spawnableBacklog` helper unchanged.
- `packages/vscode/src/views/backlog-tree-item.ts` — add `BacklogGroupTreeItem` class. Holds `areaName: string`, `count: number`, `contextValue: 'backlog-group'`. Stable `id` (`backlog-group:<areaName>`) so VSCode preserves item identity across SSE-driven `onDidChangeTreeData` refreshes.
- `packages/vscode/src/extension.ts:258` — pass `context.workspaceState` to `BacklogProvider` constructor. Wire `backlogView.onDidExpandElement` / `onDidCollapseElement` to write expansion state back when the user expands/collapses a group (gated on `element instanceof BacklogGroupTreeItem`).
- `packages/vscode/src/test/backlog.test.ts` — new test suite for `groupBacklogByArea`:
  - empty input → empty output
  - single `Uncategorized` item → single `Uncategorized` group
  - mixed: alphabetical specifics, `Uncategorized` last
  - within-group order preserves input order
  - empty area groups are omitted (no `<area> (0)` headers)
  - multiple items per area grouped correctly

## Risks & Alternatives Considered

- **Risk: backlog count badge desync.** `extension.ts:165` recomputes the view title `Backlog (N)` from `spawnableBacklog(data.backlog).length`. Grouping doesn't change that count — the same items are visible, just nested. No change needed.

- **Risk: reveal / select-by-id consumers.** If anything in the codebase calls `backlogView.reveal(item)`, the new two-level tree requires `getParent()` on the provider. Mitigation: grep first; today no consumer calls reveal on the backlog tree. If a future consumer needs it, add `getParent()` then.

- **Alternative: privilege a specific area (e.g. `cross-cutting`) at the top.** Rejected — #819 deliberately chose framework-neutral parsing. Same posture applies to the view: alphabetical specifics + `Uncategorized` last is the simplest rule that doesn't bake repo-specific conventions into the framework. Coordination of overlapping work is a separate concern from group rank.

- **Alternative: per-repo `priorityAreas` configurable for pinning specific areas to the top.** Considered and tried during the implement phase; the architect later requested it be removed. Rationale: solving a problem we don't actually have, and a configurable shape conflates coordination with rank. Pure alphabetical is the cleaner answer.

- **Alternative: toggle to disable grouping.** Issue §6 (`### 6. No toggle`) explicitly rejects this — grouping is the default, and repos without `area/*` labels see everything under `Uncategorized` (functionally identical to today, then flattened away by the single-Uncategorized optimization). No per-repo opt-out needed.

## Test Plan

### Unit tests (`packages/vscode/src/test/backlog.test.ts`)

Add a `suite('groupBacklogByArea', ...)` covering:

- Empty input → empty array.
- Single uncategorized item → one group with key `'Uncategorized'`, count 1.
- Mixed: `auth`, `tower`, `Uncategorized` → order is `['auth', 'tower', 'Uncategorized']`.
- Two specific areas → alphabetical, no `Uncategorized` header rendered when no uncategorized items exist.
- Within-group order preserves input order (do not re-sort items).
- Empty groups are omitted (no `(0)` headers).

### Manual verification at `dev-approval` gate

Reviewer launches `afx dev pir-811` and inspects the VSCode sidebar:

1. **Default rendering**: Backlog view shows headers like `vscode (20)`, `tower (4)`, etc. Headers ordered alphabetically, `Uncategorized` last.
2. **Uncategorized fallback**: any issue with no `area/*` labels → confirm it's under `Uncategorized` (last position).
3. **Click → view**: clicking a row still opens the issue via `codev.viewBacklogIssue`. Right-click → context-menu actions (spawn, open in browser, copy issue number) all still work.
4. **Expansion persistence**: collapse a group, reload the VSCode window → that group stays collapsed.
5. **No regression on dashboard**: open the web dashboard's Backlog view (`packages/dashboard/src/components/BacklogList.tsx`) → still renders as a flat list (no wire changes, no breakage).
6. **No-area repo**: on a hypothetical repo with no `area/*` labels at all, single-Uncategorized flattens away — view renders flat rows with no header.
