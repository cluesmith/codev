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

## FIX

Two commits.

**`8f7bdec9` — the fix.** New `packages/codev/src/lib/agent-env.ts`: one
`sanitizeAgentEnv()`, deny-by-default over the `CLAUDE_CODE_*` namespace with an
allowlist. Deny-by-default because a *missed marker* silently produces
unresumable agents, while a missed *config var* is loud or harmless — the
asymmetry decides the direction. `CLAUDE_CODE_OAUTH_TOKEN` is the allowlist's
reason for existing.

Routed through it: the Tower daemon spawn, both architect-launch sites, both
architect-reconnect sites, the terminal-create and shell-create sites (plus
their non-persistent fallbacks), and the shellper daemon spawn. The six
hand-rolled `delete cleanEnv['CLAUDECODE']` copies collapse into the one helper.
`afx tower start` now logs which markers it scrubbed. `codev doctor` grew a
"Tower Environment" section that reads the running daemon's env via `ps eww`.

**`c2414a94` — a move the fix forced.** doctor.ts importing `getProcessesOnPort`
from `agent-farm/commands/tower.ts` dragged `utils/shell.ts`'s module-scope
`promisify(exec)` in, and `doctor.test.ts` mocks `node:child_process` without an
`exec` export → all 24 of its cases died at import. Moved the function to
`agent-farm/utils/port.ts`, re-exported from tower.ts so nothing else moved.

### Verified, not assumed

- Regression test: **9 assertions fail** with the spawn-site changes reverted to
  `HEAD~1`, all 24 pass with them. (Reverted via `git restore --source=HEAD~1`
  on tracked files only, then restored — no stash, per the shared-stack rule.)
- Full suite: 5781 tests, 0 failures. Build passes.
- Doctor check against **live processes**: the real 4100 Tower → `ok`; a real
  contaminated Tower (pid 31888, started from inside a Claude session) → `warn`
  naming all 7 markers; a dead pid → `skipped`.
- End-to-end: started a Tower from this shell — which carries 7 markers — using
  the new build. It logged `Scrubbed inherited Claude Code session markers: …`
  and the resulting daemon's env was **clean**.

### Note on that end-to-end run

I meant to isolate it with `AGENT_FARM_DIR`, but the override var is actually
`CODEV_AGENT_FARM_DIR` (#1515), so the test Tower ran against the real
`~/.agent-farm` for ~11 seconds on port 14733. It contended with the real Tower
for the cloud tunnel (four connect/kick cycles in the log) before I killed it.
The real Tower survived — its `Tunnel Watch` cron succeeded at 18:27:26, after
the test Tower's shutdown. Flagging it because it was avoidable, not because it
broke anything.

### Design note for review

The spawn-site regression tests are **source-shape assertions**, not behavioural
ones. Booting a Tower + shellper to `ps eww` the grandchild is the kind of test
this repo confines to `.e2e.test.ts`. What regressed here is literally a code
shape repeated six times, so that shape is what is pinned. The *behaviour* —
what `sanitizeAgentEnv` strips and keeps — is pinned properly by unit tests.

<signal>PHASE_COMPLETE</signal>
