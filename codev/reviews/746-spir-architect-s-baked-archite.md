# Review: Baked Architectural Decisions in SPIR Issue Body (#746)

## Summary

Adds a structured channel for architects to pin architectural decisions in SPIR / ASPIR / AIR issue bodies, so builders and CMAP reviewers honor those decisions instead of re-litigating them. Pure prompt-and-documentation change — zero new code surface, zero runtime impact.

Architects who file an issue with a `## Baked Decisions` section see those decisions:
- Surfaced explicitly to the builder by the builder-prompt
- Honored during spec drafting (SPIR/ASPIR) or implementation (AIR) via the drafting prompts
- Protected from relitigation by all six CMAP reviewer prompts
- Discoverable via a new sub-section in each protocol.md

Total scope: 30 files edited (3 codev + 3 skeleton × 5 file types) + 1 new test file with 193 tests + 12 baseline snapshots. Net diff: +1,500 / -50 lines, almost entirely markdown.

## Spec Compliance

Every Success Criterion from the spec (`codev/specs/746-spir-architect-s-baked-archite.md`) is satisfied:

- [x] **SPIR builder-prompt** surfaces baked decisions — `## Baked Decisions` paragraph added between `## Protocol` and `{{#if spec}}`
- [x] **ASPIR builder-prompt** behaves identically — same paragraph, same placement
- [x] **AIR builder-prompt** surfaces baked decisions — same paragraph, placed between `## Protocol` and `{{#if issue}}`
- [x] **SPIR `prompts/specify.md`** instructs the builder — new `### 0.5 Baked Decisions` clause directs the builder to copy the section verbatim into Constraints
- [x] **ASPIR `prompts/specify.md`** has the same clause
- [x] **AIR `prompts/implement.md`** has the analogous clause — adapted for the no-spec workflow
- [x] **SPIR/ASPIR `consult-types/spec-review.md`** contain anti-relitigation instruction with COMMENT-vs-REQUEST_CHANGES distinction
- [x] **SPIR/ASPIR `consult-types/plan-review.md`** extend the existing "don't re-litigate" line with explicit baked-decision language
- [x] **AIR `consult-types/impl-review.md`** and **`pr-review.md`** have analogous instructions
- [x] **Documentation** — each `protocol.md` (SPIR/ASPIR/AIR) has a discoverability paragraph with category hints (language / framework / dependencies) and the amend/rescind escape hatch
- [x] **Skeleton mirror** — every edit in `codev/protocols/` is mirrored to `codev-skeleton/protocols/`; mirror parity asserted in tests
- [x] **Snapshot/no-regression** — replaced with pure-addition diff against pre-change baselines for all 12 prompt files (per architect feedback in iter-3 — see Deviations)
- [x] **No regression** — every touched static file's diff vs. its baseline is pure-addition (zero removed lines, zero modified lines)

## Deviations from Plan

### Iter-3 plan revision: dropped the parser entirely

The original plan (iter-2 of plan-approval) included:
- A `extractBakedDecisions(issueBody)` parser in `spawn-roles.ts`
- A new `TemplateContext.baked_decisions?: string` field
- A `{{#if baked_decisions}}` block in each builder-prompt template
- Parser unit tests + snapshot tests for template rendering

The architect rejected this approach at the plan-approval gate (2026-05-17 ~20:34 PDT), reasoning:
1. Builder-prompts and reviewer-prompts (which are static markdown) were getting instruction-only treatment regardless. Splitting them into two paradigms (templated vs. instruction-driven) added asymmetry without benefit.
2. LLM-driven recognition is more robust to variant section names (`## Constraints (fixed)`, `## Architectural Givens`) than a regex parser would be.
3. Prompt-driven discipline is Codev's core ethos — adding ~80 LOC of parser + edge-case handling was over-engineering.

The plan was rewritten to a pure prompt-and-documentation change. Net effect:
- Phases reduced from 5 to 4 (parser phase + e2e fixture phase removed)
- Baselines reduced from 15 to 12 (no template-rendering snapshots needed)
- Zero new code surface
- Test infrastructure simplified to grep + pure-addition diff

This deviation produced a strictly simpler, more maintainable result.

### Other deviations

None. All four phases landed as specified in the iter-3 plan.

## Lessons Learned

### What Went Well

