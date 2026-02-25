# Specification: Comprehensive Documentation Update for HN Launch

## Metadata
- **ID**: spec-2026-02-25-comprehensive-documentation-up
- **Status**: draft
- **Created**: 2026-02-25
- **Issue**: #558

## Problem Statement

Codev is preparing for a Hacker News submission of the Tour of CodevOS article. While the README was recently updated (#557), the broader documentation has accumulated stale content — deprecated command syntax, missing features, and inconsistencies between docs and the current codebase (v2.1.1).

HN readers are technically sophisticated. Encountering stale CLI examples or broken references in documentation would undermine credibility.

## Current State

### Stale Command Syntax

**README.md** uses deprecated `af dash` commands in multiple places:
- Line 44: `af dash start` (should be `af workspace start`)
- Line 354: `af dash start` (same)
- Line 356: `af spawn 3` (missing required `--protocol` flag)
- Line 361: `af dash stop` (should be `af workspace stop`)
- Line 371: `af dash start` (same)
- Line 376: `af tunnel` (may not exist as standalone command)
- Line 389: `af dash start --allow-insecure-remote` (deprecated approach)

**docs/tips.md** uses deprecated commands:
- Lines 119-121: `af dash stop` / `af dash start` (should be `af workspace stop` / `af workspace start`)
- Lines 127-130: Same `af dash` usage in "Orphaned Sessions" section

**README.md** has stale version references:
- Line 435: Example shows `v1.6.0` (current version is 2.1.1)
- Line 447: "Starting with v1.7.0, minor releases use release candidates" — outdated

### Missing Documentation for Recent Features

**docs/faq.md** is missing:
- ASPIR protocol (autonomous SPIR variant)
- AIR protocol (lightweight for small features)
- BUGFIX protocol
- Porch orchestration
- Remote access / cloud connectivity (codevos.ai)
- Cross-workspace messaging

**codev/resources/cheatsheet.md** is missing:
- ASPIR protocol in protocol table
- BUGFIX protocol in protocol table
- `porch` CLI in tools reference
- `af tower` commands in af table
- Cross-workspace messaging in af table

### Inconsistencies

**docs/why.md** references:
- "Claude Opus 4.1" — model naming may need verification
- "SP(IDE)R-SOLO" — verify this variant still exists
- "MCP support" as a tool dependency — may be outdated

**README.md Remote Access section** describes a manual SSH tunnel workflow (`af tunnel`) that has been superseded by `af workspace start --remote`.

## Desired State

All user-facing documentation should:
1. Use current CLI syntax (`af workspace` instead of `af dash`)
2. Include required flags (`af spawn 42 --protocol spir`)
3. Reference current version (2.1.1) and features
4. Cover all current protocols (SPIR, ASPIR, AIR, TICK, BUGFIX, MAINTAIN, EXPERIMENT)
5. Document recent capabilities (remote access, cloud connectivity, porch, cross-workspace messaging)
6. Present a consistent, professional tone appropriate for HN audience

## Stakeholders
- **Primary Users**: HN readers evaluating Codev for the first time
- **Secondary Users**: Existing users referencing documentation
- **Business Owners**: Codev maintainers preparing for HN launch

## Success Criteria
- [ ] All `af dash` references replaced with `af workspace` across all docs
- [ ] All `af spawn` examples include `--protocol` flag
- [ ] README version references updated to current (2.1.1)
- [ ] README Remote Access section uses `af workspace start --remote`
- [ ] FAQ covers all current protocols (ASPIR, AIR, BUGFIX at minimum)
- [ ] Cheatsheet includes all current protocols and CLI tools
- [ ] Tips uses current command syntax throughout
- [ ] No broken or obviously stale references in any user-facing doc
- [ ] AGENTS.md and CLAUDE.md remain in sync after any changes

## Constraints

### Technical Constraints
- Documentation-only changes (no code modifications)
- Must not break any existing internal links
- AGENTS.md and CLAUDE.md must remain byte-identical

### Scope Constraints
- Focus on user-facing docs: `docs/`, `codev/resources/commands/`, `codev/resources/cheatsheet.md`, `README.md`
- Do not modify internal architecture docs (`arch.md`, `lessons-learned.md`)
- Do not modify protocol definition files
- Do not modify release notes (they are historical records)

## Assumptions
- `af dash` is a deprecated alias that still works but should not appear in documentation
- `af workspace start --remote` is the current recommended approach for remote access
- All protocols listed in CLAUDE.md (SPIR, ASPIR, AIR, TICK, BUGFIX, MAINTAIN, EXPERIMENT) are current
- Version 2.1.1 is the current released version

## Solution Approach

### Approach: Systematic Audit and Update

Audit each file against the current codebase state, fix stale content, add missing documentation for recent features. Keep changes minimal — update what's wrong, add what's missing, don't rewrite what's working.

**Complexity**: Low — all changes are documentation text edits
**Risk Level**: Low — no code changes, only documentation

## Files in Scope

| File | Key Changes |
|------|-------------|
| `README.md` | Fix `af dash` → `af workspace`, fix `af spawn` examples, update version refs, update Remote Access section |
| `docs/faq.md` | Add ASPIR/AIR/BUGFIX protocols, add porch orchestration |
| `docs/tips.md` | Fix `af dash` → `af workspace`, add tips for new features |
| `docs/why.md` | Verify model names, verify SP(IDE)R-SOLO reference, minor updates |
| `codev/resources/cheatsheet.md` | Add ASPIR/BUGFIX protocols, add porch/tower to tools |
| `codev/resources/commands/overview.md` | Add porch to CLI tools summary |

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Missing a stale reference | Low | Low | Systematic file-by-file audit |
| Breaking internal links | Low | Medium | Verify all links after changes |
| AGENTS.md/CLAUDE.md desync | Low | Medium | Only modify if needed, update both together |
