# Specification: Baked Architectural Decisions in SPIR Issue Body

## Metadata
- **ID**: spec-2026-05-14-baked-decisions
- **Status**: draft (iter-2, post-CMAP)
- **Created**: 2026-05-14
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

The repo currently has **no** `.github/ISSUE_TEMPLATE/` directory (only `.github/workflows/`). Codev itself does not template its own issues today.

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

The following decisions were raised during drafting and CMAP review and are now considered settled in this spec:

1. **Scope: all three protocols.** SPIR, AIR, and ASPIR all suffer the same failure mode and must all honor baked decisions. ASPIR is identical to SPIR except for gates; it shares the same prompt assets. AIR skips the spec phase but its implement and PR review prompts still need to honor baked decisions surfaced through the issue body.

2. **Template location: both Codev (dogfood) and `codev-skeleton/` (downstream).** Codev does not currently ship an issue template for itself; this work adds one. The skeleton ships the same template so downstream projects benefit.

3. **Section heading format: heading-level-agnostic match on the name "Baked Decisions".** Prompts and instructions look for a section *named* "Baked Decisions" (case-insensitive), not for an exact `##` heading level. Real-world issue bodies render at varying heading levels (`##`, `###`); the match must tolerate that.

4. **Section identity = literal heading string.** The contract is: a heading whose text is "Baked Decisions" (any leading `#`s, any case) opens the section; the section ends at the next heading of equal-or-lesser depth or end of issue. No nested machine schema — content is free-form markdown.

5. **Empty section = no-op.** A section that is missing, present-but-empty, or contains only the placeholder text (the comment block from the template) is treated as absent. Behavior matches today's default — full exploration.

6. **Conflict between baked decisions and other issue prose**: baked decisions win. If the issue body says "we should consider both Node and Python" in prose and the baked section says "Python", the baked section is authoritative.

7. **Conflict within the baked decisions themselves** (e.g., two contradictory bullet points): builder must flag the contradiction to the architect (via `afx send architect`) and pause rather than guess. Reviewer prompts should also flag, not silently pick a winner.

8. **Conflict between a baked decision and the drafted spec**: reviewer flags the contradiction as a `REQUEST_CHANGES` against the *spec* (it failed to honor the constraint), not as an attempt to relitigate the decision.

9. **plan-review extension**: explicitly add an anti-relitigation instruction to `plan-review.md` mirroring the spec-review wording. The existing "don't re-litigate spec decisions" line is too generic; we want it explicit that baked decisions from the issue body are still off-limits even if the plan would benefit from changing them.

10. **AIR coverage**: AIR has no `spec-review.md` (it skips the spec phase). For AIR, the touchpoints are its `builder-prompt.md`, `prompts/implement.md`, and `consult-types/impl-review.md` + `consult-types/pr-review.md`. The instruction in AIR's prompts is "honor baked decisions from the issue body."

## Success Criteria

Each criterion has a concrete pass/fail signal so a builder can verify it without ambiguity.

