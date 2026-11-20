# PIR Plan: Windows user-tool lookup hardening (#1911)

## Understanding

On Windows, a program started by **bare name** is looked up in the current directory before
`PATH`: libuv does this for `child_process.spawn/execFile*` (`search_path` tries the cwd first),
and `cmd.exe` does it for every `exec`/`execSync` string. Codev runs `git`, `gh`, `npm`, `npx`,
`codev`, `porch` and friends with a builder worktree, a workspace, or a freshly cloned repository
as the cwd, so a `git.exe` committed to that repository runs under Codev instead of Git.
Spec 1658 fixed the system programs (System32 full paths); this issue fixes the user tools,
and with it native Windows leaves preview (README, both `DEPENDENCIES.md`).

### What the re-grep found (issue inventory is stale)

I re-inventoried with a TypeScript-AST scan of every non-test `.ts` under `packages/codev/src`
(every `exec/execSync/execFile/execFileSync/spawn/spawnSync`, promisified `execAsync` /
`execFileAsync`, agent-farm `run()`, and `commandLaunch().spawn*` call whose command is a string
literal or template). **72 user-tool sites**, against the issue's 36. The issue missed every
agent-farm `run('git …')` shell string (19, in `cleanup.ts`, `spawn-worktree.ts`, `spawn.ts`,
`utils/git.ts`), `tower-routes.ts`, `tower-instances.ts`, `team-update.ts`, `porch/checks.ts`,
`porch/state.ts`, `team-github.ts`, `import.ts:59`, and the `commandLaunch().spawn` sites.

**Direct `child_process` sites (67) — must be converted:**

- `agent-farm/commands/cleanup.ts`: 193, 228, 247, 261, 411, 495 `run(git …)` — **193 runs with the builder worktree as cwd**
- `agent-farm/commands/self-refresh.ts`: 484 `execFileSync(git)`
- `agent-farm/commands/spawn-worktree.ts`: 222, 230, 332, 337, 374, 382, 398, 404, 426, 458, 462 `run(git …)`; 282 `run(gh …)`; 490 `run(porch …)` (cwd = new worktree); 791 `execSync(git …)` (cwd = worktree)
- `agent-farm/commands/spawn.ts`: 958 `run(git …)`
- `agent-farm/commands/team.ts`: 26; `team-update.ts`: 37 `execSync(git …)`
- `agent-farm/servers/tower-routes.ts`: 2912 `execAsync(codev init …)`, 4056 `execAsync(git status …)` (cwd = workspace)
- `agent-farm/servers/tower-instances.ts`: 523 `execAsync(npx codev adopt …)` (cwd = an **arbitrary, not-yet-adopted directory**)
- `agent-farm/utils/config.ts`: 44 `execSync(git …)`; `utils/git.ts`: 33 `run(git …)`
- `commands/consult/index.ts`: 2048, 2049, 2217, 2234, 2249, 2254, 2359, 2753, 2786 `execFileSync(git)`; 2483, 2534, 2649 `execSync(git …)`
- `commands/doctor.ts`: 1154 `spawnSync(git)`
- `commands/import.ts`: 59 `execSync(git clone …)`
- `commands/init.ts`: 176 `execSync(git init)`, 192 `execSync(codev doctor)` (cwd = new project)
- `commands/porch/artifacts.ts`: 397, 421, 434, 466 `execFileSync(git)`
- `commands/porch/checks.ts`: 423; `porch/state.ts`: 205, 206, 209 `execFileAsync(git)`
- `lib/default-branch.ts`: 15 `execSync(git …)`
- `lib/github.ts`: 288 `execFile(gh)`
- `lib/gitignore.ts`: 168, 218 `spawnSync(git)`
- `lib/governance-bootstrap.ts`: 254, 275 `execFileSync(git)`
- `lib/protocol-drift-audit.ts`: 200 `spawnSync(npm)`
- `lib/team-github.ts`: 95 `execFileAsync(git)`
- `lib/tree-snapshot.ts`: 91, 107, 125, 184, 359 `execFileSync(git)`

