# Specification: Baked Architectural Decisions in SPIR Issue Body

---
approved: 2026-05-17
validated: [gemini, codex, claude]
---

## Metadata
- **ID**: spec-2026-05-14-baked-decisions
- **Status**: approved
- **Created**: 2026-05-14
- **Last Updated**: 2026-05-17 (iter-4: spec text amended to match the iter-3 plan-approval direction toward unconditional rendering — see Amendments below)
- **GitHub Issue**: #746

## Clarifying Questions Asked

Issue #746 is a well-scoped feature request from the Shannon architect, filed 2026-05-14 with a concrete failure case (Spec 1353 Persona harness) and two candidate solution shapes (Option A: optional issue-template section; Option B: pre-spec checklist). Because the issue already articulates problem, cost, and design options, no additional clarifying questions were posed to the user before drafting this spec. Questions surfaced during drafting are tracked in **Resolved Decisions** and **Open Questions** below.

## Problem Statement

When an architect files a SPIR (or AIR / ASPIR) issue and already has a **strong prior** on a major architectural decision — language, framework, deployment shape, protocol choice, dependency boundary — that prior is currently invisible to the builder and the CMAP reviewers (Codex / Gemini / Claude). The builder drafts the spec against an *assumed* default. CMAP reviews that spec on its merits. By the time the architect intervenes ("actually, use Python, not Node"), the spec has been through one or two consultation rounds against the wrong assumption, and the iter-2 reviewer feedback is obsolete the moment the assumption flips.

**Concrete failure**: Shannon Spec 1353 (Persona harness), 2026-05-14:
- iter-1: spec drafted assuming Node design (default)
- iter-2: drop daemon, per CMAP
- iter-3: architect intervenes — "use Python, match `shanutil`" (major reset)
- iter-4: CMAP polish

Cost: ~45 min of churn rewriting the spec, plus Codex's iter-2 feedback became wrong the moment the language switched.

The root cause is not bad CMAP feedback; it is a **missing input channel** for the architect's pre-spec convictions. The architect's strong priors are real data that the builder and reviewers need at iter-1, not at iter-3.

## Current State

Today, when an architect spawns a SPIR/AIR/ASPIR builder:
1. The builder receives the issue body verbatim in the builder-prompt template.
2. The builder reads the issue, drafts a spec, and runs CMAP.
3. CMAP reviews the spec on its technical merits — including questioning language, framework, and protocol choices the architect already considers settled.
4. If the architect was watching, they intervene mid-cycle to override the assumption, forcing a rewrite.
5. If the architect was not watching, the spec converges on the wrong shape and is rejected at the spec-approval gate, also forcing a rewrite.

There is no structured slot in the issue body for **"these decisions are fixed, do not relitigate"**. Architects who want to communicate priors do so in prose — easy to miss, easy for reviewers to override in good faith, easy for builders to treat as one option among several.

The `spec-review.md` and `plan-review.md` consult-type prompts (used by Codex / Gemini / Claude during CMAP) give reviewers a generic mandate to evaluate completeness, correctness, feasibility, and clarity. `plan-review.md` already says *"don't re-litigate spec decisions"*, which means baked decisions *will* be honored at plan-time *iff* they were faithfully written into the approved spec's Constraints section. The remaining gap is at spec-review (where there is no anti-relitigation instruction at all) and at the moment of initial spec drafting (where the specify prompt does not tell the builder to treat the section as fixed).

## Desired State

Architects have a **structured, optional channel** in the issue body to declare baked architectural decisions. When present:
1. The builder treats those decisions as **fixed inputs** to the spec — not options to explore.
2. CMAP reviewers (at spec-review **and** plan-review) are explicitly instructed to **not relitigate** the listed decisions; their job is to review the spec/plan *given* those constraints.
3. The spec's "Constraints" section incorporates the baked decisions verbatim, so they remain visible through the full spec/plan/implement lifecycle.
4. AIR builders (which skip the spec phase) honor the baked decisions directly via their builder-prompt and `impl-review.md` consult-type.

