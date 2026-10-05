# EXPERIMENT 1782: Claude Code mods for Codev (spike for #1761)

Status: **complete.** Builder half and all four live questions answered. One sub-question
(mail during the hold) could not be run, and is recorded as such.
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
| 2 | `claude plugin test` passes with the listed cases | **Pass, 16/16** (`results/plugin-test.txt`; 12 at handoff, plus 4 for the post-live fixes) |
| 3 | Each hook's own time measured against the 10 s budget; `.catch` against 1 s | **Pass.** Every hook 0–1 ms in the kit, `.catch` 0–1 ms (n=20, real faults), 7–9 ms for the fetch-heavy hook in a real engine |
| 4 | Issue lookup round trip through Tower's `getIssue` path, cached and uncached; record which design the numbers forced | **Measured.** Uncached 0.93–1.18 s wall, cached 0–1 ms; budget never at risk (see design note) |
| 5 | Four live-session questions answered with command + observation | **Answered**, except Q1's mail half: `afx send` cannot address a utility shell (see Live-session answers) |

### 1. `claude plugin validate`, verbatim

```
  ❯ ./register.tsx hooks: tool.call{tool=Bash}, attribution.text, session.measure, session.start, turn.complete, prompt.submit, command.run{command=issue}, command.run{command=codev-spike-fetch}, command.run{command=codev-spike-timings}, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=issue-peek}, classic.SessionStart{source=clear}
  ❯ ./register.tsx calls: $.clock.after (via showRefs), $.clock.now, $.command.register, $.command.run, $.env.get, $.fs.read (via towerIssue), $.http.fetch (via towerIssue), $.session.cwd (via towerIssue), $.state.get, $.state.set, $.store.delete, $.store.get, $.store.set (via getIssue, record), $.ui.ask, $.ui.copy, $.ui.log, $.ui.open (via openPeek), $.ui.resolve
```

`✔ Validation passed`, no warnings after adding `author` to the manifest.

These lines are from the final mod. At handoff, the `calls:` line listed `$.prompt.submit`
where it now lists `$.command.run`: the Q3 change, findings 9 and 10.

### 2. `claude plugin test`: what the 16 tests cover

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
  - **Dismissed hold:** when the stub throws (a dismissal, or a `-p` run with no one to
    ask), the guard denies with "The human dismissed the gate question…", not "guard failed"
    (finding 6, fixed after live Q1).
  - **`.catch`:** a store whose writes fail makes the hook itself fault before the command
    runs. `.catch` answers `{ deny: 'codev guard failed…' }` for a plain command, a
    forbidden one, and `porch approve`, and none of them reaches the shell.
  - **`.catch` cannot fail open:** with **every** write failing, the handler's own
    bookkeeping fails too and it still denies (finding 12).
