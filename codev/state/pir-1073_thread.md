# Builder pir-1073 — thread log

Issue #1073: vscode keyboard shortcut to forward the symbol/hunk under the cursor
to the builder (codelens keyboard equivalent). Protocol: PIR (strict mode).

## Plan phase (2026-08-13)

Investigated the codebase before drafting the plan. Key findings:

- **Paths moved**: issue says `packages/vscode/...`, real code is `apps/vscode/...`.
  Plan uses the real paths and calls out the drift.
- Pure helpers already exist in `apps/vscode/src/diff-inject-ref.ts`
  (`buildSymbolLensDescriptors`, `parseHunkRanges`, ref builders). The plan adds a
  new pure `resolveCursorRef(relPath, symbols, hunks, cursorLine)` there so the
  command handler stays thin and the resolution order is unit-testable.
- Two existing palette-only (unbound) commands are the closest precedent:
  `codev.forwardCurrentHunkToBuilder` (hunk-only, no symbol/file fallback) and
  `codev.forwardCurrentFileToBuilder`. Both delegate to `codev.forwardToBuilder`
  (the shared inject-without-Enter path). The new command reuses that path.
- Decision: symbol candidates derived from `buildSymbolLensDescriptors` (same set
  the codelens renders) → keyboard == codelens click. Rejected walking raw symbol
  trees for "most specific of any kind" (would forward scalar consts / nested
  blocks with no lens).
- `toSymbolNode` mapper is private in diff-inject-codelens.ts → plan exports it.
- Keybinding `Cmd/Ctrl+K H`, `when: codev.activeEditorIsBuilderFile && editorTextFocus`.

Plan written to `codev/plans/1073-vscode-keyboard-shortcut-to-fo.md`, committed,
awaiting plan-approval gate.