- [ ] **Issue template exists** at `.github/ISSUE_TEMPLATE/` in the Codev repo with a `## Baked Decisions` section. Pass: file present; section header text matches "Baked Decisions"; comment-block placeholder explains category hints (language, framework, deployment, key dependencies, deferred decisions) and tells the architect to leave it blank for free exploration.
- [ ] **Skeleton parity** — the same template is shipped in `codev-skeleton/.github/ISSUE_TEMPLATE/` (or equivalent skeleton path determined by `codev init` / `codev adopt`). Pass: file present in skeleton; `codev init` of a fresh project produces the template at the project's `.github/ISSUE_TEMPLATE/`.
- [ ] **SPIR builder-prompt** surfaces baked decisions as a distinct, un-missable section in the rendered prompt. Pass: rendering the template with an issue that contains a "Baked Decisions" section produces a `## Baked Decisions` block at the top level of the rendered prompt (not buried inside `{{issue.body}}` only). When the section is absent or empty, the rendered prompt has no `## Baked Decisions` block (no empty stub).
- [ ] **ASPIR builder-prompt** behaves identically to SPIR's. Pass: same rendering test as above against ASPIR's template.
- [ ] **AIR builder-prompt** surfaces baked decisions identically. Pass: same rendering test against AIR's template.
- [ ] **SPIR `prompts/specify.md`** instructs the builder to read the baked-decisions section first and to write its content verbatim into the spec's Constraints section. Pass: grep the file for an explicit clause referencing "Baked Decisions" and Constraints.
- [ ] **ASPIR `prompts/specify.md`** has the same clause. Pass: grep.
- [ ] **AIR `prompts/implement.md`** has an analogous "honor baked decisions from the issue body" clause. Pass: grep.
- [ ] **SPIR `consult-types/spec-review.md`** contains a "do not relitigate baked decisions" instruction. Pass: grep for explicit phrasing covering the case where the spec respects a baked decision (reviewer should not push back on the underlying choice; only flag if the spec fails to honor the decision).
- [ ] **ASPIR `consult-types/spec-review.md`** has the same instruction. Pass: grep.
- [ ] **SPIR `consult-types/plan-review.md`** extends its existing anti-relitigation language to explicitly cover baked decisions. Pass: grep for explicit "baked decisions" language.
- [ ] **ASPIR `consult-types/plan-review.md`** has the same explicit phrasing. Pass: grep.
- [ ] **AIR `consult-types/impl-review.md`** has an analogous instruction. Pass: grep.
- [ ] **AIR `consult-types/pr-review.md`** has an analogous instruction. Pass: grep.
- [ ] **Skeleton mirror** — every file modified in `codev/protocols/` has the identical edit applied to its mirror in `codev-skeleton/protocols/`. Pass: `diff -r codev/protocols/ codev-skeleton/protocols/` shows no differences for the touched files (other than the project-specific paths that already differ).
- [ ] **End-to-end transcript test**: a fixture-based test that renders the SPIR builder-prompt with an issue body containing a Baked Decisions section, then runs a dry-render of the consult-type prompt against a sample spec that respects the constraint, and verifies (via assertion or saved transcript) that the rendered prompt would not request relitigation. Pass: the transcript is committed; assertions pass.
- [ ] **No regression**: existing builder-prompt / consult-prompt rendering against an issue body with no Baked Decisions section produces output byte-identical to today's. Pass: snapshot test or diff against a recorded baseline shows no change for the no-baked-decisions case.
- [ ] **Documentation updated**: `codev/protocols/spir/protocol.md` (and AIR / ASPIR equivalents) explains the feature, with one paragraph or short subsection. Pass: grep for the keyword "Baked Decisions" in each protocol.md.

## Constraints

