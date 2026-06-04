# Specification: Multi-Architect Coordination Layer (roster · board · dedup-at-spawn · lifecycle · bounded state · checkout isolation)

## Metadata
- **ID**: spec-2026-06-03-984-multi-architect-coordination-l
- **Status**: draft
- **Created**: 2026-06-03
- **GitHub Issue**: [#984](https://github.com/cluesmith/codev/issues/984)
- **Area**: `area/tower`
- **Predecessors**: #755 (per-architect primitive), #761 (tab strip), #774 (affinity routing), #786 (lifecycle/persistence/UX), **#823 (coordination-b — builder attribution, messaging docs, builder thread files, VSCode refresh)**

## Clarifying Questions Asked

Issue #984 is a detailed six-point field report, generalized from a private heavy-use workspace (peak 5 architects + 7 builders) and routed via Shannon's operator. The deliverables, scope boundaries, and "build all six as one coherent SPIR" framing are explicit in the issue body, so no pre-draft clarification was solicited from the architect. However, mapping the field report onto *this* repository surfaced design forks that are recorded in **Open Questions** (most consequentially: the architect-state-file convention, the state-rotation mechanism, and the checkout-isolation approach). These are flagged for resolution at the spec-approval gate rather than guessed silently.

One scoping reconciliation was made during drafting and is documented in **Current State**: the issue describes "architect state files" with unbounded strikethrough history that get hand-renamed to `*-inactive`. That convention lived in the private source workspace. In *this* codebase, architect identity is persisted in SQLite (not markdown), and the only on-disk state files are the per-*builder* `codev/state/<id>_thread.md` logs introduced by #823. This spec therefore treats point #4 as *introducing* a first-class architect state-file convention, and point #5 as bounding both that new file and the existing builder thread files.

## Problem Statement

Codev/afx lets an operator **spawn** N architects in one workspace (the `workspace add-architect` / `remove-architect` primitives shipped across #755/#786, and #823 made the *builder→architect* relationship visible). But the workspace still gives the operator no first-class way to **see, route, dedup, or retire** architects as a fleet. Every coordination function that a second human would perform falls back onto the single operator. The source workspace observed five failure modes, every one of which recurred:

1. **The human is the registry.** No command answers "which architect owns what." The operator holds the roster in their head.
2. **The human is the message router.** Cross-architect coordination is relayed by hand. Sibling messaging (`afx send architect:<name>`) exists and was documented by #823, but it remains under-surfaced — there is no place that *shows* the operator who to route to.
3. **Duplicate investigation.** One symptom was independently investigated by three architects under three issues; the overlap was discovered only after the fact, at roughly 3× the cost. (An audit confirmed the fleet's actual code changes were largely orthogonal — the waste is coordination, not diff contention.)
4. **Lifecycle / state drift.** ~14 architect identities churned in ~2 weeks. Retirement was performed by hand-renaming state files to `*-inactive`; some live architects had no state file at all; one appointed architect's state file was never created. Where state files existed, they grew unbounded (tens of KB of strikethrough history), making a cold resume of an architect's context expensive.
5. **Shared checkout couples the fleet.** All architects share one git checkout. A branch switch by any one architect yanks the working tree out from under the siblings, and builders branch from the shared HEAD — so one stale checkout makes *everyone's* new builders stale. The current mitigation is a fragile, human-enforced "never switch branches" discipline rule.

The unifying diagnosis: **the coordination layer that a second operator would provide does not exist as software.** This spec builds it.

## Current State

### What already exists (do not rebuild)

| Capability | Status | Where |
|---|---|---|
| `afx workspace add-architect --name <n>` / `remove-architect` | ✅ exists | `cli.ts` → `commands/workspace-add-architect.ts`, `…-remove-architect.ts` → Tower `addArchitect`/`removeArchitect` |
| Architect persistence (survives Tower stop/start) | ✅ exists (#786) | SQLite `architect` table, composite PK `(workspace_path, id)`; `state.ts` load/reconcile |
| Spawn affinity (builder remembers spawning architect) | ✅ exists (#774) | `CODEV_ARCHITECT_NAME` env → `commands/spawn.ts` → `builders.spawned_by_architect` |
| `afx status` enumerates architects + builders | ✅ exists (#786) | `commands/status.ts` |
| Builder attribution visible on dashboard Work view | ✅ exists (#823) | `OverviewBuilder.spawnedByArchitect`, `BuilderCard` |
| Sibling messaging `afx send architect:<name>` + docs | ✅ exists (#774) + documented (#823) | `tower-messages.ts`; `CLAUDE.md`/`AGENTS.md`/`agent-farm.md` |
| Per-builder thread file `codev/state/<id>_thread.md` | ✅ convention exists (#823) | free-text markdown, written by the builder AI; no code reads/writes it |
| Cross-project board (`afx tower`) + dashboard Work view | ✅ exists | `servers/tower-routes.ts`, `servers/overview.ts`, `packages/dashboard/src/components/WorkView.tsx` |

### What does **not** exist (the gaps this spec fills)

- **No `afx architects` roster.** `afx status` lists architects but does not join them to owned issues, live builders, last-activity, or a state-file path. There is no single "who owns what" surface.
- **No issue-ownership ledger.** `builders.spawned_by_architect` records *builder*→architect affinity, but it is per-builder and lifecycle-bound (it disappears semantics-wise once a builder is cleaned up). There is no durable *issue*→architect record, and therefore no dedup-at-spawn check.
- **No architect state-file convention.** Architect identity is in SQLite; there is no per-architect markdown working-memory file, no template for one, and no lifecycle that creates/archives it.
- **No bounded-state mechanism.** Builder thread files (and any future architect state file) are free-text markdown an AI appends to; nothing caps the head or rotates the history. Cold-resume cost is unbounded.
- **No per-architect checkout.** All architects operate in the single main checkout; builders `git worktree add` from its shared HEAD. There is no per-architect working tree, and the "never switch branches" rule is the only thing preventing the fleet from yanking each other's trees.

## Desired State

A workspace operator running N architects can:

1. Run **`afx architects`** and see a single table: each architect, the open issues it owns, its live builders, its last activity, and its state-file path. This is the authoritative answer to "who owns what."
2. See the same ownership/state picture, **grouped by architect**, on the dashboard (extending the existing Work view rather than adding a separate artifact), including a "who-owes-next" signal per open thread (is the ball with the architect or the builder?).
3. Have **issue ownership recorded automatically at spawn**, and be **warned (and required to override)** when spawning a second architect onto an issue already owned by a *different* architect — catching the duplicate-investigation failure before the work is done, not after.
4. **Add** an architect and have its state file created from a template automatically; **retire** an architect and have its state file archived and its owned builders/issues released — no hand-renaming, no orphaned or missing state files.
5. Trust that state files stay **bounded**: a capped "current state" head with older history auto-rotated into an archive, so a cold resume reads a predictable, small amount.
6. Give each architect its **own checkout** so that one architect switching branches never disturbs a sibling, and a builder always branches from a fresh, architect-local base — retiring the "never switch branches" discipline rule.

Backward compatibility is a hard requirement: a workspace with a single `main` architect (the overwhelmingly common case) must see **zero behavior change** unless it opts into the new surfaces. N=1 dashboards render identically; `afx architects` works but is trivially a one-row table; checkout isolation degenerates to "main architect uses the main checkout" exactly as today.

## Stakeholders
- **Primary Users**: Workspace operators running multi-architect fleets (today: the private source workspace; Shannon as the concrete external N>1 adopter).
- **Secondary Users**: Single-architect operators (must be unaffected); architect AI sessions (consume the roster/board, write bounded state files); builder AI sessions (branch from architect-local checkouts).
- **Technical Team**: Codev maintainers (Tower, afx CLI, dashboard).
- **Business Owners**: M Waleed Kadous (architect / approver).

## Success Criteria

- [ ] **#1 Roster** — `afx architects` prints a table with, per architect: name, owned open issues (count + ids), live builders (count + ids), last-activity timestamp, and state-file path. Works at N=1 (one row) and N>1. A machine-readable form (`--json`) is available for tooling.
- [ ] **#2 Board** — The dashboard Work view can present open threads grouped by owning architect, each row showing item, owning architect, state/phase, and who-owes-next. Implemented as an extension of the existing Work view / overview API, not a separate artifact. N=1 renders identically to today.
- [ ] **#3 Ledger + dedup** — Every numbered spawn records an issue→architect ownership entry keyed by the spawning architect (via existing affinity). A spawn onto an issue already owned by a *different* architect prints a clear warning and **refuses** unless an override flag is passed. Same-architect re-spawn (e.g. `--resume`) is never blocked. Issue-level dedup only (no fuzzy symptom matching).
- [ ] **#4 Lifecycle** — `workspace add-architect` creates the architect's state file from a template if absent (idempotent: never clobbers an existing file). `workspace remove-architect` archives the state file and releases the retiring architect's owned issues and live builders per a defined, documented policy. No state file is ever silently missing for a live architect.
- [ ] **#5 Bounded state** — A defined mechanism caps the "current state" head of a state file and rotates older history to an archive, keeping cold-resume cost predictable. Applies to `codev/state/<id>_thread.md` (builders) and the architect state file from #4. The mechanism does not corrupt or lose history (it relocates, not deletes).
- [ ] **#6 Checkout isolation** — Each architect operates against its own checkout/worktree; a branch switch by one architect does not disturb a sibling. Builders spawned by an architect branch from that architect's checkout base. The `main` architect maps to the existing main checkout (no migration for the common case). The "never switch branches" rule is no longer required.
- [ ] **Backward compat** — A single-`main`-architect workspace exhibits no behavioral or visual change without opt-in.
- [ ] All new tests pass; no reduction in existing coverage; the existing afx/Tower/dashboard suites stay green.
- [ ] Documentation updated (`CLAUDE.md`/`AGENTS.md`, `codev/resources/commands/agent-farm.md`, role docs) for every new surface.

## Constraints

### Technical Constraints
- **Tooling is fixed** (baked by repo conventions): TypeScript; Commander.js for the afx CLI; the Tower HTTP server + REST client (`packages/core/tower-client.ts`); SQLite via the existing `db/schema.ts` for persisted state; React/Vite for the dashboard; **Vitest** for tests. New persisted state (e.g. the ownership ledger) must use the existing SQLite database and the established `(workspace_path, …)` scoping pattern — no new datastore.
- **Forge abstraction**: any issue metadata (open/closed, title) must go through the existing forge concept layer (`lib/forge.ts`), not a hardcoded `gh` call, so non-GitHub providers degrade gracefully.
- **Architect identity is SQLite-backed** (`architect` table, PK `(workspace_path, id)`); the roster, ledger, and lifecycle build on this, not a parallel store.
- **Worktrees share one object store**: per-architect checkout isolation must use git worktrees (or an equivalent that shares the object store), not full clones, to keep disk cost bounded — unless the design review explicitly justifies otherwise.
- **`main` is reserved** and maps to the main checkout (symmetric with the existing `afx dev main` reserved-target pattern).
- **No new always-on background process**: rotation/bounding must be triggered (on a lifecycle/digest event or by an explicit command), not a new daemon.

### Business Constraints
- **No time estimates** (per protocol).
- Backward compatibility for N=1 workspaces is non-negotiable.
- The private source workspace's specifics (names, project ids, product terminology) must NOT leak into code, tests, fixtures, or docs — only the generalized pattern ships.

## Assumptions
- The spawning architect is reliably known at spawn time via `CODEV_ARCHITECT_NAME` (established by #774); ownership recording can rely on it.
- The architect-state-file convention is new and owned by this spec; no external tool depends on a prior format.
- Live builders spawned by a retiring architect should continue running (not be killed); "release" means re-homing ownership, not termination (consistent with the #823 observation that such builders keep running and route to `main`).
- Git worktrees are available (they already back the builder model), so per-architect worktrees are mechanically feasible.

## Solution Approaches

The six points are interdependent but separable. The cheapest/highest-leverage pieces (#3 ledger + #1 roster) share a data foundation; #2 reads it; #4 manages lifecycle around it; #5 is contained; #6 is the large structural change. Below, each point lists the recommended approach plus the alternatives weighed.

### Point #3 — Issue-ownership ledger + dedup-at-spawn  (foundation, highest leverage)

**Recommended — durable ledger table, dedup gate at spawn.** Add an `issue_ownership` table (SQLite, scoped by `workspace_path`) recording `issue_number → architect`, first-owner-wins, with a timestamp and a `released` flag. At numbered spawn, the spawning architect is recorded; if a *different* architect already owns an unreleased entry for that issue, spawn prints a warning naming the owner and refuses unless `--override-owner` (name TBD) is passed. `--resume` and same-architect spawns never trip the gate.

- **Pros**: Durable across builder cleanup (catches the real failure mode — overlap discovered late); cheap; reuses affinity; clear UX.
- **Cons**: New table + migration; must define release semantics (handled by #4); needs a deliberate override path.
- **Alternatives considered**: (a) *Derive ownership from `builders.spawned_by_architect`* — rejected: lifecycle-bound and per-builder, so it can't catch overlap once a builder is cleaned up, and it has no entry for an issue an architect is investigating without a builder. (b) *Fuzzy "same symptom" matching* — explicitly out of scope per the issue (issue-level dedup only).

**Complexity**: Low–Medium. **Risk**: Low.

### Point #1 — Architect roster (`afx architects`)

**Recommended — read-only join command + Tower endpoint.** New `afx architects [--json]` command and a Tower API endpoint that joins the `architect` table to: owned open issues (from the #3 ledger, filtered to open via forge), live builders (`builders` where `spawned_by_architect = name`), last-activity (most recent terminal/builder activity for that architect), and the architect's state-file path (#4). Renders a table.

- **Pros**: Single source of truth for "who owns what"; pure read; trivially correct at N=1.
- **Cons**: "Last-activity" needs a defined source (terminal session timestamp vs. ledger/builder activity) — an Open Question.
- **Alternatives**: Fold the roster into `afx status` instead of a new command — rejected: `afx status` is already dense and the roster's join (issues, state-file path) is a distinct concern; a dedicated command is clearer and `--json`-friendly.

**Complexity**: Low. **Risk**: Low.

### Point #2 — Unified board / digest

**Recommended — extend the dashboard Work view + overview API; optional CLI digest.** Per the issue's explicit preference ("prefer extending the existing dashboard Work view / `afx tower` over a separate artifact"), add an architect-grouped presentation to the Work view: open threads grouped by owning architect, each showing item, state/phase, and **who-owes-next**. "Who-owes-next" is derived from porch gate/phase state already parsed in `overview.ts` (a pending human gate ⇒ owed by the architect; an in-progress phase ⇒ owed by the builder). Optionally expose the same digest as text via the roster command (e.g. `afx architects --board`) for terminal users.

- **Pros**: One artifact, auto-derived, no new file to keep in sync (directly answers failure mode #4's "one artifact vs N state files"); reuses overview plumbing.
- **Cons**: "Who-owes-next" needs a crisp derivation rule; grouping UI must preserve N=1 identical rendering.
- **Alternatives**: A generated markdown digest file regenerated on spawn/gate/merge — rejected as the primary surface (the issue prefers extending existing surfaces; a file reintroduces a sync burden). May still be offered as a CLI text view.

**Complexity**: Medium. **Risk**: Low–Medium (dashboard regression surface — must verify N=1 visually).

### Point #4 — Formal lifecycle (state file on add, archive/release on retire)

**Recommended — enforce state file from template on add; archive + release on remove.** Extend the existing add/remove paths. On add: if the architect's state file (convention below) does not exist, create it from a template; never clobber an existing file. On remove: move the state file to an archive location (e.g. an archive subdirectory, or a header-marked archived file — Open Question), mark the architect's owned ledger entries `released`, and re-home its live builders' attribution to `main` (builders keep running). Document the policy.

- **Pros**: Eliminates hand-renaming, missing files, and orphaned ownership in one pass; builds directly on #3's ledger.
- **Cons**: Requires choosing the architect-state-file convention/location and the archive shape (Open Questions); "re-home to main" is a policy choice that should be explicit and documented.
- **Alternatives**: Keep lifecycle hand-managed (status quo) — rejected, it is the source of failure mode #4.

**Complexity**: Medium. **Risk**: Low–Medium.

### Point #5 — Bounded, templated state files

**Recommended — templated head/history split + an explicit rotation command, triggered on lifecycle/digest events.** Define a state-file template with a bounded "current state" head section and an appended history section. Provide a rotation operation that, when a file's history exceeds a configured cap, relocates the oldest history into a dated archive file (never deletes), keeping the live file's head small and predictable. Trigger rotation on lifecycle/digest events and/or an explicit `afx`/`team` subcommand — **not** a daemon. Applies to builder `*_thread.md` and the architect state file.

- **Pros**: Bounds cold-resume cost; loss-free (relocate, not delete); no background process.
- **Cons**: These files are free-text written by an AI, so the head/history structure must be a *convention the AI follows* plus a *mechanical rotation* of the history tail — the boundary between "AI-maintained head" and "machine-rotated history" must be unambiguous (Open Question on exact structure and trigger).
- **Alternatives**: (a) Convention-only guidance in role docs with no tooling — rejected: relies on the AI self-policing length, which is exactly what failed. (b) A hook/daemon that watches and rotates — rejected: violates the no-new-daemon constraint and is surprising.

**Complexity**: Medium. **Risk**: Medium (correctness of rotation; must not lose history).

### Point #6 — Per-architect checkout isolation  (largest / riskiest)

**Recommended — per-architect git worktree, with `main` mapped to the main checkout.** Give each non-`main` architect its own git worktree (sharing the object store, cheap on disk — the same mechanism that backs builders). The architect's terminal runs in its worktree; builders it spawns branch from *that* worktree's HEAD/base rather than the shared main checkout. `main` continues to use the main checkout, so the common case needs no migration. This eliminates the shared-tree coupling and the stale-HEAD→stale-builder hazard, and retires the "never switch branches" rule.

- **Pros**: Architects gain independent branch state; builder bases become architect-local and fresh; reuses the proven worktree model; disk cost bounded (shared objects).
- **Cons**: Largest blast radius — touches Tower (must know each architect's checkout root), the spawn base-resolution path, lifecycle (create the worktree on add, remove it on retire), and disk layout. Migration story for an *existing* multi-architect workspace must be defined. Needs careful 3-way review.
- **Alternatives**: (a) *Separate full clone per architect* — rejected: heavy disk, divergent object stores, slower. (b) *Keep shared checkout but pin each builder's base to a SHA captured at spawn (not live HEAD)* — partially mitigates the stale-builder hazard but does **not** let architects switch branches independently, so it fails the explicit "retire the never-switch-branches rule" goal. May be a fallback if worktree isolation proves too invasive for one PR.

**Complexity**: High. **Risk**: High.

### Cross-cutting: PR sequencing

The issue suggests sequencing #3+#1 (cheap, high-leverage) first, then #5 (contained), then #4/#2 (enhancements), with #6 designed carefully and staged last. Per the builder PR strategy, all phases ship as commits within a single PR by default. **#6's size and risk may justify slicing it into its own PR** — this is an architect decision flagged in Open Questions; the plan will be structured so #6 is the final, independently sliceable phase.

## Open Questions

### Critical (Blocks Progress)
- [ ] **#6 PR slicing.** Should checkout isolation (#6) ship in the same PR as #1–#5, or as its own follow-up PR given its size/risk? (Recommendation: structure the plan so #6 is the last phase and *can* be sliced; architect decides at the gate.)
- [ ] **#6 migration.** For an *existing* multi-architect workspace, do we migrate live architects onto worktrees on next add/start, or only apply isolation to newly-added architects? (Recommendation: new architects get worktrees; `main` and pre-existing architects keep the main checkout until explicitly migrated — least disruptive.)

### Important (Affects Design)
- [ ] **Architect state-file convention.** Where does the architect state file live and what is it named? Candidates: `codev/state/<name>_architect.md`, `codev/state/architect-<name>.md`, or a dedicated `codev/state/architects/<name>.md`. (Must not collide with builder `*_thread.md`.)
- [ ] **State rotation: structure + trigger.** Exact head/history boundary in the template, the cap (lines/bytes), the archive file naming, and what triggers rotation (lifecycle event, digest regeneration, explicit command, or a combination).
- [ ] **Dedup override flag.** Name and ergonomics of the spawn override (`--override-owner`? `--force-owner`? reuse `--force`?). Must be distinct from the existing dirty-tree `--force`.
- [ ] **Retire policy for live builders.** Confirm "keep running, re-home attribution to `main`" vs. an alternative (e.g. require `--force` to retire while builders are live).
- [ ] **"Last-activity" source for the roster** — terminal-session timestamp, most-recent owned-builder activity, or ledger mtime?

### Nice-to-Know (Optimization)
- [ ] Should `afx architects` offer a `--board` text digest (#2 in the terminal) in this spec, or defer to dashboard-only?
- [ ] Should the dedup check warn (non-blocking) on a *closed/merged* prior-owned issue, or only on open ones?

## Performance Requirements
- `afx architects` and the overview/board endpoint must remain interactive (well under ~1s for a realistic fleet of ≤ ~10 architects / ~20 builders); they are read joins over local SQLite + cached forge data, so no heavy queries.
- State-file rotation operates on small markdown files; it must be fast enough to run inline on a lifecycle event without a perceptible stall.
- Per-architect worktree creation reuses the existing builder-worktree cost profile (object store shared); no new heavy I/O beyond a worktree add per architect.

## Security Considerations
- **No new auth surface.** All new commands/endpoints are workspace-local, consistent with existing afx/Tower scope. The ownership ledger and roster expose only data already visible within the workspace.
- **Spoofing**: ownership recording relies on `CODEV_ARCHITECT_NAME`, the same trust basis as existing affinity routing; the dedup override must not become a way to silently reassign ownership without it being visible in the ledger (record overrides).
- **Privacy**: the source workspace's identifying details must not appear in code/tests/fixtures/docs.

## Test Scenarios

### Functional Tests
1. **Ledger happy path**: architect `main` spawns issue 100 → ledger records `100→main`; `afx architects` shows `main` owning 100.
2. **Dedup block**: architect `b` spawns issue 100 (owned by `main`) → spawn refuses with a warning naming `main`; with `--override-owner` it proceeds and the override is recorded.
3. **Same-architect re-spawn / resume**: `main` re-spawns/resumes issue 100 → no block.
4. **Roster at N=1**: fresh workspace, only `main` → `afx architects` prints a single coherent row; `--json` parses.
5. **Roster at N>1**: two architects with distinct owned issues + live builders → table shows correct joins and state-file paths.
6. **Add-architect creates state file**: `add-architect --name b` with no existing file → file created from template; running it again does not clobber an edited file.
7. **Remove-architect archives + releases**: retire `b` → its state file is archived (recoverable), its ledger entries marked released, its live builders keep running with attribution re-homed to `main`.
8. **Rotation is loss-free**: a state file whose history exceeds the cap → head stays bounded, overflow relocated to an archive, total history preserved (concatenation reconstructs the original).
9. **Board / who-owes-next**: an issue at a pending human gate shows "owed by architect"; an issue mid-phase shows "owed by builder"; grouping by architect is correct.
10. **Checkout isolation**: architect `b` (worktree) switches branches → `main`'s working tree is unaffected; a builder spawned by `b` branches from `b`'s base, not main's HEAD.
11. **Backward compat**: single-`main` workspace — dashboard Work view renders byte-identically; no worktree created for `main`; all commands behave as before.

### Non-Functional Tests
1. **Performance**: roster/board endpoints return within budget for a ≤10-architect/≤20-builder fleet.
2. **Migration safety (#6)**: applying isolation to a new architect does not disturb existing architects' checkouts or running builders.
3. **No-daemon check**: rotation runs only on triggers/commands; no new always-on process is introduced.

## Dependencies
- **External Services**: GitHub (via the forge abstraction) for issue open/closed/title; must degrade gracefully for other forges.
- **Internal Systems**: Tower server + REST client; SQLite state DB + `db/schema.ts`; afx CLI (Commander); dashboard overview API + Work view; git worktree machinery (`spawn-worktree.ts`).
- **Libraries/Frameworks**: Existing only — Commander, Vitest, React/Vite, the project's SQLite layer. No new runtime dependency anticipated.

## References
- Issue [#984](https://github.com/cluesmith/codev/issues/984)
- Predecessor specs/reviews: `codev/specs/823-multi-architect-coordination-b.md` (+ its review), `…/786-…`, `…/774`-era affinity, `…/755-…`, `…/761-…`
- Surfaces: `packages/codev/src/agent-farm/cli.ts`, `commands/spawn.ts`, `commands/spawn-worktree.ts`, `commands/workspace-add-architect.ts`, `…-remove-architect.ts`, `db/schema.ts`, `state.ts`, `servers/tower-routes.ts`, `servers/overview.ts`, `lib/forge.ts`; `packages/dashboard/src/components/WorkView.tsx`; `packages/types/src/api.ts`

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| #6 checkout isolation destabilizes Tower / spawn base resolution | Med | High | Stage #6 last and sliceable; 3-way review the design; provide the "pin base to SHA" fallback; `main`→main-checkout keeps the common path untouched |
| Dashboard N>1 grouping regresses N=1 rendering | Med | Med | Gate all grouping behind `architectCount > 1`; visual-verify N=1 identical (per UI-verification discipline) |
| State rotation loses history | Low | High | Relocate-not-delete; test that concatenation reconstructs the original; never operate in place destructively |
| Ledger semantics confuse same-architect resume / closed issues | Med | Med | Explicit "same-architect never blocks" rule; Open Question on closed-issue behavior resolved before coding |
| Scope creep across six interdependent points in one PR | High | Med | Phase the plan by leverage (#3+#1 → #5 → #4+#2 → #6); each phase independently committable; #6 sliceable |
| Source-workspace details leak into the public repo | Low | Med | Generalized fixtures only; scrub names/ids/terminology |

## Expert Consultation
<!-- Populated by porch-orchestrated 3-way consultation after the initial draft. -->
**Date**: TBD
**Models Consulted**: TBD (gemini, codex, claude)
**Sections Updated**: TBD

## Approval
- [ ] Architect (human) review at `spec-approval` gate
- [ ] Expert AI Consultation Complete (3-way)

## Notes
- This spec deliberately ships recommended defaults with explicitly-flagged Open Questions rather than guessing the consequential forks (architect-state-file convention, rotation mechanism, #6 approach/slicing). These are the right things for the architect to decide at the gate.
- "Build all six as one coherent SPIR" is honored: the points share a data foundation (the ledger) and a presentation (roster/board), and lifecycle/state/checkout all hang off the same architect identity. The plan will phase them by leverage and keep #6 sliceable.

---

## Amendments

<!-- TICK amendments, if any, are appended here in chronological order. -->
