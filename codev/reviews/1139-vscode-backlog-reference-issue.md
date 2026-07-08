# PIR Review: Backlog "Reference issue in architect" honors the QuickPick selection

Fixes #1139

## Summary

In multi-architect workspaces, the Backlog row's "Reference issue in architect" button (and its PR-sidebar mirror) showed a QuickPick to choose the target architect but always injected the reference text into `architect:main`, making the picker a no-op. The fix makes `codev.openArchitectTerminal` return the architect name it actually resolved (explicit arg, picker choice, or single-architect default), and both reference commands now pass that name through to `injectArchitectText`. A cancelled picker skips injection silently instead of falling back to main.

## Files Changed

- `packages/vscode/src/extension.ts` (+28 / -7): `openArchitectTerminal` returns `Promise<string | undefined>`; both reference commands capture and pass the resolved name, early-returning on undefined
- `packages/vscode/src/terminal-manager.ts` (+6 / -6): docstring only, removed the stale "the Backlog button always targets main" design claim
- `packages/vscode/src/__tests__/extension-architect-commands.test.ts` (+36 / -11): replaced the sentinel that codified the old always-main behavior with return-contract, name-pass-through, and cancel-path sentinels
- `packages/vscode/src/__tests__/reference-pr-in-architect.test.ts` (+19 / -0): mirrored sentinels for the PR-sidebar command
- `codev/plans/1139-vscode-backlog-reference-issue.md` (+65): plan artifact
- `codev/state/pir-1139_thread.md` (+20): builder thread
- `codev/resources/lessons-learned.md`: one new Architecture entry (see Lessons Learned Updates)

## Commits

- `8f34a761` [PIR #1139] Plan draft
- `2e0ca369` [PIR #1139] Honor QuickPick selection in architect reference injection
- `dd29bbbe` [PIR #1139] Thread: implement phase notes
- plus porch state-transition commits (`chore(porch): ...`)

## Test Results

- `pnpm compile` (tsc + tsc webview + eslint + esbuild): pass
- `pnpm test:unit` (vitest): pass, 47 files, 547 tests (4 sentinel tests new or rewritten)
- Manual verification: approved by the human reviewer at the `dev-approval` gate, exercising the running worktree

## Architecture Updates

No arch changes: this PR fixes command wiring inside the VS Code extension (a return value threaded between two existing commands). No module boundaries, state, or cross-subsystem contracts changed. The `injectArchitectText` `'main'` default remains for name-less callers.

## Lessons Learned Updates

One COLD-tier entry added to `codev/resources/lessons-learned.md` (Architecture section): two independently-correct changes composed into this bug. Spec 786 Phase 6 deliberately defaulted `injectArchitectText` to `'main'`; Issue 841 Gap 2 later added a QuickPick upstream in `openArchitectTerminal`. The picker's resolution was consumed for "which terminal to open" but never returned, so downstream consumers of the default silently kept the pre-picker behavior. The lesson: when adding an interactive resolution step in front of an API with a documented default, return the resolution and audit every consumer of that default.

Nothing HOT-tier: the rule is narrow to command-composition inside the extension, not a behavior-changing cross-cutting invariant.

## Things to Look At During PR Review

- The deliberate behavior change on cancel: previously a dismissed picker still attempted injection into main (surfacing a "terminal not available" warning when main's terminal wasn't registered); now a cancel exits silently. This matches the issue's fix sketch.
- Every early-out of `codev.openArchitectTerminal` now explicitly `return undefined` (not connected, picker dismissed, architect not found, workspace-state fetch failure) so callers get a uniform contract.
- The tests are source-level sentinels (the suite's established pattern, since activating the extension requires mocking the whole `vscode` module); they anchor on the new source shape rather than executing handlers.

## How to Test Locally

- **View diff**: VSCode sidebar, right-click builder pir-1139, **View Diff**
- **Run dev server**: VSCode sidebar **Run Dev Server**, or `afx dev pir-1139`
- **What to verify** (needs a workspace with 2+ architects):
  - Backlog row mention button: pick a non-main architect in the QuickPick; `#<id> "<title>" ` lands in that architect's terminal, focused, not submitted
  - Same flow picking `main`: text lands in main
  - Same flow pressing Escape: no injection, no warning
  - PR sidebar mention button: same routing behavior
  - Single-architect workspace: no picker, injects into main, unchanged
