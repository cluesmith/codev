# Specification: Meta-specs as a first-class codev primitive

## Metadata
- **ID**: spec-2026-04-19-meta-specs
- **Status**: draft
- **Created**: 2026-04-19
- **Source Issue**: #683
- **Source Project**: Shannon (cross-workspace inbound feature request, 2026-04-19)

## Clarifying Questions Asked

The GitHub issue is unusually well-developed — it includes the problem statement, evidence from a 10-spec ASPIR cascade run on the Shannon project, a list of concrete drift-catches the pattern enabled, a properties list, directional sketches for framework support, explicit non-goals, and open questions. No clarification round is needed before drafting. Open questions raised by the issue are preserved and addressed in the "Open Questions" section below.

## Problem Statement

When an architect parallelizes a large structural change across many specs — the happy path for ASPIR — codev has no mechanism for **shared, authoritative design context** that transcends the individual spec. Each spec today is self-contained: vocabulary, canonical layouts, and cross-cutting invariants live *inside* the spec that happens to introduce them, or nowhere at all.

Consequences observed in the Shannon 10-spec cascade (2026-04-17/18, as documented in Issue #683):

1. **Parallel builders re-derive vocabulary and re-argue disambiguations.** Shannon had projects-vs-buckets, todos-vs-tasks, and memory-file taxonomy re-litigated inside individual specs before the meta-spec pattern was invented.
2. **Reviewers re-derive invariants instead of citing them.** Without a shared reference, every 3-way review has to re-argue why a rule matters from first principles.
3. **The architect becomes a human tie-breaker on every contradiction** between parallel specs — defeating the point of autonomous parallel work.
4. **Drift is detected late, at PR review**, rather than during spec authoring when it is cheap to fix.

Shannon's architect solved this by convention: hand-authored long design documents in `codev/architecture/` with named invariants (`§P1–P7`, `§2.1–2.5`), a "doc wins over diverging spec" rule, and `<!-- contract: ... -->` annotations linking invariants to enforcement tests. From those two documents, 10+ specs cascaded in parallel with review overhead collapsing dramatically — reviewers cited `§P6` when flagging drift instead of re-deriving the rule.

**Codev should make this a supported, named pattern rather than a convention each project reinvents.**

## Current State

Codev today recognizes three spec-level artifacts per feature:

| Artifact | Location | Lifetime | Shape |
|----------|----------|----------|-------|
| Spec | `codev/specs/####-name.md` | Per feature | WHAT + WHY for one change |
| Plan | `codev/plans/####-name.md` | Per feature | HOW + WHEN for one change |
| Review | `codev/reviews/####-name.md` | Per feature | Retrospective |

Cross-cutting architectural context has **no designated home**:

- `codev/resources/arch.md` exists but is an **ambient architecture snapshot** — updated during MAINTAIN, not authored as a cascade source. It has no section addressability, no "doc wins over spec" rule, no contract annotation convention, and no mechanism to declare which specs cascade from which sections.
- `codev/resources/lessons-learned.md` is retrospective — it captures what was learned, not what must hold going forward.
- Long design documents end up either (a) inline in the first spec that needs them, (b) in ad-hoc `codev/resources/*.md` files that no tooling understands, or (c) in the architect's head.

There is **no tooling** that:
- Recognizes a document as a "meta-spec" (vs. a resource, a spec, or an arch snapshot).
- Validates that a spec's declared meta-spec sections actually exist in the referenced doc.
- Inventories which architectural claims are enforced by contract tests vs. aspirational.
- Feeds cascaded meta-spec sections into a builder's context automatically.
- Tells reviewer bots that the meta-spec wins when a cascaded spec contradicts it.

Projects that need the pattern (Shannon, likely others) reinvent it from scratch, with no guarantee of consistency across projects.

## Desired State

Codev recognizes **meta-spec** as a first-class artifact with the following supported properties:

1. **Architect-authored, longer-lived than any single spec.** Meta-specs are human-written design documents, not AI-generated. They outlive individual specs and are updated in place rather than superseded wholesale.

2. **Named, addressable structure.** Each meta-spec has stable section identifiers (e.g., `§P1`, `§2.2`) so specs can point at *exact claims*, not just the doc as a whole. Section identifiers are part of the meta-spec's stable API surface.

3. **Standard location, discoverable by tooling.** Meta-specs live in `codev/architecture/`. A single command (e.g., `codev meta-specs list`) can enumerate them.

4. **Cascade source.** Individual specs declare which meta-spec sections they derive from via a standardized header convention. Builders load those sections into context automatically. Reviewers are told "the meta-spec wins."

5. **Tie-breaker.** When a cascaded spec contradicts its meta-spec, the meta-spec wins by default. The spec is updated, or escalated to the architect for an explicit meta-spec amendment.

6. **Contract surface.** Invariants in meta-spec prose can be tagged with machine-readable annotations linking them to enforcement tests:
   ```markdown
   Memory indices are thin.  <!-- contract: tests/contract/memory-indices.test.ts -->
   ```
   A single command inventories which claims are enforced (have annotations with existing test files) vs. aspirational.

7. **Amendment policy.** Each meta-spec declares how it evolves — who can amend, when, and how cascaded specs are re-validated when the meta-spec changes.

8. **Minimum viable integration with existing protocols.** SPIR/ASPIR builder prompts load cascaded meta-spec sections. Consultation reviewers are told about the "meta-spec wins" rule. `codev doctor` validates meta-spec references in specs.

**Critically, a meta-spec is NOT:**
- An AI-generated artifact (the authoring is a human job).
- A replacement for specs (specs describe *changes*; meta-specs describe *shared rules*).
- A rigid schema for the doc body (architects structure the doc as the domain demands).
- A lifecycle-managed object in the same sense as a spec (there is no "approve a meta-spec" gate analogous to spec-approval; meta-specs evolve continuously under architect control).

## Stakeholders

- **Primary Users**: Architects authoring cross-cutting design docs to drive parallel spec cascades (e.g., the Shannon architect who sent Issue #683).
- **Secondary Users**:
  - Builders (AI agents implementing cascaded specs) — consume meta-spec sections as authoritative context.
  - Reviewer bots (Gemini, Codex, Claude via `consult`) — cite meta-specs to flag drift without re-deriving rules.
  - Maintainers of downstream codev projects — get a pre-baked convention rather than reinventing one.
- **Technical Team**: Codev maintainers implementing tooling hooks (`codev doctor`, builder prompt templates, skeleton).
- **Business Owners**: Codev project architect (Waleed) has decision authority on scope and shape.

## Success Criteria

- [ ] `codev/architecture/` is a recognized standard location for meta-specs (documented in both `codev/` and `codev-skeleton/`).
- [ ] A meta-spec authoring template exists, structured around the five content areas: Principles, Disambiguations, Canonical Layout, Cascades-Into, Amendment Policy.
- [ ] A spec-header convention exists for declaring meta-spec references. Exact syntax TBD; candidates: `Meta-spec: codev/architecture/foo.md §P2, §7` in the spec body, or YAML frontmatter field. The convention is grep-friendly.
- [ ] A contract annotation convention exists: `<!-- contract: path/to/test.file[::test-name] -->` inline next to the claim it enforces.
- [ ] A single command inventories contract annotations across all meta-specs (e.g., `codev meta-specs contracts` or documented `grep` recipe), distinguishing enforced (annotation + existing test) from aspirational (annotation only) from unlinked prose.
- [ ] `codev doctor` validates meta-spec references in spec files: referenced doc exists, referenced sections exist in that doc.
- [ ] SPIR and ASPIR builder prompts load declared meta-spec sections into context when a cascaded spec is being implemented.
- [ ] SPIR and ASPIR consultation prompts include the "meta-spec wins" rule so reviewers flag drift by reference rather than re-deriving.
- [ ] Documentation updated: CLAUDE.md, AGENTS.md, cheatsheet, and a new `codev/resources/meta-specs-guide.md` explain the pattern.
- [ ] At least one canonical example meta-spec exists in the repo (can be a re-structuring of an existing ambient doc like `codev/resources/conceptual-model.md` or a fresh example; explicit decision required during planning).
- [ ] All tests pass, no regression in existing protocol execution.

## Constraints

### Technical Constraints

- **Must not break existing specs or plans.** Today, no spec declares a meta-spec reference; all existing specs must continue to validate under `codev doctor` without modification.
- **Must not require a new phase in SPIR/ASPIR.** Meta-specs sit above specs; they do not introduce a new phase to per-feature protocols.
- **Must work with existing porch state machine.** No protocol-schema changes should be required — meta-specs are an authoring-time and validation-time concept, not a runtime state-machine concept.
- **Section identifier format must be grep-friendly.** Reviewers, builders, and humans all need to be able to locate `§P6` in a meta-spec trivially. ASCII-only fallback (e.g., `#P6` or `[[P6]]`) should be supported alongside the `§` glyph to avoid Unicode normalization issues in some editors.
- **Contract annotation format must be grep-friendly and valid Markdown.** HTML comments (`<!-- contract: ... -->`) are the obvious choice — they render as nothing, survive Markdown processors, and are trivially grep-able.

### Design Constraints

- **Meta-specs are authored, not generated.** AI involvement is limited to *drafting assistance* on explicit request, not autonomous authoring. This is a non-goal explicitly called out in Issue #683.
- **Do not impose a body schema on meta-specs.** The template is a *suggestion*, not a validator. Architects structure their doc as the domain demands.
- **Lifecycle is optional and light.** Meta-specs do not have approval gates, iteration counters, or human-approval flags in YAML frontmatter the way specs/plans do. They are working documents, not governance artifacts.
- **Contract annotations are an opt-in convention**, not a mandatory feature. A meta-spec with zero contract annotations is still a valid meta-spec.
- **Dogfood it.** Codev should itself adopt meta-specs for a recurring pattern it re-derives across specs. Candidate: a `codev/architecture/protocol-authoring.md` meta-spec that captures the invariants shared across every new protocol (SPIR/ASPIR/AIR/BUGFIX/TICK). This validates the shape on a real use case *in this repo*.

### Business Constraints

- No external deadline. The Shannon architect is running on their own meta-spec pattern today; formalizing the pattern in codev benefits future cascades but does not block them.
- Scope should be kept minimal — ship the *convention and minimum tooling* first, defer optional polish (see Open Questions).

## Assumptions

- The Shannon pattern (as documented in Issue #683) is the design to emulate. No alternative patterns from other projects have been surfaced.
- Existing codev protocols (SPIR/ASPIR) are the consumption points. BUGFIX, AIR, EXPERIMENT, MAINTAIN, and SPIKE do not need cascade support — they are not used for large structural parallel changes.
- `consult` CLI prompts can be updated to include the "meta-spec wins" rule without a schema change (assumption to verify during planning).
- `codev doctor` is the right place for meta-spec-reference validation; no new top-level command is needed for the MVP.
- Porch's per-plan-phase builder prompts can interpolate meta-spec content via the existing Handlebars variable mechanism used by `builder-prompt.md` (to verify during planning).

## Solution Approaches

### Approach 1: Convention-only (lowest cost, lowest leverage)

**Description**: Add `codev/architecture/` as a documented standard location, publish a meta-spec authoring template, document the spec-header and contract-annotation conventions in `resources/meta-specs-guide.md`. **Do not** build tooling, builder-prompt hooks, or `codev doctor` validators.

**Pros**:
- Zero tooling surface. Fastest to ship.
- Downstream projects can adopt at their own pace.
- Preserves maximum flexibility — if the convention evolves, nothing has to be rewritten.

**Cons**:
- Does not solve the most valuable part of the problem: **automated context loading** into builder prompts and **automated drift detection** via `codev doctor`. Without these, meta-specs are just "conventions Shannon happened to invent."
- Shannon already has the convention. The value of codev formalizing the pattern is precisely in the tooling.
- Fails to dogfood — without `codev doctor` validation on this repo's own specs, the convention will drift here too.

**Estimated Complexity**: Low
**Risk Level**: Low (but also low value)

### Approach 2: Minimum Viable Tooling (RECOMMENDED)

**Description**: Approach 1 plus:
- `codev doctor` validates meta-spec references in spec bodies (referenced file exists, referenced sections exist).
- SPIR/ASPIR builder-prompt templates include a "meta-spec context" block. When a spec declares `Meta-spec:` headers, the cited sections are loaded into the builder's prompt.
- SPIR/ASPIR consultation prompts (for 3-way reviewers) include the "meta-spec wins" rule.
- A single grep-based command/recipe inventories contract annotations.
- Dogfood: author one meta-spec in this repo (e.g., `codev/architecture/protocol-authoring.md`) that documents invariants shared across all protocols, and retrofit at least one recent spec's header to reference it as a demonstration.

**Pros**:
- Delivers the core value: shared context reaches builders and reviewers automatically.
- Validates the pattern on this repo (dogfooding catches design bugs).
- Keeps new surface minimal: one doctor check, two prompt-template updates, one template, one guide.
- No changes to `protocol-schema.json`, no new porch phases, no new CLI subcommands beyond maybe one `codev meta-specs` helper.

**Cons**:
- Template and builder-prompt changes need to be tested end-to-end (spawn a real ASPIR builder against a spec with a meta-spec reference).
- Prompt-template changes are observability-poor — drift between the intent and what reviewers actually cite is hard to measure automatically.

**Estimated Complexity**: Medium
**Risk Level**: Low-Medium

### Approach 3: Full lifecycle (highest cost, speculative value)

**Description**: Approach 2 plus:
- A `codev meta-specs` CLI with `list`, `contracts`, `validate`, `amend` subcommands.
- Meta-spec lifecycle states (draft/approved/superseded) with YAML frontmatter.
- Automatic re-validation of cascaded specs when a meta-spec changes (surface in `codev doctor`).
- Meta-spec amendment protocol (analogous to TICK for specs).
- Integration with `codev/resources/arch.md` — meta-specs could replace it or co-exist.

**Pros**:
- Most powerful, most complete.
- Tracks meta-spec amendments and propagates them.
- Could retire `arch.md` entirely in favor of curated meta-specs.

**Cons**:
- Huge surface area. Lifecycle states, amendment protocol, and arch.md integration are each substantial features on their own. High risk of premature commitment to a shape that turns out to be wrong after a few months of real use.
- Issue #683 explicitly asks whether lifecycle states are needed as an open question. Committing to them now, before any project other than Shannon has used the feature, is premature.

**Estimated Complexity**: High
**Risk Level**: High (risk of over-engineering before we have real-world usage signal)

### Selected: Approach 2

Approach 2 delivers the core value (shared context reaches builders + reviewers, drift detected by `codev doctor`, pattern documented and templated) while preserving optionality on every speculative dimension from Issue #683's open questions (lifecycle states, amendment protocol, arch.md integration, cross-project contract tooling). If the pattern proves itself in-repo, a follow-up spec can promote selected elements of Approach 3.

## Open Questions

### Critical (Blocks Progress)

- [ ] **Spec-header convention exact syntax**: `Meta-spec: codev/architecture/foo.md §P2, §7` in the spec body (Shannon's choice), or YAML frontmatter field, or both? Decision needed before planning.
- [ ] **Section identifier format**: `§P6` (Shannon's choice — uses Unicode section glyph), or `#P6` (ASCII, HTML-anchor-compatible), or both accepted? Decision affects grep recipes and `codev doctor` validation regex.
- [ ] **Dogfood target**: Which existing cross-cutting concept in this repo (if any) should become the first in-repo meta-spec? Candidates: protocol-authoring invariants (shared across SPIR/ASPIR/AIR/BUGFIX/TICK), porch state-machine invariants, or build/release invariants. Alternatively: introduce no in-repo meta-spec and rely on an external example (weaker dogfooding).

### Important (Affects Design)

- [ ] **Lifecycle states**: Should meta-specs have draft/approved/superseded states? Issue #683 lists this as an open question. Proposed default for Approach 2: **no formal states**; if the architect wants to mark a doc as WIP, they write "Status: Draft" in the prose. Revisit after 3+ months of real use.
- [ ] **Cascade direction**: One-way (spec → meta-spec via `Meta-spec:` header) or bidirectional (meta-spec enumerates cascading children)? Proposed default for Approach 2: **one-way**. The meta-spec may optionally list specs that cascade from it as a human-readable section, but tooling relies on the spec-side header only. Spec-side is authoritative because specs are created and retired continuously while the meta-spec is long-lived.
- [ ] **Contract annotation scope**: Codev-wide convention, or project-local? Proposed default for Approach 2: **codev-wide convention** (documented in codev-skeleton), but the *enforcement surface* (which paths, which test frameworks) is project-local. The annotation format is standardized; the test path is free-form.
- [ ] **Builder prompt mechanism**: How exactly do cascaded meta-spec sections reach the builder? Options: (a) pre-expand them into the builder prompt at `afx spawn` time, (b) instruct the builder to read the file itself, (c) both. Needs prototype during planning.
- [ ] **`codev doctor` scope**: Should it validate *all* specs in the repo, or only specs for active/recent projects? Proposed default: validate all specs in `codev/specs/` but emit warnings rather than errors for existing specs that pre-date the convention.

### Nice-to-Know (Optimization)

- [ ] Relationship to `codev/resources/arch.md`: does arch.md become a curated meta-spec, or stay ambient? Likely a follow-up MAINTAIN-protocol project after meta-specs are in use.
- [ ] Relationship to `codev/resources/lessons-learned.md`: should recurring principles in lessons-learned graduate to meta-specs automatically? Likely no — graduation is a human call.
- [ ] Should meta-specs support cross-meta-spec references (one meta-spec cites another's section)? Defer.
- [ ] Should there be a way for a meta-spec to declare "this section supersedes section §X of meta-spec Y"? Defer.

## Performance Requirements

No runtime performance requirements — this is an authoring-time and CI-time feature. The only performance-adjacent concern is:

- `codev doctor` must not become appreciably slower after meta-spec validation is added. Budget: <100ms added to the doctor run for a repo with 10 meta-specs and 100 specs.

## Security Considerations

- Meta-spec references in specs are user-controlled paths. `codev doctor` must resolve them safely — no path traversal outside the repo, no following symlinks out of `codev/architecture/`.
- Contract annotations reference test file paths. Same path-traversal constraint applies if any tool executes or loads them.
- No authentication/authorization model — meta-specs are just Markdown files in the repo. Write access is gated by the repo's existing git permissions.

## Test Scenarios

### Functional Tests

1. **Meta-spec reference validation — happy path**: A spec declares `Meta-spec: codev/architecture/foo.md §P2`, the file exists, the section `§P2` exists in it. `codev doctor` passes silently.
2. **Meta-spec reference validation — missing file**: A spec references `codev/architecture/nonexistent.md`. `codev doctor` emits a clear error pointing at the spec and the missing path.
3. **Meta-spec reference validation — missing section**: A spec references `codev/architecture/foo.md §P99`, the file exists but `§P99` does not. `codev doctor` emits a clear error.
4. **Meta-spec reference validation — legacy spec**: A pre-existing spec with no `Meta-spec:` header is unaffected by `codev doctor` (no warning, no error).
5. **Contract annotation inventory**: Running the documented grep recipe on a meta-spec with 3 `<!-- contract: ... -->` annotations lists all 3 with their target test paths. Distinguishes existing test files from missing ones.
6. **Builder prompt loads cascaded sections**: Spawning a SPIR or ASPIR builder on a spec with a `Meta-spec:` header results in the cited sections appearing in the builder's context. Verified by inspecting the rendered prompt or by a test that checks the builder can cite `§P6` verbatim.
7. **Consultation reviewer cites meta-spec**: A 3-way review on a spec with a `Meta-spec:` header produces at least one reviewer output that cites the meta-spec by section when flagging an issue (if an issue exists). This is aspirational — hard to test deterministically; a manual verification pass during Review phase is acceptable.
8. **Dogfood meta-spec parses cleanly**: The in-repo example meta-spec (if added per the dogfood decision) passes whatever validator is added, and at least one existing or new spec successfully references it.

### Non-Functional Tests

1. **`codev doctor` performance**: Added validation cost is <100ms on this repo's current spec count.
2. **Documentation completeness**: `resources/meta-specs-guide.md` covers authoring, cascade references, contract annotations, and the amendment approach. Cross-linked from CLAUDE.md and AGENTS.md and the cheatsheet.
3. **Skeleton parity**: `codev-skeleton/` contains the same meta-spec guide, template, and `codev/architecture/` placeholder directory, so new projects installing codev get the pattern from day one.

## Dependencies

- **External Services**: None.
- **Internal Systems**:
  - `codev doctor` (source: `packages/codev-core` or wherever doctor lives — confirm during planning).
  - SPIR and ASPIR protocol `builder-prompt.md` templates in `codev-skeleton/protocols/`.
  - SPIR and ASPIR `consult-types/*.md` prompts.
  - Documentation surfaces: `CLAUDE.md`, `AGENTS.md`, `codev/resources/cheatsheet.md`.
- **Libraries/Frameworks**: None new. Reuse existing Handlebars/Markdown handling.

## References

- GitHub Issue #683: "Meta-specs as a first-class codev primitive" (full problem statement, Shannon evidence, directional sketches).
- Shannon project meta-specs (external, available on request per Issue #683):
  - `codev/architecture/state-and-memory.md` (sessions, state.json, reflection, tasks-vs-sessions).
  - `codev/architecture/entities-and-layout.md` (buckets, people, orgs, CLI family conventions).
- Shannon cascaded specs as evidence: 737, 738, 739, 740, 741, 742, 744, 746, 755, 759, 760, 761.
- Shannon Spec 734: "architecture-conformance contract tests" — origin of the `<!-- contract: ... -->` annotation convention.
- Existing codev artifacts that this pattern interacts with:
  - `codev/resources/arch.md` (ambient architecture snapshot, updated during MAINTAIN).
  - `codev/resources/lessons-learned.md` (retrospective principles).
  - `codev/protocols/*/protocol.md` (protocol definitions — candidate cascade source for a dogfood meta-spec on protocol-authoring invariants).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|---------------------|
| Section-identifier format (`§` vs `#`) picks the wrong default; downstream projects adopt inconsistent conventions. | Medium | Medium | Support both during MVP. Add a migration note in the guide. Let real-use signal pick the winner before locking in. |
| Builder-prompt context bloat — loading multiple cascaded sections inflates every builder prompt. | Medium | Low-Medium | Scope the loaded content to *only cited sections*, not the whole meta-spec. Measure prompt size before/after during planning. |
| Consultation reviewers do not actually cite meta-specs even when told to — the "meta-spec wins" rule becomes nominal. | Medium | Medium | Include a worked example in the consultation prompt showing a section citation. Spot-check during Review phase; revise prompt if citation rate is low. |
| `codev doctor` validator rejects legitimate existing specs, causing noise on every run. | Low | Medium | MVP: warn, don't error, on specs predating the convention. Only error on specs that *declare* a `Meta-spec:` header but reference invalid targets. |
| Meta-specs ossify — architects stop amending them because there is no amendment protocol. | Medium | Low (in MVP horizon) | Explicitly document "meta-specs evolve in place" in the guide. Revisit formal amendment protocol after 3+ months of real use. |
| Dogfood meta-spec gets out of date — architects edit protocols without updating the meta-spec. | Medium | Low | `codev doctor` catches spec-side drift (cited section missing). Meta-spec-side rot is a general doc-rot problem and not in scope to solve here. |
| Scope creep during planning into Approach 3 territory (lifecycle states, amendment protocols, arch.md retirement). | Medium | High (delays MVP) | Planning phase must explicitly defer these to follow-up specs. Track in Open Questions. |
| Contract annotation convention conflicts with some Markdown processor (e.g., an HTML-sanitizing one strips comments). | Low | Low | HTML comments are universally preserved by CommonMark-compliant processors. If a downstream project uses an aggressive sanitizer, that is their problem to configure. |

## Expert Consultation

To be completed after initial draft review. Consultation via `consult -m gemini --protocol spir --type spec`, `consult -m codex --protocol spir --type spec`, `consult -m claude --protocol spir --type spec` — in parallel.

## Approval

- [ ] Technical Lead Review (architect)
- [ ] Multi-agent consultation complete (Gemini 3 Pro, GPT-5 Codex, Claude)
- [ ] Human gate: `spec-approval`

## Notes

**Cross-workspace origin.** This spec originated as an inbound feature request from another codev-using project (Shannon). The Shannon architect sent the request via cross-workspace messaging on 2026-04-19 after running a 10-spec ASPIR cascade that validated the pattern. This is a useful signal for codev: features that emerge from actual downstream usage are higher-priority than speculative ones. Consider whether codev wants a lightweight channel for such inbound requests as a meta-observation (out of scope for this spec).

**Naming.** "Meta-spec" is borrowed from Shannon's internal vocabulary. Alternatives considered: "architecture doc" (collides with `arch.md`), "charter" (too governance-y), "invariants doc" (too narrow — the Shannon docs also carry taxonomies and canonical layouts). Meta-spec is retained.

**Authoring is human.** Worth re-emphasizing: this feature does not introduce an AI workflow to *generate* meta-specs. The value is in codev *recognizing* architect-authored meta-specs. AI can draft sections on request, but the architect owns the doc.

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
