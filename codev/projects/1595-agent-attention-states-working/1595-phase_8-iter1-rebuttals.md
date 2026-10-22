# Phase 8, iteration 1: rebuttal

Gemini lane skipped (agy exit 3, non-blocking). Codex and Claude: REQUEST_CHANGES. Every point is addressed below. The full evidence is in `codev/state/spir-1595_thread.md` (Phase 8 run log).

## Codex

1. **SC1 / scenario 9: status bar and badge not observed on a real session.** Accepted and closed as far as this environment allows. The Electron host cannot launch here (vscode-test), so the extension's own status-bar and badge code was run headless on the live overview of a real Claude session. That is the same sequence `extension.ts` runs: the sdk's `deriveAttention` and `isIdleWaiting`, then `composeStatusBarText`, `composeStatusBarTooltip` and `composeActivityBadge` from `apps/vscode/src/mailbox-indicators.ts`. Observed:
   - While the builder worked: `Codev: 1 builders`, no badge.
   - The builder's permission prompt was drawn at 08:47:57. In the same second the bar showed `1 builders · 1 waiting` and the badge showed 1.
   - The architect's prompt (08:48:05) took them to 2. The tooltips read "architect main waiting on input".
   The only part not exercised is VS Code painting the string, which is unchanged code.
2. **arch.md said SQLite holds all structured state.** Fixed. System-Wide Patterns > State Persistence now reads "all persisted structured state" and names memory-only agent state as the deliberate exception, linking to the Agent State section.
3. **The run log is not in the review.** No change in this phase. The review artifact is written in SPIR's review phase, and no `codev/reviews/1595-*.md` exists yet. The run log is committed in the thread, and the review phase carries it over together with #1851, #1852 and the idle_prompt fix. Claude made the same point as a comment and agreed it is defensible at this phase.

## Claude

1. **BLOCKER: the e2e suite fails on the final head (3 tests in `tower-api.e2e.test.ts`, 500 "nodePty.spawn is not a function").** Investigated. The failure is pre-existing and environment-specific, not caused by this branch:
   - A fresh detached worktree of `origin/main` (51fbbcb17), built on this machine, fails the same 3 tests with the same 500. That worktree has since been removed.
   - GitHub CI (Linux) passes the same suite on `main` at 51fbbcb17 and at the merge base 91ef2e3c7.
   - Manual probes of the same requests against this branch's built Tower, with and without workspace activation and with a shellper-backed architect, return 201. The failure shows up only in the Tower process that vitest launches on this machine.
   Every other gate is green on the final head: build, unit tests (7037), sdk (187), web (518), vscode unit (1265), every package's `check-types`, the rest of the e2e suite (172 passed), and the spec-1595 Playwright suite (3/3). This is recorded in the thread for the review's Flaky/environmental section. The e2e job runs in CI on the PR, which settles it on Linux.
2. **Comment: name #1851 and #1852 in the review.** Will be done in the review phase. arch.md already names #1851 under Known limitations.
3. **Comment: nested `afx architect` inherits its parent's identity (phase 6 carry b).** Fixed rather than documented. The no-Tower path now spawns with `sanitizeAgentEnv(process.env)`, matching every Tower launch path. It strips `CODEV_BUILDER_WORKTREE`, `CODEV_ARCHITECT_WORKSPACE` and the Claude session markers. That launch sets no architect identity of its own, so its reporter sends nothing. Test: `af-architect.test.ts` "strips inherited agent identity from the spawned env".
4. **Comment: the unknown-agent full-row scan was not measured.** Measured on a read-only copy of the real `global.db` (26 builder rows across 8 workspaces): a miss costs 0.26 ms (unknown builder in a known workspace) or 0.18 ms (unknown workspace). A memoized hit costs 0.02 ms.

## Also in this iteration

- `'AskUserQuestion'` now comes from one constant, `CLAUDE_QUESTION_TOOL`, for both the PreToolUse matcher and the generated script (phase 6 carry a).
- Test orphans left by e2e runs were stopped after verification: parent pid 1, `/tmp` test sockets, test-workspace cwds. The live Tower was healthy throughout.
