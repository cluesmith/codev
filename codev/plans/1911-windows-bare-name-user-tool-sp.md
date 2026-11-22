# PIR Plan: Windows user-tool lookup hardening (#1911)

> Revised 2026-11-20 at the owner's direction: the small version. The first draft (route all
> ~72 bare-name sites through the resolver) rested on an untested claim that libuv ignores
> `NoDefaultCurrentDirectoryInExePath`. Measured below: it does not.

## Understanding

On Windows, a program started by **bare name** (`git`, `gh`, `npm`, `npx`, `codev`) is looked up in
the current directory before `PATH`. Codev runs those commands with a builder worktree, a
workspace, or a freshly cloned repository as the current directory, so a `git.exe` committed to a
repository runs under Codev, as the user, on routine commands (`afx spawn`, `afx cleanup`, porch,
consult, `codev doctor`, `codev import`). Spec 1658 fixed the system programs by full System32
path; this issue covers the user tools, and with it native Windows leaves preview.

**Measured on this host (Node 24.13.0, libuv 1.51.0):** a copy of `hostname.exe` planted as
`git.exe` in a temp directory, `git --version` run with that directory as `cwd`:

| | `execFileSync('git')` | `spawnSync('git')` | `execSync('git …')` (cmd.exe) |
|---|---|---|---|
| variable unset | planted file ran | planted file ran | planted file ran |
| `process.env.NoDefaultCurrentDirectoryInExePath = '1'` set in-process first | PATH git | PATH git | PATH git |
| same, Git removed from `PATH` | ENOENT | ENOENT | "not recognized" |

libuv's `search_path` honours the variable (via `NeedCurrentDirectoryForExePathW`, read from the
calling process's environment), and `cmd.exe` honours it from its inherited environment. Setting
it in our own process at startup closes the hole for every spawn that process makes, and for
every child that inherits our environment, with no change to any call site. When the tool is not
on `PATH` the spawn fails closed; the planted file never runs.

## Proposed Change

### 1. One hardening module, set first in every Codev process

New `packages/codev/src/lib/process-bootstrap.ts`: a general side-effect module for setup every
Codev process runs first. Its one step, on `win32` only, calls `hardenExeSearch` from the new
`packages/codev/src/lib/platform/windows/exe-search.ts`, which sets
`process.env.NoDefaultCurrentDirectoryInExePath = '1'`. It is a no-op on macOS/Linux (POSIX
`execvp` never searches the cwd). Neither file imports anything else, so the bootstrap can be the
first import evaluated.

It is imported **first** (before any other import, so ESM hoisting cannot run a spawn ahead of it)
in each process entry point:

- `packages/codev/bin/{codev,afx,porch,consult,team,generate-image}.js` — every installed command.
  Child Codev processes started via `process.execPath <bin>` (porch `notify.ts`,
  `workspace-recover.ts`) go through these too.
- `packages/codev/src/agent-farm/servers/tower-server.ts` and
  `packages/codev/src/terminal/shellper-main.ts` — node scripts launched by path, not via a bin.
  They would inherit the variable from the `afx` that starts them; the explicit import makes each
  process safe on its own (e.g. a Tower started by a dev script).

### 2. Agent/terminal PTYs (node-pty)

Harness PTYs go through `lib/pty-command.ts`, which already resolves a found command to its full
path. The open case is a command that does **not** resolve: node-pty then hands the bare name to
`CreateProcess`, and I have not yet verified that `CreateProcess`'s own search honours the
variable. In implement I test it with the same planted-file setup. If it does not, the fix is a
three-line check in `pty-command.ts`: an unresolved bare name throws ENOENT instead of reaching
node-pty.

### 3. VS Code extension

The extension host is shared with other extensions, so the extension must not set a process-wide
variable there. `apps/vscode/src/cli-process.ts` already resolves `codev`/`afx` with
`resolveSpawnable`; the only gap is the unresolved case, where it passes the bare name on. Fix:
on `win32`, refuse (ENOENT) when the name does not resolve on `PATH`. The `codev`/`afx` it starts
then set the variable themselves (step 1).

### 4. Guard (static, every OS, runs in the existing unit job)

`packages/codev/src/__tests__/process-bootstrap.test.ts`:
- every file in `packages/codev/bin/` and the two server entries has the hardening import as its
  **first** import (so a new bin or a reordered import fails CI);
- the module sets the variable on `win32` and leaves `process.env` untouched elsewhere
  (platform-injected).

### 5. Windows behavioural test (`win32` only)

