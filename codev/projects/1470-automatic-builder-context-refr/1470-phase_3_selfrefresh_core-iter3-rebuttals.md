# Rebuttal — Spec 1470, Phase 3 (self-refresh core) iteration 3

**Verdicts**: Codex REQUEST_CHANGES (2 issues + 1 environment note) · Claude APPROVE (0 blocking,
4 comments).

**All accepted.** Both reviewers independently landed on the same structural gap — safety
parameters validated in one place and not the others — and Codex found that iteration 2's fix for
the nonce bypass had closed the hole only partway.

---

## Codex 1 — a short nonce still bypasses the freshness gate *(accepted; my fix was incomplete)*

Iteration 2 replaced a truthiness check with "must be a non-empty string". Codex points out that
this is not enough, and the reasoning is the same one I wrote into the code myself:

> freshness is proved by `content.includes(nonce)`

so `"nonce": "a"` is found in nearly every state file ever written. Non-emptiness is not the
property that matters — **collision resistance** is. I fixed the type confusion and left the
adjacent hole open, because I had been thinking about `[]` coercing to `''` rather than about what
makes a nonce *work*.

**Changed**: the nonce must match `^[0-9a-f]{12,}$`.

- 12 is not arbitrary: `generateNonce()` is `randomBytes(6).toString('hex')`, which is exactly 12
  lowercase hex characters.
- It is a **floor, not an exact length**, so a future `generateNonce` with more entropy stays
  valid. A validator pinned to today's width would reject tomorrow's stronger nonce — the kind of
  test that fails on an improvement.

Tests cover a one-character nonce (asserting first that `'any ordinary save file'.includes('a')` is
true, so the test states *why* it matters), non-hex, uppercase, and off-by-one-short, plus a
longer-nonce case pinning the floor semantics.

**A second bug surfaced from this**: two older tests used placeholder nonces like
`'this-run-nonce'`, which the stricter validator now rejects — including the *replay* test, whose
whole point is that a well-formed but **different** nonce is refused. It was passing for the new
reason (malformed) rather than the intended one (mismatch), which would have quietly hollowed out
the replay guarantee. Both now use valid 12-char hex, so the rejection comes from the mismatch and
the test means what its name says.

## Codex 2 / Claude 3 — safety parameters unvalidated in the core *(accepted; both reviewers, same gap)*

Codex names `minBytes`, `reentryDelaySeconds` and `challengeMaxAgeMs`; Claude independently flags
the asymmetry that `stabilityWindowMs` was validated while `minBytes` was not. They are describing
one defect from two directions, and the asymmetry is mine: I added the stability check in response
to iteration 2 and did not generalise it.

The consequences are each a silently disabled protection:

| Value | Effect |
|---|---|
| `minBytes: 0` | an empty save passes the substance gate |
| `challengeMaxAgeMs: NaN` | every expiry comparison is false, so nothing ever expires |
| `stabilityWindowMs: 0` | two observations collapse into one; a mid-write file reads as stable |
| `reentryDelaySeconds: -1` | an invalid delay still reaches scheduling, then the clear |

**Changed**: a single Gate 0 validates all four as finite and positive before anything else runs,
with a comment explaining the shared property — *these tune gates, so a bad value disables a
protection rather than failing loudly*. The test matrix is 4 parameters × 4 bad values.

On Codex's "rather than relying solely on Phase 4 CLI validation": agreed, and that is the right
principle. This function is the thing that clears a builder; it should not depend on every future
caller having remembered to check. Phase 4 will *also* validate at the CLI boundary — the two are
complementary, not redundant, because they catch different mistakes (a bad flag typed by a human
versus a bad argument passed by code).

## Codex 3 — vitest could not start in the review sandbox *(no action)*

Same environment limitation as iteration 1: Vite could not create `node_modules/.vite-temp` under
a read-only sandbox. Codex confirmed typechecking passed, and the suite runs here — 84 tests in
these two files, full suite green. Noted so it is not mistaken for skipped verification.

---

## Claude — APPROVE, four comments

### 1. `DEFAULT_REENTRY_DELAY_SECONDS` is not a "post-clear" hold *(accepted; matters for Phase 8)*

The doc called it the hold *after* the clear. It is not: the re-entry is scheduled **before** the
clear, precisely because the destructive step goes last. So the window this value must cover is the
remainder of the current turn **plus** the clear executing at turn end.

This is worth more than a doc fix — Claude is right that it changes what Phase 8 measures. Framed
as time-after-the-clear, the measurement would target the wrong interval and pick a value too
short. The corrected comment says so explicitly, so the Phase 8 measurement inherits the right
definition rather than re-deriving it.

### 2. `expectedBoundary` is optional, so the scope guard is opt-in *(accepted; Phase 4 pins it)*

True by construction — the parameter is optional so the core does not force a boundary on callers
that have none. But an opt-in guard protects nobody by default. Recorded for Phase 4: **the CLI
must always pass it**, and that will be asserted rather than assumed.

### 3. `minBytes` not range-validated while `stabilityWindowMs` was *(fixed above)*

### 4. Re-orientation write failure reused `assembly-failed` *(accepted)*

A distinct `reorient-write-failed` now separates "could not build the frame" (a missing context
field) from "could not persist it" (the filesystem). Different causes, different fixes, and a
caller that cannot tell them apart cannot advise the builder what to do.

### 5. Spec test 30 superset *(already recorded)*

Claude confirms iteration 2's judgement that the superset is not a miss. It stays in the review
artifact as a documented divergence.

---

## Net

1 incomplete fix completed (nonce format), 1 structural gap closed (all four safety parameters),
2 API/doc corrections, 1 latent test defect found in passing. Tests 59 → 84 in this file; full
suite green.

The thing I keep relearning: **I fix the instance and miss the class.** Iteration 2's bypass was
"an unvalidated value from disk"; I validated the *type* and left the *length*. The stability
window was validated; the other three parameters guarding the same clear were not. Both times the
reviewer's finding was one generalisation away from the fix I had just written. Before calling the
next gate done, the question is not "is this input checked?" but "what else reaches this decision
by the same route?"