When absent (the section is left blank or omitted), behavior is unchanged from today: the spec explores tradeoffs freely.

The expected outcome on the Shannon 1353 failure mode: if the architect had listed "Language: Python (match `shanutil`)" as a baked decision in the issue body, iter-1 would have drafted in Python, iter-2 CMAP would have left the language alone, and the 45-min reset would not have happened.

## Stakeholders

- **Primary Users**: Architects filing SPIR / AIR / ASPIR issues. They are the ones with the strong priors and the ones who pay the cost of relitigation.
- **Secondary Users**: Builders (autonomous AI agents) and CMAP reviewers (Codex / Gemini / Claude). They consume the baked decisions and must honor them.
- **Technical Team**: Codev maintainers. They own the issue templates, builder-prompts, prompt files, and consult-type prompts that this spec touches.
- **Business Owners**: Codev project — Waleed Kadous.

## Resolved Decisions

The following decisions were raised during drafting and CMAP / architect review and are now considered settled in this spec:

1. **Scope: all three protocols.** SPIR, AIR, and ASPIR all suffer the same failure mode and must all honor baked decisions. ASPIR is identical to SPIR except for gates; it shares the same prompt assets. AIR skips the spec phase but its implement and PR review prompts still need to honor baked decisions surfaced through the issue body.

2. **No GitHub issue template.** (Revised in iter-3 per architect feedback.) Codev is CLI-driven; `.github/ISSUE_TEMPLATE/` only fires for issues filed via the GitHub web UI. Architects who file via `gh issue create --body-file` or via the API would bypass the template entirely. Templates also add a maintenance surface (Codev mirror + `codev-skeleton/` mirror + downstream inheritance) that pays for itself only if the UI is the dominant filing path — which it is not. The correctness work — prompt-level honoring of the section by builders and CMAP reviewers — is what actually matters. **Discoverability** for architects is achieved instead via a documentation paragraph in each protocol's `protocol.md` (see Decision #9). Architects with strong priors include a `## Baked Decisions` section in the issue body by convention; the prompts honor it whether it arrived via UI or CLI.

3. **Section heading format: heading-level-agnostic match on the name "Baked Decisions".** Prompts and instructions look for a section *named* "Baked Decisions" (case-insensitive), not for an exact `##` heading level. Real-world issue bodies render at varying heading levels (`##`, `###`); the match must tolerate that.

4. **Section identity = literal heading string.** The contract is: a heading whose text is "Baked Decisions" (any leading `#`s, any case) opens the section; the section ends at the next heading of equal-or-lesser depth or end of issue. No nested machine schema — content is free-form markdown.

5. **Empty section = no-op.** A section that is missing, present-but-empty, or contains only the placeholder text (the comment block from the template) is treated as absent. Behavior matches today's default — full exploration.

6. **Conflict between baked decisions and other issue prose**: baked decisions win. If the issue body says "we should consider both Node and Python" in prose and the baked section says "Python", the baked section is authoritative.

7. **Conflict within the baked decisions themselves** (e.g., two contradictory bullet points): builder must flag the contradiction to the architect (via `afx send architect`) and pause rather than guess. Reviewer prompts should also flag, not silently pick a winner.

8. **Conflict between a baked decision and the drafted spec**: reviewer flags the contradiction as a `REQUEST_CHANGES` against the *spec* (it failed to honor the constraint), not as an attempt to relitigate the decision.

9. **plan-review extension**: explicitly add an anti-relitigation instruction to `plan-review.md` mirroring the spec-review wording. The existing "don't re-litigate spec decisions" line is too generic; we want it explicit that baked decisions from the issue body are still off-limits even if the plan would benefit from changing them.

10. **AIR coverage**: AIR has no `spec-review.md` (it skips the spec phase). For AIR, the touchpoints are its `builder-prompt.md`, `prompts/implement.md`, and `consult-types/impl-review.md` + `consult-types/pr-review.md`. The instruction in AIR's prompts is "honor baked decisions from the issue body."

