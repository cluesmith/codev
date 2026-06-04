# spir-984 — Multi-architect coordination layer

## Project
Issue #984 (SPIR, area/tower). Six coordinated points:
1. Architect roster (`afx architects`)
2. Unified board / digest (prefer extending dashboard Work view / `afx tower`)
3. Issue-ownership ledger + dedup-at-spawn
4. Formal lifecycle (enhance `afx workspace add-architect`/`remove-architect`)
5. Bounded, templated state files (`codev/state/<id>_thread.md`)
6. Per-architect checkout isolation (largest/riskiest)

## Status log

### Specify — started 2026-06-03
- Strict mode, porch-driven. Phase = `specify`. Spec did not pre-exist; porch spawned me to create it.
- Reading protocol + template; exploring codebase surfaces for all six points.

### Findings that shape the spec
- **Spec 823 ("coordination-b") already shipped** (review on main): builder attribution in dashboard, inter-agent messaging docs, per-builder thread-file convention, VSCode Architects-tree auto-refresh. 984 builds the NEXT layer — must not re-do these.
- **Architects are stored in SQLite** `architect` table (`packages/codev/src/agent-farm/db/schema.ts`), composite PK `(workspace_path, id)`. `id` is the architect name ('main', 'architect-2', …). No per-architect markdown state file exists in code today.
- **Spawn affinity**: `CODEV_ARCHITECT_NAME` env injected by Tower into each architect terminal; read at `commands/spawn.ts`; builders carry `spawned_by_architect`.
- **`codev/state/<id>_thread.md`** are *builder* free-text logs, written by the builder AI via the Write tool (no code produces them). Point #5 "bounded state" targets these + any new architect state file.
- **Worktrees**: builders get `git worktree add` from the shared main checkout (`commands/spawn-worktree.ts`); all architects share that one checkout → the coupling #6 addresses. Natural fix = per-architect worktrees (mirrors builder model, cheap object-store sharing).
- afx CLI = Commander.js in `agent-farm/cli.ts`; Tower routes in `servers/tower-routes.ts`; dashboard Work view in `packages/dashboard/src/components/WorkView.tsx` + `/api/overview` (`servers/overview.ts`). Tests = Vitest in `agent-farm/__tests__/`.

### Key scoping decision
The issue's "architect state files" description comes from the private source workspace (markdown working-memory files). In OUR repo that convention doesn't formally exist — so #4 must *introduce* it, and #5 bounds both builder thread files and the new architect state file. Surfacing this in the spec's Current State + Open Questions rather than blocking.

Writing spec now with recommended defaults + explicit Open Questions for: #6 checkout-isolation approach (worktree vs clone vs pin-base) and whether it ships as its own PR; #5 rotation mechanism; architect state-file convention/location.
