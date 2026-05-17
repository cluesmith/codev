# Plan: Baked Architectural Decisions in SPIR Issue Body

## Metadata
- **ID**: plan-2026-05-17-baked-decisions
- **Status**: draft (iter-2, post-CMAP)
- **Specification**: [codev/specs/746-spir-architect-s-baked-archite.md](../specs/746-spir-architect-s-baked-archite.md)
- **Created**: 2026-05-17

## Executive Summary

Implements Approach 3 from the spec (prompt-level honoring + protocol documentation). Pure prompt-and-documentation change with one supporting code change: a tiny parser in `spawn-roles.ts` that extracts a `## Baked Decisions` section from the issue body (heading-level-agnostic, case-insensitive) and exposes it as a new `baked_decisions` template context variable. Builder-prompts then render the section distinctly via `{{#if baked_decisions}}`. Reviewer prompts get explicit anti-relitigation instructions with architect-override carveouts. Each `protocol.md` gets a short discoverability paragraph. Everything mirrored to `codev-skeleton/`.

Decomposed into **4 phases**. Each phase is independently committable, valuable, and testable. Phase 5 is **integration verification** — running the snapshot diff suite end-to-end against fixture issues to confirm the user-facing acceptance criterion ("with-section vs without-section produces a diff consisting only of the new block") actually passes after all four phases land.

## Success Metrics

Copied verbatim from the spec's Success Criteria — every plan phase must close a subset of these. Cross-reference: spec section "Success Criteria" lists 14 deterministic pass/fail checks. The phase-level Acceptance Criteria below say which spec criteria each phase closes.

