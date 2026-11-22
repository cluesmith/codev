# PIR Review: Windows never runs a program from the current folder

Fixes #1911

## Summary

On Windows, a program started by bare name (`git`, `gh`, `npm`, `codev`) is looked up in the current folder before `PATH`, so a `git.exe` committed to a repository ran in place of Git whenever Codev ran `git` there. Every Codev process now imports `lib/process-bootstrap.ts` first, which on Windows sets `NoDefaultCurrentDirectoryInExePath=1` (`lib/platform/windows/exe-search.ts`); libuv and `cmd.exe` both honor it, and everything Codev starts inherits it, including every terminal Tower opens. With the hole closed, the native-Windows "preview" wording is removed from the README and both `DEPENDENCIES.md` copies.

**What is covered:**

- Every Codev process: the six commands (`codev`, `afx`, `porch`, `consult`, `team`, `generate-image`), the Tower server and shellper. A guard test fails if a new command does not import the bootstrap first.
- Everything those processes run, through inheritance (`child_process` spawns and `execSync` strings through `cmd.exe`).
- **Every terminal Tower opens**: architect and builder sessions (Claude Code, Codex, agy) and human shell tabs alike (owner decision: no carve-out). Persistent terminals are built from Tower's own environment; the non-persistent fallback (used only when shellper is unavailable) starts from the `windowsPtyBaseEnv` allowlist, which now sets the variable explicitly.
- The VS Code extension: its host is shared with other extensions, so it does not set the variable; instead `cli-process.ts` refuses a `codev`/`afx`/`porch` name that does not resolve on `PATH`, rather than letting Windows find a same-named file in the workspace. Spawn Builder then shows "afx was not found on PATH" instead of an unhandled error.

**User-visible change (`cmd.exe`):** in a `cmd.exe` session inside a Codev terminal, a program in the current folder no longer runs by bare name; `.\name` still runs it. PowerShell, the default Windows shell, already works this way. Verified on the host: `cmd.exe` runs a planted `git.exe` by default, the real Git with the variable set, and the planted file again as `.\git`.

**Known effect on other tools:** a .NET 10 NativeAOT `dotnet publish` fails inside a Codev terminal, because Visual Studio's `vcvarsall.bat` does not support the setting ([dotnet/runtime#129340](https://github.com/dotnet/runtime/issues/129340), closed as fixed in .NET 11; confirmed by reading the issue, not reproduced here). Documented in `DEPENDENCIES.md`; nothing else is done about it.

**Not changed:** node-pty does its own `PATH`-only lookup and never searches the terminal's folder, so the PTY launch path needed nothing (measured: a bare unresolvable name fails with "File not found"). A relative `.` entry in the user's own `PATH` is still searched; that is the user's configuration.

## Files Changed

- `README.md` (+1 / -1)
- `apps/vscode/src/__tests__/cli-process.test.ts` (+44 / -2)
- `apps/vscode/src/__tests__/spawn-builder-not-found.test.ts` (new)
- `apps/vscode/src/cli-process.ts` (+34 / -2)
- `apps/vscode/src/commands/spawn.ts` ('error' listener)
- `codev-skeleton/DEPENDENCIES.md` (+8 / -7)
- `codev/DEPENDENCIES.md` (+8 / -7)
- `codev/plans/1911-windows-bare-name-user-tool-sp.md` (+147 / -0)
- `codev/resources/arch.md` (Platform Layer: process bootstrap)
- `codev/resources/lessons-learned.md` (Testing: two lessons)
- `codev/reviews/1911-windows-bare-name-user-tool-sp.md` (this file)
- `codev/state/pir-1911_thread.md` (+30 / -0)
- `packages/codev/bin/afx.js` (+2 / -0)
- `packages/codev/bin/codev.js` (+2 / -0)
- `packages/codev/bin/consult.js` (+2 / -0)
- `packages/codev/bin/generate-image.js` (+2 / -0)
- `packages/codev/bin/porch.js` (+2 / -0)
- `packages/codev/bin/team.js` (+2 / -0)
- `packages/codev/src/__tests__/process-bootstrap.test.ts` (+80 / -0)
- `packages/codev/src/__tests__/shell-launch.test.ts` (one assertion)
- `packages/codev/src/__tests__/tower-lifecycle.windows.test.ts` (+61 / -0)
- `packages/codev/src/__tests__/windows-exe-search.test.ts` (+83 / -0)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+2 / -0)
- `packages/codev/src/lib/platform/windows/exe-search.ts` (+25 / -0)
- `packages/codev/src/lib/platform/windows/pty-env.ts` (sets the variable in the fallback allowlist)
- `packages/codev/src/lib/process-bootstrap.ts` (+24 / -0)
- `packages/codev/src/terminal/shellper-main.ts` (+2 / -0)

