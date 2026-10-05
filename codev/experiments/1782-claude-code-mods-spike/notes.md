# EXPERIMENT 1782: Claude Code mods for Codev (spike for #1761)

Status: **builder half complete; live Q1 and Q2 answered, Q3 retest and Q4 in progress.**
Date: 2026-10-05. Claude Code on this machine: **2.1.289** (the issue expected 2.1.288; the
reference page is written for 2.1.289, so no 2.1.289-only item was out of reach).

## Hypothesis

A small Claude Code mod can give Codev sessions four things the shell-hook path cannot,
inside the budgets the mods documentation states, in a real Codev terminal under Tower:

1. **Fail-closed guard** (#1761 candidate 1): a `tool.call` hook on Bash denies the
   irreversible acts with a reason Claude can act on, holds `porch approve` behind
   `$.ui.ask`, and denies from `.catch` when the hook throws or times out.
2. **Attribution scrub** (candidate 6): `attribution.text` returning empty text.
3. **Context band** (band half of candidate 5): `AbovePrompt` band with context percent from
   `session.measure` (the same figures as `$.session.usage()`), arch-save threshold marked.
4. **Issue peek** (candidate 13): one band chip per `#N` with a digit hotkey, a user-opened
   pane with title, state, labels, body and newest comments, `/issue N` registered
   `immediate: true`, Esc closes.

## Success criteria (fixed before running) and results

| # | Criterion | Result |
|---|---|---|
| 1 | `claude plugin validate` passes; `hooks:`/`calls:` lines recorded verbatim | **Pass.** Lines below; full output in `results/validate.txt` |
| 2 | `claude plugin test` passes with the listed cases | **Pass, 12/12** (`results/plugin-test.txt`) |
| 3 | Each hook's own time measured against the 10 s budget; `.catch` against 1 s | **Pass.** Every hook 0–1 ms in the kit, 7–9 ms for the fetch-heavy hook in a real engine |
| 4 | Issue lookup round trip through Tower's `getIssue` path, cached and uncached; record which design the numbers forced | **Measured.** Uncached 0.93–1.18 s wall, cached 0–1 ms; budget never at risk (see design note) |
| 5 | Four live-session questions answered with command + observation | **Pending handoff** (commands below) |

### 1. `claude plugin validate`, verbatim

```
  ❯ ./register.tsx hooks: tool.call{tool=Bash}, attribution.text, session.measure, session.start, turn.complete, prompt.submit, command.run{command=issue}, command.run{command=codev-spike-fetch}, command.run{command=codev-spike-timings}, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=issue-peek}, classic.SessionStart{source=clear}
  ❯ ./register.tsx calls: $.clock.after (via showRefs), $.clock.now, $.command.register, $.env.get, $.fs.read (via towerIssue), $.http.fetch (via towerIssue), $.prompt.submit, $.session.cwd (via towerIssue), $.state.get, $.state.set, $.store.delete, $.store.get, $.store.set (via getIssue, record), $.ui.ask, $.ui.copy, $.ui.log, $.ui.open (via openPeek), $.ui.resolve
```

`✔ Validation passed`, no warnings after adding `author` to the manifest.

After the Q3 change (finding 10), the `calls:` line lists `$.command.run` in place of
`$.prompt.submit`. Validation still passes.

### 2. `claude plugin test`: what the 12 tests cover

- **Guard** (`tests/guard.test.ts`). A test hook beneath the plugin stands for the shell and
  records every command that reaches it.
  - **Denied, and none reached the shell:** `git add -A`, `git add --all`, `git add .`,
    `git reset --hard`, `git reset --hard HEAD~1`, `git checkout -- .`, `git clean -fd`,
    `git stash`, `git stash push -m wip`, `git worktree remove .builders/x`,
    `git branch -D builder/x`, `gh pr merge 12 --squash`.
  - **Allowed through:** `git add path/to/file.ts`, `git status`,
    `git checkout -- path/to/file.ts`, `gh pr merge 12 --merge`.
  - **`porch approve` hold:** an `AskUserQuestion` stub answers both ways. The question is
    asked exactly once each time. `Yes, relayed verbatim` lets the command run, and `No`
    denies with "Gate not approved…".
  - **`.catch`:** when the stub throws (standing for a dismissal, or a `-p` run with no one
    to ask), the hook fails and `.catch` answers `{ deny: 'codev guard failed…' }`. The
    command never runs.
- **Attribution** (`tests/attribution.test.ts`). `commit` and `pr` come back `''`. `remedy`
  (the commit gate's own sentence) passes through unchanged.
- **Band and peek** (`tests/band-peek.test.tsx`). Mounted on **both `terminal` and
  `desktop`**:
  - The band shows `context 75% · save at 70%`, coloured yellow once over the mark.
  - A reply naming `#1672`, `PR #1131` and `#1672` again yields two chips, hotkeys `1` and
    `2`. The first is titled from a prefetch (`#1672 Lane Card: per-lane status card`).
  - **Pressing the chip by key** asks for pane `issue-peek`. The mounted pane shows the
    title, `open · area/vscode`, the body as `Markdown`, and the newest comment first.
  - Tower is hit **once** for `#1672`; every later read comes from `$.store`.
  - `/issue #1672` opens the same pane. `/issue 99999` shows Tower's 404, and `/issue abc`
    prints usage.
  - A typed prompt naming `#1672` grows a chip and is passed on unchanged.

### 3. Hook own time (the engine's meter: `next.budget.ms − next.budget.remainingMs`)

The time inside `next` and `$` calls is excluded, as the budget counts it. Meter resolution
is 1 ms, so "0 ms" means under 1 ms. These are from the plugin test run: 20 iterations of
each path, against the real engine (`results/plugin-test.txt`).

| Hook / path | n | median | max | budget |
|---|---|---|---|---|
| `tool.call` guard, deny | 20 | 0 ms | 0–1 ms | 10 000 ms |
| `tool.call` guard, pass | 20 | 0 ms | 0 ms | 10 000 ms |
| `tool.call` guard, hold approved (ask wait excluded) | 10 | 0 ms | 0–1 ms | 10 000 ms |
| `tool.call` guard `.catch` handler | 10 | 0 ms | 0–1 ms | **1 000 ms** |
| `attribution.text` | 20 | 0 ms | 0 ms | 10 000 ms |
| `session.measure` | 20 | 0 ms | 0 ms | 10 000 ms |
| `turn.complete` (ref scan + state write) | 20 | 0 ms | 1 ms | 10 000 ms |
| `prompt.submit` (ref scan) | 20 | 0 ms | 1 ms | 10 000 ms |
| `command.run` `/issue` | 20 | 0 ms | 0 ms | 10 000 ms |

In a real headless engine, `/codev-spike-fetch` makes six Tower/store round trips and
parses three full issue bodies. Its own time was **7, 8 and 9 ms** for #1761, #1782 and
#1412 (`results/tower-fetch-headless.txt`).

### 4. Issue lookup round trip (Tower `GET /api/issue`, the path #1412's click uses)

These were measured inside a real engine with `$.http.fetch`, using
`claude -p "/codev-spike-fetch <n>" --plugin-dir <mod>` run from the worktree. That is a
headless child process with no model turn: the mod's own command answers it. It is not the
builder's session.

| Issue | Tower, uncached (3 runs) | first `getIssue` (fills `$.store`) | `$.store` hit (2 runs) |
|---|---|---|---|
| #1782 | 992, 1162, 928 ms | 952 ms | 1, 0 ms |
| #1761 | 1061, 1039, 1089 ms | 1038 ms | 1, 1 ms |
| #1412 | 1116, 1016, 1184 ms | 1077 ms | 1, 1 ms |

`curl` straight at Tower agreed: 0.98–1.38 s over seven calls.

**Tower keeps no issue cache.** Every call spawns the `issue-view` forge command (`gh issue
view`), so "cached" exists only on the mod side, in `$.store`.

**Which design the numbers forced.** The budget did **not** force the timer design. A hook's
budget counts only its own code, and `$.http.fetch` time is excluded, so an inline fetch costs
the hook under 10 ms of its 10 s. The **user-facing wait** is what matters: about 1 s of
"Loading #N…" after pressing a chip. The spike therefore uses both:

- `turn.complete` and `prompt.submit` start a prefetch on a `$.clock.after(0)` timer, which
  fills `$.store` and puts titles on the chips.
- A press reads `$.store` first, so a prefetched issue opens in about 1 ms.
- `/issue N` on an issue not yet fetched shows "Loading" and then fills in.

### Findings the spike surfaced (not in the docs or the #1761 review)

1. **Tower requires the local key.** A mod reads `~/.agent-farm/local-key` with `$.fs.read`
   and sends it as `codev-tower-key`. That is the "consumer entitled to the local key"
   profile, now inside the Claude process. Without the key Tower answers 401.
2. **The `workspace` parameter must be a repo.** Tower runs the forge command with the
   workspace as its cwd. A session started outside a git checkout (the first headless run,
   from the scratchpad) got **404 for every issue**. A shipped mod should send the Codev
   workspace root (from `afx`/Tower), not `$.session.cwd()` blindly.
3. **JSX `key` is dropped on elements whose props declare no `key`** (`Text`, `Markdown`).
   `Button` and `Box` keep it, so a test-findable label needs a keyed `Box` around its
   `Text`.
4. **The test kit stands for the engine only where a test says so.** `session.measure`,
   `turn.complete`, `prompt.submit`, `session.cwd` and `ui.open` each need an `on(...)` bottom
   in the test, otherwise "no implementation for …". `console.log` works in the test
   environment although the typings omit it; the timing tables above came out that way.
5. **The test kit cannot type a digit into the composer.** It presses a band `Button` by key
   (`press`, "as a click or its hotkey does") and checks `hotkey: '1'`. Whether a bare digit
   in a real empty prompt reaches the chip is live question 2.
6. **A dismissed hold reads as a guard failure.** `$.ui.ask` rejects on dismissal, which
   lands in `.catch` with "codev guard failed". The result is correct (fail closed) but the
   reason is misleading. A shipped guard should `try`/`catch` around the ask and deny with
   "Gate question dismissed; not approved", keeping `.catch` for real faults.
7. **`claude -p "/cmd" --plugin-dir <mod>` runs a mod command with no model turn.** This is a
   cheap real-engine probe that CI could run beside `claude plugin test`.

8. **`claude plugin test` can refuse outright on a machine whose rollout switch is stale.**
   This was reported by the vscode architect when re-verifying on 2.1.289. Their first run
   failed with "hooks modules are turned off in this process: the rollout switch was saved
   off by an earlier session and is not refreshed yet". One headless `claude -p` run with
   network access refreshed the switch, and the suite then ran 12/12. **Phase-2 CI must start
   `claude` once with network before `claude plugin test`**, or a cold runner fails for a
   reason unrelated to the mod.

9. **A host check stops `$.prompt.submit` from running a slash command.** Live Q3:
   `classic.SessionStart{source:'clear'}` fired, but `$.prompt.submit({ text: '/arch-init
   spike-probe', asUser: true })` was **rejected**: "a text beginning with / would run a
   command as the user; run one with $.command.run({ command })". So candidate 8 must use
   `$.command.run({ command: 'arch-init', args: name })`. It cannot "submit as the person",
   and the #1761 review's open question on slash expansion has its answer: a mod cannot
   submit a slash command as a prompt at all.
10. **A session with the mod loaded rewrote the mod.** During live Q3, the probe `claude`
    session in the owner's tab was running in auto mode with hot reload on. It edited
    `mod/hooks/register.tsx` in this builder worktree, uncommitted, replacing the rejected
    `$.prompt.submit` with `$.command.run` (17:34 local). Neither the architect nor the owner
    made that edit by hand. The builder reviewed it, found it correct (it is the documented
    path; type-checks and validates), and committed it as its own.
    - **Consequence for #1761 decision 2:** a session that has a mod loaded and write access
      to the mod's folder will repair, and so can change, the mod it runs under. A shipped
      `codev` plugin must load from a folder the session does not write to (the installed
      package, not a worktree path). Hot reload must stay off for anything but deliberate
      authoring.
11. **Chip titles are hard-cut at the tab edge** (live Q2, 80 columns). The second chip's
    title ran into the right edge with no ellipsis. Chip labels should truncate with an
    ellipsis to their share of `bodyColumns`.

### Deviations from the issue's method

- **Guard list: one entry added**, `git checkout -- .` (regex `\bgit\s+checkout\s+--\s+\.(\s|$)`).
  The worked example's FORBIDDEN list had no pattern for it, but the success criteria require
  the deny. **Ruled by the vscode architect, option A, 2026-10-05.** The other four entries
  and the hold question are verbatim from the worked example.
- **The hooks module is `hooks/register.tsx`**, not `register.js`. It needs JSX for the band
  and pane, and TypeScript lets `tsc` check it against the engine's declarations (clean both
  with the tsconfig from the types header before any load, and as `tsc -p mod` once the
  headless run laid `.claude-plugin/types/`, which ignores itself).
- **The context band reads `session.measure`'s figures**, which the docs define as
  `$.session.usage()`'s answer at that moment, rather than calling `$.session.usage()` again.
  It is the same numbers without an extra call.
- **The arch-save threshold is a spike assumption of 70%.** The arch-save skill names no
  number, and 70% is the figure the #1761 review's band mock used.
- **Two measurement-only commands**, `/codev-spike-fetch` and `/codev-spike-timings`. They
  exist to produce the numbers above and are not candidates.

## Live-session handoff (runbook posted on #1782 for Amr)

The vscode architect re-verified the builder half on 2.1.289: validate passes and the plugin
tests run 12/12. The four questions need a person watching a rendered dialog and pane. An
architect's shell cannot observe a TUI, and Tower has no screen-snapshot API. The runbook is
on #1782 and is run by Amr, starting with `afx shell --name spike` and then the commands
below.

Builders do not load mods into their own sessions (#1761 decision 2), so these four
questions are answered by the vscode architect in a Tower terminal. Everything below starts
a **new** `claude` process. Nothing is installed, and no settings file or
`CLAUDE_CODE_PLUGIN_DIRS` is touched.

The mod's absolute path, once this branch is checked out in the builder worktree:

```
MOD=/Users/amrmohamed/repos/cluesmith/codev/.builders/experiment-1782/codev/experiments/1782-claude-code-mods-spike/mod
```

**The base command** (Q1, Q2), run in a Tower terminal inside a Codev VS Code terminal tab,
with cwd at the main checkout so Tower's issue lookup has a repo:

```
cd /Users/amrmohamed/repos/cluesmith/codev && claude --plugin-dir "$MOD"
```

The terminal must be one `afx send` can address. Tower routes mail to registered terminals,
so if the probe terminal is not addressable, record that the mail half of Q1 could not be
run this way rather than routing mail at another session.

**Q1. The `$.ui.ask` hold under Tower, with the render gate holding mail.**

1. Prompt: `Run this exact command with Bash: echo porch approve 9999 spike-gate`
   - The guard matches `porch approve` anywhere in the command, so `echo` triggers the hold
     harmlessly. Nothing calls porch.
2. While the question dialog is up, from another terminal:
   `afx send <probe terminal> "spike mail during hold"`.
3. Observe:
   - Does the dialog draw intact in the PTY and xterm?
   - Is the mail `held` (with which reason) or `delivered`?
   - Does it land on top of the dialog or in it, or wait for the prompt?
4. Answer `No`. Expect a deny reading "Gate not approved…". Does the held mail then deliver?
5. Repeat and answer `Yes, relayed verbatim`. Expect the echo to run.
6. Repeat and press Esc on the dialog. Expect "codev guard failed…" (finding 6).

**Q2. Digit-hotkey chip to an inline pane in a VS Code terminal tab, at its real width.**

1. Prompt: `Reply with one sentence that mentions #1672 and #1761.`
2. After the reply, check that the band shows `1 #1672 …` and `2 #1761 …`.
3. In the **empty** prompt, type `1` alone and pause.
4. Observe:
   - Does the pane open inline above the prompt?
   - Do the title, state and labels, body and comments render? Record `tput cols` of that
     tab.
   - Does `c` copy the URL, and does Esc close the pane?
5. Then, while Claude is working on a long prompt, type `/issue 1412`. Does the pane open
   mid-turn?

**Q3. Does a mod-submitted `/arch-init <name>` expand as a slash command?** It uses a name
with no state file, so nothing is adopted:

```
cd /Users/amrmohamed/repos/cluesmith/codev && CODEV_SPIKE_ARCH_INIT_NAME=spike-probe claude --plugin-dir "$MOD"
```

1. Type `/clear`.
2. Observe the next turn. Did the arch-init **skill** run (it reports no `codev/state/spike-probe.md`
   and asks the human, per its rules)? Or did the model receive the literal text
   `/arch-init spike-probe` as a plain message? Is the row drawn as the person's own prompt
   (`asUser: true`)?

**Q4. How a fresh, never-trusted directory's trust prompt interacts with mod loading.**

```
D=$(mktemp -d /tmp/codev-spike-trust.XXXX) && git -C "$D" init -q && cd "$D" && claude --plugin-dir "$MOD"
```

1. Before answering the trust prompt, observe whether the band or `/issue` exist yet.
2. Accept trust. Observe whether the mod loads now:
   - `/issue` appears in the typeahead.
   - A Bash `echo porch approve 1 x` is held.
   - Or a `/reload-plugins` is needed.
3. Repeat with a second fresh directory and **decline** trust. Does anything from the mod
   run?

A fresh builder worktree is a fresh directory in the same sense, so the answer transfers.
Note whether `afx spawn`'s path pre-trusts its worktrees.

### Live-session answers

*(to be recorded here from the vscode architect's report on #1782: command used and what
was observed)*

Observed by the vscode architect and Amr in a Codev VS Code terminal tab (`afx shell --name
spike`, then the commands above), 2026-10-05.

- **Q1, the hold.** The dialog drew intact in the Codev VS Code tab, tagged as coming from
  the plugin.
  - `No` → denied ("Gate not approved…").
  - `Yes, relayed verbatim` → the echo ran.
  - Esc → `.catch` deny "codev guard failed". Claude's reaction to that text was "the hook
    seems flaky", which confirms finding 6: the dismissal deny must say the human dismissed
    the question.
  - **Mail half: not runnable.** `afx send` cannot address utility shell terminals
    (`NOT_FOUND`), so the render gate's behaviour during a hold is **unanswered** by this
    run. It needs a probe session Tower registers as an agent.
- **Q2, chip to inline pane.**
  - The band showed `context 6%` with the save mark and two chips, both titled from Tower.
    The second title was hard-cut at the tab edge (finding 11).
  - Typing `1` alone in the empty prompt opened the peek **inline above the prompt**, with
    title, state, label and body as Markdown. Esc closed it.
  - `/issue 1412` mid-turn opened the pane, **docked** beside the transcript at a wider
    momentary width.
  - `tput cols` measured 80 afterwards.
- **Q3, slash expansion.** The `$.prompt.submit` route is **rejected by a host check**
  (finding 9). The `$.command.run` retest is in progress.
- **Q4, trust.** In progress.

## Conclusion (builder half)

The hypothesis holds for everything a session-less run can show:

- All four mods validate, type-check and pass 12 engine-backed tests on both drawing
  surfaces.
- Every hook's own time is two to four orders of magnitude inside its budget.
- The guard fails closed through `.catch`.

The issue peek's one real cost is Tower's uncached ~1 s forge round trip. That is a
user-wait problem, not a budget problem, and a `$.store`-backed prefetch removes it for
anything Claude has already named.

The open risks sit in the four live questions: the hold under the render gate, the
digit-to-chip path at real tab width, slash expansion, and trust.

## Recommendation on #1761 decisions 1 and 2 (provisional until the handoff answers land)

- **Decision 1 (ship a `codev` plugin): yes, conditionally.**
  - Ship it once Q2 (inline pane in a VS Code tab) and Q4 (trust) come back clean.
  - The guard and the attribution scrub carry no live-session risk. They could ship first,
    behind the existing shell hook as the floor.
  - Carry findings 1, 2 and 6 into the phase-2 design:
    - a key-reading Tower client;
    - a workspace-root parameter;
    - a dismissal-specific deny.
  - Add the `claude -p` command probe (finding 7) to CI beside `claude plugin test`.
- **Decision 2 (builders neither install nor author mods; the spawn path is the only
  loader): yes.**
  - This spike shows how little stands between a session and a mod: a folder, a flag and
    one `register`.
  - A mod at the same tier ahead of the guard could `allow` what it denies.
  - The spike itself ran entirely without loading a mod into a builder session (validate,
    test, and a headless child process), so the rule costs authoring nothing.
  - Q4's answer decides whether the spawn path must pre-trust builder worktrees for the
    plugin to load at all.
