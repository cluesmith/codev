# Unreleased

<!--
  TEMPLATE — copy to docs/releases/UNRELEASED.md at the start of each release cycle:

      cp docs/releases/UNRELEASED.template.md docs/releases/UNRELEASED.md

  Edit UNRELEASED.md across the cycle (the working copy). NEVER edit this
  template directly — it's the cold-start structure, untouched between cycles.

  Per-PR architect workflow (on the docs/vscode-changelog branch):
    1. cd worktrees/changelog                       # no fetch / no rebase — branches diverge by design
    2. Add the CHANGELOG entry to packages/vscode/CHANGELOG.md under [Unreleased]
       (add the [Unreleased] heading if it's missing — post-release state removes it)
    3. Add the matching release-notes entry to UNRELEASED.md under the right section:
         substantive change → its own ## section
         small vscode item  → Polish
         non-vscode change  → Other fixes
    4. Commit both files together; plain `git push` (fast-forward, no force)

  Why no rebase, ever: main moves with code merges, docs/vscode-changelog moves
  with changelog/release-notes entries — neither branch touches the other's
  files, so they diverge by design and reconcile at release time via merge.
  Rebasing rewrites commit hashes and forces force-pushes for zero real benefit.

  At release time:
    1. Rename the title to `# vX.Y.Z <Codename>` and add `Released: YYYY-MM-DD`
    2. Replace this entire comment block with the release Summary paragraph
       (one paragraph framing what shipped — lead with the biggest story)
    3. Fill in the Contributors section at the bottom
    4. git mv docs/releases/UNRELEASED.md docs/releases/vX.Y.Z-<codename>.md
    5. Commit, plain push, merge to main alongside the version bump
    6. Re-cp the template back to UNRELEASED.md to start the next cycle
-->

## Add Architect from the Workspace tab (#841, PR #1082)

The Workspace tab in the Codev sidebar lists registered architects under an "Architects" parent row (one child per architect registered in Tower's state, since Spec 786). Until now the only way to *add* a second architect was the CLI command `afx workspace add-architect --name <name>`. The VS Code surface lagged: the tree could render N architects but the extension provided no `+` affordance.

This release adds the missing affordance. A new `Codev: Add Architect` command surfaces three ways:

1. **The Architects row carries an inline `+` action**. Click it to register a new architect for the current workspace; a Quick Pick asks for the architect name; on submit, Tower's state updates and the Architects section re-renders with the new row underneath.
2. **`Cmd+K A` / `Ctrl+K A` keyboard shortcut** invokes the same flow without leaving the keyboard.
3. **The command palette** entry `Codev: Add Architect` runs the same code path.

Architect names render in UPPERCASE in the sidebar (`MAIN`, `OB-REFINE`, etc.) so they read as a distinct name family from the file / folder labels that share the tree. This matches the casing convention already used in `afx status` and the Tower dashboard, so the same identity reads the same way across surfaces.

A small structural cleanup ships with this: the architect-name validator that was previously duplicated between `packages/codev/src/agent-farm/utils/architect-name.ts` (the CLI surface) and the VS Code extension is now a single shared source in `@cluesmith/codev-core` (`packages/core/src/architect-name.ts`). Name validation (allowed characters, length cap, reserved-name check) is identical no matter which surface the user adds an architect from. The CLI module is a thin re-export.

This is one of the four follow-ups originally listed in #770 for multi-architect VS Code support. The remaining three (`#950` Quick Pick for sending to a chosen architect, `#1009` handoff / pickup UI, `#984`-derived coordination polish) ship on their own cadence.

## Builders sidebar auto-reveals the active builder-file diff (#1066, PR #1075)

A natural follow-up to PR #1067's cross-file navigation (#1060): with the keyboard `Ctrl+Alt+]` / `Ctrl+Alt+[` walk in place, the Builders sidebar tree was a step out of sync. Opening file 3 of a diff session would leave the sidebar selection pointing at file 1, so the visual reference for "where you are in the changed-file list" did not match the editor.

The Builders sidebar now reveals and selects the file row for whichever builder-file diff is active in the editor, mirroring the Explorer's auto-reveal behavior. A single `onDidChangeActiveTextEditor` listener handles every entry point: sidebar clicks, multi-file `View Diff` clicks, per-file `vscode.diff` opens, and the keyboard-driven nav. A registry-change re-reveal covers the case where the active editor changes before the changed-file list has loaded; once the list appears, the reveal fires.

Two file-tree navigation tweaks landed alongside, surfaced during the dev-approval review:

- Cross-file navigation now follows the **visible tree order** (depth-first in tree-view mode; git order in flat mode), so pressing the next-file keybinding always lands you on the next row you can see. Previously the navigation order matched the underlying flat change-list, not the tree representation, so a `pkg/a/foo.ts → pkg/b/bar.ts` step in flat order would visually jump across siblings in tree mode.
- File navigation now **wraps around** at the ends to match VSCode's built-in within-file hunk navigation (F7 / Shift+F7). Previously the ends no-op'd; the wrap-around removes the dead-end so a reviewer can keep tabbing through the diff session.

A new opt-out setting `codev.buildersAutoReveal` (defaulting on) disables the reveal for users who prefer a static sidebar. The reveal is gated to **diff tabs only** so a plain editor open of a tracked worktree file (e.g. opening `pkg/foo.ts` directly via `Cmd+P` while a builder also has it in its changed-file list) does not hijack the sidebar selection. The gate uses a negative test (`TabInputText` only → skip) rather than a positive `TabInputTextDiff` test, because the multi-file `TabInputTextMultiDiff` type is not exported by stable `@types/vscode@1.105` (the engine pin tracks Cursor's bundled VSCode base, per `project_vscode_engine_pinned_to_cursor`).

Supporting groundwork: file rows in the Builders tree gained a stable `<builderId>::<relPath>` id so the reveal can locate them; `BuildersProvider.getParent` reconstructs the full file → folder → builder → group ancestor chain VSCode's `TreeView.reveal` needs to walk up. The diff-inject codelens provider gained an `onDidChangeDiffInjectRegistry` event so the auto-reveal can re-fire when the changed-file list lands later than the editor open.

## Typography tokens for the Codev Markdown Preview (#1053, PR #1071)

The Codev Markdown Preview (`@cluesmith/codev-artifact-canvas` mounted by `MarkdownPreviewProvider`) previously inherited the host's typography. In the VS Code webview that meant prose rendered at the workbench UI font with a tight code-tuned line-height, no paragraph rhythm, no heading scale, and no styling for inline `code`, blockquotes, tables, `hr`, images, or lists. Spec 945 D4 had capped the v1 token vocabulary at colors, so there was no host-level lever for any of it.

This release extends the canvas theming contract with a typography token tier in three layers:

1. **Package tokens and element styling** in `default-theme.css`. Thirteen new typography tokens (font-size, font-family, line-height, paragraph spacing, optional prose-width cap, per-level heading sizes, code font family and size) plus the rules that consume them. The pass also styles block elements that were falling through to user-agent defaults: inline `code` chips, fenced `pre`, blockquotes, tables, `hr`, images, and list indentation. `github-markdown-css` v5.8.1 is the pinned baseline so the defaults are reproducible.
2. **Host bindings** in `preview-template.ts`. Code tokens bind to VSCode's editor font, prose tokens keep the readable sans stack, and inline code pairs with VSCode's `textPreformat-*` theme tokens so dark themes get proper contrast.
3. **User settings**: `codev.markdownPreview.fontSize` and `codev.markdownPreview.lineHeight` let reviewers tune the preview without affecting the rest of the IDE chrome; both reflow live via `onDidChangeConfiguration`.

The typography also covers the package's exported standalone `MarkdownView` surface (the surface a host can mount without the comment overlay) via `:is(.codev-artifact-canvas-body, .codev-artifact-canvas-rendered)` selector groups. Overlay chrome (gutter `+` affordance, comment cards, right-edge minimap) stays scoped to the composed surface where it belongs, so adopting `MarkdownView` doesn't accidentally pull in overlay markup.

Two correctness fixes landed during the dev-approval review. A dark-mode inline-code contrast bug is fixed by adding a `--codev-canvas-code-foreground` token: previously, inline code had a background token but no foreground token, so dark themes paired a dark code-block background with the general light foreground and rendered low contrast. The page-level horizontal-scroll bug from unbreakable long tokens in prose is fixed by `overflow-wrap: break-word` on the prose container, while `pre` and tables keep their own `overflow: auto` so they scroll within the block rather than at the page level.

The token vocabulary is the locked public contract from spec 945 D4, so this expansion carries a spec-amendment doc trail across `types.ts`, the package README, the PIR review, and the issue.

## Cross-file navigation in the Codev View Diff session (#1060, PR #1067)

Two new commands, `codev.diffNextFile` and `codev.diffPreviousFile`, walk a builder's changed-file list and open the next or previous file's per-file diff. Bound to `Ctrl+Alt+]` / `Ctrl+Alt+[` by default and palette-discoverable; the keybindings are scoped via a new `codev.activeEditorIsBuilderFile` context key so they only fire while the active editor is a Codev builder-file diff, not in unrelated VS Code diff editors. The keyboard equivalent of clicking the next file row in the Builders sidebar, taken from GitHub PR review's `j` / `k` muscle memory.

The implementation deliberately reuses already-shipped machinery: the `BuilderDiffCache` that backs the Builders sidebar's changed-file list provides the ordered list (so navigation order matches what the sidebar shows), the diff-inject registry provides the "currently shown" position, and each step opens through the existing per-file `vscode.diff` path. No change to how `codev.viewDiff` itself opens.

The nav anchor is seeded on **every** open (sidebar click, `viewDiff`, programmatic open), not just after a navigation step, so a deleted or binary file opened directly from the sidebar is a valid starting point for a walk. The first cycle's CMAP-3 caught this edge case (deleted / binary files lack a `file:` right-side document and so are absent from the diff-inject registry); the fix is a small `recordDiffNavPosition` call from the `codev.openBuilderFileDiff` handler with a matching regression test.

A residual narrower edge is documented as a follow-up (#1066): focusing a deleted file *inside* the multi-file View Diff editor without a prior open or nav still can't seed the anchor, because `viewDiff` only registers `file:`-kind right sides. Sidebar-open path is fixed; the in-editor focus path is the sidebar-selection-sync follow-up.

## Polish

<!-- Small vscode items as bullets:
       - **<Headline>** (#<issue>, PR #<pr>). <One short paragraph of context.>
     Move out to its own ## section if the entry grows past ~3 sentences. -->

- **Backlog issue preview no longer steals focus and cannot chain into new editor groups** (#1074, PR #1076). Clicking a backlog row used to first call `workbench.action.focusFirstEditorGroup` so that `markdown.showPreviewToSide`'s `Beside` placement would resolve to group 2; that focus side-effect pulled the user away from wherever they were sitting (e.g. a builder terminal in group 2), and if any future caller skipped the focus step the preview would chain into groups 3 / 4 / 5 instead of reusing group 2. The preview now opens via `vscode.openWith` with the built-in markdown preview's custom-editor viewType `vscode.markdown.preview.editor`, which accepts an explicit `viewColumn` plus `preserveFocus`. The count-then-pick column choice mirrors the builder-terminal model from `Bugfix #804`: group 2 when one exists, group 1 otherwise. No change to which renderer draws the preview (still VSCode's built-in markdown preview); the move is purely about how the preview is invoked, and is orthogonal to the eventual decision in #1068 about migrating issue preview onto the artifact-canvas surface.

## Other fixes (dashboard, porch, infrastructure)

<!-- Non-vscode work that ships in the npm release. Same bullet shape as Polish. -->

## Breaking changes

None.

## Install

```bash
npm install -g @cluesmith/codev@X.Y.Z
afx tower stop && afx tower start
```

The VS Code extension ships separately via the Marketplace — `Codev` extension by `cluesmith.codev`, version `X.Y.Z`.

## Contributors

<!-- Filled at release time. Use the topic-first voice from prior release notes:
       - **<Name> (@<handle>)** — <topic>: <what they did across which PRs>.
       - Builders working under AIR / BUGFIX / PIR / SPIR protocols across the PRs in this release.
     Source: git log v<prev>..HEAD --merges --pretty=format:"%h %an %s" -->
