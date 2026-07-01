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

- Spec drafted + committed (37b1987a). Ran porch-orchestrated 3-way consult (iter1).
- **Consult verdicts**: Gemini REQUEST_CHANGES, Codex REQUEST_CHANGES, Claude COMMENT (all HIGH conf; Claude verified codebase claims accurate).
- Incorporated everything → committed d7e17715. Key resolutions: state file at `codev/state/architects/<name>.md`; `--override-owner` w/ release-and-reinsert + `override_of`; partial unique index for atomic dedup; rotation via `<!-- ARCHIVE BOUNDARY -->` whole-entry moves (loss-free); `.architects/<name>/` gitignored worktrees, main=main checkout, new architects isolated by default, pre-existing migrate explicitly; dirty-worktree retire aborts unless --force; roster open/closed via overview cache (unknown on outage); who-owes-next total function; CODEV_ARCHITECT_NAME required in N>1.
- **Left for architect at gate**: #6 PR-slicing (all 3 recommend own PR), pre-existing-architect migration ergonomics, 2 nice-to-knows.
- Wrote rebuttal (984-specify-iter1-rebuttals.md, committed) documenting how each REQUEST_CHANGES point was addressed.
- **GATE: spec-approval reached.** Registered via `porch gate 984`; notified architect via `afx send`. STOPPED, awaiting human `porch approve 984 spec-approval`. Not calling approve myself (strict mode).
- Architect decisions pending at gate: (1) #6 PR-slicing (own PR recommended by all 3), (2) pre-existing-architect migration ergonomics.

### Spec APPROVED (2026-06-04) + Plan phase
- **Architect approved spec at gate** with ONE modification: **#6 → builder-base SHA-pin** (documented fallback B), NOT per-architect worktrees. Rationale: the damaging failure mode is stale-base builders (hit a `main` ~145 commits behind repeatedly); SHA-pin fixes it cheaply without the Tower/spawn refactor. Architects keep sharing main checkout; "never switch branches" stays for architects. Resolves both open gate Qs: PR-slicing moot (ships in main PR), migration ergonomics moot (no worktrees).
- Amended spec comprehensively (Amendment 1 + all #6-touching sections: title, Desired State, Success Criterion #6, Current State, Constraints, Assumptions, Performance, Risks, Test Scenarios 10/11/14, Resolved Decisions, Open Questions, Notes). Committed.
- NOTE: I did NOT self-approve the porch gate. After I committed the amendment, porch status had already advanced past spec-approval (human ran `porch approve`), so I proceeded to Plan.
- **Plan phase**: ran a 2nd Explore to nail integration points (schema migrations via db/index.ts ensureLocalDatabase; state.ts CRUD; spawn.ts SPAWNING_ARCHITECT_NAME + upsertBuilder; spawn-worktree.ts createWorktree base; Tower add/remove in tower-instances.ts ~L987/L1161; tower-client.ts; overview.ts OverviewCache; WorkView.tsx; cli.ts Commander; Vitest tests).
- Wrote plan: 7 phases (ledger → roster → bounded-state → lifecycle → board → SHA-pin → docs), machine-readable phases JSON, all porch checks pass (plan_exists/has_phases_json/min_two_phases=7). Committed.
- Ran 3-way plan consult (iter1): **Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES** (all HIGH).
- Codex's 4 points all valid + fixed: (1) claim ownership BEFORE worktree/session creation + rollback (old order couldn't prevent side effects); (2) Phase 6 attached-branch flow (old sketch detached); (3) Phase 5 board must join ledger + synthesize owned-but-unspawned rows; (4) types.ts/spawn.test.ts plumbing. Plus approver notes (state-rotation→codev/src/lib, line numbers, mkdir -p, default-branch fallback chain, createWorktree-only, closed-issue dedup default=block, stale-HEAD test fixture). Wrote rebuttal.
- **GATE: plan-approval reached.** Registered via `porch gate 984`; notified architect. STOPPED, awaiting human `porch approve 984 plan-approval`. Not self-approving.
- After approval → Implement phase (7 phases, IDE cycle each, all one PR).
