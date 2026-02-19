# Plan: ASPIR Protocol — Autonomous SPIR

## Metadata
- **ID**: plan-438-aspir-protocol
- **Status**: draft
- **Specification**: codev/specs/438-aspir-protocol.md
- **Created**: 2026-02-19

## Executive Summary

Implement the ASPIR protocol by copying the full SPIR protocol directory structure to `aspir/` in both `codev-skeleton/protocols/` and `codev/protocols/`, then modifying `protocol.json` (remove spec-approval and plan-approval gates, update metadata) and `protocol.md` (ASPIR-specific documentation). Update CLAUDE.md/AGENTS.md with the new protocol in selection guides.

This follows Approach 1 (Full Copy with Gate Removal) from the spec — self-contained, no dependencies between protocols, no code changes.

## Success Metrics
- [ ] All specification criteria met (see spec for full list)
- [ ] `af spawn N --protocol aspir` discovers the protocol
- [ ] No changes to any SPIR files
- [ ] No changes to porch source code
- [ ] Documentation updated in all required locations

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "skeleton_protocol", "title": "Create ASPIR protocol in codev-skeleton"},
    {"id": "instance_protocol", "title": "Create ASPIR protocol in codev instance"},
    {"id": "documentation", "title": "Update documentation and selection guides"}
  ]
}
```

## Phase Breakdown

### Phase 1: Create ASPIR protocol in codev-skeleton
**Dependencies**: None

#### Objectives
- Create the complete ASPIR protocol directory at `codev-skeleton/protocols/aspir/`
- All files copied from `codev-skeleton/protocols/spir/` with modifications to `protocol.json` and `protocol.md`

#### Deliverables
- [ ] `codev-skeleton/protocols/aspir/protocol.json` — modified (name, version, description, gates removed)
- [ ] `codev-skeleton/protocols/aspir/protocol.md` — modified (ASPIR documentation)
- [ ] `codev-skeleton/protocols/aspir/builder-prompt.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/prompts/specify.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/prompts/plan.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/prompts/implement.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/prompts/review.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/consult-types/spec-review.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/consult-types/plan-review.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/consult-types/impl-review.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/consult-types/phase-review.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/consult-types/pr-review.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/templates/spec.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/templates/plan.md` — copied from SPIR
- [ ] `codev-skeleton/protocols/aspir/templates/review.md` — copied from SPIR

#### Implementation Details

**protocol.json changes:**
- `"name": "spir"` → `"name": "aspir"`
- Remove `"alias": "spider"` entirely
- `"version": "2.2.0"` → `"version": "1.0.0"`
- `"description"` → `"ASPIR: Autonomous SPIR — Specify → Plan → Implement → Review without human approval gates"`
- `specify` phase: remove `"gate": "spec-approval"` property
- `plan` phase: remove `"gate": "plan-approval"` property
- `review` phase: keep `"gate": "pr"` unchanged
- All other fields unchanged

**protocol.md:**
- Rewrite to document ASPIR as an autonomous variant of SPIR
- Include "When to Use ASPIR" section (trusted work, low-risk, pre-approved specs)
- Include "When NOT to Use ASPIR" section (high-risk, novel architecture, unclear requirements)
- Reference SPIR for full protocol details
- Document that the only difference is the removal of spec-approval and plan-approval gates

#### Acceptance Criteria
- [ ] Directory `codev-skeleton/protocols/aspir/` exists with all 15 files
- [ ] `protocol.json` has `"name": "aspir"` and no alias
- [ ] `protocol.json` specify phase has no `gate` property
- [ ] `protocol.json` plan phase has no `gate` property
- [ ] `protocol.json` review phase retains `"gate": "pr"`
- [ ] All non-modified files are byte-identical to SPIR counterparts

#### Rollback Strategy
Delete the `codev-skeleton/protocols/aspir/` directory entirely.

---

### Phase 2: Create ASPIR protocol in codev instance
**Dependencies**: Phase 1

#### Objectives
- Create the ASPIR protocol directory at `codev/protocols/aspir/` for our own Codev instance
- Copy from `codev/protocols/spir/` (which has a different structure than the skeleton)

#### Deliverables
- [ ] `codev/protocols/aspir/protocol.json` — modified (same metadata changes as Phase 1, but uses codev-specific check commands)
- [ ] `codev/protocols/aspir/protocol.md` — same content as Phase 1's protocol.md
- [ ] `codev/protocols/aspir/consult-types/spec-review.md` — copied from SPIR
- [ ] `codev/protocols/aspir/consult-types/plan-review.md` — copied from SPIR
- [ ] `codev/protocols/aspir/consult-types/impl-review.md` — copied from SPIR
- [ ] `codev/protocols/aspir/consult-types/phase-review.md` — copied from SPIR
- [ ] `codev/protocols/aspir/consult-types/pr-review.md` — copied from SPIR
- [ ] `codev/protocols/aspir/templates/spec.md` — copied from SPIR
- [ ] `codev/protocols/aspir/templates/plan.md` — copied from SPIR
- [ ] `codev/protocols/aspir/templates/review.md` — copied from SPIR

#### Implementation Details

**Key difference from Phase 1**: The `codev/protocols/spir/protocol.json` has codev-specific check commands (e.g., `cwd` options, test exclusion patterns) that differ from the generic skeleton version. Copy from `codev/protocols/spir/`, not from the skeleton.

**Note**: `codev/protocols/spir/` does not have `builder-prompt.md` or `prompts/` — these only exist in the skeleton. The instance directory is intentionally smaller.

**protocol.json changes**: Same metadata changes as Phase 1 (name, version, description, gate removal).

#### Acceptance Criteria
- [ ] Directory `codev/protocols/aspir/` exists with all 10 files
- [ ] `protocol.json` has codev-specific check commands (not the generic skeleton versions)
- [ ] `protocol.json` specify and plan phases have no `gate` property
- [ ] `protocol.json` review phase retains `"gate": "pr"`
- [ ] All non-modified files are identical to their `codev/protocols/spir/` counterparts

#### Rollback Strategy
Delete the `codev/protocols/aspir/` directory entirely.

---

### Phase 3: Update documentation and selection guides
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Add ASPIR to the protocol selection guides in CLAUDE.md and AGENTS.md
- Add ASPIR to the "Available Protocols" lists in the skeleton's CLAUDE.md and AGENTS.md

#### Deliverables
- [ ] Root `CLAUDE.md` — add ASPIR to Protocol Selection Guide section
- [ ] Root `AGENTS.md` — add ASPIR to Protocol Selection Guide section (same content)
- [ ] `codev-skeleton/templates/CLAUDE.md` — add ASPIR to Available Protocols section
- [ ] `codev-skeleton/templates/AGENTS.md` — add ASPIR to Available Protocols section (same content)

#### Implementation Details

**Root CLAUDE.md/AGENTS.md** — Add a new subsection to the Protocol Selection Guide:

```markdown
### Use ASPIR for (autonomous SPIR):
- Same scope as SPIR but **trusted/low-risk** work
- Specs pre-written and approved by the architect
- Internal tooling or protocol additions with low blast radius
- When the architect wants full SPIR discipline without waiting at gates

