# PIR Plan: Group Builders Tree by Area (mirror #811)

## Understanding

The VSCode `Codev: Builders` tree (`packages/vscode/src/views/builders.ts:89`) is flat today. The `area/*` label namespace — already projected onto `OverviewBuilder.area` (single string, `'Uncategorized'` default) by #819 — is the right grouping axis. **The exact pattern was shipped in PR #886 (sibling #811) on 2026-05-27** for the Backlog view; this issue applies the same pattern to Builders.

The design has converged to a deliberately simpler shape than #818's original framing:

- **Pure alphabetical group ordering, `Uncategorized` last** — no `cross-cutting` privilege, no priority-areas knob, no configurable preference. Framework-neutrality discipline from #819 (the parser is policy-free; UI ordering matches).
- **No toggle** — grouping is the only mode. Single-`Uncategorized` flatten optimization (below) makes "off" unnecessary for repos that don't use `area/*` labels.
- **Single-`Uncategorized` flatten** — when the only group is `Uncategorized` (no `area/*` labels in the repo at all), render builder rows directly at root with no group header. Zero visual regression for unlabeled repos.
- **Per-area expand/collapse state persists via `workspaceState`** — same key shape as backlog's `codev.backlogGroupExpansion`, here `codev.buildersGroupExpansion`. Default for an untouched area: expanded.

### Wire-field note

Revised #818 still references `OverviewBuilder.areas[]` (plural) in prose, but #886 actually ships against `OverviewBuilder.area: string` (single, projected via `parseArea` — first-alphabetical wins). `views/backlog.ts:37` reads `item.area`. I'll mirror that — `b.area` — so both views consume the same field. If the architect prefers re-introducing the plural shape, that's a wire change against #819, not this view.

## Proposed Change

Mirror PR #886's three pieces in `views/backlog.ts` + `views/backlog-tree-item.ts` + `test/backlog.test.ts` onto the Builders side.

### 1. `groupBuildersByArea` pure helper

In `packages/vscode/src/views/builders.ts`, structurally identical to `groupBacklogByArea` (`views/backlog.ts:32-60`):

```ts
export function groupBuildersByArea(
  builders: OverviewBuilder[],
): Array<{ area: string; builders: OverviewBuilder[] }> {
  const buckets = new Map<string, OverviewBuilder[]>();
  for (const b of builders) {
    const bucket = buckets.get(b.area);
    if (bucket) bucket.push(b);
    else buckets.set(b.area, [b]);
  }

  const result: Array<{ area: string; builders: OverviewBuilder[] }> = [];
  const uncategorized = buckets.get(UNCATEGORIZED_AREA);
  const specifics = [...buckets.keys()].filter(a => a !== UNCATEGORIZED_AREA).sort();
  for (const area of specifics) result.push({ area, builders: buckets.get(area)! });
  if (uncategorized) result.push({ area: UNCATEGORIZED_AREA, builders: uncategorized });
  return result;
}
```

Pure, VSCode-free, unit-testable. Caller passes builders in display order (i.e. `orderForDisplay()` output) so within-group order is preserved by Map insertion.

### 2. `BuilderGroupTreeItem` class

In `packages/vscode/src/views/builder-tree-item.ts` (alongside `BuilderTreeItem`), structurally identical to `BacklogGroupTreeItem` (`views/backlog-tree-item.ts:36-46`):

```ts
export class BuilderGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly areaName: string,
    count: number,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(`${areaName} (${count})`, collapsibleState);
    this.id = `builder-group:${areaName}`;
    this.contextValue = 'builder-group';
  }
}
```

Stable `id` keyed off area name → VSCode reuses TreeItem identity across `OverviewCache` ticks → the user's collapse choice survives every refresh. `contextValue = 'builder-group'` lets us hang future per-group context menus off it without retrofitting selectors.

### 3. Two-level `BuildersProvider`

Restructure `BuildersProvider` in `views/builders.ts` to mirror `BacklogProvider`'s shape (`views/backlog.ts:78-188`):

- **Constructor gains a `workspaceState: vscode.Memento` parameter** for persistence. Existing call site (`extension.ts:255`) becomes `new BuildersProvider(overviewCache, builderDiffCache, context.workspaceState)`.
- **`getChildren(element?)`**: branch on element type.
  - `BuilderTreeItem` → file children (unchanged: `fileChildren(builderId)`)
  - `BuilderFolderTreeItem` → folder children (unchanged)
  - `BuilderFileTreeItem` → `[]` (unchanged)
  - `BuilderGroupTreeItem` → builder rows for that area (new — `rowsForGroup(areaName)`)
  - `undefined` (root) → group rows OR flattened builder rows (new — `rootChildren()`)