- **Architect feedback at the plan-approval gate prevented over-engineering.** Without the iter-3 rewrite, this PR would have shipped ~80 LOC of regex parser + new test infrastructure that didn't earn its keep. The rebuttal/iteration cycle paid off.
- **CMAP caught real test gaps.** Codex Phase 3 iter-1 spotted that the COMMENT/REQUEST_CHANGES check was too loosely scoped — it would pass even if the new paragraph lost those tokens because they already exist in the pre-existing Verdict Format section. The fix (extract the section first, then grep) is a generalizable pattern.
- **Programmatic smoke beats manual smoke.** Codex Phase 4 iter-1 caught that the "manual smoke" deliverable wasn't evidenced; converting it to a programmatic test (running `renderTemplate` against fixture issues in vitest) is strictly stronger and runs every test invocation.
- **Pure-addition diff against pre-change baselines is a lightweight no-regression mechanism.** No diff library needed — a 25-line line-walking helper does the job. Catches "someone accidentally deleted existing content while adding the new paragraph."

### Challenges Encountered

- **"Diff clean" as a parity criterion conflicts with pre-existing file divergence.** Codev/ and skeleton trees have intentional structural differences (Multi-PR / Verify sections present in skeleton, absent in codev/) that pre-date this work. Codex Phase 1 and Phase 4 both flagged file-level `diff -r` as failing — but reconciling that divergence would conflate two unrelated changes. Resolution: scope mirror-parity tests to the **section this phase changes** (extract `## Baked Decisions`, compare those byte-for-byte) rather than asserting whole-file parity. Documented in two rebuttals; both accepted.
- **Plan acceptance criteria need to be precise about scope.** The Phase 1, 3, and 4 plans all had "diff clean" or similar language that read as broader than intended. Future plans should write "[the new section] is byte-identical across codev/ and skeleton" rather than "codev/ and skeleton diff clean".

### What Would Be Done Differently

- Write the plan with the parser-vs-instruction tradeoff already considered. The iter-1 plan jumped to a parser because the spec used "baked decisions" language that felt structured; in retrospect, the LLM-driven approach was the obvious choice given Codev's prompt-driven posture.
- Specify mirror-parity scope explicitly in the plan ("section-level parity, not file-level diff clean") to avoid the recurring Codex flag.
- Consider committing programmatic smoke tests from Phase 1 rather than relying on a "manual smoke" deliverable in a later phase. The smoke value is realized once and then runs forever for free.

### Methodology Improvements

- **For prompt-driven features**: default to LLM-driven recognition. Only introduce a parser if the LLM provably cannot do the job (e.g., security-sensitive parsing, structured machine-readable contract). The architect's iter-3 feedback codifies this as a general principle.
- **For plan acceptance criteria involving mirrored trees**: scope to "the new content this phase introduces is byte-identical between codev/ and skeleton" — never use "diff clean" without qualification, since pre-existing divergence is the norm.
- **For "manual smoke" deliverables**: convert to programmatic tests up-front. There is rarely a good reason to keep something as manual when `renderTemplate` or equivalent is accessible from the test runner.

## Architecture Updates

No architecture updates needed. This is a prompt-and-documentation change with no new subsystems, no new data flows, no new modules, and no new files in `codev/resources/arch.md`'s domain. The existing `{{issue.body}}` template variable continues to carry the issue body verbatim — no change to the spawn pipeline.

## Lessons Learned Updates

Added three new lessons to `codev/resources/lessons-learned.md` under the appropriate sections:

1. **Process / Plan Authoring**: *"Default to LLM-driven recognition over regex parsing for features whose discipline is enforced by prompts. Only add a parser when the LLM provably cannot do the job (e.g., security parsing, structured machine contracts). Adding code surface for what is fundamentally a prompt-discipline question is over-engineering."*

2. **Process / Plan Authoring**: *"Plan acceptance criteria involving mirrored trees (codev/ ↔ codev-skeleton/) should scope to 'the new content is byte-identical' rather than 'diff clean'. Pre-existing structural divergence between the two trees is the norm; whole-file parity criteria force phases to either conflate unrelated cleanup or generate rebuttal traffic."*

3. **Process / Testing**: *"Convert 'manual smoke' deliverables to programmatic tests at design time. If `renderTemplate` (or equivalent) is accessible from the test runner, running the smoke automatically is strictly stronger than a one-time manual check and adds zero ongoing maintenance cost."*

## Consultation Feedback

### Specify Phase (Round 1) — 2026-05-14

