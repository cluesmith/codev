# bugfix-1158 — strip "dev server" terminology from VS Code surfaces

## Issue
#1158 — VS Code runnable-worktrees surfaces still say "dev server" (web-centric).
Config (`worktree.devCommand`) and CLI (`afx dev`) are already neutral; close the gap
so config → CLI → VS Code all read "dev".

## Investigate (phase 1)

Root cause: purely a naming/terminology inconsistency. No behavior bug. Scope enumerated
in the issue. Confirmed BUGFIX-appropriate — mechanical rename + doc prose, no arch change.

**Key constraint from verification criterion #6**: grep `packages/vscode/` for `devServer`
must yield ZERO hits post-fix. So internal identifiers must ALSO be renamed (not just
ids/titles/files): `stopDevServer`→`stopDev`, `restartDevServer`→`restartDev`,
`DevServerTreeProvider`→`DevTreeProvider`, `devServerProvider`→`devProvider`,
`devServerView`→`devView`, and the auto view-focus cmd `codev.devServer.focus`→`codev.dev.focus`.

### Change map (packages/vscode)
- **package.json**: strip "Server" from 6 titles; `codev.devServer.*`→`codev.dev.*` (5 cmds
  + palette + menus); ctx key `codev.devServerRunning`→`codev.devRunning`; view id
  `codev.devServer`→`codev.dev`.
- **extension.ts**: imports, createTreeView view id, setContext key, cmd registrations,
  focus cmd, internal var/class names.
- **File renames**: commands/dev-server-actions.ts→dev-actions.ts, views/dev-server.ts→dev.ts,
  views/dev-server-format.ts→dev-format.ts, __tests__/contributes-dev-server.test.ts→
  contributes-dev.test.ts, __tests__/dev-server-format.test.ts→dev-format.test.ts.
- Comment/prose cleanups: terminal-manager.ts, command-relay.ts, load-worktree-config.ts,
  dev-shared.ts, run/stop-*-dev.ts, views/workspace.ts, remaining test comments.

### Docs (dual-tree mirror)
- AGENTS.md / CLAUDE.md (byte-identical) — "Runnable Worktrees" section, sharpen prose so
  non-web users don't self-exclude (enumerate cargo run / expo start / test watcher / build).
- codev-skeleton/AGENTS.md + CLAUDE.md — same edits.
- codev-skeleton/protocols/pir/{protocol.md, prompts/implement.md, prompts/review.md} + codev/ mirrors.

### CHANGELOG (per convention)
- packages/vscode/CHANGELOG.md + docs/releases/UNRELEASED.md — note the rename + keybinding
  backward-compat break (old `codev.devServer.*` ids silently no-op post-upgrade).

Est. well under 300 LOC of logic (mostly mechanical). Historical prose (projectlist, plan 975)
left UNCHANGED per §6.

## Fix (phase 2) — DONE

Applied the full rename. Result: grep `packages/vscode/` for `devServer` / `Dev Server` /
`dev-server` = ZERO hits (verification #6 ✓). Also updated `codev/resources/arch.md` (living
reference, not historical) whose #921 bullets named the now-dead `codev.devServer` view /
`codev.devServerRunning` key / `views/dev-server-format.ts`. Left historical records untouched:
`codev/plans/921`, `codev/plans/1104`, `codev/reviews/921`, `codev/state/pir-921_thread.md`,
projectlist, plan 975.

**Regression guard**: the renamed `contributes-dev.test.ts` now asserts the new `codev.dev.*`
ids / `codev.devRunning` key / `codev.dev` view, PLUS a new `#1158` describe block that fails
if any command title contains "Server" or any id/view/when-clause contains "devServer". That
directly encodes verification criteria #1 and #6 as a permanent guard.

**Backward-compat break (document in PR body)**: old keybindings on `codev.devServer.stop` /
`.restart` etc. silently no-op post-upgrade; view id `codev.dev` invalidates any user override
of the old `codev.devServer` view visibility. Both minor, per-user. Flagged to architect for
the VS Code CHANGELOG (updated separately on the changelog branch per repo convention).

**Verification**: `pnpm test:unit` = 588 passed / 51 files; `pnpm compile` (check-types + lint
+ esbuild) = exit 0. Had to build workspace deps first (codev-core, codev-types,
artifact-canvas) — fresh worktree ships them unbuilt; those pre-existing module-resolution
errors were NOT from this change.

**Scope note**: did NOT touch packages/vscode/CHANGELOG.md — vscode changelog is accumulated
on the dedicated changelog branch by the architect after cleanup (repo convention), not in
feature/bugfix PRs. Surfaced the migration note in the PR body + architect notification instead.
