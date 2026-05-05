# Specification: Improve arch.md / lessons-learned.md governance

## Metadata
- **ID**: spec-2026-05-05-723-arch-md-governance
- **Status**: draft
- **Created**: 2026-05-05
- **GitHub Issue**: #723

## Problem Statement

`codev/resources/arch.md` and `codev/resources/lessons-learned.md` are **append-only by default**. Every spec, plan, or review tends to add content; nothing prunes. Over time both files balloon — per-spec changelog sections, exhaustive file enumerations, retired-component graveyards, and duplication of meta-spec content all accumulate.

The current `architecture-documenter` agent prompt (defined in `~/.claude/agents/architecture-documenter.md`) is structured around comprehensive coverage ("a missing utility or unclear structure wastes developer time", "Document every utility function with its exact location"). It biases the agent toward **adding** rather than **editing or removing**. The MAINTAIN protocol invokes "Update arch.md" as a single pass that is functionally equivalent to "add what's new".

The lived consequence is visible in the repo today: `codev/resources/arch.md` is 1,812 lines and contains per-spec narrative ("Spec 0104"), changelog framing, and exhaustive file lists that go stale the moment they're written. `lessons-learned.md` mixes durable, cross-cutting wisdom with spec-narrow recipes.

This spec groups several governance improvements that together shift the workflow from **"append by default"** to **"audit, then update."**

## Current State

**`architecture-documenter` agent**:
- Defined as a Claude Code agent at `~/.claude/agents/architecture-documenter.md` (user-global, not in repo).
- Invoked ad-hoc by AI assistants in conversation; not a first-class step in any protocol.
- Prompt emphasizes thoroughness ("Be Specific and Actionable", "Include exact file paths", "Document every utility function") with no counter-pressure to compress, prune, or remove.
- No discipline distinguishing system-shape facts (arch.md) from cross-cutting engineering wisdom (lessons-learned.md).

**`codev-skeleton/templates/arch.md`** (template shipped to other projects):
- 56-line scaffold with section stubs.
- No preface explaining how to read or maintain the doc.
- No "what NOT to put in" guidance.
- No section on verified-wrong assumptions or "skip what doesn't apply" framing.

**`codev/templates/arch.md`** (template inside this repo, identical to skeleton):
- Same 56-line stub. Same gaps.

**`codev/protocols/maintain/protocol.md`**:
- Step 3 ("Sync Documentation") is a single pass: "Compare documented structure with actual codebase. Update."
- No audit-then-update split.
- No pruning checklists for arch.md sections or lessons-learned.md entries.
- No "Lives where" routing matrix to decide which file a fact belongs in.
- Generic anti-aggressive-rewriting rules ("when in doubt, KEEP the content") that, combined with the agent's add-bias, produce monotonic growth.

**`codev/resources/arch.md`** (the live arch.md for self-hosted Codev):
- 1,812 lines. Contains per-spec changelog sections, full directory enumerations, and several aspirational/retired component descriptions.
- Working evidence that the current governance produces unbounded growth.

**`codev/resources/lessons-learned.md`** (the live lessons-learned.md):
- 371 lines. Mixes durable engineering patterns with spec-numbered narrative entries.

## Desired State

After this work:

1. **The architecture-documenter is a skill**, invoked as a standard step by the MAINTAIN protocol (and available ad-hoc). Its prompt embodies discipline about **what NOT to include** and the **two-doc framing** (arch.md owns system-shape; lessons-learned.md owns durable engineering wisdom). The skill is **guidance-only** — it never proposes destructive shell commands and never prunes content without surfacing the proposed cuts for human review first.

2. **The shipped `codev/templates/arch.md`** (and the matching `codev-skeleton/templates/arch.md`) is a richer template with a preface, opinionated section stubs, and explicit "skip what doesn't apply" framing. New projects start with a doc that *teaches* its own maintenance norms.

3. **The shipped `codev/templates/lessons-learned.md`** (and matching skeleton copy) gains a preface mirroring arch.md's: how to read, when to add, what NOT to add (spec-narrow recipes, multi-paragraph entries, duplicate adjacent entries), and a sanity-check checklist. Currently the template is 28 lines of empty section stubs; the new version teaches its own pruning norms.

