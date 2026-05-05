# Plan: Improve arch.md / lessons-learned.md governance

## Metadata
- **ID**: plan-2026-05-05-723-arch-md-governance
- **Status**: draft
- **Specification**: `codev/specs/723-improve-arch-md-lessons-learne.md`
- **Created**: 2026-05-05

## Executive Summary

This plan implements Approach 1 from the spec: a coordinated set of governance edits across the skill, the templates, and the MAINTAIN protocol. The work is split into **two implementation phases**:

- **Phase 1 — Authored artifacts**: write the new `update-arch-docs` skill, the new arch.md template (with inline "Updating This Document" preface), and the upgraded lessons-learned.md template. Place each artifact in both `codev/` (self-hosted) and `codev-skeleton/` (template propagation source) so they are byte-identical.
- **Phase 2 — Wire into MAINTAIN + verify**: update both MAINTAIN protocol files with the "Lives where" matrix, the Step 3 audit-then-update split (3a/3b), pruning checklists, and the run-file recording requirement. Then run the verification battery (parity checks, scaffold tests, smoke tests, self-consistency check) and prepare the PR.

The split is deliberate: Phase 1 is the *content* (what the discipline says); Phase 2 is the *integration* (where MAINTAIN invokes it) and the *verification* (do the parity checks pass, does `codev init` produce the new artifacts, does audit-mode actually find candidate cuts in the live 1,812-line arch.md).

There is no executable code in either phase — only docs, skill prose, and template content. The narrowest test surface is `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold`.

## Success Metrics

Inherited from spec; reorganized by phase below. Top-level rollup:

- [ ] All deterministic Success Criteria from the spec pass (skill literal-content checks, template parity, protocol parity).
- [ ] `diff -r` shows zero output across every touched skeleton/codev pair.
- [ ] Scaffold tests pass: `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold`.
- [ ] `codev init` smoke test in a tmp directory produces all the new artifacts.
- [ ] Self-consistency check against `codev/resources/arch.md` lists ≥3 candidate-cut categories in the review document.
- [ ] PR description contains the post-merge cutover note (`rm ~/.claude/agents/architecture-documenter.md`).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Authored artifacts: skill + templates"},
    {"id": "phase_2", "title": "Wire into MAINTAIN + verify"}
  ]
}
```

## Phase Breakdown

### Phase 1: Authored artifacts — skill + templates

**Dependencies**: None (spec is approved).

#### Objectives

- Author the `update-arch-docs` skill — the keystone artifact that owns documenter discipline.
- Author the new arch.md template (with inline preface) and lessons-learned.md template (with preface).
- Land the four template files and two skill files in both `codev/` and `codev-skeleton/`, byte-identical.

#### Deliverables

- [ ] `.claude/skills/update-arch-docs/SKILL.md` — the skill (in this repo).
- [ ] `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md` — the skill (skeleton copy, byte-identical).
- [ ] `codev/templates/arch.md` — new richer template with inline "Updating This Document" preface.
- [ ] `codev-skeleton/templates/arch.md` — byte-identical to the above.
- [ ] `codev/templates/lessons-learned.md` — new template with preface and pruning checklist.
- [ ] `codev-skeleton/templates/lessons-learned.md` — byte-identical to the above.
- [ ] No phase-1 changes to MAINTAIN protocol or to live `codev/resources/arch.md` / `codev/resources/lessons-learned.md`. Phase 1 is artifacts-only.

#### Implementation Details

**Skill (`update-arch-docs/SKILL.md`)** — required structure (per spec Success Criteria):

- Frontmatter:
  - `name: update-arch-docs`
  - `description:` includes literal phrases "arch.md", "lessons-learned.md", "MAINTAIN", and the trigger sentence: *"Use this skill when running MAINTAIN's arch-doc step, or when asked to update / audit / prune `codev/resources/arch.md` or `codev/resources/lessons-learned.md`."*
- Body sections (named exactly as listed in spec):
  - `## What this skill does NOT do` — calls out: no per-file enumerations, no per-spec changelog sections, no specs/plans tables, no aspirational state, no date-stamped narrative, no duplication of meta-specs. Also lists prohibited shell commands (`rm -rf`, `git rm`, destructive `sed`).
  - `## arch.md vs. lessons-learned.md (two-doc framing)` — arch.md owns system shape, unique mechanism, pointers; lessons-learned.md owns durable engineering wisdom; system-shape surprises ("looks like X but isn't") live in arch.md not lessons-learned.md.
  - `## Sizing by purpose, not by line count` — purpose-driven sizing guidance; no hard line budgets.
  - `## Mode: diff-mode (apply a specific change)` — apply the smallest section update; surface the proposed diff.
  - `## Mode: audit-mode (identify what to cut)` — read against principles; produce a candidate-cuts list with reasons; the skill *may* directly edit the files via Edit tooling in audit-mode but must surface reasons alongside the diff so PR review can evaluate intent.
  - `## Output contract` — codifies: skill edits files via Edit tooling; never invokes destructive shell commands; in audit-mode surfaces *reasons* alongside the diff.

