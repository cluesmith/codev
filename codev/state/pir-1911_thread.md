# pir-1911 thread

## 2026-11-20 — plan
- Re-inventoried with a TS-AST scan: 72 user-tool sites, not 36. The issue missed every agent-farm `run('git …')` shell string (19), tower-routes/tower-instances, porch checks/state, team-update, team-github, import.ts:59.
- Root hole beyond the sites: `resolveSpawnable` returns the bare name when it does not resolve on PATH, so libuv falls back to a cwd-first lookup. Same for relative PATH entries. Fix in the SDK resolver (fail closed, `found` flag), then every caller through `commandLaunch()`.
- No shell-string site uses pipes/redirects/||; only quoting. argv conversion is a straight swap.
- Static guard as a vitest AST test (like windows-console-spawn-guard), not a script.
- Plan at codev/plans/1911-windows-bare-name-user-tool-sp.md; waiting at plan-approval.

## 2026-11-20 — plan revised (small version, owner direction)
- Measured: libuv and cmd.exe both honour `NoDefaultCurrentDirectoryInExePath` set in-process. My first draft's claim that libuv ignores it was untested and wrong.
- Gotcha: the Claude Code shell on this host already exports that variable, which masks the hazard in any naive probe. Tests must spawn a child with it unset as a control.
- New approach: a side-effect module imported first in every bin + tower-server + shellper-main; VS Code cli-process refuses unresolved bare names; node-pty unresolved case to be tested.
- Deferred to a follow-up: commandExists unification and shell-string-to-argv conversion.

## 2026-11-20 — implement
- node-pty: does its own C++ lookup (path_util::get_shell_path), PATH only, no PATHEXT, never the terminal cwd. Unresolved bare names fail "File not found". pty-command.ts unchanged.
- Terminals get a hand-built env (windowsPtyBaseEnv allowlist), so they do NOT inherit the variable. Docs say so; told the architect.
- Real-path proof: `porch init` in a repo with a planted git.exe (variable unset). Without the hardening import: "Command failed: git add" and no commit, so the planted file ran. With it: real commit. `codev doctor` is NOT a good probe: it never runs bare git in the cwd.
- Windows CI dispatched: https://github.com/cluesmith/codev/actions/runs/44725012668
- Full codev suite on this host: 8123 passed, 2 failed (load flakes, pass on re-run: launch-loop-exit-code EPERM temp cleanup; bugfix-1814-check-timeout 2574ms > 2500ms). Tower PID 37868 before and after. VS Code suite 1282 passed.
- Windows CI 44725012668: all green except Unit Node 22, tower-lifecycle scenario 5 ECONNRESET (also failed on pir-1919 run 44258108002 before this change; passes 3/3 locally). Re-ran the failed job.
- porch tests check blocked twice by bugfix-1814-check-timeout under load (2574/3271/2690ms vs 2500); asked the architect.
- Owner asked for a generic name: renamed to lib/process-bootstrap.ts (general first-run setup); the Windows step moved to lib/platform/windows/exe-search.ts. Guard test renamed process-bootstrap.test.ts. Build, tsc and both tests pass.
- Node switched to nvm (22.23.4). Commands run with PATH prefix C:\nvm4w\nodejs and npm_config_script_shell=Git Bash (architect ruling, my commands only). node-pty and better-sqlite3 load and work on 22.
- porch done x2 alone on Node 22: build pass; tests fail only on bugfix-1814 (2767ms); one Vitest worker-exit unhandled error. Tower PID 53132 unchanged. Owner: test fixed in #1946; wait, then merge main and re-run porch done.
- Merged origin/main (#1947 timing-test fix). porch done #1: build pass, tests fail on 2 known #1923 flakes (tower-lifecycle scenario 4: agent pid not alive after restart; launch-loop-exit-code EBUSY on temp rmdir); both pass alone (5/5, 3/3). porch done #2: build + tests pass. Tower PID 53132 before and after. Gate dev-approval pending.
- Owner decision (option A): every Tower terminal carries the variable. Earlier claim that terminals use the windowsPtyBaseEnv allowlist was wrong: persistent terminals get Tower's env. New test in tower-lifecycle.windows.test.ts (builder, API shell, dashboard shell tab); control with the bootstrap removed fails ('unset'), with it passes. Gotcha: the test env had the variable as NODEFAULTCURRENTDIRECTORYINEXEPATH, so a plain delete missed it; the test removes it case-insensitively. Docs and plan corrected; cmd.exe change named (.\name still works; PowerShell already behaves so).
- porch done alone after terminal-coverage change: build + tests pass. Tower PID 53132 before/after. Windows CI 45078247361 green (pre-terminal-test); new run dispatched on 53a1f3cba. At dev-approval.
