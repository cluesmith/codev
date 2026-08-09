# PIR Plan: Builder crash-restart resumes the session instead of respawning fresh

## Understanding

Every builder runs inside a generated `.builder-start.sh` wrapper. Since #1244/#1267 the wrapper's loop is produced by `buildLaunchLoop(initial, fresh)` (`packages/codev/src/agent-farm/commands/spawn-worktree.ts:839`) with a shared tail (`launchLoopTail`, `spawn-worktree.ts:803`) that branches on exit code:

- **Clean exit (0)** — deliberate quit: clear screen, wait for Enter, relaunch the *fresh* invocation (#1267).
- **Unnatural exit (nonzero / signal, bash reports 128+N)** — sleep 2, rerun the loop's current command.

The bug is in the unnatural branch of a **fresh spawn**: the loop's only command is the fresh, prompt-carrying invocation (`claude <role> "$(cat .builder-prompt.txt)"`), so a jetsam SIGKILL (137) respawns a brand-new session that re-reads the spawn prompt with total amnesia. My own worktree's `.builder-start.sh` is a live specimen of exactly this. Only the *recovery* variant (`startBuilderSession` with a `resume` object, `spawn-worktree.ts:944-949`) enters on `--resume <id>` and therefore survives crashes.

The architect side already solved this end-to-end (#832/#1145/#1149/#1224/#1264): mint a UUID at spawn, pin via `harness.session.newSessionArgs`, resume the pinned id on crash restarts, degrade to fresh when the session is unresumable, and mint a **new** id for the fresh rerun after a clean exit (`tower-utils.ts:397-401, 458-529`). Builders can't reuse that machinery directly — architects are Node-spawned by the shellper, builders are a generated bash script — so the same state machine must be expressed in the generated script.

## Proposed Change

Teach the generated launch loop a per-lifetime session state machine, gated on harness support. For the Claude harness (the only one with `HarnessProvider.session`):

### 1. Mint and pin at spawn

`startBuilderSession` mints `crypto.randomUUID()` and the initial invocation becomes:

```
claude <role-fragment> --session-id "$codev_session_id" "$(cat .builder-prompt.txt)"
```

Fresh mint per spawn only — never a persisted id reused across spawns (#1224 lesson). Only the crash loop *within one wrapper lifetime* resumes it.

### 2. Crash restart resumes instead of replaying the prompt

The nonzero branch switches the loop to a resume invocation:

```
claude --resume "$codev_session_id" '<short crash-resume nudge>'
```

No role fragment (the transcript already contains it — same rule as the existing resume path). The **nudge prompt** is essential for autonomy: `--resume` without a prompt restores the conversation but leaves the agent idle waiting for input, which for an unattended builder converts amnesia into a stall. The nudge is a fixed short message ("You were automatically restarted after a crash; your conversation is restored. Re-check state — `porch next <id>` in strict mode — and continue."). Implementation will verify empirically that `claude --resume <id> "<prompt>"` accepts a positional prompt before relying on it (fallback if not: resume without prompt and document the stall risk as strictly better than amnesia).

### 3. Unresumable-session degrade (bounded fast-fail fallback)

A `--resume` against a gone/corrupt jsonl or a held id (#1145/#1149/#1224 lessons) dies fast and would otherwise crash-loop every 2s forever. The wrapper counts **consecutive fast failures** (nonzero exit with elapsed runtime `< $codev_fast_fail_secs`, default 15, overridable via `CODEV_LAUNCH_FAST_FAIL_SECS` for tests, measured with bash `$SECONDS`). Three in a row → mint a **new** id, fall back to the pinned fresh (prompt-replay) invocation — i.e. today's behavior, but crash-protected going forward. A slow failure resets the counter.

### 4. Clean exit: stay fresh (per #1267), but pin a new id

**Design question the architect flagged: should the Enter-gated relaunch after a clean exit resume instead?** My answer: **no — keep fresh, with a newly minted id.**

Argument: #1267 (builders) and #1264 (architects) both shipped, deliberately and recently, the rule that a clean exit means the user ended *that conversation*, and the relaunch "must not" revive it — #1267 exists precisely because the resume variant's relaunch resumed the conversation the user had just quit. Reversing that here would flip shipped semantics twice in two releases and resurrect the original complaint. The continuity the architect wants is real but already served: a user who wants their context back has `afx spawn --resume` / recover; a user who double-Ctrl+C'd and pressed Enter chose a fresh start. What the relaunch *was* missing is crash protection — so the relaunch mints a **new** UUID and runs the pinned fresh invocation, mirroring `buildArchitectFreshLaunch` (#1264: "each rerun is a genuinely new conversation and needs its own id"). Subsequent crashes then resume the *new* conversation, never the superseded one (sticky, one-way — preserving #1267's invariant).

Because the new id is minted at runtime in bash, the script needs a mint helper: `uuidgen | tr '[:upper:]' '[:lower:]'` (macOS/util-linux), falling back to `/proc/sys/kernel/random/uuid` (Linux), falling back to an **unpinned** fresh invocation — today's exact behavior, graceful degradation. While the loop is on the unpinned command, a crash reruns it unpinned (never `--resume` of a stale id).

### 5. Harness seam (no Claude flags outside the harness)

`HarnessProvider.session` grows optional script-fragment forms, mirroring the existing dual-form convention (`buildRoleInjection`/`buildScriptRoleInjection`, `buildResume` returning both `args` and `scriptFragment`):

```ts
session?: {
  newSessionArgs(sessionId: string): string[];
  resumeArgs(sessionId: string): string[];
  /** Script-fragment forms; idExpr is a pre-quoted shell expression, e.g. `"$codev_session_id"`. */
  newSessionScriptFragment?(idExpr: string): string;   // claude: `--session-id ${idExpr}`
  resumeScriptFragment?(idExpr: string): string;       // claude: `--resume ${idExpr}`
  verifyOwnership?(...): boolean;
}
```

The session-aware loop is generated only when both fragment forms exist. Codex / Gemini / OpenCode / custom harnesses (no `session`) get the current loop **byte-for-byte** — zero behavior change, verified by test.

### 6. Persist the current id for later unification (#1112 — coordinate, don't absorb)

The wrapper maintains `.builder-session-id` in the worktree: written at spawn by Node, rewritten by bash on every re-mint. Key input for #1112: the *bash script* is the only party that knows the current id after a clean-exit or degrade re-mint, so a spawn-time-only DB write would go stale — the worktree file (or a bash-side update hook) is the accurate source. This PR only *writes* the file; consuming it in `afx spawn --resume` / `workspace recover` (replacing mtime discovery) stays in #1112. `buildResume` mtime discovery is untouched here.

### 7. Entry-on-resume (recover) path

Unchanged entry semantics: `initial` remains the harness's discovered-id resume fragment (no nudge — recover flows have a human in the loop). But the loop around it becomes session-aware with `codev_session_id` preset to the discovered id: a crash after recovery resumes the same conversation *with* the nudge, a clean exit re-mints and goes pinned-fresh (today it switches to *unpinned* fresh — strict improvement, same #1267 semantics).

### Generated script shape (Claude harness, fresh spawn)

```bash
codev_session_id='<uuid minted at spawn>'
codev_fast_fail_secs="${CODEV_LAUNCH_FAST_FAIL_SECS:-15}"
codev_mint_session_id() { ... uuidgen → /proc fallback → empty ... }
codev_persist_session_id() { printf '%s\n' "$codev_session_id" > '.builder-session-id'; }
codev_launch_pinned()   { claude <role> --session-id "$codev_session_id" "$(cat '<prompt>')"; }
codev_launch_unpinned() { claude <role> "$(cat '<prompt>')"; }              # degraded: no mint available
codev_launch_resume()   { claude --resume "$codev_session_id" '<nudge>'; }
codev_relaunch_fresh()  { new id → pinned, else unpinned; persist; }
codev_launch=codev_launch_pinned   # (= a plain initial fn on the recover path)
codev_fast_fails=0
codev_persist_session_id
while true; do
  codev_started=$SECONDS
  "$codev_launch"
  status=$?
  codev_elapsed=$(( SECONDS - codev_started ))
  if [ "$status" -eq 0 ]; then
    clear; echo "...Press Enter to relaunch fresh..."; read -r || exit 0
    codev_relaunch_fresh; codev_fast_fails=0; continue
  fi
  if [ "$codev_elapsed" -lt "$codev_fast_fail_secs" ]; then codev_fast_fails=$((codev_fast_fails+1)); else codev_fast_fails=0; fi
  if [ "$codev_fast_fails" -ge 3 ]; then
    echo "Agent failing immediately; starting a fresh conversation with the original prompt in 2 seconds..."
    codev_relaunch_fresh; codev_fast_fails=0
  elif [ "$codev_launch" = codev_launch_unpinned ]; then
    echo "Agent exited (code $status). Restarting in 2 seconds..."   # no id to resume
  else
    echo "Agent exited (code $status). Resuming the conversation in 2 seconds... (Ctrl+C to quit)"
    codev_launch=codev_launch_resume
  fi
  sleep 2
done
```

`afx reset`'s `harnessFromLaunchScript` (reset/context.ts:401) detects the harness by command-position scan per line; `claude` stays at command position inside the functions (as it already does in the #1267 two-function variant), so reset keeps working — covered by a test.

## Files to Change

- `packages/codev/src/agent-farm/utils/harness.ts:79-92` — add `newSessionScriptFragment` / `resumeScriptFragment` to the `session` seam; implement on `CLAUDE_HARNESS` (`:157-163`). Other harnesses untouched.
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts:803-862` — extend the loop builder: session-aware variant (state machine above) alongside the existing `buildLaunchLoop` (kept verbatim for session-less harnesses); `launchLoopTail` reworked accordingly.
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts:880-969` (`startBuilderSession`) — mint `crypto.randomUUID()` when the harness has script-form session support; write `.builder-session-id`; generate the session-aware script on both the fresh and resume-entry paths.
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts:995-1033` (`buildWorktreeLaunchScript`) — same session-aware loop for worktree-mode spawns (no prompt file; pinned fresh is the role-injected interactive invocation).
- `packages/codev/src/agent-farm/__tests__/` — new executed-loop tests (pattern of `bugfix-1267-launch-loop.test.ts`: real bash + fake agent scripting exit codes) + harness unit tests; see Test Plan.
- Mirror check: nothing in `codev-skeleton/` documents the wrapper's loop mechanics (it's generated code), but I will grep both trees for `.builder-start.sh` / restart-loop mentions and update any docs that describe the fresh-respawn behavior (e.g. builder role docs describing "Tower's while-true loop will relaunch you with the same prompt" — that wording changes).

## Risks & Alternatives Considered

- **Risk: `claude --resume <id> "prompt"` might not accept a positional prompt.** Mitigation: verify empirically first (memory lesson: check CLI flags via `--help`/trial before coding). Fallback: resume without the nudge — context preserved, builder idles until poked; still strictly better than amnesia, and `afx interrupt`/`afx send` can wake it.
- **Risk: `--session-id` collision at first launch** (id somehow taken). Fresh random mint per spawn makes this negligible; if it happens, the launch fast-fails and the bounded fallback re-mints — self-healing.
- **Risk: uuidgen unavailable on some Linux.** Fallback chain ends in unpinned fresh = exactly today's behavior; no new failure mode.
- **Risk: jetsam kills the *resumed* process quickly and repeatedly** (memory pressure persists) → after 3 fast deaths we replay the prompt fresh. That's the correct degradation: identical to today's behavior, and #1227 addresses the pressure itself.
- **Risk: breaking `afx reset` / `modeFromBuilderPrompt`.** The prompt file is still written once at spawn and never rewritten (#1267 invariant preserved); harness detection still finds `claude` at command position. Both covered by tests.
- **Alternative: reverse #1267 and make the clean-exit relaunch resume** (architect's lean). Rejected above (§4) — flips freshly shipped, deliberate semantics and reintroduces the complaint that motivated #1267; continuity-after-quit is already served by `--resume`/recover.
- **Alternative: put the whole state machine in Node** (shellper-style CrashLoopFallback for builders). Rejected: builders are PTY-launched bash scripts by design (persistent across Tower restarts); moving restart logic into Tower would couple builder liveness to Tower liveness — a much larger architectural change.
- **Alternative: generic `argsToScriptFragment(args)` helper instead of new seam methods.** Rejected: the seam's dual-form convention (`buildResume`, `buildScriptRoleInjection`) keeps flag shape *and* escaping owned by the provider; a generic escaper would be a second convention.
- **Alternative: absorb #1112 (DB-persisted builder session ids + consumption).** Rejected per architect guidance: this PR writes `.builder-session-id` as the accurate current-id surface and leaves storage/consumption decisions to #1112.

## Test Plan

Executed-loop tests (extending the `bugfix-1267-launch-loop.test.ts` harness — real bash, fake agent with scripted exit codes, argv log). **Layer caution (#1244 finding): the wrapper sees bash's 128+N for signal deaths, while node-pty reports `{exitCode: 0, signal: 9}` — these tests run real bash and assert wrapper-layer codes only; no node-pty fixtures.** Fast-fail threshold driven via `CODEV_LAUNCH_FAST_FAIL_SECS` so tests stay fast.

- Unit: crash (exit 137) → second invocation is `--resume <spawn-id> <nudge>`, NOT the prompt replay; first invocation carried `--session-id <spawn-id>` and the prompt as a single argument.
- Unit: clean exit → Enter → relaunch is pinned fresh with a *different* id, carries role + prompt; a subsequent crash resumes the *new* id (sticky one-way switch, #1267 invariant).
- Unit: resume fast-fails 3× → falls back to pinned fresh (prompt replay) with a new id; `.builder-session-id` reflects each re-mint.
- Unit: slow failure (fake agent sleeps past threshold) resets the fast-fail counter.
- Unit: session-less harness (codex/gemini/custom) → generated script byte-identical to current output (string assertion) and behaviorally unchanged (executed).
- Unit: resume-entry (recover) variant → enters on discovered-id resume without nudge; crash → resume same id with nudge; clean exit → pinned fresh new id.
- Unit: `harnessFromLaunchScript` still detects `claude` from the new script shape; prompt file untouched on resume.
- Unit (harness.ts): Claude's `newSessionScriptFragment`/`resumeScriptFragment` render the expected flags around a caller-supplied id expression.
- Manual (dev-approval gate):
  1. Spawn a scratch builder; `kill -9` its claude pid → observe "Resuming the conversation in 2 seconds…" and the builder waking with context intact (it should re-orient via the nudge).
  2. Double-Ctrl+C then Enter → fresh session, new id in `.builder-session-id`; then `kill -9` → resumes the *new* conversation.
  3. Delete the session jsonl under `~/.claude/projects/<encoded-worktree>/`, `kill -9` → three fast resume attempts, then fresh prompt-replay relaunch.
  4. Spawn with a codex builder command (or inspect the generated script) → unchanged loop.
  5. `afx reset` against the new script → still identifies the claude harness.
