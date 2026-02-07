---
approved: 2026-02-06
validated: [claude]
---

# Spec 0093: SPIR → SPIR Rename

## Summary

Complete the rename of the SPIR protocol to SPIR across the entire codebase. The rename was decided previously (SPIR = Specify, Plan, Implement, Review) but only ~15% was completed — mainly aliases in protocol.json files and a header note in protocol.md.

## Problem Statement

The protocol was originally called SPIR (Specify, Plan, Implement, Defend, Evaluate, Review). The "Defend" and "Evaluate" phases were folded into "Implement" and "Review" respectively, making the acronym inaccurate. The decision was made to rename to SPIR but the rename was never completed. Currently:

- 728 references to "SPIR" across 224 files
- Only 19 references to "SPIR" (partial rename)
- Directory names still use `spider/`
- All user-facing documentation (README, CLAUDE.md, AGENTS.md, INSTALL.md) still say SPIR

This creates confusion for new users and inconsistency in the codebase.

## Requirements

### 1. Directory Rename

Rename protocol directories:
- `codev-skeleton/protocols/spir/` → `codev-skeleton/protocols/spir/`
- `codev/protocols/spir/` → `codev/protocols/spir/`

### 2. Code Updates

Update all TypeScript source files that reference "spider":
- `packages/codev/src/agent-farm/commands/spawn.ts` — protocol name strings
- `packages/codev/src/commands/porch/` — protocol references
- Any test files referencing "spider" protocol name
- Type definitions and enums

### 3. Protocol File Updates

- `protocol.json` — change `"name": "spir"` to `"name": "spir"`
- `protocol.md` — update all references, remove "(formerly SPIR)" notes
- Other protocol files that reference SPIR (tick, bugfix, maintain, experiment)

### 4. Documentation Updates

- `README.md` — all SPIR references → SPIR
- `CLAUDE.md` — all SPIR references → SPIR
- `AGENTS.md` — all SPIR references → SPIR (keep in sync with CLAUDE.md)
- `INSTALL.md` — all references
- `codev/resources/arch.md` — architecture references
- `codev/resources/cheatsheet.md` — if exists
- `codev/resources/commands/*.md` — CLI documentation

### 5. Spec/Plan/Review Files

- Update references in existing specs, plans, and reviews
- These are historical documents so use judgment — update protocol name references but don't rewrite historical context

### 6. Branch Naming Convention

Update the documented branch naming convention:
- Old: `spir/0001-feature-name/phase-name`
- New: `spir/0001-feature-name/phase-name`

### 7. Backward Compatibility

- Keep `"alias": "spider"` in `protocol.json` so existing `--use-protocol spir` still works
- The `codev/protocols/spir/` directory in user projects will be handled by a future migration in `codev update`
- No runtime breaking changes — alias ensures old references work

## Non-Requirements

- Migrating existing user projects (that's a `codev update` concern)
- Renaming git branches that already used the `spider/` prefix
- Updating git commit history

## Acceptance Criteria

1. [ ] No directory named `spider/` in `codev-skeleton/protocols/` or `codev/protocols/`
2. [ ] Zero references to "SPIR" in CLAUDE.md, AGENTS.md, README.md, INSTALL.md (except backward-compat notes)
3. [ ] `protocol.json` has `"name": "spir"` with `"alias": "spider"` for backward compat
4. [ ] `af spawn -p XXXX --use-protocol spir` still works (alias)
5. [ ] `af spawn -p XXXX --use-protocol spir` works (new name)
6. [ ] All TypeScript source references updated
7. [ ] All tests pass
8. [ ] `SPIR` notation in docs replaced with `SPIR` (the phases are now S-P-I-R)

## Testing Strategy

- Run full test suite after rename to catch any hardcoded "spider" strings
- Verify `--use-protocol spir` still resolves via alias
- Verify `--use-protocol spir` works
- grep for remaining "spider" references (should only be alias and historical git references)

## Files to Modify

Approximately 250 files. Key categories:

| Category | Count | Example |
|----------|-------|---------|
| Documentation (MD) | ~30 | README.md, CLAUDE.md, AGENTS.md |
| Protocol definitions | ~10 | protocol.json, protocol.md |
| TypeScript source | ~15 | spawn.ts, porch/*.ts |
| Test files | ~15 | *.test.ts |
| Specs/Plans/Reviews | ~180 | codev/specs/*.md, codev/plans/*.md |

## Dependencies

None — this is a standalone rename task.
