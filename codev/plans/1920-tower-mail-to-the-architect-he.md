# PIR Plan: Windows architect claude draws an ASCII `>` composer marker, so its mail is held forever

## Understanding

### What the gate actually saw (captured, not inferred)

Fix-shape step 1 asked for the mirror's viewport at the moment of a `no-composer-marker`
verdict. I captured it read-only on the owner's machine, against the live Tower, while the
three messages to `main` (c11d1897, 0d01a748, 0d3090dd) were still `held / busy:no-composer-marker`:

- Opened a viewer WebSocket to `/ws/terminal/887fdcae…` (the `main` architect). It sent nothing
  (no input, no resize) and closed after the replay frame. The replay frame is
  `SessionScreen.serialize()`, the same mirror the gate classifies.
- Rendered it at the session's geometry (75×38, from `/api/terminals/:id`) and ran the installed
  production `classifyScreen` with `CLAUDE_PROFILE`. The verdict was
  `{ clean: false, reason: 'busy', detail: 'no-composer-marker' }`, matching the hold.

The screen is a normal, idle, fully painted claude. Nothing is torn and the geometry is right:

```
32 |✻ Crunched for 1m 48s · done 10:56 AM
33 |                                   √ Update installed · Restart to update
34 |───────────────────────────────────────────────────────────────────────────
35 |>
36 |───────────────────────────────────────────────────────────────────────────
37 |  ⏵⏵ auto mode on (shift+tab to cycle)
```

The composer marker is an **ASCII `>`**, not `❯`, and the tick is `√`, not `✔`. These are the
ASCII fallbacks of the `figures` glyph set, which claude uses when it decides the terminal does
not support Unicode. `CLAUDE_PROFILE.markerPattern` is `/^[❯›]/`
(`packages/codev/src/agent-farm/servers/gate-profiles.ts:61-66`, `COMPOSER_MARKER`), so
`findMarkerRow` (`render-gate.ts:243-264`) finds nothing and `locateComposerRegion` returns
`no-composer-marker` (`render-gate.ts:395`). The gate is behaving as designed; the screen is one
the claude profile has never been taught.

### Every architect, no builder

I repeated the capture for every live claude session on the machine:

| session | kind | `❯` on screen | verdict |
|---|---|---|---|
| 887fdcae (codev `main`) | architect | 0 (`>`) | no-composer-marker |
| 873ac6e2 (tiny-timesheets) | architect | 0 (`>`) | no-composer-marker |
| 0fdbd4df (tiny-timesheets `windows`) | architect | 0 (`>`) | no-composer-marker |
| 7f1ae4ca (builder-pir-1920) | builder | 1 | clean |
| 163ab488 (builder-pir-1919) | builder | 1 | clean |

So the split is not reconnected vs freshly spawned. It is **architect vs builder**. All current
holds follow a Tower restart only because architects are long-lived and every one on this machine
was spawned before it.

### Why architects and not builders: `TERM`

- Architects are launched as a bare `claude` straight into ConPTY. Their env is
  `sanitizeAgentEnv(process.env)`, which is Tower's inherited env plus harness and identity vars
  (`tower-instances.ts:635-640` and `:1171-1176`; reconnect restart options at
  `tower-terminals.ts:812-822` and `:1298-1303`). Nothing sets `TERM`.
- Builders are launched as `bash.exe` running `.builder-start.sh`. Git Bash sets
  `TERM=xterm-256color` itself when it is missing (measured: with `TERM` unset in the environment,
  `bash.exe -c 'echo $TERM'` prints `xterm-256color`). claude inherits it from bash.
- On Windows, node-pty does **not** derive `TERM` from the `name: 'xterm-256color'` option (on
  POSIX it does), so a direct launch gets only what the env carries.
- claude's Unicode check on win32 looks at `WT_SESSION`, `TERM_PROGRAM=vscode`,
  `TERM=xterm-256color` and similar. A Tower started from a console that sets none of them gives
  its architects no Unicode support.

Measured directly. claude.exe under ConPTY with `TERM`, `WT_SESSION`, `TERM_PROGRAM` and
`COLORTERM` removed draws `> ` and no `❯`. The same launch with only `TERM=xterm-256color` added
draws `❯`. No prompt was sent in either run.

The Spec 1658 recorder (`packages/codev/scripts/spec-1658-conpty-capture.mts:140-141`) sets
`env.TERM = 'xterm-256color'` itself, so every committed ConPTY fixture is a `❯` screen and the
architect's real launch env was never recorded. That is why the ConPTY replay suite passed.

