# Spec Iteration 1 — Rebuttal to Review Feedback

**Date**: 2026-05-05
**Reviewers**: Gemini 3 Pro (COMMENT), GPT-5.4 Codex (REQUEST_CHANGES), Claude (COMMENT)

## Codex feedback (REQUEST_CHANGES) — addressed

### 1. "Factual error: codev-skeleton/ does have .claude/skills/"

**Action taken**: Verified by `ls codev-skeleton/.claude/skills/` (contents: `afx codev consult generate-image porch`). Removed the false claim from the spec; moved skeleton-skill-location from the "Open Questions" section to a new "Resolved Decisions" section. Added explicit confirmation that `codev update` propagates skills via `copySkills(target, skel, { skipExisting: true })` (verified in `packages/codev/src/commands/update.ts:211`).

**Rebuttal**: Agreed, accepted in full.

### 2. "Skill discovery/triggering criteria are too fuzzy"

**Action taken**: Restructured Success Criteria. The previous fuzzy criteria ("description triggers on MAINTAIN-driven invocations") have been replaced by **deterministic literal-content checks**:
- Frontmatter `description` must contain the literal phrases "arch.md", "lessons-learned.md", "MAINTAIN" plus a literal trigger sentence.
- The body must contain seven named `## ...` sections (listed verbatim in the spec).
- Manual smoke-test of skill discovery is explicitly marked as informational, not a deterministic acceptance criterion.

**Rebuttal**: Agreed. The new literal-content criteria are testable with a `grep` script.

### 3. "lessons-learned.md deliverables weaker than arch.md"

**Action taken**: Added explicit Success Criteria for `codev/templates/lessons-learned.md` and `codev-skeleton/templates/lessons-learned.md`: a preface mirroring arch.md's, "what NOT to add" guidance (no spec-narrow recipes, no multi-paragraph entries, no duplicate adjacent entries), and a sanity-check checklist. Added a corresponding bullet to the "Desired State" section.

**Rebuttal**: Agreed in full. The original spec under-specified lessons-learned.md.

### 4. "`pnpm build && pnpm test` is too broad"

**Action taken**: Replaced with a narrower target: `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold`. This targets the actual change surface (the scaffold logic that propagates templates and skills). Added a separate test scenario for skill propagation via `codev update` and template propagation via `codev init`.

**Rebuttal**: Agreed. Narrower test scope is appropriate for a docs/skill change.

### 5. "Constrain skill to guidance only — no destructive command suggestions or auto-pruning"

**Action taken**: Added an explicit constraint: **"Skill is guidance-only"**. SKILL.md must not include shell commands that delete files (no `git rm`, no `rm -rf`, no destructive sed). Pruning produces a *list of candidates* or a *proposed diff* surfaced for human review; the skill never executes the cuts. This is enforced at PR review time. Also added an `## Output contract` section to the skill body that codifies this.

**Rebuttal**: Agreed in full. This is a correct security/safety hardening.

## Gemini feedback (COMMENT) — addressed

### 1. "Fact check on skeleton skills" — same as Codex #1, addressed.

### 2. "Missing lessons-learned.md template update" — same as Codex #3, addressed.

### 3. "Skill naming collision with global agent"

**Action taken**: Resolved decision: skill is named `update-arch-docs` (action-oriented, no collision). Added a "Relationship to the architecture-documenter agent" section requirement to the skill body so users running both don't get confused. Added the resolution to the "Resolved Decisions" section. Added a row to the Risks table marking the collision risk as resolved.

**Rebuttal**: Agreed. Action-oriented name is the better choice and avoids ambiguity.

### 4. "Audit-pass results recorded in run file"

**Action taken**: Added to the MAINTAIN protocol Success Criteria: "an explicit instruction to record audit findings in the run file (`codev/maintain/NNNN.md`)." Audit findings now appear in PRs, giving the architect visibility into *why* sections were targeted, not just deletion diffs.

**Rebuttal**: Agreed. Captures the visibility concern correctly.

## Claude feedback (COMMENT) — addressed

### 1. "Skeleton skill propagation is already answerable" — same as Codex #1, addressed.

### 2. "Naming collision with user-global agent" — same as Gemini #3, addressed.

### 3. "Template propagation semantics unclear"

**Action taken**: Verified in `packages/codev/src/lib/scaffold.ts:137-169`: `copyResourceTemplates` copies templates only during `init`/`adopt`, not during `update`. `copySkills` runs during `update` with `skipExisting: true`. Documented this explicitly in the spec's "Resolved Decisions" section, in the Constraints section, and as a row in the Risks table noting that existing projects need to manually copy the new arch.md template if they want it (the *governance discipline* still reaches them via the propagated skill, even if the template doesn't).

**Rebuttal**: Agreed. This is exactly the kind of hidden propagation semantic that the spec needs to surface for the implementer.

### 4. "Step 3 split vs prepended sub-step ambiguity"

**Action taken**: Resolved decision recorded explicitly: "Sub-step split into 3a (Audit) and 3b (Update). Top-level step numbers 1, 2, 4 are unchanged." Added a corresponding Success Criterion that mandates this structure: "The new Step 3a / Step 3b structure preserves the existing Step 1, Step 2, Step 4 numbering so in-flight runs are not disrupted; this is a sub-step split, not a renumber of the parent steps."

**Rebuttal**: Agreed. Resolves the ambiguity.

## Net assessment

All five Codex REQUEST_CHANGES items addressed in the spec. All four Gemini key issues addressed. All four Claude key issues addressed. No reviewer point was rejected; no conflicts between reviewers required adjudication. The spec moves from "draft, three open questions" to "draft, one substantive open question (Lives-where matrix exact rows, deferred to plan phase)."
