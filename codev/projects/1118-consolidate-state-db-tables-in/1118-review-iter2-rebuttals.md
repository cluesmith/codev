# Rebuttal — PIR #1118 review iteration 2 (+ manual cross-workspace audit)

Iteration 2 was an ad-hoc 3-way re-run (architect requested) after the iter-1 fixes, plus a
systematic audit of "what else assumed the per-file boundary?" (prompted by: are there other
bugs like the `clearRuntime` one now that we share one DB). Two more issues found; **both
fixed** (commit `7f6ce330`). No disagreement.

- **claude iter2**: APPROVE.
- **gemini iter2**: APPROVE.
- **codex iter2**: REQUEST_CHANGES — dry-run side-effect (finding 2 below).

## Finding 1 (audit-found, HIGH) — `send.ts` opened the retired `state.db`

`detectCurrentBuilderId()` (the `afx send` #1094 anti-spoofing path) opened
`<workspace>/.agent-farm/state.db` directly to resolve a builder's canonical id. After #1118
migrates + renames that file, `existsSync` fails and `afx send` from a worktree throws
`BuilderIdResolutionError`. This is the same direct-open pattern as `lookupBuilderSpawningArchitect`
and `overview.ts` (both fixed in the main implementation) — this third instance was missed, and
**all three consult models missed it too**; the manual audit caught it.

**Fix**: read `global.db` (`getGlobalDbPath()`, read-only) scoped by `workspace_path =
normalizeWorkspacePath(workspacePath)`, matching by worktree. The #1094 fail-loud contract is
preserved (throws, never a bare-name fallback). Test rewritten for the global.db model, including
a **same-id-different-workspace** scoping case (a builder with the same worktree tail in another
workspace must not match).

## Finding 2 (codex iter2, MEDIUM) — `afx db consolidate` dry-run not side-effect-free

`dbConsolidate` called `getGlobalDb()` before the `--apply` check; `getGlobalDb()` eagerly
initializes/migrates `global.db` (creates the file, runs migration v14). So a *preview* could
create/migrate the target DB — violating the plan's "dry-run … no writes."

**Fix**: dry-run opens `global.db` **read-only** (or an in-memory DB if it doesn't exist yet —
empty tables make every source row read as "new", the correct preview). Only `--apply` opens the
real read-write `getGlobalDb()` connection. New test asserts dry-run neither calls `getGlobalDb()`
nor creates the target file.

## Audit result (scope of the "shared-DB" bug class)

Confirmed the complete set of access paths that relied on per-file isolation:
- Unscoped state.ts reads/writes → all scoped (builder fns + `clearRuntime`).
- Direct `state.db` opens → three total: `lookupBuilderSpawningArchitect` ✓, `overview.ts` ✓,
  and `send.ts` (this fix). Grep confirms no others remain.
- `clearState` → no production callers.
- `utils`/`annotations` unscoped in `loadState` → vestigial (no producers); noted as a
  low-severity future cleanup, not fixed here.

**Verification**: `pnpm build` ✓, full agent-farm suite ✓ (2018 passed, +new tests), typecheck clean.
