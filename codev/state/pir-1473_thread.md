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