- [ ] All specification criteria met
- [ ] Test coverage: every new code path in `spawn-roles.ts` has unit tests; every prompt edit has a grep-based regression test
- [ ] No regression: existing builder-prompt / consult-prompt renders against issues with no `## Baked Decisions` section produce byte-identical output to the recorded baselines
- [ ] Documentation discoverability: `grep -l "Baked Decisions" codev/protocols/*/protocol.md` returns three files (SPIR / ASPIR / AIR)
- [ ] Skeleton parity: `diff -r codev/protocols/ codev-skeleton/protocols/` shows no substantive differences for touched files

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Parser + builder-prompt rendering (SPIR/ASPIR/AIR + skeleton)"},
    {"id": "phase_2", "title": "Drafting prompts: specify.md (SPIR/ASPIR) + implement.md (AIR) + skeleton"},
    {"id": "phase_3", "title": "Reviewer prompts: spec-review / plan-review / impl-review / pr-review + skeleton"},
    {"id": "phase_4", "title": "Protocol documentation paragraphs (SPIR/ASPIR/AIR + skeleton)"},
    {"id": "phase_5", "title": "End-to-end snapshot diff fixtures + final regression sweep"}
  ]
}
```

## Phase Breakdown

### Phase 1: Parser + Builder-Prompt Rendering
**Dependencies**: None

#### Objectives
- Add a small parser to `spawn-roles.ts` that extracts a `## Baked Decisions` section from an issue body — heading-level-agnostic (`#`, `##`, `###`, etc.), case-insensitive on the literal text "Baked Decisions". The extracted content runs from the matching heading to the next heading of equal-or-lesser depth (or end of body).
- Extend `TemplateContext` with an optional `baked_decisions?: string` field. Populate it in the codepath that builds the context from an issue (look for `context.issue.body` consumption sites).
- Update the SPIR, ASPIR, and AIR `builder-prompt.md` templates (and their `codev-skeleton/` mirrors) to render a distinct `## Baked Decisions` block via `{{#if baked_decisions}}...{{/if}}`, placed prominently (top-level, before or right after the protocol section — TBD during implementation, but **above** the `{{#if issue}}` block so the architect's pinned decisions are read before the surrounding issue prose).

#### Deliverables
- [ ] `extractBakedDecisions(issueBody: string): string | undefined` exported from `spawn-roles.ts` (or a new sibling module if cleaner)
- [ ] `TemplateContext.baked_decisions?: string` added to the interface
- [ ] Wiring in the issue→context builder so `baked_decisions` is populated from `issue.body` whenever the section is present
- [ ] Edits to `codev/protocols/spir/builder-prompt.md`, `codev/protocols/aspir/builder-prompt.md`, `codev/protocols/air/builder-prompt.md`
- [ ] Identical edits mirrored to `codev-skeleton/protocols/{spir,aspir,air}/builder-prompt.md`
- [ ] Unit tests for the parser (see Test Plan)
- [ ] Snapshot tests for builder-prompt rendering (with + without baked decisions, for each of SPIR/ASPIR/AIR)

#### Implementation Details

**Parser contract** (frozen by the spec's Resolved Decisions #3–#7):
- Find a heading whose text (after stripping leading `#`s and whitespace) matches `"baked decisions"` case-insensitively.
- The section ends at the next heading of equal-or-lesser depth than the matching heading, or at end of body.
- If no matching heading exists, or the section body (after the heading line) is whitespace-only, return `undefined` (treated as absent — no `## Baked Decisions` block renders).
- Two or more matching headings: take the first; flag the rest as part of its content (the contradiction-flagging behavior lives in the prompts, not the parser).
- Output is the raw markdown body of the section (without the heading line itself). Callers prepend `## Baked Decisions` when rendering.

**Files touched**:
- `packages/codev/src/agent-farm/commands/spawn-roles.ts` — defines and exports `extractBakedDecisions`; extends `TemplateContext` with `baked_decisions?: string`; enriches the context inside `buildPromptFromTemplate()` (just before `renderTemplate()`) by reading `context.issue?.body` and populating `context.baked_decisions`. **This is the preferred wiring point because it keeps all baked-decision logic colocated in one module and means BUGFIX automatically gets a no-op (its `builder-prompt.md` has no `{{#if baked_decisions}}` block).**
- `packages/codev/src/agent-farm/commands/spawn.ts` — this is where `TemplateContext` is *constructed* (around lines 405–420; verify on read). The plan defers context wiring to `spawn-roles.ts` (above), so `spawn.ts` should require **no edit** if the `buildPromptFromTemplate()`-side enrichment is used. List `spawn.ts` here as a **read-only verification touchpoint** — confirm that no second context-construction site is missed; if one exists, prefer adding the call there over routing through `buildPromptFromTemplate()`. If implementation reveals a need to edit `spawn.ts` directly (e.g., because the issue body is not present in `context.issue.body` at the `buildPromptFromTemplate()` site for some code path), do so and add a note in the phase review.
- `codev/protocols/spir/builder-prompt.md`
- `codev/protocols/aspir/builder-prompt.md`
- `codev/protocols/air/builder-prompt.md`
- `codev-skeleton/protocols/spir/builder-prompt.md`
- `codev-skeleton/protocols/aspir/builder-prompt.md`
- `codev-skeleton/protocols/air/builder-prompt.md`
- `packages/codev/src/agent-farm/__tests__/spawn-roles.test.ts` (new unit tests for the parser and template rendering)
- New: `packages/codev/src/agent-farm/__tests__/baked-decisions.test.ts` (focused suite for the parser edge cases; can live in the existing file if smaller than ~80 LOC)

**Builder-prompt addition** (template fragment, identical across SPIR/ASPIR/AIR modulo path):
```handlebars
{{#if baked_decisions}}
## Baked Decisions

The following decisions have been baked in by the architect. Do not autonomously override them. If you discover a serious reason to question a baked decision, surface that concern to the architect via `afx send` rather than relitigating it inside the spec/plan/review.

{{baked_decisions}}
{{/if}}
```

#### Acceptance Criteria
Closes spec criteria: *SPIR/ASPIR/AIR builder-prompt surface baked decisions* + *Snapshot diff (with-vs-without)*.
- [ ] Parser returns the correct content for fixtures `## Baked Decisions`, `### Baked Decisions`, `# Baked Decisions`, `## baked decisions` (lowercase)
- [ ] Parser returns `undefined` for: missing section, empty section, whitespace-only section
- [ ] Rendering each of the three builder-prompts against an issue with a non-empty section produces a top-level `## Baked Decisions` block
- [ ] Rendering each against an issue without the section produces no `## Baked Decisions` block (no empty stub, no double blank lines)
- [ ] Snapshot diff per builder-prompt (with vs without) consists exclusively of the new block — no other lines change
- [ ] `diff -r codev/protocols/{spir,aspir,air}/builder-prompt.md codev-skeleton/protocols/{spir,aspir,air}/builder-prompt.md` shows no differences

#### Test Plan
- **Unit Tests** (vitest): `extractBakedDecisions` against ~10 fixtures covering heading levels, case, absence, empty, whitespace-only, multiple headings, content with subheadings of greater depth (which should NOT terminate the section).
- **Integration Tests**: `renderTemplate` against each builder-prompt with two fixture contexts (baked-present and baked-absent); assert presence/absence of the `## Baked Decisions` literal heading in the output.
- **Snapshot Tests**: Use vitest's `toMatchSnapshot` (or hand-rolled file comparison) for the without-section render of each builder-prompt to establish a regression baseline.

#### Rollback Strategy
Single-file revert of `spawn-roles.ts` plus three protocol + three skeleton template files. The `baked_decisions` template variable is additive — pre-existing renders unaffected when it is `undefined`.

#### Risks
- **Risk**: Heading-detection regex misclassifies fenced code blocks containing `## Baked Decisions` as the section header.
  - **Mitigation**: Strip fenced code blocks before parsing, OR walk line-by-line tracking fence state. Add a fixture for this case.
- **Risk**: The new top-level block changes spacing in the rendered builder-prompt and breaks the "no regression" assertion for unrelated tests.
  - **Mitigation**: The block is gated on `{{#if baked_decisions}}`, so absent-case renders are unchanged; verify with a snapshot comparison against a pre-change baseline before merging.

---

### Phase 2: Drafting Prompts (specify.md + implement.md)
**Dependencies**: Phase 1

#### Objectives
- Update `codev/protocols/spir/prompts/specify.md` and `codev/protocols/aspir/prompts/specify.md` (+ skeleton mirrors) so the SPIR/ASPIR builder, when drafting a spec, reads the baked-decisions section first and writes its content verbatim into the spec's Constraints section.
- Update `codev/protocols/air/prompts/implement.md` (+ skeleton mirror) with an analogous "honor baked decisions from the issue body" clause — AIR has no spec phase so its baked-decision discipline lives in the implement prompt.
- All prompt language uses the **architect-override carveout** framing (spec Resolved Decision #12): "do not autonomously override / relitigate" rather than absolute prohibitions.

#### Deliverables
- [ ] Edit `codev/protocols/spir/prompts/specify.md`: add a clause near step 2 (Problem Analysis) instructing the builder to look for the baked-decisions section first
- [ ] Edit `codev/protocols/aspir/prompts/specify.md`: same edit
- [ ] Edit `codev/protocols/air/prompts/implement.md`: add an analogous clause near the beginning of the implementation instructions
- [ ] Mirror all three to `codev-skeleton/protocols/{spir,aspir,air}/prompts/`
- [ ] Regression grep tests confirming each file contains the expected phrasing

#### Implementation Details

**Clause text for SPIR/ASPIR `specify.md`** (final wording TBD during implementation):
> **Baked Decisions.** Before exploring solution approaches, check the issue body for a section named "Baked Decisions" (any heading level, case-insensitive). If present, copy its content verbatim into the spec's Constraints section and treat each item as fixed. Do not autonomously relitigate the architect's choices in your Solution Exploration. If you discover a serious problem with a baked decision, raise it via `afx send architect` rather than overriding it in the spec. **If two baked decisions contradict each other (e.g., two different language choices), do not pick one — pause, flag the contradiction to the architect via `afx send`, and wait for resolution before drafting.**

**Clause text for AIR `implement.md`**:
> **Baked Decisions.** Check the issue body for a section named "Baked Decisions" (any heading level, case-insensitive). If present, treat each listed decision as fixed during implementation. Do not autonomously substitute alternate languages, frameworks, or dependencies. If you discover a serious problem with a baked decision, raise it via `afx send architect` rather than working around it. **If two baked decisions contradict each other, do not pick one — pause, flag the contradiction to the architect via `afx send`, and wait for resolution before implementing.**

**Files touched**:
- `codev/protocols/spir/prompts/specify.md`
- `codev/protocols/aspir/prompts/specify.md`
- `codev/protocols/air/prompts/implement.md`
- `codev-skeleton/protocols/spir/prompts/specify.md`
- `codev-skeleton/protocols/aspir/prompts/specify.md`
- `codev-skeleton/protocols/air/prompts/implement.md`
- A small regression-grep test (extend an existing test in `packages/codev/src/__tests__/` or add a new one) asserting the clause is present in each file

#### Acceptance Criteria
Closes spec criteria: *SPIR/ASPIR `prompts/specify.md` instructs the builder...* + *AIR `prompts/implement.md` has an analogous clause* + *contradiction-handling (spec Resolved Decision #7) for drafting prompts*.
- [ ] `grep -l "Baked Decisions" codev/protocols/spir/prompts/specify.md` matches
- [ ] Same for ASPIR
- [ ] Same for `codev/protocols/air/prompts/implement.md`
- [ ] All three mirrored to `codev-skeleton/`
- [ ] The clauses use the carveout framing ("do not autonomously…") — not absolute prohibition
- [ ] Each clause explicitly addresses contradictions: grep for `contradict` or `pause` plus `flag` in each file
- [ ] Diff between codev/ and skeleton copies of these files shows no substantive differences

#### Test Plan
- **Grep regression test**: a vitest test that reads each of the six files and asserts the presence of:
  - The literal string `Baked Decisions`
  - The carveout phrase (`do not autonomously`)
  - Contradiction-handling vocabulary (`contradict` AND `pause` AND `flag`)
- **Manual reading**: post-edit, read the rendered specify.md and implement.md end-to-end to confirm the clause flows naturally in context.

#### Rollback Strategy
Single-line-or-paragraph revert per file. No code surface touched.

#### Risks
- **Risk**: The clause lands somewhere a builder would skip (e.g., buried in the "What NOT to Do" footer).
  - **Mitigation**: Place near the top of the operative section (right after the "Check for Existing Spec" block in specify.md, or right after the "Goal" block in implement.md).

---

### Phase 3: Reviewer Prompts (spec-review / plan-review / impl-review / pr-review)
**Dependencies**: Phase 1 (so the section exists conceptually; reviewers can refer to it)

#### Objectives
- Add anti-relitigation language with architect-override carveouts to:
  - `codev/protocols/spir/consult-types/spec-review.md`
  - `codev/protocols/aspir/consult-types/spec-review.md`
  - `codev/protocols/spir/consult-types/plan-review.md`
  - `codev/protocols/aspir/consult-types/plan-review.md`
  - `codev/protocols/air/consult-types/impl-review.md`
  - `codev/protocols/air/consult-types/pr-review.md`
- All six edits mirrored to `codev-skeleton/`.

#### Deliverables
- [ ] Six edited consult-type prompts (above) + six skeleton mirrors
- [ ] Each prompt's added clause explicitly mentions "Baked Decisions" by name
- [ ] Reviewer is told to flag a baked-decision concern as a `COMMENT`, not as `REQUEST_CHANGES`, and only `REQUEST_CHANGES` if the spec/plan/code **fails to honor** a baked decision (the contrapositive — spec doesn't follow the constraint — is a real defect)
- [ ] Grep regression tests for each file

#### Implementation Details

**Clause text** (template — adapt per consult-type, final wording TBD during implementation):
> **Baked Decisions.** If the spec's Constraints section (or the issue body in AIR's case) includes content under a "Baked Decisions" heading, the architect has marked those choices as fixed. Do not autonomously challenge them: do not propose alternative languages, frameworks, deployment shapes, or dependencies that contradict a baked decision. You may **`COMMENT`** with concerns about a baked decision (the architect will decide whether to rescind it); reserve **`REQUEST_CHANGES`** for the case where the spec/plan/code **fails to honor** a stated baked decision — that is a real defect. **If the baked decisions themselves contain contradictions (e.g., two different language choices), do not pick one — `REQUEST_CHANGES` and ask the architect to clarify before proceeding.**

For `plan-review.md` specifically, the existing "don't re-litigate spec decisions" line stays; the new paragraph supplements it with explicit baked-decision language.

**Files touched** (6 codev + 6 skeleton mirrors = 12 total):
- `codev/protocols/spir/consult-types/spec-review.md`
- `codev/protocols/aspir/consult-types/spec-review.md`
- `codev/protocols/spir/consult-types/plan-review.md`
- `codev/protocols/aspir/consult-types/plan-review.md`
- `codev/protocols/air/consult-types/impl-review.md`
- `codev/protocols/air/consult-types/pr-review.md`
- Skeleton mirrors of each
- One regression-grep test asserting the clause is present in each

#### Acceptance Criteria
Closes spec criteria: *SPIR/ASPIR `spec-review.md` contains a "do not autonomously override baked decisions" instruction*, *SPIR/ASPIR `plan-review.md` extends its existing language*, *AIR `impl-review.md` / `pr-review.md` have analogous instructions*, *contradiction-handling (spec Resolved Decision #7) for reviewer prompts*.
- [ ] All 6 codev + 6 skeleton files contain the literal string `Baked Decisions`
- [ ] All contain the carveout phrase (`do not autonomously`)
- [ ] All explicitly distinguish `COMMENT` from `REQUEST_CHANGES`
- [ ] All explicitly cover contradictions: grep for `contradict` plus a directive verb (`pause` / `clarify`) in each file
- [ ] Diff between codev/ and skeleton copies shows no substantive differences

#### Test Plan
- **Grep regression test**: vitest test reads each of the 12 files and asserts the presence of: `"Baked Decisions"`, `"do not autonomously"`, `"COMMENT"`, `"REQUEST_CHANGES"`, `"contradict"`.
- **Read-through**: post-edit, read each file in full to confirm the new paragraph fits the existing structure.

#### Rollback Strategy
Per-file paragraph revert. No interaction with other phases.

#### Risks
- **Risk**: Reviewer prompts collectively grow long enough that LLMs skim past the new clause.
  - **Mitigation**: Insert near the top of the "Notes" or "Focus Areas" section (above existing content), not at the bottom. Keep the paragraph to 3-4 sentences.

---

### Phase 4: Protocol Documentation Paragraphs
**Dependencies**: Phase 1 (so the convention is concrete) — but in practice can be done in parallel with Phase 2 or 3

#### Objectives
- Each `protocol.md` (SPIR, ASPIR, AIR) gets a short discoverability paragraph explaining the convention. Per spec Resolved Decision #11, this is the **primary discoverability surface** — architects learn baked decisions exist by reading the protocol they are about to invoke.
- The paragraph mentions the category hints (language / framework / deployment / dependencies / deferred decisions) so architects know what kinds of priors are appropriate to bake.

#### Deliverables
- [ ] Paragraph in `codev/protocols/spir/protocol.md`
- [ ] Paragraph in `codev/protocols/aspir/protocol.md`
- [ ] Paragraph in `codev/protocols/air/protocol.md`
- [ ] Skeleton mirrors of all three
- [ ] Grep regression test asserting the keyword "Baked Decisions" appears in each

#### Implementation Details

**Paragraph text** (final wording TBD during implementation):
> ### Baked Decisions (Optional)
>
> When filing an issue for SPIR / ASPIR / AIR, you can pin architectural decisions you don't want the builder or CMAP reviewers to re-litigate. Include a `## Baked Decisions` section (any heading level is fine) anywhere in the issue body. Useful categories: language, framework, deployment shape, key dependencies, decisions deferred to a later spec. The builder will copy the section verbatim into the spec's Constraints and treat each item as fixed; CMAP reviewers will not propose alternatives unless the spec itself fails to honor a stated decision. Leave the section out for issues where you want the builder to explore freely — absence is the no-op default. You can amend or rescind a baked decision at any time by updating the issue and respawning, or by sending the builder a direct instruction.

**Files touched**:
- `codev/protocols/spir/protocol.md`
- `codev/protocols/aspir/protocol.md`
- `codev/protocols/air/protocol.md`
- `codev-skeleton/protocols/{spir,aspir,air}/protocol.md`
- Regression-grep test (or extend Phase 2/3's grep test)

**Placement**: Insert as a sub-section after the protocol's "Overview" or "When to Use" section — somewhere an architect reading top-down will encounter it before invoking the protocol.

#### Acceptance Criteria
Closes spec criterion: *Documentation — each protocol.md contains a paragraph instructing architects how to declare baked decisions*.
- [ ] `grep -l "Baked Decisions" codev/protocols/{spir,aspir,air}/protocol.md` returns three files
- [ ] Same for `codev-skeleton/protocols/{spir,aspir,air}/protocol.md`
- [ ] Each paragraph mentions the category hints (language / framework / etc.)
- [ ] Each paragraph documents the rescind/amend escape hatch
- [ ] codev/ and skeleton diff clean

#### Test Plan
- **Grep regression test**: vitest assertion on the keyword + category hint words.
- **Manual reading**: confirm each paragraph reads naturally in the surrounding protocol prose.

#### Rollback Strategy
Per-file paragraph revert.

#### Risks
- **Risk**: Paragraph wording drifts between SPIR/ASPIR/AIR because they're edited independently.
  - **Mitigation**: Author a single canonical paragraph; copy verbatim to all three (with minor protocol-name adjustments). Add the grep test to enforce keyword consistency.

---

### Phase 5: End-to-End Snapshot Diff Fixtures + Final Regression Sweep
**Dependencies**: Phases 1-4

#### Objectives
- Build the concrete snapshot-diff test that the spec's tightened end-to-end criterion calls for: render each of the three builder-prompts twice against the same fixture issue (once with `## Baked Decisions`, once without) and assert the diff is exactly the new block.
- For consult-type prompts (which are static markdown, not rendered): assert that the only difference between the pre-change baseline and the post-change file is the newly added baked-decisions paragraph. This is the no-regression check that **closes the spec's "rendering each consult-type prompt against fixtures that do NOT include a Baked Decisions section produces output byte-identical to a baseline" criterion** in the form that actually fits how consult-type prompts work (they are read verbatim, not templated).
- Run the full grep suite from Phases 2-4 as a final regression sweep.
- Confirm no unintended changes via a full `diff -r codev/protocols/ codev-skeleton/protocols/`.

#### Deliverables
- [ ] Fixture issue bodies committed under `packages/codev/src/agent-farm/__tests__/fixtures/`:
  - `issue-with-baked.md` (containing a `## Baked Decisions` section with 2-3 sample items)
  - `issue-without-baked.md` (same content, section omitted)
- [ ] **Pre-change baselines captured at the start of Phase 1** for:
  - All three builder-prompts (SPIR/ASPIR/AIR `builder-prompt.md` — rendered output via `renderTemplate` against the no-baked fixture)
  - All six consult-type prompts touched by Phase 3 (SPIR `spec-review.md` + `plan-review.md`, ASPIR `spec-review.md` + `plan-review.md`, AIR `impl-review.md` + `pr-review.md`) — captured as raw file snapshots (these aren't rendered; the consult tooling reads them verbatim)
  - All three drafting prompts touched by Phase 2 (SPIR/ASPIR `specify.md`, AIR `implement.md`) — raw file snapshots
  - All three `protocol.md` files touched by Phase 4 — raw file snapshots
  - Baselines committed as fixtures under `packages/codev/src/agent-farm/__tests__/fixtures/baselines/`
- [ ] **Snapshot diff test (builder-prompts)**: for each of SPIR/ASPIR/AIR builder-prompts, render with and without; compute the diff; assert it equals the expected `## Baked Decisions` block (heading + carveout boilerplate from Phase 1's template + the fixture's section content).
- [ ] **No-regression test (builder-prompts)**: render each builder-prompt against the no-baked fixture; assert byte-identical to the captured baseline.
- [ ] **No-regression test (consult-type prompts)**: for each of the 6 consult-type prompts in Phase 3 + 3 drafting prompts in Phase 2 + 3 protocol.md files in Phase 4 = 12 files: diff the post-change file against its captured baseline. Assert that every changed line is part of an added paragraph (i.e., the diff consists of pure additions, no deletions or modifications to pre-existing lines). This is the consult-prompt analogue of the builder-prompt snapshot diff and satisfies the spec's no-regression criterion for static markdown files.
- [ ] Final grep sweep verifying every file from Phases 2-4 has the expected literal strings (single test that re-runs all Phase 2 / 3 / 4 greps).
- [ ] `diff -r codev/protocols/ codev-skeleton/protocols/` clean for touched files.

#### Implementation Details

**Snapshot test shape — builder-prompts** (illustrative):
```typescript
describe('Phase 5: baked-decisions end-to-end snapshot diff (builder-prompts)', () => {
  for (const protocol of ['spir', 'aspir', 'air']) {
    it(`${protocol} builder-prompt: with-vs-without diff is exactly the baked block`, () => {
      const ctxWith    = makeContext(protocol, { issue: { body: fixtureWithBaked } });
      const ctxWithout = makeContext(protocol, { issue: { body: fixtureWithoutBaked } });
      const rendered   = renderTemplate(template[protocol], ctxWith);
      const baseline   = renderTemplate(template[protocol], ctxWithout);
      const diff       = computeUnifiedDiff(baseline, rendered);
      // Every added line is part of the baked block; no other content changed.
      expect(diff.removedLines).toEqual([]);
      expect(diff.addedLines.join('\n')).toMatch(/^## Baked Decisions/);
    });

    it(`${protocol} builder-prompt: no-regression against pre-change baseline`, () => {
      const ctxWithout = makeContext(protocol, { issue: { body: fixtureWithoutBaked } });
      const rendered   = renderTemplate(template[protocol], ctxWithout);
      const baseline   = readBaseline(`${protocol}-builder-prompt-no-baked.txt`);
      expect(rendered).toEqual(baseline);
    });
  }
});
```

**Snapshot test shape — consult-type + drafting + protocol.md files** (illustrative):
```typescript
describe('Phase 5: no-regression for static prompt files', () => {
  const STATIC_FILES = [
    // Phase 2 (drafting prompts)
    'codev/protocols/spir/prompts/specify.md',
    'codev/protocols/aspir/prompts/specify.md',
    'codev/protocols/air/prompts/implement.md',
    // Phase 3 (reviewer prompts)
    'codev/protocols/spir/consult-types/spec-review.md',
    'codev/protocols/aspir/consult-types/spec-review.md',
    'codev/protocols/spir/consult-types/plan-review.md',
    'codev/protocols/aspir/consult-types/plan-review.md',
    'codev/protocols/air/consult-types/impl-review.md',
    'codev/protocols/air/consult-types/pr-review.md',
    // Phase 4 (docs)
    'codev/protocols/spir/protocol.md',
    'codev/protocols/aspir/protocol.md',
    'codev/protocols/air/protocol.md',
  ];

  for (const file of STATIC_FILES) {
    it(`${file}: diff vs baseline is pure-addition (no deletions or modifications)`, () => {
      const post     = readFileSync(file, 'utf-8');
      const baseline = readBaseline(file.replace(/\//g, '_') + '.baseline');
      const diff     = computeUnifiedDiff(baseline, post);
      expect(diff.removedLines).toEqual([]);
      // Optional: assert added lines contain "Baked Decisions" so we know the addition is the intended one.
      expect(diff.addedLines.join('\n')).toContain('Baked Decisions');
    });
  }
});
```

`computeUnifiedDiff` can use the `diff` npm package (already a common transitive dep) or be hand-rolled with a 30-line line-diff function — both acceptable; the builder picks during implementation.

**Files touched**:
- `packages/codev/src/agent-farm/__tests__/fixtures/issue-with-baked.md`
- `packages/codev/src/agent-farm/__tests__/fixtures/issue-without-baked.md`
- `packages/codev/src/agent-farm/__tests__/fixtures/baselines/*.baseline` — pre-change snapshots of the 12 static files + 3 builder-prompt no-baked renders
- `packages/codev/src/agent-farm/__tests__/baked-decisions-e2e.test.ts` (new)

#### Acceptance Criteria
Closes spec criteria: *Snapshot diff (with-vs-without)*, *No regression* (for both builder-prompts AND static prompt files), *Skeleton parity*.
- [ ] The snapshot diff test passes for all three builder-prompts (with-vs-without diff = exactly the baked block)
- [ ] The without-baked render of each builder-prompt is byte-identical to the pre-change baseline (no regression — builder-prompts)
- [ ] For each of the 12 static files (Phases 2-4), the diff against the pre-change baseline is pure-addition (zero removed lines, zero modified lines) — no regression for consult/drafting/protocol files
- [ ] All grep regression tests from Phases 2-4 pass in a single test run
- [ ] `diff -r codev/protocols/ codev-skeleton/protocols/` for touched files is clean

#### Test Plan
- **Builder-prompt snapshot tests** (new): the with-vs-without diff assertion + the no-regression baseline assertion for each of SPIR/ASPIR/AIR.
- **Static-file no-regression tests** (new): for each of the 12 static prompt/doc files, the pure-addition diff assertion described above.
- **Regression suite**: re-run all grep tests added in Phases 2-4.
- **Manual smoke**: run `afx spawn` (or use a dry-render harness if one exists) against a hand-crafted issue with a baked decisions section to visually confirm the rendered prompt looks right.

#### Rollback Strategy
The test files are additive — removing them does not affect any production code.

#### Risks
- **Risk**: The "no-regression baseline" captured in Phase 1 drifts if Phases 2-4 edit files in ways that affect rendering (e.g., a stray newline change).
  - **Mitigation**: Run the regression check at the end of each phase, not just Phase 5. If a regression appears, identify and revert the unintended change.
- **Risk**: The diff-equality assertion is brittle to whitespace differences in the template's `{{#if}}` block trimming.
  - **Mitigation**: Use the existing `renderTemplate`'s post-processing (`replace(/\n{3,}/g, '\n\n')` and `.trim()`) so the assertion is on the canonical output, not raw template residue.

## Dependency Map
```
Phase 1 (parser + builder-prompts) ──→ Phase 2 (drafting prompts)
                                  ├──→ Phase 3 (reviewer prompts)
                                  └──→ Phase 4 (docs)
                                            │
                                            ↓
                                       Phase 5 (e2e snapshot + sweep)
```

Phases 2, 3, and 4 are independent of each other and can be done in any order after Phase 1. Phase 5 depends on all of them.

## Resource Requirements
### Development Resources
- **Engineers**: One builder (this one), familiar with TypeScript and the codev prompt-template system
- **Environment**: standard Codev dev environment; `pnpm install` + `pnpm --filter @cluesmith/codev test`

### Infrastructure
- None new. No database changes, no new services, no configuration changes.

## Integration Points
### External Systems
None.

### Internal Systems
- **Tower / spawn pipeline**: consumes `TemplateContext`. The new `baked_decisions` field is additive — existing call sites work unchanged because the field is optional.
- **CMAP reviewer pipeline (`consult` CLI)**: consumes the consult-type prompts. The added paragraphs flow through the existing pipeline; no consult-tooling change.
- **Skeleton-sync**: the standard rule — every edit in `codev/protocols/` mirrored to `codev-skeleton/protocols/` — applies. No new tooling needed.

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
| Parser misclassifies fenced code blocks containing `## Baked Decisions` | Medium | Medium | Strip / skip fenced blocks during parsing; add explicit fixture | Builder |
| Builder-prompt edits break unrelated snapshot tests | Low | Medium | Capture pre-change baseline in Phase 1; gate every render-output change on the `{{#if baked_decisions}}` condition | Builder |
| Skeleton mirrors drift from codev/ | Low | Low | Skeleton-parity assertion baked into Phases 1-4 + final sweep in Phase 5 | Builder |
| Reviewer prompts grow long enough that the new clause is skimmed | Medium | Low | Place clause near top of Notes / Focus Areas section; keep to 3-4 sentences | Builder |
| Documentation paragraph drift between SPIR / ASPIR / AIR | Medium | Low | Single canonical paragraph copied to all three with minor name adjustments | Builder |
| End-to-end diff test is brittle to whitespace | Medium | Low | Diff against canonical (post-trim) output | Builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|-------------|--------|------------|-------|
| CMAP iter on plan exposes a hole that requires re-architecting the parser | Low | Medium | Plan is intentionally a thin parser + prompt-level changes; minimal surface to re-architect | Builder |

## Validation Checkpoints
1. **After Phase 1**: Builder-prompts render the new block correctly; parser unit tests green; pre-change baseline captured.
2. **After Phase 2**: Specify/implement prompts contain the carveout clause; grep test green.
3. **After Phase 3**: All six reviewer prompts contain the anti-relitigation language; grep test green.
4. **After Phase 4**: Three `protocol.md` files documented; discoverability paragraph reads naturally.
5. **After Phase 5**: End-to-end diff test passes; full no-regression sweep green; skeleton parity clean.
6. **Before PR**: Run `pnpm --filter @cluesmith/codev test`; run a manual `afx spawn` dry-render against a fixture issue.

## Monitoring and Observability
Not applicable — this is a prompt-and-documentation change with no runtime behavior to observe.

## Documentation Updates Required
- [ ] `codev/protocols/spir/protocol.md`: discoverability paragraph (Phase 4)
- [ ] `codev/protocols/aspir/protocol.md`: discoverability paragraph (Phase 4)
- [ ] `codev/protocols/air/protocol.md`: discoverability paragraph (Phase 4)
- [ ] `codev-skeleton/protocols/{spir,aspir,air}/protocol.md`: mirrors (Phase 4)
- [ ] Review document (`codev/reviews/746-spir-architect-s-baked-archite.md`) per SPIR's Review phase

## Post-Implementation Tasks
- [ ] Manual smoke: spawn a SPIR builder against a fixture issue with a `## Baked Decisions` section, confirm the builder reads it and respects it in the spec draft.
- [ ] (Optional, deferred) Consider whether `afx spawn` should warn when it detects `## Baked Decisions` in an issue body but the section is empty — listed as a Nice-to-Know in the spec; not in this plan's scope.

## Expert Review

**Iteration 1 — 2026-05-17**: Reviewed by Gemini, Codex, Claude. Verdicts: Gemini `APPROVE`, Codex `REQUEST_CHANGES`, Claude `APPROVE`.

Key consolidated feedback addressed in this iter-2 update:

- **Phase 1: `spawn.ts` clarification** (all three reviewers flagged). `TemplateContext` is populated in `spawn.ts`, not `spawn-roles.ts`. Phase 1 now explicitly lists both files: the preferred wiring point is `spawn-roles.ts` (inside `buildPromptFromTemplate`, just before `renderTemplate`), keeping all baked-decision logic colocated; `spawn.ts` is listed as a read-only verification touchpoint with a fallback if `buildPromptFromTemplate` doesn't have access to the issue body at the right code path.
- **Phase 5: no-regression for consult-type prompts** (Codex). The spec requires no-regression on **all** touched files, not just builder-prompts. Phase 5 now includes a 12-file "pure-addition diff" check covering all consult-type, drafting, and protocol.md files — baselines captured early in Phase 1 and asserted in Phase 5.
- **Contradiction handling (spec Resolved Decision #7)** (Codex). The plan now requires explicit "if baked decisions contradict, pause and flag" language in Phase 2's drafting prompts AND Phase 3's reviewer prompts, with corresponding grep tests asserting the words `contradict` + `pause`/`flag`/`clarify` are present.

Minor observations from Claude (Phase 5's `computeDiff()` not being a standard vitest util) addressed inline by naming the implementation options (`diff` npm package or hand-rolled — both acceptable).

Plan adjustments summary:
- Phase 1 "Files touched": added `spawn.ts` as read-only verification with fallback edit clause
- Phase 2 clause text: added contradiction-pause sentence to both SPIR/ASPIR and AIR clauses
- Phase 2 Acceptance Criteria + Test Plan: added contradiction grep
- Phase 3 clause text: added contradiction-`REQUEST_CHANGES` sentence
- Phase 3 Acceptance Criteria + Test Plan: added contradiction grep
- Phase 5: doubled deliverables to cover 12 static files + 3 builder-prompts, added illustrative static-file test code, explicit baseline-capture timing

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-05-17 | Initial plan draft | Spec 746 approved by architect | Builder |
| 2026-05-17 | iter-2: spawn.ts wiring clarification, consult-prompt no-regression, contradiction-handling | CMAP feedback (Codex REQUEST_CHANGES, Gemini + Claude minor) | Builder |

## Notes

- The parser is intentionally minimal — heading-name match only, no schema enforcement. The discipline lives in the prompts. This matches Codev's existing prompt-driven posture.
- The architect-override carveout (spec Resolved Decision #12) is the most important framing constraint. Every prompt addition must use "do not autonomously …" rather than absolute prohibition. PR reviewer should grep for and verify this in every touched file.
- Phases 2 / 3 / 4 are highly parallelizable. The plan orders them 1→2→3→4→5 for readability; the actual implementation can interleave them as long as Phase 1's snapshot baseline is captured first.

---

## Amendment History

<!-- TICK amendments to this plan go here in chronological order -->
