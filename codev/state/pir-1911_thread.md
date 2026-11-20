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
