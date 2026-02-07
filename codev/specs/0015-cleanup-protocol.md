# Specification: Cleanup Protocol

## Metadata
- **ID**: 0015-cleanup-protocol
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-03
- **Priority**: medium

## Problem Statement

Codebases accumulate cruft over time:
- Dead code (unused functions, imports, files)
- Stale documentation
- Outdated dependencies
- Inconsistent patterns

There's no systematic way to clean up a codebase. Developers do it ad-hoc, often incompletely.

## Current State

- No cleanup protocol defined
- Cleanup is done manually and inconsistently
- Architecture docs may be out of sync with code
- CLAUDE.md and AGENTS.md may drift apart

## Desired State

A **CLEANUP protocol** with defined phases:
1. **AUDIT**: Identify dead code, unused deps, stale docs
2. **PRUNE**: Remove identified cruft
3. **VALIDATE**: Run tests, verify nothing broke
4. **SYNC**: Update architecture docs, sync CLAUDE.md ↔ AGENTS.md ↔ README.md

## Success Criteria

- [ ] CLEANUP protocol defined in `codev/protocols/cleanup/protocol.md`
- [ ] Phase definitions with entry/exit criteria
- [ ] Integration with existing subagents (architecture-documenter)
- [ ] Can be invoked via `af spawn --protocol cleanup` (requires 0014)

## Protocol Design

### Phase 1: AUDIT

**Purpose**: Identify what needs cleaning

**Activities**:
- Run static analysis for dead code (unused exports, unreachable code)
- Check for unused dependencies in package.json/requirements.txt
- Identify stale documentation (references non-existent files/functions)
- List orphaned test files

- Audit test infrastructure:
  - Do all tests pass?
  - Are there redundant or low-ROI tests to prune?
  - Are there orphaned test fixtures?

**Subagents**: `dead-code-auditor` (new), static analysis tools

**Exit Criteria**: Audit report generated listing all identified issues

**Output**: Audit report saved to `codev/cleanup/audit-YYYY-MM-DD.md`

### Phase 2: PRUNE

**Purpose**: Remove identified cruft

**Input**: Audit report from Phase 1

**Activities**:
- Delete dead code (with confirmation)
- Remove unused dependencies
- Delete orphaned files
- Clean up commented-out code

**Subagents**: None (manual or scripted removal)

**Exit Criteria**: All identified cruft removed, changes committed

### Phase 3: VALIDATE

**Purpose**: Ensure nothing broke

**Activities**:
- Run full test suite
- Run linters
- Check for import errors
- Verify build succeeds

**Subagents**: None (existing test infrastructure)

**Exit Criteria**: All tests pass, no regressions

### Phase 4: SYNC

**Purpose**: Update documentation

**Activities**:
- Run architecture-documenter to update arch.md
- Sync CLAUDE.md ↔ AGENTS.md
- Update README if needed
- Check for stale comments

**Subagents**: `architecture-documenter`, `doc-sync` (new)

**Exit Criteria**: Documentation matches current codebase state

## Integration with Conceptual Model

Per `codev/resources/conceptual-model.md`, CLEANUP is correctly classified as a **Protocol** (not a Role or Subagent) because:
- It has multiple distinct phases
- Phases have dependencies and ordering
- The process is episodic, not ongoing

## Scope

### In Scope
- Protocol definition
- Phase descriptions
- Integration points

### Out of Scope
- Implementing all subagents
- Automated fixes (human approval required for deletions)

## Dependencies

- 0014 Flexible Builder Spawning (for `--protocol` flag)
- architecture-documenter subagent (existing)

## References

- `codev/resources/conceptual-model.md` - Case study on CLEANUP
- `codev/protocols/spir/protocol.md` - Protocol structure reference

## Expert Consultation
**Date**: 2025-12-03
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro
**Feedback Incorporated**:
- **CRITICAL**: Add "Dry Run" mode for Prune phase - show what would be deleted without deleting
- Add rollback strategy if Validate phase fails
- Prefer "soft delete" (move to `.trash/`) over immediate permanent deletion
- High risk of data loss if Audit logic is flawed - be defensive
- Clarify entry/exit criteria and approval ownership per phase

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
