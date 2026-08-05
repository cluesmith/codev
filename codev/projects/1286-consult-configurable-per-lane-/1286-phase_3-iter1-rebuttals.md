# phase_3 iteration 1 — rebuttals

**Verdicts**: codex REQUEST_CHANGES (HIGH) · claude APPROVE (HIGH, three non-blocking notes)

**All four findings accepted and fixed** (commit `d266e652`). No disagreement on any point.

Both lanes independently found the same ordering defect, which is worth noting: it was not a
stylistic difference of opinion but a genuine hole two reviewers reached from different directions.

---

## Finding 1 — non-response marker checked *after* the hard-fail branch (codex + claude; ACCEPTED)

> An agy timeout/non-response that exits non-zero is misclassified as a configuration failure,
> contradicting the requirement that environment timeouts remain non-blocking even when configured.

**Correct, and it breaks the invariant I wrote myself.** My comment claimed "auth, timeout,
non-response and empty output stay skips even when configured" while the code checked `code !== 0`
before ever looking at `AGY_NONRESPONSE_MARKER`. agy can emit that marker *and* exit non-zero, so a
plain timeout would have hard-failed a configured lane — wedging exactly the degraded lane
(#1032/#1033) whose non-blocking property this phase was supposed to preserve. A comment asserting
an invariant is not the same as code enforcing it.

**Fixed**: the marker is classified before the hard-fail branch.

### My first fix was wrong, and my own new test caught it

Fixing this, I initially wrote `environmentCause = raw.length === 0 || raw.includes(MARKER)` —
treating **empty stdout** as an environment cause too. That is wrong in a way that quietly disables
the whole feature: a rejected model id writes its error to **stderr** and exits non-zero with *empty
stdout*. That is the rejection signature. Classifying it as an environment cause made the hard
failure unreachable for the precise case it exists to catch.

The stale-review test I was adding for Finding 2 failed immediately, which is what exposed it. The
final rule is deliberately narrow: **only the non-response marker** overrides the hard failure.
Empty stdout still means "no review" on the zero-exit path, unchanged.

Mutation-verified in both directions: removing the marker guard fails
`a non-response that also exits non-zero stays a skip`; widening the hard-fail to any non-zero exit
fails the unconfigured-lane test.

---

## Finding 2 — hard failure leaves a stale review file (codex; ACCEPTED)

> A stale review from an earlier run of the same iteration can remain available for porch to accept,
> violating "no review file, porch does not advance". The test only uses a fresh path and misses
> this case.

**Correct, including the critique of my test.** My test asserted the *fresh-path* case, which proves
only that this run wrote nothing — not that nothing exists. Porch keys off the file's presence and
consult writes to a deterministic per-iteration path, so a review from an earlier run of the same
iteration would be accepted as though the failed run had succeeded. The acceptance criterion says
"no review file", and my implementation delivered "we didn't write one", which is a weaker property
that looks identical in a green test.

**Fixed**: `discardStaleOutput()` removes an existing file before rejecting, with a test that seeds a
stale `VERDICT: APPROVE` review first — the shape codex specified.

**Applied to all three lanes, not just agy.** The codex and claude runners throw on provider
rejection with the same exposure. Fixing only the lane that was reviewed would leave the identical
defect in two others; this follows the phase_1 precedent of fixing the family rather than the line.

---

## Finding 3 — `code === null` hard-fails a configured lane (claude; ACCEPTED)

> `code === null` (signal-killed agy) now hard-fails when a model is configured; consider
> `code !== null && code !== 0`.

**Correct.** `code !== 0` is also true for `null`. A signal kill (OOM, external kill) is an
environment cause, so it must skip. Fixed exactly as suggested, with a `SIGKILL` fixture mode and a
test.

---

## Finding 4 — dead fixture mode (claude; ACCEPTED)

> `FAKE_AGY_MODE=unauth` is defined in the fixture but unused — no test covers *configured lane +
> unauthenticated → still skips*, the direction that would wedge a phase if inverted.

**Correct, and the sharpest of the four in proportion to its size.** I wrote an `unauth` mode into
the fixture and never used it: dead fixture code that reads like coverage to anyone scanning the
file, on the single direction whose inversion would wedge every phase in an unauthenticated
workspace. Now covered by
`an unauthenticated agy stays a skip even when a model is configured`.

---

## Note on issue #1323 (test isolation / real-agy spawns)

The architect filed #1323 after a burst of OAuth browser windows during suite runs. Verified rather
than assumed for this branch: `agy-lane-model.test.ts` pins `CODEV_AGY_BIN` to a generated fake
script, pins `CODEV_AGY_AUTH_CACHE_DIR` to a per-test temp dir, and passes no `metricsCtx` — so it
cannot spawn real agy, cannot touch the shared auth cache, and writes no metrics DB. The real-agy
verification in this phase was run manually outside any suite, which is the split #1323 asks for.

---

## Verification after the fixes

- `tsc --noEmit`: clean
- phase_3 file: 14 → **18 tests**
- Unit suite: **3923 passed**, 48 skipped, **0 failed**
- CLI integration: **93 passed**, 0 failed
- Manual (real agy, outside the suites): configured + bogus id → exit 1, no review file;
  unconfigured → exit 0, COMMENT skip written
