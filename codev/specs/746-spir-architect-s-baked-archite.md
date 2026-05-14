# Specification: Baked Architectural Decisions in SPIR Issue Body

## Metadata
- **ID**: spec-2026-05-14-baked-decisions
- **Status**: draft
- **Created**: 2026-05-14
- **GitHub Issue**: #746

## Clarifying Questions Asked

Issue #746 is a well-scoped feature request from the Shannon architect, filed 2026-05-14 with a concrete failure case (Spec 1353 Persona harness) and two candidate solution shapes (Option A: optional issue-template section; Option B: pre-spec checklist). Because the issue already articulates problem, cost, and design options, no additional clarifying questions were posed to the user before drafting this spec. Questions surfaced during drafting are tracked in **Open Questions** below.

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

The `spec-review.md` consult-type prompt (used by Codex / Gemini / Claude during CMAP) gives reviewers a generic mandate to evaluate completeness, correctness, feasibility, and clarity. There is no instruction to *honor* baked decisions or to skip relitigation of architect-fixed choices.

## Desired State

Architects have a **structured, optional channel** in the issue body to declare baked architectural decisions. When present:
1. The builder treats those decisions as **fixed inputs** to the spec — not options to explore.
2. CMAP reviewers are explicitly instructed to **not relitigate** the listed decisions; their job is to review the spec *given* those constraints.
3. The spec's "Constraints" section incorporates the baked decisions verbatim, so they remain visible through the full spec/plan/implement lifecycle.

When absent (the section is left blank or omitted), behavior is unchanged from today: the spec explores tradeoffs freely.

The expected outcome on the Shannon 1353 failure mode: if the architect had listed "Language: Python (match `shanutil`)" as a baked decision in the issue body, iter-1 would have drafted in Python, iter-2 CMAP would have left the language alone, and the 45-min reset would not have happened.

## Stakeholders

- **Primary Users**: Architects filing SPIR / AIR / ASPIR issues. They are the ones with the strong priors and the ones who pay the cost of relitigation.
- **Secondary Users**: Builders (autonomous AI agents) and CMAP reviewers (Codex / Gemini / Claude). They consume the baked decisions and must honor them.
- **Technical Team**: Codev maintainers. They own the issue templates, builder-prompts, and consult-type prompts that this spec touches.
- **Business Owners**: Codev project — Waleed Kadous.

## Success Criteria

- [ ] A baked-decisions section exists in the GitHub issue template(s) for SPIR-eligible work, with self-documenting placeholder text that explains when to use it and when to leave blank.
- [ ] The SPIR / AIR / ASPIR builder-prompts surface the baked decisions to the builder (either inline in the rendered prompt or via the existing `issue.body` channel with a callout the builder cannot miss).
- [ ] The `spec-review.md` consult-type prompt (and any equivalent for plan-review where decisions could leak) instructs reviewers to treat listed baked decisions as fixed and to flag — but not override — any concerns about them.
- [ ] When a builder encounters baked decisions in an issue, the spec it drafts includes those decisions verbatim in **Constraints**, and the spec's solution exploration is shaped accordingly.
- [ ] When baked decisions are absent or empty, builder/reviewer behavior is unchanged from today (zero-friction default).
- [ ] At least one end-to-end scenario test (or documented dry-run) demonstrates: baked decision present in issue → spec respects it → CMAP reviewer feedback does not relitigate it.
- [ ] Documentation in `codev/protocols/spir/protocol.md` (and AIR/ASPIR equivalents, if in scope) explains the feature and links to it from the architect-facing workflow docs.

## Constraints