ASPIR is identical to SPIR except `spec-approval` and `plan-approval` gates are auto-approved. The PR gate remains.
```

**Skeleton `codev-skeleton/templates/CLAUDE.md` and `codev-skeleton/templates/AGENTS.md`** — Add to the Available Protocols bullet list:

```markdown
- **ASPIR**: Autonomous SPIR (no approval gates) - `codev/protocols/aspir/protocol.md`
```

#### Acceptance Criteria
- [ ] All four doc files updated
- [ ] CLAUDE.md and AGENTS.md have identical ASPIR content (they must stay in sync)
- [ ] Skeleton `codev-skeleton/templates/CLAUDE.md` and `codev-skeleton/templates/AGENTS.md` have identical ASPIR content

#### Rollback Strategy
Revert the doc changes via git.

---

## Dependency Map
```
Phase 1 (skeleton) ──→ Phase 3 (docs)
Phase 2 (instance) ──→ Phase 3 (docs)
```

Phase 1 and Phase 2 are independent of each other but both must complete before Phase 3.

## Risk Analysis
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Copied files miss a hidden file | Low | Medium | Verify file counts match SPIR after copy |
| protocol.json has syntax error after edit | Low | High | Validate JSON parses correctly |
| CLAUDE.md/AGENTS.md get out of sync | Medium | Low | Edit both in same commit |

## Validation Checkpoints
1. **After Phase 1**: Verify `codev-skeleton/protocols/aspir/` has all 15 files, protocol.json is valid JSON with correct changes
2. **After Phase 2**: Verify `codev/protocols/aspir/` has all 10 files, protocol.json has codev-specific checks
3. **After Phase 3**: Verify all 4 doc files reference ASPIR consistently

## Notes
- This is a file-copy-heavy implementation. Most work is ensuring completeness and correctness of copies, not writing new logic.
- The plan intentionally separates skeleton and instance into different phases because they have different file structures and different protocol.json contents.