## Commits

- `e145f3cb9` [PIR #1911] Terminal coverage test: end every recorded session in teardown
- `db8577b67` [PIR #1911] Thread: checks pass, back at dev-approval
- `53a1f3cba` [PIR #1911] Cover every Tower terminal: test it, correct the docs
- `663603ee9` [PIR #1911] Thread: checks pass, at dev-approval
- `f9d0c8b26` [PIR #1911] Thread: Node 22 runs, waiting on #1946
- `3bef42211` [PIR #1911] Rename to lib/process-bootstrap.ts; move the Windows step to platform/windows/exe-search.ts
- `1cfb06b92` [PIR #1911] Thread: implement notes
- `1b16aeecd` [PIR #1911] Docs: native Windows is no longer a preview
- `4d54ae89e` [PIR #1911] VS Code: refuse a Codev CLI name that does not resolve on PATH
- `7d4d41f74` [PIR #1911] Set NoDefaultCurrentDirectoryInExePath first in every Codev entry point
- `20606082b` [PIR #1911] Plan revised: set NoDefaultCurrentDirectoryInExePath at entry points
- `b5865fe9f` [PIR #1911] Plan draft

(Plus a merge of `main` for #1947 and porch's own `chore(porch)` commits.)

## Test Results

- `npm run build`: ✓ pass
- `npm test` (porch `tests` check, run alone on the host): ✓ pass. A direct run of the same suite after the `main` merge: 8123 passed, 247 skipped, plus the two #1923 flakes below, which pass on their own.
- VS Code suite: 1282 passed.
- New tests:
  - `process-bootstrap.test.ts`: the bootstrap sets the variable on `win32` only; every `bin/` command and both server entries import it first.
  - `windows-exe-search.test.ts` (Windows): plants a copy of `hostname.exe` as `git.exe`. Control: with the variable removed, `git` runs the planted file. Hardened: `execFileSync`, `spawnSync` and an `execSync` string all run the real Git. With Git off `PATH`: ENOENT, and the planted file still never runs.
  - `tower-lifecycle.windows.test.ts`, new scenario: an isolated Tower started WITHOUT the variable opens a persistent builder terminal, a persistent API shell terminal and the dashboard's PowerShell shell tab; all three carry `NoDefaultCurrentDirectoryInExePath=1`. With the bootstrap import removed from `afx`, Tower and shellper, it fails (`unset`). Its teardown ends every session the test Tower recorded, pass or fail.
  - `cli-process.test.ts`: an unresolved bare name on Windows is never spawned and fails as ENOENT; a resolved one still spawns.
  - `spawn-builder-not-found.test.ts`: Spawn Builder turns that ENOENT into "afx was not found on PATH".
  - `shell-launch.test.ts`: `windowsPtyBaseEnv` sets the variable even when the parent did not.
- Real user path: `porch init` in a repository containing a planted `git.exe`. Without the bootstrap the planted file ran (`Command failed: git add`, no commit); with it, the real Git made the commit.
- **Local verification ran on Node 24.13.0 (the implementation and first suite runs) and Node 22.23.4 (all runs after the owner switched to nvm-windows, including the final porch checks).** node-pty and better-sqlite3 were confirmed to load and work under 22 before the re-runs.
- Tower PID: unchanged across every full-suite run (37868 on the first session, 53132 after the Node switch).
- Windows CI (on-demand `windows.yml`): https://github.com/cluesmith/codev/actions/runs/45080898387 on the final commit `e145f3cb9`. Earlier green runs: 45079432385 (`53a1f3cba`), 45078247361, 44725012668.

## Architecture Updates

Routed to COLD `codev/resources/arch.md`, Platform Layer: a "Process bootstrap and current-folder lookup" bullet (every entry point imports `lib/process-bootstrap.ts` first; on Windows it sets `NoDefaultCurrentDirectoryInExePath`; children and every Tower terminal inherit it; the VS Code host refuses unresolved names instead). Not HOT: it changes behavior on one platform and is enforced by a guard test, so it does not need to be in every prompt.

## Lessons Learned Updates

Routed to COLD `codev/resources/lessons-learned.md`, Testing:

- A security control test must fail without the fix; run that control before trusting a pass. Two traps hid the hazard here: Claude Code's shell already exports the variable, and on Windows a `{ ...process.env }` copy has case-sensitive keys, so deleting `NoDefaultCurrentDirectoryInExePath` missed the inherited `NODEFAULTCURRENTDIRECTORYINEXEPATH`.
- Persistent terminals outlive `tower stop`, so a test that opens them must end every session its Tower recorded, in `finally`, and confirm with a before/after process count.

## Things to Look At During PR Review

- **Consultation** (single pass): codex=COMMENT, claude=COMMENT. **Gemini did not run** (the `agy` CLI was not found on this host; porch recorded the skip as COMMENT). Acted on, with the architect's go-ahead: Claude found that the non-persistent fallback's `windowsPtyBaseEnv` allowlist lacked the variable, so a builder terminal created while shellper is unavailable kept the Windows default, contradicting "every terminal" in the docs (architect and shell-tab fallbacks pass Tower's full env and were covered). Fixed in `pty-env.ts` with a unit assertion. Also from Claude: Spawn Builder had no `'error'` listener, now shows "afx was not found on PATH"; nits (errno comment, the hand-listed `SERVER_ENTRY_POINTS` comment, a null check in the new scenario). Codex's .NET NativeAOT note was checked against dotnet/runtime#129340 and documented.
- **Every Tower terminal is covered, human shells included.** Earlier in the project I said terminals were built from the `windowsPtyBaseEnv` allowlist and would keep the Windows default. That was wrong: only the non-persistent fallback uses the allowlist (and it now sets the variable too); persistent terminals (architect, builder, shell tab) are built from Tower's environment. The owner chose to keep every terminal covered. Docs and plan now say so.
- **The `cmd.exe` behavior change** above is the one user-visible effect. PowerShell is unaffected.
- **Import order is the whole mechanism.** ESM evaluates imports before the module body, so the bootstrap must be the first import in each entry point. `process-bootstrap.test.ts` checks the first statement of each `bin/*.js` and both server entries; the bootstrap and `exe-search.ts` import nothing.
- **Tower and shellper imports are belt-and-braces.** Tower started by `afx` would inherit the variable anyway; the direct imports cover a Tower or shellper started some other way.
- **VS Code (`apps/vscode/src/cli-process.ts`)** returns a `ChildProcess` that emits an ENOENT-shaped error on the next tick (and `execCodevCli` rejects) when the resolver hands back an unresolved bare name. Callers already handle spawn errors.
- **Shell-string to argv conversion and `commandExists` unification were deliberately left out** of this PR (the plan's first draft proposed converting ~70 sites). With the variable set process-wide they are no longer needed to close the hole; they can be a follow-up if wanted.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1911 → **View Diff** (auto-detects the repo's default branch)
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1911`
- **What to verify** (native Windows):
  - `npx vitest run src/__tests__/windows-exe-search.test.ts src/__tests__/process-bootstrap.test.ts` in `packages/codev`.
  - `npx vitest run src/__tests__/tower-lifecycle.windows.test.ts -t 1911` (isolated Tower; leaves no shellpers behind).
  - Real path: in a scratch repo, copy `C:\Windows\System32\hostname.exe` to `git.exe`, then run a Codev command that runs `git` there (e.g. `porch init`); the real Git runs.
  - In a Codev `cmd.exe` terminal: `set NoDefaultCurrentDirectoryInExePath` prints `1`; a program in the folder runs only as `.\name`.
  - Run your test shell with the variable removed (`env -u NoDefaultCurrentDirectoryInExePath` in Git Bash), since Claude Code's shell already exports it.

## Flaky Tests (if any)

All are recorded on #1923; each was left running, not skipped, and passed on its own or on re-run:

- `packages/codev/src/commands/porch/__tests__/bugfix-1814-check-timeout.test.ts` ("a protocol.json timeout_ms reaches the runner and kills the check at that value"): 2574–3271 ms against a 2500 ms bound under load; blocked porch twice. Fixed on `main` by #1947 (#1946) and merged into this branch.
- `packages/codev/src/agent-farm/__tests__/launch-loop-exit-code.test.ts:49` ("still auto-restarts after a crash"): EBUSY / EPERM removing its temp folder in `afterEach`.
- `packages/codev/src/__tests__/tower-lifecycle.windows.test.ts`, scenario 4 ("a session survives tower stop/start", agent pid not alive after restart, under full-suite load) and scenario 5 (`read ECONNRESET` on Windows CI Node 22, run 44725012668; also failed on another branch before this change).
- One Vitest "Worker exited unexpectedly" unhandled error in a Node 22 full run, not tied to any test file.
