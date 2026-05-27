# bugfix-799 thread

## Investigate

Issue #799: changed-file rows in Builders view render grey instead of SCM colors.

Root cause confirmed from code reading (the issue body already nailed it; verifying touch points):

- `packages/vscode/src/views/builder-file-tree-item.ts:49` sets `resourceUri = vscode.Uri.file(path.join(worktreePath, rel))`.
- `resourceUri.scheme === 'file'` makes the row eligible for VSCode's global decoration providers — including the built-in Git decorator, which sees the path as gitignored (it lives under `.builders/<id>/…`) and tints the label with `gitDecoration.ignoredResourceForeground` (grey).
- Our `BuilderFileDecorationProvider` supplies the `A`/`M`/`D` badge but loses the color tint to Git in the decoration merge.

Only `BuilderFileTreeItem.resourceUri` is ever constructed; nothing else reads `resourceUri` on that class. The `codev.openBuilderFileDiff` handler uses `arg.plan`/`arg.worktreePath`/`arg.baseRef` — not the resourceUri — so changing the scheme doesn't break diff opening. No context-menu entries are wired to scheme === 'file' for `builder-file` rows.

## Plan for fix

Switch the scheme to a custom one (`codev-builder-diff`), so the built-in Git decorator skips the URI. Same `fsPath` (and same basename) ⇒ the file-type icon still resolves.

Touch points:

1. `builder-file-tree-item.ts` — construct the URI via `vscode.Uri.file(...).with({ scheme: BUILDER_FILE_SCHEME })`. Export the helper + scheme so the cache can match.
2. `builder-diff-cache.ts` — `syncDecorations` must fire the `onDidChangeFileDecorations` event with URIs that match what the tree items carry (same scheme), or VSCode won't re-query our provider for those rows. Switch the map keying to `uri.toString()` so lookups are unambiguous across schemes.
3. Add regression test asserting the resourceUri scheme is NOT `file`.

Touch size estimate: ~40 LOC. Well within BUGFIX scope.

## Fix

Implemented:

1. **`packages/vscode/src/views/builder-file-tree-item.ts`** — added `BUILDER_FILE_SCHEME = 'codev-builder-diff'` constant and `builderFileResourceUri(worktreePath, rel)` factory. `BuilderFileTreeItem.resourceUri` now uses the helper. The scheme is intentionally not registered as a TextDocumentContentProvider — these URIs are decoration-only markers; the diff is opened via the existing `codev.openBuilderFileDiff` command which builds explicit left/right URIs (the `codev-diff:` content scheme owned by `commands/view-diff.ts` is unchanged).
2. **`packages/vscode/src/views/builder-diff-cache.ts`** — `syncDecorations` constructs URIs via the same helper so the URI fired through `onDidChangeFileDecorations` matches the one VSCode sees on the tree row (otherwise the cached decoration would go stale on file-list changes). Keying switched from `uri.fsPath` to `uri.toString()` for unambiguous matching across schemes.
3. **`packages/vscode/src/test/builder-file-tree-item.test.ts`** — 5 regression tests: scheme is non-`file`, scheme matches `BUILDER_FILE_SCHEME`, `decorationFor()` returns the recorded status for the helper-built URI, plain `file:` URI of the same path returns `undefined` (proves the scheme separation), and the change-event URI carries the custom scheme.

Diff size: ~70 LOC (incl. tests + comments). Well within BUGFIX scope.

## Verification

- `pnpm exec tsc --noEmit` → clean
- `pnpm lint` → clean
- `pnpm test:unit` (vitest) → 34/34 passing
- `pnpm test` (vscode-test, Electron) → 83/83 passing, includes the 5 new cases

I have not been able to visually verify the rendered tree colors (no VSCode UI session in the worktree). The fix is mechanical and the issue body diagnosed it precisely; a reviewer running the dev build can confirm by spawning a builder and inspecting the Builders view.