On POSIX the gap does not exist: node-pty sets `TERM` from `name`, and claude's non-Windows
Unicode check passes for any `TERM` except `linux`.

### The 2026-11-17 09:34–09:37 `busy:user-text` / `composer-redraw` holds (fix-shape step 3)

All five went to tiny-timesheets `main` (3efb9be9, 4a59d2d4, 656ca893, 9582f824, 03a05014). Each
**delivered on its own**, after 37.8 s, 1.9 s, 0.4 s, 0.7 s and 0.7 s. A `user-text` or
`composer-redraw` verdict means a composer marker was found, so that session was drawing `❯` at the
time. They are not this bug. Their short lifetimes fit a human at the line and a composer
repainting, which is what those verdicts are for. No screen from that window survives, so "a human
was typing" cannot be proven after the fact. Nothing points to a false hold, and I propose no
change for them.

## Proposed Change

There are two parts. Part 1 removes the cause. Part 2 makes the gate read the screen claude
actually draws, so sessions already running heal without restarting claude, and a future
non-Unicode env cannot silently stop mail again.

### 1. Give every Tower-launched agent PTY a `TERM` that matches the PTY it runs in

Tower tells node-pty the terminal is `xterm-256color`. The child's env should say the same. Add
one helper next to `sanitizeAgentEnv` in `packages/codev/src/lib/agent-env.ts`,
`withPtyTerminalType(env)`, which returns `{ ...env, TERM: 'xterm-256color' }`, and apply it at the
single Tower-side chokepoint every shellper launch and relaunch goes through,
`packages/codev/src/terminal/session-manager.ts`:

- `createSession` (`:390-450`): the env handed to the shellper for the first spawn (`env: opts.env`
  at `:423`);
- every `client.spawn({ … env: session.options.env })` relaunch (`:1526-1531` fresh rerun,
  `:1601-1606` crash restart) and the crash-loop fallback env swap (`:1628`);
- the reconnect path that adopts `restartOptions.env` (`:761`).

Applied at the chokepoint rather than at the four architect env builders, so builders, shells and
any future direct launch get it too, and no caller can forget it. `TERM` is set unconditionally,
as `terminalProfile()` (`lib/platform/windows/command-launch.ts:139`) and node-pty on POSIX already
do. An inherited `TERM=xterm` (from mintty, say) is still wrong for this PTY, and claude's win32
check does not accept plain `xterm`. On POSIX this changes nothing, because node-pty already sets
it.

