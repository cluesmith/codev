# PIR Plan: Stop console windows flashing on Windows (unhidden child-process spawns)

## Understanding

On native Windows a black console window flashes repeatedly while an agent works in a Codev
terminal inside VS Code. It stops when the agent's turn ends and never happens with VS Code
closed.

**Mechanism.** A console program started from a process that has *no console* gets a new,
visible console window for its lifetime unless the spawn passes `windowsHide: true` (libuv adds
`CREATE_NO_WINDOW` and `SW_HIDE`). Three kinds of codev process have no console:

| Console-less process | Why |
|---|---|
| **Tower** (non-CIM launch) | `afx tower start` spawns it `detached: true` (`agent-farm/commands/tower.ts:353-371`). On Windows `detached` means `DETACHED_PROCESS`, and Win32 ignores `CREATE_NO_WINDOW` alongside it, so Tower has no console at all. (The CIM launch path, used when started from inside a codev session, gives Tower a *hidden* console via `ShowWindow = 0`, so its children don't flash. That is why Spec 1658's scenario 15 passed.) |
| **VS Code extension host** | Started by `Code.exe` (a GUI app). |
| **CLIs the extension launches detached** | `afx spawn` (`apps/vscode/src/commands/spawn.ts:46`) and `afx tower start` (`apps/vscode/src/tower-starter.ts:48`) both go through `spawnCodevCli(..., { detached: true, stdio: 'ignore' })`. They run with no console. |

Agents' own tool calls are **not** the source. They run inside a shellper ConPTY, and their
children inherit that pseudo-console.

**The reported chain** (each step checked against source):

1. Each agent tool call posts lifecycle state to Tower. Tower broadcasts a coalesced
   `overview-changed` SSE event, roughly one every 500 ms (`agent-state/broadcast.ts`).
2. `TeamProvider` refreshes on **every** SSE event, with no filter, debounce or visibility check
   (`apps/vscode/src/views/team.ts:11`).
3. Each refresh calls `GET /api/team` (`tower-routes.ts:3245`). That calls
   `fetchTeamGitHubData` (`lib/team-github.ts:314`), which calls `getRepoInfo`, which runs
   `execFileAsync('git', ['remote','get-url','origin'], { cwd })` with no `windowsHide`
   (`lib/team-github.ts:58`). `git.exe` launched from console-less Tower means a black window.

This matches all three observations. It happens only during a turn because tool calls drive the
events. It needs VS Code open because the Team view drives the requests. The window is black
because it belongs to git.exe. As a side effect, each refresh also runs the `team-activity`
GraphQL forge call, which spends GitHub quota at about 2 calls per second during a turn.

**Sweep.** I walked the relative-import graph from four console-less entry points:
`servers/tower-server.ts`, `commands/spawn.ts` (`afx spawn`), `commands/tower.ts`
(`afx tower start`) and `apps/vscode/src/extension.ts`. That gives every module, in a process
that may lack a console, that imports `child_process`. Production call sites with no
`windowsHide`, re-verified against the files:

| Site | Process | Notes |
|---|---|---|
| `lib/team-github.ts:58` `git remote get-url` | Tower, afx spawn | **The reported flash** |
| `servers/tower-cron.ts:286` `exec(command)` | Tower | cmd.exe for the length of each cron run |
| `servers/tower-routes.ts:4047` `git status --porcelain` | Tower | Dashboard FileTree polls it every 5 s |
| `servers/tower-routes.ts:2904` `codev init` | Tower | Dashboard "create workspace" |
| `servers/tower-instances.ts:523` `npx codev adopt` | Tower | Workspace adopt |
| `lib/github.ts:288` `gh api rate_limit` | Tower, afx spawn | Rate-limit probe |
| `servers/tower-utils.ts:251` `ps` | Tower | `sessionHasLiveHolder` runs it on Windows too. Fails harmlessly with no `ps` on PATH, but runs (and flashes) when Git's `usr\bin\ps.exe` is on PATH |
| `agent-farm/utils/shell.ts:24` `run` (execAsync), `:143` `which` | Tower, afx spawn, afx tower | `:85` `runStreaming` is POSIX-only; Windows is already hidden |
| `agent-farm/utils/config.ts:44` `git rev-parse --git-common-dir` | all | |
| `agent-farm/commands/spawn-worktree.ts:791` `git update-index` | afx spawn | |
| `commands/porch/artifacts.ts:299,325,390,411,424,455` | afx spawn | git / forge CLI reads during spawn |
| `apps/vscode/src/commands/view-diff.ts:176,270,283,293,294,392,476` | ext host | git diff family |
| `apps/vscode/src/commands/press-cursor-ref.ts:49` | ext host | git diff |
| `apps/vscode/src/review-queue/store.ts:236` | ext host | git |
| `apps/vscode/src/commands/approve.ts:360` | ext host | `porch approve` |
| `apps/vscode/src/commands/cleanup.ts:51` | ext host | `afx cleanup` |
| `apps/vscode/src/clipboard-image.ts:56` | ext host | Windows branch runs `powershell.exe` |

