# PIR #1473 — response to review iteration 1

Verdicts on file: gemini `APPROVE`, codex `REQUEST_CHANGES`, claude — no review produced by this
lane (see `1473-review-iter1-claude.txt`, a failure record, not a review).

Everything below was verified against the branch before acting. Every codex finding was
legitimate; none is rebutted as a false positive. Fixes landed in `d807c1802` and `57c3b3607`.

---

## codex 1 — `/api/send` and `commands/send.ts` had plumbing and no test

**Accurate. Fixed.** The finding's sharpest phrasing is codex's own: *removing those plumbing
changes would leave the suite green.* `unverifiedCause` was tested at the `DeliveryOutcome`
level — the layer I wrote — and at neither operator-facing boundary.

Added to `tower-routes.test.ts`: the `no-echo` cause, the `input-raced` cause (a session whose
`write` advances `inputSeq`, so the header lands and `verified` is true — the case that motivated
the field), and the additive-absence case proving a clean delivery grows no new key.

Added to `send.test.ts`: both wordings, the older-Tower `verified: false` fallback, and an
explicit assertion that operator text never leaks the verifier's internals (`needle`, `0 chars`)
— which the plan had called out by name and nothing had been pinning.

## codex 2 — the raw terminal-write route was not tested to advance/filter the input signal

**Accurate. Fixed.** `POST /api/terminals/:id/write` counts as input *only* because it passes no
`origin` and the default is `'external'`. That is an invisible coupling one word wide: changing
the call to `write(data, 'delivery')` would reopen the race for every non-WebSocket client while
every gate test kept passing, because gate tests supply their own sessions.

Now tested against a **real** `PtySession` on a shellper double, not a fake — a double could only
assert what the double was told to do. Three cases: a keystroke advances the signal; a DA reply
does not, but still reaches the PTY verbatim; a mixed chunk keeps only the human residue.

The general form is now `arch.md` invariant 11: every write into a `PtySession` counts as human
input unless it explicitly opts out, and `'delivery'` is correct only for bytes the gate itself
authorised.

## codex 3 — the starvation threshold was sized against one cadence, documented against another

**Accurate, and worse than stated. Fixed.** `60 × (300 + 25)` ≈ 19.5s, not the ~90s claimed.

The arithmetic is the weaker half. The decisive evidence is that **the manual verification of
this feature would have tripped it**: step 4a's ten repetitions each drove 15–20s of unbroken
cursor-key input — precisely the window the old rule called machine-generated. A constant written
to avoid libelling an ordinary typist as a machine would have fired on the human confirming that
the feature respects ordinary typists.

A count was also the wrong unit independent of its value: the backstop, quiescence and submit
triggers all drive passes, so the pass rate was never stable and the threshold would re-scale
silently on any cadence change. Replaced with wall-clock `CONSECUTIVE_INPUT_HOLD_WARN_MS =
90_000` measured from the start of the unbroken run. Three tests: 200 passes across 20s must not
warn (fails against the old code), 20 passes across 95s warns exactly once, and two 60s runs
separated by a delivery do not accumulate.

## codex 4 — the review's "Files Changed" did not match the branch

**Accurate. Fixed.** The numbers were computed before the review and governance commits existed,
so the document understated the scope it was describing. The section is now generated from the
actual merge-base diff (41 files, +5834 / −88) and states that it is measured after the final
review commit and therefore includes the review file itself — which is the honest framing for a
self-referential count, rather than a number that silently drifts on every subsequent commit.

---

## Also fixed this round, from the architect's integration CMAP

Four blocking findings from that lane (claude's review of the same branch, which this lane could
not produce): the missing `recent-input` case in `describeDetail()`; the stale three-value detail
vocabulary in `packages/types`; the threshold above; and the absence of a sensitive-data warning
on `AF_LOG_INPUT_SIGNAL`, which logs keystrokes verbatim.

## Not changed, with reasons

- **`retryAfterMs` asymmetry** (`mailbox-delivery.ts:825`, `:897`). Those branches fire when the
  screen moved *during* the classify, so input may still be arriving and no settle boundary
  exists to compute a deadline from. A value there would arm a timer against a number describing
  nothing; the next pass re-samples and arms the retry properly.
- **The xterm pin resolves from `packages/codev`, not `apps/web`** (the emitting client, which
  declares its own copy). A real gap, and a one-line change with a cross-package ownership
  question behind it. Deliberately not slipped into a REQUEST_CHANGES turn — that is how a small
  correct change ships unreviewed. Carried as a follow-up.
- **`isUserIdle()` has no production consumers left.** MAINTAIN candidate, not this PR's business.