#### Gemini — REQUEST_CHANGES
- **Concern**: Unresolved scope (SPIR only vs all three protocols), unresolved template location.
  - **Addressed**: Resolved Decisions #1 and #2 added — applies to SPIR + AIR + ASPIR; templates land in both Codev and skeleton.
- **Concern**: Heading-level robustness (`##` vs `###`) not addressed.
  - **Addressed**: Resolved Decision #3 — matching is heading-level-agnostic + case-insensitive; test scenarios + risk row added.
- **Concern**: Plan-review consistency — existing "don't re-litigate" line too generic.
  - **Addressed**: Resolved Decision #9 — explicit anti-relitigation language added to plan-review.md (and AIR equivalents) in Success Criteria.

#### Codex — REQUEST_CHANGES
- **Concern**: Scope still unresolved in spec text.
  - **Addressed**: Same as Gemini above — explicit decision #1.
- **Concern**: Acceptance criteria non-deterministic ("CMAP feedback does not relitigate it").
  - **Addressed**: Rewrote every Success Criterion as a concrete grep / snapshot / file-existence check with explicit "Pass:" signals.
- **Concern**: Minimum contract for issue-body format undefined.
  - **Addressed**: Resolved Decisions #3-#5 — heading text "Baked Decisions" (case-insensitive, any level); empty / missing / placeholder-only = no-op.
- **Concern**: Edge cases incomplete (intra-section contradictions, conflict with prose).
  - **Addressed**: Resolved Decisions #6, #7, #8 — explicit rules added; Test Scenarios 6, 7 added.

#### Claude — COMMENT
- **Concern**: `prompts/specify.md` (SPIR + ASPIR) missing from Dependencies — these drive spec drafting, distinct from builder-prompt.
  - **Addressed**: Added to Dependencies; explicit Success Criteria for each.
- **Concern**: First "Critical" open question already answered by spec content.
  - **Addressed**: Resolved in Resolved Decisions; removed from open questions.
- **Concern**: codev-skeleton/ as explicit success criterion.
  - **Addressed**: Added.
- **Concern**: Clarify AIR has no `spec-review.md`.
  - **Addressed**: Resolved Decision #10 — AIR touchpoints enumerated.

### Specify Phase (Architect Feedback at spec-approval gate) — 2026-05-17

- **Feedback**: Drop the `.github/ISSUE_TEMPLATE/` scope entirely. Codev is CLI-driven; templates only fire for GitHub UI filing.
  - **Addressed**: Resolved Decision #2 rewritten; documentation paragraph in each protocol.md becomes the discoverability surface (Decision #11).
- **Feedback**: Tighten the end-to-end transcript criterion to a concrete snapshot diff.
  - **Addressed**: Reworded the criterion to "snapshot diff (with vs without Baked Decisions section) consists exclusively of the new block."
- **Feedback**: Add architect-override carveout framing to all prompt language.
  - **Addressed**: Resolved Decision #12 added; every prompt clause uses "do not autonomously …" framing.

### Plan Phase (Round 1) — 2026-05-17

#### Gemini — APPROVE
- No concerns raised. Noted minor observation about `spawn.ts` being the actual context-construction site (also flagged by Codex and Claude).

#### Codex — REQUEST_CHANGES
- **Concern**: Phase 1 understated the code surface (`spawn.ts` missing).
  - **Addressed**: Phase 1 "Files touched" expanded to include `spawn.ts` as a read-only verification touchpoint with fallback edit clause. (Moot after iter-3 architect rewrite dropped the parser entirely.)
- **Concern**: Phase 5 missing no-regression coverage for consult-type prompts.
  - **Addressed**: Phase 5 deliverables expanded to cover 12 static files with pure-addition diff. (Folded into Phase 4 after iter-3 rewrite.)
