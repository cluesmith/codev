# PIR Review: Keyboard shortcut to forward the symbol/hunk under the cursor to the builder

Fixes #1073

## Summary

Adds `codev.forwardCursorContextToBuilder` (bound to `Cmd/Ctrl+K H`), the keyboard
equivalent of clicking a "Forward to Builder" codelens in the builder-diff editor.
Pressing the key resolves the cursor's current line to the most specific enclosing
symbol (first), else the containing changed hunk, else the bare file path, and
injects that reference into the builder PTY with no Enter — closing the gap where
every granular forward surface was mouse-only (`Cmd/Ctrl+K B` required a text
selection first; codelens has no keyboard activator in VS Code).

## Files Changed

- `apps/vscode/src/diff-inject-ref.ts` (+48 / -0) — new `CursorRef` type + pure
  `resolveCursorRef(relPath, symbols, hunks, cursorLine)` implementing the
  symbol → hunk → file resolution order.
- `apps/vscode/src/diff-inject-codelens.ts` (+4 / -1) — export the `toSymbolNode`
  mapper (was private) so the command handler reuses it.
- `apps/vscode/src/extension.ts` (+28 / -2) — register the new command (thin
  handler: fetch live document symbols, call `resolveCursorRef`, reuse the shared
  `codev.forwardToBuilder` inject path, status-bar note on the file fallback).
- `apps/vscode/package.json` (+10 / -0) — command declaration + `Cmd/Ctrl+K H`
  keybinding (`when: codev.activeEditorIsBuilderFile && editorTextFocus`).
- `apps/vscode/src/__tests__/diff-inject-ref.test.ts` (+70 / -0) — 7 unit tests
  covering the resolution order.

## Commits

- `6b1a07b4a` [PIR #1073] Add forwardCursorContextToBuilder command + Cmd/Ctrl+K H binding
- `ea5c541ad` [PIR #1073] Unit tests for resolveCursorRef resolution order
- `35cbc3090` [PIR #1073] Thread log: implement phase

## Test Results

- `pnpm check-types`: ✓ pass
- `pnpm lint`: ✓ pass
- `pnpm test:unit`: ✓ pass (819 tests, 68 files; 7 new)
- Manual verification: approved by the human at the `dev-approval` gate (cursor
  inside a symbol / in a hunk / on an unchanged line → correct reference injected,
  no Enter, focus retained on the diff editor).

## Architecture Updates

No arch changes. This is an additive VS Code command + keybinding that reuses the
existing diff-inject registry, pure helpers (`diff-inject-ref.ts`), and inject path
(`codev.forwardToBuilder`); it introduces no new module boundary, state, or
cross-cutting invariant. The "VS Code Extension" section of `arch.md` intentionally
does not enumerate every command/keybinding (exhaustive enumeration is explicitly
out of scope for the arch docs), so no entry is warranted.

## Lessons Learned Updates

No lessons captured — the change is small and additive, and the reuse-the-existing-
lens-model decision is already documented inline in `resolveCursorRef`. (The one
gotcha hit during implementation — vitest reports 18 test-file load failures when
the workspace deps `@cluesmith/codev-types` / `@cluesmith/codev-sdk` haven't been
built — is pre-existing build-order behavior, not a durable cross-cutting lesson;
it's flagged under "Things to Look At" for the reviewer's awareness.)

## Things to Look At During PR Review

- **Symbol resolution == codelens click.** `resolveCursorRef` derives its symbol
  candidates from `buildSymbolLensDescriptors` (the exact forwardable-symbol set
  the codelens renders) rather than walking the raw symbol tree, so the keyboard
  lands on the same range a lens click would, and never forwards a scalar const or
  a nested block the lens wouldn't. Among overlapping candidates the smallest span
  wins (a method beats its enclosing class).
- **Resolution order is symbol-first.** When both a symbol and a hunk cover the
  cursor, the symbol wins (verified by a dedicated test). Hunk is a fallback for
  brand-new files / top-level edits / languages without a symbol provider.
- **Existing sibling commands left untouched.** There were already two palette-only,
  unbound commands — `forwardCurrentHunkToBuilder` (hunk-only) and
  `forwardCurrentFileToBuilder` (file-only). This change adds a *new* unified
  command rather than binding those, because neither does the symbol step or the
  file fallback the issue requires. If consolidating/removing the older two is
  desired, that's a separate follow-up.
- **Path drift note:** the issue references `packages/vscode/...`; the code now
  lives under `apps/vscode/...`. All work landed under the real `apps/vscode/` root.
- **Test-suite environment note:** run `pnpm --filter @cluesmith/codev-types
  --filter @cluesmith/codev-sdk build` before `pnpm test:unit`, or ~18 unrelated
  test files fail to load on unbuilt workspace-dep exports. After building deps the
  full suite is green (819 tests).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1073 → **Review Diff**.
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1073`.
- **What to verify**:
  - Cursor inside a function/method body (no selection) → `Cmd/Ctrl+K H` injects
    `path/to/file.ts:L<symbol-start>-L<symbol-end>` matching the symbol's codelens.
  - Cursor in a changed region with no covering symbol → injects the hunk range.
  - Cursor on an unchanged line outside any symbol/hunk → injects the bare file
    path and shows the status-bar note.
  - Focus stays on the diff editor; no picker/modal; no Enter pressed.
  - New-file diff: cursor inside a symbol still forwards its range.
  - Scope: in an unrelated (non-builder) diff/editor, `Cmd/Ctrl+K H` does nothing.
  - Regression: `Cmd/Ctrl+K B` (with a selection) and codelens clicks still work.