11. **Discoverability via documentation, not templates.** Each affected `protocol.md` (SPIR, ASPIR, AIR) gets a short paragraph: *"If you have strong priors on language / framework / deployment / dependencies, include a `## Baked Decisions` section in the issue body. The builder and CMAP reviewers will treat its contents as fixed and will not re-litigate them."* Same change mirrored to `codev-skeleton/protocols/*/protocol.md`. This is the entire discoverability surface — no template ceremony.

12. **Architect-override carveout in all prompt language.** Prompt rules that constrain the builder/reviewer behavior around baked decisions must be framed as *"do not autonomously override a baked decision"*, not *"baked decisions are forbidden to question"*. The architect can always rescind or amend a baked decision in a follow-up message; the rule guards against silent autonomous drift, not against human revision. Every prompt addition this spec drives must include this carveout in spirit (and in the literal phrasing where reasonable).

## Success Criteria

Each criterion has a concrete pass/fail signal so a builder can verify it without ambiguity. **All criteria are prompt-and-documentation changes** — no issue templates, no CLI changes (see Resolved Decision #2).

- [ ] **SPIR builder-prompt** carries a top-level `## Baked Decisions` instruction paragraph that teaches the builder the convention. (Amended in iter-4: per the iter-3 plan-approval direction, the paragraph is **unconditional** — present in every rendered builder-prompt regardless of whether the issue body contains a Baked Decisions section. The paragraph is a no-op when no section is present; it educates the builder when one is. See Amendments below.) Pass: rendering the template against any issue produces a top-level `## Baked Decisions` block; when the issue itself contains a Baked Decisions section, that content reaches the builder verbatim via `{{issue.body}}`.
- [ ] **ASPIR builder-prompt** behaves identically to SPIR's. Pass: same rendering test against ASPIR's template.
- [ ] **AIR builder-prompt** carries the same instruction paragraph. Pass: same rendering test against AIR's template.
- [ ] **SPIR `prompts/specify.md`** instructs the builder to read the baked-decisions section first and to write its content verbatim into the spec's Constraints section. Pass: grep the file for an explicit clause referencing "Baked Decisions" and Constraints.
- [ ] **ASPIR `prompts/specify.md`** has the same clause. Pass: grep.
- [ ] **AIR `prompts/implement.md`** has an analogous "honor baked decisions from the issue body" clause. Pass: grep.
- [ ] **SPIR `consult-types/spec-review.md`** contains a "do not autonomously override baked decisions" instruction (carveout phrasing per Decision #12). Pass: grep for explicit phrasing covering the case where the spec respects a baked decision (reviewer should not push back on the underlying choice; only flag if the spec fails to honor the decision).
- [ ] **ASPIR `consult-types/spec-review.md`** has the same instruction. Pass: grep.
- [ ] **SPIR `consult-types/plan-review.md`** extends its existing anti-relitigation language to explicitly cover baked decisions. Pass: grep for explicit "baked decisions" language.
- [ ] **ASPIR `consult-types/plan-review.md`** has the same explicit phrasing. Pass: grep.
- [ ] **AIR `consult-types/impl-review.md`** has an analogous instruction. Pass: grep.
- [ ] **AIR `consult-types/pr-review.md`** has an analogous instruction. Pass: grep.
- [ ] **Documentation** — `codev/protocols/spir/protocol.md`, `codev/protocols/aspir/protocol.md`, and `codev/protocols/air/protocol.md` each contain a paragraph instructing architects how to declare baked decisions in the issue body. Pass: grep for "Baked Decisions" in each protocol.md; manual read confirms the paragraph explains the convention, category hints (language / framework / deployment / dependencies), and the "no relitigation by default" behavior.
- [ ] **Skeleton mirror** — every file modified in `codev/protocols/` has the identical edit applied to its mirror in `codev-skeleton/protocols/`. Pass: `diff -r codev/protocols/ codev-skeleton/protocols/` for the touched files shows no substantive differences (other than path-string differences that already exist).
- [ ] **End-to-end smoke (with-vs-without rendering)** — for each of the three builder-prompts (SPIR, ASPIR, AIR), render the template twice against fixture issues: once with a `## Baked Decisions` section and once without. (Amended in iter-4: per the iter-3 unconditional-instruction design, both renders contain the instruction paragraph; the difference is only in the `{{issue.body}}` content, which carries the issue's own Baked Decisions section through verbatim when present.) Pass: both renders contain the top-level instruction `## Baked Decisions` block; the with-fixture render additionally contains the fixture's Baked Decisions content verbatim; the without-fixture render contains no fixture content.
- [ ] **No regression** — every static markdown file touched by this work (builder-prompts, drafting prompts, reviewer prompts, protocol.md) has a pre-change baseline captured; the post-change file is a pure-addition diff of the baseline (zero removed lines, zero modified lines). This is how no-regression maps to the architect-directed unconditional design: we no longer need a "no `## Baked Decisions` block when absent" assertion (that requirement only applied to the parser-based design); instead, we assert that nothing pre-existing was removed or mangled in any of the 30 touched files.

## Constraints

### Technical Constraints
- Issue body is the canonical input channel for AIR / BUGFIX / SPIR / ASPIR — anything we add must live in the rendered issue body (or in an equally durable channel that flows through `afx spawn`'s `--issue` path).
- Changes must be backward compatible: existing issues without the section must work unchanged.
- The mechanism must work regardless of how the issue was filed (GitHub UI, `gh issue create --body-file`, API). The section is plain markdown convention — discoverability comes from protocol documentation, not from GitHub templates (see Resolved Decision #2).
- Section name matching must be **heading-level-agnostic** (`##`, `###`, etc.) and case-insensitive on the text "Baked Decisions". Builder-prompt and consult-type prompt phrasing must not lock to a specific heading level.
- Builder-prompt and consult-type prompts are rendered Handlebars-style templates — additions must respect that toolchain.
- The protocol is meant to apply to SPIR, ASPIR, and AIR (not BUGFIX, which is too small for architectural priors).
- Prompt language must use the **architect-override carveout** framing (Resolved Decision #12): "do not autonomously override / relitigate baked decisions" rather than absolute prohibitions. The architect can always rescind.

### Business Constraints
- This is a tier-2 priority per Shannon's note — design carefully rather than rush.
- Must not add friction for the common case (no baked decisions). Optional-by-default is non-negotiable.

## Assumptions
- The issue body is the right surface for declaring baked decisions (vs. a separate file or a CLI flag). A documentation-only convention is sufficient because the Codev workflow is CLI-driven and architects file issues directly.
- Builders and CMAP reviewers will reliably honor an explicit instruction in their prompts to treat a section as fixed — i.e., we trust the prompt channel more than we trust prose conventions.
- Architects who don't have strong priors will simply omit the section; absence is the no-op default.
- The audience for "baked decisions" is **the spec drafter and CMAP reviewers** — not downstream consumers. We do not need a separate API or machine-readable schema.
- Documentation discoverability (a paragraph in each `protocol.md`) is sufficient — architects learn the convention by reading the protocol they are about to invoke.

## Solution Approaches

### Approach 1: Issue-Template + Reviewer Prompt Update (rejected in iter-3)
**Description**: Add an optional `## Baked Decisions` section to GitHub issue template(s) for SPIR / AIR / ASPIR plus the prompt edits.

**Pros**:
- Discoverability — architects filing via the GitHub UI see the section as a prompt.
- Single source of truth (the issue body).

**Cons** (decisive):
- GitHub issue templates only fire when filing via the web UI. Codev is CLI-driven (`gh issue create --body-file`, scripted issue filing, API integrations) and most issues are filed without ever touching the template.
- Maintenance surface: a template in `codev/.github/ISSUE_TEMPLATE/`, a mirror in `codev-skeleton/.github/ISSUE_TEMPLATE/`, downstream projects inheriting it on `codev init`. Each new mirror is a synchronization burden.
- Placeholder text in the rendered issue is noise when the architect has no baked decisions.

**Estimated Complexity**: Medium (mostly mirror-management)
**Risk Level**: Low
**Decision**: Rejected by architect in iter-3. Discoverability is better served by documentation in each `protocol.md` — architects read those when invoking the protocol.

### Approach 2: Pre-Spec Checklist Template (Option B from the issue)
**Description**: A separate one-pager template (e.g., `codev/templates/pre-spec.md`) that architects fill before filing the issue. The filled checklist is pasted verbatim into the issue body.

**Pros**:
- More rigorous — checklist forces the architect to consider each category.
- Useful as a thinking tool even when most fields are "TBD."

**Cons**:
- More ceremony — friction on every issue, not just the ones with baked decisions.
- Two-step workflow (fill template → paste into issue) is awkward.
- For issues with no baked decisions, the checklist is dead weight.

**Estimated Complexity**: Medium
**Risk Level**: Medium (adoption risk — architects skip it under pressure)
**Decision**: Not chosen.

### Approach 3: Prompt-Level Honoring + Protocol Documentation (Selected)
**Description**: Pure prompt-and-documentation change.
- Builder-prompts (SPIR / ASPIR / AIR) surface a `## Baked Decisions` block in the rendered prompt when the issue body contains a section with that name (heading-level-agnostic, case-insensitive).
- `prompts/specify.md` (SPIR / ASPIR) instructs the builder to write the section verbatim into the spec's Constraints section.
- `prompts/implement.md` (AIR) instructs the builder to treat the section as fixed during implementation.
- `consult-types/spec-review.md`, `plan-review.md`, `impl-review.md`, `pr-review.md` instruct reviewers to honor baked decisions and not autonomously override them.
- Each `protocol.md` (SPIR, ASPIR, AIR) gets a short paragraph documenting the convention and category hints (language / framework / deployment / dependencies).
- Mirror everything into `codev-skeleton/`.

**Pros**:
- Zero ceremony when not used — absence of the section is the no-op default.
- Single source of truth for the *mechanism* (prompts) and a single source of truth for *discoverability* (protocol docs).
- No GitHub-UI dependency — works for issues filed via CLI or API.
- Smallest maintenance surface that achieves the goal.
- Architect can amend or rescind a baked decision at any time (carveout framing per Decision #12).

**Cons**:
- Discoverability depends on architects reading the protocol doc — they have to learn the convention, not be prompted by template scaffolding.
- No machine-enforced schema — architects can write fuzzy or contradictory entries; reviewer prompts handle this by instructing to flag-and-pause.

**Estimated Complexity**: Low
**Risk Level**: Low

**Recommendation**: Approach 3.

## Open Questions

### Critical (Blocks Progress)

*(None remaining — scope and template location resolved above under Resolved Decisions.)*

### Important (Affects Design)

- [ ] **Should `afx spawn` warn at spawn time** if it detects "Baked Decisions" header in the issue but the section is empty? Lean: out of scope for this spec — keep the spec-side change pure prompt + documentation.

### Nice-to-Know (Optimization)
- [ ] Should the spec template (`codev/protocols/spir/templates/spec.md`) explicitly cross-reference baked decisions in its Constraints section header?
- [ ] Is there value in tooling that lints the baked-decisions section for common categories (language / framework / deployment) before spawning a builder?
- [ ] Should `consult` output flag if a reviewer's feedback contradicts a baked decision, so it can be visibly down-weighted in CMAP synthesis?

## Performance Requirements

Not applicable — this is a documentation / prompt-template change. No runtime or service-level performance concerns.

## Security Considerations

- No new authentication or authorization surface.
- The baked-decisions section is plain markdown inside the issue body — same trust boundary as today's issue content.
- One mild concern: a baked decision that includes a path or dependency name will flow verbatim into the builder-prompt and the CMAP reviewer prompts. This is the same trust posture as the rest of the issue body, so no new exposure.

## Test Scenarios

### Functional Tests

1. **Baked-decisions present (happy path)**
   - Fixture issue body includes `## Baked Decisions` with "Language: Python, Framework: FastAPI."
   - Render the SPIR builder-prompt.
   - Assertion: rendered prompt contains a dedicated `## Baked Decisions` block at the top level (not just embedded inside `{{issue.body}}`).
   - Render the spec-review consult-type prompt with a fixture spec that respects the constraint.
   - Assertion: rendered prompt contains the anti-relitigation instruction text verbatim.

2. **Baked-decisions absent (omitted) — snapshot diff**
   - Render the SPIR builder-prompt twice against the same fixture issue: once with a `## Baked Decisions` section, once without.
   - Assertion: the diff between the two outputs is non-empty and consists exclusively of the new `## Baked Decisions` block. No other lines change.
   - Snapshot test: the "without" render is byte-identical to a baseline recorded against today's templates.
   - Repeat for ASPIR and AIR.

3. **Baked-decisions partial**
   - Fixture issue body lists only language (Python) but no framework.
   - Render builder-prompt.
   - Assertion: language appears verbatim; no framework constraint is fabricated.

4. **Heading-level variation**
   - Three fixtures: `## Baked Decisions`, `### Baked Decisions`, `# Baked Decisions`.
   - Render builder-prompt for each.
   - Assertion: section is recognized in all three cases; rendered prompt surfaces the content correctly.

5. **Case insensitivity**
   - Fixture: `## baked decisions` (lowercase).
   - Assertion: section recognized and content surfaced.

6. **Contradictory entries within baked decisions**
   - Fixture: section contains "Language: Python" AND "Language: Node.js".
   - Render builder-prompt and consult-type prompts.
   - Assertion: both prompts contain instructions telling the builder/reviewer to flag the contradiction and pause, not silently pick.

7. **Conflict between baked decision and issue prose**
   - Fixture: prose says "consider Node and Python", baked says "Python".
   - Manual / transcript test: builder treats Python as fixed, prose as superseded.

8. **Plan-review honors baked decisions**
   - Fixture: spec with a Constraints section listing the baked decisions; plan that respects them.
   - Render plan-review prompt.
   - Assertion: prompt contains the anti-relitigation instruction language.

9. **AIR impl-review honors baked decisions**
    - Fixture: AIR issue with baked decisions; implementation respecting them.
    - Render impl-review prompt.
    - Assertion: anti-relitigation instruction present.

### Non-Functional Tests

- **No regression**: Existing SPIR / AIR / ASPIR projects without baked decisions complete as they do today. CMAP iteration counts on a representative set of recent issues do not increase. (Measurable by re-running CMAP on a previously-completed issue and checking the new feedback against the historical feedback.)

## Dependencies

- **External Services**: None.
- **Internal Systems** (every file in this list is a touchpoint that must be reviewed and most must be edited):
  - `codev/protocols/spir/builder-prompt.md`
  - `codev/protocols/aspir/builder-prompt.md`
  - `codev/protocols/air/builder-prompt.md`
  - `codev/protocols/spir/prompts/specify.md`
  - `codev/protocols/aspir/prompts/specify.md`
  - `codev/protocols/air/prompts/implement.md`
  - `codev/protocols/spir/consult-types/spec-review.md`
  - `codev/protocols/aspir/consult-types/spec-review.md`
  - `codev/protocols/spir/consult-types/plan-review.md`
  - `codev/protocols/aspir/consult-types/plan-review.md`
  - `codev/protocols/air/consult-types/impl-review.md`
  - `codev/protocols/air/consult-types/pr-review.md`
  - `codev/protocols/spir/protocol.md` (documentation paragraph — primary discoverability surface)
  - `codev/protocols/aspir/protocol.md` (documentation paragraph)
  - `codev/protocols/air/protocol.md` (documentation paragraph)
  - `codev-skeleton/` mirror copies of every file above
- **Explicitly NOT in scope**: `.github/ISSUE_TEMPLATE/` (rejected in iter-3 — see Resolved Decision #2).
- **Libraries/Frameworks**: None new. Existing Handlebars-style prompt rendering is sufficient.

## References

- Issue #746 (this spec's source)
- Shannon Spec 1353 (Persona harness) — the concrete failure case that motivated the issue
- `codev/protocols/spir/protocol.md` — SPIR protocol
- `codev/protocols/spir/consult-types/spec-review.md`, `plan-review.md` — CMAP reviewer prompts
- `codev/protocols/spir/builder-prompt.md` — Builder system prompt
- `codev-skeleton/protocols/...` — Mirror copies shipped to downstream projects

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|--------------------|
| Architects don't discover the convention | Medium | Medium | Documentation paragraph in each `protocol.md` is the discoverability surface; protocol docs are the first thing an architect reads when invoking a protocol. Future MAINTAIN can audit usage and surface examples. |
| Architects forget to use the section, reverting to status quo | Medium | Low | Same docs paragraph reminds them; CMAP iteration cost is its own incentive — architects who feel the pain of relitigation will adopt. |
| Builders / CMAP reviewers ignore the prompt instruction | Low–Medium | High | Explicit dedicated section in the rendered prompt; reviewer prompt repeats the instruction verbatim; phrasing puts the constraint at the top of the relevant section. |
| Baked decisions are wrong or premature | Medium | Medium | Architects can amend the issue and respawn; document this escape hatch in the protocol. The spec-approval gate is still the human checkpoint. Carveout framing (Decision #12) makes clear the architect can rescind. |
| Conflict between baked decisions and CMAP best-practice advice | Medium | Low | Reviewer prompt tells reviewers to flag concerns about a baked decision as a `COMMENT`, not as `REQUEST_CHANGES` — the architect makes the final call. |
| Heading-level mismatch (`##` vs `###` vs `#`) silently breaks recognition | Medium | High | Prompts instruct readers to match the section by *name*, not by heading level; success criteria require explicit fixtures covering all three levels. |
| Contradictory baked decisions cause silent failure | Low | Medium | Builder and reviewer prompts both instruct to flag and pause rather than guess. |
| Prompt language overshoots into absolute prohibition | Low | Medium | Decision #12 mandates "do not autonomously override" framing; reviewer of the implementation PR should verify this carveout is present in every prompt addition. |

## Expert Consultation

**Iteration 1 — 2026-05-14**: Reviewed by Gemini, Codex, Claude. Verdicts: Gemini `REQUEST_CHANGES`, Codex `REQUEST_CHANGES`, Claude `COMMENT`.

Key consolidated feedback addressed in iter-2:

- **Resolved scope** to SPIR + AIR + ASPIR explicitly (was a critical open question in iter-1).
- **Added heading-level-agnostic matching** to constraints and test scenarios (Gemini — real-world issues render at varying levels).
- **Added `prompts/specify.md` (SPIR + ASPIR) and `prompts/implement.md` (AIR) to Dependencies** (Claude — these are the prompts that actually drive spec drafting, distinct from builder-prompt).
- **Added explicit plan-review.md and AIR impl/pr-review.md changes** to Success Criteria (Gemini — existing "don't re-litigate" line is too generic to close the loophole).
- **Made Success Criteria deterministic** — every criterion now has a concrete pass signal (Codex).
- **Defined section-recognition contract**: heading text "Baked Decisions" (case-insensitive, any level), empty = no-op, with explicit rules for contradictions and conflicts with prose.
- **Clarified AIR has no `spec-review.md`** — the AIR touchpoints are builder-prompt + implement.md + impl-review.md + pr-review.md.

**Architect Feedback — 2026-05-17** (post iter-2 spec-approval gate):

- **Dropped `.github/ISSUE_TEMPLATE/` scope entirely.** Codev is CLI-driven; templates only fire for GitHub UI filing and add maintenance surface (codev/ + skeleton/ mirrors + downstream inheritance) for discoverability the CLI workflow doesn't need. Resolved Decision #2 rewritten; Success Criteria (issue template + skeleton template), Constraints, Test Scenario "Issue filed via CLI", and Risks rows trimmed.
- **Replaced with documentation.** Each `protocol.md` (SPIR / ASPIR / AIR) gets a discoverability paragraph. Resolved Decision #11 added; Success Criteria for documentation tightened to require category hints and the no-relitigation behavior to be explained.
- **Dropped the "one generic template vs per-protocol" open question** as moot.
- **Tightened the end-to-end transcript success criterion** to a concrete snapshot diff (with-section vs without-section render of each builder-prompt; the diff must consist exclusively of the new `## Baked Decisions` block).
- **Added Resolved Decision #12** (architect-override carveout) per the memory rule that prompt constraints on builders should be framed as "don't autonomously X" rather than "X is forbidden." All prompt edits this spec drives must use that framing; reviewer of the implementation PR should verify.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

- This spec deliberately stays at the WHAT level. The HOW — exact phrasing of the reviewer-prompt additions, exact documentation paragraph wording, the order in which files are edited — belongs in the plan.
- The Shannon failure case (Spec 1353) is the canonical example; the plan should include it as an end-to-end test scenario.
- Recommendation crystallized in **Approach 3 (prompt-level honoring + protocol documentation)** after architect feedback removed the issue-template scope. Low risk, low friction, smallest maintenance surface.
- The category hints (language / framework / deployment / dependencies / deferred decisions) live in the `protocol.md` documentation paragraph rather than in a template placeholder — same scaffolding, different surface.

---

## Amendments

### Amendment 1: Unconditional instruction paragraph (2026-05-17, iter-4)

**Summary**: Drop the conditional-rendering requirement from the builder-prompt success criteria. The instruction paragraph is unconditional.

**Problem addressed**: The original spec (iter-3) carried success criteria written against a parser-based design: *"When the section is absent or empty, the rendered prompt has no `## Baked Decisions` block (no empty stub)"*. When the architect's plan-approval feedback (2026-05-17 ~20:34 PDT) directed dropping the parser and replacing the `{{#if baked_decisions}}` block with *"a plain instruction paragraph (uniform across SPIR/ASPIR/AIR)"*, the plan was rewritten — but the spec text was not updated to match. Codex's PR-level CMAP review caught the resulting drift: the implementation (correctly per the architect's direction) puts the `## Baked Decisions` paragraph unconditionally in every builder-prompt render, but the spec text still required absence-of-block when the issue has no section.

**Rationale for the architect-directed design**: An unconditional instruction paragraph teaches the convention to every builder, every time, regardless of whether the current issue uses it. When the issue has no Baked Decisions section, the paragraph is a no-op (the builder reads the instruction, looks at the issue body, finds no section, and proceeds normally). When the issue does have one, the paragraph tells the builder to honor it. This is more robust than conditional rendering — it doesn't depend on a parser detecting the section correctly, and it discoverably documents the convention in every builder session.

**Spec changes**:
- **Success Criteria** — the "SPIR/ASPIR/AIR builder-prompt" criteria are reworded: instruction paragraph is unconditional and always present; the assertion is that the paragraph exists and that fixture content reaches the builder verbatim when present.
- **End-to-end smoke / No-regression criteria** — reworded to match: both with-fixture and without-fixture renders contain the instruction; the no-regression mechanism becomes "pure-addition diff against pre-change baselines" rather than "byte-identical when section absent".
- **Resolved Decisions #5** (empty section = no-op): still applies — but at the *builder-behavior* level, not at the *rendering* level. The builder sees the instruction; the absence of an issue-side Baked Decisions section means the instruction has nothing to act on.

**Plan changes**: None. The iter-3 plan already reflects the architect-directed design; this amendment brings the spec text into alignment with the plan that was approved and implemented.

**Implementation impact**: Zero. The committed implementation already matches the architect-directed unconditional design. The amendment is a documentation-side correction to remove the spec-vs-implementation drift Codex flagged.

<!-- TICK amendments to this specification go here in chronological order -->