**arch.md template** — required structure:

- Top of file: short TL;DR explaining the doc's purpose.
- Section stubs (per spec scope item 2): TL;DR, Repository Layout & Stack, per-subsystem mechanism, Apps Roster, Packages Roster, Verified-Wrong Assumptions, Updating This Document.
- Each section stub includes a one-line "skip if N/A" hint where applicable.
- Final section `## Updating This Document` contains the inline preface that replaces the dropped `arch-md-guide.md`. Covers:
  - When to update (after MAINTAIN runs, after architectural decisions land).
  - How to update (use the `update-arch-docs` skill).
  - What NOT to put in (per-spec changelog, exhaustive enumerations, aspirational state, duplicate meta-spec content).
  - Sanity-check checklist (4-6 questions to run through before committing).
  - Note that `codev update` does not propagate templates — existing projects opt in by manual copy.

**lessons-learned.md template** — required structure:

- Preface (~10-15 lines) covering: how to read, when to add an entry, what NOT to add (spec-narrow recipes, multi-paragraph entries, duplicate adjacent entries), sanity-check checklist.
- Existing topical sections (Testing, Architecture, Process, Tooling, Integration, etc.) — keep the same skeleton; the preface is what's new.

**Byte-identical placement**:

- After authoring each artifact in `codev/`, copy verbatim to the matching `codev-skeleton/` path. Verify with `diff -r` at end of phase.
- This includes the new skill, which lives in *both* `.claude/skills/update-arch-docs/SKILL.md` (this repo) and `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md` (skeleton).

**Files NOT touched in Phase 1**:
- MAINTAIN protocol (Phase 2).
- Scaffold logic (`packages/codev/src/lib/scaffold.ts`) — no changes needed; existing `copyResourceTemplates` handles `arch.md` and `lessons-learned.md` already, and `copySkills` propagates skills directory generically.
- Live `codev/resources/arch.md` / `codev/resources/lessons-learned.md` — out of scope per spec.

#### Acceptance Criteria

- [ ] All six deliverable files exist at correct paths.
- [ ] Skill literal-content check passes: frontmatter `description` contains all required phrases; body contains all six required `## ...` sections.
- [ ] arch.md template includes all seven section stubs from the issue scope.
- [ ] arch.md template's "Updating This Document" section contains the four preface ingredients (when, how, what NOT, sanity-check checklist).
- [ ] lessons-learned.md template has a preface with "what NOT to add" guidance and sanity-check checklist.
- [ ] `diff codev/templates/arch.md codev-skeleton/templates/arch.md` produces no output.
- [ ] `diff codev/templates/lessons-learned.md codev-skeleton/templates/lessons-learned.md` produces no output.
- [ ] `diff -r .claude/skills/update-arch-docs/ codev-skeleton/.claude/skills/update-arch-docs/` produces no output.
- [ ] No code changes outside `.md` files and the new skill directory.

#### Test Plan

- **Unit Tests**: None applicable (Phase 1 changes are docs/skill prose only).
- **Integration Tests**: `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold` still passes (Phase 1 does not touch scaffold logic, but we verify).
- **Manual Testing**:
  1. `cat .claude/skills/update-arch-docs/SKILL.md` — visually confirm structure.
  2. `grep -E "^## " codev/templates/arch.md` — confirm all expected section headings.
  3. `diff -r` parity checks listed in Acceptance Criteria.

#### Rollback Strategy

Each artifact is a new file or a self-contained replacement. To roll back: `git revert` the phase-1 commit. No downstream consumers depend on these artifacts at this point in the merge order, so revert is safe.

#### Risks

