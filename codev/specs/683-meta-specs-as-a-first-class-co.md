# Specification: Meta-specs as a first-class codev primitive

## Metadata
- **ID**: spec-2026-04-19-meta-specs
- **Status**: draft
- **Created**: 2026-04-19
- **Source Issue**: #683
- **Source Project**: Shannon (cross-workspace inbound feature request, 2026-04-19)

## Clarifying Questions Asked

The GitHub issue is unusually well-developed — it includes the problem statement, evidence from a 10-spec ASPIR cascade run on the Shannon project, a list of concrete drift-catches the pattern enabled, a properties list, directional sketches for framework support, explicit non-goals, and open questions. No clarification round with the source architect is needed before drafting.

After multi-agent consultation (Gemini 3 Pro, GPT-5 Codex, Claude), a set of MVP design decisions that the initial draft left open have been committed to. They are recorded under "Resolved Design Decisions" below. The Issue #683 open questions that remain genuinely open (deferred scope rather than undefined MVP behavior) are in "Open Questions".

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

3. **Standard location, discoverable by tooling.** Meta-specs live in `codev/architecture/`.

4. **Cascade source.** Individual specs declare which meta-spec sections they derive from via a standardized YAML frontmatter field. Builders load the cited sections into context automatically. Reviewers are told "the meta-spec wins" and are instructed to read cited sections before flagging issues.

5. **Tie-breaker.** When a cascaded spec contradicts its meta-spec, the meta-spec wins by default. The spec is updated, or escalated to the architect for an explicit meta-spec amendment.

6. **Contract surface.** Invariants in meta-spec prose can be tagged with machine-readable annotations linking them to enforcement tests:
   ```markdown
   Memory indices are thin.  <!-- contract: tests/contract/memory-indices.test.ts -->
   ```
   A documented grep-based recipe inventories annotated claims, distinguishing those whose target test file exists ("enforced") from those whose target is missing ("aspirational"). Un-annotated prose is out of scope for MVP inventory.

7. **Minimum viable integration with existing protocols.** SPIR/ASPIR builder prompts load cascaded meta-spec sections. Consultation prompts include the "meta-spec wins" rule and explicitly instruct reviewers to read cited sections. `codev doctor` validates meta-spec references in specs.

**Critically, a meta-spec is NOT:**
- An AI-generated artifact (the authoring is a human job).
- A replacement for specs (specs describe *changes*; meta-specs describe *shared rules*).
- A rigid schema for the doc body (architects structure the doc as the domain demands).
- A lifecycle-managed object in the same sense as a spec (there is no "approve a meta-spec" gate analogous to spec-approval; meta-specs evolve continuously under architect control).

## Resolved Design Decisions (MVP)

These items were left open in the initial draft and have been decided after consultation feedback.

### D1. Spec-side reference syntax — YAML frontmatter

Specs declare meta-spec references in YAML frontmatter, **not** inline body text.

```yaml
---
meta_specs:
  - path: codev/architecture/protocol-authoring.md
    sections: [P2, P7]
  - path: codev/architecture/state-and-memory.md
    sections: [2.1]
---
```

**Rationale**: Frontmatter is parsed once with a standard YAML parser; inline body regex is brittle and produces more validator false-positives. Specs already use YAML frontmatter for `approved:` and `validated:` fields, so this extends an established convention. Gemini flagged this as the clearly safer choice; Codex asked for a single committed syntax.

Section identifiers in the `sections` array are written without the `§` prefix. Validation code normalizes the identifier (matches `P2`, `§P2`, and `[[P2]]` all as the same section ID in the referenced doc).

### D2. Section identifier format — `§P6` primary, `[[P6]]` ASCII fallback

Meta-spec authors mark sections with either `§P6` (preferred Unicode form) or `[[P6]]` (ASCII fallback) at the start of a section heading. Both forms are recognized by the validator and extractor. **`#P6` is not accepted** — it collides with Markdown heading syntax and GitHub issue references (both Gemini and Claude flagged this).

Example meta-spec heading forms (any of these define section `P6`):
```markdown
## §P6. Memory indices are thin
## [[P6]] Memory indices are thin
### §P6 Principle: indices never duplicate payload
```

The identifier must appear within the first 80 characters of a `##` or `###` heading line.