### Technical Constraints
- Issue body is the canonical input channel for AIR / BUGFIX / SPIR / ASPIR — anything we add must live in the rendered issue body (or in an equally durable channel that flows through `afx spawn`'s `--issue` path).
- Changes must be backward compatible: existing issues without the section must work unchanged.
- The mechanism must work whether the issue was filed via GitHub UI (template-driven) or via `gh issue create --body-file` / API (no template enforcement).
- Builder-prompt and consult-type prompts are rendered Handlebars templates — additions must respect that toolchain.
- The protocol is meant to apply to SPIR primarily; AIR and ASPIR have lighter ceremony but the same risk profile, so the design must be cleanly portable.

### Business Constraints
- This is a tier-2 priority per Shannon's note — design carefully rather than rush.
- Must not add friction for the common case (no baked decisions). Optional-by-default is non-negotiable.

## Assumptions
- GitHub issue templates are the right surface for declaring baked decisions (vs. a separate file or a CLI flag).
- Builders and CMAP reviewers will reliably honor an explicit instruction in their prompts to treat a section as fixed — i.e., we trust the prompt channel more than we trust prose conventions.
- Architects who don't have strong priors will leave the section blank; the placeholder text is enough to communicate "leave blank if you want exploration."
- The audience for "baked decisions" is **the spec drafter and CMAP reviewers** — not downstream consumers. We do not need a separate API or machine-readable schema.

## Solution Approaches

### Approach 1: Optional Issue-Template Section + Reviewer Prompt Update (Option A from the issue)
**Description**: Add an optional `## Baked Decisions` section to the GitHub issue template(s) that feed SPIR / AIR / ASPIR. Placeholder text explains it is optional and lists the kinds of decisions that belong (language, framework, deployment shape, protocol, key dependencies). Update the SPIR builder-prompt to call out the section if non-empty. Update `spec-review.md` (and `plan-review.md` if needed) consult-type prompts to instruct reviewers to honor the listed decisions as fixed.

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
- [ ] **Scope**: Does this apply to SPIR only, or to AIR and ASPIR as well? The issue notes both as candidates. Lean: apply to all three, since the cost (relitigation) is the same shape.
- [ ] **Templates location**: Codev does not currently ship `.github/ISSUE_TEMPLATE/` for itself (verified — `.github/` only contains `workflows/`). Are we adding templates to the Codev repo for itself, or are we adding the baked-decisions instruction to `codev-skeleton/` so downstream projects pick it up? Lean: both — Codev should dogfood its own template, and the skeleton should ship it so adopters benefit.

### Important (Affects Design)
- [ ] **Builder-prompt placement**: Should the baked decisions appear as a distinct section in the rendered builder-prompt (`## Baked Decisions`), or should we trust the `{{issue.body}}` channel and add a one-liner reminder ("if the issue lists baked decisions, treat them as fixed")? Lean: explicit section — the whole point is to make them un-missable.
- [ ] **Plan-review scope**: Do baked decisions also need to be honored at plan-review time, or is spec-review the only checkpoint where relitigation hurts? Lean: spec-review is the primary surface, but plan-review should at least not contradict the spec's Constraints section.
- [ ] **Section name**: "Baked Decisions" vs. "Fixed Decisions" vs. "Architectural Givens" vs. "Decisions Not to Reconsider." The issue uses "Baked decisions"; keeping that terminology aids continuity.

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
   - Filed issue includes `## Baked Decisions` with "Language: Python, Framework: FastAPI."
   - Spawn a SPIR builder.
   - The builder's rendered prompt surfaces the baked decisions distinctly.
   - The spec drafted by the builder lists those decisions in its Constraints section.
   - The CMAP reviewer prompts include the instruction to honor baked decisions.
   - CMAP feedback does not propose Node, JS, Express, or any alternative to the listed language/framework.

2. **Baked-decisions absent (empty / omitted)**
   - Filed issue has no `## Baked Decisions` section, or the section is present but empty.
   - Builder behavior is identical to today — explores tradeoffs freely.
   - CMAP feedback is identical to today.

3. **Baked-decisions partial**
   - Filed issue lists only language (Python) but no framework.
   - Spec respects the language constraint; framework is free for exploration.
   - CMAP feedback does not push back on the language but can propose framework alternatives.

4. **Baked-decisions in conflict with spec content**
   - If a builder drafts a spec that contradicts a baked decision, CMAP reviewers should flag the contradiction (decision vs. spec text), not propose to overturn the decision.

5. **Issue filed via CLI (no template)**
   - Architect runs `gh issue create --body-file` or types the body directly.
   - If they include the `## Baked Decisions` section by convention, it is honored.
   - If they don't, behavior is unchanged from today.

### Non-Functional Tests

- **No regression**: Existing SPIR / AIR / ASPIR projects without baked decisions complete as they do today; CMAP iteration counts on representative existing issues don't increase.

## Dependencies

- **External Services**: GitHub Issue templates (rendered by GitHub's web UI).
- **Internal Systems**:
  - `codev/protocols/spir/builder-prompt.md` (and AIR / ASPIR equivalents)
  - `codev/protocols/spir/consult-types/spec-review.md` (and possibly `plan-review.md`)
  - `codev-skeleton/` mirror copies of the above
  - The `afx spawn` issue-fetch path (`packages/codev/src/agent-farm/commands/spawn.ts` and friends) — needs no change if we route through the existing `{{issue.body}}` channel.
- **Libraries/Frameworks**: None new. Existing Handlebars-style prompt rendering is sufficient.

## References

- Issue #746 (this spec's source)
- Shannon Spec 1353 (Persona harness) — the concrete failure case that motivated the issue
- `codev/protocols/spir/protocol.md` — SPIR protocol
- `codev/protocols/spir/consult-types/spec-review.md` — CMAP reviewer prompt
- `codev/protocols/spir/builder-prompt.md` — Builder system prompt
- `codev-skeleton/protocols/spir/...` — Mirror copies shipped to downstream projects

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|--------------------|
| Architects forget to use the new section, reverting to status quo | Medium | Low | Template placeholder is self-explanatory; SPIR docs add a one-liner; future MAINTAIN can audit usage. |
| Builders / CMAP reviewers ignore the prompt instruction | Low–Medium | High | Explicit dedicated section in the rendered prompt; reviewer prompt repeats the instruction verbatim; phrasing puts the constraint at the top of the relevant section. |
| Baked decisions are wrong or premature | Medium | Medium | Architects can amend the issue and respawn; document this escape hatch in the protocol. The spec-approval gate is still the human checkpoint. |
| Section becomes a noisy boilerplate that everyone ignores | Low | Medium | Keep the section truly optional — empty placeholder = no-op, no warnings, no friction. |
| Conflict between baked decisions and CMAP best-practice advice | Medium | Low | Reviewer prompt tells reviewers to flag concerns about a baked decision as a comment, not as REQUEST_CHANGES — the architect makes the final call. |
| Issues filed via CLI bypass the template entirely | High | Low | Document the convention; the section being plain markdown means CLI-filed issues can still include it manually. |

## Expert Consultation

To be filled after the first CMAP cycle (Gemini / Codex / Claude).

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

- This spec deliberately stays at the WHAT level. The HOW — exact placeholder wording, exact phrasing of the reviewer-prompt addition, which protocols get the change in which order — belongs in the plan.
- The Shannon failure case (Spec 1353) is the canonical example; the plan should include it as an end-to-end test scenario.
- Recommendation crystallized in **Approach 3 (hybrid)**: optional section with category hints inline. Low risk, low friction, immediate benefit when used.

---

## Amendments

<!-- TICK amendments to this specification go here in chronological order -->
