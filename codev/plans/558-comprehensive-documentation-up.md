# Plan: Comprehensive Documentation Update for HN Launch

## Metadata
- **Spec**: codev/specs/558-comprehensive-documentation-up.md
- **Status**: draft
- **Created**: 2026-02-25

## Phase Overview

| # | Phase | Objective | Status |
|---|-------|-----------|--------|
| 1 | Fix deprecated CLI commands | Replace all `af dash` with `af workspace`, fix `af spawn` syntax | pending |
| 2 | Update README version refs and Remote Access | Fix stale version numbers, modernize remote access section | pending |
| 3 | Expand FAQ and Cheatsheet | Add missing protocols, features, and CLI tools | pending |
| 4 | Update tips.md and why.md | Fix stale commands in tips, verify references in why.md | pending |

## Phase Details

### Phase 1: Fix Deprecated CLI Commands

**Objective**: Replace all deprecated `af dash` references with `af workspace` across all docs.

**Files to modify**:
- `README.md` — Lines using `af dash start`, `af dash stop`
- `docs/tips.md` — Lines 119-130 using `af dash` in troubleshooting section

**Changes**:
- `af dash start` → `af workspace start`
- `af dash stop` → `af workspace stop`
- `af spawn 3` → `af spawn 3 --protocol spir` (add required --protocol flag)

**Done when**: No `af dash` references remain in user-facing docs (excluding deprecation notices in agent-farm.md).

### Phase 2: Update README Version References and Remote Access

**Objective**: Fix stale version numbers and modernize the remote access section.

**Files to modify**:
- `README.md`

**Changes**:
- Update release example from `v1.6.0` to current-era version
- Update versioning strategy text (remove "Starting with v1.7.0" phrasing)
- Replace manual SSH tunnel section with `af workspace start --remote` approach
- Ensure `af tunnel` reference is replaced or removed

**Done when**: README reflects v2.x era and current remote access workflow.

### Phase 3: Expand FAQ and Cheatsheet

**Objective**: Add documentation for protocols and features missing from FAQ and cheatsheet.

**Files to modify**:
- `docs/faq.md` — Add sections on ASPIR, AIR, BUGFIX, porch orchestration
- `codev/resources/cheatsheet.md` — Add ASPIR, BUGFIX to protocol table; add porch, tower to tools
- `codev/resources/commands/overview.md` — Add porch to CLI summary if missing

**Done when**: All current protocols and CLI tools are documented in reference materials.

### Phase 4: Update tips.md and why.md

**Objective**: Fix remaining stale content in tips and verify references in why.md.

**Files to modify**:
- `docs/tips.md` — Add tips for remote access, cross-workspace messaging, porch checks
- `docs/why.md` — Verify "Claude Opus 4.1" model reference, verify "SP(IDE)R-SOLO" mention, verify "MCP support" reference

**Done when**: All user-facing docs have accurate, current content.
