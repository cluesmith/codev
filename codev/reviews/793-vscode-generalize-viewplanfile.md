# PIR Review: vscode — generalize viewPlanFile to viewSpecFile + viewReviewFile

Fixes #793

## Summary

Generalised the existing `codev.viewPlanFile` command (previously PIR-only) into a sibling trio (`viewSpecFile` / `viewPlanFile` / `viewReviewFile`) with protocol-aware right-click menu visibility on the Builders tree. The dispatcher in `view-artifact.ts` was already kind-generic, so most of the change is declarative; the only piece of real new logic is a `-review` suffix on the row's `contextValue` driven by `readdirSync` against `<worktree>/codev/reviews/`, which the `viewReviewFile` `when`-clause keys off to hide the menu entry on PIR rows until a review file is committed. Unblocks downstream issue #792.

## Files Changed

`git diff --stat $(git merge-base main HEAD)`:

- `codev/plans/793-vscode-generalize-viewplanfile.md` (+168 / -0, new)
- `codev/reviews/793-vscode-generalize-viewplanfile.md` (+ this file)
- `packages/vscode/package.json` (+34 / -3) — two command declarations, three `view/item/context` entries, three `commandPalette: when: false` entries
- `packages/vscode/src/__tests__/menu-when-clauses.test.ts` (+125 / -0, new) — visibility matrix + commandPalette-hiding tests
- `packages/vscode/src/commands/view-artifact.ts` (+18 / -14) — widened `ArtifactKind`, added `viewSpecFile` / `viewReviewFile` wrappers, rewrote docblock
- `packages/vscode/src/extension.ts` (+5 / -1) — registered the two new commands
- `packages/vscode/src/views/builders.ts` (+50 / -7) — `-review` suffix wiring, `builderHasReviewFile` helper

## Commits

