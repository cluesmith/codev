# pir-1911 thread

## 2026-11-20 — plan
- Re-inventoried with a TS-AST scan: 72 user-tool sites, not 36. The issue missed every agent-farm `run('git …')` shell string (19), tower-routes/tower-instances, porch checks/state, team-update, team-github, import.ts:59.
- Root hole beyond the sites: `resolveSpawnable` returns the bare name when it does not resolve on PATH, so libuv falls back to a cwd-first lookup. Same for relative PATH entries. Fix in the SDK resolver (fail closed, `found` flag), then every caller through `commandLaunch()`.
- No shell-string site uses pipes/redirects/||; only quoting. argv conversion is a straight swap.
- Static guard as a vitest AST test (like windows-console-spawn-guard), not a script.
- Plan at codev/plans/1911-windows-bare-name-user-tool-sp.md; waiting at plan-approval.
