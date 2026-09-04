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