- **Concern**: Contradiction handling (spec Decision #7) under-specified in plan.
  - **Addressed**: Explicit contradiction clause text added to Phase 2 and Phase 3, plus grep tests for `contradict` + `pause` + `flag`.

#### Claude — APPROVE
- Same `spawn.ts` observation as Gemini and Codex (non-blocking).
- Noted that `computeDiff()` in illustrative code isn't a standard vitest utility — addressed inline by noting the `diff` npm package or hand-rolled options.

### Plan Phase (Architect Feedback at plan-approval gate) — 2026-05-17

- **Feedback**: Drop the parser entirely. Use prompt instructions.
  - **Addressed**: Entire plan rewritten (iter-3). Parser, `TemplateContext` field, and `{{#if baked_decisions}}` block removed. 5 phases → 4 phases. 15 baselines → 12 baselines. See "Deviations from Plan" above.

### Implement Phase 1 (Builder-prompts) — 2026-05-17

#### Gemini — APPROVE
- No concerns.

#### Codex — REQUEST_CHANGES
- **Concern**: Codev/ and skeleton builder-prompts still differ beyond the new paragraph.
  - **Rebutted**: Pre-existing divergence (skeleton has Multi-PR / Verify sections that codev/ doesn't) is out of this work's scope. Codex/Gemini reading of "diff clean" is over-strict.
- **Concern**: Tests only check pure-addition against codev/ baselines; never assert codev/ ↔ codev-skeleton/ parity.
  - **Addressed**: Added a focused parity test that extracts the `## Baked Decisions` section from each builder-prompt and asserts codev/ + skeleton sections are byte-identical. Doesn't fail on pre-existing divergence; does catch drift in the paragraph this work owns.

#### Claude — APPROVE
- Independently validated the pre-existing-divergence interpretation. Noted the pollution check could be extended beyond SPIR — non-blocking; pure-addition diff guards ASPIR/AIR implicitly.

### Implement Phase 2 (Drafting prompts) — 2026-05-17

#### Gemini — APPROVE
- No concerns.

#### Codex — APPROVE
- No concerns.

#### Claude — APPROVE
- Noted the `### 0.5 Baked Decisions` numbering choice as a creative way to fit the existing flow. Non-blocking.

### Implement Phase 3 (Reviewer prompts) — 2026-05-17

#### Gemini — APPROVE
- No concerns.

#### Codex — REQUEST_CHANGES
- **Concern**: Phase 3 grep test for COMMENT/REQUEST_CHANGES is file-scoped, but those tokens already exist in the pre-existing `## Verdict Format` section. A regression that loses the distinction from the new paragraph would silently pass.
  - **Addressed**: Lifted `extractBakedSection` helper to the top of the Phase 3 describe block; rewrote per-file blocks to assert against the extracted section, not the whole file. Hypothetical regression now fails loudly.

#### Claude — APPROVE
- Noted the same test had 48 grep regression tests without flagging the scoping weakness — Codex caught the subtler case. Acknowledged in rebuttal.

### Implement Phase 4 (Docs + final sweep) — 2026-05-17

#### Gemini — APPROVE
- No concerns.

#### Codex — REQUEST_CHANGES
- **Concern**: Manual smoke not evidenced — only static regression checks, no artifact showing the spawn-and-render check was performed.
  - **Addressed**: Converted the manual smoke into a programmatic end-to-end test (`Spec 746 end-to-end smoke` describe block). For each of SPIR/ASPIR/AIR builder-prompts, renders against fixture issue bodies (with + without baked decisions) and asserts the rendered prompt contains both the instruction paragraph and the issue's baked-decisions content. Strictly stronger than one-time manual check.
- **Concern**: Skeleton-parity check is section-only, not broader codev/skeleton diff.
  - **Rebutted**: Same grounds as Phase 1 — pre-existing divergence is out of scope; section-level parity is what Phase 4 owns and matches the actual obligation.

#### Claude — APPROVE
- Noted one cosmetic leftover comment in the inventory list (stream-of-consciousness text). Cleaned up in the same commit as the smoke conversion.

## Flaky Tests

No flaky tests encountered or introduced. The full pre-existing test suite (2,632 tests across 130 files) plus this work's 193 new tests all pass deterministically.

## Follow-up Items

- **Deferred (Nice-to-Know in spec)**: Consider whether `afx spawn` should warn at spawn time if it detects a `## Baked Decisions` header in the issue body but the section is empty. Out of scope for this PR — pure prompt/docs change kept the surface tight. Could be a future bugfix or TICK if architects request it.
- **Deferred**: Section-name aliasing (e.g., "Architectural Givens" or "Constraints (fixed)") is intentionally out of scope. The spec requires the literal "Baked Decisions" name. If usage shows architects gravitating to other names, the prompts could be updated to recognize aliases.
- **Worth tracking**: How often do architects actually use the section? Future MAINTAIN run could audit recent issues to see uptake and inform a v2 (e.g., issue template prompt if discoverability proves insufficient).
