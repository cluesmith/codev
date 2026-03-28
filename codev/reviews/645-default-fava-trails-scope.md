---
protocol: air
issue: 645
status: committed
reviewed: 2026-03-28
---

# Review: Default fava-trails artifact scope to codev-artifacts/<Org>/<Repo>

## Summary

Small contained change to `CliResolver` in `packages/codev/src/commands/porch/artifacts.ts`. When `artifacts.backend` is `"fava-trails"` (or `"cli"`) and no explicit scope is configured, the resolver now auto-derives the scope as `codev-artifacts/<Org>/<Repo>` from the git remote origin URL.

## Changes

| File | Change |
|------|--------|
| `packages/codev/src/commands/porch/artifacts.ts` | Added `deriveDefaultScope()` helper; updated `getResolver()` to call it when no scope configured |
| `packages/codev/src/commands/porch/__tests__/artifacts.test.ts` | Updated existing test, added 2 new tests for auto-derive behavior |

## Implementation Notes

- `deriveDefaultScope()` runs `git remote get-url origin` and parses both HTTPS (`github.com/Org/Repo.git`) and SSH (`git@github.com:Org/Repo.git`) URLs
- Returns `null` on any failure (not a git repo, no remote, unparseable URL) — caller falls through to error
- Explicit `artifacts.scope` in config takes priority (no prefix, no override)
- ~20 lines of new logic in production code

## Test Results

- 23/23 artifacts tests pass
- Build passes clean

## Verdict

**Accepted.** Minimal, focused change. Error path still works (updated message). No breaking changes — existing configs with explicit scope are unaffected.
