# Rebuttal — Spec 1470, Phase 3 (self-refresh core) iteration 1

**Verdicts**: Codex REQUEST_CHANGES (2 issues + 1 environment note) · Claude APPROVE (0 blocking,
5 comments).

**All accepted.** Codex found two defects in the safety-critical path, and one of them is the kind
this phase exists to make impossible. Claude approved but its first comment identified a hole in a
guarantee my own module header claims — so I closed it here rather than deferring it to Phase 4 as
suggested.

---

## Codex 1 — the step log recorded actions AFTER performing them *(accepted; my error, and it
undermined the whole testing strategy)*

My module header claimed actions are "appended to an ordered step log BEFORE being performed". The
code did the opposite: `await terminal.sendRaw('/clear'); step('clear');`.

Codex names the consequence exactly, and it is the serious one: **`sendRaw` can succeed on the wire
and still throw client-side.** In that case the builder IS cleared, the call reports failure, no
`clear` step is ever logged — and the run reports "no clear happened" about a context that no
longer exists. Worse, every one of my `expectNoClear()` assertions would agree with it. The tests I
built specifically to be non-vacuous would have passed over a destroyed builder.

**Changed**: the irreversible action is now logged *before* it is attempted.

- `clear-attempted` — appended before `sendRaw`, never removed.
- `clear` — appended only on success.

`clear-attempted` without `clear` means **"we do not know"**, which is the truth and is reportable.
Everything downstream had to learn that distinction:

- `expectNoClear()` now asserts the absence of **both** names.
- `didClear()` returns true for an attempt as well as a confirmation, because anything asking "is
  this builder's context safe?" must read the ambiguous case as unsafe. `didClearConfirmed()` is
  the strict variant, for the places that genuinely mean confirmed.
- The failure message no longer says "your context is intact" — it says the clear **may** have
  landed. Claiming safety there would be a guess presented as a fact, and the reader would act on
  it.

Reversible steps stay logged after success, where a failure is genuinely a non-event. The
asymmetry is now stated in the header instead of contradicted by it.

**Scope note**: `runReset` (`index.ts:540`) has the same log-after-clear pattern. I did **not**
change it — this phase does not own the driven path, and I have already widened scope once this
project. It goes to the review artifact as a follow-up.

## Codex 2 — challenge-deletion failure was swallowed, leaving a replayable challenge *(accepted)*

Correct and precise. I deleted the challenge after the clear and ignored failures with a comment
claiming it was harmless. It is not: if the delete fails, the challenge **and** the already-verified
state file both survive, so a second `execute` passes every gate and clears the builder **again**,
scheduling a second re-entry into a context that just lost the first one.

**Changed**, and I moved the guarantee earlier rather than just making the delete fatal. Deleting
after the clear cannot fail safe — the destructive act has already happened, so failing the run
undoes nothing. Instead:

1. **Mark the challenge consumed BEFORE the clear.** A write, performed while aborting is still
   free. If it fails, the run aborts with nothing destroyed.
2. **The gate refuses any challenge carrying `consumedAt`.** So the mark alone makes it unusable.
3. **The post-clear delete becomes tidiness**, and can fail without failing a completed refresh.

That inverts the failure mode: previously a failed delete meant "replayable"; now it means "already
neutralised, just untidy". Covered by a test using the `failRemoves` fake Codex pointed at, which
asserts the second execute is refused with `already consumed`.

## Codex 3 — the sandbox blocked Codex's own vitest run *(no action)*

Environment-only: `.vite-temp` could not be created under the review sandbox. The suite runs
here (51 tests in these two files, full suite green), and Codex confirmed typechecking passed, so
its code reading stands. Noted so a later reader does not mistake it for a skipped verification.

---

## Claude — APPROVE, five comments, all taken

### 1. The challenge was neither age-bounded nor boundary-matched *(closed here, not deferred)*

The best comment of the round, because it identifies a gap in a guarantee the module's own header
asserts. Claude's path: `begin` at boundary A → execute aborts (dirty worktree, Tower down) → the
builder commits and works on → reaches boundary B → runs execute **without** a fresh `begin`. The
lingering challenge and the stale `.builder-state.md` both pass, and the builder clears on
superseded state.

Claude suggested closing it in Phase 4, where the CLI knows the boundary. I closed it **here**,
because the invariant belongs to the module that claims it — a guard that lives one layer up can be
bypassed by any other caller, and the header would stay wrong in the meantime.

Both sides of the hole are now shut:

- `expectedBoundary` (optional) is compared against `challenge.boundary`; Phase 4 will pass it.
- `challengeMaxAgeMs` rejects a challenge older than an hour — far longer than the seconds a real
  begin→execute pair takes, so it never interferes, and short enough that a forgotten challenge
  cannot be replayed much later.

### 2. Dry run modelled as `outcome: 'aborted'` *(accepted)*

Right, and it was a wart with real downstream cost: the report printed "ABORTED" for a *successful*
rehearsal, and Phase 4's exit-code logic would have needed to special-case `failure === undefined`
— a contract nobody would infer from the type. There is now a distinct `'dry-run'` outcome, and the
report says "this refresh WOULD proceed."

### 3. Spec tests 21 and 22 collapse into one scenario *(acknowledged; carried to Phase 4)*

Accurate — "Tower unreachable" and "scheduling rejected" are the same fake, because
`scheduleReentry` is the only Tower touch before the clear. That is a property of the design rather
than a gap in the tests. Claude's actionable half is the one that matters and is now recorded for
Phase 4: **the real-port binding must not introduce a Tower call that can fail *after* the clear.**

### 4. `SelfRefreshFsPort.exists()` declared but unused *(dropped)*

Removed from the port. The fake keeps its own `exists()` for test convenience; the interface should
describe what the orchestrator actually needs.

### 5. The min-bytes decision lived only in the thread and plan *(moved)*

Fair — `constants.ts` is where a future reader looks, and its `DEFAULT_MIN_BYTES` doc still carried
only the 1273 rationale. The Spec 1470 retention decision now sits there: the calibration mismatch,
why the floor is kept anyway, and the pointer to Phase 8's measurement.

---

## Net

2 defects fixed in the destructive path (log-before-act; challenge burned before the clear rather
than deleted after), 5 comments taken including one hole closed a phase earlier than suggested,
1 environment note, 1 follow-up recorded for the review artifact. Tests grew 42 → 51.

The lesson from Codex 1 is the one worth keeping. I had built an elaborate non-vacuity discipline —
three witnesses per assertion, step-log checks on every abort path — and it was resting on a log
that could not record the one event it existed to catch. Rigour applied to the wrong layer looks
exactly like rigour.
