# PIR #789 — inject file/hunk ref into builder PTY from the unified-diff editor (codelens)

## Plan phase (iteration 1)

Investigated the vscode extension. Key findings:
- `codev.viewDiff` opens VSCode's multi-file diff editor (`vscode.changes`); right side of each file is a plain `file:` URI at `<worktree>/<relpath>` — carries new-side line numbers.
- `injectArchitectText` (`terminal-manager.ts:146`) is the inject-without-Enter precedent; no builder equivalent exists yet.
- `openBuilderByRoleOrId` opens/reveals a builder terminal but returns void and resolves roleOrId → a *canonical* id that can differ from the input → terminal key mismatch risk. Plan returns the resolved id to fix this.
- Palette suppression: just don't declare the codelens-backing command in `contributes.commands`.

### Design chosen
CodeLensProvider on the right-side `file:` documents. New pure helpers (`diff-inject-ref.ts`) for hunk parsing + ref strings; provider (`diff-inject-codelens.ts`) reads a per-`viewDiff`-run registry; `viewDiff` parses one extra `git diff --unified` to populate hunk ranges; `terminal-manager` gets `injectBuilderText` + id-returning `openBuilderByRoleOrId`; `extension.ts` registers palette-hidden `codev.injectBuilderFileRef`.

### Primary risk (to validate at dev-approval gate)
CodeLenses may not render inside the `vscode.changes` multi-diff editor (document-scoped lenses + multi-diff embedding has historical gaps). Fallback if so: same provider/registry on the per-file `vscode.diff` (`openBuilderFileDiff`). This is exactly what PIR's dev-approval gate (run the worktree) is for.

Plan written to `codev/plans/789-vscode-inject-file-hunk-refere.md`, committed. Awaiting `plan-approval`.

## Implement phase (iteration 1)

plan-approval approved. Implemented per plan, 3 commits:
- `diff-inject-ref.ts` (pure helpers: parseHunkRanges/parseUnifiedDiff/buildBuilderFileRef/buildBuilderHunkRef/buildLensDescriptors) + `diff-inject-codelens.ts` (provider, `{scheme:'file'}`, per-viewDiff-run registry) + `diff-inject-ref.test.ts` (12 tests).
- `terminal-manager.ts`: added `injectBuilderText`; `openBuilderByRoleOrId` now returns the resolved canonical id (non-breaking).
- `view-diff.ts`: one extra `git diff -M --unified=3` parsed into the registry before `vscode.changes` (patch failure non-fatal). `extension.ts`: palette-hidden `codev.injectBuilderFileRef` + `activateDiffInjectCodeLens`.

Validation: `pnpm test:unit` 372 pass (had to build core+types dist first — the 7 import-resolution failures were pre-existing unbuilt-dep, not my diff), `check-types` clean, `lint` clean, esbuild bundles.

**Primary risk still unvalidated**: whether CodeLenses render inside the `vscode.changes` multi-diff editor. Needs the human to run the worktree at the dev-approval gate. Fallback documented in plan if they don't render.

Awaiting `dev-approval`.

## Dev-approval gate — primary risk materialized, pivoted to Option A

Human tested in the Extension Dev Host. Lenses did NOT appear in the `codev.viewDiff` multi-file editor, even with `diffEditor.codeLens` enabled. Confirmed via VSCode issues #97640 / #156707: CodeLens is hidden in diff editors by default; the setting re-enables it for the **single-file** diff editor, but the **multi-file `vscode.changes` editor doesn't render CodeLens at all**. So the issue's literal surface (lenses in the viewDiff multi-file editor) is infeasible.

**Provider proven correct**: opening a changed file in a plain editor tab shows the lens on line 1. So registration + fsPath matching + rendering all work — only the multi-diff host is the blocker.

**Pivot (human chose Option A)**: surface the lenses on the **single-file `vscode.diff`** opened from the Builders tree (`codev.openBuilderFileDiff`), which honors `diffEditor.codeLens`. Changes:
- `openBuilderFileDiff` now populates the registry for its file (new `registerFileInjectSession` in view-diff.ts, `upsert` on the provider) so lenses appear without a prior View Diff run.
- New `ensure-diff-codelens.ts`: when opening a file diff with `diffEditor.codeLens` off, one-click prompt to enable it (with "Don't ask again" in globalState). Avoids shipping a feature that silently needs a hidden setting.
- viewDiff still populates the registry (harmless; future-proofs if multi-diff ever supports lenses; also powers the normal-tab case).

Validation: check-types/lint/test:unit (372) all green; esbuild bundles. **Needs human to re-test Option A**: F5 relaunch → click a changed file row in the Builders tree → single-file diff → lenses render (prompt offers to enable the setting first).

Note for review file: the spec'd surface was infeasible; should reflect the per-file-diff entry point back to the issue.

## Dev-approval iteration: hunk-lens placement fix

Human observed hunk lenses landing on the wrong function's signature. Root cause: `--unified=3` reports each hunk's new-side start up to 3 *context* lines above the first real change, so near a function boundary the anchor lands on the preceding `def`/`return`. Fixed: `parseHunkRanges` now walks the hunk body to find the first/last actually-added (`+`) new-side lines (`changeStart`/`changeEnd`); `buildLensDescriptors` anchors AND labels on those instead of the header span. Deviation from issue's literal "hunk header range" — intentional, more accurate. 374 tests green. Needs human re-test after F5 relaunch.
