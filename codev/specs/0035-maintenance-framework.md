# Specification: MAINTAIN Protocol

## Metadata
- **ID**: 0035-maintain-protocol
- **Protocol**: TICK
- **Status**: implementing
- **Created**: 2025-12-06
- **Priority**: medium

## Problem Statement

Codev has a CLEANUP protocol that handles code hygiene (dead code removal, dependency updates, test maintenance). However:

1. **Documentation maintenance is missing**: arch.md drift, lessons-learned.md curation, CLAUDE.md/AGENTS.md sync are not covered
2. **CLEANUP is misnamed**: "Cleanup" implies one-time janitorial work, not ongoing maintenance
3. **Conceptual confusion**: CLEANUP was questioned as a "protocol" - is it really just a procedure?

The solution: rename CLEANUP to MAINTAIN, expand scope to include documentation, and affirm it as a full protocol.

## Desired State

### MAINTAIN Protocol

A protocol for periodic maintenance of both code and documentation. Unlike SPIR/TICK, MAINTAIN is a **task list** rather than sequential phases. Tasks can run in parallel and some require human review.

**Scope** (code + documentation):
- Code hygiene: dead code, dependencies, flags, tests
- arch.md updates (absorbs architecture-documenter agent)
- lessons-learned.md generation (extract wisdom from reviews)
- CLAUDE.md/AGENTS.md synchronization
- Spec/plan/review consistency checks
- Project tracking updates

### Execution Model

MAINTAIN is executed by a Builder, spawned by the Architect:

```
Architect: "Time for maintenance"
    ↓
af spawn --protocol maintain
    ↓
Builder executes MAINTAIN protocol
    ↓
PR with maintenance changes
    ↓
Architect reviews → Builder merges
```

No new roles. Same Architect/Builder pattern as SPIR and TICK.

### Triggers

| Trigger | Frequency | Notes |
|---------|-----------|-------|
| Before release | Per release | Clean slate for shipping |
| Quarterly | 4x/year | Regular hygiene |
| Post-major-feature | As needed | After big integrations |
| Ad-hoc | When crusty | Architect's judgment |

## Changes from CLEANUP

| Aspect | CLEANUP (current) | MAINTAIN (proposed) |
|--------|-------------------|---------------------|
| Name | CLEANUP | MAINTAIN |
| Code hygiene | Yes | Yes |
| Dead code removal | Yes | Yes |
| Dependency updates | Yes | Yes |
| Test maintenance | Yes | Yes |
| **arch.md updates** | No | **Yes** |
| **lessons-learned.md** | No | **Yes** |
| **CLAUDE.md/AGENTS.md sync** | No | **Yes** |
| **Spec/plan/review consistency** | No | **Yes** |

## MAINTAIN Task List

Unlike SPIR/TICK (which have sequential phases), MAINTAIN is a **task list**. Tasks can be run in parallel where independent, and some require human review.

### Code Hygiene Tasks

| Task | Parallelizable | Human Review? |
|------|----------------|---------------|
| Remove dead code | Yes | No |
| Remove unused dependencies | Yes | Yes (breaking changes) |
| Clean unused flags | Yes | No |
| Fix flaky tests | No | Yes |
| Update outdated dependencies | Yes | Yes (breaking changes) |

### Documentation Sync Tasks

| Task | Parallelizable | Human Review? |
|------|----------------|---------------|
| Update arch.md | Yes | No |
| Generate lessons-learned.md | Yes | Yes (curation) |
| Sync CLAUDE.md ↔ AGENTS.md | Yes | No |
| Check spec/plan/review consistency | Yes | Yes (decision needed) |
| Remove references to deleted code | Yes | No |
| Archive completed specs | Yes | No |

### Project Tracking Tasks

| Task | Parallelizable | Human Review? |
|------|----------------|---------------|
| Update projectlist.md status | Yes | No |
| Archive terminal projects | Yes | No |

### Validation (run after all tasks)

After task completion, validate:
- All tests pass
- Build succeeds
- No import errors
- Documentation links resolve

