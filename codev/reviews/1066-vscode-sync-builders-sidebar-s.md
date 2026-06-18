# PIR Review: Sync Builders sidebar selection with the active builder-diff file

Fixes #1066

## Summary

The Builders sidebar now reveals and selects the row for whichever builder-diff file is active in the editor, mirroring the Explorer's auto-reveal. One `onDidChangeActiveTextEditor` + registry-change listener covers every entry point (keyboard navigation, multi-file View Diff clicks, per-file diff). Supporting groundwork: file rows gained a stable `<builderId>::<relPath>` id and `BuildersProvider.getParent` now reconstructs the full file → folder → builder → group chain so `reveal` can locate a row. While reviewing the running tree, two adjacent navigation tweaks were folded in: cross-file nav now follows the **visible tree order** (depth-first in tree mode) and **wraps** at the ends to match VSCode's built-in hunk navigation.

## Files Changed

(`git diff --stat` against the merge-base, code only)

- `packages/vscode/src/views/builders.ts` (+125 / -) — `getParent` extended to file/folder rows, `parentForFileNode`, `findFileItem`, `findParentNode`, `builderWithWorktree` helper
- `packages/vscode/src/views/builder-file-tree-item.ts` (+9) — stable `<builderId>::<relPath>` id
- `packages/vscode/src/views/file-path-tree.ts` (+20) — `flattenTreeOrder` (depth-first display order)
- `packages/vscode/src/commands/diff-nav.ts` (+53 / -) — `navigationOrder` (tree order), wrap-around `computeNavTarget`
- `packages/vscode/src/diff-inject-codelens.ts` (+12) — `onDidChangeDiffInjectRegistry` export
- `packages/vscode/src/extension.ts` (+42 / -) — `revealActiveBuilderFile` listener (dual trigger), `buildersAutoReveal` gate
- `packages/vscode/package.json` (+5) — `codev.buildersAutoReveal` setting
- `packages/vscode/src/__tests__/builders-autoreveal.test.ts` (+222) — new
- `packages/vscode/src/__tests__/diff-nav.test.ts` (+69 / -) — navigationOrder + wrap tests

Plus the PIR artifacts: `codev/plans/1066-*.md`, `codev/reviews/1066-*.md`, `codev/state/pir-1066_thread.md`, and COLD governance updates to `codev/resources/arch.md` + `codev/resources/lessons-learned.md`.

## Commits