**Already routed through the resolver, but not safe (5 + the pty path):** the architect's list —
`commands/import.ts:292` (`claude`), `agent-farm/commands/ide.ts:155/325` (`npm`),
`lib/agent-process.ts:32` — plus `bench.ts:100`, `bootstrap-docs.ts:287` (`consult`),
`porch/index.ts:711` (`afx`), `tower.ts:366` (`npx`/`node`) and `lib/pty-command.ts:26` (every
harness PTY) go through `commandLaunch().spawn*` / `spawnableOnHost` / `resolveSpawnable`.
The root problem there is in the resolver itself:
`packages/sdk/src/node/executable.ts:270-273` — when a name **does not resolve** on `PATH`,
`resolveSpawnable` returns the bare name unchanged, so the spawn falls back to libuv's lookup,
**which checks the cwd first**. "git not on PATH, but `git.exe` in the repo" therefore still runs
the planted file. These sites are **in scope**; they are fixed once, in the resolver, not per
site. `lib/agent-process.ts` itself is already safe when it gets a full path
(`resolveClaudeBin()` returns an absolute path), and is covered by the same fix for other launches.

A second resolver hole: `findAllExecutables` (`executable.ts:152`) honours **relative** `PATH`
entries (`.`, `bin`), which resolve against the cwd. That is the same attack through `PATH`.

**POSIX-only tools (out of scope to change; confirmed unreachable on Windows in implement):**
`ps` (cleanup.ts:90, architect-session-holder.ts:94, tower-utils.ts:252, posix/processes.ts:56/80,
session-manager.ts:1150), `pgrep` (tower.ts:470/486), `tail` (tower.ts:603), `lsof`
(posix/processes.ts:139), `sysctl`/`lscpu`/`free` (bench.ts:50/54/72/77), `du`
(migration-backup-audit.ts:79), `command -v` (consult/index.ts:1435), `which` (the five
`commandExists` probes, removed below). Each gets a `// user-tool: posix-only (<why>)` annotation
checked by the guard, so a future refactor that makes one reachable on Windows is visible.

### Shell-string sites and their shell features (architect point 3)

Every shell-string user-tool site, and whether it relies on a shell feature. **None uses pipes,
redirects, `||`/`&&`, globbing or variable expansion.** The only shell feature in use is
double-quote quoting of interpolated values (and whitespace word-splitting), which the argv form
replaces exactly — and more safely: today a branch, path or remote containing `"`, `$` or
backticks is shell-interpreted.

| Site | Command | Shell feature used | argv form |
|---|---|---|---|
| cleanup.ts:193 | `git status --porcelain` | none | `['status','--porcelain']` |
| cleanup.ts:228 | `git push origin --delete "${branch}"` | quoting | `['push','origin','--delete',branch]` |
| cleanup.ts:247 | `git worktree remove "${p}" --force` | quoting | `['worktree','remove',p,'--force']` |
| cleanup.ts:261, 495; spawn.ts:958 | `git worktree prune` | none | `['worktree','prune']` |
| cleanup.ts:411 | `git branch -D "${b}"` | quoting | `['branch','-D',b]` |
| spawn-worktree.ts:222 | `git branch ${branchName}` | word-split (unquoted, single token) | `['branch',branchName]` |
| spawn-worktree.ts:230 | `git worktree add "${p}" ${branchName}` | quoting + word-split | `['worktree','add',p,branchName]` |
| spawn-worktree.ts:282 | `gh pr list --head "${b}" --json … --state open` | quoting | argv |
| spawn-worktree.ts:332 / 337 | `git remote get-url "${n}"` / `git remote add "${n}" "${url}"` | quoting | argv |
| spawn-worktree.ts:374 / 398 | `git fetch "${r}"` [`"${b}"`] | quoting | argv |
| spawn-worktree.ts:382 / 404 | `git ls-remote --heads "${r}" "${b}"` | quoting | argv |
| spawn-worktree.ts:426 | `git worktree list --porcelain` | none | argv |
| spawn-worktree.ts:458 / 462 | `git worktree add "${p}" [-b "${b}" "${r}/${b}"]` | quoting | argv |
| spawn-worktree.ts:490 | `porch init ${proto} ${id} "${name}"` | quoting + word-split (proto/id pre-sanitised to one token) | `['init',proto,id,name]` |
| spawn-worktree.ts:791 | `git update-index --skip-worktree "${rel}"` | quoting | argv |
| team-update.ts:37 | `git log --oneline --since="${since}" --all --grep="spawn" -i` | quoting inside `--opt="…"` | `['log','--oneline',`--since=${since}`,'--all','--grep=spawn','-i']` |
| team.ts:26 | `git config user.name` | none | argv |
| tower-routes.ts:2912 | `codev init --yes "${name}"` | quoting | `['init','--yes',name]` |
| tower-routes.ts:4056; utils/git.ts:33 | `git status --porcelain [--untracked-files=no]` | none | argv |
| tower-instances.ts:523 | `npx codev adopt --yes` | none | `npx` argv |
| config.ts:44 | `git rev-parse --git-common-dir` | none | argv |
| consult 2483 / 2534 / 2649 | `git show HEAD` / `git branch --show-current` | none | argv |
| import.ts:59 | `git clone --depth 1 "${url}" "${dir}"` | quoting | argv |
| init.ts:176 / 192 | `git init` / `codev doctor` | none | argv |
| default-branch.ts:15 | `git symbolic-ref --short refs/remotes/origin/HEAD` | none | argv |

