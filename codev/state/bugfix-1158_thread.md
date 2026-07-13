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

## PR (phase 3)

Two commits (fix+test landed together in the fix commit; the test file is in it) →
pushed → **PR #1173** (Fixes #1158). porch fix-phase checks passed from main checkout
(build 4.9s, tests 20.1s). Advanced to `pr` phase. CMAP 3-way (gemini/codex/claude, type pr)
running. Next: record CMAP verdicts, notify architect, `porch done` to request the `pr` gate,
then WAIT for human approval (never self-approve).

**porch-from-where gotcha**: this project's porch state lives in the MAIN checkout's
`codev/projects/`, not the worktree. `porch status` auto-detects from the worktree, but
stateful cmds (`check`/`done`) must run from the main checkout (`cd ../.. && porch <cmd> bugfix-1158`)
or they silently no-op / error "not found".

**consult gotcha**: from this worktree, consult's project auto-detect fails ("Multiple
projects found") because the worktree's `codev/projects/` still holds all historical projects
and this one's state is in main. Disambiguate with `--issue 1158`. Also: never pipe consult to
`head` — SIGPIPE kills it before it writes `--output`.

### CMAP outcome — REQUEST_CHANGES → fixed (commit f931aa4e)

All 3 reviewers (gemini/codex/claude) independently caught the SAME real defect: my
first-pass verification grep `"Dev Server\|dev server"` was case-sensitive and missed the
mixed-case **"Dev server"** — so 4 user-facing toast strings (dev-shared.ts, stop-worktree-dev.ts)
still said "Dev server started/stopped/already running". Textbook "trust the protocol — CMAP
catches what solo review misses." Fixed all 4 + 2 comments + README.md (marketplace doc, ~15
refs, command titles were mismatching the actual palette) + pir protocol.md:137 (both trees).
Strengthened the regression guard to scan ALL menu groups + keybindings.

**Rebutted** codex's "add codev.devServer.* deprecated aliases" — the breaking rename is the
issue's explicit choice (#1158 verify #9: document the no-op, don't preserve old ids).

Re-verified: case-insensitive grep clean (only the intentional enumeration remains); 590 unit
tests pass; compile clean. Pushed, PR body corrected (the earlier "0 hits" claim was wrong for
case-insensitive), CMAP verdicts recorded. Next: notify architect, `porch done` → request `pr`
gate, WAIT for human approval.
