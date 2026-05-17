# Plan: Baked Architectural Decisions in SPIR Issue Body

## Metadata
- **ID**: plan-2026-05-17-baked-decisions
- **Status**: draft (iter-3, post-architect-feedback)
- **Specification**: [codev/specs/746-spir-architect-s-baked-archite.md](../specs/746-spir-architect-s-baked-archite.md)
- **Created**: 2026-05-17

## Executive Summary

**Pure prompt-and-documentation change.** No code surface touched. No parser, no `TemplateContext` field, no template-engine changes. The LLM finds the `## Baked Decisions` section in the issue body (which is already passed verbatim via `{{issue.body}}`) and honors it because the prompt tells it to.

This is the simplest design that satisfies the spec. It also handles variant section names (e.g., "Constraints (fixed)", "Architectural Choices") and inline baked decisions in prose more gracefully than a regex parser would — the LLM recognizes intent, the regex would not. Adding parser infrastructure for what is fundamentally a prompt-discipline question would be against Codev's core ethos.

**4 phases.** Each phase is independently committable, valuable, and testable. The tests are exclusively grep-based content assertions plus pure-addition diffs against pre-change baselines — no template-rendering snapshots, no parser unit tests.

## Success Metrics

Copied from the spec's Success Criteria. Cross-reference: spec section "Success Criteria" lists 14 deterministic pass/fail checks. The phase-level Acceptance Criteria below say which spec criteria each phase closes.

- [ ] All specification criteria met
- [ ] Test coverage: every touched prompt file has a grep regression test asserting the required instruction language; every touched file has a pure-addition diff test against its pre-change baseline
- [ ] No regression: every touched static markdown file's diff vs. its pre-change baseline contains zero removed lines and zero modified lines (only additions)
- [ ] Documentation discoverability: `grep -l "Baked Decisions" codev/protocols/*/protocol.md` returns three files (SPIR / ASPIR / AIR)
- [ ] Skeleton parity: `diff -r codev/protocols/ codev-skeleton/protocols/` shows no substantive differences for touched files

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Builder-prompt instruction (SPIR/ASPIR/AIR + skeleton)"},
    {"id": "phase_2", "title": "Drafting prompts: specify.md (SPIR/ASPIR) + implement.md (AIR) + skeleton"},
    {"id": "phase_3", "title": "Reviewer prompts: spec-review / plan-review / impl-review / pr-review + skeleton"},
    {"id": "phase_4", "title": "Protocol documentation + final regression sweep"}
  ]
}
```

## Phase Breakdown

### Phase 1: Builder-Prompt Instruction
**Dependencies**: None

#### Objectives
- Add a uniform instruction paragraph to the SPIR / ASPIR / AIR `builder-prompt.md` templates (and their `codev-skeleton/` mirrors) telling the builder to recognize a `## Baked Decisions` section in the issue body and treat its contents as fixed.
- Capture pre-change baselines of all touched files (used in this phase and later phases for the no-regression assertion).

#### Deliverables
- [ ] Pre-change baseline snapshots of the 12 prompt files touched across this and subsequent phases (3 builder-prompts + 3 drafting prompts + 6 reviewer prompts), committed under `packages/codev/src/agent-farm/__tests__/fixtures/baselines/`. Captured up-front in Phase 1 so subsequent phases can assert against them.
- [ ] Edits to `codev/protocols/spir/builder-prompt.md`, `codev/protocols/aspir/builder-prompt.md`, `codev/protocols/air/builder-prompt.md`
- [ ] Identical edits mirrored to `codev-skeleton/protocols/{spir,aspir,air}/builder-prompt.md`
- [ ] Grep regression test in a new `packages/codev/src/agent-farm/__tests__/baked-decisions.test.ts` (or extension of an existing test file) asserting each builder-prompt contains the required strings
- [ ] Pure-addition diff test against the pre-change baselines

#### Implementation Details

**Instruction paragraph** (uniform across all three builder-prompts, final wording TBD during implementation):