POSIX regression risk is therefore limited to: (a) the error **message** text (`run()` throws
`Command failed: <cmd>\n<stderr>`; I keep that format by joining argv for the message), and
(b) `npx`/`codev`/`porch` resolving from `PATH` the same way `/bin/sh` did — identical on POSIX,
since `execFile` without a shell uses the same `execvp` `PATH` search.

## Proposed Change

### 1. Fail closed in the resolver (`packages/sdk/src/node/executable.ts`)

- `findAllExecutables`: on `win32`, **skip non-absolute `PATH` entries** (they resolve against the
  cwd). POSIX unchanged.
- `resolveSpawnable`: add `found: boolean` to `SpawnableCommand`. On `win32`, a **bare** name that
  does not resolve returns `found: false` (command still the bare name, for messages). POSIX and
  names with a path separator: `found: true` as today (POSIX `execvp` never searches the cwd).
  Additive; existing callers that ignore `found` are updated below.

### 2. One shell-free user-tool API on the platform seam

`CommandLaunch` (`lib/platform/command-launch.ts`) already has `spawn` / `spawnSync` for bare
commands; add the two missing shapes and make all four fail closed on Windows:

```ts
spawn(cmd, args, opts): ChildProcess                   // exists
spawnSync(cmd, args, opts): SpawnSyncReturns<string>   // exists
execFileSync(cmd, args, opts): string                  // new
execFile(cmd, args, opts): Promise<{stdout, stderr}>   // new (async, promisified execFile shape)
commandExists(name): boolean                           // posixProbe parameter removed
```

- **POSIX** implementations call `child_process` directly with the same argv and options —
  no shell, no lookup change.
- **Windows** implementations run `spawnableOnHost` (PATH-only, `PATHEXT`, `.cmd` shim handling),
  set `windowsHide` and `windowsVerbatimArguments`, and when `found === false` produce the
  **same ENOENT surface the caller already handles** without ever spawning the bare name:
  `execFileSync`/`execFile` throw/reject an `ENOENT` error shaped like Node's
  (`code`, `errno`, `syscall: 'spawn <cmd>'`, `path`, `spawnargs`); `spawnSync` returns
  `{ error, status: null, … }`; `spawn` returns a `ChildProcess` that emits that `error` on the
  next tick (the async contract callers already listen for).
- `lib/pty-command.ts` (harness PTYs) and `git-bash-launch.ts` get the same `found` check and
  throw ENOENT instead of handing node-pty a bare name.

### 3. `commandExists`: one shell-free implementation (Spec 1658 review A2.9)

`commandLaunch().commandExists(name)` = `findOnHostPath(name) !== null` on **both** platforms
(the SDK resolver does `X_OK` + `isFile` on POSIX — the `which` semantics). The three `which`
forms go: `doctor.ts:677` (`which ${cmd}` string), `consult/index.ts:419`, `import.ts:324`,
`bench.ts:222`, `agent-farm/utils/shell.ts:139` (its async variant becomes a thin wrapper; its
name sanitising stays).

