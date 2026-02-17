# Plan: Public Documentation Audit for v2.0.7

## Metadata
- **ID**: plan-2026-02-17-documentation-audit
- **Status**: draft
- **Specification**: codev/specs/386-documentation-audit.md
- **Created**: 2026-02-17

## Executive Summary

Systematic audit and update of all public-facing and developer-facing markdown documentation across three tiers: public-facing (GitHub visitors), developer reference (architects/builders), and skeleton templates (shipped to other projects). Work is organized tier-by-tier, with a final cross-cutting verification phase.

**Current state findings:**
- Root README.md EXISTS (contrary to spec's initial claim — needs audit for accuracy)
- CHANGELOG.md exists but only covers up to an unreleased section — needs entries through v2.0.7
- CLAUDE.md and AGENTS.md at root are confirmed IDENTICAL (no drift)
- Release notes exist through v2.0.3 — missing notes for tagged releases v2.0.1, v2.0.2, v2.0.6
- Stale references found in ~15 in-scope files across all tiers (tmux, ttyd, state.json, codev tower, etc.)

## Success Metrics
- [ ] All spec acceptance criteria met
- [ ] Zero stale references (tmux, ttyd, state.json, ports.json, npx agent-farm, consult general, codev tower, dashboard-server, projectlist.md) in any audited file
- [ ] All CLI examples use current v2.0.7 syntax
- [ ] Release notes exist for every tagged release
- [ ] CLAUDE.md/AGENTS.md pairs confirmed in sync
- [ ] Obsolete files identified and listed

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "tier_1_public", "title": "Tier 1: Public-Facing Documents"},
    {"id": "tier_2_developer", "title": "Tier 2: Developer Reference"},
    {"id": "tier_3_skeleton", "title": "Tier 3: Skeleton Templates"},
    {"id": "final_verification", "title": "Final Verification & Obsolete File Report"}
  ]
}
```

## Phase Breakdown

### Phase 1: Tier 1 - Public-Facing Documents
**Dependencies**: None

#### Objectives
- Audit and update all documents visible to GitHub visitors
- Fix all stale references in Tier 1 files
- Fill the release notes gap for tagged releases

#### Files to Modify/Create
- `README.md` — audit for v2.0.7 accuracy (architecture, features, CLI syntax)
- `CHANGELOG.md` — add entries for v1.1.0 through v2.0.7 (sourced from docs/releases/ and git history)
- `docs/releases/v2.0.1.md` — CREATE: release notes for v2.0.1
- `docs/releases/v2.0.2.md` — CREATE: release notes for v2.0.2
- `docs/releases/v2.0.6.md` — CREATE: release notes for v2.0.6
- `docs/why.md` — audit for stale architecture descriptions
- `docs/faq.md` — audit for outdated Q&As
- `docs/tips.md` — audit and fix stale references (confirmed hit)
- `examples/todo-manager/README.md` — audit for current CLI syntax
- `CLAUDE.md` / `AGENTS.md` — verify sync (confirmed identical; audit content for v2.0.7 accuracy)

#### Acceptance Criteria
- [ ] README.md accurately describes v2.0.7 architecture (Shellper, Porch, Tower, consult v2)
- [ ] CHANGELOG.md has entries for all releases v1.0.0 through v2.0.7
- [ ] Release notes exist for v2.0.1, v2.0.2, v2.0.6
- [ ] Zero stale references in any Tier 1 file
- [ ] CLAUDE.md and AGENTS.md confirmed identical
- [ ] docs/why.md, docs/faq.md, docs/tips.md audited and updated

#### Test Plan
- **Verification**: Grep all Tier 1 files for stale patterns — expect zero hits
- **Manual**: Verify CHANGELOG.md structure matches Keep a Changelog format
- **Manual**: Diff CLAUDE.md and AGENTS.md — expect identical

#### Risks
- **Risk**: Release notes for v2.0.1/v2.0.2/v2.0.6 require understanding changes from git history
  - **Mitigation**: Use `git log v2.0.0..v2.0.1`, etc. to source accurate content

---

### Phase 2: Tier 2 - Developer Reference
**Dependencies**: None (can run independently of Phase 1)

#### Objectives
- Audit all developer-facing reference documents for v2.0.7 accuracy
- Fix stale references to removed features
- Ensure CLI command references use current syntax

#### Files to Modify
- `codev/resources/arch.md` — audit architecture description (confirmed stale hits)
- `codev/resources/cheatsheet.md` — audit concepts and tool reference (confirmed stale hits)
- `codev/resources/workflow-reference.md` — audit stage-by-stage workflow
- `codev/resources/commands/overview.md` — audit CLI quick start
- `codev/resources/commands/codev.md` — audit codev CLI reference (confirmed stale hits)
- `codev/resources/commands/agent-farm.md` — audit af CLI reference (confirmed stale hits)
- `codev/resources/commands/consult.md` — audit consult CLI reference
- `codev/resources/testing-guide.md` — audit Playwright and testing docs
- `codev/resources/protocol-format.md` — audit protocol definition format
- `codev/resources/lessons-learned.md` — audit extracted wisdom (confirmed stale hits)
- `codev/resources/lifecycle.md` — audit project lifecycle (confirmed stale hits)
- `codev/resources/conceptual-model.md` — audit conceptual model
- `codev/resources/identity-and-porch-design.md` — audit porch design doc
- `codev/resources/agent-farm.md` — audit AF architecture doc

#### Acceptance Criteria
- [ ] Zero stale references in any Tier 2 file
- [ ] All CLI examples use current syntax (af tower, consult --prompt, etc.)
- [ ] Architecture description matches v2.0.7 (Shellper, Porch, Tower single daemon)
- [ ] Each file verified and committed

#### Test Plan
- **Verification**: Grep all Tier 2 files for stale patterns — expect zero hits
- **Manual**: Spot-check CLI examples against actual `--help` output

#### Risks
- **Risk**: Some developer reference files may document features that partially changed (not fully removed)
  - **Mitigation**: Cross-reference with current codebase before editing

---

### Phase 3: Tier 3 - Skeleton Templates
**Dependencies**: None (can run independently)

#### Objectives
- Audit all files that ship to other projects via codev-skeleton
- Fix stale references and ensure current CLI syntax
- Verify skeleton CLAUDE.md/AGENTS.md template pair

#### Files to Modify
- `codev-skeleton/templates/CLAUDE.md` — audit template for current architecture
- `codev-skeleton/templates/AGENTS.md` — verify identical to CLAUDE.md template
- `codev-skeleton/templates/cheatsheet.md` — audit cheatsheet template
- `codev-skeleton/templates/arch.md` — audit architecture template
- `codev-skeleton/templates/lessons-learned.md` — audit lessons template
- `codev-skeleton/templates/lifecycle.md` — audit lifecycle template
- `codev-skeleton/templates/pr-overview.md` — audit PR overview template
- `codev-skeleton/resources/commands/overview.md` — audit CLI overview
- `codev-skeleton/resources/commands/agent-farm.md` — audit af reference (confirmed stale hits)
- `codev-skeleton/resources/commands/codev.md` — audit codev reference (confirmed stale hits)
- `codev-skeleton/resources/commands/consult.md` — audit consult reference
- `codev-skeleton/resources/workflow-reference.md` — audit workflow reference
- `codev-skeleton/resources/spikes.md` — audit spikes guide
- `codev-skeleton/builders.md` — audit builder instructions
- `codev-skeleton/DEPENDENCIES.md` — audit dependencies doc
- `codev-skeleton/roles/*.md` — audit role definitions

#### Acceptance Criteria
- [ ] Zero stale references in any Tier 3 file
- [ ] Skeleton CLAUDE.md and AGENTS.md templates are identical
- [ ] All CLI examples in skeleton use current syntax
- [ ] Role definitions reference current architecture

#### Test Plan
- **Verification**: Grep all Tier 3 files for stale patterns — expect zero hits
- **Manual**: Diff skeleton CLAUDE.md and AGENTS.md templates — expect identical

#### Risks
- **Risk**: Skeleton templates may have placeholder syntax ({{PROJECT_NAME}}) that shouldn't be changed
  - **Mitigation**: Preserve all placeholder syntax, only update stale content references

---

### Phase 4: Final Verification & Obsolete File Report
**Dependencies**: Phases 1, 2, 3

#### Objectives
- Verify all acceptance criteria from the spec are met
- Compile list of obsolete files with recommended actions
- Final stale reference sweep across ALL audited files

#### Deliverables
- [ ] Full stale reference re-grep with zero hits across all tiers
- [ ] Obsolete file report listing files to archive or delete
- [ ] PR description checklist of all changes made
- [ ] All acceptance criteria from spec verified

#### Acceptance Criteria
- [ ] `grep -r` for all 8 stale patterns returns zero hits in audited files
- [ ] Obsolete files identified with recommended action
- [ ] Complete change manifest ready for PR description

#### Test Plan
- **Verification**: Run comprehensive grep for all stale patterns across all in-scope files
- **Manual**: Walk through spec acceptance criteria checklist item by item

#### Risks
- **Risk**: May discover additional stale patterns not in the original known-issues list
  - **Mitigation**: Document any newly discovered patterns and fix them

---

## Dependency Map
```
Phase 1 (Tier 1) ─┐
Phase 2 (Tier 2) ─┼──→ Phase 4 (Final Verification)
Phase 3 (Tier 3) ─┘
```

Phases 1-3 are independent and can be executed in any order. Phase 4 depends on all three being complete.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Release notes require deep git archaeology | M | L | Use git log between tags + existing release notes as source |
| Some stale references may be in valid historical context | L | L | Only fix references that are presented as current/instructional |
| Skeleton templates have complex placeholder syntax | L | M | Preserve all {{}} placeholders, only update content |

## Notes
- The spec claims no root README.md exists, but one was found during planning. It will be audited for accuracy rather than created from scratch.
- Package version is 2.0.7 but latest git tag is v2.0.6. No v2.0.4, v2.0.5, or v2.0.7 tags exist.
- Release notes will be created only for tagged releases: v2.0.1, v2.0.2, v2.0.6.
- Files explicitly out of scope: protocol .md files, porch prompts, consult type files, specs/plans/reviews, analysis documents.
- MIGRATION-1.0.md and INSTALL.md are not in spec scope but have stale references — will flag in obsolete file report.
