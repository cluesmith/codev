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

1. **The architecture-documenter is a skill**, invoked as a standard step by the MAINTAIN protocol (and available ad-hoc). Its prompt embodies discipline about **what NOT to include** and the **two-doc framing** (arch.md owns system-shape; lessons-learned.md owns durable engineering wisdom).

2. **The shipped `codev/templates/arch.md`** (and the matching `codev-skeleton/templates/arch.md`) is a richer template with a preface, opinionated section stubs, and explicit "skip what doesn't apply" framing. New projects start with a doc that *teaches* its own maintenance norms.

3. **A new sibling `codev/templates/arch-md-guide.md`** ships alongside the template. ~30–60 lines. Tells future maintainers (human or AI) how to keep arch.md healthy: when to update, how to update, what NOT to put in, sanity-check checklist.

4. **The MAINTAIN protocol** carries a **"Lives where"** matrix that routes each fact/insight to the right home, plus a **two-phase audit-then-update** flow with concrete pruning checklists.

5. **Both `codev-skeleton/` (template-for-others) and `codev/` (self-hosted)** carry the changes. Other projects pulling Codev get the upgraded governance; this repo also benefits from it.

The deliverables are governance-doc edits — they do not change live `arch.md` / `lessons-learned.md` content directly. Cleanup of the existing 1,812-line `arch.md` is a separate MAINTAIN run that *uses* the new governance once it lands.

## Stakeholders

- **Primary Users**: AI builders and architects (Claude Code, Cursor, Copilot users) running MAINTAIN or invoking architecture documentation work.
- **Secondary Users**: Human maintainers of Codev-using projects who read these files.
- **Technical Team**: This builder (project 723) implements; architect approves; users of `codev-skeleton/` inherit on next `codev update`.
- **Decision Authority**: Codev project owner (architect).

## Success Criteria

