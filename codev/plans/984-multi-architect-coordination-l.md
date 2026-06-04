# Implementation Plan: Multi-Architect Coordination Layer

## Metadata
- **ID**: plan-2026-06-04-984-multi-architect-coordination-l
- **Status**: draft
- **Specification**: [`codev/specs/984-multi-architect-coordination-l.md`](../specs/984-multi-architect-coordination-l.md)
- **Created**: 2026-06-04
- **GitHub Issue**: [#984](https://github.com/cluesmith/codev/issues/984)

## Executive Summary

Implements the six-point coordination layer from the approved spec, in dependency order. The **ownership ledger** (#3) is the data foundation; the **roster** (#1) reads it; **bounded state files** (#5) supply the template the **lifecycle** (#4) creates and archives; the **board** (#2) extends the dashboard overview; **builder-base SHA-pin** (#6 — architect-directed, replacing worktree isolation) is a localized change to the spawn base-resolution path. A final **documentation** phase surfaces every new command/flag.

All phases ship as commits within a **single PR** (per the builder PR strategy and the spec's Amendment 1 — #6 is now small enough that no slicing is needed). Each phase is independently committable and testable. Backward compatibility for single-`main` workspaces is verified per phase (N=1 must be unchanged).

**Integration anchors** (verified against the codebase):
- SQLite schema: `packages/codev/src/agent-farm/db/schema.ts` (`LOCAL_SCHEMA`, `CREATE TABLE IF NOT EXISTS`); versioned migrations in `db/index.ts` `ensureLocalDatabase()`.
- State CRUD: `packages/codev/src/agent-farm/state.ts` (`upsertBuilder`, `setArchitectByName`, `loadState`, `removeArchitect`).
- Spawn: `commands/spawn.ts` (`SPAWNING_ARCHITECT_NAME` at module load; `upsertBuilder` in `spawnSpec`); base resolution in `commands/spawn-worktree.ts` (`createWorktree`).
- Tower: routes in `servers/tower-routes.ts`; architect add/remove impl in `servers/tower-instances.ts` (`addArchitect` ~L987, `removeArchitect` ~L1161, both around `setArchitectByName`); REST client in `packages/core/src/tower-client.ts`.
- Overview/board: `servers/overview.ts` (`OverviewCache`, `discoverBuilders`, porch `status.yaml` parsing); dashboard `packages/dashboard/src/components/WorkView.tsx` + `BuilderCard.tsx`; shared types in `packages/types/src/api.ts`.
- CLI: `packages/codev/src/agent-farm/cli.ts` (Commander `.command().action()`).
- Tests: Vitest in `packages/codev/src/agent-farm/__tests__/` (`state.test.ts`, `tower-routes.test.ts`, e2e under `__tests__/e2e/`).

## Success Metrics
- [ ] All spec Success Criteria (#1–#6 + backward compat) met.
- [ ] Each phase has unit tests; critical paths have integration tests; dashboard changes have Playwright coverage at N=1 and N>1.
- [ ] No reduction in existing coverage; the afx/Tower/dashboard suites stay green.
- [ ] N=1 (single `main` architect) behavior and dashboard rendering are unchanged.
- [ ] Documentation (`CLAUDE.md`/`AGENTS.md`, `agent-farm.md`, role docs, skeleton templates) updated for every new surface.

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_1_ledger", "title": "Issue-ownership ledger + dedup-at-spawn (#3): SQLite table + migration, ledger CRUD, spawn recording, dedup gate with --override-owner, CODEV_ARCHITECT_NAME N>1 validation"},
    {"id": "phase_2_roster", "title": "Architect roster (#1): afx architects [--json] command + GET /api/workspaces/:enc/architects Tower endpoint, joining architect table to ledger + builders + overview cache + last-activity"},
    {"id": "phase_3_bounded_state", "title": "Bounded/rotated state files (#5): templated head/<!-- ARCHIVE BOUNDARY -->/history, afx state rotate command + entry-boundary rotation util (loss-free), role-doc/template updates"},
    {"id": "phase_4_lifecycle", "title": "Architect lifecycle (#4): create architect state file from template on add-architect (idempotent); archive state file + release ledger + re-home builders to main on remove-architect"},
    {"id": "phase_5_board", "title": "Unified board / who-owes-next (#2): extend overview API + WorkView to group open threads by owning architect with a total who-owes-next function; optional afx architects --board text digest"},
    {"id": "phase_6_sha_pin", "title": "Builder-base SHA-pin (#6): at spawn, fetch + rev-parse the integration/default branch tip and branch the builder from that SHA; fail-fast on fetch error; --base override; read default branch (no hardcoded main)"},
    {"id": "phase_7_docs", "title": "Documentation: CLAUDE.md/AGENTS.md, agent-farm.md, role docs, skeleton templates for afx architects, --override-owner, --base, state rotation, lifecycle semantics"}
  ]
}
```

## Phase Breakdown

### Phase 1: Issue-ownership ledger + dedup-at-spawn (#3)
**Dependencies**: None — the data foundation.

#### Objectives
- Persist a durable `issue_number → architect` ownership record at spawn, independent of builder lifecycle.
- Block a second architect from spawning on an issue already owned by a different architect, unless explicitly overridden.

#### Files
- `packages/codev/src/agent-farm/db/schema.ts` — add `issue_ownership` table to `LOCAL_SCHEMA` (`CREATE TABLE IF NOT EXISTS`) with a **partial unique index** on `(workspace_path, issue_number) WHERE released = 0`.
- `packages/codev/src/agent-farm/db/index.ts` — add a versioned migration in `ensureLocalDatabase()` so existing DBs gain the table + index.
- `packages/codev/src/agent-farm/state.ts` — ledger CRUD: `recordOwnership`, `getOwner`, `releaseOwnership`, `listOwnershipForArchitect`, `overrideOwnership` (release-and-reinsert with `override_of`).
- `packages/codev/src/agent-farm/commands/spawn.ts` — resolve the spawning architect (with `--override-owner`), validate `CODEV_ARCHITECT_NAME` in N>1, run the dedup check, write the ledger entry after `upsertBuilder`.
- `packages/codev/src/agent-farm/cli.ts` — add `--override-owner` to the `spawn` command.
- `packages/codev/src/agent-farm/__tests__/state.test.ts` (+ a focused `ledger.test.ts`) — CRUD + dedup + atomicity tests.

#### Implementation Details
- **Schema**: columns `workspace_path TEXT NOT NULL, issue_number TEXT NOT NULL, architect TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), released INTEGER NOT NULL DEFAULT 0, released_at TEXT, override_of TEXT`. Partial unique index `CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_ownership_live ON issue_ownership(workspace_path, issue_number) WHERE released = 0` — this makes the dedup check-then-insert **atomic** (a concurrent double-spawn loses on the constraint; surface that as the dedup warning).
- **Architect resolution at spawn**: `SPAWNING_ARCHITECT_NAME` currently = `process.env.CODEV_ARCHITECT_NAME || 'main'` (module-scope, `spawn.ts:36`). Make it resolvable per-invocation so `--override-owner` can supersede it. **N>1 validation**: if more than one architect is registered for the workspace and the resolved name is not a registered architect, fail loud (do not default to `main`). N=1 keeps the `main` fallback.
- **Dedup gate**: before/at the ledger write, look up the live owner for `issue_number`; if it exists and differs from the spawning architect, print a clear warning naming the owner and **refuse** unless `--override-owner` was passed. `--resume` and same-architect spawns never trip. Override = `releaseOwnership(prior)` + `recordOwnership(new, override_of=prior)`.
- **Ledger durability**: builder `cleanup` and issue close do **not** release entries (per spec); release happens only via override, `remove-architect` (Phase 4), or a future explicit command.

#### Acceptance Criteria
- [ ] Spawning issue N records `N→<architect>`; re-spawn/resume by the same architect does not block.
- [ ] A different architect spawning N is refused with a named warning; `--override-owner` proceeds and records `override_of`.
- [ ] Concurrent double-spawn yields exactly one live owner (unique-index test).
- [ ] N>1 spawn with unset/unknown `CODEV_ARCHITECT_NAME` is refused; N=1 unchanged.
- [ ] Migration creates the table + index on a pre-existing DB without data loss.

#### Test Plan
- **Unit**: ledger CRUD; override release-and-reinsert; partial-unique-index rejects a second live owner; N>1 name validation.
- **Integration**: a spawn path test (mocked git/Tower) that records ownership and blocks a cross-architect spawn.

#### Risks
- **Migration on existing DBs** → use `CREATE TABLE/INDEX IF NOT EXISTS` + a versioned migration; test against a seeded old DB.
- **Resolving architect per-invocation without breaking module-scope readers** → centralize resolution in a helper used by all spawn paths (`spawnSpec`, `spawnTask`, etc.).

---

### Phase 2: Architect roster — `afx architects` (#1)
**Dependencies**: Phase 1 (reads the ledger).

#### Objectives
- One authoritative table: per architect → owned issues (+open/closed), live builders, last-activity, state-file path.

#### Files
- `packages/codev/src/agent-farm/commands/architects.ts` — new command (table + `--json`).
- `packages/codev/src/agent-farm/cli.ts` — register `afx architects [--json]`.
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — new `GET /api/workspaces/:encoded/architects` handler (the POST/DELETE on this path already exist for add/remove; add the GET branch).
- `packages/core/src/tower-client.ts` — `getArchitects(workspacePath)` client method.
- `packages/codev/src/agent-farm/servers/overview.ts` — reuse `OverviewCache` issue list for open/closed; expose a helper if needed.
- `packages/types/src/api.ts` — `ArchitectRosterRow` shape.
- `packages/codev/src/agent-farm/__tests__/` — roster join + degraded-forge unit tests; a route test.

#### Implementation Details
- **Join**: `architect` table (via `loadState`) ⋈ ledger (Phase 1) ⋈ `builders` (`spawned_by_architect = name`) ⋈ last-activity.
- **Open/closed**: intersect ledger issue ids against the **existing overview/issue cache** (no per-issue forge shell-out). When the cache is unavailable/stale, render status `unknown` (never block on forge).
- **Last-activity**: `max(architect terminal-session timestamp, most-recent owned-builder updated_at)`; `—` if neither.
- **State-file path**: `codev/state/architects/<name>.md` (created by Phase 4; the roster shows the path whether or not it exists yet, flagging missing).
- **N=1**: a single coherent `main` row; `--json` parses.

#### Acceptance Criteria
- [ ] `afx architects` renders the joined table at N=1 and N>1; `--json` is valid and parseable.
- [ ] Open/closed labels come from the cache; forge outage degrades to `unknown` without error or >1s latency.
- [ ] Last-activity matches the most-recent of terminal/builder activity.

#### Test Plan
- **Unit**: roster assembly from seeded architect/ledger/builder rows; degraded-forge path; last-activity selection.
- **Integration**: `GET …/architects` route returns the expected JSON; CLI renders it.

#### Risks
- **<1s budget** → no per-issue shell-out; reuse the cache. Test with a stubbed slow/absent forge.

---

### Phase 3: Bounded / rotated state files (#5)
**Dependencies**: None (templates + rotation util). Ordered before Phase 4 because Phase 4 creates the architect state file from this template.

#### Objectives
- A templated head/history structure with a machine-parseable boundary, and a loss-free rotation that keeps cold-resume cost bounded.

#### Files
- `codev/state/` template assets — an **architect-state template** and the **boundary marker** convention; mirror into `codev-skeleton/` where adopters need it.
- `codev/roles/builder.md` + `codev-skeleton/roles/builder.md` — teach the head/`<!-- ARCHIVE BOUNDARY -->`/history structure for builder `*_thread.md` (extends the #823 thread-file section).
- `codev/roles/architect.md` + `codev-skeleton/roles/architect.md` — same structure for the architect state file.
- `packages/core/src/state-rotation.ts` (or `packages/codev/src/lib/`) — pure rotation function: parse below the boundary, move oldest **whole entries** into `codev/state/archive/<id>-<date>.md`, never split a fenced code block.
- `packages/codev/src/agent-farm/commands/state-rotate.ts` + `cli.ts` — `afx state rotate <id>` (and an internal entry point for opportunistic triggers).
- `.gitignore` — ensure `codev/state/archive/` retention is handled per project convention (commit vs ignore — follow existing `codev/state/` disposition; archives are history, default commit).
- Tests — rotation correctness + loss-free reconstruction.

#### Implementation Details
- **Template regions**: `# <title>` + bounded head (AI-maintained "current state"), then `<!-- ARCHIVE BOUNDARY -->`, then `## History` (append-only entries delimited by `### ` or `---`).
- **Rotation**: operates **only** below the boundary, at whole-entry boundaries; when the history region exceeds the cap (configurable; default in bytes/lines), move the oldest entries to the dated archive. The head is never auto-truncated (convention-bounded). **Loss-free invariant**: `archive + live` concatenation reconstructs the original (tested).
- **Trigger**: explicit `afx state rotate <id>` + opportunistic call on lifecycle/digest events (Phase 4 add/remove, Phase 5 board regeneration). **No daemon / file watcher.**
- **Date in archive name**: passed in by the caller (the rotation util takes a date argument; the CLI supplies it) — keeps the util pure/testable.

#### Acceptance Criteria
- [ ] A state file exceeding the cap rotates only whole history entries below the boundary; a fenced code block is never split; head untouched.
- [ ] `archive + live` reconstructs the original content (loss-free).
- [ ] Builder and architect role docs/templates carry the structure; `copy-skeleton` validation confirms the shipped skeleton matches.
- [ ] No new always-on process is introduced.

#### Test Plan
- **Unit**: rotation on fixtures (with/without code blocks, under/over cap); reconstruction invariant; idempotence (rotating an under-cap file is a no-op).
- **Manual**: run `afx state rotate` on a large fixture thread file.

#### Risks
- **History loss / markdown corruption** → relocate-not-delete; entry-boundary parsing; reconstruction test is a hard gate.
- **AI not following the template head** → role-doc guidance; rotation only touches the history region, so a sloppy head never causes data loss.

---

### Phase 4: Architect lifecycle — state file on add, archive + release on retire (#4)
**Dependencies**: Phase 1 (ledger release) + Phase 3 (state-file template).

#### Objectives
- Add-architect always yields a state file (from template, idempotent); remove-architect archives it and releases owned builders/issues — no hand-renaming, no orphans.

#### Files
- `packages/codev/src/agent-farm/servers/tower-instances.ts` — in `addArchitect` (after `setArchitectByName`, ~L987): create `codev/state/architects/<name>.md` from the Phase 3 template if absent (never clobber). In `removeArchitect` (around `setArchitectByName(...,null)` ~L1161): archive the state file → `codev/state/archive/architects/<name>-<date>.md`, release ledger entries, re-home builders.
- `packages/codev/src/agent-farm/state.ts` — `releaseOwnershipForArchitect(name)` and `rehomeBuildersToMain(name)` (`UPDATE builders SET spawned_by_architect='main' WHERE spawned_by_architect=name`).
- (Possibly) `commands/workspace-add-architect.ts` / `workspace-remove-architect.ts` — only if any client-side messaging needs updating; the substantive work is server-side.
- Tests — add creates file (idempotent); remove archives + releases + re-homes.

#### Implementation Details
- **On add** (ordered): create state file from template if missing (idempotent — re-adding a retired name restores rather than overwrites).
- **On remove** (ordered): (1) archive state file (recoverable, not deleted); (2) `releaseOwnershipForArchitect`; (3) `rehomeBuildersToMain` — builders **keep running**; routing already falls back to `main` post-#774, so the column update makes the new home explicit, no routing-code change; (4) remove architect row (existing). **No worktree removal** (per Amendment 1, #6 is SHA-pin — there is no architect worktree).
- **`main` guard**: `remove-architect` already refuses to remove `main` — unchanged.

#### Acceptance Criteria
- [ ] `add-architect <name>` creates `codev/state/architects/<name>.md`; re-running does not clobber an edited file.
- [ ] `remove-architect <name>` archives the state file (recoverable), marks its ledger entries released, and re-homes its live builders to `main` (still running).
- [ ] Routing from a re-homed builder lands on `main`.

#### Test Plan
- **Unit**: idempotent create; archive move; ledger release; builder re-home SQL.
- **Integration**: route-level add then remove, asserting filesystem + DB + SSE side effects (reuse the `architects-updated` SSE from #823).

#### Risks
- **Workspace-relative path resolution** (state dir lives under the workspace, not the Tower cwd) → resolve from the workspace path the handler already has.
- **Filesystem race with a live AI writing the file** → archive is a move of the file as-is; the AI re-creates on next write if needed (acceptable; documented).

---

### Phase 5: Unified board / who-owes-next (#2)
**Dependencies**: Phase 1 (ledger) + Phase 2 (roster data/types).

#### Objectives
- The dashboard Work view can group open threads by owning architect, each with a deterministic who-owes-next signal; optional CLI text digest.

#### Files
- `packages/codev/src/agent-farm/servers/overview.ts` — add the who-owes-next derivation (a **total function** over already-parsed porch/overview state) and architect-grouping data to the overview payload.
- `packages/types/src/api.ts` — extend the overview shape with who-owes-next + grouping fields (additive, optional).
- `packages/dashboard/src/components/WorkView.tsx` (+ CSS) — group by `spawnedByArchitect` and render who-owes-next **only when `architectCount > 1`** (reuse `architectCount` + `OverviewBuilder.spawnedByArchitect` from #823 — **no new dashboard deps**).
- `packages/codev/src/agent-farm/commands/architects.ts` — optional `--board` text digest (nice-to-know; may defer).
- Tests — who-owes-next unit tests (all cases incl. `unknown`); Playwright N=1-identical + N>1 grouping.

#### Implementation Details
- **who-owes-next** (total, with `unknown` fallback): pending human gate → architect; mid-phase progressing → builder; review-complete / PR-open-awaiting-merge → architect; ledger entry with no active builder → architect; idle/stuck builder → builder (stalled); else → `unknown`.
- **N=1 invariant**: grouping/who-owes-next render is gated behind `architectCount > 1`; N=1 Work view renders byte-identically to today.

#### Acceptance Criteria
- [ ] Work view groups open threads by owning architect at N>1, each showing item, state/phase, who-owes-next.
- [ ] who-owes-next returns a defined value (never crashes) for every state, including `unknown`.
- [ ] N=1 Work view is byte-identical to pre-984 (Playwright snapshot/textContent).

#### Test Plan
- **Unit**: who-owes-next over every enumerated state + a deliberately ambiguous one (→ `unknown`).
- **Playwright**: N=1 identical; N=2/3 grouping + who-owes-next labels render (per the UI-visual-verification discipline).

#### Risks
- **N=1 regression** → gate all new rendering behind `architectCount > 1`; visual-verify.
- **who-owes-next ambiguity** → enforced `unknown` fallback; tested.

---

### Phase 6: Builder-base SHA-pin (#6)
**Dependencies**: None (localized to the spawn base-resolution path). Independent — could be reordered earlier; kept here per the spec's "staged last" guidance.

#### Objectives
- Every builder branches from a fresh, known-good integration-branch-tip SHA captured at spawn — never the shared checkout's stale live HEAD.

#### Files
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — in `createWorktree()` (and `createWorktreeFromBranch()` where relevant), resolve the base: fetch the integration ref + `rev-parse` to a SHA, then `git worktree add <path> <sha>` (instead of branching from live HEAD).
- `packages/codev/src/agent-farm/commands/spawn.ts` — thread a resolved `--base` through; pass the default-branch/base to `createWorktree`.
- `packages/codev/src/agent-farm/cli.ts` — add `--base <ref|sha>` to `spawn`.
- (Read) default-branch source — derive from git (`git symbolic-ref refs/remotes/origin/HEAD`) and/or config; **do not hardcode `main`**.
- Tests — base-pin from a deliberately-stale checkout; fail-fast on fetch error; `--base` override; non-`main` default branch.

#### Implementation Details
- **Resolution**: (1) determine the integration/default branch (config/forge default, falling back to `origin/HEAD`); (2) `git fetch <remote> <branch>`; (3) `git rev-parse <remote>/<branch>` → base SHA; (4) `git branch <builder-branch> <sha>` + `git worktree add <path> <sha>`.
- **Fail-fast**: if the fetch fails, **error loudly**; do **not** silently fall back to stale local HEAD (that would reintroduce the hazard). `--base <ref|sha>` lets the architect pin an explicit base deliberately.
- **Backward compat**: common case resolves to a fresh `origin/main` — what operators already expect; no new directories/config.

#### Acceptance Criteria
- [ ] With the shared checkout left on a stale commit/other branch, a spawned builder's base is the freshly-fetched integration tip (merge-base with `origin/main` = `origin/main` tip).
- [ ] Fetch failure fails the spawn loud; `--base <sha>` branches from the explicit SHA.
- [ ] Default branch is read, not hardcoded (a workspace defaulting to `ci` pins `origin/ci`).

#### Test Plan
- **Unit/Integration**: spawn against a fixture repo with a stale local HEAD → builder branches from origin tip; simulate fetch failure → loud error; `--base` override path; non-`main` default.

#### Risks
- **Wrong base / silent stale fallback** → read the real default branch; fail-fast (no silent fallback); `--base` escape hatch — all tested.
- **Added fetch latency** → bounded single fetch; correctness-critical; acceptable.

---

### Phase 7: Documentation
**Dependencies**: All prior phases (documents their surfaces).

#### Objectives
- Every new command/flag/semantic is discoverable in the canonical docs and role files.

#### Files
- `CLAUDE.md` + `AGENTS.md` (repo root) — `afx architects`, `--override-owner`, `--base`, state rotation, lifecycle/re-home semantics; keep the two byte-identical.
- `codev/resources/commands/agent-farm.md` — full reference entries.
- `codev-skeleton/templates/CLAUDE.md` + `…/AGENTS.md` — adopter-facing variants.
- `codev/roles/architect.md` + `codev/roles/builder.md` (+ skeleton copies) — any role-facing notes not already added in Phase 3.
- Run the repo's `copy-skeleton`/validation to confirm shipped skeleton matches.

#### Implementation Details
- Mirror the #823 documentation pattern (one coherent section per surface; CLAUDE.md/AGENTS.md identical; skeleton templates adopter-friendly).

#### Acceptance Criteria
- [ ] All new surfaces documented; CLAUDE.md == AGENTS.md; skeleton templates carry equivalent content; `copy-skeleton` validation passes.

#### Test Plan
- **Manual/CI**: skeleton-sync validation; doc-link check if present.

#### Risks
- **Drift between CLAUDE.md and AGENTS.md** → edit atomically; verify byte-identity.

---

## Cross-Phase Risk Assessment
- **Six interdependent points in one PR** → strict dependency ordering (1 → 2; 3 → 4; 1 → 5; 6 independent; 7 last); each phase a self-contained commit; CMAP at PR.
- **N=1 backward compatibility** → every phase that touches a user surface verifies N=1 is unchanged; dashboard changes gated behind `architectCount > 1` and Playwright-verified.
- **DB migration safety** → `IF NOT EXISTS` + versioned migration tested against a seeded old DB.
- **#6 correctness** → fail-fast + read-real-default-branch + `--base`, all tested (the spec's highest-impact risk row).
- **Privacy** → no source-workspace identifiers in code/tests/fixtures/docs (generalized fixtures only).

## Consultation Log
<!-- Populated by porch-orchestrated 3-way plan consultation. -->
**Date**: TBD
**Models Consulted**: TBD (gemini, codex, claude)
**Sections Updated**: TBD

## Phase Status Tracking
- [ ] Phase 1 — Ledger + dedup (`pending`)
- [ ] Phase 2 — Roster (`pending`)
- [ ] Phase 3 — Bounded state files (`pending`)
- [ ] Phase 4 — Lifecycle (`pending`)
- [ ] Phase 5 — Board / who-owes-next (`pending`)
- [ ] Phase 6 — Builder-base SHA-pin (`pending`)
- [ ] Phase 7 — Documentation (`pending`)
