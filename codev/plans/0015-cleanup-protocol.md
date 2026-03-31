# Plan: Cleanup Protocol

## Metadata
- **ID**: 0015-cleanup-protocol
- **Status**: draft
- **Specification**: codev/specs/0015-cleanup-protocol.md
- **Created**: 2025-12-04
- **Protocol**: TICK (simple protocol definition)

## Executive Summary

Implement the CLEANUP protocol as a four-phase codebase maintenance workflow. The primary deliverable is the protocol definition document. This is primarily documentation work with light scripting.

## Success Metrics
- [ ] CLEANUP protocol defined in `codev/protocols/cleanup/protocol.md`
- [ ] Audit report template created
- [ ] Phase definitions with clear entry/exit criteria
- [ ] Dry-run mode documented for PRUNE phase
- [ ] Soft-delete strategy with restore.sh documented
- [ ] Scope definition (cleanup categories) documented

## Phase Breakdown

### Phase 1: Protocol Definition
**Dependencies**: None

#### Objectives
- Define the complete CLEANUP protocol document
- Establish clear phase boundaries and criteria
- Define explicit scope (what gets cleaned)

#### Deliverables
- [ ] `codev/protocols/cleanup/protocol.md` - Main protocol file
- [ ] `codev/protocols/cleanup/templates/audit-report.md` - Audit report template
- [ ] Directory structure: `codev/cleanup/` for runtime artifacts

#### Implementation Details

**Protocol Structure**:
```
codev/protocols/cleanup/
├── protocol.md          # Main protocol definition
└── templates/
    └── audit-report.md  # Template for audit output
```

**Runtime Artifacts Structure**:
```
codev/cleanup/
├── audit-2025-12-04.md           # Timestamped audit reports
└── .trash/
    └── 2025-12-04-1430/          # Timestamped trash folders
        ├── restore.sh            # Auto-generated restore script
        └── [original/path/...]   # Preserved directory structure
```

**Scope Definition (Cleanup Categories)**:
The protocol MUST define which targets it operates on:
1. `dead-code`: Unused functions, imports, unreachable code
2. `dependencies`: Unused npm/pip packages
3. `docs`: Stale documentation referencing non-existent code
4. `tests`: Orphaned test files, low-ROI tests
5. `temp`: Temporary files (.trash/, .consult/, build artifacts)
6. `metadata`: Orphaned entries in projectlist.md

**Key Sections in protocol.md**:
1. Overview and purpose
2. Scope definition (cleanup categories)
3. When to run CLEANUP (triggers)
4. Phase 1: AUDIT - detailed activities, entry/exit criteria
5. Phase 2: PRUNE - dry-run, soft-delete, restore.sh generation
6. Phase 3: VALIDATE - test suite, build verification
7. Phase 4: SYNC - update projectlist.md, AGENTS.md, arch.md
8. Retention policy (.trash/ kept 30 days)
9. Rollback strategy

**Phase Entry/Exit Criteria**:

| Phase | Entry Criteria | Exit Criteria |
|-------|---------------|---------------|
| AUDIT | Clean git state, tests passing | Audit report generated |
| PRUNE | Audit report reviewed by human | Files moved to .trash/, restore.sh generated |
| VALIDATE | PRUNE complete | All tests pass, build succeeds |
| SYNC | VALIDATE passes | projectlist.md and docs updated |

**Audit Report Template**:
```markdown
# Cleanup Audit Report
Date: YYYY-MM-DD
Project: [name]
Categories: [dead-code, dependencies, docs, tests, temp, metadata]

## Summary
- Files to remove: N
- Dependencies to remove: N
- Docs to update: N

## Dead Code
- [ ] file1.ts:42 - unused export `foo`
- [ ] file2.ts:100 - unreachable function `bar`

## Unused Dependencies
- [ ] package1 (not imported anywhere)

## Stale Documentation
- [ ] docs/old.md (references deleted function `baz`)

## Test Infrastructure
- All tests passing: Yes/No
- [ ] tests/old.test.ts (tests deleted feature)

## Metadata Updates Required
- [ ] projectlist.md: Remove reference to 0003
- [ ] AGENTS.md: Update protocol list

## Recommendations
[Summary of suggested actions]
```

