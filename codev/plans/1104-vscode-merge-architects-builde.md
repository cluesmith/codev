# PIR Plan: Merge Architects + Builders into a single adaptive "Agents" tree (VSCode)

## Understanding

Issue #1104 wants the Codev VSCode sidebar to surface architect→builder ownership
(`spawnedByArchitect`) by replacing the parallel "Architects" and "Builders" views with one
**Agents** tree that is *architect-rooted when there is more than one architect* and collapses
to today's area/phase grouping when there is exactly one. It also rewrites `Codev: Add Architect`
from a direct CLI shell-out into a request routed to the `main` architect.

### Important correction to the issue's premise

The issue describes "two parallel trees (Architects + Builders)". **In the VSCode extension that
is not the current state.** There is exactly one builder tree view registered
(`codev.builders` → `BuildersProvider`, `extension.ts:418`) plus a *Workspace > Architects
subsection* living inside the `codev.workspace` view (`WorkspaceProvider.getArchitectChildren`,
`workspace.ts:75,253-293`). There is **no standalone `codev.architects` tree view** to remove —
verified against `package.json` `contributes.views` (only `codev.workspace`, `codev.builders`,
`codev.backlog`, `codev.pullRequests`, `codev.recentlyClosed`, `codev.team`, `codev.status`,
`codev.placeholder`, `codev.devServer`). The "standalone Architects tree" in the issue maps to
the Tower **dashboard**, not the extension.