- **Risk**: Skill description doesn't trigger reliably from natural-language invocations.
  - **Mitigation**: Deterministic literal-content check guards what's *written*; manual smoke test in Phase 2 verifies behavior. Worst case (skill never triggers), the prose still serves as a reference doc that humans can read.
- **Risk**: arch.md template grows too prescriptive and feels heavy for small projects.
  - **Mitigation**: Each section stub carries a "skip if N/A" hint; preface explicitly says skip what doesn't apply.

---

### Phase 2: Wire into MAINTAIN + verify

**Dependencies**: Phase 1 (skill and templates must exist before MAINTAIN can reference them).

#### Objectives

- Update MAINTAIN protocol (both `codev/` and `codev-skeleton/` copies) with the matrix, the audit-then-update split, the pruning checklists, and the run-file recording requirement.
- Run the full verification battery from the spec.
- Prepare the PR with the post-merge cutover note.

#### Deliverables

- [ ] `codev/protocols/maintain/protocol.md` — updated with: "Lives where" matrix, Step 3 split into 3a/3b, sample audit prompt, per-arch.md-section pruning checklist, per-lessons-learned.md-entry pruning checklist, run-file format addition for audit findings.
- [ ] `codev-skeleton/protocols/maintain/protocol.md` — byte-identical to the above.
- [ ] Verification artifacts captured in the review document: parity-check outputs, scaffold-test result, codev-init smoke-test result, self-consistency-check findings.
- [ ] PR description draft including the post-merge cutover note.

#### Implementation Details

**MAINTAIN protocol edits** (applied to both `codev/protocols/maintain/protocol.md` and `codev-skeleton/protocols/maintain/protocol.md`, kept byte-identical):

1. **Add a "Lives where" matrix** to the protocol overview area (probably a new subsection under "Key Documents MAINTAIN keeps current"). The matrix routes facts/insights to the right home. Starter rows from the issue, plus refinements during implementation:

   | Type of fact/insight | Lives in |
   |---|---|
   | Current system shape (services, transports, mental models) | arch.md |
   | Mechanism for a unique subsystem | arch.md (subsystem section) OR a meta-spec under `codev/architecture/<domain>.md` |
   | A durable engineering pattern that applies across specs | lessons-learned.md |
   | A spec-narrow fix recipe | Spec review only |
   | A system-shape surprise verified-wrong in production | arch.md § Verified-Wrong Assumptions |
   | Aspirational architectural direction | The relevant meta-spec, NOT arch.md body |
   | A changelog of "we shipped X in spec Y on date Z" | git log + spec review |

   Final exact rows are locked at plan-approval time per the spec's open question.

2. **Split Step 3 ("Sync Documentation") into 3a (Audit) and 3b (Update)**:
   - **Step 3a — Audit documentation**: invoke the `update-arch-docs` skill in audit-mode. Produce a candidate-cuts list against the per-arch.md-section pruning checklist and per-lessons-learned.md-entry pruning checklist. Record findings in the run file (`codev/maintain/NNNN.md`) under a new `## Audit Findings` section before any edits land.
   - **Step 3b — Update documentation**: apply the audit decisions plus any new content (the existing Step 3 work). Continue using the `update-arch-docs` skill in diff-mode for any specific changes.
   - Step numbers 1, 2, and 4 keep their existing numbering.

3. **Add the pruning checklists** as inline content under Step 3a:
   - **For each arch.md section**: Does it describe current state? Does it duplicate a meta-spec? Is it a per-file enumeration that's gone stale? Is it a changelog/narrative section?
   - **For each lessons-learned.md entry**: Is it cross-applicable beyond the spec that produced it? Is it terse (1-3 sentences)? Is the topic section the right one? Is it a duplicate of an adjacent entry?

4. **Add a sample audit prompt** (a checklist invocation that asks the skill to identify sections to cut) as a code block under Step 3a.

5. **Update the run-file format** (the `## What Was Done` template) to include a `## Audit Findings` section with the schema:
   ```
   ## Audit Findings
   ### arch.md
   - <section-name>: <reason for proposed cut/compression>
   ### lessons-learned.md
   - <entry>: <reason>
   ```

6. **Cross-reference the skill** from the protocol — Step 3a and Step 3b each call out `update-arch-docs` by name and link to `.claude/skills/update-arch-docs/SKILL.md`.

**Verification battery** (run in this order, results recorded in `codev/reviews/723-improve-arch-md-lessons-learne.md`):