### 4. Convert all 67 direct sites

- `execFileSync('git', …)` → `commandLaunch().execFileSync('git', …)`; `spawnSync` /
  `execFile(Async)` likewise. Same argv, same options.
- `execSync('git …')` / `execAsync('…')` strings → argv per the table above.
- agent-farm `run('git …')`: add `runTool(cmd, args, { cwd })` to `utils/shell.ts` (same
  `{stdout, stderr}` trimmed result, same `Command failed:` error) built on
  `commandLaunch().execFile`. After conversion `run()` has no callers left in `src`; I delete it
  rather than leave a shell-string helper behind (grep-confirmed in implement; if a non-tool
  caller remains it stays and the guard covers it).
- Tests that mock `node:child_process` and match the old **strings** are updated to the argv
  form (6 files today: `spawn-worktree.test.ts`, `spec-1658-cleanup-worktree-removal.test.ts`,
  `doctor.test.ts`, `import.test.ts`, `issue-1919-hidden-spawns.test.ts`,
  `windows-shell-spawns.test.ts`; more may surface from the 32 files mocking child_process).

### 5. Static guard (`src/__tests__/user-tool-spawn-guard.test.ts`)

A vitest AST guard (same technique as `windows-console-spawn-guard.test.ts`, so it runs on every
OS in the existing unit CI job — no new workflow step needed): for every non-test `.ts` under
`packages/codev/src`, any call to a `node:child_process` binding (named, aliased, or
`promisify`-wrapped) or to agent-farm `run`/`runStreaming`/`spawnDetached`, whose command is a
string literal/template whose first token is a **user tool** (`git gh npm npx node pnpm codev
afx porch consult claude codex gemini agy jq`), fails — unless annotated
`// user-tool: <reason>` on the line or the line above. POSIX-only tools (`ps pgrep tail lsof
sysctl lscpu free du which command`) must carry `// user-tool: posix-only (…)`. The allowed path
is `commandLaunch()` (whose Windows half is the resolver). The guard also asserts it found the
known POSIX-only sites, so a broken scanner cannot pass vacuously.

### 6. Windows behavioural test (`src/__tests__/windows-user-tool-cwd.test.ts`, `win32` only)

Plants a fake `git.exe` (a copy of `%SystemRoot%\System32\hostname.exe`, which prints the host
name and exits 0) in a temp worktree-shaped cwd, then:
1. **Control:** raw `execFileSync('git', ['--version'], { cwd })` prints the host name — proves
   the plant works and the hazard is real on this runner.
2. `commandLaunch().execFileSync('git', ['--version'], { cwd })` prints `git version …` (PATH git).
3. Same for `execFile`, `spawnSync`, `spawn` and `runTool`.
4. With `PATH` stripped of Git: all four fail with `ENOENT`; the planted file never runs.
5. A relative `PATH` entry (`.`) is ignored.

Plus platform-injected unit tests in `packages/sdk/src/__tests__/executable.test.ts` for
`found: false` and relative-`PATH` skipping (run on every OS).

### 7. Docs

Remove the preview wording in `README.md:123` and `DEPENDENCIES.md:213, 262-267` in
**both** `codev/` and `codev-skeleton/` (kept byte-identical). The "only work in repositories you
trust" bullet becomes a short statement that Codev runs every program by full path or a
`PATH`-only lookup, never from the current folder.

## Files to Change