- **Attribution** (`tests/attribution.test.ts`). `commit` and `pr` come back `''`. `remedy`
  (the commit gate's own sentence) passes through unchanged.
- **Band and peek** (`tests/band-peek.test.tsx`). Mounted on **both `terminal` and
  `desktop`**:
  - The band shows `context 75% · save at 70%`, coloured yellow once over the mark.
  - A reply naming `#1672`, `PR #1131` and `#1672` again yields two chips, hotkeys `1` and
    `2`. The first is titled from a prefetch and fitted to its 33-cell share of a 76-cell
    band: `#1672 Lane Card: per-lane status…`.
  - Chip titles are cut with an ellipsis to their share of the band, and the number always
    stays whole. At 60 cells beside the context line, each chip gets 12 (finding 11, fixed
    after live Q2).
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
| `tool.call` guard, hold dismissed (ask wait excluded) | 10 | 0 ms | 0 ms | 10 000 ms |
| `tool.call` guard `.catch` handler (real faults, flaky store) | 20 | 0 ms | 1 ms | **1 000 ms** |
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
6. **A dismissed hold read as a guard failure.** `$.ui.ask` rejects on dismissal, which
   landed in `.catch` with "codev guard failed". The result was correct (fail closed) but
   the reason misled: live Q1 showed Claude reading it as "the hook seems flaky".
   **Fixed:** a `try`/`catch` around the ask now denies with "The human dismissed the gate
   question, so porch approve was not run…", and `.catch` is left for real faults.
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
11. **Chip titles were hard-cut at the tab edge** (live Q2, 80 columns). The second chip's
    title ran into the right edge with no ellipsis. **Fixed:** each chip's label is fitted to
    an even share of `bodyColumns` (less the context line, the `1: ` hotkey and the gap),
    with the title cut by an ellipsis and the number kept whole. `Button` takes no `wrap`
    prop, so the mod fits the label itself.
12. **A `.catch` handler that throws makes the guard fail OPEN.** The docs: past its grace,
    or on a throw, "the hook is absent as if it had no handler", and `next(e)` runs on its
    behalf, so the command runs. The worked example's `.catch` only returns a deny and is
    safe. The spike's first `.catch`, though, also wrote its timing to `$.store`, and a
    failing store would have let the command through. Fixed in two ways:
    - the handler's own bookkeeping is wrapped and never throws;
    - the hook records **before** calling `next`, so a bookkeeping fault fails closed rather
      than denying a command that already ran.

    Rule for the shipped guard: a `.catch` handler does nothing that can fail, and the hook
    does all its fallible work before `next`.
13. **Trust, from Codev's code: `afx spawn` does not pre-trust builder worktrees.**
    - No Codev code writes Claude Code trust state. A search of `packages/codev/src` finds no
      `hasTrustDialogAccepted` and no write to `~/.claude.json`. The only trust-related code
      is `gate-profiles.ts` treating agy's trust dialog as busy.
    - This builder nevertheless started with no trust prompt. `~/.claude.json` holds a
      trusted entry for the **main checkout**, which contains `.builders/`, and **none** for
      this worktree's own path.
    - Builders here also launch with `--dangerously-skip-permissions`. This repo's
      `.codev/config.json` sets it; `codev init`/`adopt` set it only when skip-permissions is
      chosen.
    - So the worktree is covered either by the trusted parent checkout or by the
      skip-permissions flag. Codev's code cannot say which: that decision is Claude Code's.
    - With Q4 (decline exits; accept loads the mod with no reload), the practical answer:
      adopters whose builders run without that flag and outside a trusted parent will see
      the modal trust prompt at spawn, and the plugin loads once it is accepted. Phase 2
      should check that case directly before relying on the plugin in builders.

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
6. Repeat and press Esc on the dialog. Expect "codev guard failed…" (as run; finding 6
   since changed this to a dismissal deny).

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
- **Q3, slash expansion.**
  - `classic.SessionStart{source:'clear'}` fired.
  - The `$.prompt.submit` route is **rejected by a host check** (finding 9).
  - Retested with `$.command.run({ command: 'arch-init', args: 'spike-probe' })` (the change
    finding 10 describes). The arch-init **skill ran exactly as written**: it found no state
    file for `spike-probe`, listed the architect state files, asked the human, and adopted
    nothing.
  - **Candidate 8 is proven on the `$.command.run` path, and only on that path.**
- **Q4, trust.** Run in a fresh `mktemp -d` git repo with `claude --plugin-dir "$MOD"`.
  - The trust prompt is **modal** (No, exit / Yes, trust). Nothing can be typed before it
    is answered, so no mod surface is reachable.
  - **Declining exits the process.**
  - After accepting, `/issue` was listed at once. **No `/reload-plugins` was needed.**
  - In short, trust gates the session, not the mod separately. For builders, see finding 13:
    Codev does not pre-trust worktrees.

## Conclusion

**The hypothesis holds.** It was tested in a real Codev VS Code terminal tab under Tower and
in the engine's own test kit. One sub-question could not be run with the tools available.

- **Guard.**
  - Denies every listed irreversible act with a reason Claude acts on.
  - Holds `porch approve` behind a dialog that draws intact in a Codev tab.
  - Fails closed through `.catch`: proven with real faults, including the handler's own
    failure.
  - The live run surfaced two wording and fail-open details, now fixed: findings 6 and 12.
- **Attribution scrub.** Empty commit and PR attribution, with the engine's own gate
  sentences left alone.
- **Context band.** Live in the tab (`context 6%` with the save mark), updated from
  `session.measure`.
- **Issue peek.**
  - A digit typed alone opens a user-opened pane inline above the prompt in an 80-column
    VS Code tab, and Esc closes it.
  - `/issue N` works mid-turn.
  - Titles come from Tower's `getIssue` path. Their cost is a ~1 s user wait on a cold
    issue (Tower keeps no cache), not a budget risk, and the `$.store` prefetch hides it for
    anything Claude has named.
- **Budgets.**
  - Every hook's own time is 0–1 ms against 10 s, and the fetch command's 7–9 ms in a real
    engine.
  - `.catch` takes 0–1 ms against 1 s.
- **Not answered: how the render gate treats mail while the hold is up.** `afx send` cannot
  address a utility shell. It needs a probe session Tower registers as an agent, which no
  current afx command starts with a `--plugin-dir`. Candidate 7 (mailbox delivery) inherits
  this question.

Things the docs and the #1761 review did not predict:
- `$.prompt.submit` cannot run a slash command; only `$.command.run` can (finding 9).
- A session with a mod loaded rewrote that mod in a builder's worktree (finding 10).
- The `.catch` fail-open trap (finding 12).
- Tower needs the local key, and a repo workspace (findings 1 and 2).
- CI must warm `claude` before `claude plugin test` (finding 8).

## Recommendation on #1761 decisions 1 and 2

- **Decision 1, ship a `codev` Claude Code plugin from the package: yes.** The live questions
  that gated it came back clean: the inline pane in a VS Code tab (Q2), and trust (Q4: trust
  gates the session, and the mod loads on accept with no reload). Ship in this order and
  shape:
  1. **Guard and attribution scrub first.** They carry no drawing risk. Keep the shell write
     guard as the cross-harness floor, and route both through one mod so the shell hook is
     never silently skipped (the ordering rule in #1761).
  2. **Context band and issue peek next.**
     - Fit labels to `bodyColumns` (finding 11).
     - Send Tower the workspace root rather than the session cwd (finding 2).
     - Add a small Tower-side issue cache, or keep the mod's `$.store` prefetch, to remove
       the ~1 s cold wait.
  3. **The plugin loads from the installed package folder, never a path a session writes**
     (finding 10). Hot reload stays off outside deliberate authoring.
  4. **CI:**
     - warm `claude` with one networked run (finding 8);
     - run `claude plugin test`;
     - add a `claude -p "/<cmd>" --plugin-dir` probe (finding 7).
  5. **Candidate 8 (arch-init on clear) is viable**, through `$.command.run` only (findings
     9 and Q3). Gate it on `afx whoami` naming an architect.
  6. **Before relying on the plugin in builders,** check the spawn case finding 13 leaves
     open: a builder launched without `--dangerously-skip-permissions`, in a worktree
     outside a trusted parent.
- **Decision 2, builders neither install nor author mods, and the spawn path is the only
  loader: yes, and the spike strengthens it.**
  - Finding 10 is the case the decision anticipated, observed live: a session with a mod
    loaded and write access to the mod's folder changed the mod it runs under, unasked.
    The change happened to be correct; the next one need not be.
  - Write the rule into the builder role. The shipped plugin's folder must not be one a
    builder session writes to.
  - The spike shows the rule costs authoring nothing. All of the builder's work was done
    without loading a mod into its session: validate, plugin test, headless `claude -p`
    probes. The live questions went to a human-watched session.
