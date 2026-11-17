# air-1608 thread: vscode engine floor ^1.105 -> ^1.128

## 2026-10-05 implement

- `engines.vscode` `^1.105.0` -> `^1.128.0`.
- Deviation from the issue: `@types/vscode` 1.128.x was never published on npm (1.125.0 jumps
  to 1.134.0). Pinned `~1.125.0`, the newest typings that do not exceed the floor (vsce refuses
  typings newer than `engines.vscode`). The 1.126-1.128 API delta is therefore not type-checked.
- Deprecation pass: diffed `@types/vscode` 1.105.0 vs 1.125.0 `index.d.ts`. Additive only: no
  removed declarations, no new `@deprecated`. The comments, terminal, tree, webview-view and
  commands surfaces are unchanged apart from doc wording; `WebviewPanel.iconPath` widened to
  `IconPath` (compatible). Remaining changes are language-model/chat, QuickInputButton, l10n.
- `afx send architect` from the worktree failed: "Cannot resolve canonical builder id ... no
  matching builder row" (worktree not registered in global.db).
- Checks: check-types, lint, vitest (87 files / 1045 tests), esbuild production build,
  `vsce package` all green.
- `pnpm test` (vscode-test integration harness, not run in CI) cannot launch VS Code 1.140:
  pinned `@vscode/test-electron` ^2.5.2 spawns `Contents/MacOS/Electron` but the bundle ships
  `Code` (ENOENT). A local symlink workaround gets SIGKILLed (breaks the bundle signature).
  Pre-existing harness issue, independent of the engine bump; left out of scope.
