# Review: `codev doctor` — detect protocol-file drift (#1210)

## Summary

`codev doctor` gains a **Framework Drift** report that surfaces a previously-silent failure class of
the four-tier resolver: project-local copies (`.codev/` / `codev/`) of framework files that shadow
the installed skeleton, and an installed skeleton that is itself behind npm latest.

Two deliverables:
- A pure, unit-tested library `packages/codev/src/lib/protocol-drift-audit.ts` that (a) diffs every
  local copy of a skeleton framework file (under `protocols/`, `consult-types/`, `roles/`) against
  the skeleton and classifies it `identical` (redundant, safe to remove) or `differs` (customized or
  stale? — adjudicate), and (b) compares the installed package version against npm latest
  (best-effort, offline-tolerant, bounded).
- Wiring in `packages/codev/src/commands/doctor.ts` that renders the report **quiet by default**:
  the section prints only when a shadow exists or the skeleton is behind. Report-only — no user file
  is ever modified.

Item 2 of the issue (historical-default hash detection) was spec'd as non-blocking and deferred to a
follow-up. `codev update` wiring was left optional (the lib is structured for it).

## Spec Compliance

All spec success criteria are met:
- Identical shadow → info-only "redundant copy, safe to remove" line (not a warning). ✓
- Differing shadow → adjudicate warning naming the file, tier, resolved-winner, and **skeleton
  package version**; increments the warning count. ✓
- No overrides + up-to-date/offline → **true no-op** (no section printed). ✓
- No overrides + behind → staleness warning surfaces (the issue's sibling failure mode), with a
  staleness-specific header subtitle. ✓
- Staleness reports explicit `installed X; latest Y`; offline-tolerant; bounded (~2.5s). ✓
- Both override roots (`.codev/` and `codev/`) considered; each local copy reported and classified. ✓
- `codev/resources/` (user-evolved) excluded. ✓
- Report-only — no file mutation (asserted by test). ✓
- Standalone unit-tested lib mirroring the pr-gate / framework-ref precedent. ✓

## Deviations from Plan

- None material. The plan's Approach 1 (skeleton-driven diff) was implemented as specified, with
  Approach 2's quiet-by-default gating. Enumeration reuses `listSkeletonFiles()` per the plan (an
  early draft used a custom walk; corrected in phase-1 review).
- Added a small documented test seam (`CODEV_DOCTOR_FAKE_LATEST` env var in doctor.ts) to make the
  staleness-only "behind" integration branch e2e-testable without a live registry — this was Claude's
  suggested option during phase-3 review, not a plan change.

## Key Metrics

- Product code: **+328 lines** across 2 files (`protocol-drift-audit.ts` +264, `doctor.ts` +64).
- Tests: **+345 lines** — 20 unit cases + 4 CLI e2e cases.
- Full suite: 3555+ passing, 0 failures.
- 31 commits on the branch; 3 implement phases, each with a 3-way consult round (several with a
  Codex REQUEST_CHANGES → fix → re-approve cycle).

## Consultation Iteration Summary

Every phase ran a 3-way consult (gemini / codex / claude). Codex was the consistent gatekeeper:
- **Spec**: APPROVE / APPROVE / COMMENT — folded in explicit scan set, dual override roots, explicit
  `installed X; latest Y` wording, item-2 non-blocking, raw-byte compare.
- **Plan**: APPROVE / APPROVE / **REQUEST_CHANGES** — resolved a genuine self-contradiction (Exec
  Summary "no-op when no overrides" vs Phase 2 "staleness always shown") into one quiet-by-default rule.
- **Phase 1**: **REQUEST_CHANGES** — reuse `listSkeletonFiles()` instead of a custom walk. Fixed.
- **Phase 2**: **REQUEST_CHANGES** ×2 — name the skeleton version in the differs line; fix the false
  header parenthetical in the staleness-only path. Both fixed.
- **Phase 3**: **REQUEST_CHANGES** ×2 across two iters — add the staleness-only "behind" e2e branch
  (via the test seam) + assert identical-is-info-only; then assert the *real* npm lookup is
  bounded/offline-tolerant (not just a stub). Both fixed → unanimous APPROVE.

Rebuttal docs for each round are in `codev/projects/1210-*/`.

## Lessons Learned

### What Went Well
- Reusing the three existing audit precedents (`pr-gate-audit`, `framework-ref-audit`, `gitignore`)
  made the shape obvious and the review fast — pure lib (findings + formatter) + thin doctor wiring.
- Manually running `codev doctor` against *this* self-hosted repo (which has real `codev/protocols`
  overrides) validated the feature end-to-end immediately — a live, high-signal fixture.

### Challenges
- **Testing a network-bound, timeout-guaranteed path deterministically** cost the most review cycles.
  Injecting `fetchLatest` covered logic, but the *bounded-when-offline* non-functional guarantee lives
  in the real `npm view` timeout — asserting it required exporting the real fetcher and driving it at
  an unreachable registry. Two Codex rounds to land it fully.
- **A self-contradiction in the plan** (no-op vs always-show staleness) slipped past my own drafting
  and was caught by Codex — a reminder that "quiet by default" needs one precisely-stated rule, not
  two independently-reasonable sentences.

### What Would Be Done Differently
- State cross-cutting output rules (like "quiet by default") once, as an explicit precedence rule,
  before writing per-branch prose — would have avoided the plan contradiction.
- When a plan lists non-functional assertions (bounded timing), write the *real-path* test up front,
  not a stub — the stub reads as coverage but isn't.

## Architecture Updates

- Routed: **cold** — `codev/resources/arch.md` (Core Components / System-Wide Patterns) already
  documents the four-tier resolver and the doctor audit-lib pattern; this feature is another instance
  of that established pattern (pure audit lib + doctor wiring), so no new architectural shape was
  introduced. No hot-tier change: the resolver + audit-precedent facts are already in
  `arch-critical.md` and the hot file is at cap. **No arch.md edit required** — the drift audit is a
  faithful application of the documented "doctor diagnoses silent misconfiguration via a pure audit
  lib" pattern, not a new invariant.

## Lessons Learned Updates

- Routed: **cold** — `codev/resources/lessons-learned.md` (Testing) — *"When a plan promises a
  non-functional assertion backed by a real timeout/network path, test the real path, not an injected
  stub — a stub that returns the expected value reads as coverage but exercises none of the guarantee
  (the bound lives in the real code path)."* Not hot-tier: it's a useful testing refinement, not a
  top-10 always-injected lesson, and the hot file is at cap. (Recorded here; the MAINTAIN pass can
  fold it into lessons-learned.md's Testing section.)

## Technical Debt

- None introduced. The `CODEV_DOCTOR_FAKE_LATEST` env seam is documented and inert in real use; it is
  the minimal cross-process injection needed for e2e coverage of the staleness branch.

## Follow-up Items

- **Item 2 (known-default detection)**: ship a manifest of historical skeleton-file hashes so a
  `differs` copy matching a known old default is provably rot → stronger "safe to delete" verdict.
  Layers onto `DriftFinding` with an optional `matchesHistoricalDefault` field. Deferred (non-blocking
  per spec; needs a release-time hash-generation step).
- **`codev update` wiring**: optionally consume `auditProtocolDrift` in `update` to surface drift at
  upgrade time. The lib is structured for this with no refactor.