- [ ] An `architecture-documenter` skill exists at `.claude/skills/architecture-documenter/SKILL.md` (in this repo) and at the equivalent path in `codev-skeleton/` so other projects inherit it on `codev update`.
- [ ] The skill's `description` triggers on MAINTAIN-driven invocations and on ad-hoc "update arch.md" requests.
- [ ] The skill body contains: explicit "What NOT to include" section, two-doc framing (arch.md vs. lessons-learned.md), purpose-driven sizing guidance, and two operating modes (diff-mode and audit-mode).
- [ ] `codev/templates/arch.md` and `codev-skeleton/templates/arch.md` are replaced with a richer template that includes a preface, the opinionated section stubs listed in the issue, and "skip what doesn't apply" framing. Both files are byte-identical (Codev's convention).
- [ ] `codev/templates/arch-md-guide.md` and `codev-skeleton/templates/arch-md-guide.md` exist with ~30–60 lines of governance guidance. Both files are byte-identical.
- [ ] `codev/protocols/maintain/protocol.md` and `codev-skeleton/protocols/maintain/protocol.md` carry: the "Lives where" matrix, the audit-pass-before-update-pass split (with sample audit prompt), and per-section / per-entry pruning checklists. Both files are byte-identical.
- [ ] No live `arch.md` / `lessons-learned.md` content is rewritten as part of this spec — that work belongs to a future MAINTAIN run.
- [ ] A self-consistency check: applying the new governance to the existing 1,812-line `codev/resources/arch.md` would identify at least 3 distinct categories of cuts (per-spec changelog, exhaustive enumerations, aspirational sections). The review document records this check.
- [ ] All builds and tests pass (`pnpm build && pnpm test` from `packages/codev/`).

## Constraints

### Technical Constraints

- **Skill format compliance**: The new skill must conform to Claude Code's skill format (frontmatter with `name` and `description`; SKILL.md as the entry point; located under `.claude/skills/<name>/SKILL.md`).
- **Skeleton/main parity**: `codev-skeleton/` is the template that gets copied to other projects via `codev init` / `codev update`. Files in `codev/` that have skeleton equivalents must be kept in sync (current diff verified empty for `templates/arch.md` and `templates/lessons-learned.md` and `protocols/maintain/protocol.md`).
- **No breaking changes to MAINTAIN's contract**: Existing maintenance runs should still be able to execute. The audit-pass should be additive: a new sub-step inside Step 3, not a renumbering that disrupts in-flight runs.
- **No deletion of the existing agent file**: `~/.claude/agents/architecture-documenter.md` is a user-global file outside this repo. We do not touch it. The skill is a parallel artifact; users who want it must ensure their Claude Code is configured to discover skills in this project.

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

## Open Questions

### Critical (Blocks Progress)

- [ ] **Skill name**: Should the skill be `architecture-documenter` (matches the agent name) or something more action-oriented like `update-arch-md`? Default: `architecture-documenter` for continuity. Reviewer feedback welcome.

### Important (Affects Design)

- [ ] **Where exactly does the skill live in `codev-skeleton/`?** The skeleton currently does not have a `.claude/skills/` directory. We need to confirm whether skills get copied via `codev update` or whether they're only picked up from the consuming project's local `.claude/`. If they don't propagate via the skeleton, the skeleton-side artifact may need to be a markdown reference file the user copies manually.
- [ ] **"Diff-mode" vs "audit-mode" framing**: The issue calls these out explicitly. Diff-mode = "apply a specific change to the smallest section that needs updating." Audit-mode = "read against principles, identify what to cut, ask for confirmation before removing." Should these be modes the skill exposes via its description, or behaviors the skill chooses based on the invocation phrasing? Default: behaviors selected from invocation phrasing, with the skill's body explicitly contrasting them.
- [ ] **"Lives where" matrix exact rows**: The issue offers a starter matrix but flags "Categories and exact rows to be refined during implementation." Implementation work needs to lock these down.

### Nice-to-Know (Optimization)

- [ ] **Smoke-test scope**: How thorough should the "self-consistency check" against the existing 1,812-line arch.md be? Default: 3-5 illustrative findings recorded in the review document, not a comprehensive audit.

## Test Scenarios

### Functional Tests

1. **Skill discovery**: With Claude Code running in this repo, type `/architecture-documenter` (or paraphrased natural-language invocation) and confirm the skill is offered. Confirm equivalent in a fresh project that has run `codev update` to pull the skeleton.
2. **MAINTAIN audit-pass dry-run**: Walk through Step 3 of the updated MAINTAIN protocol against `codev/resources/arch.md`. Verify the audit checklist produces a reviewable list of "sections to cut" before any update is made.
3. **Template smoke-test**: Run `codev init` (or read the skeleton path) in a scratch directory; verify `codev/resources/arch.md` is the new richer template, and `codev/templates/arch-md-guide.md` is present.
4. **Skeleton/main parity**: After all edits, `diff -r codev/templates/ codev-skeleton/templates/` produces no output for the touched files. Same for the maintain protocol.

### Non-Functional Tests

1. **Template readability**: A human reader unfamiliar with Codev should be able to skim the new arch.md template and the arch-md-guide and answer "what goes here? what does NOT go here?" in under 2 minutes.
2. **Skill triggering**: The skill's `description` is specific enough that Claude doesn't surface it on unrelated work but does surface it for "update the architecture doc" / "what should I prune from arch.md" / MAINTAIN protocol contexts.

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
| Skeleton-vs-codev drift introduced by this spec | Medium | Medium | Add a parity check to the success criteria; verify with `diff -r` before PR. |
| Skill duplicates MAINTAIN protocol content verbatim | Medium | Low | Author the skill to own discipline (what NOT to include, two-doc framing); MAINTAIN owns flow (audit then update). Cross-link rather than copy. |
| Audit pass becomes paralyzing — runs find too much to cut and protocol stalls | Low | Medium | The audit pass produces a *list*, not a deletion. Updates are gated on architect approval (existing MAINTAIN PR review). The new checklists are guides, not blockers. |
| The new richer template feels too prescriptive for small projects | Medium | Low | Explicit "skip what doesn't apply" framing; preface that walks readers through optional vs. required sections. |
| Future MAINTAIN run aggressively prunes a section that turns out to be load-bearing | Low | Medium | Pruning happens during the update-pass with architect review on the PR; "when in doubt, KEEP" rule preserved from existing MAINTAIN governance. |
| The skill never triggers because Claude Code doesn't surface it | Low | High | Validate during implementation against this repo's `.claude/skills/` to confirm discovery. Document the configuration step in the arch-md-guide if needed. |

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
**Sections Updated**: To be filled in after consultation round.

## Approval

- [ ] Architect Review
- [ ] 3-way consultation complete (gemini, codex, claude)
- [ ] Spec-approval gate signaled

## Notes

This spec is structurally a "governance change" spec, not a feature spec. It produces no executable code. The plan that follows will likely be a single-phase plan that touches ~6 files (skill, two templates, two arch-md-guide files, two MAINTAIN protocols, possibly a small MAINTAIN reference in CLAUDE.md/AGENTS.md if needed). The "phases" framing of SPIR may collapse to one or two implementation phases.