### Technical Constraints
- Issue body is the canonical input channel for AIR / BUGFIX / SPIR / ASPIR — anything we add must live in the rendered issue body (or in an equally durable channel that flows through `afx spawn`'s `--issue` path).
- Changes must be backward compatible: existing issues without the section must work unchanged.
- The mechanism must work whether the issue was filed via GitHub UI (template-driven) or via `gh issue create --body-file` / API (no template enforcement). The section is plain markdown; CLI-filed issues can include it manually.
- Section name matching must be **heading-level-agnostic** (`##`, `###`, etc.) and case-insensitive on the text "Baked Decisions". Builder-prompt and consult-type prompt phrasing must not lock to a specific heading level.
- Builder-prompt and consult-type prompts are rendered Handlebars-style templates — additions must respect that toolchain.
- The protocol is meant to apply to SPIR, ASPIR, and AIR (not BUGFIX, which is too small for architectural priors).

### Business Constraints
- This is a tier-2 priority per Shannon's note — design carefully rather than rush.
- Must not add friction for the common case (no baked decisions). Optional-by-default is non-negotiable.

## Assumptions
- GitHub issue templates are the right surface for declaring baked decisions (vs. a separate file or a CLI flag).
- Builders and CMAP reviewers will reliably honor an explicit instruction in their prompts to treat a section as fixed — i.e., we trust the prompt channel more than we trust prose conventions.
- Architects who don't have strong priors will leave the section blank or delete it; the placeholder text is enough to communicate "leave blank if you want exploration."
- The audience for "baked decisions" is **the spec drafter and CMAP reviewers** — not downstream consumers. We do not need a separate API or machine-readable schema.

## Solution Approaches

### Approach 1: Optional Issue-Template Section + Reviewer Prompt Update (Option A from the issue)
**Description**: Add an optional `## Baked Decisions` section to the GitHub issue template(s) that feed SPIR / AIR / ASPIR. Placeholder text explains it is optional and lists the kinds of decisions that belong (language, framework, deployment shape, protocol, key dependencies). Update the SPIR builder-prompt to call out the section if non-empty. Update `spec-review.md` (and `plan-review.md` and AIR's impl/PR reviews) consult-type prompts to instruct reviewers to honor the listed decisions as fixed.

**Pros**:
- Lowest friction — section is optional, blank case is a no-op.
- Single source of truth (the issue body) — no new file types, no new CLI flags.
- Backward compatible — existing issues just don't have the section.
- Architect can fill it in 30 seconds when filing.

**Cons**:
- Relies on GitHub issue templates, which only fire when filing via the UI. CLI-filed issues need the architect to remember the section by convention.
- Builder might still under-weight the section if the prompt callout is too subtle.
- No machine-enforced schema — architects can write fuzzy or contradictory entries.

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Pre-Spec Checklist Template (Option B from the issue)
**Description**: A separate one-pager template (e.g., `codev/templates/pre-spec.md`) that architects fill before filing the issue. The filled checklist is pasted verbatim into the issue body. Forces architects to think through language, framework, deployment, key dependencies, and deferred decisions before they file.

**Pros**:
- More rigorous — checklist forces the architect to consider each category.
- Output is structured and parseable.
- Useful as a thinking tool even when most fields are "TBD."

**Cons**:
- More ceremony — friction on every issue, not just the ones with baked decisions.
- Two-step workflow (fill template → paste into issue) is awkward.
- For issues with no baked decisions, the checklist is dead weight.
- Risk of the checklist becoming a box-checking ritual that gets filled with "TBD" everywhere.

**Estimated Complexity**: Medium
**Risk Level**: Medium (adoption risk — architects skip it under pressure)

### Approach 3: Hybrid — Optional Section with Checklist Hints (Recommended)
**Description**: Approach 1 as the default mechanism (optional issue-template section), but enrich the placeholder text inside the section with the **categories** from Approach 2 (language, framework, deployment, key dependencies, deferred decisions). Architects who want lightweight use it as a free-form list; architects who want rigor use it as an inline checklist. Single channel, two usage patterns.

**Pros**:
- Preserves the zero-friction default of Approach 1.
- Lifts the cognitive scaffolding of Approach 2 into the inline placeholder without forcing a second file.
- One place to look (the issue body) for both styles of architect.
- Easy to adopt incrementally — the placeholder educates new users without blocking experienced ones.

**Cons**:
- Placeholder text gets longer, which can be noisy in the rendered issue if not deleted.
- Still no machine-enforced schema (consistent with the rest of Codev's prompt-driven discipline).

**Estimated Complexity**: Low
**Risk Level**: Low

**Recommendation**: Approach 3.

## Open Questions

### Critical (Blocks Progress)

*(None remaining — scope and template location resolved above under Resolved Decisions.)*

### Important (Affects Design)

- [ ] **Issue-template count**: One generic template covering all protocols, or one per protocol (SPIR / AIR / ASPIR / BUGFIX)? Lean: one generic template with a brief "Protocol" prefix field; details can be elaborated in plan.
- [ ] **Should `afx spawn` warn at spawn time** if it detects "Baked Decisions" header in the issue but the section is empty? Lean: out of scope for this spec — keep the spec-side change pure prompt/template.

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

2. **Baked-decisions absent (empty / omitted)**
   - Fixture issue body has no `## Baked Decisions` section.
   - Render the SPIR builder-prompt.
   - Assertion: rendered prompt has no `## Baked Decisions` block (no empty stub).
   - Snapshot test: render output is byte-identical to baseline recorded against today's templates.

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

8. **Issue filed via CLI (no template)**
   - Builder-prompt rendering for an issue body that was hand-authored with a "Baked Decisions" section produces the same result as a template-filed issue.

9. **Plan-review honors baked decisions**
   - Fixture: spec with a Constraints section listing the baked decisions; plan that respects them.
   - Render plan-review prompt.
   - Assertion: prompt contains the anti-relitigation instruction language.

10. **AIR impl-review honors baked decisions**
    - Fixture: AIR issue with baked decisions; implementation respecting them.
    - Render impl-review prompt.
    - Assertion: anti-relitigation instruction present.

### Non-Functional Tests

- **No regression**: Existing SPIR / AIR / ASPIR projects without baked decisions complete as they do today. CMAP iteration counts on a representative set of recent issues do not increase. (Measurable by re-running CMAP on a previously-completed issue and checking the new feedback against the historical feedback.)

## Dependencies

- **External Services**: GitHub Issue templates (rendered by GitHub's web UI).
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
  - `codev/protocols/spir/protocol.md` (documentation)
  - `codev/protocols/aspir/protocol.md` (documentation)
  - `codev/protocols/air/protocol.md` (documentation)
  - `.github/ISSUE_TEMPLATE/` (new directory, new template file)
  - `codev-skeleton/` mirror copies of every file above
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
| Architects forget to use the new section, reverting to status quo | Medium | Low | Template placeholder is self-explanatory; SPIR docs add a one-liner; future MAINTAIN can audit usage. |
| Builders / CMAP reviewers ignore the prompt instruction | Low–Medium | High | Explicit dedicated section in the rendered prompt; reviewer prompt repeats the instruction verbatim; phrasing puts the constraint at the top of the relevant section. |
| Baked decisions are wrong or premature | Medium | Medium | Architects can amend the issue and respawn; document this escape hatch in the protocol. The spec-approval gate is still the human checkpoint. |
| Section becomes a noisy boilerplate that everyone ignores | Low | Medium | Keep the section truly optional — empty placeholder = no-op, no warnings, no friction. |
| Conflict between baked decisions and CMAP best-practice advice | Medium | Low | Reviewer prompt tells reviewers to flag concerns about a baked decision as a `COMMENT`, not as `REQUEST_CHANGES` — the architect makes the final call. |
| Heading-level mismatch (`##` vs `###` vs `#`) silently breaks recognition | Medium | High | Prompts instruct readers to match the section by *name*, not by heading level; success criteria require explicit fixtures covering all three levels. |
| Contradictory baked decisions cause silent failure | Low | Medium | Builder and reviewer prompts both instruct to flag and pause rather than guess. |
| Issues filed via CLI bypass the template entirely | High | Low | Document the convention; the section being plain markdown means CLI-filed issues can still include it manually. |

## Expert Consultation

**Iteration 1 — 2026-05-14**: Reviewed by Gemini, Codex, Claude. Verdicts: Gemini `REQUEST_CHANGES`, Codex `REQUEST_CHANGES`, Claude `COMMENT`.

Key consolidated feedback addressed in this iter-2 update:

- **Resolved scope** to SPIR + AIR + ASPIR explicitly (was a critical open question in iter-1).
- **Resolved template location**: both Codev (dogfood) and `codev-skeleton/`.
- **Added heading-level-agnostic matching** to constraints and test scenarios (Gemini caught this — real-world issues render at varying levels).
- **Added `prompts/specify.md` (SPIR + ASPIR) and `prompts/implement.md` (AIR) to Dependencies** (Claude caught this — these are the prompts that actually drive spec drafting, distinct from builder-prompt).
- **Added explicit plan-review.md and AIR impl/pr-review.md changes** to Success Criteria (Gemini noted the existing "don't re-litigate" line is too generic to close the loophole).
- **Made Success Criteria deterministic** — every criterion now has a concrete pass signal (file exists, grep passes, snapshot matches) so a builder can self-verify (Codex caught this).
- **Defined section-recognition contract**: heading text "Baked Decisions" (case-insensitive, any level), empty = no-op, with explicit rules for contradictions and conflicts with prose.
- **Clarified AIR has no `spec-review.md`** — the AIR touchpoints are builder-prompt + implement.md + impl-review.md + pr-review.md.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

- This spec deliberately stays at the WHAT level. The HOW — exact placeholder wording, exact phrasing of the reviewer-prompt additions, the order in which files are edited — belongs in the plan.
- The Shannon failure case (Spec 1353) is the canonical example; the plan should include it as an end-to-end test scenario.
- Recommendation crystallized in **Approach 3 (hybrid)**: optional section with category hints inline. Low risk, low friction, immediate benefit when used.

---

## Amendments

<!-- TICK amendments to this specification go here in chronological order -->
