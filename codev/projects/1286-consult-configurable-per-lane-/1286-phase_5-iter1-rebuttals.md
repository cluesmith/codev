# Phase 5 — Iteration 1 Rebuttals

**Verdicts**: codex `REQUEST_CHANGES` (HIGH) · claude `APPROVE` (HIGH)

Everything raised was accepted and fixed. Nothing is rebutted.

---

## codex (blocking) — the end-to-end test terminated the worker instead of asserting

> `spec-1286-lane-selection.test.ts:305` invokes `done()` on missing reviews without mocking
> `process.exit`. `done()` calls `process.exit(1)` at `porch/index.ts:472`, so `.rejects.toThrow()`
> cannot intercept it; the test worker exits.

**Accepted. Verified at the source before fixing** — `index.ts`'s `missingModels` branch prints
`VERIFICATION REQUIRED` and calls `process.exit(1)`; it does not throw. So `.rejects.toThrow()` had
nothing to catch.

The uncomfortable part is that **the test passed**. That is exactly what makes this finding valuable
rather than pedantic: a suite that reports green while one of its assertions is structurally
incapable of failing is worse than a red one, and I had used that green tick as evidence in the
phase_5 commit message. Mocked `process.exit` to throw, following `done-verification.test.ts`'s
existing convention rather than inventing a second pattern.

Then made the assertion specific — `.rejects.toThrow('process.exit(1)')` rather than a bare
`.toThrow()` — because "some error was raised" would also be satisfied by an unrelated crash during
fixture setup, which is the same class of false-green I was just bitten by.

**Mutation-verified after fixing**: disabling `done`'s missing-review refusal (`if (false && …)`)
now fails the test. It did not before.

On codex's note that it could not run the suite in its read-only environment: that is why the
mutation result is stated explicitly here rather than left as "tests pass".

---

## claude (APPROVE, two minor points — both taken)

**1. `porch/index.ts:509` hardcoded "3-way review".** Cosmetic in claude's framing, but it is output
this very phase made wrong: once config can select lanes, a workspace running a 2-lane PIR was told
to expect a 3-way review, with no way to tell whether the third lane had failed or was never asked
for. Now derives the count from the same resolver (`${laneCount}-way review`), and degrades to a
plain "Ready for review." rather than printing "0-way" when no lanes run. The two neighbouring
comments that also said "3-way" are updated, since a stale comment is how the literal survived.

**2. The "throws rather than falling back" test exercised the wrapper, not `done()`.** The sharper
of the two. The deleted `catch` is this phase's one deliberate behavior change and its only real
regression risk, and I had pinned it only at the resolver — which cannot prove the `catch` is gone
from the *call site*. Added an end-to-end case: malformed config now fails `done()` itself with the
offending key in the message.

---

## Verification

`tsc --noEmit` 0 · full build ✓ · full unit suite green · 16 tests in the phase file.
Both end-to-end assertions mutation-verified (a `done` that ignores config fails the narrowing test;
a `done` that never refuses fails the enforcement test).