Already hidden, or not reached on Windows: `commandLaunch()` (both Windows methods set
`windowsHide`), `spawnCodevCli`, `ide-server.ts`, `ide-version.ts`, `job-objects.ts`,
`process-tree.ts`, `process-census.ts`, `port-query.ts`, `git-bash.ts`, `tower-lifecycle.ts`.
POSIX-only branches: `architect-session-holder.ts:93`, `session-manager.ts:1146`,
`posix/processes.ts`, `tower.ts:469/484/600`, `activity-hooks.ts:113` (macOS `open`). Forge
concept commands go through `commandLaunch().execShellString`, which is already hidden.

## Proposed Change

Three parts, matching the issue's fix shape.

### 1. Hide every spawn reachable from a console-less process

Add `windowsHide: true` to every site in the table above. On POSIX it is ignored, so macOS and
Linux behaviour is unchanged. Where a site already chooses by platform, the flag goes on the
Windows-reachable call only. Two sites get more than the flag:

- **`tower-utils.ts` `sessionHasLiveHolder`.** On Windows `ps -ww -A -o args=` is wrong anyway:
  MSYS `ps` doesn't print native command lines. Read the command lines from the existing Windows
  process census (`lib/platform/windows/process-census.ts`, already hidden) if it exposes them.
  Otherwise skip the probe on Windows and return `false`, which is the documented "could not
  determine" outcome and what happens today when `ps` is missing. I'll settle which one during
  implementation from what the census returns, and name the choice in the PR.
- **`tower-cron.ts` `runCommand`.** Add `windowsHide: true`. This hides cmd.exe, and the cron
  command inherits that hidden console. The shell stays cmd.exe for now. Moving cron to Git Bash
  (`commandLaunch().execShellString`) would change what Windows users' existing cron commands
  mean, so it is out of scope (see Alternatives).

### 2. Stop the Team view refreshing on every SSE event

`apps/vscode/src/views/team.ts`:

- Register the view with `vscode.window.createTreeView('codev.team', …)` instead of
  `registerTreeDataProvider`, so the provider can read `visible` and `onDidChangeVisibility`.
- On an SSE event, refresh only when the view is visible, through a **trailing throttle of at
  most one fetch per 30 s**. Team data (members, GitHub activity, messages) doesn't come from
  agent lifecycle events, so the events only serve as a "something may have changed" hint.
- Refresh immediately when the view becomes visible, when the connection reaches `connected`,
  and on the existing `codev.refreshTeam` command.
- A refresh that arrives while a fetch is in flight is coalesced, not run concurrently.

Tower side, in `lib/team-github.ts`: cache `getRepoInfo` per `cwd` with a short TTL (5 min). The
origin URL almost never changes. This also covers `lib/github.ts:413`, which calls the same
function from the overview path.

### 3. A guard test that fails CI on a new unhidden spawn

New `packages/codev/src/__tests__/windows-console-spawn-guard.test.ts`. It is static and runs on
every OS:

1. Walk the relative-import graph (TS `import`/`export … from`/dynamic `import()`) from the four
   console-less entry points above. That yields the set of modules that can run without a
   console. The walk lives in the test, so a new import into Tower or the extension is covered
   automatically.
2. For each module in the set, parse it with the TypeScript compiler API. Find the local bindings
   of `exec`, `execSync`, `execFile`, `execFileSync`, `spawn`, `spawnSync` and `fork` imported
   from `node:child_process`/`child_process`, plus `promisify(<one of those>)` aliases.
