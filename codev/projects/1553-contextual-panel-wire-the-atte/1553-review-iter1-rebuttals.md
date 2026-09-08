# CMAP iteration 1 — rebuttals / dispositions (PIR #1553)

Verdicts: **Gemini APPROVE** · **Codex REQUEST_CHANGES** · **Claude REQUEST_CHANGES**. All three
verified the *implementation* clean (pure projection, injectable `now`, correct gate-vs-idle dedup,
honest `heldTotal`, token-only styles, resolver untouched). The blockers were the **review artifact**
plus two minor code nits. All fixed in the follow-up commit; per-point below.

## Codex

1. **Review file lacks `Commits`, `Test Results`, `How to Test Locally` (+ actionable UI/platform
   steps).** — **AGREED, FIXED.** The first review draft followed a generic template and omitted the
   PIR-mandated sections (`codev-skeleton/protocols/pir/prompts/review.md`). All three added, with a
   concrete reviewer walkthrough and an explicit note that blocked/held/queued state needs a live
   Tower (the human at the `pr` gate drives it).

2. **Arch/lessons routing declared but not present in the changed-file list / resource files.** —
   **AGREED, FIXED.** The updates were described but not applied. Now applied in the same commit:
   `codev/resources/arch.md` (VS Code Extension → the #1049 contextual-panel paragraph) and
   `codev/resources/lessons-learned.md` (one Architecture lesson, one UI/UX lesson). Both routed
   **COLD** (subsystem-specific; the hot files are at cap and this introduces no always-must-know
   invariant).

3. **"Missing Attention payload renders an empty-state claim instead of retaining the prior
   placeholder behavior required by the plan."** — **PARTLY AGREED, FIXED (softened, not reverted).**
   The `attention === undefined` branch is only reachable as a transient pre-first-post frame (the
   provider always attaches the payload in Attention mode), so the old per-mode placeholder no longer
   applies to Attention. But asserting "Nothing needs attention" before the roll-up arrives *is* a
   false claim, which is Codex's real point — so that branch now renders a neutral `Loading…`, not an
   emptiness claim.

## Claude

1. **Missing `## Commits` / `## Test Results` / `## How to Test Locally`** (the last is the one the
   human needs, since the builder can't reproduce the signals). — **AGREED, FIXED** (same as Codex 1);
   How to Test Locally spells out the owner-driven live-Tower walkthrough.

2. **Arch/lessons routing declared but neither file in the diff; must update routed files in the same
   commit.** — **AGREED, FIXED** (same as Codex 2). Applied in-commit.

3. **(Minor) Empty-state sub-line doesn't mention the "Waiting on input" signal.** — **AGREED, FIXED.**
   `webview/main.ts` sub-line now reads "No builders at a gate, none waiting on input, no held mail,
   no queued feedback."

4. **(Minor) `EMPTY_ATTENTION` is a shared mutable singleton returned by reference from public SDK
   surface.** — **AGREED, FIXED.** Replaced the module-level const with an `emptyAttention()` factory
   returning a fresh object each call; the null/degenerate path uses it. **Regression test added**
   (`builder-helpers.test.ts`): mutating one `deriveAttention(null)` result does not leak into the
   next, and the two results are distinct references.

5. **(Minor, non-blocking) `since()` is untested.** — **ACKNOWLEDGED, NOT CHANGED (rebuttal).** The
   webview render module (`webview/main.ts`) can't be imported under vitest — it runs
   `acquireVsCodeApi()` at top level and imports CSS, both browser-only. Restructuring the render layer
   to unit-test a 4-branch relative-age formatter isn't worth the churn here; it's covered by
   manual/visual verification at dev-approval. Noted in the review's Things-to-Look-At. (Claude flagged
   this as non-blocking.)

## Net

Two REQUEST_CHANGES, both centered on the review artifact + two small code nits — all addressed with
code + applied governance updates + a regression test. No implementation defect was found by any
reviewer. PIR is single-pass, so these fixes are not independently re-reviewed; the human at the `pr`
gate is the remaining check (the notification leads with the REQUEST_CHANGES + disposition).