```markdown
## Baked Decisions

If the issue body contains a section named "Baked Decisions" (any heading level, case-insensitive), treat its contents as fixed architectural decisions baked in by the architect. Do not autonomously override them in your spec, plan, or implementation. If you discover a serious reason to question a baked decision, surface that concern to the architect via `afx send` rather than relitigating it inside the spec/plan/review.

If the architect's baked-decisions section contains internal contradictions (e.g., two different language choices), do not pick one — pause, flag the contradiction to the architect via `afx send`, and wait for resolution before proceeding.
```

**Placement**: Insert near the top of each builder-prompt, after the `## Protocol` section and before `{{#if spec}}` / `{{#if issue}}` blocks. This ensures the builder reads the instruction before encountering the issue body.

**Files touched**:
- `codev/protocols/spir/builder-prompt.md`
- `codev/protocols/aspir/builder-prompt.md`
- `codev/protocols/air/builder-prompt.md`
- `codev-skeleton/protocols/spir/builder-prompt.md`
- `codev-skeleton/protocols/aspir/builder-prompt.md`
- `codev-skeleton/protocols/air/builder-prompt.md`
- `packages/codev/src/agent-farm/__tests__/fixtures/baselines/spir-builder-prompt.md.baseline`
- `packages/codev/src/agent-farm/__tests__/fixtures/baselines/aspir-builder-prompt.md.baseline`
- `packages/codev/src/agent-farm/__tests__/fixtures/baselines/air-builder-prompt.md.baseline`
- `packages/codev/src/agent-farm/__tests__/fixtures/baselines/` — also pre-populate baselines for the 9 other prompt files touched in Phases 2-3 (capture once, use across all phases)
- `packages/codev/src/agent-farm/__tests__/baked-decisions.test.ts` (new test file)

#### Acceptance Criteria
Closes spec criteria: *SPIR/ASPIR/AIR builder-prompt surface baked decisions*.
- [ ] Each of the 3 codev + 3 skeleton builder-prompts contains the literal string `Baked Decisions`
- [ ] Each contains the carveout phrase (`do not autonomously`)
- [ ] Each contains contradiction-handling vocabulary (`contradict` AND `pause`)
- [ ] Diff of each post-edit file vs. its pre-change baseline is **pure addition** — zero removed lines, zero modified lines
- [ ] `diff -r codev/protocols/{spir,aspir,air}/builder-prompt.md codev-skeleton/protocols/{spir,aspir,air}/builder-prompt.md` shows no differences

#### Test Plan
- **Baseline capture script**: a small helper (can be a one-line shell loop or part of the test file setup) that reads each of the 12 currently-touched files and writes them to `__tests__/fixtures/baselines/`. Run **once** at the start of Phase 1, before any edits.
- **Grep regression test** (vitest): reads each builder-prompt file and asserts the literal strings above.
- **Pure-addition diff test** (vitest): reads each builder-prompt and its baseline, computes a line-diff (using the `diff` npm package — already commonly available — or a 30-line hand-rolled function), asserts `diff.removed.length === 0` and `diff.modified.length === 0`.

#### Rollback Strategy
Per-file paragraph revert. No code surface touched, so no rollback complexity.

#### Risks
- **Risk**: Paragraph wording drifts between SPIR / ASPIR / AIR because they're edited independently.
  - **Mitigation**: Author a single canonical paragraph; copy verbatim to all three. The grep test enforces keyword consistency.
- **Risk**: Baseline capture happens after an unintended pre-Phase-1 edit, polluting the baseline.
  - **Mitigation**: First commit of Phase 1 is **only** the baseline capture (a separate "[Spec 746][Phase: 1] chore: capture pre-change baselines" commit) before any prompt edits.

---

