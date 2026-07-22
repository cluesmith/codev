# Plan iteration 1 — Rebuttals

**Verdicts**: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES

Only Codex requested changes. Both points are valid and I accepted them — the plan had a genuine
internal contradiction. Summary of resolution below.

---

## Codex — Issue 1 (blocking): plan conflicts with itself on *when the section appears*

> The Executive Summary says it adopts no-op gating ("report nothing when the project ships no
> framework overrides"), but Phase 2 says the staleness line is **always shown when in a project**.
> Those cannot both be true, and the latter breaks the spec's "true no-op" requirement.

**Accepted — this was a real contradiction. Fixed.**

I introduced a single, unambiguous rule in both the spec and the plan (spec *Desired State* +
Success Criteria; plan *Key Design Decisions* + Phase 2 + Phase 3): the **Framework Drift section is
quiet by default**. doctor computes shadows + staleness, then:

- **No shadows AND not-behind** (up-to-date, *or* offline/uncheckable) → **prints nothing at all**
  (no header). This is the spec's true no-op.
- **Otherwise** the section is shown. Staleness is a **warning only when `behind`**; the up-to-date
  and "could not check (offline?)" lines are informational and appear only because shadows already
  forced the section open. Staleness is therefore **never** printed unconditionally-per-run.

Rationale for keeping the `behind`-forces-section case (rather than making staleness purely
subordinate to shadows): a stale installed skeleton with no local overrides is exactly the issue's
**sibling failure mode** ("before the upgrade, the installed skeleton itself was a version behind, so
even non-shadowed resolution served pre-fix templates. Equally silent."). Suppressing it would
re-hide the very bug #1210 asks doctor to surface. I updated the spec's no-op success criterion to
scope it precisely — "no overrides **and** up-to-date/unreachable" → no-op; "no overrides **but**
behind" → staleness warning surfaces (explicitly not a no-op).

## Codex — Issue 2 (blocking): testing under-specifies no-overrides + staleness-behind/offline

> The plan should explicitly say whether staleness is suppressed when there are no shadows, or
> whether the spec is being intentionally reinterpreted.

**Accepted. Fixed.** Phase 3 now names three explicit no-overrides cases and asserts each:
1. no overrides + skeleton up-to-date (stub `fetchLatest` = installed) → **no "Framework Drift"
   header** in output (true no-op);
2. no overrides + skeleton behind (stub `fetchLatest` > installed) → **staleness warning present**
   (section shown for staleness alone);
3. offline → staleness silent, no hang, bounded by the ~2.5s timeout.

Phase 2 acceptance criteria were amended to match. The `fetchLatest` seam (injectable in
`checkSkeletonStaleness`) makes these deterministic without real network.

---

## Codex — non-blocking observations (acknowledged)

- **"Phase 1 isn't truly independently testable if all tests are in Phase 3."** Fair; the phrasing was
  slightly overstated. Phase 1 delivers pure functions with an injectable `workspaceRoot`/`fetchLatest`
  so it *is* exercisable in isolation; tests are consolidated in Phase 3 so lib + wiring commit
  cleanly. Left the phase split as-is (deliberate), but the plan notes the seam.
- **File choices / precedent alignment / `resources/` exclusion** — confirmed correct; no change.

## gemini / claude

Both APPROVE, KEY_ISSUES: none. Gemini's spec-phase notes (raw-byte compare for EOL; ~2–3s timeout)
were already incorporated into the plan's Key Design Decisions. No further action.
