# PIR Review: Gate builder-row Run/Stop Dev Server menu on `worktree.devCommand`

Fixes #975

## Summary

The builder-row **Run/Stop Dev Server** context-menu entries used to show on every builder row regardless of whether `worktree.devCommand` was configured, so picking one ran against a missing command (error toast or no-op). This PR gates those entries — plus the dev keybindings and the workspace-dev command-palette entries — on a new `codev.hasDevCommand` context key. The key is refreshed by global signals in `extension.ts` (`onStateChange` + the `worktree-config-updated` SSE), mirroring the Workspace view's own dev-row gate, so all three gated surfaces stay live — including the keybindings/palette, which are invokable independent of the Builders tree's visibility. A shared `hasRunnableDevCommand()` helper backs both the key and the Workspace view's Start-row gate, also fixing a latent empty-string bug.

## Files Changed

- `packages/vscode/src/extension.ts` (+32 / -0) — `syncHasDevCommandContext()` refreshing the context key on `onStateChange` + the `worktree-config-updated` SSE envelope, plus an initial seed
- `packages/vscode/src/load-worktree-config.ts` (+18 / -0) — `hasRunnableDevCommand()` helper (single source of truth)
- `packages/vscode/src/views/workspace.ts` (+~12 / -~11) — Start-row gate switched from `devCommand !== null` to `hasRunnableDevCommand(worktreeConfig)`
- `packages/vscode/package.json` (+22 / -4) — `&& codev.hasDevCommand` on the two builder-row dev `when` clauses; `when` gating on the two dev keybindings; commandPalette entries (workspace-dev → `codev.hasDevCommand`, builder-row dev → `false`)
- `packages/vscode/src/__tests__/has-runnable-dev-command.test.ts` (+47 / -0, new) — helper truth table
- `packages/vscode/src/__tests__/menu-when-clauses.test.ts` (+67 / -0) — `when`-shape assertions for the gating across menu / palette / keybinding surfaces

## Commits

- `4c856a92` [PIR #975] Gate builder-row Run/Stop Dev Server menu on worktree.devCommand
- `50a66686` [PIR #975] Group BuildersProvider parameter-properties together
- (final) [PIR #975] Use global onStateChange + SSE refresh for hasDevCommand (consult REQUEST_CHANGES)

## Test Results

- `pnpm build`: ✓ pass (porch check, 6.3s)
- `pnpm test`: ✓ pass (porch check, 20.8s)
- `pnpm check-types`: ✓ clean
- `pnpm test:unit`: ✓ 276 tests pass (21 files), incl. 2 new test files
- `eslint` (changed files): ✓ clean
- Manual verification: performed by the human at the `dev-approval` gate against the running worktree — builder-row entries hidden with no `devCommand`, present with one, live after a config edit; Workspace view unaffected. **Note:** dev-approval was on an earlier render-path implementation; the refresh mechanism was changed post-gate (see "Things to Look At") — the user-facing menu behavior is unchanged and now extends correctly to the keybindings/palette.

## Architecture Updates

No `arch.md` changes needed. This PR fixes a UI-gating bug within the existing VSCode TreeView + `when`-clause / setContext pattern; it introduces no new module boundary or architectural pattern. The `codev.hasDevCommand` refresh mirrors the established global context-key pattern in this extension — `WorkspaceProvider`'s own dev-row gate (`onStateChange` + `worktree-config-updated` SSE) and the builders-tree setting keys (`codev.buildersAutoCollapse`, `codev.buildersGroupBy`), which are driven by global `vscode.workspace.onDidChangeConfiguration` listeners. The key is refreshed by global signals — not the tree render path — because the keybindings and palette entries it also gates are invokable independent of the Builders tree's visibility.

## Lessons Learned Updates

No addition to `codev/resources/lessons-learned.md`. The transferable observation — *a context key shared by surfaces with different lifecycles (an ephemeral tree context menu vs. global keybindings/palette) must be refreshed on the cadence of the most demanding surface; a render-path refresh that fits the menu silently breaks the global surfaces* — is the heart of this PR's review back-and-forth and is captured in the code comments + the "Things to Look At" note below, not broad enough to warrant a standing lessons entry.

## Things to Look At During PR Review

- **Consult finding + disposition (REQUEST_CHANGES → fixed).** The PR-stage 3-way consult split 2 REQUEST_CHANGES (Gemini, Codex; HIGH) vs 1 APPROVE (Claude). Both dissents were correct and the same: an earlier implementation refreshed `codev.hasDevCommand` from the Builders-tree render path, which left the **global** keybindings (`cmd+alt+r`/`s`) and workspace-dev palette entries stale when the Builders tree wasn't rendered (e.g. collapsed) — `cmd+alt+r` could silently no-op with a `devCommand` configured. **Disposition: fixed**, not rebutted — the refresh was moved to global signals (`onStateChange` + `worktree-config-updated` SSE) in `extension.ts`, mirroring `WorkspaceProvider`. All three surfaces are now live and consistent. Gemini also correctly flagged a factual error in an earlier draft of this review (it claimed the render-path was "consistent with" `buildersAutoCollapse`/`buildersGroupBy`, which are actually `onDidChangeConfiguration`-driven) — corrected above. PIR is single-pass, so this fix was **not** independently re-reviewed by the models; please verify it at the `pr` gate.
- **Coverage note (Codex's ask).** The testable unit — the value computation `hasRunnableDevCommand` — is fully covered (truth table incl. empty/whitespace). The menu/keybinding/palette `when`-clause contract is pinned in `menu-when-clauses.test.ts`. The event-wiring itself (which signals trigger the refresh) is activation-time VSCode glue: it mirrors `WorkspaceProvider`'s already-trusted, identical `onStateChange` + `worktree-config-updated` filter, and like all such glue in this extension is exercised by the vscode-test integration harness / manual run rather than vitest. No brittle vscode-mock unit test was added for it.
- **Empty-string semantics.** `hasRunnableDevCommand` treats `"devCommand": ""` / whitespace as absent, matching `dev-shared.ts`'s `if (!devCommand)` runnability gate. This also changes the Workspace view's Start-row gate (previously `devCommand !== null`, which would have shown a Start row for `""` that errors on click) — a latent bug fix. Confirm no Workspace-view regression.
- **Builder-row dev palette entries pinned `when: false`.** They need a tree-row argument; argless palette invocation falls through (same rationale as `viewSpecFile`/`viewPlanFile`/`viewReviewFile`). This is a behavior change — before this PR they had no palette entry and so defaulted to visible.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-975` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-975`
- **What to verify**:
  - With no `worktree.devCommand` in `.codev/config.json`: right-click a builder row → **no** Run/Stop Dev Server entries.
  - Add `"devCommand": "pnpm dev"` and save: entries appear live (no window reload), via the `worktree-config-updated` SSE.
  - Remove it again / set it to `""`: entries hidden live.
  - Workspace view Start/Stop rows behave as before across the same edits.
  - Keybinding `cmd+alt+r` is silent with no dev command (even with the Builders tree collapsed); starts dev with one — verify both tree-collapsed and tree-expanded states.