**Restoration Strategy**:
When soft-deleting, preserve original paths:
```bash
# .trash/2025-12-04-1430/restore.sh
#!/bin/bash
mv ".trash/2025-12-04-1430/src/utils/old.ts" "src/utils/old.ts"
mv ".trash/2025-12-04-1430/tests/old.test.ts" "tests/old.test.ts"
echo "Restored 2 files"
```

**Retention Policy**:
- `.trash/` subdirectories older than 30 days may be permanently deleted
- Audit reports kept indefinitely in `codev/cleanup/`

#### Acceptance Criteria
- [ ] Protocol document is complete and follows existing protocol format
- [ ] All four phases have explicit entry/exit criteria
- [ ] Scope definition (cleanup categories) is clear
- [ ] Dry-run and soft-delete modes documented
- [ ] Restore.sh generation documented
- [ ] Retention policy defined
- [ ] Audit report template is comprehensive

#### Risks
- **Risk**: Protocol too complex for practical use
  - **Mitigation**: Keep phases lightweight, allow skipping phases
- **Risk**: Accidental deletion of active work
  - **Mitigation**: Require clean git state, preserve paths in .trash/

---

### Phase 2: Integration Points
**Dependencies**: Phase 1

#### Objectives
- Document how CLEANUP integrates with existing tools
- Define future integration with 0014 (Flexible Builder Spawning)

#### Deliverables
- [ ] Update `codev/protocols/cleanup/protocol.md` with integration section
- [ ] Add CLEANUP to protocol index if one exists
- [ ] Document .gitignore additions

#### Implementation Details

**Integration Points**:
1. `architecture-documenter` - called during SYNC phase
2. Future: `afx spawn --protocol cleanup` (requires 0014)
3. Manual invocation instructions until 0014 is complete

**Required .gitignore additions**:
```
codev/cleanup/.trash/
# Note: audit-*.md reports ARE versioned (committed to git)
```

#### Acceptance Criteria
- [ ] Integration with architecture-documenter documented
- [ ] Manual invocation path is clear
- [ ] .gitignore updated

---

## Dependency Map
```
Phase 1 (Protocol Definition) ──→ Phase 2 (Integration Points)
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Data loss from aggressive pruning | M | H | Dry-run default, soft-delete with restore.sh |
| Audit misidentifies live code as dead | M | H | Require human confirmation, preserve paths |
| Cleanup pollutes itself | L | M | Define clear directory structure, .gitignore |

## Validation Checkpoints
1. **After Phase 1**: Protocol document reviewed, template usable
2. **After Phase 2**: Integration points verified, .gitignore updated

## Documentation Updates Required
- [ ] Add CLEANUP to CLAUDE.md/AGENTS.md protocol list
- [ ] Update codev/resources/arch.md with new protocol
- [ ] Update .gitignore

## Expert Review
**Date**: 2025-12-04
**Models**: Gemini Pro, GPT-5 Codex (parallel consultation)
**Key Feedback**:
- Add explicit scope definition (cleanup categories) ✓
- Add entry/exit criteria per phase ✓
- Preserve directory structure in .trash/ ✓
- Generate restore.sh for easy rollback ✓
- Rename INDEX → SYNC to clarify purpose ✓
- Add retention policy for .trash/ ✓
- Add .gitignore entries ✓

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete

## Notes
- This protocol is primarily documentation
- Actual cleanup tooling (dead-code-auditor subagent) is out of scope per spec
- Human approval required for all deletions (no automated removal)
- SYNC phase updates metadata (projectlist.md, AGENTS.md) not just syncs docs
