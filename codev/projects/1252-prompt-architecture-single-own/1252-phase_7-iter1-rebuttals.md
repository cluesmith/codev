# Phase 7 — rebuttal, iteration 1

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 | 3 | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-1 — "core deliverable incomplete: classes still manual/duplicated"

Accepted in substance — rather than litigating that S1 is a SHOULD, the
completion pass finished the extractable remainder:

- **5 more partials**: `flaky-test-handling` (uniform across
  spir/aspir/bugfix/experiment; the scar canonical stays authored inline in
  every file — no scar dedup), `porch-workflow-fidelity` (×3),
  `no-skip-3way-review` (single line, **nested** inside the strict partial and
  included directly by bugfix/experiment), `baked-decisions` (spir/aspir
  uniform), `pr-strategy` (spir/aspir).
- **All 10 classes now `enforcement: automated`.** Remaining non-owner copies
  are *declared* `retained_restatements`, each justified in the YAML — and
  they are genuine protocol variants, not deferred work: AIR documents flaky
  skips in the PR body because it has no review file; air's baked clause is
  Spec 746's own per-protocol wording; pp-implement's flaky list is phrased
  for the phase context; spir-protocol-doc restates rules as reference prose.
- **Test suites moved with the dedups in the same commit**: bugfix-744 now
  greps the partial; Spec 746's suite operates on SERVED text
  (`readRepoFile` include-expands, mirroring production) with baselines
  re-derived from expanded content.

## CX-2 — companion drifted from the YAML

Accepted. The class table is now **generated from the YAML** (owner +
enforcement + refs/retained columns), and the parity test grew teeth: each
class's companion row must name its current owner and enforcement, so prose
can no longer describe a stale state while the marker stays numerically green.

## CX-3 — after-artifact lacked the delta

Accepted. `1252-word-after-phase7.md` now carries the required per-component
before/after/delta table and the achieved percentage: **21,856 → 20,324 =
−7.0%** (served words; the proxy expands includes recursively so
dedup-by-partial cannot claim phantom savings), with the structural
decomposition of the shortfall against the 20% target.

Full suite: 3,742 passed, 0 failures.
