# Unreleased

<!--
  TEMPLATE — copy to docs/releases/UNRELEASED.md at the start of each release cycle:

      cp docs/releases/UNRELEASED.template.md docs/releases/UNRELEASED.md

  Edit UNRELEASED.md across the cycle (the working copy). NEVER edit this
  template directly — it's the cold-start structure, untouched between cycles.

  Per-PR architect workflow (on the docs/vscode-changelog branch):
    1. cd worktrees/changelog                       # no fetch / no rebase — branches diverge by design
    2. Add the CHANGELOG entry to packages/vscode/CHANGELOG.md under [Unreleased]
       (add the [Unreleased] heading if it's missing — post-release state removes it)
    3. Add the matching release-notes entry to UNRELEASED.md under the right section:
         substantive change → its own ## section
         small vscode item  → Polish
         non-vscode change  → Other fixes
    4. Commit both files together; plain `git push` (fast-forward, no force)

  Why no rebase, ever: main moves with code merges, docs/vscode-changelog moves
  with changelog/release-notes entries — neither branch touches the other's
  files, so they diverge by design and reconcile at release time via merge.
  Rebasing rewrites commit hashes and forces force-pushes for zero real benefit.

  At release time:
    1. Rename the title to `# vX.Y.Z <Codename>` and add `Released: YYYY-MM-DD`
    2. Replace this entire comment block with the release Summary paragraph
       (one paragraph framing what shipped — lead with the biggest story)
    3. Fill in the Contributors section at the bottom
    4. git mv docs/releases/UNRELEASED.md docs/releases/vX.Y.Z-<codename>.md
    5. Commit, plain push, merge to main alongside the version bump
    6. Re-cp the template back to UNRELEASED.md to start the next cycle
-->

## IDE-mode foundation: dual-mode activation, empty-window surfaces, no more dead actions

(#1144, PR #1148)

Two changes shipped as one layer for the Codev extension.

First: the Workspace section (Architects / Spawn Builder / New Shell) is now gated on `vscode.workspace.workspaceFolders?.length > 0`. Open VS Code with no folder and those rows go quiet instead of pretending Codev is ready to act on an implicit workspace. Empty-view content ("Open a folder to use Codev") takes their place — the same pattern VS Code's own Source Control and Explorer views use for the no-folder state.

Second: a pair of context keys, `codev.hasWorkspace` (whether a folder is open) and `codev.ideMode` (whether the extension is running inside the Codev IDE fork, detected via `vscode.env.appName === 'Codev'`), model the extension's four operating quadrants explicitly. Under `onStartupFinished` activation — required so the extension can serve the fork's every-window case — the guest+no-codev-workspace quadrant is provably inert: no Tower spawn, no UI mutation, no state writes. Marketplace users opening non-codev projects see zero side-effects from having the extension installed, verified by a marketplace-inertness test as part of the PIR review.

In the Codev IDE fork, the `ideMode && !hasWorkspace` quadrant focuses the Codev container on startup, shows Open Folder / Open Recent welcome content, and fires a one-time first-run notification pointing at the CLI-preflight walkthrough. That empty-window surface doubles as the fork's welcome experience — the fork strips VS Code's core onboarding, so this is what users land in on first launch.

## Polish

- **Backlog: "Reference issue in architect" honors the architect QuickPick selection** (#1139, PR #1157). Previously the inline reference button in a multi-architect workspace would show a QuickPick to pick the target architect, then inject the reference into `architect:main` regardless of the pick — the picker was effectively a no-op for the injection. Now the picked architect name flows through to `injectArchitectText`, so the QuickPick selection actually determines which terminal receives the reference. Same fix applied to the sibling "Reference PR in architect" command on Pull Request rows. Single-architect workspaces unchanged — no picker shown, default routing preserved.

## Other fixes (dashboard, porch, infrastructure)

- **Codex CMAP lane restored on macOS 26** (#1128, PR #1141). Bumps the bundled codex vendor to a signature Apple hasn't revoked. The previous vendored binary's certificate had been revoked by Apple, and macOS 26 XProtect enforces the revocation by SIGKILL'ing the binary at exec time and auto-Trashing it — every `consult -m codex ...` first-run failed with SIGKILL, and subsequent runs failed with `ENOENT` once the binary was gone. The new vendor ships the same tool with a fresh, non-revoked signature (verified via `spctl` and end-to-end round-trip on macOS 26). Any consult protocol that includes a codex lane (PIR CMAP-2, SPIR CMAP-3, general `consult -m codex`) is unblocked again.
- **VS Code extension prepublish builds all workspace dependencies** (#1154, PR #1155). The extension's `vscode:prepublish` script was only building two of its three `workspace:*` dependencies, so a fresh clone → `pnpm install` → `pnpm --filter codev-vscode run check-types` failed with `TS2307: Cannot find module '@cluesmith/codev-artifact-canvas'`. New contributors and CI cold caches hit this. Switched to a topological filter (`pnpm --filter 'codev-vscode^...' build`) that builds the whole workspace-dep graph — future-proof against any new workspace dep re-introducing the same bug.
- **`afx workspace recover` preserves per-builder architect attribution** (#1140, PR #1156). Previously, respawning builders after a Tower recovery event lost each builder's original owning architect — every revived builder got re-attributed to whichever architect owned the shell that ran `afx workspace recover`. Sibling-architect workspaces would lose their per-team builder rosters on the first post-crash recovery pass. Now the recover flow reads each builder's original owning architect from Tower state and preserves it across the respawn, so multi-architect workspaces come back with the correct ownership graph intact.

## Breaking changes

None.

## Install

```bash
npm install -g @cluesmith/codev@X.Y.Z
afx tower stop && afx tower start
```

The VS Code extension ships separately via the Marketplace — `Codev` extension by `cluesmith.codev`, version `X.Y.Z`.

## Contributors

<!-- Filled at release time. Use the topic-first voice from prior release notes:
       - **<Name> (@<handle>)** — <topic>: <what they did across which PRs>.
       - Builders working under AIR / BUGFIX / PIR / SPIR protocols across the PRs in this release.
     Source: git log v<prev>..HEAD --merges --pretty=format:"%h %an %s" -->
