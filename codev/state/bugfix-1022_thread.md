# Builder thread: bugfix-1022

VSCode dev config: exclude `.builders/` + `node_modules` from watch/search; drop Extension Test Runner recommendation (issue #1022).

## Investigate

Confirmed both pieces of the root cause by inspection:

- `.vscode/extensions.json` recommends `ms-vscode.extension-test-runner`. On workspaces with builder worktrees, its test discovery runs `rg --no-ignore --follow` globs that walk every `.builders/*/node_modules` pnpm symlink farm, pegging CPU.
- `.vscode/settings.json` has no `files.watcherExclude` block at all, and its `search.exclude` only covers `packages/*/out|dist` — nothing for `.builders/` or `node_modules`.
- `packages/vscode/vsc-extension-quickstart.md` line 14 tells devs to install recommended extensions including the test runner (and `amodio.tsl-problem-matcher`, which was never in `extensions.json`).

This is a config-only fix; no reproduction beyond inspection is possible or needed (the bug manifests as VSCode-host `rg` process storms, environmental).

Plan for fix phase:
1. Add `files.watcherExclude` and extend `search.exclude` in `.vscode/settings.json` with `**/.builders/**` and `**/node_modules/**`.
2. Remove `ms-vscode.extension-test-runner` from `extensions.json` recommendations (keep eslint + esbuild-problem-matchers; keep the file).
3. Fix quickstart line 14 to match actual recommendations. Keep the "Run tests" section's manual install link — installing the test runner deliberately when working on extension tests is still valid; the bug was the blanket recommendation.

No regression test is practical for editor config JSON; the verification is the config content itself.