- **`rootChildren()`**: compute ordered builders once, group via `groupBuildersByArea`, apply single-`Uncategorized` flatten:

  ```ts
  const ordered = orderForDisplay(data.builders, now);
  const groups = groupBuildersByArea(ordered);
  if (groups.length === 1 && groups[0].area === UNCATEGORIZED_AREA) {
    return groups[0].builders.map(b => this.makeBuilderRow(b, now));
  }
  const expansion = this.readExpansionState();
  return groups.map(g => new BuilderGroupTreeItem(g.area, g.builders.length,
    (expansion[g.area] ?? true) ? vscode.TreeItemCollapsibleState.Expanded
                                 : vscode.TreeItemCollapsibleState.Collapsed));
  ```

- **`rowsForGroup(areaName)`**: recompute the same ordered+grouped result and return the matching group's builder rows, each built via the same `makeBuilderRow` helper used by the flatten branch.
- **`makeBuilderRow(b, now)`**: extract today's per-builder rendering (`builders.ts:89-136`) into a single helper so flatten + grouped paths share it byte-for-byte. No behavior change.
- **`setGroupExpanded(areaName, expanded)`**: persistence method, identical to `BacklogProvider.setGroupExpanded` (`views/backlog.ts:107-111`).
- **`readExpansionState()`**: read the `EXPANSION_STATE_KEY = 'codev.buildersGroupExpansion'` map from `workspaceState`, defaulting to `{}`.

### 4. `getParent` for accordion `reveal()`

This is the **one** divergence from backlog: the Builders accordion (`extension.ts:310`) calls `buildersView.reveal(builderItem, { expand: 3 })`. With groups inserted, `reveal` needs a real parent chain — today's `getParent(): undefined` will break the accordion in grouping mode.

Solution: maintain a `Map<builderId, BuilderGroupTreeItem>` populated by `rootChildren()` whenever it returns groups (i.e. multi-group case). `getParent(BuilderTreeItem)` returns the cached group; `getParent` for everything else (and in the single-`Uncategorized` flatten case, where builders are root) returns `undefined`. Clean and minimal.

### 5. Wire `onDidExpand/CollapseElement` in `extension.ts`

Mirror the backlog wiring (`extension.ts:261-271`) immediately after creating `buildersView`:

```ts
context.subscriptions.push(
  buildersView.onDidExpandElement((e) => {
    if (e.element instanceof BuilderGroupTreeItem) {
      buildersProvider.setGroupExpanded(e.element.areaName, true);
    }
  }),
  buildersView.onDidCollapseElement((e) => {
    if (e.element instanceof BuilderGroupTreeItem) {
      buildersProvider.setGroupExpanded(e.element.areaName, false);
    }
  }),
);
```

Existing `buildersView.onDidExpandElement` accordion handler (line 297) is untouched — its `instanceof BuilderTreeItem` guard already ignores group rows.

### 6. Tests

`packages/vscode/src/test/builders.test.ts` gains a `suite('groupBuildersByArea')` mirroring `suite('groupBacklogByArea')` from `test/backlog.test.ts:43-100`. Same test cases adapted to the builders shape:

- empty in → empty out
- single Uncategorized builder → one Uncategorized group
- alphabetical specifics then Uncategorized last
- omits empty area groups (no `<area> (0)` headers)
- preserves input order within a group (no internal re-sort) — this is the within-group `orderForDisplay()` preservation
- groups multiple builders per area correctly

### 7. Out of scope (preserve issue's contract)

- Configurable priority-areas mechanism
- Hardcoded `area/cross-cutting` or any area-name privilege
- Toggle to disable grouping
- Grouping by `type:*` / `priority:*` / any non-area axis
- Duplicating a builder under multiple area groups (single primary area derived from `parseArea`)
- Per-builder user-pickable primary area override
- Dashboard equivalent (no existing dashboard consumer of `builder.area` — separate change)

## Files to Change