1. Skeleton/main parity — `diff -r` across all touched pairs:
   - `diff codev/templates/arch.md codev-skeleton/templates/arch.md`
   - `diff codev/templates/lessons-learned.md codev-skeleton/templates/lessons-learned.md`
   - `diff codev/protocols/maintain/protocol.md codev-skeleton/protocols/maintain/protocol.md`
   - `diff -r .claude/skills/update-arch-docs/ codev-skeleton/.claude/skills/update-arch-docs/`
2. Skill literal-content check — verify required frontmatter phrases and body sections (re-run from Phase 1; defends against regressions).
3. Scaffold tests — `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold` (run in background; reasonable timeout 120s).
4. `codev init` smoke test — `node packages/codev/dist/cli.js init /tmp/codev-723-smoke 2>&1` (or equivalent), then verify the new arch.md, new lessons-learned.md, and the new skill landed in the scratch project. Clean up the scratch directory.
5. Skill propagation via `codev update` — in a separate scratch project that has Codev already installed, run `codev update` and verify `.claude/skills/update-arch-docs/SKILL.md` appears.
6. Self-consistency check — invoke `update-arch-docs` in audit-mode against `codev/resources/arch.md`. Capture at least three categories of candidate cuts in the review document. **Do not apply the cuts** — that's a separate MAINTAIN run, out of scope per the spec.
7. Manual smoke test of skill discovery — invoke `/update-arch-docs` and confirm it surfaces. Note the result in the review.

**PR preparation**:

- Branch: `builder/spir-723` (already in use; this is the existing builder worktree).
- PR title: `[Spec 723] Improve arch.md / lessons-learned.md governance`.
- PR description includes:
  - Summary of all six issue scope items addressed.
  - **Post-merge cutover (architect action required)**: `rm ~/.claude/agents/architecture-documenter.md` — surfaced prominently near the top of the description.
  - List of files changed.
  - Verification results (parity checks, test runs, self-consistency findings).

#### Acceptance Criteria

- [ ] Both MAINTAIN protocol files updated with all six edits (matrix, Step 3a/3b, two checklists, sample audit prompt, run-file format update, skill cross-reference).
- [ ] `diff` parity checks across all four touched pairs produce no output.
- [ ] Scaffold tests pass.
- [ ] `codev init` smoke test produces all expected artifacts.
- [ ] Self-consistency check found ≥3 candidate-cut categories — recorded in review doc.
- [ ] PR description drafted with the post-merge cutover note prominently surfaced.

#### Test Plan

- **Unit Tests**: `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold`.
- **Integration Tests**: `codev init` smoke test (covered above). Skill propagation via `codev update` (covered above).
- **Manual Testing**: Skill discovery (manual `/update-arch-docs` invocation). Audit-mode self-consistency check against live arch.md.

#### Rollback Strategy

If MAINTAIN protocol edits cause confusion in the next maintenance run, `git revert` the Phase 2 commit. The Phase 1 artifacts (skill + templates) remain valid and useful even without the MAINTAIN integration — the protocol simply reverts to its previous "single Step 3" shape.

#### Risks

- **Risk**: Audit-mode self-consistency check fails to find ≥3 categories.
  - **Mitigation**: The live `codev/resources/arch.md` is 1,812 lines and visibly contains per-spec changelog sections, exhaustive enumerations, and aspirational/retired components — three categories already verified to exist by manual inspection. If audit-mode somehow misses them, that's a skill prose bug we can fix by improving the audit-mode section text.
- **Risk**: Scaffold tests fail because `copyResourceTemplates` references a file that no longer exists.
  - **Mitigation**: We are not removing any existing templates, only updating their content. The template list in scaffold.ts (`['lessons-learned.md', 'arch.md', 'cheatsheet.md', 'lifecycle.md']`) is unchanged. Cross-checked.
- **Risk**: `codev init` smoke test produces stale content because the binary in `packages/codev/dist/` predates Phase 1 changes.
  - **Mitigation**: Phase 1 changes are template content, not packaged code. Templates are read from `codev-skeleton/` at runtime, not bundled into the binary. Verified by reading `packages/codev/src/lib/scaffold.ts` — it `path.join(skeletonDir, 'templates', template)`.

---

## Dependency Map

```
Phase 1 ──→ Phase 2
(skill + templates)   (MAINTAIN wiring + verification + PR)
```

