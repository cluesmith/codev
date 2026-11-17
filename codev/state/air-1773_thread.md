# air-1773 thread

- 2026-10-05: Implemented #1773. `apps/vscode/package.json` gains a new `contributes.configurationDefaults` block (none existed) with `"comments.openView": "never"`; manifest test `src/__tests__/contributes-configuration-defaults.test.ts` asserts the value and that it is the only override. Commit 7cc6604e7.
- Worktree needed `@cluesmith/codev-types`, `codev-sdk`, `codev-artifact-canvas` built before the vscode vitest suite / check-types would run (28 files failed on unresolved packages until then; build prerequisite, not a regression).
- Dev-host verification (lane brief point 2) could NOT be performed from this builder session: launching `code --extensionDevelopmentPath ...` with an isolated `--user-data-dir` never opened a window and `screencapture` reported "could not create image from display", sandboxed or not. The session has no window-server access. Scratch probe extension (creates a Comments API thread, logs `inspect('comments.openView')`) is ready for a human run. Flagged to architect:vscode.
- No CMAP: purely declarative manifest change.