- `b220b1ce` [PIR #1066] Stable file-row id + getParent/findFileItem for reveal
- `5dd16783` [PIR #1066] Auto-reveal active builder-diff file in Builders tree
- `b5dc6a4b` [PIR #1066] Unit tests for findParentNode, file-row id, findFileItem, getParent
- `3ac1ac7e` [PIR #1066] Fix stale sidebar selection: re-reveal on diff-inject registry change
- `5741f480` [PIR #1066] Navigate files in visible tree order (depth-first) in tree-view mode
- `ff6bcc0d` [PIR #1066] Extract builderWithWorktree helper to dedup the changed-file preamble
- `4259a9f1` [PIR #1066] Wrap file navigation at the ends to match built-in hunk nav
- (plus `[PIR #1066] Thread:` log commits)

## Test Results

- `pnpm check-types`: ✓ pass
- `pnpm lint`: ✓ pass
- `pnpm test:unit`: ✓ pass (457 tests, 14 new across the two test files)
- Manual verification (at the dev-approval gate, on the running Extension Host): reveal follows keyboard nav / multi-file View Diff clicks / per-file diff across both view modes (flat + tree) and both grouping axes (stage + area); the same-relPath-across-two-builders case resolves to the correct builder; the stale-selection bug was reproduced and confirmed fixed; tree-order navigation and wrap-around verified.

## Architecture Updates

**COLD** — added one Key Design Decision to `codev/resources/arch.md` (VS Code Extension section): "Builders diff-review: navigation + active-file sync (#1060/#1066)", documenting that the current builder/file is **derived from the active editor** via the diff-inject registry (worktree-absolute path is unique per builder), that navigation is intra-builder in visible tree order with wrap, and the two TreeView prerequisites for `reveal` (stable ids + full `getParent` chain) plus the dual-trigger reveal.

**HOT** — no changes. These are VS Code-extension-scoped mechanics, not always-injected cross-cutting system facts; they belong in COLD reference, not the capped hot tier.

No `codev-skeleton/` mirror needed: this is product code (`packages/vscode`) plus user-evolved governance docs, not framework template files.

## Lessons Learned Updates

**COLD** — added three UI/UX lessons to `codev/resources/lessons-learned.md` (all `[From #1066]`):
1. An editor-derived sidebar sync must listen to **both** the active-editor event and the metadata-registry change event, because a programmatic diff open registers its entry *after* the editor activates (the root cause of the stale-selection bug — it "worked on revisits", masking the timing).
2. `reveal` on a deep TreeView row needs stable row `id`s **and** a `getParent` that reconstructs the whole chain for collapsed subtrees (a getChildren-populated map is insufficient since reveal walks parents before expanding).
3. When a UI gesture overlaps a host built-in you can't reconfigure (VSCode's wrapping hunk nav), match the built-in rather than reimplement it — verify whether the behavior is even yours before promising to change it.

**HOT** — no changes (same rationale as arch).

## Things to Look At During PR Review

- **`BuildersProvider.getParent` async reconstruction** (`builders.ts`) — the load-bearing piece. It rebuilds the compacted path tree from the cached diff and walks `findParentNode` to resolve a row's parent. Correctness depends on the fact that compaction means folder rows only ever carry *compacted* fullPaths (a unit test pins this; `packages/vscode` compacts to `packages/vscode/src`).
- **Dual-trigger reveal** (`extension.ts` + `diff-inject-codelens.ts`) — the fix for the stale-selection bug. The staleness guard (re-check the active fsPath after the await) protects rapid keyboard nav from a slow lookup overriding a newer file.
- **`navigationOrder` mode-dependency** (`diff-nav.ts`) — tree mode flattens the tree depth-first; flat mode keeps git order. Each matches what its view renders.
- **Scope note**: the tree-order and wrap-around navigation changes touch #1060's nav, slightly beyond the literal #1066 sidebar-sync charter; folded in because they directly serve nav/sidebar coherence and were requested by the reviewer at the dev-approval gate.

## How to Test Locally

For reviewers pulling the branch:

- **Run dev server / Extension Host**: reload the extension to pick up the rebuilt bundle.
- **What to verify** (mapped to the plan's Test Plan):
  - Changing the active builder-diff editor (keyboard nav Ctrl+Alt+]/[, multi-file View Diff click, per-file diff) selects the matching sidebar row, expanding ancestors.
  - Works in both view modes (flat + tree) and both grouping axes (stage + area), incl. the single-`Uncategorized` flatten case.
  - No selection hijack for a normal source file or unrelated diff.
  - Accordion (#913): revealing a file in builder B collapses A and keeps B open.
  - Opt-out: `codev.buildersAutoReveal: false` disables the sync.
  - Navigation follows the visible tree order and wraps at the ends.

## Consultation Dispositions (single advisory pass)

- **Codex — `REQUEST_CHANGES` (HIGH): reveal gate could hijack a standalone open.** Valid. The reveal gated only on "active file path is in the diff-inject registry", but the registry is keyed by the right-side worktree file path, so opening that same file as a normal (non-diff) editor tab would also match and hijack the selection. **Fixed** (commit `6954515b`): the reveal now skips when the active tab is a plain `TabInputText`, so it fires only for diff tabs (per-file `vscode.diff` and the multi-file `vscode.changes`). New pure helper `isStandaloneTextTab` + a regression test. Gated on "is a plain text tab" rather than "is a diff tab" because `TabInputTextMultiDiff` is absent from the stable `@types/vscode@1.105`; a diff tab is never `TabInputText`, so both diff surfaces still reveal.
- **Claude — `COMMENT` (HIGH): stale test-file docstring.** Valid. `diff-nav.test.ts` header still said "the edges no-op (no wrap)" after the wrap-around change. **Fixed** (same commit): header now describes the visible-tree order + wrap-around.
- **Gemini — no usable verdict.** The `agy` run emitted sandbox meta-output instead of a review (no `VERDICT` line); treated as a non-blocking skip per the consult tooling's documented behavior.

## Follow-ups

- **#1072** (filed): vscode dedup — a shared `builderById` lookup helper (the `builders.find(b => b.id === id)` pattern repeats across ~6 command files) and a shared `buildersFileViewAsTree` config reader. Deliberately deferred to keep this PR scoped.