### D3. Section extraction boundary

A cited section's content extends from the heading line containing the identifier to **the next Markdown heading of the same or higher level, or end-of-file**, whichever comes first. The heading line itself is included in the extracted content. Sub-headings (of strictly lower level) are included recursively.

Example: `## §P6 …` includes everything until the next `##` or `#`. `### §P6 …` includes everything until the next `###`, `##`, or `#`.

Both Codex and Gemini flagged that without this rule, "load only cited sections" is undefined.

### D4. Section identifier API-surface note

Section IDs are a stable API surface. Renaming `§P6` to `§P7` is a breaking change to every spec that cites it. The authoring template and guide must document this rule, and recommend appending new IDs rather than renumbering.

### D5. Validator placement — extend `checkCodevStructure()` in `doctor.ts`

`codev doctor` already validates repo structure via `packages/codev/src/commands/doctor.ts::checkCodevStructure()` (it checks for deprecated `roles/review-types/` and missing git remotes). Meta-spec reference validation extends this existing function. No new top-level `codev` subcommand in MVP.

**Error severity rules:**

| Case | `codev doctor` behavior |
|------|-------------------------|
| Spec with no `meta_specs` frontmatter field | Silent (legacy specs are unaffected) |
| Spec with `meta_specs` referencing a missing file | **Error** (doctor exits non-zero) |
| Spec with `meta_specs` referencing a missing section in an existing file | **Error** |
| Spec with a malformed `meta_specs` YAML structure | **Error** |
| Meta-spec with a `<!-- contract: ... -->` annotation whose target test file is missing | **Warning** (not an error in MVP; future flag may upgrade) |

Gemini worried doctor was "system deps only"; that is not quite right — `checkCodevStructure()` already exists and is the established pattern for structural validation. Codex verified this; Claude verified this. The scope concern is still worth honoring by making the new checks opt-outable via a future flag if the rule set expands.

### D6. Contract inventory — grep recipe in MVP, no new subcommand

The MVP ships a documented grep recipe (and a `Makefile`/npm-script target if trivial) that lists contract annotations, flagging those whose target file does not exist. No `codev meta-specs contracts` subcommand in MVP — can be promoted in a follow-up.

### D7. Builder-prompt injection mechanism — pre-expand at spawn time

`afx spawn` (specifically the `TemplateContext` built by `packages/codev/src/agent-farm/commands/spawn-roles.ts`) is extended with a `meta_spec_context` string field. When a spec declares `meta_specs:` in frontmatter, the spawn code reads and extracts the cited sections per §D3 and concatenates them into a single pre-rendered string. The builder prompt template adds a block:

```markdown
{{#if meta_spec_context}}
## Meta-Spec Context (authoritative)

The following excerpts are from meta-specs this spec cascades from. When the spec and a meta-spec disagree, **the meta-spec wins**.

{{meta_spec_context}}
{{/if}}
```

**Rationale**: The codev template renderer is a simplified custom implementation (Claude identified this — it supports `{{variable}}` and `{{#if}}` but not `{{#each}}`). Pre-expansion into a single string works with the current renderer without extending it.

### D8. Consultation prompt changes — inject content, don't rely on reviewer file-reads

SPIR/ASPIR consult-type prompts (`consult-types/spec.md`, `consult-types/plan.md`, `consult-types/impl.md`, etc.) are updated to:

(a) State the "meta-spec wins" rule explicitly.
(b) **Include the same extracted meta-spec sections** as a "Meta-Spec Context" block when the artifact being reviewed is a cascaded spec. This mirrors the builder prompt — reviewers do not have to autonomously fetch files.
(c) Provide a worked citation example (e.g., "If the spec disagrees with `state-and-memory.md §P6`, flag it and cite the section.").

Gemini pointed out that reviewers will not spontaneously fetch files; the MVP therefore injects the content, just like the builder prompt.

### D9. Dogfood target — `codev/architecture/protocol-authoring.md`

The in-repo canonical example meta-spec is **`codev/architecture/protocol-authoring.md`**, capturing invariants shared across every codev protocol definition (SPIR/ASPIR/AIR/BUGFIX/TICK/EXPERIMENT/MAINTAIN). Candidate sections:

- `§P1` — Every protocol has an `input.type` (`spec`, `github-issue`, or `none`).
- `§P2` — Every protocol ends with a `pr` gate.
- `§P3` — Human-gate protocols list their gates in `protocol.json`.
- `§P4` — Per-phase build/verify structure is consistent across protocols.
- `§P5` — Protocol documents live in `codev-skeleton/protocols/<name>/protocol.md` and `codev/protocols/<name>/protocol.md`.

(The exact invariants are an authoring task during implementation, not a spec-level decision.)

One existing recent spec (candidate: this spec, #683, or a recent ASPIR spec retrofitted in the Review phase) will declare a `meta_specs:` frontmatter reference to demonstrate the end-to-end flow.

### D10. Cascade direction — one-way (spec → meta-spec)

Tooling uses the spec-side `meta_specs:` declaration only. A meta-spec MAY list cascading children as human-readable prose for architect convenience, but no tool depends on it. Spec-side is authoritative because specs churn far faster than meta-specs.

### D11. Contract annotation scope — codev-wide convention, project-local enforcement

The annotation format (`<!-- contract: <path>[::<name>] -->`) is standardized and documented in codev-skeleton. The contained `<path>` is free-form — each project points at its own test files with its own conventions. No test framework is imposed.

### D12. `codev doctor` scope — all specs in `codev/specs/`

The new validator runs over all files matching `codev/specs/*.md`, not only active project specs. Specs without `meta_specs:` frontmatter are silent (per D5). Performance budget: <100ms added cost on a repo with 10 meta-specs and 100 specs.

## Stakeholders

- **Primary Users**: Architects authoring cross-cutting design docs to drive parallel spec cascades (e.g., the Shannon architect who sent Issue #683).
- **Secondary Users**:
  - Builders (AI agents implementing cascaded specs) — consume meta-spec sections as authoritative context.
  - Reviewer bots (Gemini, Codex, Claude via `consult`) — cite meta-specs to flag drift without re-deriving rules.
  - Maintainers of downstream codev projects — get a pre-baked convention rather than reinventing one.
- **Technical Team**: Codev maintainers implementing tooling hooks (`codev doctor`, builder prompt templates, skeleton).
- **Business Owners**: Codev project architect (Waleed) has decision authority on scope and shape.

## Success Criteria

- [ ] `codev/architecture/` is a recognized standard location for meta-specs, documented in `codev/` and present in `codev-skeleton/` as a directory containing a non-empty README stub pointing at the guide (addresses Codex's skeleton parity concern).
- [ ] A meta-spec authoring template exists at `codev-skeleton/templates/meta-spec.md`, structured around: Principles, Disambiguations, Canonical Layout, Cascades-Into, Amendment Policy.
- [ ] Spec frontmatter convention: `meta_specs:` field per D1, with validator support.
- [ ] Section identifier format: `§P6` or `[[P6]]` per D2, with extraction boundary per D3, documented in the guide.
- [ ] Contract annotation convention (`<!-- contract: path[::name] -->`) documented and demonstrated.
- [ ] Documented grep recipe (or `Makefile`/npm-script target) that inventories contract annotations across `codev/architecture/` and flags annotations whose target file is missing (per D6).
- [ ] `codev doctor` (via extended `checkCodevStructure()`) validates `meta_specs:` references per the error-severity table in D5.
- [ ] SPIR and ASPIR builder-prompt templates include a `Meta-Spec Context` block populated at spawn time per D7.
- [ ] SPIR and ASPIR consultation prompts (`consult-types/*.md` for spec, plan, and impl types) include the "meta-spec wins" rule, a worked citation example, and the injected `Meta-Spec Context` block per D8.
- [ ] `codev/architecture/protocol-authoring.md` exists in-repo as the dogfood meta-spec per D9, with at least one spec that declares it in `meta_specs:` frontmatter.
- [ ] `codev/resources/meta-specs-guide.md` covers authoring, cascade references, contract annotations, amendment approach, and the "section identifier stability" rule (D4). Deletion/rename of a meta-spec is covered (doctor catches it; guide documents the migration flow — Claude's suggestion).
- [ ] CLAUDE.md, AGENTS.md, and `codev/resources/cheatsheet.md` link to the new guide.
- [ ] Unit tests cover: frontmatter parsing, reference validation (happy / missing file / missing section / legacy spec), section extraction boundary, and contract-inventory recipe behavior.
- [ ] End-to-end test: spawning a SPIR or ASPIR builder on a spec with `meta_specs:` frontmatter results in the cited sections appearing in the rendered builder prompt (asserted by existing test harness, e.g., alongside `bugfix-619-aspir-prompt.test.ts`).
- [ ] All existing tests pass, no regression in protocol execution.

## Constraints

### Technical Constraints

- **Must not break existing specs or plans.** No existing spec declares `meta_specs:`; all existing specs must continue to validate under `codev doctor` silently.
- **Must not require a new phase in SPIR/ASPIR.** Meta-specs sit above specs; they do not introduce a new phase to per-feature protocols.
- **Must work with existing porch state machine.** No `protocol-schema.json` changes.
- **Template engine is a simplified custom renderer**, not Handlebars (`packages/codev/src/agent-farm/commands/spawn-roles.ts::renderTemplate()`). It supports `{{variable}}` and `{{#if condition}}...{{/if}}` but not `{{#each}}`, helpers, or partials. Pre-expansion of meta-spec context into a single string works with this (per D7).
- **Section identifier format must be grep-friendly.** `§` as Unicode glyph or `[[P6]]` as ASCII fallback. Not `#P6`.
- **Contract annotation format must be grep-friendly and valid Markdown.** HTML comments survive all CommonMark-compliant processors.

### Design Constraints

- **Meta-specs are authored, not generated.** AI involvement is limited to *drafting assistance* on explicit request.
- **Do not impose a body schema on meta-specs.** The template is a suggestion, not a validator. Only the section-heading form (per D2) is mechanically enforced.
- **Lifecycle is optional and light.** Meta-specs do not have approval gates, iteration counters, or `approved:` frontmatter like specs/plans.
- **Contract annotations are an opt-in convention.** A meta-spec with zero annotations is still valid.
- **Dogfood it.** `codev/architecture/protocol-authoring.md` is in scope for this project per D9.

### Business Constraints

- No external deadline.
- Scope kept minimal — ship the convention and minimum tooling; defer Approach-3 polish.

## Assumptions

- The Shannon pattern (as documented in Issue #683) is the design to emulate. No alternative patterns from other projects have been surfaced.
- Existing codev protocols (SPIR/ASPIR) are the consumption points. BUGFIX, AIR, EXPERIMENT, MAINTAIN, and SPIKE do not need cascade support.
- `consult-types/*.md` prompts can be updated to inject the Meta-Spec Context block via the same pre-expansion mechanism used for builder prompts (to verify in planning).
- `checkCodevStructure()` in `doctor.ts` is the right extension point (verified during consultation; both Codex and Claude confirmed).

## Solution Approaches

### Approach 1: Convention-only (lowest cost, lowest leverage)

**Description**: Add `codev/architecture/` as a documented standard location, publish an authoring template, document the spec-frontmatter and contract-annotation conventions. **Do not** build tooling, builder-prompt hooks, or `codev doctor` validators.

**Pros**:
- Zero tooling surface. Fastest to ship.
- Downstream projects can adopt at their own pace.

**Cons**:
- Does not solve the most valuable part of the problem: **automated context loading** into builder prompts and **automated drift detection** via `codev doctor`.
- Shannon already has the convention. The value of codev formalizing the pattern is precisely in the tooling.
- Fails to dogfood — without `codev doctor` validation on this repo's own specs, the convention drifts here too.

**Estimated Complexity**: Low
**Risk Level**: Low (but also low value)

### Approach 2: Minimum Viable Tooling (SELECTED)

**Description**: Approach 1 plus the scope defined by D1–D12. Specifically:
- `doctor.ts::checkCodevStructure()` validates `meta_specs:` frontmatter references.
- SPIR/ASPIR builder-prompt templates include a `Meta-Spec Context` block populated via pre-expansion at `afx spawn` time (D7).
- SPIR/ASPIR consultation prompts inject the same `Meta-Spec Context` block and include the "meta-spec wins" rule with a worked citation example (D8).
- Documented grep recipe for contract inventory (D6).
- Dogfood: `codev/architecture/protocol-authoring.md` plus at least one spec retrofitted with `meta_specs:` frontmatter (D9).

**Pros**:
- Delivers the core value: shared context reaches builders and reviewers automatically; drift caught by doctor.
- Validates the pattern on this repo (dogfooding catches design bugs).
- No protocol-schema changes, no new porch phases, no new top-level CLI subcommands.

**Cons**:
- Template and builder-prompt changes need end-to-end verification (spawn a real ASPIR builder against a spec with `meta_specs:`).
- Reviewer-citation quality is observability-poor — drift between "told to cite" and "actually cites" is hard to measure automatically.

**Estimated Complexity**: Medium
**Risk Level**: Low-Medium

### Approach 3: Full lifecycle (highest cost, speculative value)

**Description**: Approach 2 plus:
- A `codev meta-specs` CLI with `list`, `contracts`, `validate`, `amend` subcommands.
- Meta-spec lifecycle states (draft/approved/superseded) in YAML frontmatter.
- Automatic re-validation of cascaded specs when a meta-spec changes.
- Meta-spec amendment protocol (analogous to TICK for specs).
- Integration with `codev/resources/arch.md` — meta-specs replace or subsume it.

**Pros**:
- Most powerful, most complete.

**Cons**:
- Huge surface area. High risk of premature commitment to a shape that turns out to be wrong after a few months of real use.
- Issue #683 explicitly lists lifecycle states as an open question.

**Estimated Complexity**: High
**Risk Level**: High.

### Selected: Approach 2

Approach 2 delivers the core value while preserving optionality on every speculative dimension. If the pattern proves itself in-repo, a follow-up spec can promote selected elements of Approach 3.

## Open Questions

Items that remain genuinely open (deferred for MVP, not undefined behavior):

### Important (Deferred — may be picked up in a follow-up spec)

- [ ] **Lifecycle states**: Should meta-specs have draft/approved/superseded states? MVP default: no formal states. Revisit after 3+ months of real use.
- [ ] **Meta-spec amendment protocol**: Analogous to TICK, for meta-specs. Deferred.
- [ ] **arch.md relationship**: Does `codev/resources/arch.md` become a curated meta-spec or stay ambient? Likely a follow-up MAINTAIN-protocol project.
- [ ] **Cross-meta-spec references**: One meta-spec citing another's section. Deferred.
- [ ] **"Supersedes" links**: A meta-spec section declaring it supersedes section X of meta-spec Y. Deferred.
- [ ] **Un-annotated invariant marker**: A way to machine-identify claims that *should* be contract-linked but aren't. Deferred (Codex raised this; defensible MVP omission).
- [ ] **Separate `codev validate` subcommand**: If meta-spec validation grows beyond two or three rules, pull it out of `doctor` into its own subcommand (Gemini's suggestion). MVP defers this.

### Nice-to-Know (Optimization)

- [ ] Should recurring principles in `lessons-learned.md` graduate to meta-specs automatically? Likely no — graduation is a human call.
- [ ] Should meta-spec authoring have a recommended word-count-per-section guardrail (Claude suggested ~500 words per section to avoid prompt bloat)? MVP: document the guidance in the guide; no enforcement.

## Performance Requirements

No runtime performance requirements — this is an authoring-time and CI-time feature.

- `codev doctor` added cost: <100ms on a repo with 10 meta-specs and 100 specs.
- Builder-prompt size increase: measure before/after during planning; if cascaded meta-spec context exceeds ~4000 tokens on a real spec, investigate section-scoping tightness.

## Security Considerations

- Meta-spec references in specs are user-controlled paths. The validator resolves paths inside the repo root only — no symlink traversal outside, no `..` traversal outside `codev/architecture/`.
- Contract annotations reference test file paths. Same path-traversal constraint; no tool *executes* them — they are only displayed and checked for existence.
- No authentication/authorization model — meta-specs are Markdown files gated by existing git permissions.

## Test Scenarios

### Functional Tests

1. **Frontmatter parsing — happy path**: A spec with valid `meta_specs:` frontmatter parses into the expected internal structure.
2. **Frontmatter parsing — malformed**: Malformed YAML under `meta_specs:` is reported as an error with the offending spec path.
3. **Reference validation — happy path**: Spec references `codev/architecture/foo.md §P2`, file exists, section `§P2` exists. `codev doctor` passes silently.
4. **Reference validation — missing file**: Referenced file does not exist → doctor emits error with spec path and missing target.
5. **Reference validation — missing section**: File exists but `§P99` does not → doctor emits error.
6. **Reference validation — legacy spec**: Spec with no `meta_specs:` frontmatter → doctor silent (no warning, no error).
7. **Section extraction boundary**: Given a meta-spec with `## §P6 …` followed by content, then `## §P7 …`, extraction of `§P6` returns the heading and its content but not `§P7`. Level-respect: `### §P6` extraction stops at the next `###` / `##` / `#`, not at `####`.
8. **ASCII identifier fallback**: A meta-spec heading `## [[P6]] …` is recognized with the same extraction semantics as `## §P6 …`.
9. **Contract inventory recipe**: Running the documented grep recipe on a meta-spec with 3 `<!-- contract: ... -->` annotations lists all 3 with target paths and distinguishes existing vs. missing target files.
10. **Builder prompt loads cascaded sections**: Spawning a builder on a spec with `meta_specs:` frontmatter renders the cited sections in the prompt under `Meta-Spec Context`. Verified by unit test extending the existing `bugfix-619-aspir-prompt.test.ts` harness.
11. **Consultation prompt includes meta-spec context**: A consultation run on a cascaded spec produces a prompt containing both the "meta-spec wins" rule and the cited sections.
12. **Dogfood meta-spec parses cleanly**: `codev/architecture/protocol-authoring.md` has the expected section markers, at least one spec declares it in `meta_specs:`, and `codev doctor` passes.

### Non-Functional Tests

1. **`codev doctor` performance**: Added validation cost is <100ms on this repo's current spec count.
2. **Documentation completeness**: `resources/meta-specs-guide.md` covers authoring, cascade references, contract annotations, amendment approach, section-ID stability (D4), and meta-spec deletion/rename workflow. Cross-linked from CLAUDE.md and AGENTS.md and the cheatsheet.
3. **Skeleton parity**: `codev-skeleton/` contains the guide, the `templates/meta-spec.md` template, and a non-empty `codev/architecture/README.md` stub (satisfies Codex's "not an empty placeholder" concern).

## Dependencies

- **External Services**: None.
- **Internal Systems**:
  - `packages/codev/src/commands/doctor.ts::checkCodevStructure()` — extend for meta-spec validation (Claude verified location).
  - `packages/codev/src/agent-farm/commands/spawn-roles.ts` — extend `TemplateContext` with `meta_spec_context` string field and populate it at spawn time for cascaded specs.
  - SPIR and ASPIR protocol `builder-prompt.md` templates in `codev-skeleton/protocols/spir/` and `codev-skeleton/protocols/aspir/`.
  - SPIR and ASPIR `consult-types/*.md` prompts (`spec.md`, `plan.md`, `impl.md`).
  - Documentation surfaces: `CLAUDE.md`, `AGENTS.md`, `codev/resources/cheatsheet.md`.
- **Libraries/Frameworks**: None new. The existing YAML frontmatter parser (used for `approved:`/`validated:`) is reused; the simplified template renderer is sufficient for the `{{#if meta_spec_context}}` block.

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
  - `codev/protocols/*/protocol.md` (cascade source for the dogfood meta-spec).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|---------------------|
| Frontmatter choice (D1) is wrong — downstream projects prefer body-text references for grep-ability. | Low | Medium | The MVP supports only frontmatter. Body-text can be added as a secondary source of truth in a follow-up TICK if real feedback demands it. Frontmatter is grep-friendly (`rg '^meta_specs:' codev/specs/`). |
| Section extraction boundary (D3) mishandles nested content or tables. | Medium | Low | Tests (T7, T8) exercise the boundary logic. A documented escape: authors who need uncut content in a section can use explicit block markers, or just avoid ambiguous nesting. |
| Builder-prompt context bloat — cascaded sections inflate every builder prompt. | Medium | Low-Medium | Scope the loaded content to *only cited sections*. Measure prompt size before/after during planning. Guide recommends ≤500 words per section. |
| Consultation reviewers do not actually cite meta-specs even when given the content. | Medium | Medium | Inject the content directly (D8) — this is stronger than "told to cite". Include a worked example. Spot-check during Review phase. |
| `codev doctor` rejects legitimate specs. | Low | Medium | Legacy specs without `meta_specs:` frontmatter are silent per D5. Only specs that *declare* a `meta_specs:` field with invalid targets are errored. |
| Dogfood meta-spec gets out of date — architects edit protocols without updating the meta-spec. | Medium | Low | Doctor catches spec-side drift (cited section missing). Meta-spec-side rot is a general doc-rot problem; a potential future `codev doctor` warning could flag meta-spec claims that haven't been touched in N months. Out of scope for MVP. |
| Scope creep during planning into Approach 3 territory. | Medium | High (delays MVP) | Planning phase must explicitly defer Approach-3 items. All deferred items are catalogued in Open Questions. |
| Contract annotation format conflicts with an aggressive Markdown processor. | Low | Low | HTML comments are universally preserved by CommonMark-compliant processors. |
| Section-identifier renumbering silently breaks cascaded specs. | Medium | Medium | D4 documents this explicitly. Doctor will catch a broken reference on the next run. Guide recommends appending new IDs. |

## Expert Consultation

Consultation completed 2026-04-19 with Gemini 3 Pro, GPT-5 Codex, and Claude Opus (via `consult -m … --protocol spir --type spec`, run in parallel).

**Verdicts before revision**: Codex REQUEST_CHANGES (HIGH confidence), Gemini REQUEST_CHANGES (HIGH confidence), Claude APPROVE (HIGH confidence).

**Primary revisions incorporated**:

- Resolved all "Critical (Blocks Progress)" open questions into committed design decisions (D1–D12). Codex and Gemini both asked that critical MVP behavior be pinned down before approval.
- Committed to YAML frontmatter (`meta_specs:`) over inline body text (Gemini's strong recommendation, Codex asked for a committed syntax).
- Rejected `#P6` as an ASCII fallback because it collides with Markdown headings and GitHub issue references; selected `[[P6]]` instead (both Gemini and Claude flagged).
- Added a precise section extraction boundary rule (D3) — "next heading of same-or-higher level" — both Codex and Gemini flagged the omission.
- Added an error-severity table for `codev doctor` (D5) — Codex asked for this.
- Corrected the doctor source path to `packages/codev/src/commands/doctor.ts` — Codex flagged the handwave.
- Noted that the template renderer is a simplified custom implementation (not Handlebars proper); committed to pre-expansion into a single string (Claude found the renderer's limits; Codex flagged the "not just a template edit" issue).
- Committed to injecting meta-spec content into consultation prompts rather than just telling reviewers the rule (D8) — Gemini flagged that reviewers will not spontaneously fetch files.
- Dropped "un-annotated invariant" inventory from MVP — Codex flagged that grep cannot distinguish prose from unmarked claims.
- Committed to `codev/architecture/protocol-authoring.md` as the dogfood target (D9) — Codex asked that the dogfood be resolved, not left open.
- Added a non-empty `codev-skeleton/codev/architecture/README.md` stub requirement — Codex flagged skeleton parity.
- Added deletion/rename workflow documentation to the success criteria — Claude suggested it.
- Added section-ID stability rule (D4) — prevents silent breakage from renumbering.

## Approval

- [ ] Technical Lead Review (architect)
- [x] Multi-agent consultation complete (Gemini 3 Pro, GPT-5 Codex, Claude)
- [ ] Human gate: `spec-approval`

## Notes

**Cross-workspace origin.** This spec originated as an inbound feature request from another codev-using project (Shannon). The Shannon architect sent the request via cross-workspace messaging on 2026-04-19 after running a 10-spec ASPIR cascade that validated the pattern. This is a useful signal for codev: features that emerge from actual downstream usage are higher-priority than speculative ones. Consider whether codev wants a lightweight channel for such inbound requests as a meta-observation (out of scope for this spec).

**Naming.** "Meta-spec" is borrowed from Shannon's internal vocabulary. Alternatives considered: "architecture doc" (collides with `arch.md`), "charter" (too governance-y), "invariants doc" (too narrow — the Shannon docs also carry taxonomies and canonical layouts). Meta-spec is retained.

**Authoring is human.** This feature does not introduce an AI workflow to *generate* meta-specs. The value is in codev *recognizing* architect-authored meta-specs. AI can draft sections on request, but the architect owns the doc.

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
