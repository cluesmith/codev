# Review: Architect-Builder TICK-002 - Protocol-Agnostic Spawn System

**Spec**: [0002-architect-builder.md](../specs/0002-architect-builder.md) (TICK-002 amendment)
**Plan**: [0002-architect-builder.md](../plans/0002-architect-builder.md) (Phase 9)
**Date**: 2026-01-27
**Status**: Planned

## Summary

Refactor `afx spawn` to decouple input types from protocols, making the system extensible without hardcoding protocol-specific logic.

## Problem Statement

Currently, specific protocols are deeply baked into `afx spawn`:
- `spawnBugfix()` hardcodes BUGFIX protocol path, collision checks, and issue commenting
- `spawnSpec()` defaults to SPIR with protocol-specific prompts
- Adding a new protocol requires modifying spawn.ts

This violates the open-closed principle and makes the system harder to extend.

## Proposed Solution

Separate three orthogonal concerns:

1. **Input Type** - what the builder starts from (spec, issue, task, protocol, worktree)
2. **Mode** - who orchestrates (strict = porch, soft = AI follows protocol.md)
3. **Protocol** - what workflow to follow (spir, bugfix, tick, maintain, etc.)

Key changes:
- Add `--protocol` universal flag
- Protocol-defined input requirements and hooks in protocol.json
- Protocol-specific prompt templates in `protocols/{name}/builder-prompt.md`
- Refactor spawn.ts into modular components

## Implementation Status

- [ ] Phase 9 implementation started
- [ ] Protocol schema extended
- [ ] Prompt templates created
- [ ] Spawn refactored
- [ ] Backwards compatibility verified
- [ ] Tests passing

## Lessons Learned

(To be filled after implementation)

## Review Checklist

- [ ] Existing commands work unchanged
- [ ] New `--protocol` flag works with all input types
- [ ] Adding a new protocol requires only data files (no code changes)
- [ ] Prompts render correctly for all combinations
- [ ] Documentation updated
