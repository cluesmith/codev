# PIR Review: Windows console window flashes while an agent works

Fixes #1919

## Summary

On native Windows a console window flashed about twice a second while an agent worked in a VS Code Codev terminal. Tower, started detached, has no console, so every console program it spawned without `windowsHide` got a visible window of its own. The VS Code Team view refreshed on every Tower SSE event (about one per agent tool call), and each refresh made Tower run an unhidden `git remote get-url origin`. This PR hides every spawn reachable from Tower, `afx spawn` / `afx tower` and the extension host, makes the Team view fetch on SSE only while visible and at most every 30 s, caches the origin lookup, and adds a guard test that fails CI on any new unhidden spawn in those import graphs.

## Files Changed

- `apps/vscode/src/__tests__/cli-process.test.ts` (+32 / -3)
- `apps/vscode/src/__tests__/team-view-refresh.test.ts` (+161 / -0)
- `apps/vscode/src/activity-hooks.ts` (+1 / -0)
- `apps/vscode/src/cli-process.ts` (+29 / -1)
- `apps/vscode/src/clipboard-image.ts` (+3 / -1)
- `apps/vscode/src/commands/approve.ts` (+2 / -5)
- `apps/vscode/src/commands/cleanup.ts` (+2 / -5)
- `apps/vscode/src/commands/press-cursor-ref.ts` (+1 / -1)
- `apps/vscode/src/commands/view-diff.ts` (+7 / -7)
- `apps/vscode/src/extension.ts` (+6 / -1)
- `apps/vscode/src/review-queue/store.ts` (+1 / -1)
- `apps/vscode/src/views/team.ts` (+100 / -3)
- `codev/plans/1919-windows-console-window-flashes.md` (+216 / -0)
- `codev/projects/1919-windows-console-window-flashes/status.yaml` (porch state)
- `codev/resources/arch.md` (Platform Layer: console windows)
- `codev/resources/lessons-learned.md` (Debugging: reproduce through the user's launch path)
- `codev/reviews/1919-windows-console-window-flashes.md` (this file)
- `codev/state/pir-1919_thread.md` (+15 / -0)
- `packages/codev/src/__tests__/issue-1919-hidden-spawns.test.ts` (+98 / -0)
- `packages/codev/src/__tests__/windows-console-spawn-guard.test.ts` (+264 / -0)
- `packages/codev/src/agent-farm/__tests__/tower-cron.test.ts` (+3 / -1)
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` (+1 / -0)
- `packages/codev/src/agent-farm/commands/tower.ts` (+3 / -0)
- `packages/codev/src/agent-farm/servers/architect-session-holder.ts` (+1 / -0)
- `packages/codev/src/agent-farm/servers/ide-server.ts` (+1 / -0)
- `packages/codev/src/agent-farm/servers/tower-cron.ts` (+3 / -0)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+1 / -0)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+2 / -0)
- `packages/codev/src/agent-farm/servers/tower-utils.ts` (+9 / -0)
- `packages/codev/src/agent-farm/utils/config.ts` (+1 / -0)
- `packages/codev/src/agent-farm/utils/shell.ts` (+3 / -0)
- `packages/codev/src/commands/porch/artifacts.ts` (+6 / -2)
- `packages/codev/src/lib/github.ts` (+1 / -1)
- `packages/codev/src/lib/platform/posix/command-launch.ts` (+6 / -0)
- `packages/codev/src/lib/platform/posix/processes.ts` (+3 / -0)
- `packages/codev/src/lib/team-github.ts` (+31 / -3)
- `packages/codev/src/terminal/session-manager.ts` (+1 / -0)

## Commits

- `cb9ed631b` [PIR #1919] Plan draft
- `02069be72` [PIR #1919] Hide Tower and afx spawn child processes on Windows
- `2d962115f` [PIR #1919] Hide extension-host child processes on Windows
- `2d1717a1f` [PIR #1919] Team view: fetch on SSE only while visible, at most every 30s
- `cfe9dc873` [PIR #1919] Guard: spawns reachable from a console-less process must be hidden
- `f46988d00` [PIR #1919] Thread: implement phase
- `0bb21438f` Merge origin/main (5bce03080) into builder/pir-1919, no conflicts
- `543bc21e4` [PIR #1919] Review + retrospective
- a follow-up commit: bound and de-prompt the hidden `git fetch` (consultation finding)
- plus porch state commits

## Test Results

- `npm run build`: ✓ pass
- `npm test` (`packages/codev`, native Windows, run alone): ✓ 402 files / 8035 tests passed, 247 skipped, 0 failed. Porch's tests check passed at dev-approval (130 s).
- New tests: `windows-console-spawn-guard.test.ts` (6: the graph guard plus scanner fixtures), `issue-1919-hidden-spawns.test.ts` (6), `team-view-refresh.test.ts` (7), 2 new `cli-process` tests; `tower-cron.test.ts` asserts `windowsHide`.
- `apps/vscode` check-types: ✓ clean.
- Windows workflow on this branch: https://github.com/cluesmith/codev/actions/runs/44258108002 (1 failure: `tower-lifecycle.windows` scenario 5, `read ECONNRESET`, Node 24 only; the same flaky file seen on #1926 and #1928). Re-run on `eba684309`: https://github.com/cluesmith/codev/actions/runs/44259502725, all jobs passed.
- Manual verification: the owner ran the branch on native Windows and approved it at the dev-approval gate.

## Architecture Updates

COLD `codev/resources/arch.md`, Platform Layer: new **Console windows** bullet. A detached Tower has no console; every spawn reachable from Tower, `afx spawn` / `afx tower` and the extension host passes `windowsHide` or carries a `// windows-console: <reason>` comment, enforced by the guard test; the extension spawns CLIs through `cli-process.ts`. Not HOT: it governs spawn sites, not every change.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`, Debugging: reproduce through the user's launch path. Spec 1658's check passed because a Tower started from inside a codev session inherits a hidden console through the CIM launch path; a user's Tower has none. How a process was launched decides what its children inherit, and a static guard beats a manual check that depends on it.

## Things to Look At During PR Review

- **`sessionHasLiveHolder` on Windows skips the `ps` probe and returns false** when no detector is injected (`tower-utils.ts`). The architect asked to prefer the process census; I did not, because the census is async and the function sits under the synchronous `resolveArchitectLaunch`. What returning false changes for architect launch: nothing in production. Every production caller passes its own detector: both `tower-instances.ts` call sites pass the census-backed `reconcileArchitectSessionHolder`, and `resolveArchitectRestart` passes `() => false`. Only tests reached the default `ps` path, and on Windows it ran a `ps` that does not exist there.
- **Team view refresh policy** (`apps/vscode/src/views/team.ts`). It fetches immediately when it becomes visible, on connect while visible, and on manual refresh. SSE-driven fetches happen only while visible, throttled to one per 30 s with a trailing fetch, and never two at once. The Team view now uses `createTreeView` (so it can see visibility) instead of `registerTreeDataProvider`.
- **`getRepoInfo` caches the origin for 5 minutes per cwd**; a missing origin (or a transient git failure) only for 45 s, so a workspace that gains `origin` shows Team data soon. Expired entries are deleted. The cache registers a reset (`registerTestReset` in `lib/test-env.ts`) that the shared `vitest-setup.ts` runs before every test, so cached origins cannot leak between tests.
- **The guard test** (`windows-console-spawn-guard.test.ts`) uses the TypeScript compiler API. It walks relative imports from `tower-server.ts`, `commands/spawn.ts`, `commands/tower.ts` and `apps/vscode/src/extension.ts`, and checks every `child_process` call (named imports, dynamic-import destructuring, `promisify` aliases, same-file object literals) for `windowsHide` or a `// windows-console:` comment. It cannot see spawns through an injected function (for example `clipboard-image.ts`'s `deps.spawn`), so those carry the comment by hand.
- **Adjacent fix:** VS Code's approve and cleanup commands called bare `execFile('porch'|'afx')`, which cannot run npm `.cmd` shims on Windows. They now use the new `execCodevCli`, which resolves the shim and hides the window.
- **Comment-only edits in POSIX-only files** (`lib/platform/posix/*`, the `ps`/`pgrep`/`tail` sites, `activity-hooks.ts`): those calls never run on Windows and carry a `// windows-console:` comment for the guard. No behaviour change.
- **Hidden `git fetch` in `GitRefResolver`** (`artifacts.ts`). Hiding it meant a Git Credential Manager prompt could no longer be seen or answered, and the fetch had no timeout, so it could hang porch. It now runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and a 60 s timeout; a failed or timed-out fetch falls into the existing warning and the locally cached ref is read. Raised by the Claude consultation; regression test in `issue-1919-hidden-spawns.test.ts`.
- **Architect review fixes** (all in this PR):
  - `porch` and `afx cleanup` now run hidden from the extension (`execCodevCli`), so their graphs (`commands/porch/index.ts`, `agent-farm/commands/cleanup.ts`) are guard entry points. That surfaced `porch`'s `notify.ts` (`afx send` after `porch approve`), `checks.ts` (`git branch`), `state.ts` (`git add/commit/push` of status.yaml) and `cleanup.ts`'s POSIX `ps`; all now hidden or annotated. The status push also sets `GIT_TERMINAL_PROMPT=0`, so it fails instead of waiting on a prompt no one can see.
  - The guard accepts only the literal `windowsHide: true` (not `false`, a variable or a shorthand).
  - `GIT_FETCH_TIMEOUT_MS` moved above `GitRefResolver`'s doc comment.
  - arch.md: a hidden child can never prompt, so anything that might must be non-interactive.
  - Follow-up filed: #1933 (detect new console-less entry points instead of a hand-maintained list).
- **Consultation (single pass):** Claude APPROVE; Codex COMMENT (its sandbox could not read the files, no issues raised); Gemini COMMENT (lane skipped, `agy` not installed). Claude's other non-blocking notes: the guard's limits are now stated in its header; `spawnDetached`'s `windowsHide` is a no-op next to `detached` and now says so; `getRepoInfo` has no in-flight dedupe and caches a missing origin for 5 minutes (accepted); `TeamProvider.dispose()` is untested (accepted); a Windows cron command that deliberately opens a window now runs hidden (intended: cron runs unattended).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1919 → **View Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1919`
- **What to verify** (native Windows):
  - Restart Tower from a non-codev shell (`afx tower start`), so it has no console.
  - Run an agent turn with the Team view expanded, then collapsed: no console window.
  - Watch a cron run: no window.
  - Keep a dashboard file tree open for at least 30 s: no window.
  - In VS Code: spawn a builder, view a diff, approve a gate, paste a clipboard image: no window, and each works.
  - On macOS/Linux: behaviour unchanged, the Team view still updates while visible.

## Flaky Tests

None seen on the final runs. An earlier `porch done` tests check failed while it overlapped another builder's full-suite run; porch truncated the output, so the failing tests are unknown. The solo re-run passed in full. Known load-dependent Windows failures are tracked in #1923.

- `packages/codev/src/__tests__/tower-lifecycle.windows.test.ts`, scenario 5 ("a row whose shellper pid was reused is refused and removed"): `read ECONNRESET` on the Windows workflow, Node 24, run 44258108002; passed on Node 22 and on the re-run.
