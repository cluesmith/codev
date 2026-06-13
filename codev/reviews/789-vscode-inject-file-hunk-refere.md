# PIR Review: Forward file/symbol/hunk/selection references into the builder PTY (CodeLens)

Fixes #789

## Summary

Adds a one-click way to forward a code reference from a builder's diff into that builder's terminal prompt — no path retyping. In a builder file diff (or a normal editor tab on a builder worktree file) a `Forward to Builder` CodeLens appears at the file top, above each declaration (function/class/interface/enum/struct/namespace/method/constructor + multi-line top-level const), and above each changed hunk; clicking injects `<path>` or `<path>:L<start>-L<end>` into the builder's prompt **without** pressing Enter, mirroring the existing architect-reference pattern. A right-click **"Codev: Forward Selection to Builder"** (and `Cmd/Ctrl+K B`) forwards any selected range, and works inside the multi-file View Diff editor too.

The issue's original mechanism (CodeLens on hunks in the `codev.viewDiff` editor) proved unworkable and the design pivoted during the `dev-approval` gate — see Lessons Learned. The implementation that shipped is symbol-driven (granularity follows the code, so new files are as forwardable as modified ones), with per-hunk lenses layered on, plus the selection action as the path that survives in the multi-file editor.

## Files Changed

- `packages/vscode/src/diff-inject-ref.ts` (+247 / new) — pure helpers: symbol selection (`buildSymbolLensDescriptors`), changed-run parsing (`parseHunkRanges`/`parseUnifiedDiff`), `buildAllLensDescriptors` (symbol + hunk lenses, deduped by anchor line), ref builders.
- `packages/vscode/src/diff-inject-codelens.ts` (+156 / new) — `CodeLensProvider` over a per-diff registry; resolves document symbols; backs the `codev.activeEditorIsBuilderFile` context key.
- `packages/vscode/src/ensure-diff-codelens.ts` (+38 / new) — one-click prompt to enable `diffEditor.codeLens` (Global scope) when off.
- `packages/vscode/src/commands/view-diff.ts` (+79 / -…) — populate the registry on `viewDiff` and the per-file diff; open the editor before computing hunks.
- `packages/vscode/src/terminal-manager.ts` (+32) — `injectBuilderText`; `openBuilderByRoleOrId` returns the resolved canonical id.
- `packages/vscode/src/extension.ts` (+62) — register `codev.forwardToBuilder` (palette-hidden) and `codev.forwardSelectionToBuilder`; activate the provider.
- `packages/vscode/package.json` (+21) — selection command + `editor/context` menu + `Cmd/Ctrl+K B` keybinding (all scoped + palette-hidden).
- `packages/vscode/src/__tests__/diff-inject-ref.test.ts` (+181 / new) — unit tests for the pure helpers.

## Commits

Full list via `git log main..HEAD --oneline` (26 feature commits). Highlights:

- `7ee8068a` Add diff-inject ref helpers + CodeLens provider
- `4c6af3ee` terminal-manager: injectBuilderText + resolved-id return
- `fecb9658` Option A: lenses on per-file diff + diffEditor.codeLens prompt
- `9984f8c4` Drive lenses off document symbols, not git hunks
- `75c03eb5` Right-click "Forward Selection to Builder" editor/context action
- `aea085f4` Restore per-hunk lenses alongside symbol lenses (option B)
- `a9bbb478` One change-lens per contiguous changed run, not per git hunk
- `29f04083` Open diffs before computing hunks (fix open-delay regression)
- `a93d6ac5` Remove symbol cache (misdiagnosed; risked pinning empty symbols)
- `aa96ba8f` Enable diffEditor.codeLens at Global scope

## Test Results

- `pnpm --filter codev-vscode check-types`: ✓ pass
- `pnpm --filter codev-vscode lint`: ✓ pass
- `pnpm --filter codev-vscode test:unit`: ✓ pass (375 tests, ~20 new for symbol selection / changed-run parsing / lens building)
- `node esbuild.js` bundle: ✓
- Manual (human, at `dev-approval` in the Extension Dev Host): file/symbol/hunk lenses render in per-file diff and normal tabs with `diffEditor.codeLens` on; clicking injects the ref into the builder terminal without Enter; right-click "Forward Selection to Builder" + `Cmd+K B` forward a selection (incl. in the multi-file View Diff editor); new-file lenses carry line ranges; the enable-prompt writes the setting.