### Phase 2: Drafting Prompts (specify.md + implement.md)
**Dependencies**: Phase 1 (so the baseline-capture infrastructure is in place; the baselines for Phase 2's files were captured in Phase 1)

#### Objectives
- Update SPIR / ASPIR `prompts/specify.md` (+ skeleton mirrors) so the builder, when drafting a spec, reads the baked-decisions section first and writes its content verbatim into the spec's Constraints section.
- Update AIR `prompts/implement.md` (+ skeleton mirror) with an analogous "honor baked decisions from the issue body" clause — AIR skips the spec phase so its baked-decision discipline lives in the implement prompt.
- All prompt language uses the architect-override carveout framing (spec Resolved Decision #12).

#### Deliverables
- [ ] Edit `codev/protocols/spir/prompts/specify.md`: add clause instructing the builder to look for the baked-decisions section first and copy it into Constraints verbatim
- [ ] Edit `codev/protocols/aspir/prompts/specify.md`: same edit
- [ ] Edit `codev/protocols/air/prompts/implement.md`: analogous clause near the implementation instructions
- [ ] Mirror all three to `codev-skeleton/protocols/{spir,aspir,air}/prompts/`
- [ ] Extend the grep regression test from Phase 1 to cover these 6 files
- [ ] Pure-addition diff test against pre-change baselines for these 6 files

#### Implementation Details

**Clause text for SPIR/ASPIR `specify.md`** (final wording TBD during implementation):

> **Baked Decisions.** Before exploring solution approaches, check the issue body for a section named "Baked Decisions" (any heading level, case-insensitive). If present, copy its content verbatim into the spec's Constraints section and treat each item as fixed. Do not autonomously relitigate the architect's choices in your Solution Exploration. If you discover a serious problem with a baked decision, raise it via `afx send architect` rather than overriding it in the spec. If two baked decisions contradict each other (e.g., two different language choices), do not pick one — pause, flag the contradiction via `afx send`, and wait for resolution before drafting.

**Clause text for AIR `implement.md`**:

> **Baked Decisions.** Check the issue body for a section named "Baked Decisions" (any heading level, case-insensitive). If present, treat each listed decision as fixed during implementation. Do not autonomously substitute alternate languages, frameworks, or dependencies. If you discover a serious problem with a baked decision, raise it via `afx send architect` rather than working around it. If two baked decisions contradict each other, do not pick one — pause, flag the contradiction via `afx send`, and wait for resolution before implementing.

**Placement**: Near the top of the operative section (in specify.md, right after the "Check for Existing Spec" block; in implement.md, right after the "Goal" block) so the builder reads the rule before starting drafting/implementation.

**Files touched**:
- `codev/protocols/spir/prompts/specify.md`
- `codev/protocols/aspir/prompts/specify.md`
- `codev/protocols/air/prompts/implement.md`
- Skeleton mirrors of each
- Extension of `packages/codev/src/agent-farm/__tests__/baked-decisions.test.ts`

#### Acceptance Criteria
Closes spec criteria: *SPIR/ASPIR `prompts/specify.md` instructs the builder...*, *AIR `prompts/implement.md` has an analogous clause*, *contradiction-handling (spec Resolved Decision #7) for drafting prompts*.
- [ ] All 3 codev + 3 skeleton files contain the literal string `Baked Decisions`
- [ ] All contain the carveout phrase (`do not autonomously`)
- [ ] All contain contradiction-handling vocabulary (`contradict` AND `pause` AND `flag`)
- [ ] Each post-edit file's diff vs. its pre-change baseline is pure addition
- [ ] Diff between codev/ and skeleton copies shows no substantive differences

#### Test Plan
- **Grep regression test** (extending Phase 1's test): reads each of the 6 files and asserts the literal strings + carveout + contradiction vocabulary.
- **Pure-addition diff test** (extending Phase 1's test): runs the same line-diff function against each of the 6 files vs. its baseline.
- **Manual reading**: post-edit, read each file end-to-end to confirm the clause flows in context.

#### Rollback Strategy
Per-file paragraph revert.

#### Risks
- **Risk**: The clause lands somewhere a builder would skim past (e.g., buried in the "What NOT to Do" footer).
  - **Mitigation**: Place near the top of the operative section as specified above.

---

### Phase 3: Reviewer Prompts (spec-review / plan-review / impl-review / pr-review)
**Dependencies**: Phase 1 (baselines)

#### Objectives
- Add anti-relitigation language with architect-override carveouts and contradiction-handling to the 6 consult-type prompt files (+ 6 skeleton mirrors).

#### Deliverables
- [ ] Edits to:
  - `codev/protocols/spir/consult-types/spec-review.md`
  - `codev/protocols/aspir/consult-types/spec-review.md`
  - `codev/protocols/spir/consult-types/plan-review.md`
  - `codev/protocols/aspir/consult-types/plan-review.md`
  - `codev/protocols/air/consult-types/impl-review.md`
  - `codev/protocols/air/consult-types/pr-review.md`
- [ ] Mirrors of each in `codev-skeleton/`
- [ ] Extension of the grep regression test to cover these 12 files
- [ ] Pure-addition diff test against pre-change baselines for these 6 files (the canonical codev/ copies — skeleton parity is asserted separately)

#### Implementation Details

**Clause text** (template — adapt per consult-type, final wording TBD during implementation):

> **Baked Decisions.** If the spec's Constraints section (or the issue body in AIR's case) includes content under a "Baked Decisions" heading, the architect has marked those choices as fixed. Do not autonomously challenge them: do not propose alternative languages, frameworks, deployment shapes, or dependencies that contradict a baked decision. You may **`COMMENT`** with concerns about a baked decision (the architect will decide whether to rescind it); reserve **`REQUEST_CHANGES`** for the case where the spec/plan/code **fails to honor** a stated baked decision — that is a real defect. If the baked decisions themselves contain contradictions (e.g., two different language choices), do not pick one — `REQUEST_CHANGES` and ask the architect to clarify before proceeding.

For `plan-review.md` specifically, the existing "don't re-litigate spec decisions" line stays; the new paragraph supplements it with explicit baked-decision language.

**Placement**: Insert near the top of the "Notes" or "Focus Areas" section (above existing content), not at the bottom. Keep the paragraph to 3-4 sentences.

**Files touched** (6 codev + 6 skeleton = 12):
- `codev/protocols/spir/consult-types/spec-review.md`
- `codev/protocols/aspir/consult-types/spec-review.md`
- `codev/protocols/spir/consult-types/plan-review.md`
- `codev/protocols/aspir/consult-types/plan-review.md`
- `codev/protocols/air/consult-types/impl-review.md`
- `codev/protocols/air/consult-types/pr-review.md`
- Skeleton mirrors of each
- Extension of `packages/codev/src/agent-farm/__tests__/baked-decisions.test.ts`

#### Acceptance Criteria
Closes spec criteria: *SPIR/ASPIR `spec-review.md` contains a "do not autonomously override baked decisions" instruction*, *SPIR/ASPIR `plan-review.md` extends its existing language*, *AIR `impl-review.md` / `pr-review.md` have analogous instructions*, *contradiction-handling (spec Resolved Decision #7) for reviewer prompts*.
- [ ] All 6 codev + 6 skeleton files contain the literal string `Baked Decisions`
- [ ] All contain the carveout phrase (`do not autonomously`)
- [ ] All explicitly distinguish `COMMENT` from `REQUEST_CHANGES`
- [ ] All contain contradiction-handling vocabulary (`contradict` AND `clarify`)
- [ ] Each post-edit codev/ file's diff vs. its pre-change baseline is pure addition
- [ ] Diff between codev/ and skeleton copies shows no substantive differences

#### Test Plan
- **Grep regression test** (extending Phase 1/2's test): reads each of the 12 files and asserts the literal strings.
- **Pure-addition diff test** (extending Phase 1/2's test): runs the line-diff against each of the 6 codev/ files vs. its baseline.
- **Read-through**: post-edit, read each file in full to confirm the new paragraph fits the existing structure.

#### Rollback Strategy
Per-file paragraph revert.

#### Risks
- **Risk**: Reviewer prompts collectively grow long enough that LLMs skim past the new clause.
  - **Mitigation**: Place clause near the top of Notes / Focus Areas; keep to 3-4 sentences.

---

### Phase 4: Protocol Documentation Paragraphs + Final Regression Sweep
**Dependencies**: Phases 1-3 (so all prompt edits are in place; this phase verifies them collectively)

#### Objectives
- Add a discoverability paragraph to each `protocol.md` (SPIR, ASPIR, AIR) + skeleton mirrors. Per spec Resolved Decision #11, this is the primary discoverability surface.
- Run the final cross-phase regression sweep: full grep suite + `diff -r` skeleton parity check + a manual smoke confirming a real spawn renders the new content.

#### Deliverables
- [ ] Paragraph in `codev/protocols/spir/protocol.md`
- [ ] Paragraph in `codev/protocols/aspir/protocol.md`
- [ ] Paragraph in `codev/protocols/air/protocol.md`
- [ ] Skeleton mirrors of all three
- [ ] Grep regression test for the keyword "Baked Decisions" in each protocol.md
- [ ] Final cross-phase grep sweep test (re-runs every Phase 1-3 grep)
- [ ] Skeleton-parity assertion: `diff -r codev/protocols/ codev-skeleton/protocols/` clean for touched files
- [ ] Manual smoke: spawn a builder against a fixture issue containing a `## Baked Decisions` section, confirm the rendered prompt the builder receives includes both the issue's baked-decisions content (via `{{issue.body}}`) and the instruction paragraph telling them how to handle it (added in Phase 1)

#### Implementation Details

**Paragraph text** (final wording TBD during implementation):

```markdown
### Baked Decisions (Optional)

When filing an issue for SPIR / ASPIR / AIR, you can pin architectural decisions you don't want the builder or CMAP reviewers to re-litigate. Include a `## Baked Decisions` section (any heading level is fine) anywhere in the issue body. Useful categories: language, framework, deployment shape, key dependencies, decisions deferred to a later spec. The builder will copy the section verbatim into the spec's Constraints and treat each item as fixed; CMAP reviewers will not propose alternatives unless the spec itself fails to honor a stated decision. Leave the section out for issues where you want the builder to explore freely — absence is the no-op default. You can amend or rescind a baked decision at any time by updating the issue and respawning, or by sending the builder a direct instruction via `afx send`.
```

**Placement**: Insert as a sub-section after the protocol's "Overview" or "When to Use" section — somewhere an architect reading top-down will encounter it before invoking the protocol.

**Files touched**:
- `codev/protocols/spir/protocol.md`
- `codev/protocols/aspir/protocol.md`
- `codev/protocols/air/protocol.md`
- `codev-skeleton/protocols/{spir,aspir,air}/protocol.md`
- Extension of `packages/codev/src/agent-farm/__tests__/baked-decisions.test.ts` for the docs grep + the cross-phase final sweep

#### Acceptance Criteria
Closes spec criterion: *Documentation — each protocol.md contains a paragraph instructing architects how to declare baked decisions*. Also closes *Skeleton parity* and the cross-phase no-regression sweep.
- [ ] `grep -l "Baked Decisions" codev/protocols/{spir,aspir,air}/protocol.md` returns three files
- [ ] Same for `codev-skeleton/protocols/{spir,aspir,air}/protocol.md`
- [ ] Each paragraph mentions the category hints (language / framework / etc.)
- [ ] Each paragraph documents the rescind/amend escape hatch
- [ ] codev/ and skeleton diff clean
- [ ] Cross-phase grep sweep: all required strings present in every file touched in Phases 1-3
- [ ] Manual smoke: spawned builder's rendered prompt visibly includes the instruction paragraph + the issue's baked-decisions content; confirmed by reading the rendered prompt file or watching the builder reference it

#### Test Plan
- **Grep regression test**: vitest assertion on the keyword + category hint words in each protocol.md.
- **Cross-phase grep sweep**: single test that re-runs every grep assertion from Phases 1-3 in one pass.
- **Skeleton-parity test** (vitest, optional but recommended): walk all touched files and assert codev/ and skeleton copies match.
- **Manual reading**: confirm each paragraph reads naturally in surrounding protocol prose.
- **Manual smoke**: spawn a builder against `__tests__/fixtures/issue-with-baked.md` (the existing fixture from earlier plans — re-purposed here as a sanity check) and inspect the resulting `.builder-prompt.txt` for the expected content.

#### Rollback Strategy
Per-file paragraph revert.

#### Risks
- **Risk**: Paragraph wording drifts between SPIR / ASPIR / AIR.
  - **Mitigation**: Single canonical paragraph copied to all three with minor name adjustments; grep test enforces keyword consistency.
- **Risk**: Manual smoke is skipped; subtle integration issue ships.
  - **Mitigation**: The smoke is explicitly listed as an acceptance criterion above; PR review can ask for evidence (e.g., a screenshot or pasted excerpt).

## Dependency Map
```
Phase 1 (builder-prompts + baselines) ──→ Phase 2 (drafting prompts)
                                     ├──→ Phase 3 (reviewer prompts)
                                     └──→ Phase 4 (docs + final sweep)
```

Phases 2 and 3 are independent of each other and can be done in either order after Phase 1. Phase 4 depends on Phases 2 and 3 because its cross-phase grep sweep needs their edits to be present.

## Resource Requirements
### Development Resources
- **Engineers**: One builder (this one), comfortable with prompt-template editing and vitest
- **Environment**: standard Codev dev environment; `pnpm install` + `pnpm --filter @cluesmith/codev test`

### Infrastructure
- None new.

## Integration Points
### External Systems
None.

### Internal Systems
- **Tower / spawn pipeline**: unchanged. No code surface touched. `{{issue.body}}` continues to carry the issue body verbatim, including any `## Baked Decisions` section.
- **CMAP reviewer pipeline (`consult` CLI)**: consumes the consult-type prompts as static markdown. The added paragraphs flow through the existing pipeline; no consult-tooling change.
- **Skeleton-sync**: the standard rule — every edit in `codev/protocols/` mirrored to `codev-skeleton/protocols/` — applies.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
| Paragraph wording drifts across the three protocols | Medium | Low | Single canonical paragraph copied to all; grep test enforces keywords | Builder |
| Builder-prompt addition changes whitespace and breaks unrelated snapshot tests | Low | Low | Pure-addition diff assertion catches this; the template's existing trim/dedup post-processing handles minor spacing | Builder |
| Skeleton mirrors drift from codev/ | Low | Low | Skeleton-parity assertion baked into Phase 4's final sweep | Builder |
| Reviewer prompts grow long enough that the new clause is skimmed | Medium | Low | Place clause near top of Notes / Focus Areas; keep to 3-4 sentences | Builder |
| Baseline capture happens after an unintended edit, polluting the baseline | Low | Medium | First commit of Phase 1 is exclusively the baseline capture, before any prompt edits | Builder |
| LLM misses a baked-decisions section because the heading is unusual ("Architectural Givens") | Medium | Low | The prompt instruction names "Baked Decisions" specifically; architects who use the convention will use that name. Unusual variants are explicitly out of scope — the spec requires recognition of the literal "Baked Decisions" section name. | Architect |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
| CMAP iter on plan exposes a hole | Low | Low | Plan is minimal; smallest reasonable scope | Builder |

## Validation Checkpoints
1. **After Phase 1**: Baselines captured before edits. Three builder-prompts contain the instruction paragraph. Grep + pure-addition diff tests green.
2. **After Phase 2**: Drafting/implement prompts contain the carveout clause and contradiction-handling. Grep + pure-addition diff tests green.
3. **After Phase 3**: All six reviewer prompts contain the anti-relitigation language with COMMENT/REQUEST_CHANGES distinction and contradiction-handling. Grep + pure-addition diff tests green.
4. **After Phase 4**: Three protocol.md files documented. Cross-phase grep sweep green. Skeleton parity clean. Manual smoke confirmed.
5. **Before PR**: Full `pnpm --filter @cluesmith/codev test` green.

## Monitoring and Observability
Not applicable — this is a prompt-and-documentation change with no runtime behavior.

## Documentation Updates Required
- [ ] `codev/protocols/spir/protocol.md`: discoverability paragraph (Phase 4)
- [ ] `codev/protocols/aspir/protocol.md`: discoverability paragraph (Phase 4)
- [ ] `codev/protocols/air/protocol.md`: discoverability paragraph (Phase 4)
- [ ] `codev-skeleton/protocols/{spir,aspir,air}/protocol.md`: mirrors (Phase 4)
- [ ] Review document (`codev/reviews/746-spir-architect-s-baked-archite.md`) per SPIR's Review phase

## Post-Implementation Tasks
- [ ] (Optional, deferred) Consider whether `afx spawn` should warn when it detects `## Baked Decisions` in an issue body but the section is empty — listed as a Nice-to-Know in the spec; not in this plan's scope.

## Expert Review

**Iteration 1 — 2026-05-17**: Reviewed by Gemini, Codex, Claude. Verdicts: Gemini `APPROVE`, Codex `REQUEST_CHANGES`, Claude `APPROVE`. Plan was then revised per iter-2 to address Codex's three issues (spawn.ts wiring, consult-prompt no-regression, contradiction-handling).

**Architect Feedback — 2026-05-17** (post iter-2 plan-approval gate):

- **Dropped the parser entirely.** No `extractBakedDecisions()`, no `TemplateContext.baked_decisions`, no `{{#if baked_decisions}}` template block, no code surface. The LLM finds the section in the issue body (already passed via `{{issue.body}}`) and honors it because the prompt tells it to. Reasoning: (1) builder-prompts and reviewer-prompts (which are static markdown) were going to get instruction-only treatment regardless — splitting them across two paradigms (templated vs. instruction-driven) added asymmetry without benefit; (2) LLM-driven recognition is more robust to variant section names than a regex parser; (3) prompt-driven discipline is Codev's core ethos.
- **Reduced from 5 phases to 4.** Phase 1 (parser) and Phase 5 (e2e fixtures + sweep) are gone; their valid parts (cross-phase grep sweep, manual smoke) are folded into the new Phase 4.
- **Reduced from 15 baselines to 12.** No template-rendering snapshots needed; just raw-file pre-change baselines for the 12 prompt files (3 builder + 3 drafting + 6 reviewer). Protocol.md files don't need baselines because their additions are entirely new sub-sections (grep + manual readthrough is enough).
- **Contradiction handling stays** as instruction text in both drafting and reviewer prompts (per Codex iter-1 #3) — already integrated.
- **Test infrastructure simplifies** — no parser unit tests, no template-rendering snapshots, no fixture-issue files. Just grep tests and pure-addition diff tests, all in one new `baked-decisions.test.ts` file.

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-05-17 | Initial plan draft | Spec 746 approved by architect | Builder |
| 2026-05-17 | iter-2: spawn.ts wiring clarification, consult-prompt no-regression, contradiction-handling | CMAP feedback (Codex REQUEST_CHANGES) | Builder |
| 2026-05-17 | iter-3: dropped parser entirely; reduced to 4 phases; pure prompt+docs change | Architect feedback (over-engineering) | Builder |

## Notes

- This plan is intentionally minimal — pure prompt-and-documentation change with grep + pure-addition diff tests as the only verification. No code surface means no rollback complexity and no maintenance burden.
- The architect-override carveout (spec Resolved Decision #12) is the most important framing constraint. Every prompt addition uses "do not autonomously …" rather than absolute prohibition. PR reviewer should grep for and verify this in every touched file.
- Phases 2 and 3 are highly parallelizable. The plan orders them 1→2→3→4 for readability; the actual implementation can interleave them as long as Phase 1's baseline capture is the first action.

---

## Amendment History

<!-- TICK amendments to this plan go here in chronological order -->