- `packages/vscode/src/views/builders.ts` — add `groupBuildersByArea` pure helper; restructure `BuildersProvider` into two-level form with `rootChildren` / `rowsForGroup` / `makeBuilderRow` / `setGroupExpanded` / `readExpansionState` (mirror `BacklogProvider`); add `getParent` with group-cache map; widen constructor to accept `workspaceState: vscode.Memento`; import `UNCATEGORIZED_AREA` from `@cluesmith/codev-core/constants`.
- `packages/vscode/src/views/builder-tree-item.ts` — add `BuilderGroupTreeItem` class (mirror `BacklogGroupTreeItem` in `backlog-tree-item.ts:36-46`).
- `packages/vscode/src/extension.ts:255` — update `new BuildersProvider(...)` call to pass `context.workspaceState`; add `buildersView.onDidExpand/CollapseElement` subscriptions that call `buildersProvider.setGroupExpanded` for `BuilderGroupTreeItem` (mirror lines 261-271); import `BuilderGroupTreeItem`.
- `packages/vscode/src/test/builders.test.ts` — add `suite('groupBuildersByArea')` with the six test cases mirrored from `backlog.test.ts`.
- **No changes** to `packages/core/`, `packages/types/`, `packages/codev/`, `packages/vscode/package.json`. No new settings, no new commands, no new menu entries.

## Risks & Alternatives Considered

### Risks

- **Accordion `reveal()` regression in grouping mode** — addressed by the `getParent` + `Map<builderId, BuilderGroupTreeItem>` mechanism. Validated manually at the `dev-approval` gate (expand a builder; verify others auto-collapse across groups).
- **`workspaceState` key collision** — `codev.buildersGroupExpansion` is namespaced under `codev.` and is distinct from `codev.backlogGroupExpansion`. No collision.
- **Single-`Uncategorized` flatten makes `getParent` semantics differ between modes** — handled: the group cache is empty in flatten mode, so `getParent(builderItem)` returns `undefined` (today's behavior); accordion works unchanged.
- **`orderForDisplay()` only runs once** — root render computes `ordered` then groups it; `rowsForGroup` recomputes the same pipeline so within-group order matches. Slightly wasteful (two `orderForDisplay` calls per refresh) but matches the backlog's `orderedSpawnable` pattern (`backlog.ts:113-147`) — caching across calls would diverge from the reference.

### Alternatives Considered

- **Keep the toggle from v1 of this plan.** Rejected per architect's revised directive: #886 didn't ship one and the design discipline is "no configurable knob unless there's a real demand".
- **Extract `groupByArea` to `@cluesmith/codev-core` as a shared helper.** Rejected to match #886's actually-shipped shape exactly — backlog inlined its helper in `views/backlog.ts`, so builders does the same. If/when a third consumer needs it (dashboard), extraction is a one-line refactor.
- **Use `OverviewBuilder.areas[]` (plural) as the issue body still suggests.** Rejected — `#886` ships against the single `.area` projection from `parseArea`. Wire alignment matters more than copying the issue's prose verbatim.

## Test Plan

### Unit (CI + local `pnpm test --filter @cluesmith/codev-vscode`)

Six tests in `suite('groupBuildersByArea')`:

1. empty in → empty out
2. single Uncategorized builder → one `Uncategorized` group
3. mixed inputs → alphabetical specifics then `Uncategorized` last
4. omits empty area groups (no `<area> (0)` headers)
5. preserves input order within a group (no internal re-sort) — confirms within-group ordering relies on caller-supplied order (i.e. `orderForDisplay()` semantics flow through unchanged)
6. groups multiple builders per area correctly

### Manual (`dev-approval` gate)

Reviewer runs `afx dev pir-818` and exercises in the running VSCode instance:

- **Side-by-side with backlog**: open the Codev sidebar; verify Builders renders with the same group-header style as Backlog (`<area> (count)`, alphabetical, `Uncategorized` last).
- **Within-group ordering**: ensure a blocked builder still sorts above active builders within its area group (preserves `orderForDisplay()`).
- **Accordion in grouping mode**: with `codev.buildersAutoCollapse` on (default), expand a builder's changed-files diff. Verify other builders auto-collapse — across groups too, not just within the same group.
- **Per-group expand/collapse persistence**: collapse one group. Reload the window. Verify the group is still collapsed. Expand it; reload; verify expanded.
- **Single-Uncategorized flatten**: hard to reproduce naturally on this repo (every issue is labelled), but verifiable by temporarily removing all `area/*` labels from open builders' issues (or, for the reviewer, by reading the test case and accepting the unit coverage).
- **Reactivity**: add or remove an `area/*` label on a builder's underlying issue via `gh issue edit`. Wait for the next `OverviewCache` SSE tick (≤60s) and confirm the builder migrates between groups.
- **Comparison with Backlog**: switch between the two views and confirm the rule "feels identical" — same alphabetical order, same Uncategorized-last placement, same per-area collapse persistence behaviour.

### Cross-platform

N/A — VSCode-only change, runs identically across OSes.