What part 1 does not heal: a claude process that is already running keeps its env. On the next
relaunch (a crash restart, or Tower's resume after a shellper restart) the new env applies through
the `spawn` path above. Until then part 2 covers it.

The recorder gets the same treatment. `spec-1658-conpty-capture.mts` gains a `--bare-env` switch
that skips its own `TERM` injection, so the screen production used to produce can be recorded.

### 2. Teach the claude profile its ASCII-fallback marker

Change only `CLAUDE_PROFILE`'s `markerPattern` (`gate-profiles.ts:61-66`) to accept claude's ASCII
pointer: `/^(?:[❯›]|>(?= |$))/`. That is `❯`/`›` as before, or `>` followed by a space or the end of
the row. `COMPOSER_MARKER` stays as it is for codex.

Why this does not weaken the gate:

- claude uses the same `figures.pointer` glyph for its composer, its picker cursor and its echo of
  a submitted turn. In fallback mode all three become `>` together, so the new pattern sees exactly
  the ambiguity the `❯` pattern has always handled. Nothing new is allowed through. The captured
  screen shows this: row 6 is the turn echo `> yes file the two issues…`, and row 35 is the
  composer. `findMarkerRow` keeps the last match, and the region still needs its rule below (row 36)
  and zero normal-intensity cells. A picker drawn as `> 1. Yes` still holds as `user-text`,
  exactly like the `❯` picker fixture.
- claude indents its assistant output (`● `, `  ⎿ `, two-space continuation), so its own content
  does not begin a row with `> `.
- Fail-safe stays intact. Anything that is not a bounded, empty composer is still not clean. No
  hold becomes a force-inject; this only lets the gate see a composer that is really there.

## Files to Change

- `packages/codev/src/lib/agent-env.ts`: add `withPtyTerminalType(env)` (doc comment: why the
  Windows child env must carry `TERM`, and that node-pty on Windows does not set it).
- `packages/codev/src/terminal/session-manager.ts:423, :761, :1526-1531, :1601-1606, :1628`: route
  the child env through `withPtyTerminalType`. I will grep for any other `client.spawn(`/`env:`
  site in this file and apply the same.
- `packages/codev/src/agent-farm/servers/gate-profiles.ts:61-66`: a claude-specific marker pattern
  with a comment citing this issue and the measured fallback.
- `packages/codev/src/agent-farm/servers/render-gate.ts`: comments only. The header's list of why a
  marker can be missing gains "claude's ASCII fallback (#1920)".
- `packages/codev/scripts/spec-1658-conpty-capture.mts:136-144`: `--bare-env` switch.
- New fixtures:
  - `packages/codev/src/agent-farm/__tests__/fixtures/gate/claude-ascii-marker-idle.replay.bin.gz`:
    a real idle claude screen with the ASCII `>` composer, recorded on this machine with
    `--bare-env` and scrubbed by the recorder. Expected: **clean**, and **no-composer-marker under
    the old pattern** (the repro).
  - `claude-ascii-marker-draft` (typed text): **busy / user-text**.
  - `claude-ascii-marker-echo` (a prior turn's `> …` echo above an empty composer): **clean**, with
    the marker row asserted to be the composer and not the echo.
  - If the recorder can drive it, a ConPTY timed capture
    `conpty/conpty-claude-ascii-idle.capture.jsonl.gz` for the replay suite (`expect: delivered`).
- `packages/codev/src/agent-farm/__tests__/fixtures/gate/README.md`: provenance rows for the
  above, plus a note that the recorder's default env sets `TERM`.
- Tests:
  - `render-gate.test.ts`: the three fixtures, and a picker case (`> 1. …` rows) that stays busy.
  - `session-manager` tests: the first spawn and each relaunch path carry `TERM=xterm-256color`
    when the caller's env lacks it or carries `xterm`.
  - `agent-env` unit test for the helper.
- `codev/resources/lessons-learned.md` (cold tier): a fixture recorder that adds env production
  does not add records the wrong screen.

## Risks & Alternatives Considered

- **Risk: setting `TERM` changes some other tool's behaviour in builder or shell PTYs.** Builders
  already get `xterm-256color` from Git Bash and shells from `terminalProfile()`, so in practice
  only direct launches (architects) change, and they change to what the PTY really is. Mitigation:
  the session-manager tests pin it, and the Windows workflow runs on the branch.
- **Risk: the `>` marker matches a non-composer row and yields a false clean.** It would need a
  final `> ` row followed by a rule line with nothing normal-intensity between. Every claude screen
  of that shape is a composer, because picker and echo rows carry normal-intensity text after the
  pointer. The echo fixture and picker test cover this. Codex and agy profiles are untouched.
- **Alternative: inject `TERM` only in the four architect env builders.** Rejected. It is four
  places to keep in step, and it misses the shellper relaunch paths whose env comes from stored
  options.
- **Alternative: fix only the env (part 1).** Rejected as incomplete. Already-running architects
  keep the fallback screen until claude relaunches, so the acceptance case (Tower restart, idle
  architect, send delivers) would still fail for them. Any other route to a non-Unicode claude (a
  user `TERM` override, a future claude heuristic) would bring back a permanent silent hold.
- **Alternative: fix only the profile (part 2).** Rejected as incomplete. It leaves architects on a
  degraded ASCII UI and leaves the recorder blind to the production env.
- **Alternative: set `WT_SESSION` or `TERM_PROGRAM` instead.** Rejected. Those claim a specific
  host terminal that is not there. `TERM` describes the PTY Tower actually created.

## Test Plan

- **Unit / fixture (CI):** the new fixtures classify as stated; under the old `/^[❯›]/` pattern the
  idle ASCII fixture classifies `no-composer-marker` (asserted in the test as the regression repro);
  all existing POSIX gate fixtures and `spec-1658-conpty-gate-replay.test.ts` stay green; the
  session-manager env tests pass.
- **Windows workflow:** dispatch `windows.yml` on the branch (`suites=true`), since this touches
  process spawning env, and link the run in the PR.
- **Manual at dev-approval (owner's machine):**
  1. `pnpm local-install` from the worktree (restarts Tower).
  2. Without touching the architect, check `afx inbox`. The three held messages to `main` should
     deliver on the backstop drainer's next pass (part 2), and the architect should receive them.
  3. `afx send architect "1920 test"` to an idle architect: `delivered`.
  4. Snapshot the architect again (same read-only WS capture) and confirm the classifier says
     `clean`.
  5. Relaunch claude in one architect (or wait for a natural restart) and confirm it now draws
     `❯` (part 1).
  6. A freshly spawned builder still delivers (no regression).