4. **A new sibling `codev/templates/arch-md-guide.md`** ships alongside the template. ~30–60 lines. Tells future maintainers (human or AI) how to keep arch.md healthy: when to update, how to update, what NOT to put in, sanity-check checklist.

5. **The MAINTAIN protocol** carries a **"Lives where"** matrix that routes each fact/insight to the right home, plus a **two-phase audit-then-update** flow with concrete pruning checklists. The audit-pass results are recorded in the run file (`codev/maintain/NNNN.md`) so reviewers can see *why* sections were targeted, not just the deletion diffs.

6. **Both `codev-skeleton/` (template-for-others) and `codev/` (self-hosted)** carry the changes. Other projects pulling Codev get the upgraded governance; this repo also benefits from it.

The deliverables are governance-doc edits — they do not change live `arch.md` / `lessons-learned.md` content directly. Cleanup of the existing 1,812-line `arch.md` is a separate MAINTAIN run that *uses* the new governance once it lands.

## Stakeholders

- **Primary Users**: AI builders and architects (Claude Code, Cursor, Copilot users) running MAINTAIN or invoking architecture documentation work.
- **Secondary Users**: Human maintainers of Codev-using projects who read these files.
- **Technical Team**: This builder (project 723) implements; architect approves; users of `codev-skeleton/` inherit on next `codev update`.
- **Decision Authority**: Codev project owner (architect).

## Success Criteria

### Skill (deterministic checks)

- [ ] A skill named `update-arch-docs` (chosen to avoid collision with the user-global `architecture-documenter` agent — see Resolved Decisions) exists at `.claude/skills/update-arch-docs/SKILL.md` in this repo and at `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md` in the skeleton. Both `SKILL.md` files are byte-identical.
- [ ] The skill's frontmatter `description` field includes all of: the phrases "arch.md", "lessons-learned.md", and "MAINTAIN", plus an explicit trigger sentence ("Use this skill when running MAINTAIN's arch-doc step, or when asked to update / audit / prune `codev/resources/arch.md` or `codev/resources/lessons-learned.md`."). This is a literal-content check, not a behavioral one.
- [ ] The skill body contains, as named sections: `## What this skill does NOT do`, `## arch.md vs. lessons-learned.md (two-doc framing)`, `## Sizing by purpose, not by line count`, `## Mode: diff-mode (apply a specific change)`, `## Mode: audit-mode (identify what to cut)`, and `## Output contract` (which states the skill never auto-deletes; it produces a proposed diff or a list of candidate cuts).
- [ ] Manual smoke test: running `/update-arch-docs` (or natural-language paraphrase) from inside this repo loads the skill. Result is recorded in the review.

### Templates

- [ ] `codev/templates/arch.md` and `codev-skeleton/templates/arch.md` are replaced with a richer template that includes a preface, the opinionated section stubs listed in the issue (TL;DR, Repository Layout & Stack, per-subsystem mechanism, Apps Roster, Packages Roster, Verified-Wrong Assumptions, Updating This Document), and "skip what doesn't apply" framing. Both files are byte-identical.
- [ ] `codev/templates/lessons-learned.md` and `codev-skeleton/templates/lessons-learned.md` are updated with a preface and "what NOT to add" guidance (no spec-narrow recipes, no multi-paragraph entries, no duplicate adjacent entries) plus a sanity-check checklist. Both files are byte-identical.
- [ ] `codev/templates/arch-md-guide.md` and `codev-skeleton/templates/arch-md-guide.md` exist with ~30–60 lines of governance guidance. Both files are byte-identical.
- [ ] `packages/codev/src/lib/scaffold.ts::copyResourceTemplates` template list includes `arch-md-guide.md` so it propagates via `codev init` / `codev adopt`. (Templates are not copied by `codev update`; existing projects pick up new templates only on a fresh `init`/`adopt` or by manual copy. This is documented in the arch-md-guide preface.)

### MAINTAIN protocol