`packages/codev/src/__tests__/windows-exe-search.test.ts` plants a `git.exe` (copy of
`%SystemRoot%\System32\hostname.exe`) in a temp worktree-shaped directory and runs a child
`node` process that does `execFileSync('git', …)`, `spawnSync` and `execSync('git --version')`
with that `cwd`:
1. **Control:** without the variable, the planted file runs (proves the plant works on the runner).
2. With the hardening module imported: `git version …` from `PATH`.
3. With Git removed from `PATH`: ENOENT; the planted file still never runs.
The child-process form keeps the test independent of the vitest worker's own environment (this
host's Claude Code shell already exports the variable, which hid the hazard in my first probe).

### 6. Docs

Remove the preview wording: `README.md:123` and `DEPENDENCIES.md:213, 262-267` in **both**
`codev/` and `codev-skeleton/` (kept byte-identical). The "only work in repositories you trust"
bullet becomes one sentence: Codev never runs a program from the current folder; it uses full
system paths or a `PATH`-only lookup.

## Files to Change

- `packages/codev/src/lib/process-bootstrap.ts` — new, the side-effect module
- `packages/codev/src/lib/platform/windows/exe-search.ts` — new, the Windows step it runs
- `packages/codev/bin/codev.js`, `afx.js`, `porch.js`, `consult.js`, `team.js`, `generate-image.js` — first import
- `packages/codev/src/agent-farm/servers/tower-server.ts`, `packages/codev/src/terminal/shellper-main.ts` — first import
- `packages/codev/src/lib/pty-command.ts` — only if the node-pty test shows it is needed
- `apps/vscode/src/cli-process.ts` — refuse an unresolved bare name on Windows
- `packages/codev/src/__tests__/process-bootstrap.test.ts` — new guard
- `packages/codev/src/__tests__/windows-exe-search.test.ts` — new Windows test
- `README.md`, `codev/DEPENDENCIES.md`, `codev-skeleton/DEPENDENCIES.md` — preview wording removed
- `codev/state/pir-1911_thread.md` — thread log

## Risks & Alternatives Considered

- **Risk: a Codev process that never loads an entry point** (e.g. a script run with `node
  dist/…` directly, or a future server entry). Mitigated by the guard over `bin/` and the server
  entries, and by inheritance: anything started from a hardened process inherits the variable
  unless it is given a hand-built environment. Every persistent terminal Tower opens (architect,
  builder, shell tab) is built from Tower's own environment, so all of them inherit it (owner
  decision: no carve-out for human shells; `tower-lifecycle.windows.test.ts` covers it). Only the
  non-persistent fallback starts from the `windowsPtyBaseEnv` allowlist.
- **Risk: user-visible change in children.** Programs Codev starts inherit the variable, so a
  `cmd.exe` session inside a Codev terminal would no longer run `foo.exe` from its current
  folder by bare name (`.\foo` still works). PowerShell already behaves this way. Accepted as the
  safer default; named in the PR.
- **Not covered:** a relative entry such as `.` in the user's own `PATH` is still searched. That is
  the user's configuration and `cmd.exe` behaves the same.
- **Alternative: route every bare-name spawn through the host resolver** (the issue's stated fix,
  and this plan's first draft): ~72 sites, a new spawn API, SDK changes, test-mock churn across
  six or more files. Same protection; rejected by the owner as disproportionate.
- **Deferred, not dropped:** the issue's `commandExists` unification (three `which` forms,
  including `doctor.ts`'s `which ${cmd}` string) and converting quoted `execSync`/`run()` shell
  strings to argv. Neither is needed to close this hole; both are hygiene. Proposed as a
  follow-up issue.
- **Out of scope:** the remaining single-site `isWindows()` forks (Spec 1658 A2.5) and the
  IDE-server capability (#1890).

## Test Plan

- **Unit (all OS):** the guard; full `packages/codev` unit suite on this Windows host, recording
  the Tower PID before and after and reporting any change; known #1923 load flakes re-run once.
- **Windows behavioural:** `windows-exe-search.test.ts` (control, PATH git, ENOENT).
- **node-pty check:** the planted-file probe for an unresolved PTY command (decides step 2).
- **Windows CI:** `gh workflow run windows.yml --ref builder/pir-1911 -f purpose='#1911 exe search hardening' -f suites=true`, run linked in the PR.
- **Manual (dev-approval, this host), from a shell with the variable unset:**
  1. In a scratch repo, commit a `git.exe` (copy of `hostname.exe`) at the root.
  2. `afx spawn` a builder for it, run `porch status` and `codev doctor` inside the worktree, then
     `afx cleanup` it: everything behaves normally and nothing prints the host name.
  3. Same commands with Git removed from `PATH`: a clear "not found" error; the planted file never runs.
- **POSIX:** CI unit + e2e on Linux/macOS unchanged and green (the module is a no-op there).
