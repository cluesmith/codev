---
approved: 2026-02-02
validated: [gemini, codex, claude]
---

# Spec 0088: Porch Version Constant

## Problem

The porch module lacks a centralized version constant. When porch outputs status information or logs, it has no version identifier. This makes it harder to debug which version of porch produced a given output.

## Questions & Answers

1. **Q**: Where should the constant live? **A**: In a new `version.ts` file in the porch directory.
2. **Q**: What format? **A**: Semantic version string (independent protocol version, not derived from package.json).

## Solution

Add a `PORCH_VERSION` constant to `packages/codev/src/commands/porch/version.ts` that exports the current porch version. Update the `showStatus` function in `run.ts` to display it.

## Acceptance Criteria

- [ ] `version.ts` exports `PORCH_VERSION` string constant
- [ ] `showStatus()` in `run.ts` displays the version
- [ ] Existing tests still pass

## Technical Implementation

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PORCH_VERSION` | `'1.0.0'` | Current porch protocol orchestrator version |

### Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/commands/porch/version.ts` | New file, exports `PORCH_VERSION` |
| `packages/codev/src/commands/porch/run.ts` | Import and display in `showStatus()` |

### Test Strategy

1. Unit test: verify `PORCH_VERSION` matches expected format (semver regex)
2. Existing tests pass without modification
