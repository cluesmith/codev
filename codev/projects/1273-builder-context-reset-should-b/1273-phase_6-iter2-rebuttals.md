# Rebuttal — Phase 6 (Reset orchestrator + CLI wiring), iteration 2

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

**Accepted in full.** This is the third time in this project that two APPROVEs would have shipped a real
defect, and the second time the defect was safety-critical.

---

## Codex — REQUEST_CHANGES

### Issue 1: "The CLI accepts numeric flag values that bypass or break core safety gates"

**Accepted.** Verified each claim against the code before fixing:

- **`--quiet-window -1` → R4 disabled.** The quiescence check is
  `clock.now() - observation.lastDataAt >= quietWindowMs`. With a negative window that comparison is true
  on the first poll regardless of what the terminal is doing, so a builder mid-turn passes the gate
  immediately and gets cleared. The whole point of phase 2's `lastDataAt` work, defeated by a flag.
- **`--min-bytes -1` → R2's substance floor disabled.** `bytes < minBytes` is never true, so a
  three-line stub — or an empty file carrying only the nonce — is accepted as a working-state save.
- **`--timeout nope` → `NaN`.** Worse than a wrong timeout: every comparison against `NaN` is false, so
  `clock.now() >= deadline` never fires and the receipt wait **never terminates**. The command hangs
  rather than aborting.

The common shape is what makes this worse than an input-validation nit: none of these produce an error or
a degraded run. Each one switches off a specific protection **while the run still reports success**. A
reset that clears a busy builder and prints a clean step log is precisely the outcome the step-log design
exists to make impossible — and it was reachable by typing a number.

**Changed, in two places deliberately.**

1. **CLI boundary** (`cli.ts`): `--timeout`, `--min-bytes`, `--quiet-window` each go through a
   positive-integer check that errors and exits 1. Verified against the real binary, not just the build:
   `--quiet-window=-1`, `--timeout=nope` and `--min-bytes=0` all print a named error and exit 1.
2. **The orchestrator itself** (`runReset`): every timing/threshold parameter is validated in a new step 0,
   before preflight. This is not redundant. The orchestrator is the component that *owns* R2 and R4, and
   it should not delegate its own preconditions to whoever calls it — a programmatic caller must not be
   able to disable an invariant by passing a number. The guard uses `Number.isFinite`, not a bare `> 0`:
   `NaN > 0` is false but so is `NaN <= 0`, so a NaN slips past any single comparison written the obvious
   way. Infinity is rejected too, since an infinite deadline is a hang.

### Issue 2: "The command-surface tests do not cover invalid numeric flag input"

**Accepted.** Same structural gap as iteration 1's — the tests covered the values a well-behaved caller
passes, not the ones that break the gates.

**Changed** — 7 orchestrator tests and 2 wrapper tests:

- one per gate-disabling value (negative and zero quiet window, negative `minBytes`, `NaN` and `Infinity`
  timeouts, zero quiesce timeout), each asserting the abort happens **before** any message, raw write or
  file write — the same "nothing was touched" assertion the R1 tests use
- one test that *demonstrates* the hazard rather than only the guard: a permanently-busy terminal with
  `quietWindowMs: -1`, which without the guard would sail through quiescence
- wrapper: a rejected value surfaces as a failure rather than being swallowed into a success report, and
  an unset flag is forwarded as `undefined` so the orchestrator's own default applies (passing `0` for an
  absent flag would disable the very gate the default enforces)

---

## Gemini — APPROVE · Claude — APPROVE

No issues raised.

Recorded plainly, because the pattern is now the most useful thing this project has produced: **three
times in two phases, the majority approved code with a real defect in it.** Iteration 5 (`input_description`
covering half of spawn's entry points), iteration 1 of this phase (addressing parity + a blank `--dry-run`
output), and now flags that silently disable R2 and R4. Each time the single dissenter was right on the
facts.

---

## Net effect

Safety-critical flags can no longer be used to switch off the invariants they tune, at either the CLI or
the library boundary. Tests 3939 → 3948. Build clean; validation verified against the real `afx` binary.
