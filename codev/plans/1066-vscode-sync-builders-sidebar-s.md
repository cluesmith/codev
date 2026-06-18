# PIR Plan: Sync Builders sidebar selection with the active builder-diff file

## Understanding

When reviewing a builder's diff, the file shown in the diff editor and the row
*highlighted* in the Builders sidebar can drift apart. Three entry points move the
diff editor without moving the sidebar selection:

1. **Keyboard navigation** (#1060): `codev.diffNextFile` / `codev.diffPreviousFile`
   (Ctrl+Alt+] / Ctrl+Alt+[) open the next/previous file's per-file diff, but the
   tree keeps the last-clicked row highlighted.
2. **Clicking a file inside the multi-file View Diff editor** — the editor scrolls
   to that file; the sidebar selection doesn't follow.
3. **The per-file diff opened from a sidebar click** — selection is correct only
   because the click set it, not because anything syncs it.

The desired mechanic mirrors VSCode's Explorer *Reveal active file* /
`explorer.autoReveal`: a single `onDidChangeActiveTextEditor` listener that, when
the active editor is a tracked builder-diff file, locates the matching row and
`buildersView.reveal(item, { select: true, expand: true })`.

The feature is its own issue (not part of #1060) because revealing a *file* row
needs groundwork the navigation feature stayed out of. Verified against the code:

- **`getParent` is builder-row-only today** (`views/builders.ts:154-159`): it
  returns the cached group for a `BuilderTreeItem` and `undefined` for everything
  else, including `BuilderFileTreeItem` / `BuilderFolderTreeItem`. `reveal` needs
  the full parent chain (file → folder(s) in tree mode → builder → group).
- **File rows have no stable `id`** (`views/builder-file-tree-item.ts:78-108` sets
  `resourceUri`, `contextValue`, `command` — no `id`). `reveal` matches recreated
  elements by `id`; folder rows already have one
  (`views/builder-folder-tree-item.ts:23`: `<builderId>::folder::<fullPath>`), but
  file rows don't.
- **Accordion id-versioning (#913)**: builder-row ids churn via `AccordionRowIds`
  (`views/builders.ts:236-289,398-417`). The reconstructed parent chain must use
  the *current* versioned id (`rowIds.idFor(b.id)`) so `reveal` matches what
  `getChildren` renders.
- **Tree-mode folder hierarchy**: in file-tree view mode a file's parent is a
  (compacted) folder row from `buildFilePathTree` (`views/file-path-tree.ts`);
  `getParent` must reconstruct that hierarchy.

The resolver already exists: the diff-inject registry
(`diff-inject-codelens.ts:161` `getDiffInjectEntry(fsPath)`) maps the right-side
worktree fsPath to `{ builderId, relPath, hunks }`, and is populated by both the
multi-file View Diff (`setDiffInjectSession`) and the per-file diff (`upsert` via
`openBuilderFileDiff`). `buildersView` is created with `createTreeView`
(`extension.ts:376`), so `reveal()` is available. The accordion already proves
`reveal(item, { expand: true })` fires `onDidExpandElement` and is handled
(`extension.ts:763-776` `openBuilderRow`).

## Proposed Change

Four coordinated pieces. One listener covers all three entry points.

### 1. Stable id on file rows

In `BuilderFileTreeItem` (`views/builder-file-tree-item.ts`), set
`this.id = \`${builderId}::${rel}\`` in the constructor. This is unique per
(builder, file), distinct from folder ids (`<builderId>::folder::<...>` — the
`folder::` infix prevents collision) and builder-row ids (`<builderId>#<version>`).
`reveal` locates the rendered row by matching this id against what `getChildren`
produces; since `getChildren` constructs `BuilderFileTreeItem` with the same
fields, the ids match.

### 2. Extend `getParent` to file + folder rows

In `BuildersProvider.getParent` (`views/builders.ts:154`):

- `BuilderTreeItem` → unchanged (group from `groupParentByBuilderId`, or undefined
  in the flatten case).
- `BuilderFileTreeItem` / `BuilderFolderTreeItem` → delegate to a new
  `parentForFileNode(element)` that reconstructs the chain:
  - Resolve the builder + `worktreePath` from the overview cache.
  - **Flat-list mode** (`!viewAsTree()`): a file's parent is the builder row
    directly → return `makeBuilderRow(builder, Date.now())` (carries the current
    accordion-versioned id).
  - **Tree mode**: rebuild `buildFilePathTree(result.files)` from the cached diff,
    find the node whose `fullPath` equals the element's path (file →
    `plan.resourcePath`; folder → `node.fullPath`), and return its parent:
    - parent is another folder → `new BuilderFolderTreeItem(...)` (matching id), or
    - parent is top-level → the builder row.

`getParent` may return a `Thenable` (VSCode's `ProviderResult`), so the async
`diffCache.getDiff` (15s-TTL cached — the same data the rows were built from) is
fine. VSCode calls `getParent` once per ancestor level during a reveal; each call
is a cache hit plus a cheap pure tree rebuild. A small recursive helper
`findParentNode(nodes, targetPath)` walks the compacted tree to return the parent
`FilePathNode` (or undefined for top-level).

### 3. `findFileItem(builderId, relPath)` on the provider

A public async method that constructs the `BuilderFileTreeItem` to hand to
`reveal`: resolve the builder, `getDiff`, find the matching `BuilderFileChange`,
and return `new BuilderFileTreeItem(builderId, worktreePath, baseRef, change, plan)`
(or `undefined` if the builder/file is gone). Its id matches the rendered row, so
`reveal` + the new `getParent` chain locate and highlight it.

### 4. The sync listener + opt-out setting

In `extension.ts`, register one `onDidChangeActiveTextEditor` listener (near the
other Builders wiring, ~line 477):

```ts
const readAutoReveal = () =>
  vscode.workspace.getConfiguration('codev').get<boolean>('buildersAutoReveal', true);
context.subscriptions.push(
  vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (!readAutoReveal()) { return; }
    const fsPath = editor?.document.uri.fsPath;
    if (!fsPath) { return; }
    const entry = getDiffInjectEntry(fsPath);          // tracked builder-diff file?
    if (!entry) { return; }                            // no hijack for other editors
    const item = await buildersProvider.findFileItem(entry.builderId, entry.relPath);
    if (!item) { return; }
    try {
      await buildersView!.reveal(item, { select: true, expand: true, focus: false });
    } catch { /* benign: row gone mid-cleanup */ }
  }),
);
```

`focus: false` keeps focus in the diff editor (we never yank focus to the tree on
an editor change). The `getDiffInjectEntry` gate is the no-hijack guarantee:
non-builder editors and the diff's left/base side (`codev-diff:` scheme, not in the
registry) resolve to `undefined` → no reveal.

Add a dedicated `codev.buildersAutoReveal` boolean setting (default `true`) in
`package.json`, mirroring the existing `codev.builders*` family
(`buildersAutoCollapse`, `buildersFileViewAsTree`):

```json
"codev.buildersAutoReveal": {
  "type": "boolean",
  "default": true,
  "description": "Builders view: reveal and select the active builder-diff file's row in the tree when the diff editor changes (keyboard navigation, multi-file View Diff click, or per-file diff). Mirror of the Explorer's auto-reveal."
}
```

## Files to Change

- `packages/vscode/src/views/builder-file-tree-item.ts` — add stable
  `this.id = \`${builderId}::${rel}\`` in the constructor.
- `packages/vscode/src/views/builders.ts` — extend `getParent` (file/folder rows);
  add private `parentForFileNode` + a pure `findParentNode` tree-walk helper; add
  public async `findFileItem`. Reuse `makeBuilderRow`, `buildFilePathTree`,
  `viewAsTree`, `diffCache.getDiff`.
- `packages/vscode/src/extension.ts` — register the
  `onDidChangeActiveTextEditor` reveal listener with the `buildersAutoReveal` gate
  (near the accordion wiring, ~line 477). Import `getDiffInjectEntry` (already
  imported for `forwardSelectionToBuilder`).
- `packages/vscode/package.json` — add the `codev.buildersAutoReveal` setting.
- Tests:
  - `packages/vscode/src/__tests__/builders-autoreveal.test.ts` (new) — pure-helper
    coverage for `findParentNode` (top-level file/folder, nested, compacted chain,
    not-found) and the file-row id format, following the `vscode`-mock pattern in
    `builders-accordion.test.ts`.
  - Extend `builder-file-tree-item.test.ts` to assert the new `id`.

## Risks & Alternatives Considered

- **Risk: reveal vs accordion refresh race.** Revealing a file expands its builder
  row, which fires `onDidExpandElement` → `collapseBuildersExcept` → a tree
  `changeEmitter.fire()` mid-reveal. This is the *same* path `openBuilderRow`
  already exercises, and the `AccordionGate` re-fire guard prevents loops. Mitigation:
  exercise every mode at the dev-approval gate; if a flicker appears, gate the
  reveal-triggered expansion. (AC: "plays nicely with the accordion.")
- **Risk: rapid keyboard nav fires many reveals.** Each is a diff-cache hit + a
  pure tree rebuild + a `reveal`. The existing context-key listener already runs
  unthrottled on every active-editor change, so this is parity. Debounce is
  available if profiling at the gate shows churn; left out for simplicity.
- **Risk: async `getParent` correctness.** `getParent` must work for *collapsed*
  subtrees (reveal builds the chain up before expanding down), so it reconstructs
  from cached diff data rather than a getChildren-populated map. Verified the cache
  is the same source the rows were built from, so the reconstructed chain matches.
- **Alternative: honor `explorer.autoReveal` instead of a dedicated setting.**
  Rejected — `explorer.autoReveal` is tri-valued (`true | false | "focusNoScroll"`)
  and semantically about the file Explorer; coupling our toggle to it is less
  discoverable and less clear than a `codev.buildersAutoReveal` boolean that sits
  with the rest of the `codev.builders*` family. (Open to reversing this at the
  gate if you'd prefer the native coupling.)
- **Alternative: populate a parent-map in `getChildren`.** Rejected — `getChildren`
  for files only runs for an *expanded* builder, but reveal needs `getParent` for
  collapsed subtrees, so a lazily-populated map would miss.

## Test Plan

Unit (run from the worktree: `pnpm --filter @cluesmith/codev-vscode test`):
- `findParentNode`: top-level file → undefined parent; nested file → innermost
  folder; compacted chain (`packages/codev/src`) → correct compacted parent;
  folder's parent; not-found → undefined.
- `BuilderFileTreeItem.id` equals `<builderId>::<relPath>`.

Manual at the dev-approval gate (the load-bearing review — `afx dev pir-1066` or
Run Dev Server, then open a builder with several changed files):
- **Keyboard nav**: Ctrl+Alt+] / Ctrl+Alt+[ steps the diff; the sidebar selection
  follows each file, expanding the builder (and folders, in tree mode).
- **Multi-file View Diff**: click a file inside the multi-file editor → its row
  highlights in the sidebar.
- **Per-file diff from a sidebar click**: selection stays correct (no regression).
- **Both view modes**: flat list and file-tree (`codev.buildersFileViewAsTree`).
- **Both grouping axes**: stage and area (`codev.buildersGroupBy`) — incl. the
  single-`Uncategorized` flatten case (area mode).
- **No hijack**: focus a normal source file or an unrelated diff → sidebar
  selection unchanged.
- **Accordion**: revealing a file in builder B collapses builder A and keeps B
  expanded, without fighting the collapse-others behavior.
- **Opt-out**: set `codev.buildersAutoReveal: false` → no auto-reveal; existing
  click/accordion/decoration behavior unchanged.