## Architecture Updates

No `arch.md` changes needed — this is a self-contained VSCode UI feature (a CodeLens provider + two commands + terminal injection) that doesn't alter module boundaries or introduce a cross-cutting pattern. The durable platform constraints it surfaced are captured in `lessons-learned.md` instead (see below).

## Lessons Learned Updates

Added one entry to `codev/resources/lessons-learned.md` (UI/UX): CodeLens does **not** render in VSCode's multi-file `vscode.changes` editor, and is hidden by default in single diff editors (`diffEditor.codeLens`) — the constraint that forced this feature's whole design pivot. The full design-process lesson (symbol- vs hunk-driven granularity, and surfacing the multi-file-editor limit early) is recorded in this review.

## Things to Look At During PR Review

- **`buildAllLensDescriptors` dedup** (`diff-inject-ref.ts`): a hunk lens is suppressed when its anchor line already has a symbol/file lens, so declaration-line changes show the structural lens and body changes show the hunk lens — no stacking. Worth a careful read.
- **`parseHunkRanges`** now emits one range per *contiguous changed run* (broken by context lines; deletions don't break a run), not per git hunk — this is what makes adjacent edits get individual lenses.
- **Surface limits**: symbol/hunk CodeLenses live in per-file diff + normal tabs (CodeLens is suppressed in the multi-file `vscode.changes` editor); the selection context-menu is the path that works in the multi-file editor. This is a VSCode constraint, not a bug.
- **No 3-way consult iteration** (PIR single-pass): if the consult flags anything, it's addressed/rebutted here, not re-reviewed.

### Consultation outcome (PR-creation, single advisory pass)

- **Claude: APPROVE** (HIGH) — no issues.
- **Codex: REQUEST_CHANGES** (HIGH) — **real defect, fixed.** The `codev.activeEditorIsBuilderFile` context key (gating the right-click "Forward Selection to Builder" + `Cmd/Ctrl+K B`) was synced only on `onDidChangeActiveTextEditor`. Because `openBuilderFileDiff` opens the diff (making it active) *before* registering its file, the key was left `false` on the just-opened diff until focus changed, so the selection entry point was dead. **Fix** (`diff-inject-codelens.ts`): re-sync the key on every registry change by subscribing to the provider's `onDidChangeCodeLenses` (fired by `setSession`/`upsert`). **Regression test**: `src/__tests__/diff-inject-context-key.test.ts` asserts the key flips `true` after the active file is registered (and back to `false` when a new session drops it) — it fails without the re-sync. Since PIR is single-pass, this fix was **not** independently re-reviewed; flagging for human verification at the `pr` gate.
- **Gemini: skipped** — the agy/Gemini path returned "the current workspace is empty" on both attempts (it didn't ingest the diff). Best-effort per the consult design; no verdict.

## How to Test Locally

This is a VSCode **extension** change, so `afx dev` won't exercise it — load the extension:

- **Extension Dev Host**: open `packages/vscode` (or the repo) and press **F5** ("Run Codev Extension").
- Ensure `diffEditor.codeLens` is on (the feature prompts to enable it on first file-diff open).
- Builders tree → click a changed file → confirm `Forward to Builder` lenses (file, symbols, hunks); click one → the builder terminal focuses and the ref is typed with no Enter.
- Select lines → right-click **Codev: Forward Selection to Builder** (or `Cmd/Ctrl+K B`); confirm it works in the multi-file **View Diff** editor too.
- Verify `codev.forwardToBuilder` / `codev.forwardSelectionToBuilder` are absent from the Command Palette.

## Related

- #1022 — workspace `files.watcherExclude`/`search.exclude` for `.builders/` + `node_modules`, and dropping the Extension Test Runner recommendation (a CPU storm discovered while reviewing this feature; not part of this change).