Consequence for scope: the work is **(a)** add an adaptive architect tier to the existing
Builders tree and rename it Agents, and **(b)** rewrite Add Architect. The "remove the standalone
Architects tree / repurpose its view id" bullet is a no-op for the extension — the Workspace >
Architects subsection stays exactly as-is (it is already the "workspace configuration" surface the
issue's "Workspace view delineation" section wants to preserve). I will confirm this reading with
the reviewer at the plan gate rather than hunt for a tree that isn't there.

### Data the design needs, and where it lives today

- **`OverviewBuilder.spawnedByArchitect`** (`packages/types/src/api.ts:201`) — already on the wire,
  populated by the overview server from `state.db.builders.spawned_by_architect`
  (`overview.ts:822-828`). This is the builder→architect edge. `null` for legacy / unmatched rows.
- **Architect roster** (names, which is `main`, presence of passive architects like REVIEWER that
  never spawn) is **not** in `OverviewData`. It is fetched via
  `client.getWorkspaceStatus(workspacePath)` → `terminals.filter(t => t.type === 'architect')`,
  each carrying `architectName` (`tower-client.ts:330,34-48`). `WorkspaceProvider` already consumes
  this and re-renders on the `architects-updated` SSE envelope (`workspace.ts:44-53`).

So the Agents tree needs *both* the builder list (overview cache, synchronous) *and* the architect
roster (async workspace-status fetch). The roster is required — deriving architects from
`spawnedByArchitect` alone would silently drop passive architects, which the issue explicitly wants
rendered as interactive leaf rows.

## Proposed Change

### 1. Architect-roster source in BuildersProvider — **Option A (recommended)**

Give `BuildersProvider` an architect roster it refreshes the same way `WorkspaceProvider` does:

- On construction, subscribe to the `architects-updated` SSE envelope (and reuse the existing
  overview-cache `onDidChange`), fetch `getWorkspaceStatus`, cache `architectName[]` (main-first),
  and fire `onDidChangeTreeData`.
- `architectCount` = roster length. Drives the adaptive root.

Rationale: keeps the entire change inside the VSCode extension, mirrors an established, tested
pattern (`WorkspaceProvider.getArchitectChildren`), and changes no wire contract. The roster fetch
is cached (not re-fetched per `getChildren` call), so render stays cheap.

**Alternative B (considered, not chosen): enrich `/api/overview` with `architects: ArchitectState[]`.**
Cleaner in one respect — a single atomic cache carrying builders + roster, synchronous render, and
the dashboard could reuse it. Rejected for this PIR because it changes the `OverviewData` wire type
and adds roster plumbing into the Tower overview builder (`overview.ts`), pushing a VSCode-scoped
change into `area/tower` and `area/core`. If the reviewer prefers B at the plan gate I will switch;
it is a clean swap of the data source behind the same tree logic.

### 2. Adaptive root in the tree (`builders.ts`)

Introduce an **architect tier** as an outer wrapper around the existing grouping strategies, which
stay one-level and unchanged (`builder-grouping.ts` is untouched — honoring the issue's "strategy
interface should stay unchanged"):

- `rootChildren()` branches on `architectCount`:
  - **=== 1** (or 0): today's behaviour exactly — return area/phase group headers (or the flattened
    lone-`Uncategorized` rows). This branch is a bit-for-bit regression target.
  - **> 1**: return one **architect node** per roster entry (main-first). Each architect node's
    `collapsibleState` is `Collapsed` when it owns ≥1 builder, `None` (leaf) when it owns none — the
    passive-architect rule. Architect rows are interactive (click → open that architect's terminal
    via `codev.openArchitectTerminal`; right-click → message), so a childless REVIEWER stays a usable
    leaf.
- A new `getChildren` branch for an architect node returns that architect's builders grouped by the
  **existing** active strategy (area or phase) at level 2 — i.e. the level-2 group headers are
  produced by delegating to `this.active().group(...)` over only that architect's builders. Level-3
  builder rows and their file-tree children are unchanged.
- Builders are partitioned to architects by `spawnedByArchitect`. Builders with `null` /
  unknown-owner are collected under a synthetic **"Unassigned"** architect node at the end (decision
  to confirm at gate — see Open Questions; the alternative is hiding them, which would make builders
  vanish from the tree, so I lean to an explicit Unassigned bucket).

### 3. Rollups extend to two tiers (`builder-row.ts`, `builder-tree-item.ts`)

`rollupGroupState` / `worstBuilderState` / `BUILDER_STATE_GLYPH` already take an arbitrary builder
list, so they extend with no signature change:

- **Level 1 (architect node):** rollup over *all* builders owned by the architect (sum across its
  area/phase groups). Same glyph vocabulary, same worst-of severity, same
  `"<b> blocked · <i> waiting · <a> active"` tooltip shape. A new lightweight
  `ArchitectGroupTreeItem` (sibling of `BuilderGroupTreeItem`, likely sharing `AreaGroupTreeItem`)
  carries the architect label, count, rollup icon, and `contextValue` for the message/open menus.
- **Level 2 (area/phase header):** unchanged `BuilderGroupTreeItem` rollup over that architect's
  subset.

### 4. `description` badge for architect attribution (`builders.ts` / `builder-row.ts`)

In the single-architect-collapsed view the architect tier is absent, so per the issue the architect
name rides as a dim `description` badge on builder rows **only when `architectCount > 1`** (so
single-architect workspaces stay clean). In the multi-architect tree the architect is already in the
row's ancestry, so the badge is suppressed there to avoid duplication. Net: the badge appears only in
sub-trees where the owning architect is not an ancestor (matching the issue's rule).

### 5. `getParent` / accordion / auto-reveal (`builders.ts`)

`getParent` must walk the new chain so `reveal()` (accordion #913, active-file sync #1066) still
works in the multi-architect tree: builder → area/phase group → architect node → root. The
`groupParentByBuilderId` map gains a parallel `architectParentByGroup` (or the builder→group map is
extended to also record the group→architect link). Single-architect mode keeps today's two-level
chain untouched. The accordion (`collapseBuildersExcept`, `AccordionRowIds`) operates on builder
rows and is unaffected by an added ancestor level, but I will add regression coverage.

### 6. Rename Builders → Agents

- `package.json` `contributes.views.codev.builders.name`: `"Builders"` → `"Agents"`.
- **View id `codev.builders` is kept** (not renamed to `codev.agents`) to avoid breaking saved view
  layouts, `when`-clause references, and the `buildersView` handle wiring in `extension.ts`. Only the
  display name changes. (Open Question flags the id-migration alternative for the reviewer.)
- Title/tooltips and the grouping-toggle command titles that say "Builders" updated to "Agents"
  where user-facing; internal symbol names (`BuildersProvider`, `buildersView`) left as-is to keep
  the diff reviewable (rename is cosmetic and high-churn; can be a follow-up).

### 7. Add Architect → conversational (`extension.ts:802`, maybe `commands/`)

Rewrite `codev.addArchitect`:

1. Resolve the `main` architect's session from `getWorkspaceStatus` (terminals, `type==='architect'`,
   `architectName==='main'`). If main is absent or has no live session, show a modal explaining the
   action asks main to add, with the CLI fallback (`afx workspace add-architect --name <name>` /
   `afx workspace start`). Refuse — do **not** silently fall back to direct creation.
2. Input box for the new architect name, reusing the existing `validateArchitectName` shared
   validator (parity with `afx workspace add-architect`).
3. Dispatch `client.sendMessage('architect:main', "Please add a <name> architect.", { workspace })`
   (the `architect:<name>` addressing form `/api/send` already supports). Toast on success.
4. v1 scope per issue: **name-only** (no scope/brief prompt), **no auto-open** of main's terminal —
   both listed as deferrable polish in the issue. Open Questions surfaces these for the reviewer.

The command is reachable from the Agents title-bar `+`, the Workspace > Architects `+`, the
`Cmd+K A` keybinding, and the palette — all already bound to `codev.addArchitect`, so no new
contributions are needed beyond pointing the Agents title `+` at it.

## Files to Change

- `packages/vscode/src/views/builders.ts` — adaptive `rootChildren()` (architectCount branch),
  architect-node `getChildren` branch, architect partition by `spawnedByArchitect` + Unassigned
  bucket, two-tier `getParent`, `description` badge wiring, roster cache + `architects-updated`
  subscription.
- `packages/vscode/src/views/builder-tree-item.ts` — new `ArchitectGroupTreeItem` (label, count,
  tier-1 rollup icon, `contextValue`, click→`codev.openArchitectTerminal`); leaf vs collapsed state.
- `packages/vscode/src/views/builder-row.ts` — no signature change expected; possibly a small helper
  for the architect-attribution `description` string. (Rollup helpers reused as-is.)
- `packages/vscode/src/views/builder-grouping.ts` — **unchanged** (strategy interface stays
  one-level); noted explicitly so the reviewer knows the wrapper is the new outer concern.
- `packages/vscode/src/extension.ts` — rewrite `codev.addArchitect` handler (main-resolve →
  send-to-main; main-absent → modal+CLI fallback); ensure Agents title `+` points at it.
- `packages/vscode/package.json` — `codev.builders` view `name` → `"Agents"`; menu/title strings
  "Builders"→"Agents" where user-facing; Agents title-bar `+` contribution if not already present.
- `packages/vscode/src/__tests__/builder-grouping.test.ts` — multi-architect partition/rollup cases.
- `packages/vscode/src/__tests__/builders-accordion.test.ts` — accordion unaffected by added tier.
- `packages/vscode/src/__tests__/builders-autoreveal.test.ts` — `getParent` three-level chain.
- New: `packages/vscode/src/__tests__/add-architect.test.ts` (or extend an existing handler test) —
  main-present → message dispatched; main-absent → modal + CLI fallback; name-validation parity.
- New: a small unit test for the architect-tier partition/rollup pure logic (mirroring
  `builder-row.test.ts` style) if the logic is extracted to a vscode-free helper for testability.

## Risks & Alternatives Considered

- **Risk: the "remove standalone Architects tree" bullet has no target in VSCode.** Mitigation:
  treat it as a no-op, keep Workspace > Architects intact, and confirm the reading at the plan gate.
  This is the single most important thing for the reviewer to validate before any code is written.
- **Risk: async roster fetch vs synchronous render.** `rootChildren()` is currently synchronous.
  Mitigation: cache the roster in the provider (fetched on SSE/refresh), so `getChildren` reads it
  synchronously; never block render on a fetch. `architectCount` defaults to 1 until the first roster
  load completes → the tree renders today's behaviour during the brief warm-up, never a broken tree.
- **Risk: builders with `spawnedByArchitect: null` (legacy / unmatched) disappearing.** Mitigation:
  explicit "Unassigned" architect bucket in multi-architect mode. (Confirm at gate.)
- **Risk: `getParent` regressions break accordion + active-file reveal.** Mitigation: dedicated
  autoreveal test for the three-level chain; single-architect chain kept byte-identical.
- **Alternative — enrich `/api/overview` with the roster (Option B):** cleaner single cache, but
  crosses into `area/tower`/`area/core` and changes a wire type. Deferred unless the reviewer prefers
  it.
- **Alternative — keep two views, add a badge only (issue's rejected "plain badge"):** doesn't give
  the architect-rooted triage view the issue asks for; rejected per the issue's own design discussion.
- **Alternative — rename view id to `codev.agents`:** cleaner naming but risks saved-layout / when-
  clause breakage; deferred (Open Questions).

## Test Plan

The reviewer exercises the running worktree at the `dev-approval` gate.

- **Unit (vitest, `pnpm --filter @cluesmith/codev-vscode test` from the worktree):**
  - Architect partition: builders bucket to the right architect by `spawnedByArchitect`; null →
    Unassigned.
  - Tier-1 rollup: worst-of severity + counts sum across an architect's area/phase groups.
  - Adaptive root: `architectCount === 1` returns today's group nodes (regression — snapshot of
    current output); `> 1` returns architect nodes with correct leaf/collapsed states (passive
    architect → leaf).
  - `getParent` three-level chain resolves builder → group → architect.
  - Add Architect: main-present dispatches `sendMessage('architect:main', ...)`; main-absent shows
    modal with CLI fallback; invalid name rejected by shared validator (parity).
- **Manual (VSCode, against a running Tower):**
  - Single-architect workspace: Agents tree looks identical to today's Builders tree (area/phase
    groups, no architect rows, no architect `description` badge). Toggle area↔phase still works.
  - Multi-architect workspace (`afx workspace add-architect --name <x>`): Agents shows architect rows;
    builders nest under their owner with area/phase sub-grouping; passive architect renders as a
    clickable leaf; rollup glyphs/tooltips correct at both tiers; `description` badge absent (owner is
    ancestor).
  - Accordion + click-to-open-terminal still work on builder rows under the architect tier.
  - Add Architect from the Agents `+`: with main running → message lands in main's terminal; with
    main closed → modal points to the CLI fallback.
  - Workspace > Architects subsection unchanged and still in sync via `architects-updated`.
- **Cross-platform:** N/A (desktop VSCode extension only).
