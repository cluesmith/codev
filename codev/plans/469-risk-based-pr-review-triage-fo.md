# Plan: Risk-Based PR Review Triage for Architect

## Metadata
- **ID**: plan-469
- **Status**: draft
- **Specification**: codev/specs/469-risk-based-pr-review-triage-fo.md
- **Created**: 2026-02-21

## Executive Summary

Implement risk-based PR review triage as a **documentation-only change**. Update the architect role, workflow reference, and create a risk triage guide. No CLI code changes — the architect uses existing tools (`gh pr diff --stat`, existing `consult` commands) with new decision guidance.

This follows Approach 2 from the spec (Documentation Only), per architect feedback that a CLI command is overkill.

## Success Metrics
- [ ] Architect role includes risk triage decision framework at integration review step
- [ ] Workflow reference documents conditional review depth at Stage 6
- [ ] Risk triage guide exists with criteria, subsystem mappings, and example workflows
- [ ] All `codev/` and `codev-skeleton/` versions are in sync

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "architect_prompt", "title": "Architect Prompt & Role Updates"},
    {"id": "reference_docs", "title": "Workflow Reference & Triage Guide"}
  ]
}
```

## Phase Breakdown

### Phase 1: Architect Prompt & Role Updates
**Dependencies**: None

#### Objectives
- Update the architect role document with the risk triage decision framework
- Replace the fixed "always 3-way CMAP" integration review with a conditional triage

#### Deliverables
- [ ] Modified: `codev/roles/architect.md` — risk triage framework in Section 4 (Integration Review)
- [ ] Modified: `codev-skeleton/roles/architect.md` — same changes for skeleton

#### Implementation Details

**Replace Section 4 "Integration Review" in `architect.md`** with:

1. **Assess risk** — Run `gh pr diff --stat <N>` to see size/scope, then decide:

| Risk | Criteria | Action |
|------|----------|--------|
| **Low** | Small diff (<100 lines, 1-3 files), isolated change, bugfixes, docs, cosmetic | Read PR, summarize root cause + fix, tell builder to merge |
| **Medium** | Moderate diff (100-500 lines, 4-10 files), touches shared code, new features | Run single-model integration review: `consult -m claude --type integration pr N` |
| **High** | Large diff (>500 lines, >10 files), core subsystems, security, protocol changes | Full 3-way CMAP: run Gemini + Codex + Claude in parallel |

2. **Highest factor wins** — If any single factor (lines, files, or subsystem) is high-risk, treat the whole PR as high-risk.

3. **Typical mappings** — Low: most bugfixes, ASPIR, docs. Medium: SPIR features, new commands. High: protocol changes, Tower, porch, security.

4. Keep existing examples for posting findings as PR comments and notifying builder.

#### Acceptance Criteria
- [ ] Architect role documents triage as the first step in integration review
- [ ] Triage table includes all three levels with clear criteria and actions
- [ ] `codev/` and `codev-skeleton/` versions are identical

#### Test Plan
- **Manual review**: Read the updated role doc to verify it's clear and actionable

#### Rollback Strategy
- Revert to previous version via git

---

### Phase 2: Workflow Reference & Triage Guide
**Dependencies**: Phase 1

#### Objectives
- Update workflow reference to show conditional review at Stage 6
- Create a standalone risk triage reference document with subsystem mappings

#### Deliverables
- [ ] Modified: `codev/resources/workflow-reference.md` — conditional review at Stage 6
- [ ] Modified: `codev-skeleton/resources/workflow-reference.md` — same changes
- [ ] New: `codev/resources/risk-triage.md` — complete risk triage reference
- [ ] New: `codev-skeleton/resources/risk-triage.md` — same for skeleton

#### Implementation Details

**Workflow reference (`workflow-reference.md`)**:
Update Stage 6 (COMMITTED) from:
```
Architect does 3-way integration review
```
To:
```
Architect assesses PR risk (gh pr diff --stat)
Low: Read + merge | Medium: 1-model review | High: 3-way CMAP
```

Also update the "Review Types" table to note that integration reviews have variable depth based on risk.

**Risk triage guide (`risk-triage.md`)**:
New reference document containing:
- Risk criteria table (lines, files, subsystem)
- Precedence rule: highest factor wins
- Subsystem-to-risk mapping table:

| Subsystem | Path Patterns | Risk |
|-----------|--------------|------|
| Protocol orchestrator | `packages/codev/src/commands/porch/` | High |
| Tower architecture | `packages/codev/src/tower/` | High |
| State management | `packages/codev/src/state/` | High |
| Protocol definitions | `codev/protocols/`, `codev-skeleton/protocols/` | High |
| Agent Farm commands | `packages/codev/src/commands/af/` | Medium |
| Consultation system | `packages/codev/src/commands/consult/` | Medium |
| Shared libraries | `packages/codev/src/lib/` | Medium |
| CLI commands (other) | `packages/codev/src/commands/` | Medium |
| Role definitions | `codev/roles/`, `codev-skeleton/roles/` | Medium |
| Documentation | `codev/resources/`, `*.md` | Low |
| Project artifacts | `codev/specs/`, `codev/plans/`, `codev/reviews/` | Low |
| Tests only | `packages/codev/tests/` | Low |

- Example workflows for each risk level (what the architect does step-by-step)
- Quick reference card

#### Acceptance Criteria
- [ ] Workflow reference shows conditional review at Stage 6
- [ ] Risk triage guide has complete subsystem mappings
- [ ] Example workflows are clear and actionable
- [ ] `codev/` and `codev-skeleton/` versions are in sync

#### Test Plan
- **Manual review**: Read all docs for consistency and completeness
- **Cross-reference**: Verify workflow reference and triage guide are consistent with architect role

#### Rollback Strategy
- Revert documentation files via git

---

## Dependency Map
```
Phase 1: Architect Prompt ──→ Phase 2: Reference Docs
```

Phase 2 depends on Phase 1 because the triage guide and workflow reference should reference the same framework established in the architect role.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Subsystem mappings become outdated | Low | Low | Easy to update; highest-factor-wins provides safety net |
| Architects ignore triage and always CMAP | Low | Low | Documentation makes cost/benefit clear |

## Validation Checkpoints
1. **After Phase 1**: Architect role reads clearly with triage framework
2. **After Phase 2**: All documentation is consistent across files

## Notes

No code changes. The architect manually runs `gh pr diff --stat <N>` to assess size/scope, then decides based on the triage table in their role doc. This is the simplest viable approach — the decision framework lives in documentation, and the architect retains full judgment.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