- `packages/sdk/src/node/executable.ts` — `found` flag; skip relative `PATH` entries on win32
- `packages/sdk/src/__tests__/executable.test.ts` — tests for both
- `packages/codev/src/lib/host-executable.ts` — `spawnableOnHost` passes `found` through; ENOENT error builder
- `packages/codev/src/lib/platform/command-launch.ts` — `execFileSync`, `execFile`; `commandExists(name)`
- `packages/codev/src/lib/platform/{posix,windows}/command-launch.ts` — implementations, fail closed
- `packages/codev/src/lib/pty-command.ts`, `lib/platform/windows/git-bash-launch.ts` — `found` check
- `packages/codev/src/agent-farm/utils/shell.ts` — `runTool`; `commandExists` thin; `run` removed if unused
- The 67 sites listed above (25 files) — argv conversion
- `doctor.ts`, `consult/index.ts`, `import.ts`, `bench.ts` — drop local `which` probes
- POSIX-only sites — `// user-tool: posix-only` annotations
- `packages/codev/src/__tests__/user-tool-spawn-guard.test.ts` — new static guard
- `packages/codev/src/__tests__/windows-user-tool-cwd.test.ts` — new Windows test
- Existing tests mocking the old strings — updated to argv
- `README.md`, `codev/DEPENDENCIES.md`, `codev-skeleton/DEPENDENCIES.md` — preview wording removed
- `codev/state/pir-1911_thread.md` — thread log

## Risks & Alternatives Considered

- **Risk: POSIX regression from dropping the shell.** Mitigated by the table above: no site uses
  a shell feature beyond quoting. Error messages keep the `Command failed: <cmd>` form.
- **Risk: a `.cmd`-shimmed tool (`npx`, `codev`, `porch` installed by npm) behaves differently
  under argv than under `cmd.exe`.** `resolveSpawnable` already handles this for the
  `commandLaunch().spawn` sites in production today (`consult`, `afx`); same code path.
- **Risk: test-mock churn** across files that match exact `execSync` strings. Mechanical; done
  per site with the site.
- **Risk: VS Code extension** (`apps/vscode/src/cli-process.ts`) also uses `resolveSpawnable` and
  ignores `found`. The SDK change is additive, so it keeps today's behaviour. It has the same hole
  (it runs `codev`/`afx` with the workspace as cwd); the fix is a one-line `found` check there, so
  I include it as an adjacent fix-in-place and name it in the PR. If the reviewer wants it out of
  scope, drop that one file.
- **Alternative: set `NoDefaultCurrentDirectoryInExePath`.** That env var stops `cmd.exe` from
  searching the cwd, but libuv ignores it (it implements its own `search_path`), so it fixes only
  half the sites, and it leaks into every child. Rejected.
- **Alternative: convert each site to `spawnableOnHost` inline.** 67 hand-rolled
  `windowsHide`/`windowsVerbatimArguments`/ENOENT copies; the guard could only check "uses the
  resolver somewhere". Rejected for the seam (single source of truth).
- **Alternative: a script in `scripts/` + CI step, like `tmp-residue-check.mjs`.** The check needs
  a TypeScript AST to see through aliases and templates; the vitest guard gets `typescript` for
  free and already runs in the unit job. The issue allows "test or script".
- **Out of scope:** the remaining single-site `isWindows()` forks (Spec 1658 A2.5); the IDE-server
  capability (#1890); shell strings that run under the resolved **Git Bash** (porch checks, forge
  concept scripts, `runStreaming` postSpawn/dev commands) — bash's `PATH` search does not consult
  the cwd, and those commands are the user's own configuration.

## Test Plan

- **Unit (all OS):** SDK resolver tests (`found`, relative `PATH`); `user-tool-spawn-guard`;
  updated site tests; full `packages/codev` unit suite on the Windows host, recording the Tower
  PID before and after (and reporting any change), re-running known #1923 load flakes once.
- **Windows behavioural:** `windows-user-tool-cwd.test.ts` (the planted `git.exe` control +
  PATH-git + ENOENT cases).
- **Windows CI:** `gh workflow run windows.yml --ref builder/pir-1911 -f purpose='#1911 user-tool PATH-only lookup' -f suites=true`, run linked in the PR.
- **Manual (dev-approval, on this Windows host):**
  1. In a scratch repo, commit a `git.exe` (copy of `hostname.exe`) at the root.
  2. `afx spawn` a builder for it / `afx cleanup` it, and `porch status` inside it: worktree
     creation, the clean-check (`git status` in the worktree) and cleanup all behave normally;
     nothing prints the host name.
  3. `codev doctor` and `consult` from inside the worktree report the real Git.
  4. Temporarily remove Git from `PATH` in a shell: commands fail with a clear "not found"
     error, and the planted `git.exe` still never runs.
- **POSIX:** CI unit + e2e on Linux/macOS unchanged and green.