Phase 2 strictly depends on Phase 1 because Phase 2 references the skill by name in the protocol.

## Resource Requirements

### Development Resources

- **Engineers**: One AI builder (this agent). No specialist expertise required — work is markdown/skill prose authoring plus standard parity/test verification.
- **Environment**: This builder worktree (`/Users/mwk/Development/cluesmith/codev/.builders/spir-723/`). No additional infra needed.

### Infrastructure

- None (no database changes, no new services, no monitoring additions).

## Integration Points

### Internal Systems

- **`packages/codev/src/lib/scaffold.ts`**: Read-only consumer in this work. Already handles `arch.md` and `lessons-learned.md` template propagation; already handles skill propagation via `copySkills`. No edits needed.
- **MAINTAIN protocol**: Modified in Phase 2 to invoke the new skill.
- **`codev update`**: Read-only consumer. Verified to propagate skills (via `copySkills` with `skipExisting: true`) but not templates.

### External Systems

- None.

## Risk Analysis

### Technical Risks

| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Skill literal-content check passes but skill doesn't trigger | Low | High | Manual smoke test in Phase 2; prose still readable as reference doc | Builder |
| Skeleton/main drift introduced during edits | Medium | Medium | `diff -r` parity checks at end of each phase; commit only after parity confirmed | Builder |
| Self-consistency check fails to find ≥3 categories | Low | Medium | Live arch.md visibly contains all three categories — manually verified | Builder |
| Scaffold tests break unexpectedly | Low | Medium | No code changes to scaffold.ts; only template content. If tests reference template content, update test fixtures alongside templates | Builder |

### Schedule Risks

| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| 3-way consultation surfaces material changes that ripple through both phases | Medium | Low | Iterate; reviewer feedback on plan loops back to plan, not back through the spec | Builder |

## Validation Checkpoints

1. **End of Phase 1**: All six artifact files exist; literal-content check passes; `diff -r` parity confirmed for templates and skill.
2. **End of Phase 2**: MAINTAIN protocol updated; all parity checks pass; scaffold tests pass; `codev init` smoke test produces expected output; self-consistency check captured ≥3 categories.
3. **Pre-PR**: PR description drafted with post-merge cutover note prominently surfaced.

## Monitoring and Observability

Not applicable — no runtime services modified. Documentation governance changes have no production observability surface.

## Documentation Updates Required

Documentation IS the work product. Specifically:

- [x] (Phase 1) `update-arch-docs/SKILL.md` — new.
- [x] (Phase 1) `arch.md` template — replaced with richer version.
- [x] (Phase 1) `lessons-learned.md` template — preface added.
- [x] (Phase 2) MAINTAIN protocol — matrix, 3a/3b split, checklists, run-file format.

**Out of scope** (per spec): live `codev/resources/arch.md` and `codev/resources/lessons-learned.md` rewrites.

**Not needed** for this work:
- API documentation (no API changes).
- Architecture diagrams (no architecture changes).
- Runbooks (no operational changes).
- User guides (governance discipline change is invisible to end users).

## Post-Implementation Tasks

Inherited from spec's Out-of-Scope; not part of this work but explicitly enumerated:

- A future MAINTAIN run that *uses* the new governance to clean up the existing 1,812-line `codev/resources/arch.md` and 371-line `codev/resources/lessons-learned.md`.
- Architect-side task: `rm ~/.claude/agents/architecture-documenter.md` at merge time.
- Future issues for the four out-of-scope items listed in the spec.

## Expert Review

**Date**: 2026-05-05
**Models**: Gemini 3 Pro, GPT-5.4 Codex, Claude (3-way via `consult`)
**Key Feedback**: To be filled in after consultation round.

**Plan Adjustments**: To be filled in after consultation.

## Approval

- [ ] Architect Review
- [ ] 3-way consultation complete (gemini, codex, claude)
- [ ] Plan-approval gate signaled

## Change Log

| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-05-05 | Initial plan draft | Specify phase complete; spec approved | Builder (project 723) |

## Notes

The plan compresses to two phases because the spec is governance-only. There is no executable code, so no separate "implement", "defend", "evaluate" beat per phase — instead, Phase 1 is "author" and Phase 2 is "wire + verify". The implement/defend/evaluate cycle from the SPIR protocol is honored by treating each phase's authoring as the implement step, the parity/literal-content checks as the defend step, and the manual smoke tests + self-consistency check as the evaluate step.
