# Rebuttal — PIR #1118 review iteration 3 (final)

Final 3-way re-run against the settled code. **claude APPROVE**, **gemini COMMENT**,
**codex REQUEST_CHANGES** (two items). Both addressed (commit `c81b8f0d`).

## Finding 1 (codex) — `send.ts` `.builders` regexes used lazy first-match

`detectWorkspaceRoot()` and `detectCurrentBuilderId()` parsed the worktree with a lazy
`/^(.+?)\/\.builders\/…/`, which matches the **first** `/.builders/`. For a *nested* worktree
`<repo>/.builders/a/.builders/b` this resolves the outer builder — the same class the PR fixed
elsewhere with `lastIndexOf`.

**Reachability (per architect discussion)**: nesting only occurs via `afx spawn` from *inside* a
builder worktree, an explicitly-forbidden anti-pattern ("breaks everything", per CLAUDE.md). In
normal use (single `/.builders/`), lazy and greedy are identical — no user-facing impact. Fixed
anyway for consistency (the PR's whole theme is last-match `.builders` parsing) — it's a
one-character change and leaves the tree uniform.

**Fix**: greedy `.+` in both regexes; regression test asserting a nested worktree resolves the
inner builder. Also refreshed the stale `detectCurrentBuilderId` docstring (claude's minor
observation: it still referenced `state.db`/singleton `getDb()`; the code correctly reads
`global.db`).

## Finding 2 (codex) — missing `runBootConsolidation` coverage

`consolidate.test.ts` covered `applyMigration`/`isConsolidationDone` but not the actual boot
path or its strict-marker semantics.

**Fix**: added a `runBootConsolidation` suite (exercises the real `activeStateDbPath()` via a
temp workspace cwd): first-boot migrate + marker + source rename; marker-set → no-op (new active
`state.db` untouched); strict → marks done even when the active `state.db` is absent, then
no-ops on subsequent boots.

## gemini (COMMENT)

Advisory only, no blocking issues raised; noted the plan-fulfilment and the composite-PK
security contract as correctly handled.

**Verification**: `pnpm build` ✓, full agent-farm suite ✓ (2022 passed, +4 new tests), typecheck
clean, CI green.
