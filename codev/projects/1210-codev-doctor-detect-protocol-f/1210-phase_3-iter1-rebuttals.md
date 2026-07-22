# Phase 3 (tests) iteration 1 — Rebuttals

**Verdicts**: gemini APPROVE · claude COMMENT · codex REQUEST_CHANGES

Codex (blocking) and Claude (comment) independently flagged the same primary gap; both accepted and
fixed.

## Codex Issue 1 (blocking) / Claude Issue 1: missing e2e for the staleness-only "behind" branch

> The e2e file forces npm offline in every test, making `behind` unreachable and leaving the main
> Phase 2 integration branch ("no overrides + skeleton behind → section shown for staleness alone")
> unverified. (Claude: "explicitly listed as a Phase 3 e2e deliverable … add a `fetchLatest`
> injection seam to `doctor.ts` to enable the e2e case.")

**Accepted — fixed by adding the seam Claude suggested.** `doctor.ts` now reads an optional
`CODEV_DOCTOR_FAKE_LATEST` env var and, when set, injects it as the npm-latest value into the
already-injectable `checkSkeletonStaleness(fetchLatest?)`. Unset in real use → the real `npm view`
lookup runs unchanged (the seam is inert for actual users). New e2e test:

> "shows the Framework Drift section for staleness alone when the skeleton is behind (no shadows)" —
> no local overrides, `CODEV_DOCTOR_FAKE_LATEST=999.0.0`, asserts the section opens with the
> **staleness-specific subtitle** (`installed skeleton is behind npm latest`), a `latest 999.0.0 —
> behind` warning, and **no** adjudication line (no shadows in this path).

This exercises exactly the Phase 2 branch (staleness-only header subtitle + behind warning) that was
previously unreachable end-to-end.

## Codex Issue 2 (blocking): identical-shadow test doesn't assert info-only / not-a-warning

> Checks the identical message appears, but does not assert this path is info-only / not a warning.

**Accepted — fixed.** The identical-shadow e2e test now also asserts the output does **not** contain
`customized or stale? — adjudicate` (the warning/`differs` marker). With only an identical copy in
the fixture there is no `differs` finding, so the absence of the adjudicate line confirms the
identical path is informational, not a warning.

## Claude Issue 2 (comment): EOL unit test could vacuously pass

> The EOL test silently passes without asserting when the picked file has no newlines; add a guard.

**Accepted — fixed.** The EOL unit test now asserts the precondition explicitly
(`expect(skeletonBytes(rel).includes(0x0a)).toBe(true)`) before the CRLF transform, then asserts
`differs` unconditionally — so it can no longer pass vacuously.

## Result
Unit: 19/19. e2e: now 4 tests (added the staleness-only case). `tsc` clean, `npm run build` green.
gemini APPROVE with no issues.
