# bugfix-1169 — vscode: collapse lower-priority sidebar views by default

## Investigate

**Issue**: 4 of the 7 Codev sidebar views (Pull Requests, Recently Closed, Team, Status)
default to fully-expanded on first install, crowding the primary surfaces
(Workspace, Agents, Backlog). VS Code gives no manifest lever for height ratios;
the only lever is defaulting lower-priority views to `visibility: "collapsed"`.

**Root cause**: `packages/vscode/package.json` `contributes.views.codev[]` — the four
views omit `"visibility"`, so VS Code applies the default (`visible`).

**Note on the issue snippet**: the real file's view entries carry `"when"` clauses
(e.g. `"codev.hasWorkspace"`) that the issue's simplified snippet dropped. Fix must
ADD `"visibility": "collapsed"` while PRESERVING each existing `when`.

**Precedent**: `codev.placeholder` in `codevPanel` already uses `"visibility": "collapsed"`.

## Fix

Added `"visibility": "collapsed"` to the four lower-priority views (pullRequests,
recentlyClosed, team, status), preserving each existing `when` clause. JSON validates.

**Release notes decision**: issue scoped dual-accumulate release-notes entries onto this
branch, but repo workflow keeps those on the divergent `docs/vscode-changelog` branch
(worktrees/changelog) so code + changelog branches reconcile cleanly at release. Asked
the architect/human: decision = leave changelog to that branch. This builder branch ships
ONLY the manifest fix. Architect handles CHANGELOG.md [Unreleased] + UNRELEASED.md Polish.

No unit test: declarative manifest-only change, no runtime behavior. Verify via VS Code
Extension Development Host smoke (first-install shows the 4 views collapsed to headers).

**Scope**: single declarative manifest change (4 keys added) + dual-accumulate release
notes (packages/vscode/CHANGELOG.md `[Unreleased]` + docs/releases/UNRELEASED.md Polish).
No source, no tests (declarative). Well within BUGFIX scope (<300 LOC).