- [ ] `codev/protocols/maintain/protocol.md` and `codev-skeleton/protocols/maintain/protocol.md` are byte-identical and carry: the "Lives where" matrix, an audit-pass split inside Step 3 (renamed to Step 3a "Audit documentation" and Step 3b "Update documentation"), a sample audit prompt, per-arch.md-section pruning checklist, per-lessons-learned.md-entry pruning checklist, and an explicit instruction to record audit findings in the run file (`codev/maintain/NNNN.md`).
- [ ] The new Step 3a / Step 3b structure preserves the existing Step 1, Step 2, Step 4 numbering so in-flight runs are not disrupted; this is a sub-step split, not a renumber of the parent steps.

### Whole-spec checks

- [ ] No live `arch.md` / `lessons-learned.md` content is rewritten as part of this spec — that work belongs to a future MAINTAIN run.
- [ ] A self-consistency check: applying the new audit-mode skill to the existing 1,812-line `codev/resources/arch.md` produces at least 3 distinct categories of candidate cuts (e.g., per-spec changelog, exhaustive enumerations, aspirational sections). Findings are summarized in the review document — no actual cuts made.
- [ ] `diff -r` parity verification across all touched skeleton/codev pairs (templates, protocol, skill) produces no output.
- [ ] Tests touching the affected scaffold logic still pass: `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold` (narrower than full `pnpm test`, targets the actual change surface).
- [ ] A scratch `codev init` (or equivalent) into a tmp directory produces the new richer arch.md, the new lessons-learned.md preface, the new arch-md-guide.md, and (in the project's `.claude/skills/`) the `update-arch-docs` skill.

## Constraints

### Technical Constraints

- **Skill format compliance**: The new skill must conform to Claude Code's skill format (frontmatter with `name` and `description`; SKILL.md as the entry point; located under `.claude/skills/<name>/SKILL.md`).
- **Skill is guidance-only**: The SKILL.md body must not include shell commands that delete files, no `git rm` invocations, no `rm -rf`, no destructive sed scripts. Pruning produces a *list of candidates* or a *proposed diff* surfaced for human review; the skill never executes the cuts itself. This is an explicit instruction inside the skill body and a code-review check on the PR.
- **Skeleton/main parity**: `codev-skeleton/` is the template propagation source for other projects (`codev init`/`adopt` copies from it; `codev update` propagates `.claude/skills/` with `skipExisting: true` so new skills land in existing projects on next update, but does NOT propagate `templates/`). Files in `codev/` that have skeleton equivalents must be kept byte-identical (current diff verified empty for `templates/arch.md`, `templates/lessons-learned.md`, and `protocols/maintain/protocol.md`).
- **Step 3 sub-step split, not renumber**: Existing maintenance runs should still complete. The audit-pass is a sub-step split inside Step 3 ("Sync Documentation") into Step 3a (Audit) and Step 3b (Update). Steps 1, 2, and 4 keep their numbering. This preserves the existing top-level structure for tools/runners that key off it.
- **No deletion of the existing agent file**: `~/.claude/agents/architecture-documenter.md` is a user-global file outside this repo. We do not touch it. The skill uses a different name (`update-arch-docs`) to avoid invocation collision; both can coexist. The skill body explicitly notes this in a "Relationship to the architecture-documenter agent" section, so users running both don't get confused.

### Business Constraints

- **Scope-bounded**: This spec implements exactly the six items listed in issue #723. Anything in the "Out of Scope" section is deferred to follow-up issues.
- **No live-doc rewrites in this spec**: The rewrite of `codev/resources/arch.md` itself is explicitly out of scope. This spec only ships governance.

## Assumptions

- The Claude Code skill format and discovery mechanism (the `.claude/skills/` directory, SKILL.md frontmatter) is stable and available to the audience consuming Codev.
- MAINTAIN consumers run their AI assistant inside the project worktree, which gives skills the chance to surface.
- Existing skills in this repo (`afx`, `consult`, `porch`, `codev`, `forge`, `team`, `skill-creator`, `generate-image`) are working examples of the format we should follow.
- The architect will not block on the "self-consistency check" success criterion — it is a smoke test, not a deliverable.

## Solution Approaches

### Approach 1: Skill + template replacement + MAINTAIN protocol edits (chosen)

**Description**: Implement all six items as a coordinated set of edits. The skill is the new home for the documenter's discipline; the template replacement is a one-time content swap; the MAINTAIN protocol gets new sub-sections (matrix, audit pass, checklists). Apply each change in both `codev/` and `codev-skeleton/` so both internal and downstream users benefit.

**Pros**:
- Faithful to the issue's six-item scope.
- Each change is a small, reviewable diff.
- Composes well: the new skill reads naturally when invoked from the MAINTAIN protocol's audit-pass step.
- Leaves the live arch.md untouched, so reviewers can validate the governance without drowning in 1,800-line cleanup diffs.

**Cons**:
- Six edits across multiple files create some review surface.
- The skill duplicates concerns also articulated in the MAINTAIN protocol; we have to be careful not to write the same guidance twice in different voices.

**Estimated Complexity**: Medium
**Risk Level**: Low (no executable code; all changes are docs/skill content)

### Approach 2: Single combined "doc-governance.md" file

**Description**: Collapse the skill, the new arch-md-guide, and the new MAINTAIN sub-sections into one canonical governance file that all the others link to.

**Pros**:
- One source of truth.
- No duplication.

**Cons**:
- Skills must self-contain their triggering content (frontmatter + body) to be discoverable. A skill that only `cat`s another file gives a worse triggering experience.
- The MAINTAIN protocol benefits from inlining the matrix and checklists where they're used; pointer-only is harder to follow during execution.
- Diverges from how other Codev skills are structured (each is a self-contained directory).

**Decision**: Reject. The duplication concern is real but mitigated by careful authoring; the discoverability and locality wins of Approach 1 outweigh the DRY win.

### Approach 3: Defer the skill conversion; only ship template + MAINTAIN edits

**Description**: Leave `architecture-documenter` as a user-global agent for now; ship the richer template, the guide, and the MAINTAIN updates.

**Pros**:
- Smaller diff. Faster ship.

**Cons**:
- The issue explicitly identifies the skill conversion as the natural place to bake in pruning discipline. Skipping it leaves the agent's prompt as the dominant influence on documenter behavior, undercutting the MAINTAIN-side improvements.
- Leaves a known gap that will need a follow-up.

**Decision**: Reject. The skill is the keystone.

## Resolved Decisions

These were open questions in the initial draft. Resolved during 3-way consultation:

- **Skill name**: `update-arch-docs`. Action-oriented, distinguishable from the user-global `architecture-documenter` agent, and avoids the same-name shadowing/ambiguity concern raised by Gemini and Claude reviewers.
- **Skeleton skill location**: `codev-skeleton/.claude/skills/update-arch-docs/SKILL.md`. The skeleton does have a `.claude/skills/` directory (verified: contains `afx`, `codev`, `consult`, `generate-image`, `porch`). New skills propagate to existing downstream projects via `codev update` (calls `copySkills` with `skipExisting: true`).
- **Diff-mode vs audit-mode**: Both are behaviors selected from invocation phrasing, but each has its own named section in the skill body so the contrast is explicit. The skill never auto-acts in audit-mode — output is a candidate-cuts list for human review.
- **Step 3 restructuring**: Sub-step split into 3a (Audit) and 3b (Update). Top-level step numbers 1, 2, 4 are unchanged.
- **Template propagation**: `codev update` does NOT copy templates — only `init`/`adopt` does. The new richer arch.md template only lands in *new* projects. Existing projects need to manually copy if they want the new template; this is documented in the arch-md-guide preface so users aren't surprised.

## Open Questions

### Important (Affects Design)

- [ ] **"Lives where" matrix exact rows**: The issue offers a starter matrix; final rows to be locked down during the plan phase. Builder will propose, architect approves at plan-approval gate.

### Nice-to-Know (Optimization)

- [ ] **Self-consistency check scope**: How thorough should the smoke-test against the existing 1,812-line arch.md be? Default: 3–5 illustrative findings recorded in the review document, not a comprehensive audit.

## Test Scenarios

### Functional Tests

1. **Skill literal-content check**: `cat .claude/skills/update-arch-docs/SKILL.md` and confirm: the frontmatter `description` contains the required phrases ("arch.md", "lessons-learned.md", "MAINTAIN", trigger sentence) and the body contains the required named sections (`## What this skill does NOT do`, `## arch.md vs. lessons-learned.md (two-doc framing)`, `## Sizing by purpose, not by line count`, `## Mode: diff-mode (apply a specific change)`, `## Mode: audit-mode (identify what to cut)`, `## Output contract`, `## Relationship to the architecture-documenter agent`).
2. **Skill discovery (manual)**: With Claude Code running in this repo, type `/update-arch-docs` and confirm the skill loads. Result is recorded in the review document. (Behavioral; verified manually, not as a deterministic acceptance criterion.)
3. **Skill propagation via update**: In a scratch sandbox project that has Codev installed (without the new skill), run `codev update` and verify `.claude/skills/update-arch-docs/SKILL.md` is now present.
4. **Template smoke-test**: Run `codev init scratch-project` in a tmp directory; verify `codev/resources/arch.md` matches the new richer template, `codev/resources/lessons-learned.md` matches the new template, and `codev/templates/arch-md-guide.md` is present.
5. **MAINTAIN audit-pass dry-run**: Walk through Step 3 (now 3a + 3b) of the updated MAINTAIN protocol against `codev/resources/arch.md`. Verify Step 3a produces a reviewable list of "sections to cut" before Step 3b runs, and that the run file format includes a section for audit findings.
6. **Skeleton/main parity**: `diff -r codev/templates/ codev-skeleton/templates/` produces no output for the touched files. Same parity check for `protocols/maintain/protocol.md` and the new skill directory.
7. **Targeted test run**: `pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold` passes.
8. **Self-consistency check**: Use audit-mode against `codev/resources/arch.md`. Record at least 3 categories of candidate cuts in the review document. (Smoke test only; cuts are NOT applied.)

### Non-Functional Tests

1. **Template readability**: A human reader unfamiliar with Codev should be able to skim the new arch.md template and the arch-md-guide and answer "what goes here? what does NOT go here?" in under 2 minutes.
2. **Skill triggering quality (informational)**: The skill's `description` is specific enough that Claude doesn't surface it on unrelated work but does surface it for "update the architecture doc" / "what should I prune from arch.md" / MAINTAIN protocol contexts. This is informational because triggering depends on the LLM; the deterministic checks above guard the literal content.

## Dependencies

- **External Services**: None.
- **Internal Systems**: 
  - Claude Code skill format (consumed)
  - MAINTAIN protocol (modified)
  - `codev update` mechanism for propagating skeleton changes (relied on, not modified)
- **Libraries/Frameworks**: None.

## References

- GitHub Issue: #723 — Improve arch.md / lessons-learned.md governance
- Existing agent prompt: `~/.claude/agents/architecture-documenter.md` (user-global, read-only for this work)
- Existing MAINTAIN protocol: `codev/protocols/maintain/protocol.md`
- Existing arch.md template: `codev/templates/arch.md`, `codev-skeleton/templates/arch.md`
- Existing skills in repo: `.claude/skills/{afx,codev,consult,forge,porch,team,skill-creator,generate-image}/`
- Live arch.md (target of governance, not edited here): `codev/resources/arch.md`
- Live lessons-learned.md (target of governance, not edited here): `codev/resources/lessons-learned.md`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Skill format changes underneath us | Low | Medium | Pin to current frontmatter shape; verify against existing skills before shipping. |
| Skeleton-vs-codev drift introduced by this spec | Medium | Medium | `diff -r` parity check is a success criterion; verified before PR. |
| Skill duplicates MAINTAIN protocol content verbatim | Medium | Low | Skill owns discipline (what NOT to include, two-doc framing); MAINTAIN owns flow (audit then update). Cross-link rather than copy. |
| Audit pass becomes paralyzing — runs find too much to cut and protocol stalls | Low | Medium | The audit pass produces a *list*, not a deletion. Updates are gated on architect approval (existing MAINTAIN PR review). New checklists are guides, not blockers. |
| The new richer template feels too prescriptive for small projects | Medium | Low | Explicit "skip what doesn't apply" framing; preface that walks readers through optional vs. required sections. |
| Future MAINTAIN run aggressively prunes a section that turns out to be load-bearing | Low | Medium | Pruning happens during the update-pass with architect review on the PR; "when in doubt, KEEP" rule preserved from existing MAINTAIN governance. The skill is guidance-only by constraint — never executes cuts. |
| The skill never triggers because Claude Code doesn't surface it | Low | High | Manual smoke test during implementation; deterministic literal-content checks guard the description content. Discovery configuration documented in arch-md-guide if needed. |
| Naming collision with user-global `architecture-documenter` agent | Resolved | — | Skill named `update-arch-docs` instead. Both can coexist; skill body has a "Relationship to architecture-documenter agent" section to disambiguate. |
| Existing projects don't pick up the new arch.md template (because `codev update` doesn't copy templates) | Medium | Low | Documented in arch-md-guide preface and in the spec's Resolved Decisions. Existing projects opt in by manually copying. The skill propagates via `update`, so the *governance discipline* still reaches them even if the template doesn't. |

