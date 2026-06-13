# Phase 3 (overlay) — Rebuttal to implement consult iteration 3

**Verdicts:** Codex REQUEST_CHANGES (MEDIUM); Claude APPROVE; Gemini COMMENT. Codex's single item
was **accepted and fixed** (commit `71a2cf7b`).

## Codex — REQUEST_CHANGES (addressed)

- **Out-of-range markers were warned on every `list()` reload, but deferred-#4's AC says
  "dropped … and warned once."** A noisy `FileAdapter.watch` would re-warn for the same stale
  marker each refresh. **Fixed:** added a `warnedRef` Set that dedups the `console.warn` per unique
  stale marker (`line|author|text`), so each stale marker warns exactly once across reloads.
  Tightened the test to assert `console.warn` is called exactly once even after a `watch` re-list of
  the same stale marker. 28/28 green.

## Claude — APPROVE; Gemini — COMMENT. No further changes required.

Net: Codex iter-3 item resolved in `71a2cf7b`; no scope creep. (This is the 3rd Codex iteration on
Phase 3; each item — watch-guard, async race, warn-once — was a legitimate but progressively
smaller robustness/AC-compliance refinement, all fixed; Claude has APPROVED since iter-2.)
