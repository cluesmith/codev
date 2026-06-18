# PIR #1066 — sync Builders sidebar selection with active builder-diff file

## Phase: plan

### Investigation (done)
Issue: when the active builder-diff editor changes (keyboard nav #1060, multi-file
View Diff click, per-file diff), the Builders sidebar keeps the last-clicked row
highlighted instead of following the editor. Want an Explorer-style "reveal active
file" sync.

Key code map:
- `diff-inject-codelens.ts` — registry keyed by right-side fsPath →
  `{ builderId, relPath, hunks }`. `getDiffInjectEntry(fsPath)` is the resolver.
  Already has an `onDidChangeActiveTextEditor` listener (for the context key).
- `views/builders.ts` — `BuildersProvider`. `getParent` is **builder-row-only**
  today (returns group for `BuilderTreeItem`, undefined for file/folder rows).
  `rowIds` (AccordionRowIds, #913) versions builder-row ids. `groupParentByBuilderId`
  maps builder→group, populated in `rootChildren`.
- `views/builder-file-tree-item.ts` — `BuilderFileTreeItem` has **NO `id`** today.
- `views/builder-folder-tree-item.ts` — folder rows already have stable id
  `<builderId>::folder::<fullPath>`.
- `views/file-path-tree.ts` — `buildFilePathTree` builds the compacted folder tree
  (tree mode). Leaf node `fullPath === plan.resourcePath`.
- `extension.ts` — `buildersView = createTreeView(...)` (so `reveal` is available).
  Accordion wired via `onDidExpandElement` → `collapseBuildersExcept`.
  `openBuilderRow` already does `buildersView.reveal(item, {expand:true})` — proven
  that reveal(expand) fires onDidExpandElement and the accordion handles it.

### Plan approach (4 parts)
1. Stable id on `BuilderFileTreeItem`: `<builderId>::<relPath>` (reveal matches by id).
2. Extend `getParent` to reconstruct the chain for file + folder rows
   (flat mode → builder row; tree mode → rebuild path tree, find parent folder).
3. `findFileItem(builderId, relPath)` on the provider to construct the matching item.
4. `onDidChangeActiveTextEditor` listener in extension.ts: resolve via
   `getDiffInjectEntry`, gate on a new `codev.buildersAutoReveal` setting
   (default true), `reveal(item, {select:true, expand:true, focus:false})`.

dev-approval gate is load-bearing: walk all modes (flat/tree × stage/area) on the
running tree.

Plan written → awaiting plan-approval gate.

## Phase: implement (plan-approval approved)

Implemented all four pieces:
1. `builder-file-tree-item.ts` — `this.id = <builderId>::<rel>`.
2. `builders.ts` — `getParent` extended to file/folder rows via async
   `parentForFileNode`; exported pure `findParentNode` tree-walk; public async
   `findFileItem`.
3. `extension.ts` — `onDidChangeActiveTextEditor` reveal listener gated on
   `codev.buildersAutoReveal` (default true); `getDiffInjectEntry` is the
   no-hijack gate; `focus:false`.
4. `package.json` — `codev.buildersAutoReveal` setting.

Tests: `__tests__/builders-autoreveal.test.ts` — findParentNode (top-level,
not-found, compacted nested, folder-to-parent), file-row id format + uniqueness,
findFileItem (correct builder incl. duplicate relPath across two builders),
getParent (flat → builder row, tree → folder, top-level → builder row).

Learning while testing: `packages/vscode` compacts away — only the compacted
fullPath (`packages/vscode/src`) exists as a folder node, so getParent only ever
sees real compacted fullPaths. Fixed the test to assert against compacted paths.

Env note: had to build codev-core, codev-types, artifact-canvas in the worktree
before vscode check-types/tests resolved (pre-existing, not my change).

porch checks: build ✓ (8.9s), tests ✓ (20.6s, 454 passed incl. 11 new).
→ awaiting dev-approval gate. Manual matrix in the plan's Test Plan.

### dev-approval iteration 1: stale-selection bug (fixed)
Reviewer screenshot: editor on `middleware/require-user-or-service-auth.ts` but
sidebar highlighted `src/index.ts` (one level up). Root cause = registry TIMING,
not getParent: `openBuilderFileDiff` opens the diff (→ active-editor event fires)
BEFORE it upserts the diff-inject entry, so on a file's FIRST open
`getDiffInjectEntry` returns undefined and the reveal bails → selection lags on
the previous file. Revisits worked (entry already present) → "works sometimes".
Fix: exposed `onDidChangeDiffInjectRegistry` from diff-inject-codelens; reveal now
runs on BOTH active-editor change AND registry change (same dual-trigger the
context-key sync already uses). Refactored to a named `revealActiveBuilderFile`
(one fn, two subscriptions) + a staleness guard (re-check active fsPath after the
await) for rapid nav. check-types/lint/tests green (454).

### dev-approval iteration 2: navigation order (tree order)
Reviewer: Ctrl+Alt+] nav visited loose `src/*` files before the `middleware/`
folder even though the tree shows middleware first. Root cause = nav walked git
`--name-status` order while the tree renders folders-first/alpha depth-first.
Fix (touches #1060's nav, folded in since it serves #1066's nav+sidebar
coherence): added `flattenTreeOrder` (DFS leaf order) to file-path-tree.ts and
`navigationOrder(files, viewAsTree)` to diff-nav.ts. Tree mode → depth-first tree
order; flat mode → unchanged git order (matches what flat list shows). +3 tests
(457 total). green.

