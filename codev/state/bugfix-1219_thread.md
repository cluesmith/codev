# bugfix-1219 — tower: sanitize inherited CLAUDE_CODE_* env

Issue #1219 (area/tower). Protocol: BUGFIX, strict mode.

## INVESTIGATE

### Reproduced (live install, not assumed)

`ps eww` on the two Tower daemons running out of `.builders/task-47B5`
(ports 14701/14711) shows both carrying the full Claude Code session marker set:

```
CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT,
CLAUDE_CODE_EXECPATH, CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN,
CLAUDECODE
```

Those Towers were started from inside a Claude Code session. The 4100 Tower
(the one that spawned this builder) is currently *clean* — it was started with
the manual `env -u CLAUDE_CODE_*` workaround, which is exactly the discipline
this issue asks to automate. So the contaminated-Tower state is real and
reproducible; the clean one is a human remembering to type the workaround.

Note on probing: `env | grep ^CLAUDE` inside a Bash tool call is **not** a valid
probe — the agent's own claude process plants those vars for its children.
`ps eww <claude pid>` is the honest one.

### Root cause

Three distinct places, all inheriting a full `process.env` with no
`CLAUDE_CODE_*` handling:

1. `packages/codev/src/agent-farm/commands/tower.ts:255` — the Tower daemon is
   spawned with `env: process.env`. Whatever env `afx tower start` ran in bakes
   into the daemon and everything below it.
2. Tower's agent-spawn sites build `{ ...process.env }` and delete **only**
   `CLAUDECODE`, never `CLAUDE_CODE_*`:
   - `servers/tower-instances.ts:583`, `:1117` (architect launch, `cleanEnv`)
   - `servers/tower-terminals.ts:723`, `:1010` (architect reconnect/restart)
   - `servers/tower-routes.ts:805` (terminal create), `:3169` (shell create),
     plus the non-persistent fallbacks at `:865` and `:3235`
3. `agent-farm/commands/spawn-worktree.ts:687 createPtySession()` sends **no**
   `env` to `POST /api/terminals`, so `handleTerminalCreate` takes the
   `env || process.env` branch → the builder PTY gets Tower's whole env.

`shellper-main` passes its config `env` straight to node-pty, and node-pty
replaces the child environment wholesale — so the env Tower hands to
`SessionManager.createSession` *is* the agent's env. That makes (2)+(3) the
load-bearing leak, and (1) the upstream source.

`TerminalManager.createSession` (the non-shellper path) builds an allowlisted
`baseEnv` and is already clean — except it merges `req.env` over it.

`SessionManager.createSession` also `cpSpawn`s shellper-main with no `env`
option, so the shellper daemon itself inherits Tower's markers (visible in
`ps eww`, and it is the process that outlives Tower).

### Constraint found — do NOT blanket-strip `CLAUDE_CODE_*`

`CLAUDE_CODE_OAUTH_TOKEN` is load-bearing: `commands/consult/index.ts:713`
(`buildClaudeConsultEnv`) reads it from the agent's own env to route CMAP
traffic through the Claude subscription instead of the metered API. A blanket
strip would silently downgrade every consultation. Fix must be deny-by-default
over `CLAUDE_CODE_*` **with an allowlist** for auth/config vars.

### Scope

Well inside BUGFIX: one small shared helper (`src/lib/agent-env.ts`), ~6
call-site edits, the daemon self-scrub, a `codev doctor` check modelled on
`checkSessionLogs`, and tests. No skeleton mirror needed — this is package
source, not framework template content.

<signal>PHASE_COMPLETE</signal>