`git log main..HEAD --oneline` (implementation commits — porch's chore commits omitted):

- `af42f45c` [PIR #793] Plan draft
- `7917ed0a` [PIR #793] Generalize viewPlanFile to viewSpecFile + viewReviewFile
- `c67cc3b6` [PIR #793] Encode review-file presence in contextValue, gate PIR review menu
- `39d2720a` [PIR #793] Replace nested ternary in family assignment with if/else chain
- `cd76e38f` [PIR #793] Review file
- (follow-up commit adding the `commandPalette` hiding + restructured review file — sha lands on push)

## Test Results

- `pnpm check-types` (vscode package): ✓ pass
- `pnpm test:unit` (vscode vitest suite): ✓ pass — **78 / 78**, of which 41 are new (38 visibility-matrix cases + 3 commandPalette-hiding cases)
- `pnpm build` (vscode package, during porch's implement-phase check): ✓ pass
- **Manual verification at `dev-approval`**: reviewer exercised the worktree's VSCode extension via the architect's gate-approval flow. Approval was followed by a one-line refactor request (nested-ternary → `if`/`else if`/`else`) which was addressed in `39d2720a` and re-validated by `porch done`'s build+tests pass.
- Pre-existing failures in the broader `packages/codev/` test suite (`adopt.test.ts`, `update.test.ts`, `consult.test.ts`, `session-manager.test.ts`, real-shellper integration) — 23 tests — are **out of scope**: none of them touch any file in this diff, and per PIR protocol I do not fix unrelated red.

## Architecture Updates

No `codev/resources/arch.md` updates needed. This is an extension to the existing per-row `contextValue` menu-gating pattern (already documented in arch and exercised by `gate-toast.ts`, `approve.ts`, the existing `viewPlanFile` plumbing, etc.). No new module boundary, no new concept, no shift in how the Builders tree or `view-artifact.ts` dispatches.

## Lessons Learned Updates

No `codev/resources/lessons-learned.md` updates needed. There is one *candidate* lesson worth flagging — that a vitest matrix asserting the package.json `viewItem =~ /…/` regexes is the only structural defence against silent menu-visibility drift — but it's one data point, not yet a recurring pattern across builders. Worth re-evaluating once a second feature lands using the same pattern; premature to lift into shared lessons now.

## Things to Look At During PR Review

CMAP-2 returned **REQUEST_CHANGES** from both Gemini and Codex. Disposition below — please verify these at the `pr` gate, since PIR is single-pass and the consultation will not be re-run.

1. **Plan drift: `commandPalette` entries were missing (both reviewers).** The approved plan says: *"add three `commandPalette` entries to hide these from the command palette: they're builder-row commands and need a tree-item arg. Match the existing `codev.openBuilderRow` pattern (`when: false`)."* I deliberately deviated during implementation, thinking it matched the existing `viewPlanFile` (which is *also* missing from `commandPalette` — i.e. the existing `viewPlanFile` was itself a pre-existing drift from this convention). The deviation was unjustified — the plan is the contract, and `openBuilderById` / `openBuilderRow` / `viewBacklogIssue` / `openBuilderFileDiff` / etc. all have `when: false` palette entries for the same builder-row-arg reason.
   - **Fixed**: added three `when: false` palette entries (`package.json:265-276`) and a pinning test (`menu-when-clauses.test.ts:106-125`) that asserts each of the three commands has a palette entry with `when === 'false'`. The test would have failed before the fix; vitest now 78/78 pass.
   - **Note**: I did not separately fix the *existing* `codev.viewPlanFile` drift (which has never had a palette entry) because that pre-dates this PR and falls under the same pre-existing-state rule as the unrelated test failures. The new test only pins the three commands this PR owns.

2. **Review file completeness (codex).** Codex flagged the review file as missing PIR-required sections (Files Changed, Commits, Test Results, Things to Look At, How to Test Locally) and carrying a `TBD` placeholder for the CMAP table. The original draft was templated off `codev/protocols/spir/templates/review.md` rather than `codev/protocols/pir/prompts/review.md` — the latter is the actual section contract for PIR.
   - **Fixed**: this version of the file follows the PIR review prompt's section list and replaces the SPIR-shaped scaffold.

3. **Per-row `readdirSync` cost.** `builderHasReviewFile` does a sync `readdirSync` on `<worktree>/codev/reviews/` on every Builders-tree render. The reviews dir is small and local, and the tree already does heavier work (diff cache) on row expansion. Acceptable, but worth a glance during real-tree refreshes to confirm no perceptible lag. If profiling later shows it's a hot path, cache on the overview-data refresh boundary.

4. **Three regex `when` clauses kept in sync by hand.** The `viewReviewFile` clause uses a slightly fiddly alternation: `^(builder|blocked-builder|awaiting-builder)-((spir|aspir|air)(-review)?|pir-review)$`. The unit-test matrix is the readable source of truth; the regex is the machine encoding. Adding a fourth protocol means extending three regexes; the matrix test will catch one missed.

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-793` → **View Diff** (auto-detects default branch).
- **Run dev server**: VSCode sidebar → builder `pir-793` row → **Run Dev Server**, or `afx dev pir-793` from the main checkout root.
- **What to verify** (mapped to the plan's Test Plan + the visibility matrix in the issue):
  - In a workspace with builders across multiple protocols, right-click each builder row:
    - **SPIR / ASPIR**: all three menu entries visible (`View Spec File`, `View Plan File`, `View Review File`).
    - **PIR without a committed review file** (e.g. this very branch before the review commit, or any PIR builder still in `implement`): only `View Plan File` visible.
    - **PIR with a committed review file** (touch `codev/reviews/<pir-id>-anything.md` on a PIR builder branch, push, wait for the overview poll to pick it up): `View Plan File` + `View Review File` both visible.
    - **AIR**: only `View Review File` visible.
    - **BUGFIX / TICK**: none of the three visible.
  - **Command palette (Cmd+Shift+P)**: type `Codev: View` — none of the three commands should appear (they're all hidden via `when: false`).
  - Click each visible entry: the corresponding `.md` file opens in a preview tab (or the missing-file toast fires if it doesn't exist for the non-PIR protocols, per the existing `view-artifact.ts` behaviour).
