# pir-1473 — Render gate: input-side residuals

## 2026-09-04 — PLAN phase

Spawned strict-mode PIR on issue #1473. Architect envelope: we are NOT cluesmith/codev
maintainers — a maintainer reviews and merges. Park after the pr gate; do not merge, do not
close #1473, do not clean the worktree.

### What I verified (not just read)

The architect's pre-spawn comment on #1473 re-pinned the issue against `03bc5213e` and narrowed
it. I re-checked every row of that table against the files, and it holds:

- Output side is CLOSED. `ringToken` (`mailbox-delivery.ts:520`) sampled `:606`, re-checked
  `:653` and again in-lock at `:703`; `SETTLE_BEFORE_WRITE_MS=250` + `settled()` (#1573);
  `watchEcho`/`verify()` post-write (#1573, #1584). The Notes' "consider a post-write echo
  settle" already landed — do not redo it.
- Input side has NO observation. `bytesWritten` is the ring's output counter
  (`pty-session.ts:930`); `_lastDataAt` is assigned only in `onPtyData` (`:514-516`);
  `PtySession.write()` (`:628-640`) records nothing at all.
- The code names this issue as the owner of the hole in three places:
  `mailbox-delivery.ts:696-700`, `:735-737`, `session-submit.ts:121-127`.

### Something the issue does not mention

`handleUserInput()` (`pty-session.ts:949`) ALREADY records `_lastInputAt` via
`recordUserInput()` — Spec 403 typing-awareness. So a keyboard-input timestamp exists; the gate
simply never consults it. It misses the raw `POST /api/terminals/:id/write` passthrough
(`tower-routes.ts:960` calls `session.write()` directly) and there is no byte counter. Both gaps
have to close before the gate can trust it.

### Plan shape

Two mechanisms, because the two residuals need different kinds of signal and neither covers the
other:

1. `inputBytes` counter folded into `ringToken` → closes R7 (keystroke AFTER the sample).
2. `INPUT_SETTLE_BEFORE_WRITE_MS = 300` on `lastInputAt` → closes echo lag (keystroke BEFORE the
   sample, not yet echoed). A counter comparison provably cannot see this one.

Counting is defaulted ON in `write(data, origin = 'external')` and opted OUT only by the gated
delivery's paced write. Rationale: opt-in counting at known chokepoints is how today's bug got
made. Default-on means a forgotten path holds spuriously instead of writing onto a draft.

The architect's explicit warning — the delivery's own paced write must not self-trip the signal —
is handled by that `'delivery'` origin threaded through `message-write.ts`, plus a test that runs
a real multi-line paced write and asserts `inputBytes` is unchanged across it.

During-the-write races (bytes already out) are reported, not held: flagged into the existing
delivered-unverified path. Holding there would re-write a message that DID land — the #1584
re-injection failure — for a race that only adds stray characters, unlike `preempted` where the
composer may have been cleared.

### Open question I flagged rather than guessed

The 300 ms constant is an estimate. The manual test plan measures the real keystroke→echo gap
across claude/codex, local and shellper-backed, at the dev-approval gate and adjusts.

### Deliberate non-goal

Input from a second client attached directly to the same shellper bypasses this `PtySession`
entirely and stays unobservable. Different boundary (already listed as uncovered in
`session-submit.ts:56-58`); will be documented in the review rather than papered over.

Plan committed; sitting at `plan-approval`.

## 2026-09-04 — Plan revision 2 (post-consult)

Architect ran a 2-way consult (claude + codex) plus their own verification: REQUEST CHANGES, three
blockers. I re-verified every claim against the source before revising — all held, and two were
worse than described.

### Blocker 1 — terminal reply traffic counts as human input (the one that reshapes the design)

`Terminal.tsx:639` forwards everything xterm emits on `onData`, and xterm emits terminal *replies*
through that same event. The client filter (`:655-661`) covers only DA/CPR/DECRPM and only while
`rc.initialPhase` is true — set on connect (`:421`, `:462`), cleared by `flushInitialBuffer`
(`:469`) on a short timer. So for a session's whole steady-state life the filter is OFF, and focus
(`ESC[I`/`ESC[O`) and mouse reports are never filtered in any phase.

This is the self-trip route my revision-1 `'delivery'` origin could not close, and I missed it:
our write → repaint → query → browser reply → counted as foreign input. Worse than latency —
`busy` is excluded from `isClassifierStuck`, so a chatty attached client would starve an agent
silently, forever.

Fix: server-side `stripTerminalReplies()` in `handleUserInput`, unconditional (afx attach, VS Code
webview and mobile clients don't share the client filter). Signal-only — the bytes still reach the
PTY, because the app asked for the reply.

Left `composing` alone deliberately: replies already spuriously call `startComposing()`, but
`stopComposing` drives the `'submit'` fast trigger and I'm not perturbing a delivery trigger inside
a delivery-safety issue. Confirmed `get composing()` has no production consumer, so leaving it
costs nothing. Follow-up in the review.

### Blocker 2 — `racedByInput` was in the one place it would be suppressed

The `verified === false` escalation is nested inside `if (echo)` (`:819-858`), and `echo` is null
for short/raw sends. Worse: for the Enter-truncation case the needle is the message's FIRST line,
which landed — so `verified` comes back **true** while the tail was lost, and `racedByInput` is the
only signal for that failure. Moved outside the block, plus a `cause` discriminator on
`UnverifiedDeliveryInfo` (an operator can't currently distinguish "header never appeared" from "a
human typed into it mid-write" — different remedies).

### Blocker 3 — types and four runtime-only fake breakages

`WritableSession` needs `inputSeq`. Took codex's construction for the `tracked` wrapper: hard-code
`session.write(data, 'delivery')` rather than threading an origin param, because a 1-arg function
IS assignable to a 2-arg type — TS would not catch a forgotten forward, and the failure mode is
"mail never delivers". Verified `submitMessagePaced` has exactly ONE production caller
(`mailbox-wiring.ts:301`), so hard-coding cannot mis-tag an operator write.

Four doubles break at runtime, not compile time: `tower-routes.test.ts:226` (NaN → every send test
in the file holds), `tower-websocket.test.ts:61`, `spec-1313-paced-write-drop.test.ts:33-45`, and
`send-architect-identity.test.ts:108` (calls `s.write(msg)` on a REAL session to simulate a
delivery — adding fields doesn't fix it, it must pass `'delivery'`).

### Decisions I had to make and record

- **`lastInputAt > lastDataAt`** (claude's constant-free R2 signal): evaluated, REJECTED as
  primary. It deadlocks permanently on a keystroke that provokes no output — the condition never
  clears, `busy` never escalates, that agent's mail never delivers. The reply filter removes the
  reply-driven deadlock, not the ignored-keystroke one. Recorded as the next tightening in BOUNDED
  form (hold while un-echoed, capped ~1s, then fall back) if the dev-gate measurement says 300 ms
  is too loose.
- **Counter naming:** `.length` is UTF-16 code units, so `inputBytes` would lie → `inputSeq`,
  documented as a change counter that exists to differ, not to total.
- **"Closes R2" → "bounds R2".** Named the surviving residuals in the plan, the code comments and
  (later) the review. Gave the 300 ms a rollback criterion.
- **"A keystroke removes nothing" was wrong** — a human Enter mid-write submits our partial body;
  `^U`/`^W`/`^C` truncate. Flag-not-hold survives, but the WARN text has to say "may have been
  truncated or submitted early".
- **Delayed `^C` rationale was wrong** — `tower-routes.ts:1834` is documented as firing UNATTENDED.
  It should still count, but for the reason that it changes composer state, not "a human is there".
- **Counter's real justification restated:** claude was right that the settle alone largely covers
  headline R1. The counter is load-bearing for (a) waits longer than the settle —
  `OPERATOR_SUBMIT_WAIT_CEILING_MS = 2000`, so a lock wait can be 2 s between sample and precheck —
  and (b) verdict-memo invalidation, which no settle bounds. Named both, or a future reader deletes
  the counter as redundant.

### Two corrections in my favour (architect's own grep)

- `isUserIdle`/`lastInputAt` have NO production consumers — Spec 403 is a test constraint, not a
  live one. The gate becomes `lastInputAt`'s first real consumer.
- `QUIESCENCE_DEBOUNCE_MS = 500` > 300, so quiescence-triggered passes are automatically
  input-settled in the normal case. But I had to sharpen the `'submit'` claim the other way:
  `scheduleDrain` runs in a microtask, so that pass is now *provably always* held, not "largely
  unaffected".

Revision 2 committed. Still at `plan-approval`.

## 2026-09-04 — Plan revision 3 (post 3-way CMAP)

Verdicts split: gemini APPROVE, claude 3 blockers, codex 4. Architect adjudicated the
disagreements against source. I re-verified everything myself before accepting — including
enumerating the pinned xterm 5.5.0 bundle rather than relaying the review's table. All six items
confirmed, and my own enumeration turned up a hazard nobody raised.

### The hazard nobody raised — case sensitivity

The adopted final-byte rule is `/\x1b\[[?>=]?[0-9;]*\$?[cnty]/g`. If that character class ever
carries an `i` flag it eats `ESC[C` (Right arrow), `ESC[1;5C` (Ctrl-Right), `ESC[F`/`ESC[H`
(home/end) and `ESC[Z` (shift-Tab) — silently re-opening R1 for ordinary keyboard navigation,
which is the exact corruption this issue exists to close. Pinned by explicit survival tests.

I confirmed the rule is safe against the bundle's full key table: key finals are
`~ A B C D F H I O Z` plus `R` and `M`/`m`. Nothing a key can produce ends in lowercase c/n/t/y.

### What I verified in the bundle myself

Emitted: DA1 `ESC[?1;2c` `ESC[?6c`; DA2 `ESC[>0;276;0c` `ESC[>83;40003;0c` `ESC[>85;95;0c`;
DSR `ESC[0n`; XTWINOPS `ESC[4;h;w t` `ESC[6;h;w t` `ESC[8;rows;cols t`; CPR `ESC[r;cR`;
DECXCPR `ESC[?r;cR` (TWO params — my revision-2 pattern demanded three); DECRPM
`ESC[<?>f;v$y`; OSC colour terminated by ST. So revision 2's "self-trip completely closed"
was FALSE — DSR and XTWINOPS are precisely the output-provoked class.

### Reversal 1 — mouse reports must COUNT, not be stripped

claude and codex directly contradicted each other, so I checked. Codex is right: the mouse
encoders build their string from a DOM-derived event object `{col,row,button,action}` and hand it
to the generic `triggerDataEvent` path — not a parser reply callback. A mouse report is a human
action that changes the composer (click moves the cursor, middle-click pastes, drag selects).
Stripping it re-opens R1 for mouse-driven TUIs. Row removed.

Focus reports (`ESC[I`/`ESC[O`) stay stripped and that is consistent: focus cannot alter composer
CONTENT, and a click that could carries its own mouse report, which is now preserved.

### Reversal 2 — build the one-shot re-drain now, don't defer it

"Measure first" is the right instinct against a speculative optimisation and the wrong one against
a proven certainty. The submit-trigger hold is analytic: `stopComposing` emits `'submit'`
synchronously after `recordUserInput`, and `scheduleDrain` runs in a microtask, so
`lastInputAt === now` at that pass, always. Nothing left to measure. And one timer mitigates three
things at once — the submit case, the navigation-key case, and the escalation-blind residual
below.

### My own false claim, corrected

Revision 2 justified the counter partly on "a delivery can sit on the lock for up to 2s".
FALSE — verified: `trySubmitToSession` returns false immediately on contention
(`session-submit.ts:479`); deliveries DECLINE, they never wait. `OPERATOR_SUBMIT_WAIT_CEILING_MS`
is what an operator waits while a DELIVERY holds the line — the opposite direction. I quoted that
asymmetry in my own plan and then argued from the wrong side of it. It matters because these
justifications become a code comment, and a false one there is worse than none.

Real justification: memo invalidation (sufficient alone — a CachedVerdict survives across backstop
ticks, bounded by no settle), plus the unbounded awaits inside the gap (`await classify` at :626
AND `await watchEcho` at :715, the latter scanning up to 1000 mirror lines).

### Other fixes

- The interactive sender was STILL being told `verified: true` on an input-raced delivery —
  `tower-routes.ts:2288-2289` surfaces only `outcome.verified` and `send.ts:462` warns only on
  `=== false`. So the exact Enter-truncation case section 6 exists for reported plain success.
  Added result-level `unverifiedCause` threaded to the CLI; precedence `'input-raced'` wins; the
  WARN no longer prints "needle 0 chars".
- Deleted `'pre-recorded'` — an unenforced bypass asserting something the type cannot check.
  Filter moves inside `write()`'s external branch: 3 origins → 2, raw route covered free.
- `WritableSession` as specified would not compile (`tracked` literal lacked a required field).
  Split: `WritableSession` keeps the 1-arg write; the paced seam takes
  `& { id: string; readonly inputSeq: number }`.

### Decide-item nobody had named: the escalation-blind input hold

`hold('busy')` nulls `detail` (:591-596) and plain `busy` is excluded from `isClassifierStuck`
(:400-405). So a missed reply RECURRING under 300ms holds indefinitely and silently; the only net
is `escalateHeldToOwner` at ~180s, skipped for architects — a starved architect would be entirely
silent. My revision-2 line "a spurious hold the backstop clears" was too optimistic.

Chose BOTH halves: a `'recent-input'` gate detail (so `afx inbox` says `busy:recent-input` through
the existing shared formatter) AND a consecutive-input-hold counter WARNing at ~60 holds (≈90s —
a human types in bursts; 90s of unbroken sub-300ms input is a machine). The detail must NOT join
`isUnverifiableVerdict` — it sits beside `user-text`, and escalating it would false-alarm on every
ordinary typist. That predicate is an allow-list, so adding the value is inert there by
construction.

### Corrections to my own residual list

Residual 3 now says an `afx attach` client is wholly out of scope — its input AND its terminal's
replies. It connects straight to the shellper socket (`commands/attach.ts:141-142`) and never
touches `PtySession`. Consequence for the test plan: manual step 1 CANNOT be run against
`afx attach` — logging at `handleUserInput` would show zero chunks and read as a false pass.
Substituted the VS Code integrated terminal (different xterm build, and the surface whose reply
set may differ).

Also noted the general rule behind the `send-architect-identity` breakage: `recordUserInput()`
uses `Date.now()` while the gate uses `ports.now()`, so ANY test pairing a fake clock with a real
`PtySession` breaks and adding fields never fixes it. Adding an injectable clock to
`PtySessionConfig` as the seam.

Revision 3 committed. Still at `plan-approval`.

## Implement phase

Plan revision 3 approved; implementing it as written. Four commits, tests alongside.

### What I verified before writing code, rather than taking the plan's word

The plan's xterm emission table is the load-bearing claim in the whole change — an under-strip
holds mail with nobody typing, an over-strip silently stops counting real keys. So I enumerated
`triggerDataEvent` in the pinned 5.5.0 bundle myself rather than trusting revision 3's table.
It held up, and three details are worth recording:

- The DA2 `linux` branch emits `e.params[0]+"c"` with **no ESC prefix** — a bare `"0c"`. Nothing
  ESC-anchored can strip it, so on a `TERM=linux` client it would count as 2 chars of input.
  Under-strip = spurious hold = fail-safe, and it is now visible as `busy:recent-input` rather
  than silent. Left alone deliberately: an unanchored `0c` pattern would eat real typing.
- X10 mouse goes out via `triggerBinaryEvent`, not `triggerDataEvent`, and `Terminal.tsx` wires
  only `onData` — so it never reaches the server from the web client at all. The X10 survival
  test is therefore about the filter's shape, not a live path.
- `requestStatusString` builds DECRQSS as `ESC + "P1$r…" + ESC + "\"`, which the plan's pattern
  matches. Confirmed rather than assumed, because that one is easy to get wrong by an ESC.

### Two deviations from the plan, both forced

1. **§3's type split as literally specified does not compile.** The plan keeps `WritableSession`
   at a one-arg `write` and types the paced seam as `WritableSession & { id; inputSeq }` — but
   the wrapper body calls `session.write(data, 'delivery')`, which is a two-arg call against a
   one-arg type. Introduced a standalone `PacedWriteSession` instead (id + inputSeq + an
   origin-taking `write`). `WritableSession` is untouched, so no helper or fake churns, and a
   one-arg `write` is still assignable to the seam — which is what keeps the delivery module's
   structural `DeliverySession` fakes working without an origin they never pass.

2. **A token that moved is not necessarily input.** The plan folds `inputSeq` into `ringToken`
   and then re-holds with `detail: 'recent-input'` on any token mismatch. But the token also
   carries `bytesWritten` and the geometry, so an ordinary repaint would have been reported to
   every operator surface as "a human is at the keyboard" — a false statement on the row. I
   sample `inputSeqBefore` separately and attribute: `recent-input` only when the input half is
   what moved, plain detail-less `busy` otherwise. Same guard, honest label.

### Test-double migration — the plan's classification was right about the shape, wrong about one file

`spec-1313-paced-write-drop.test.ts` was predicted to break at COMPILE time. It does not:
`packages/codev/tsconfig.json` excludes `**/__tests__/**`, so no test in this repo is
type-checked by the build at all. Every double therefore fails (or doesn't) at RUNTIME only,
which makes `tower-routes.test.ts` the one that actually mattered — it reaches the live mailbox
binding, so a missing `lastInputAt` gives `now() - undefined` = NaN, and NaN fails the settle's
positive comparison, holding every send test in the file. That one is now commented in place so
the next person adding a field knows why it is not optional.

### Baseline discipline

Ran the suite at the merge-base in a scratch worktree before trusting any red. Baseline: 1 file
failing (`worktree-write-guard`, environmental — it passes in this worktree). Post-change:
285 files pass, 0 fail. So every red I saw mid-flight was mine, and every one is now green.

Still to do: the manual verification steps at the dev-approval gate — they are why this is PIR
and not AIR, and the 300 ms constant has a rollback criterion attached to step 2.

## dev-approval evidence — and the bug it found

The architect sent the gate back for evidence, correctly: I had requested it on build-green +
suite-green, which is not what this gate asks. Built
`packages/codev/scripts/pir-1473-dev-approval-evidence.mts` on the 1365/1475 precedent —
isolated Towers on private ports, real shellper-backed PTYs, real HTTP + WebSocket endpoints —
and committed the transcript to `codev/evidence/1473-dev-approval-transcript.txt`. 20/20.

### The evidence found a real gap that no unit test could have

Step 5 measured the input-hold recovery at **237.8ms**. That is not the re-drain; it is almost
exactly the quiescence debounce (500ms) minus my pre-send wait. The re-drain should have fired
at ~60ms.

Cause: `tower-routes.ts:2266` — the `afx send` REQUEST path calls `deliverAgentMailSerialized`
DIRECTLY, not through the drainer. So `armInputRetry` never sees that pass's outcome and the
`retryAfterMs` is dropped on the floor. Every unit test I wrote drives the drainer, so all 27
passed while the operator-facing path silently fell through to quiescence or the backstop — in
precisely the case where a human is sitting there watching the send.

Fixed with `MailboxDrainer.noteOutcome()`, called from the request path. Re-measured: **61.9ms**,
and the assertion now compares against the QUIESCENCE debounce rather than the backstop, because
"faster than 1.5s" would have passed while quiescence did all the work — which is exactly how I
missed it the first time. Two regression tests added, one of them pinning that the direct pass
arms nothing on its own.

This is the whole argument for the PIR gate in one finding. "Tests pass" was true and useless.

### The calibration, and what it does and does not prove

Keystroke→echo, measured on the real client path (terminal WebSocket → handleUserInput → write
→ PTY → app repaint → ring → WebSocket), one clock, no polling interval:

| combo | n | p50 | p95 | p99 |
|---|---|---|---|---|
| claude, shellper-backed | 40 | 0.9ms | 1.3ms | 4.2ms |
| codex, shellper-backed | 40 | 0.7ms | 1.1ms | 3.3ms |

Rollback criterion NOT fired — worst p99 is 4.2ms against a 300ms budget, ~70x margin. But the
fixture is a repaint shim, not a real harness, so this is a LOWER BOUND and the script says so
where it evaluates the rule. Confirming against real claude/codex is on the human list.

### Two things I could not script, and did not fake

- **The local (non-persistent) PTY combos** fail inside the Tower with `nodePty.spawn is not a
  function`. I reproduced it identically against a build of the merge-base, so it is
  pre-existing and outside this issue — recorded as a SKIP carrying its reason rather than
  fixed here or quietly dropped.
- **The "vs main" baseline** could not be the shared main checkout: its `dist` is from July and
  no longer even starts (`./reconnect-policy` is not exported by its vendored codev-core). I
  build a detached worktree at the merge-base instead, which is the better comparison anyway —
  exactly the code this branch changed, nothing else moving. Path comes from
  `PIR1473_BASELINE_DIST`; unset makes every delta SKIP rather than report one-sided numbers.

### A script bug worth naming, since it briefly looked like a code bug

The first run "failed" `--escape still writes its body through`. `--escape` writes a bare ESC
and returns — it never writes a body, by design (tower-routes.ts:2109). The script was wrong,
not the code; the assertion now checks the ESC reached the terminal.

### Latency deltas against the merge-base

- Idle terminal (the common path): branch 5.4ms vs baseline 7.3ms — **−1.9ms**, no regression.
- Freshly-painted terminal: branch 442.1ms vs baseline 441.0ms — **+1.1ms**. Both hold on the
  output settle and recover on quiescence, so the new input guard costs essentially nothing
  here.

Still outstanding: manual steps 1, 3 and 4, plus the real-harness half of step 2. Named
precisely in the transcript and not marked done.

## The human runbook (`codev/evidence/1473-human-runbook.md`)

Manual steps 1, 2 (real-harness half), 3 and 4 need hands. This is the tooling and the script
for them, written so a human who has read neither the plan nor the diff can execute it.

### Why the runbook cannot say `afx`

`afx send` and `afx inbox` build `new TowerClient()` with no port, so they always talk to the
live Tower on 4100 — where two real builders are running. A runbook that said `afx send` would
drive them. `scripts/pir-1473-human-harness.mts` therefore carries its own `send` / `inbox`
against an isolated Tower on 14793 (own DB, own workspace, own shellper socket dir), rendering
through the SAME shared `formatVerdict`, so the pass string in the runbook is the string a real
operator sees.

It also must not say `afx attach`: attach talks to the shellper socket directly and never
touches `PtySession`, so step 1 would log zero chunks and read as a pass. That is residual 3,
and it is the one way this runbook could certify nothing while looking green.

### Four things the smoke test found that guessing would have missed

1. **`GET /api/inbox` answers with a bare array**, not `{messages:[…]}`. My first `inbox`
   printed "(no held messages)" over a populated mailbox — which in step 4 is precisely the
   FAIL shape. A runbook whose pass criterion can be faked by a client bug is worthless, so
   this one is now read the way `afx inbox` reads it.
2. **Ctrl-C on `up` is not teardown.** Shellper sessions are detached by design, so the harness
   processes outlived the Tower and sat in `ps` looking exactly like real builders. Added a
   `down` subcommand that matches on the isolated run directory in each process's own argv —
   a string nothing on the live Tower can carry — and the runbook now ends with it.
3. **Activating the workspace auto-creates an `architect` terminal** running `claude`. So
   "the last terminal in the list" is not reliably the probe; `up` now writes the probe's id to
   a file and `calibrate` reads it. Calibrating the wrong app would have produced a number that
   looked fine and meant nothing.
4. **A human cannot race the 300 ms settle from a second terminal.** Step 3 (mouse) needs a
   click within the settle of the gate's sample. `send --delay N` turns that unrepeatable race
   into an 8-second interval the human can simply be clicking through; step 4 uses the same
   trick to place the send at ten different points in a keystroke stream.

### The trace, verified end to end

`AF_LOG_INPUT_SIGNAL=1` on a live Tower, bytes pushed over the terminal WebSocket:

```
[input-signal 3c09c9db] raw="\e[?1;2c"     stripped="\e[?1;2c"  survived=<NOTHING> inputSeq=0→0
[input-signal 3c09c9db] raw="x"            stripped=<none>      survived="x"       inputSeq=0→1
[input-signal 3c09c9db] raw="a\e[12;40Rb"  stripped="\e[12;40R" survived="ab"      inputSeq=1→3
```

A reply moves nothing, a keystroke moves the counter, and a mixed chunk splits correctly. The
runbook's step 1 also asks the human to type one character *after* the hands-off minute — a
silent trace and a clean trace look identical, and without that check a wiring failure would
read as the strongest possible pass.

`escapeBytes` exists so these lines cannot repaint the terminal they are being read in; a test
now asserts no recognized reply survives it with a raw control byte.

### State

Build green. Full suite: **286 files passed, 3 skipped, 5819 tests, 0 failures** — unchanged
from before this work. Live Tower on 4100 verified listening and untouched after every run;
isolated port 14793 free; no leftover processes.

Still parked at `dev-approval`. Not opening the PR, not approving the gate.

## Runbook revision 2 — the architect was right about step 4

The human's run passed 1a, 2 and 3. Two problems came back, and the step 4 one is mine.

### Step 4 asserted something its own procedure made unobservable

Step 4 told the human to type printable characters and then expect `busy:recent-input`. It
cannot happen. `mailbox-delivery.ts:797` returns on `!verdict.clean` — a non-empty composer is
`user-text` and returns — and the input-settle check is at `:840`, after it. So `recent-input`
is structurally unreachable the moment there is a draft on screen.

The uncomfortable part: I had already reasoned this out. The evidence script picks a Right-arrow
for step 5 for exactly this reason and says so in a comment — "a printable character would leave
a draft and hold `user-text`, which is the OLD guard and proves nothing about this issue". I
wrote the correct reasoning for the scripted step and then wrote the manual step as if I hadn't.
The human's 10/10 `busy:user-text` was a correct observation of the wrong thing.

Split into **4a** (empty composer, cursor-only input — Left/Right/Home/End — expecting
`busy:recent-input`; this now carries the 10 varied repetitions) and **4b** (the original typing
procedure, expected verdict `busy:user-text`, proving draft integrity and labelled as evidence
for the pre-existing guard). Up/Down are excluded from 4a: they recall history into the composer
and would void the rep.

### This time I ran the procedures before writing them down

Against a real `claude` on the isolated Tower, not a shim:

- **4a works.** `pending → busy:recent-input → DELIVERED`, arrows about twice a second.
- **Cadence matters, and not in the obvious direction.** At ~10 presses/sec the row sits mostly
  in plain `busy`: fast input generates echo, the OUTPUT settle is checked first (`:835`), and
  it fires before the input settle ever runs. Holding the key down would have looked like a
  weaker result while actually testing a different guard. The runbook now says press
  deliberately, and says plainly that a bare `busy` is not a failure.
- **A rep against a busy agent is void.** After a delivered message, claude is mid-turn and
  every subsequent send returns `user-text` — I watched one sit there for 45 s and briefly took
  it for a defect. Each rep must start from an idle agent and an empty composer.
- **4b confirmed:** typing holds `busy:user-text` and stays there until the draft is cleared.

### The two-hands problem, and `--watch`

Revision 1 said "keep clicking, then run `h1473 inbox`" — but stopping to type in the other
terminal ENDS the condition being measured, and a single sample afterwards cannot tell "never
held" from "held and already cleared". `send --watch N` now polls the row and prints a verdict
timeline. It is better evidence than a point sample: the hold and its self-clearing recovery
appear in one trace.

### Step 1b — the probe was invisible to VS Code, and the settings were not the problem

`codev.towerPort` is honoured everywhere (no 4100 hardcodes outside tests). The Agents view
reads ONLY `/api/overview`, which left-joins the live terminal registry onto a `readdirSync` of
`<workspace>/.builders/` (`overview.ts:866-869`) and matches via `worktreeNameToRoleId`
(`overview.ts:475-512`) — which rewrites a directory `pir-1473-probe` to the roleId
`builder-pir-1473`. My harness created no `.builders/` directory and registered the literal
roleId `pir-1473-probe`, so it failed both halves of the join at once. The browser renders from
the registry directly, which is why the same session was visible there and nowhere in VS Code.

`up` now creates `<ws>/.builders/pir-1473-probe/` and registers as `builder-pir-1473`. Verified
against the endpoint itself rather than by reasoning: `/api/overview` now returns
`{roleId: "builder-pir-1473", id: "pir-1473-probe"}`. 1b is not marked passed — the human
re-runs it.

Tower 4100 confirmed listening and untouched after every run; 14793 free; no leftover processes.
Still parked at `dev-approval`.

## Runbook revision 3 — the same mistake, one layer down

4a passed, all reps. 1b failed again, differently: the row now appears but clicking it says
"#1473's terminal isn't available yet".

### I verified the half I had changed. Again.

Rev 2 fixed the listing and verified the listing. But listing and clicking read different
sources:

- **list** — `/api/overview`, filesystem-derived; the row's `id` is the DIRECTORY NAME verbatim.
- **click** — `views/builders.ts:439` hands that same `b.id` to `openBuilderByRoleOrId` →
  `resolveBuilderTerminal` → `resolveAgentName` (`agent-names.ts:39-60`), matched against
  `/api/state`'s ids by EXACT or TAIL match.

`pir-1473-probe` satisfies the first and fails the second: `builder-pir-1473` neither equals it
nor ends with `-pir-1473-probe` → `kind: 'missing'` → exactly the toast. Renaming the directory
to `pir-1473` satisfies both, since `builder-pir-1473` ends with `-pir-1473`.

That is twice on the same step. The failure mode is not "I checked the wrong endpoint" — it is
that I chose the check AFTER choosing the fix, so the check could only confirm the fix. The
check has to be picked from the user's action ("click the row"), not from the diff.

### The architect's root cause was on the right path but the wrong database

They reported zero `builders` rows and no builder-type `terminal_sessions` for the harness
workspace. That was read from `global.db` — but `up` runs the Tower with
`AF_TEST_DB=test-1473-14793.db`, so none of the harness state is in `global.db` at all. Queried
live, `/api/state` already returned `{id: 'builder-pir-1473', terminalId: 'cc838076…'}` with a
non-null terminal id, which is what they asked me to confirm.

So I did NOT add a `builders` row. `/api/state`'s builders come from the terminal registry
(`entry.builders`), not that table — proven by it returning a live terminalId while the table is
empty. A synthetic row in a table that afx and porch own would buy nothing on the click path.
The one thing it would change is cosmetic: the row groups under `UNKNOWN` because the group is
the porch phase and this throwaway workspace has no porch project. The runbook now says so, so
the human does not read it as a fault.

### `vscode-check`

New subcommand, and the useful part is what it refuses to do: it does not re-check
`/api/overview`. It reproduces the click — takes the row id from the overview, fetches
`/api/state` the way the client does, and calls **the extension's own `resolveBuilderTerminal`**,
imported rather than reimplemented (`terminal-resolve.ts` is vscode-free precisely so it can be
driven this way). A local copy of the matching rules would agree with itself and prove nothing.

Run against the live Tower before the fix it printed the human's failure verbatim
(`FAIL: resolved "missing"`); after renaming the directory, `PASS`. The rename was applied to
the RUNNING workspace, so 1b is retryable immediately — the Tower was not torn down.

The runbook's 1b now opens with `vscode-check` as a pre-flight, so the next failure names the
broken lookup instead of presenting as a toast.

Tower 4100 and both real builders untouched throughout. Still parked at `dev-approval`.
