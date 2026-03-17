---
approved: 2026-03-17
validated: [architect]
---

# Specification: Trivial Builder Fixes (ASPIR prompt, porch init, phases check)

## Metadata
- **ID**: 619
- **Status**: approved
- **GitHub Issue**: https://github.com/cluesmith/codev/issues/619

## Problem Statement

Three small bugs block builders from running correctly:

1. **ASPIR builder-prompt references SPIR**: `codev-skeleton/protocols/aspir/builder-prompt.md` line ~30 says "Follow the SPIR protocol" — should say ASPIR
2. **`af spawn --task` skips porch init**: `spawnTask()` never calls `initPorchInWorktree()` when an explicit protocol is provided, unlike `spawnSpec()` and `spawnBugfix()`
3. **Fragile phases JSON check**: `runArtifactCheck()` in `checks.ts` uses `content.includes('"phases":')` which breaks on whitespace variations from CLI backends

## Success Criteria

- [ ] ASPIR builder-prompt references `codev/protocols/aspir/protocol.md`
- [ ] `af spawn --task T --protocol aspir` initializes porch in the builder worktree
- [ ] `has_phases_json` check uses regex to handle whitespace variations
- [ ] All existing tests pass

## Files to Modify

1. `codev-skeleton/protocols/aspir/builder-prompt.md` — fix protocol reference
2. `codev/protocols/aspir/builder-prompt.md` — fix protocol reference (our instance)
3. `packages/codev/src/agent-farm/commands/spawn.ts` — add `initPorchInWorktree()` in `spawnTask()` when `hasExplicitProtocol`
4. `packages/codev/src/commands/porch/checks.ts` — change `content.includes('"phases":')` to `/"phases"\s*:/.test(content)`