## Out of Scope (separate issues)

The following are flagged for follow-up but not implemented here:

- Surfacing the four general framework principles ("be opinionated about where facts live"; "ship guidance for what NOT to include alongside what to include"; "make pruning first-class"; "distinguish system-shape from engineering-wisdom") in top-level Codev framework guidance.
- First-class documentation of the `codev/architecture/<domain>.md` meta-spec pattern.
- `current-thread.md` save-state convention.
- "Doc maintenance" checklist item in spec review templates.
- Line-count diff visibility / threshold-based MAINTAIN flagging.
- The actual cleanup of the existing 1,812-line `codev/resources/arch.md` and 371-line `codev/resources/lessons-learned.md`. That belongs to a future MAINTAIN run that *uses* this governance.

## Expert Consultation

**Date**: 2026-05-05
**Models Consulted**: Gemini 3 Pro, GPT-5.4 Codex, Claude (3-way via `consult`)
**Verdicts**: Gemini COMMENT (HIGH), Codex REQUEST_CHANGES (HIGH), Claude COMMENT (HIGH)

**Sections Updated** based on consultation feedback:

- **Current State / Open Questions**: Removed false claim that `codev-skeleton/` lacks a `.claude/skills/` directory (it has one — verified). Moved this from "open" to "resolved" decisions.
- **Resolved Decisions** (new section): Locked down skill name (`update-arch-docs` to avoid collision with the user-global agent), skill location, mode framing, Step 3 split semantics, and template propagation expectation.
- **Success Criteria**: Restructured into deterministic literal-content checks for the skill (frontmatter phrases, required named sections), explicit `lessons-learned.md` template criteria (matching the `arch.md` improvements), and a narrower test-run criterion (`pnpm --filter @cluesmith/codev test -- --testPathPatterns=scaffold`) instead of full `pnpm build && pnpm test`.
- **Constraints**: Added "skill is guidance-only" constraint (no destructive shell commands; pruning produces candidate lists, not actual cuts) per Codex security feedback. Clarified skeleton-vs-codev propagation semantics for both skills (`copySkills` with `skipExisting`) and templates (only `init`/`adopt`, not `update`).
- **Desired State**: Added explicit lessons-learned.md template improvement, added "guidance-only" framing for the skill, added "audit findings recorded in run file" requirement.
- **Test Scenarios**: Added literal-content check, skill propagation via `update`, scaffold-targeted test run, and self-consistency check; clarified that skill-triggering tests are informational not deterministic.
- **Risks**: Added "naming collision with user-global agent" risk and its mitigation (different skill name).

## Approval

- [ ] Architect Review
- [ ] 3-way consultation complete (gemini, codex, claude)
- [ ] Spec-approval gate signaled

## Notes

This spec is structurally a "governance change" spec, not a feature spec. It produces no executable code. The plan that follows will likely be a single-phase plan that touches ~6 files (skill, two templates, two arch-md-guide files, two MAINTAIN protocols, possibly a small MAINTAIN reference in CLAUDE.md/AGENTS.md if needed). The "phases" framing of SPIR may collapse to one or two implementation phases.