### dev-approval iteration 3: navigation wrap-around
Verified hunk-stepping is VSCode's BUILT-IN change nav (F7), which wraps at the
last hunk and has no setting to disable. We own no hunk nav. Rather than build a
custom no-wrap hunk navigator, reviewer chose to make FILE nav wrap too for
consistency. Changed `computeNavTarget` to modulo wrap (forward past last → first,
backward past first → last; single file wraps to itself); dropped `atEdge` + the
edge flash in navigateDiff. Updated computeNavTarget tests. green (457).
Also filed #1072 (vscode dedup: builderById + file-view config reader).

## Phase: review (dev-approval approved)

Wrote `codev/reviews/1066-*.md`. Routed governance updates COLD only (VSCode-scoped,
not HOT-worthy): arch.md gets a "Builders diff-review: navigation + active-file
sync (#1060/#1066)" design decision; lessons-learned.md gets 3 [From #1066] UI/UX
lessons (dual-trigger registry sync, reveal needs stable ids + full getParent
chain, match host built-in wrap rather than reimplement). No skeleton mirror
(product code + user-evolved docs, not framework templates).

PR #1075 opened (review file as body), recorded with porch. porch review checks
green (pr_exists, arch/lessons section presence). 3-way consultation (gemini/codex/
claude, type=impl) running in background — single advisory pass. Architect notified.
→ will report any REQUEST_CHANGES then wait at pr gate.

### Consultation results + fixes (iteration 1)
- Codex REQUEST_CHANGES (HIGH): reveal gate matched any tracked fsPath, so a
  standalone (non-diff) open of a worktree file could hijack selection. REAL.
  Fixed: `isStandaloneTextTab` gate — reveal skips plain TabInputText, fires only
  for diff tabs. Negative gate (skip TabInputText) chosen because
  TabInputTextMultiDiff isn't in stable @types/vscode@1.105. + regression test.
- Claude COMMENT (HIGH): stale "no wrap" docstring in diff-nav.test.ts header.
  Fixed.
- Gemini: unusable (agy sandbox meta-output, no verdict) — non-blocking skip.
  (porch parsed it as REQUEST_CHANGES → wrote rebuttal file.)
Rebuttals: codev/projects/1066-*/1066-review-iter1-rebuttals.md. Dispositions also
in the review file + PR #1075 body. check-types/lint/tests green (461, +4).
porch review checks green → **pr gate pending**. Architect notified, leading with
the Codex fix. Waiting for human to review PR + approve pr gate, then I merge.
