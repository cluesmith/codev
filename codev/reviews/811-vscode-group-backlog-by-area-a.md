# PIR Review: vscode — group backlog tree by area

Fixes #811

## Summary

The vscode Backlog tree is now grouped by `area/*` label. Group ordering is pure alphabetical specific areas followed by `Uncategorized` last; a single-`Uncategorized` group collapses to flat rendering so repos that haven't adopted `area/*` labels see no visual regression. No configurable mechanism — the framework stays policy-free about specific label names and about group rank (extending #819's discipline to the view layer).

## Files Changed

Computed via `git diff --stat origin/main...HEAD`:

- `codev/plans/811-vscode-group-backlog-by-area.md` (+73 / -0)
- `codev/projects/811-vscode-group-backlog-by-area-a/status.yaml` (+29 / -0) — porch-managed
- `codev/reviews/811-vscode-group-backlog-by-area-a.md` (+93 / -0) — this file
- `codev/state/pir-811_thread.md` (+68 / -0)
- `packages/vscode/src/extension.ts` (+13 / -4) — wire workspaceState + expand/collapse listeners
- `packages/vscode/src/test/backlog.test.ts` (+59 / -6) — 6 new `groupBacklogByArea` tests
- `packages/vscode/src/views/backlog-tree-item.ts` (+22 / -0) — `BacklogGroupTreeItem` class
- `packages/vscode/src/views/backlog.ts` (+154 / -19) — pure `groupBacklogByArea` helper + two-level `BacklogProvider` + single-Uncategorized flatten optimization

Total: 8 files, +511 / -29.

## Commits

```
7309c94c [PIR #811] Plan draft
68c3d070 [PIR #811] Group backlog tree by area/* label
5fd9351e [PIR #811] Thread: log implement-phase progress
aab03a27 [PIR #811] Replace hardcoded cross-cutting with codev.backlog.priorityAreas setting
f736c3cc [PIR #811] Plan + thread: revise to user-configurable priority areas
87fbf75b [PIR #811] Flatten single-Uncategorized backlog to row list (no header)
a235d422 [PIR #811] Review + retrospective
9ace0fcb [PIR #811] Address Claude COMMENT: drop void prefix on fire-and-forget update
6183fba6 [PIR #811] Thread: log review-phase consult verdicts and pr gate
f1c30975 [PIR #811] Drop codev.backlog.priorityAreas mechanism per architect reconsideration
```

## Test Results

- `pnpm --filter codev-vscode test`: ✓ 90 pass (6 new `groupBacklogByArea` cases + 84 pre-existing)
- `pnpm build` (full workspace): ✓ green
- `pnpm --filter codev-vscode check-types`: ✓ green
- `pnpm --filter codev-vscode lint`: ✓ green (ESLint via the test pretest pipeline)
- Manual verification (at `dev-approval` gate): the human inspected the running implementation in the worktree dev server and approved.

## Architecture Updates

No changes to `codev/resources/arch.md`. This PR adds:

1. A pure view-layer grouping helper (`groupBacklogByArea`) over an existing wire shape (`OverviewBacklogItem.area`, added by #819) — no new module boundaries, no new wire fields, no new caching layers.
2. A two-level VSCode `TreeDataProvider` for the backlog view — a localized refactor of `BacklogProvider`, not a new tree-architecture pattern.

None warrant arch-doc entries — they reuse established patterns. The framework-neutrality discipline (do not bake repo-specific label names or per-repo rank policy into framework code) was already established in `codev/resources/arch.md` / lessons via #819 and remains the implicit rule this PR follows.

## Lessons Learned Updates

No additions to `codev/resources/lessons-learned.md`. Two design moves worth recording are already covered by existing project memory:

1. **Framework code stays policy-free about label values *and* about per-repo rank policy.** The first iteration hardcoded `'cross-cutting'` as a privileged top group; the human at `dev-approval` flagged it as the same anti-pattern #819 corrected at the parser. Switching to a `codev.backlog.priorityAreas` setting solved the hardcoded-label problem but introduced a new one: a configurable mechanism for what turned out to be the wrong shape (rank ≠ coordination). The architect's reconsideration during the review phase dropped the mechanism entirely. Net: alphabetical specifics + `Uncategorized` last is the simplest rule and matches `parseArea`'s policy-free posture. Same principle as [`feedback_framework_neutral_on_label_semantics`](../../.claude/projects/-Users-amrmohamed-repos-cluesmith-codev/memory/feedback_framework_neutral_on_label_semantics.md); no new lesson.

2. **Trust the wire contract; don't add defensive coercions for things the contract guarantees.** First iteration had `item.area || UNCATEGORIZED_AREA` as a defensive fallback even though the wire contract (`required-with-default`, set by `parseArea` server-side) guarantees `area` is always a populated string. Dropped the fallback and the corresponding empty-string test case. System-prompt rule applied to the view boundary — not a new lesson.

A follow-up issue was filed during this PIR:

- **#885** — `vscode: capitalize area group header labels in backlog and builders trees`. The lowercase `area/*` label convention renders headers as `vscode (12)` next to `Uncategorized (8)`; visual inconsistency this PIR did not address (it would touch the rendering layer and the same fix should land in #818's builders-tree grouping).

## Things to Look At During PR Review

1. **Three design revisions before settling**, visible in the commit history. First iteration hardcoded `'cross-cutting'` as a privileged top group. Second iteration replaced that with a per-repo VSCode setting `codev.backlog.priorityAreas`. Third iteration (this commit) dropped the configurable entirely per architect reconsideration — pure alphabetical, no priority mechanism, no setting. The final shape is the smallest possible: a render-layer grouping over an existing wire field, with one optimization (single-Uncategorized flatten) for the no-area-labels case.

2. **Single-Uncategorized flatten optimization** (`packages/vscode/src/views/backlog.ts:120-125`). When the grouped output is exactly one group AND that group is `Uncategorized`, the view skips the header and returns rows directly. This is the zero-cost migration property the issue body promised. Trigger is specifically "1 group AND Uncategorized" — a single-`vscode` repo with all items in one specific area still gets a header for clarity (the header carries the categorization signal; an `Uncategorized` header carries none).

3. **Group identity** (`BacklogGroupTreeItem.id = 'backlog-group:<areaName>'`). VSCode reuses the same TreeItem instance across `onDidChangeTreeData` refreshes when `id` matches, which keeps the user's expand/collapse state visually stable across the `OverviewCache` SSE tick. Without the stable `id`, every refresh would reset the visible expansion (the persisted state in `workspaceState` would still be honored, but the tree would flash collapsed-then-expanded on each tick).

4. **`pnpm --filter @cluesmith/codev test` showed 17 unrelated flakes on first run** (cron-cli and other agent-farm tests) that all passed on retry. The diff is 100% under `packages/vscode/` so the failures cannot be caused by this PIR. Mentioning for transparency, not as a flaky-test skip — no tests were quarantined.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-811` → **Review Diff** (auto-detects the repo's default branch). Or `git diff main...HEAD`.
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-811` from a shell.
- **What to verify**:
  - The Backlog tree shows grouped headers like `vscode (N)`, `tower (N)`, etc., ordered alphabetically with `Uncategorized` last.
  - Issue with no `area/*` labels lives under `Uncategorized` at the bottom.
  - Collapse a group, reload the VSCode window → that group stays collapsed.
  - Single-issue click → still opens via `codev.viewBacklogIssue`. Right-click → context menu actions (spawn, open in browser, copy issue number) still work.
  - On a hypothetical repo with no `area/*` labels at all, the view renders flat (no `Uncategorized (N)` header) — single-Uncategorized flatten optimization.
  - Dashboard's `BacklogList` (web): no wire changes, no breakage; still renders as a flat list.

## Flaky Tests

None skipped or quarantined.