### arch.md Updates (absorbed from architecture-documenter)

The arch.md update task absorbs what the architecture-documenter agent used to do:

1. Scan actual codebase structure
2. Compare with documented structure in arch.md
3. Update directory tree
4. Update component descriptions
5. Update utility function documentation
6. Remove references to deleted code

This is now a MAINTAIN task, not a separate agent.

## lessons-learned.md

A new artifact generated during MAINTAIN:

**Location**: `codev/resources/lessons-learned.md`

**Purpose**: Consolidated wisdom extracted from review documents. An "executive summary" of what we've learned, indexed by topic.

**Structure**:
```markdown
# Lessons Learned

## Testing
- [From 0001] Always use XDG sandboxing in tests to avoid touching real $HOME
- [From 0009] Verify dependencies actually export what you expect before using them

## Architecture
- [From 0008] Single source of truth beats distributed state
- [From 0031] SQLite with WAL mode handles concurrency better than JSON files

## Process
- [From 0001] Multi-agent consultation catches issues humans miss
- [From 0034] Two-pass rendering needed for table-aware markdown processing
```

**Curation rules**:
- Link back to source review
- Keep entries actionable (not just "we learned X")
- Prune outdated lessons (tech changes, patterns superseded)
- Organize by topic, not by project

## Artifacts to Eliminate

### architecture-documenter agent

**Current**: `.claude/agents/architecture-documenter.md`
**Disposition**: Delete after MAINTAIN is implemented

arch.md updates move into MAINTAIN SYNC phase. No separate agent needed.

### CLEANUP protocol

**Current**: `codev/protocols/cleanup/`
**Disposition**: Rename to `codev/protocols/maintain/`

All existing CLEANUP content is preserved and expanded.

## Success Criteria

- [x] `codev/protocols/cleanup/` renamed to `codev/protocols/maintain/`
- [x] MAINTAIN protocol.md includes documentation maintenance in all phases
- [x] lessons-learned.md template created
- [x] architecture-documenter agent deleted (never existed - absorbed into protocol)
- [x] CLAUDE.md updated to reference MAINTAIN (not CLEANUP)
- [x] Builder can be spawned with `--protocol maintain`
- [ ] At least one successful MAINTAIN run demonstrated

## Technical Changes

### Protocol file changes

1. Rename `codev/protocols/cleanup/` → `codev/protocols/maintain/`
2. Update protocol.md with expanded scope
3. Add documentation audit checklist to AUDIT phase
4. Add documentation sync steps to SYNC phase
5. Add lessons-learned.md template to templates/

### CLAUDE.md changes

1. Replace all references to CLEANUP with MAINTAIN
2. Remove architecture-documenter agent section
3. Add MAINTAIN to protocol selection guide

### Agent deletion

1. Delete `.claude/agents/architecture-documenter.md`
2. Update any references in CLAUDE.md

## Relationship to Other Specs

- **0015 (CLEANUP Protocol)**: Superseded - CLEANUP becomes MAINTAIN
- **0028 (Librarian Role)**: Abandoned - no new roles needed
- **0027 (Arch-Documenter as Protocol)**: Already superseded by 0028, now moot

## Out of Scope

- Go-to-market concerns (separate project: comarket)
- New roles (Librarian, Tech Debt Manager, etc.)
- Automated scheduling (manual trigger by Architect for now)

## Consulted

- **Gemini**: Recommended one role (Librarian), MAINTAIN as protocol
- **Codex**: Recommended two roles, procedures not protocol

**Decision**: No new roles. MAINTAIN as protocol executed by Builder. Simpler.

## Notes

This spec simplifies the maintenance story:
- Protocols build things (SPIR, TICK, EXPERIMENT)
- Protocols maintain things (MAINTAIN)
- Roles execute protocols (Architect orchestrates, Builder executes)

MAINTAIN is just another protocol. The Architect decides when to run it, spawns a Builder, reviews the PR. Same pattern as feature work.
