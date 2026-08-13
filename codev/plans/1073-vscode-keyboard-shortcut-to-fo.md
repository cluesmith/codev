# PIR Plan: Keyboard shortcut to forward the symbol/hunk under the cursor to the builder

## Understanding

The unified builder-diff editor (#789 / PR #1023) forwards file / hunk / symbol
references into a builder's PTY, but every granular surface is **mouse-driven**:

- The file-header codelens injects the file path.
- The per-symbol / per-hunk codelens injects `path/to/file.ts:L42-L58`.
- `Cmd/Ctrl+K B` (`codev.forwardSelectionToBuilder`) needs an explicit text
  selection (`when: … && editorHasSelection`) — a two-step motion.

There is no single keystroke for the natural review motion *"my cursor is inside
this hunk / function; forward whatever covers it."* Codelens has no keyboard
activator in VS Code, so the lens is mouse-only by construction.

This issue adds a **new command + keybinding** that resolves the cursor's current
line to its enclosing symbol (first), else the containing changed hunk, else the
bare file, and injects the reference into the builder PTY — reusing the exact
inject path the codelens already uses (no Enter pressed).

### Codebase notes (verified in the worktree)

- **Paths moved.** The issue references `packages/vscode/...`; the code now lives
  under `apps/vscode/...`. All file paths below use the real `apps/vscode/` root.
- `apps/vscode/src/diff-inject-ref.ts` is `vscode`-free and already exports the
  pure selection/ref helpers: `buildSymbolLensDescriptors` (the file-level +
  forwardable-symbol lens set), `parseHunkRanges`, `buildBuilderFileRef`,
  `buildBuilderRangeRef`, and the `SymbolNode` / `ChangedRange` / `LensDescriptor`
  types.
- `apps/vscode/src/diff-inject-codelens.ts` owns the diff-inject **registry**
  (`getDiffInjectEntry(fsPath)` → `{ builderId, relPath, hunks }`), the
  `codev.activeEditorIsBuilderFile` context key, and a private `toSymbolNode`
  mapper (`vscode.DocumentSymbol` → `SymbolNode`).
- `apps/vscode/src/extension.ts` registers the command handlers. Two existing
  handlers are the closest precedent and are **palette-only (unbound)**:
  - `codev.forwardCurrentHunkToBuilder` (extension.ts:1227) — hunk-only, no
    symbol step, no file fallback; status-bars "place the cursor in a changed
    hunk" on a miss.
  - `codev.forwardCurrentFileToBuilder` (extension.ts:1217) — file path only.
  Both delegate to `codev.forwardToBuilder(builderId, refText)` (extension.ts:1163),
  which opens/reveals the builder terminal and injects the text without Enter.
  This is the inject path the new command reuses verbatim.
- Keybindings live in `apps/vscode/package.json` under `contributes.keybindings`
  (the `Cmd/Ctrl+K` family: `k a`, `k d`, `k g`, `k b`, `k i`); command titles
  under `contributes.commands`.

## Proposed Change

Add one new command, `codev.forwardCursorContextToBuilder`, wired to
`Cmd/Ctrl+K H`, plus one new **pure** resolver in `diff-inject-ref.ts` that the
command (and its unit tests) call. The existing commands, codelens, and
`Cmd/Ctrl+K B` are left untouched (additive change).

### 1. New pure resolver in `diff-inject-ref.ts`

```ts
export type CursorRef =
  | { kind: 'symbol' | 'hunk'; refText: string; range: ChangedRange }
  | { kind: 'file'; refText: string };

/**
 * Resolve the reference to forward for a cursor sitting on `cursorLine` (1-based,
 * new-side). Resolution order (locked by the issue):
 *   1. Symbol — the most specific forwardable symbol whose range contains the
 *      cursor. "Forwardable" == exactly the symbol set the codelens exposes, so
 *      the keyboard lands on the same range a lens click would.
 *   2. Hunk — the changed range containing the cursor.
 *   3. File — the bare file path.
 */
export function resolveCursorRef(
  relPath: string,
  symbols: SymbolNode[],
  hunks: ChangedRange[],
  cursorLine: number,
): CursorRef
```

**Symbol step — reuse the existing lens model.** Rather than walk raw symbols
(which would forward scalar consts or deeply nested blocks the codelens never
shows), the resolver derives its candidate symbols from
`buildSymbolLensDescriptors(relPath, symbols)` — the *same* file-level +
forwardable-declaration set the lenses render. Among descriptors that carry a
`range` (i.e. not the file-level lens) containing `cursorLine`, pick the one with
the **smallest span** (most specific: a method inside a class beats the class).
This guarantees acceptance-criterion parity: pressing the key inside a symbol
injects exactly what clicking that symbol's lens would, `L<start>-L<end>`.

**Hunk step.** If no symbol range contains the cursor, scan `hunks`
(`ChangedRange[]`, already 1-based new-side, carried on the registry entry) for
one containing `cursorLine`; inject `buildBuilderRangeRef(relPath, h.start, h.end)`.

**File step.** Otherwise return `{ kind: 'file', refText: buildBuilderFileRef(relPath) }`.

This keeps *all* resolution logic `vscode`-free and unit-testable; the command
handler is a thin adapter.

### 2. Export the symbol mapper

`toSymbolNode` in `diff-inject-codelens.ts` is currently private. Export it (and
re-export or import it in `extension.ts`) so the new handler can map the live
`vscode.DocumentSymbol[]` to `SymbolNode[]` without duplicating the mapper. No
behavior change to the provider.

### 3. New command handler in `extension.ts`

Register `codev.forwardCursorContextToBuilder` alongside the existing forward
commands:

```ts
reg('codev.forwardCursorContextToBuilder', async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const entry = getDiffInjectEntry(editor.document.uri.fsPath);
  if (!entry) { return; }
  const cursorLine = editor.selection.active.line + 1; // 1-based new-side
  let symbols: vscode.DocumentSymbol[] = [];
  try {
    symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', editor.document.uri)) ?? [];
  } catch { symbols = []; }
  const resolved = resolveCursorRef(
    entry.relPath, symbols.map(toSymbolNode), entry.hunks, cursorLine);
  if (resolved.kind === 'file') {
    vscode.window.setStatusBarMessage(
      'Codev: forwarded file path (no symbol or hunk at cursor)', 3000);
  }
  await vscode.commands.executeCommand(
    'codev.forwardToBuilder', entry.builderId, resolved.refText);
});
```

Focus stays on the diff editor; `forwardToBuilder` reveals/opens the terminal and
injects without stealing keyboard focus (same as every existing forward action),
and no picker/modal is shown — builder is inherited from the registry entry
(plan-gate decision #5).

### 4. Contribute command + keybinding in `package.json`

- `contributes.commands`: add
  `{ "command": "codev.forwardCursorContextToBuilder", "title": "Codev: Forward Symbol / Hunk at Cursor to Builder" }`
  (palette-discoverable).
- `contributes.keybindings`: add
  ```json
  {
    "command": "codev.forwardCursorContextToBuilder",
    "key": "ctrl+k h",
    "mac": "cmd+k h",
    "when": "codev.activeEditorIsBuilderFile && editorTextFocus"
  }
  ```
  `editorTextFocus` (not `editorHasSelection`) — cursor only, no selection
  required. `codev.activeEditorIsBuilderFile` scopes it to tracked builder-diff
  files so it never fires in unrelated diff/editor tabs.

### 5. Unit tests

Add cases to `apps/vscode/src/__tests__/diff-inject-ref.test.ts` (pure, no vscode
mock) covering `resolveCursorRef`:

- cursor inside a top-level function → symbol range;
- cursor inside a method within a class → the **method** (most specific), not the class;
- cursor on a declaration line vs body line — both resolve to the enclosing symbol;
- no symbol but inside a hunk → hunk range;
- no symbol and no hunk → file ref (`kind: 'file'`);
- new-file diff (symbols present, empty `hunks`) → symbol still resolves;
- symbol-present-but-cursor-outside-it, inside a hunk → hunk wins (order).

## Files to Change

- `apps/vscode/src/diff-inject-ref.ts` — add `CursorRef` type + `resolveCursorRef`
  pure helper (built on the existing `buildSymbolLensDescriptors`, `buildBuilderRangeRef`,
  `buildBuilderFileRef`).
- `apps/vscode/src/diff-inject-codelens.ts` — `export` the `toSymbolNode` mapper
  (currently private; no logic change).
- `apps/vscode/src/extension.ts` — register `codev.forwardCursorContextToBuilder`
  (~15 lines) near the existing `forwardCurrentHunkToBuilder` (extension.ts:1227);
  import `resolveCursorRef` + `toSymbolNode`.
- `apps/vscode/package.json` — add the command declaration (`contributes.commands`)
  and the `Cmd/Ctrl+K H` keybinding (`contributes.keybindings`).
- `apps/vscode/src/__tests__/diff-inject-ref.test.ts` — resolution-order unit tests.

## Risks & Alternatives Considered

- **Risk: keybinding collision.** The issue verified `cmd+k h` / `cmd+k cmd+h`
  are both unbound in VS Code defaults. Adjacent risk: `cmd+k cmd+b` is
  `editor.action.setSelectionAnchor`; a user who learned that chord but releases
  Cmd between keys lands on `cmd+k b` (forward-selection), not our new binding —
  pre-existing, unchanged by this work. Mitigation: ship as a rebindable default,
  matching the `Cmd/Ctrl+K B` precedent.
- **Risk: symbol resolution diverging from the codelens.** Mitigated by deriving
  candidates from `buildSymbolLensDescriptors` (the same set the lenses render),
  so keyboard == click. Rejected alternative: walking raw `SymbolNode` trees for
  the "most specific symbol of any kind" — it would forward scalar consts / nested
  blocks that have no lens, breaking the "keyboard equivalent of a codelens click"
  contract and surprising the reviewer.
- **Alternative: bind `Cmd/Ctrl+K H` to the existing `forwardCurrentHunkToBuilder`.**
  Rejected — that command is hunk-only with no symbol step and no file fallback;
  it status-bars a *failure* ("place the cursor in a changed hunk") instead of
  falling through, missing acceptance criteria #2 (symbol) and #4 (file fallback).
  A new unified resolver is required.
- **Alternative: carry symbols on the registry entry** to avoid the per-press
  `executeDocumentSymbolProvider` call. Rejected — the codelens provider already
  fetches symbols lazily per document; symbols go stale as the file changes, and a
  single command-time fetch is cheap and always current. Matches the provider's
  own pattern.
- **Out of scope (unchanged):** the codelens itself, `Cmd/Ctrl+K B`, a batched
  review queue (#1037), a file-path-only keybinding, cross-file walk (#1060), and
  any right-click menu entry (plan-gate decision #2: palette + keybinding only for v1).

## Test Plan

**Unit** (`pnpm --filter @cluesmith/codev-vscode test`, run from `apps/vscode/`):
the `resolveCursorRef` cases above — symbol-first, method-most-specific,
hunk-fallback, file-fallback, order-when-both, new-file. Pure functions, no mock.

**Manual (dev-approval gate)** — in a running worktree with an active builder diff:

1. Open a builder file diff (View Diff / per-file diff) so codelenses appear.
2. Place the cursor **inside a function/method body** (no selection) → press
   `Cmd/Ctrl+K H`. Confirm the builder terminal receives
   `path/to/file.ts:L<symbol-start>-L<symbol-end> ` with **no Enter**, and the
   range matches the symbol's codelens.
3. Place the cursor in a **changed region not covered by any symbol** (e.g. a
   top-level edit / a language with no symbol provider) → `Cmd/Ctrl+K H` injects
   the hunk range `:L<start>-L<end>`.
4. Place the cursor on an **unchanged context line outside any symbol** →
   `Cmd/Ctrl+K H` injects the bare file path and shows the status-bar note
   "forwarded file path (no symbol or hunk at cursor)".
5. Confirm **focus stays on the diff editor** — no picker/modal, keyboard flow
   uninterrupted; repeat and keep typing feedback before Enter.
6. **New-file diff** (no left side): cursor inside a symbol still forwards its range.
7. **Scope check:** open an unrelated (non-builder) diff/editor → `Cmd/Ctrl+K H`
   does nothing (`codev.activeEditorIsBuilderFile` false).
8. **Regression:** `Cmd/Ctrl+K B` with a selection still forwards the selection;
   clicking a codelens still injects its reference.

**Cross-platform:** N/A (VS Code extension; `mac` + `key` both declared for the
keybinding).