3. Every call to one of those bindings must pass an options object literal containing
   `windowsHide`, either directly or through a same-file `const` whose initializer is such a
   literal. Any other use of the binding (a call without it, or passing the binding as a value,
   as clipboard-image's injectable `deps.spawn` does) fails, unless the line or the one above it
   carries `// windows-console: <reason>`, such as `posix-only` or `options carry windowsHide at
   the injected call`.
4. The failure message names `file:line` and explains the rule and the opt-out.

The rule is deliberately "hide or explain", not "reachability-proven". A POSIX-only branch takes a
one-line annotation, which keeps the guard simple and the exceptions visible in review. The test
also carries a small fixture check: one inline source string with an unhidden `execFile`, which
the scanner must flag. That proves the scanner isn't vacuously passing.

## Files to Change

- `packages/codev/src/lib/team-github.ts:55-72`: `windowsHide`, plus a per-cwd TTL cache for `getRepoInfo`
- `packages/codev/src/lib/github.ts:288`: `windowsHide`
- `packages/codev/src/agent-farm/servers/tower-cron.ts:286`: `windowsHide`
- `packages/codev/src/agent-farm/servers/tower-routes.ts:2904,4047`: `windowsHide`
- `packages/codev/src/agent-farm/servers/tower-instances.ts:523`: `windowsHide`
- `packages/codev/src/agent-farm/servers/tower-utils.ts:250-292`: Windows branch for `sessionHasLiveHolder`
- `packages/codev/src/agent-farm/utils/shell.ts:24,143`: `windowsHide`, plus annotation on the POSIX `:85`
- `packages/codev/src/agent-farm/utils/config.ts:44`: `windowsHide`
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts:791`: `windowsHide`
- `packages/codev/src/commands/porch/artifacts.ts`: `windowsHide` on its 6 sites
- POSIX-only sites (`architect-session-holder.ts`, `session-manager.ts`, `posix/processes.ts`, `tower.ts`, `activity-hooks.ts`): `// windows-console: posix-only` annotation
- `apps/vscode/src/commands/view-diff.ts`, `press-cursor-ref.ts`, `approve.ts`, `cleanup.ts`, `review-queue/store.ts`: `windowsHide`
- `apps/vscode/src/clipboard-image.ts:56`: `windowsHide` in `opts`, plus annotation on the injected default
- `apps/vscode/src/views/team.ts`: visibility gating, throttle, in-flight coalescing
- `apps/vscode/src/extension.ts:655,681`: `createTreeView` for `codev.team`, wired into `TeamProvider`
- `packages/codev/src/__tests__/windows-console-spawn-guard.test.ts`: new guard test
- `packages/codev/src/__tests__/` (team-github tests) and `apps/vscode/src/__tests__/team*.test.ts`: unit tests below
- `codev/state/pir-1919_thread.md`: builder thread

The change has no framework content, so nothing goes into `codev-skeleton/`.

## Risks & Alternatives Considered

- **Risk: hiding a child that needs to prompt.** With `windowsHide` and non-inherited stdio, a
  child gets its own hidden console. A `git fetch` whose ssh key needs a passphrase typed at the
  console would wait invisibly instead of prompting. Every site in scope already uses piped or
  ignored stdio and runs from a process with no usable console, so a prompt could not be answered
  today either. The one shared-with-terminal case is porch's `GitRefResolver` fetch
  (`artifacts.ts:390`) run from a builder terminal. Mitigation: keep its existing `stdio` and add
  `GIT_TERMINAL_PROMPT=0`-style behaviour only if review asks. I'll name it in the PR.
- **Risk: Team view looks staler.** At most 30 s behind while visible, and immediate on reveal or
  manual refresh. That is acceptable for GitHub-activity data, and it also stops the view
  spending GraphQL quota at about 2 calls per second during agent turns.
- **Risk: the guard is noisy.** Annotations are cheap, and the failure text says exactly what to
  do.
- **Alternative: give Tower a hidden console so every descendant inherits it.** This would be a
  root fix for the whole Tower subtree. Dropping `detached` doesn't work: libuv puts non-detached
  children in a kill-on-close job, so Tower would die with `afx tower start`. Always using the CIM
  launch (which already yields a hidden console) does work, but it adds about 1 s of PowerShell
  startup to every Tower start, depends on WMI being available, and changes a lifecycle Spec 1658
  verified. Rejected for this PR. It's worth a follow-up issue if per-site discipline proves
  leaky. The guard test is the cheaper defence.
- **Alternative: hide spawns everywhere (all CLI code too).** Rejected. CLI code run from a
  terminal shares that terminal's console, and hiding it there only adds the prompt risk above.
- **Alternative: route tower-cron through Git Bash.** Rejected here because it's a semantic
  change for existing Windows cron commands. It belongs in a separate issue if wanted.

## Test Plan

**Unit tests**
- Guard test (above), including the fixture proving it flags an unhidden call.
- `team-github`: `getRepoInfo` passes `windowsHide: true`, returns the cached value within the
  TTL without a second spawn, and re-spawns after it.
- `tower-utils` `sessionHasLiveHolder`: under forced `win32` it doesn't spawn `ps`.
- `tower-cron` `runCommand`: options include `windowsHide: true`, and the POSIX call is otherwise
  unchanged.
- `TeamProvider`: no fetch on SSE while hidden. While visible, a burst of N events gives exactly
  one fetch per throttle window. It fetches on becoming visible, on `connected` and on manual
  refresh.
- Existing suites stay green: `pnpm --filter @cluesmith/codev test` and the vscode unit tests.

**Manual (Windows 11, at `dev-approval`)**
1. Build and install the worktree's CLI and extension, then restart Tower from a non-codev shell
   (the `detached` path: the reported configuration).
2. Team view **expanded**: run an agent turn with many tool calls in a Codev terminal in VS Code.
   No console window appears.
3. Repeat with the Team view **collapsed**.
4. Add a cron task (`afx cron`) with a short interval and watch a run. No window.
5. Open a dashboard tab with the file tree visible for at least 30 s. No window.
6. From VS Code: spawn a builder (command palette), open a builder diff, approve a gate, paste a
   clipboard image. No window.
7. Optional instrumentation: Sysinternals Process Monitor filtered on `Process Create` under
   Tower's PID, to confirm git.exe still runs during a turn (now hidden) and runs far less often
   with the Team view collapsed.

**Cross-platform**
- macOS/Linux: the existing suites, plus the guard (it runs on every OS). `windowsHide` is a
  no-op there.
- Dispatch the on-demand Windows workflow on the branch, since the PR touches process spawning,
  and link the run in the PR:
  `gh workflow run windows.yml --ref builder/pir-1919 -f purpose='#1919 hidden spawns + guard' -f suites=true`.
