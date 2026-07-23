# Specification: Multi-Architect Coordination Layer (roster · board · dedup-at-spawn · lifecycle · bounded state · builder-base SHA-pin)

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
- **No pinned builder base.** Builders `git worktree add` from the shared checkout's **live HEAD**, so a builder inherits whatever commit (possibly badly stale, possibly the wrong branch) the shared checkout happens to be on. Observed in practice: builders branched from a `main` that was ~145 commits behind. There is no capture of a fresh known-good base SHA at spawn.

## Desired State

A workspace operator running N architects can:

1. Run **`afx architects`** and see a single table: each architect, the open issues it owns, its live builders, its last activity, and its state-file path. This is the authoritative answer to "who owns what."
2. See the same ownership/state picture, **grouped by architect**, on the dashboard (extending the existing Work view rather than adding a separate artifact), including a "who-owes-next" signal per open thread (is the ball with the architect or the builder?).
3. Have **issue ownership recorded automatically at spawn**, and be **warned (and required to override)** when spawning a second architect onto an issue already owned by a *different* architect — catching the duplicate-investigation failure before the work is done, not after.
4. **Add** an architect and have its state file created from a template automatically; **retire** an architect and have its state file archived and its owned builders/issues released — no hand-renaming, no orphaned or missing state files.
5. Trust that state files stay **bounded**: a capped "current state" head with older history auto-rotated into an archive, so a cold resume reads a predictable, small amount.
6. Trust that every builder branches from a **fresh, known-good base SHA** captured at spawn (the integration/default branch tip), never from whatever stale commit the shared checkout happens to be sitting on — eliminating the stale/wrong-base-builder hazard without restructuring how architects share the checkout.

Backward compatibility is a hard requirement: a workspace with a single `main` architect (the overwhelmingly common case) must see **zero behavior change** unless it opts into the new surfaces. N=1 dashboards render identically; `afx architects` works but is trivially a one-row table; builder-base SHA-pinning degenerates to "branch from a fresh `origin/main`," which is what operators already expect.

## Stakeholders
- **Primary Users**: Workspace operators running multi-architect fleets (today: the private source workspace; Shannon as the concrete external N>1 adopter).
- **Secondary Users**: Single-architect operators (must be unaffected); architect AI sessions (consume the roster/board, write bounded state files); builder AI sessions (branch from a pinned known-good base SHA).
- **Technical Team**: Codev maintainers (Tower, afx CLI, dashboard).
- **Business Owners**: M Waleed Kadous (architect / approver).

## Success Criteria

- [ ] **#1 Roster** — `afx architects` prints a table with, per architect: name, owned open issues (count + ids), live builders (count + ids), last-activity timestamp, and state-file path. Works at N=1 (one row) and N>1. A machine-readable form (`--json`) is available for tooling.
- [ ] **#2 Board** — The dashboard Work view can present open threads grouped by owning architect, each row showing item, owning architect, state/phase, and who-owes-next. Implemented as an extension of the existing Work view / overview API, not a separate artifact. N=1 renders identically to today.
- [ ] **#3 Ledger + dedup** — Every numbered spawn records an issue→architect ownership entry keyed by the spawning architect (via existing affinity). A spawn onto an issue already owned by a *different* architect prints a clear warning and **refuses** unless an override flag is passed. Same-architect re-spawn (e.g. `--resume`) is never blocked. Issue-level dedup only (no fuzzy symptom matching).
- [ ] **#4 Lifecycle** — `workspace add-architect` creates the architect's state file from a template if absent (idempotent: never clobbers an existing file). `workspace remove-architect` archives the state file and releases the retiring architect's owned issues and live builders per a defined, documented policy. No state file is ever silently missing for a live architect.
- [ ] **#5 Bounded state** — A defined mechanism caps the "current state" head of a state file and rotates older history to an archive, keeping cold-resume cost predictable. Applies to `codev/state/<id>_thread.md` (builders) and the architect state file from #4. The mechanism does not corrupt or lose history (it relocates, not deletes).
- [ ] **#6 Builder-base SHA-pin** — At spawn, the builder's base is a fresh SHA captured by fetching + `rev-parse`-ing the integration/default branch tip (e.g. `origin/main`, or the workspace's configured default), and the builder branch is created from that SHA — not from the shared checkout's live HEAD. A fetch failure fails the spawn loud (no silent fallback to stale local HEAD). A `--base <ref|sha>` override allows a deliberate non-default base. The common case (fresh `origin/main`) matches existing operator expectations. (Architects continue to share the main checkout; per the architect's decision, no per-architect worktrees and no `.architects/` directories are introduced.)
<!-- REVIEW(@architect): This one I'm not quite so sure about because architects have to interact with builders and if they're started in a subdir they may not be able to do that directly. -->
- [ ] **Backward compat** — A single-`main`-architect workspace exhibits no behavioral or visual change without opt-in.
- [ ] All new tests pass; no reduction in existing coverage; the existing afx/Tower/dashboard suites stay green.
- [ ] Documentation updated (`CLAUDE.md`/`AGENTS.md`, `codev/resources/commands/agent-farm.md`, role docs) for every new surface.

## Constraints

### Technical Constraints
- **Tooling is fixed** (baked by repo conventions): TypeScript; Commander.js for the afx CLI; the Tower HTTP server + REST client (`packages/core/tower-client.ts`); SQLite via the existing `db/schema.ts` for persisted state; React/Vite for the dashboard; **Vitest** for tests. New persisted state (e.g. the ownership ledger) must use the existing SQLite database and the established `(workspace_path, …)` scoping pattern — no new datastore.
- **Forge abstraction**: any issue metadata (open/closed, title) must go through the existing forge concept layer (`lib/forge.ts`), not a hardcoded `gh` call, so non-GitHub providers degrade gracefully.
- **Architect identity is SQLite-backed** (`architect` table, PK `(workspace_path, id)`); the roster, ledger, and lifecycle build on this, not a parallel store.
- **Builder-base SHA-pin must read the workspace's real default branch**, not hardcode `main` (some workspaces default to `ci`). It must capture the base via a fresh fetch + `rev-parse` of the remote integration ref, and **fail loud** on fetch error rather than silently using a stale local HEAD.
- **No new checkout topology**: per the architect's decision, #6 introduces no per-architect worktrees, no `.architects/` directories, and no Tower checkout-root changes — it is a localized change to the spawn base-resolution path only.
- **`main` is reserved** as an architect identity (symmetric with the existing `afx dev main` reserved-target pattern).
- **No new always-on background process**: rotation/bounding must be triggered (on a lifecycle/digest event or by an explicit command), not a new daemon.

### Business Constraints
- **No time estimates** (per protocol).
- Backward compatibility for N=1 workspaces is non-negotiable.
- The private source workspace's specifics (names, project ids, product terminology) must NOT leak into code, tests, fixtures, or docs — only the generalized pattern ships.

## Assumptions
- The spawning architect is reliably known at spawn time via `CODEV_ARCHITECT_NAME` (established by #774); ownership recording can rely on it.
- The architect-state-file convention is new and owned by this spec; no external tool depends on a prior format.
- Live builders spawned by a retiring architect should continue running (not be killed); "release" means re-homing ownership, not termination (consistent with the #823 observation that such builders keep running and route to `main`).
- The workspace's integration/default branch tip (e.g. `origin/main`, or `origin/ci`) is the correct known-good base for new builders, and is reachable via a fetch at spawn time; its name is discoverable from config/forge defaults rather than assumed.

## Solution Approaches

The six points are interdependent but separable. The cheapest/highest-leverage pieces (#3 ledger + #1 roster) share a data foundation; #2 reads it; #4 manages lifecycle around it; #5 is contained; #6 is the large structural change. Below, each point lists the recommended approach plus the alternatives weighed.

### Point #3 — Issue-ownership ledger + dedup-at-spawn  (foundation, highest leverage)

**Recommended — durable ledger table, dedup gate at spawn.** Add an `issue_ownership` table (SQLite, scoped by `workspace_path`) recording `issue_number → architect`, first-owner-wins, with `created_at`, an `released` flag (+ `released_at`), and an `override_of` column (the prior owner, populated only when an override created the row). At numbered spawn, the spawning architect is recorded; if a *different* architect already owns an **unreleased** entry for that issue, spawn prints a warning naming the owner and refuses unless `--override-owner` is passed. `--resume` and same-architect spawns never trip the gate.

**Precise ledger semantics** (resolving Codex/Claude feedback):
- **First-owner-wins.** The first unreleased entry for an `(workspace_path, issue_number)` is authoritative. A partial unique index on `(workspace_path, issue_number) WHERE released = 0` enforces at most one live owner and makes the check-then-insert **atomic** — a concurrent double-spawn cannot create two live owners (the loser's `INSERT` fails the constraint and is surfaced as the dedup warning). This closes the race Claude raised.
- **Override behavior.** `--override-owner` does **not** silently transfer. It marks the existing entry `released` (recording the releasing actor) and inserts a new live entry owned by the overriding architect with `override_of = <prior owner>`. The override is therefore auditable in the ledger, never silent.
- **Issue close / reopen.** Closing an issue does not auto-release its ledger entry (ownership is about *who is working it*, not issue state); the roster simply renders it under "owned" with status `closed`. Re-spawning the same architect on a reopened issue is the same-architect no-block path. (Whether the dedup check should *warn but not block* on a closed prior-owned issue is the one remaining nice-to-know Open Question.)
- **Builder cleanup** (`afx cleanup`) does **not** release the ledger entry — durability across cleanup is the entire point (it's what catches late-discovered overlap). Release happens only via `--override-owner`, `remove-architect` (#4), or an explicit future release command.
- **`CODEV_ARCHITECT_NAME` validation.** In an N>1 workspace, spawn must resolve a **registered** architect name; it must NOT silently fall back to `main` when the env var is unset/unknown (that would let a misconfigured terminal claim ownership as `main`). At N=1 the existing fall-back-to-`main` behavior is unchanged.

- **Pros**: Durable across builder cleanup (catches the real failure mode — overlap discovered late); cheap; reuses affinity; clear, auditable UX.
- **Cons**: New table + migration; release semantics couple to #4; needs a deliberate override path.
- **Alternatives considered**: (a) *Derive ownership from `builders.spawned_by_architect`* — rejected: lifecycle-bound and per-builder, so it can't catch overlap once a builder is cleaned up, and it has no entry for an issue an architect is investigating without a builder. (b) *Fuzzy "same symptom" matching* — explicitly out of scope per the issue (issue-level dedup only).

**Complexity**: Low–Medium. **Risk**: Low.

### Point #1 — Architect roster (`afx architects`)

**Recommended — read-only join command + Tower endpoint.** New `afx architects [--json]` command and a Tower API endpoint that joins the `architect` table to: owned issues (from the #3 ledger), live builders (`builders` where `spawned_by_architect = name`), last-activity, and the architect's state-file path (#4). Renders a table.

**Open/closed status source + degraded behavior** (resolving Claude/Codex feedback): the roster must stay interactive (<1s), so it must **not** shell out to the forge once per owned issue. Instead it reuses the **existing overview/issue cache** (`servers/overview.ts` already fetches the issue/PR lists via the forge concept layer and caches them) and **intersects** the ledger's owned issue ids against that cached set to label each as open/closed. When the forge cache is unavailable or stale, the roster still renders every owned issue id with status `unknown` (it never blocks on the forge) — local SQLite data (architect, ledger, builders) is always authoritative for the roster's structure. This keeps the command deterministic and within budget regardless of forge health.

**Last-activity source** (resolved): the most recent of (a) the architect's active terminal-session timestamp and (b) the `updated_at` of its most-recently-active owned builder — whichever is newer; `—` if neither exists.

- **Pros**: Single source of truth for "who owns what"; pure read; trivially correct at N=1; forge-outage tolerant.
- **Cons**: Reuses the overview cache, so open/closed labels are as fresh as that cache (acceptable; the roster is a coordination aid, not a forge mirror).
- **Alternatives**: Fold the roster into `afx status` — rejected: `afx status` is already dense and the roster's join (issues, state-file path) is a distinct concern; a dedicated `--json`-friendly command is clearer. Per-issue forge shell-out — rejected on the <1s budget.

**Complexity**: Low. **Risk**: Low.

### Point #2 — Unified board / digest

**Recommended — extend the dashboard Work view + overview API; optional CLI digest.** Per the issue's explicit preference ("prefer extending the existing dashboard Work view / `afx tower` over a separate artifact"), add an architect-grouped presentation to the Work view: open threads grouped by owning architect, each showing item, state/phase, and **who-owes-next**. The grouping reuses the existing React component structure plus the already-present `architectCount` and `OverviewBuilder.spawnedByArchitect` (both shipped by #823) — **no new dashboard dependencies** are required (resolving Claude's scope question). Optionally expose the same digest as text via the roster command (e.g. `afx architects --board`) for terminal users.

**Who-owes-next derivation** (resolving Claude/Codex edge-case feedback) — a small, total function over already-parsed porch/overview state, with an explicit fallback so the board is deterministic:
- Pending **human gate** (spec/plan/pr/dev approval) → **architect**.
- Builder mid-phase, actively progressing → **builder**.
- Review complete / **PR open awaiting merge** → **architect**.
- Issue in the ledger with **no active builder** (owned but not yet spawned) → **architect**.
- Builder present but **idle/stuck** (no pending gate, no recent activity) → **builder (stalled)** — surfaced distinctly so it reads as "needs a nudge."
- Any state not matching the above → **`unknown`** (never a crash; the board degrades gracefully).

- **Pros**: One artifact, auto-derived, no new file to keep in sync (directly answers failure mode #4's "one artifact vs N state files"); reuses overview plumbing; no new deps.
- **Cons**: The who-owes-next rule must be implemented as a total function with the `unknown` fallback; grouping UI must preserve N=1 identical rendering.
- **Alternatives**: A generated markdown digest file regenerated on spawn/gate/merge — rejected as the primary surface (the issue prefers extending existing surfaces; a file reintroduces a sync burden). May still be offered as a CLI text view.

**Complexity**: Medium. **Risk**: Low–Medium (dashboard regression surface — must verify N=1 visually).

### Point #4 — Formal lifecycle (state file on add, archive/release on retire)

**Recommended — enforce state file from template on add; archive + release on remove.** Extend the existing add/remove paths.

- **Architect state-file convention (resolved):** `codev/state/architects/<name>.md` — a dedicated subdirectory that cleanly namespaces architect state away from builder `*_thread.md` files in `codev/state/` (no collision risk).
- **On add:** if `codev/state/architects/<name>.md` does not exist, create it from the architect-state template; **never clobber** an existing file (idempotent — re-adding a previously-retired name reuses/restores rather than overwriting).
- **On remove — concrete release steps** (resolving Claude's "what does re-home mean" feedback), executed in this order:
  1. **Archive the state file**: move `codev/state/architects/<name>.md` → `codev/state/archive/architects/<name>-<date>.md` (recoverable; not deleted).
  2. **Release ledger entries**: mark every unreleased `issue_ownership` row owned by `<name>` as `released` (with `released_at`); the issues become re-claimable.
  3. **Re-home live builders**: `UPDATE builders SET spawned_by_architect = 'main'` for that architect's live builders — builders **keep running**; this is the concrete meaning of "re-home," and it makes `afx send architect` from those builders route to `main` (which the post-#774 routing in `tower-messages.ts` already does as a fallback, so no routing-code change is required — but the column update makes the new home explicit rather than implicit).
  4. **Remove the architect row** (existing behavior). (No worktree to remove — #6 is SHA-pin, not per-architect checkouts.)

- **Pros**: Eliminates hand-renaming, missing files, and orphaned ownership in one pass; builds directly on #3's ledger; release steps are explicit and ordered.
- **Cons**: "Re-home to main" is a deliberate policy (documented); couples to #3.
- **Alternatives**: Keep lifecycle hand-managed (status quo) — rejected, it is the source of failure mode #4.

**Complexity**: Medium. **Risk**: Low–Medium.

### Point #5 — Bounded, templated state files

**Recommended — templated head/history split with an explicit machine-parseable boundary marker + a triggered rotation command.** Define a state-file template with two regions separated by an **unambiguous delimiter comment** so rotation is never a blind line/byte cut (resolving Gemini's markdown-truncation-safety concern):

```
# <title>
... bounded "current state" head — AI-maintained, capped ...

<!-- ARCHIVE BOUNDARY -->
## History
... append-only log entries below this line ...
```

- **Rotation operates only on the region *below* `<!-- ARCHIVE BOUNDARY -->`**, and only at whole **entry** boundaries (e.g. `### `-delimited or `---`-delimited log entries) — it never splits a fenced code block or a partial markdown element. When the file exceeds its cap, the **oldest** complete history entries are *moved* (not deleted) into a dated archive file (`codev/state/archive/<id>-<date>.md`), leaving the head and the most-recent history intact. Concatenating archive + live file reconstructs the original (loss-free invariant, tested).
- **The cap** is a configurable threshold (default measured in bytes/lines of the history region); the head region is bounded by *convention* (the role docs instruct the AI to keep the head a small "current state" summary) and is never auto-truncated by the tool — only the history region rotates.
- **Trigger**: an explicit `afx state rotate <id>` (or equivalent) subcommand, plus opportunistic invocation on lifecycle/digest events (add/remove-architect, board regeneration). **No daemon, no file watcher** (honors the no-new-always-on-process constraint).
- Applies uniformly to builder `*_thread.md` and the architect `codev/state/architects/<name>.md` files (both adopt the boundary marker in their templates).

- **Pros**: Bounds cold-resume cost; loss-free (relocate at entry boundaries, never split markdown); deterministic boundary; no background process.
- **Cons**: Requires the templates and role docs to teach the head/boundary/history structure so the AI writes within it; the rotation tool must parse entry boundaries, not raw offsets.
- **Alternatives**: (a) Convention-only guidance with no tooling — rejected: relies on the AI self-policing length, which is exactly what failed. (b) Arbitrary line/byte truncation — rejected: splits markdown/code blocks (Gemini). (c) A hook/daemon that watches and rotates — rejected: violates the no-new-daemon constraint.

**Complexity**: Medium. **Risk**: Medium (correctness of rotation; must not lose history or split markdown).

### Point #6 — Builder-base SHA-pinning  (architect-directed: fallback B chosen over worktree isolation)

> **Post-approval architect decision (2026-06-04):** At the spec-approval gate the architect **replaced full per-architect checkout isolation with the documented fallback (B): builder-base SHA-pinning.** Rationale: the damaging failure mode observed in practice is the *stale/wrong-base builder* (builders repeatedly branched from a `main` that was ~145 commits behind), which SHA-pinning fixes directly and cheaply — without the high-risk Tower/spawn refactor that per-architect worktrees require. Architects continue to share the main checkout; the "never switch branches" discipline rule **stays** for architects (accepted — architects sit on the integration branch and rarely need independent branches). This resolves both former Open Questions (PR-slicing and migration ergonomics) — see below.

**Approach — capture a fresh known-good base SHA at spawn and branch the builder from it.** Today `createWorktree()` runs `git branch` + `git worktree add` from the shared checkout's **live HEAD**, so a builder inherits whatever (possibly stale, possibly wrong-branch) commit the shared checkout happens to be sitting on. Instead, at spawn:
1. **Resolve the integration/default branch** for the workspace — the repo's default branch tip, e.g. `origin/main` (or `origin/ci` in workspaces whose default branch is `ci`). The branch name is read from existing config/forge defaults, not hardcoded.
2. **Fetch + `rev-parse`** that remote ref to capture a fresh, explicit base SHA (`git fetch <remote> <branch>` then `git rev-parse <remote>/<branch>`).
3. **Branch the new builder from that SHA** (`git branch <builder-branch> <sha>` / `git worktree add <path> <sha>`), not from the shared checkout's working HEAD.

This eliminates the stale/wrong-base hazard regardless of what state any architect left the shared checkout in, and it is a localized change to the spawn base-resolution path — **no Tower refactor, no per-architect worktrees, no `.architects/<name>/` directories, no lifecycle/migration surface.**

- **Edge / failure handling:** if the fetch fails (offline / forge unreachable), spawn must **fail loud** with a clear error rather than silently falling back to the stale local HEAD (fail-fast — a silent fallback would reintroduce exactly the hazard this fixes). A `--base <ref|sha>` escape hatch lets the architect pin an explicit base when they deliberately want a non-default base (e.g. stacking on an unmerged branch).
- **Backward compatibility:** for the common case the captured SHA *is* `origin/main`'s tip, so behavior is "branch from a fresh main" — what operators already expect. No new directories, no gitignore changes, no dashboard/Tower changes.

- **Pros**: Directly kills the observed stale-base failure; small, localized diff in the spawn path; low blast radius; ships inside the main PR; no migration story needed.
- **Cons**: Does **not** give architects independent branch state — so the "never switch branches" rule remains for architects (explicitly accepted by the architect; architects rarely need it). Adds a fetch to the spawn path (small latency; acceptable, and correctness-critical).
- **Alternatives (now historical):** (a) *Per-architect git worktrees* — the spec's original recommendation; **rejected by the architect** as too high-risk (Tower/spawn refactor) for the benefit, given architects rarely switch branches. (b) *Separate full clone per architect* — rejected (heavy disk). (c) *Branch from live shared HEAD* — the status quo that causes the hazard.

**Complexity**: Low–Medium. **Risk**: Low–Medium (must fail-fast on fetch error; must read the correct default branch, not hardcode `main`).

### Cross-cutting: PR sequencing

The issue suggests sequencing #3+#1 (cheap, high-leverage) first, then #5 (contained), then #4/#2 (enhancements), with #6 last. Per the builder PR strategy, all phases ship as commits within a single PR. With the architect's decision to make #6 a small SHA-pin change (not worktree isolation), **all six points ship in one PR** — there is no longer any blast-radius reason to slice #6 out.

## Resolved Design Decisions

The first consultation pushed (Gemini + Codex REQUEST_CHANGES) to resolve the acceptance-critical forks rather than leave them open. These are now **fixed in the approaches above** and listed here for visibility; the architect can still overturn any at the gate:

- **Architect state-file convention** → `codev/state/architects/<name>.md` (dedicated subdir; no collision with builder `*_thread.md`).
- **Dedup override flag** → `--override-owner` (distinct from git-dirty `--force`); overrides are recorded in the ledger (`override_of`), never silent.
- **Ledger atomicity** → partial unique index on `(workspace_path, issue_number) WHERE released = 0`, making check-then-insert atomic (closes the concurrent-spawn race).
- **Retire / re-home policy** → builders keep running; their `spawned_by_architect` is updated to `main`; ledger entries marked `released`; state file archived. (No architect worktree to remove under SHA-pin.)
- **Roster last-activity** → max(terminal-session ts, most-recent owned-builder `updated_at`).
- **Roster open/closed source** → intersect ledger ids against the existing overview/issue cache; `unknown` when forge data is unavailable (never blocks).
- **State rotation** → machine-parseable `<!-- ARCHIVE BOUNDARY -->` delimiter; rotate only complete history entries below it into `codev/state/archive/…`; explicit command + opportunistic on lifecycle/digest events; no daemon.
- **`CODEV_ARCHITECT_NAME` validation** → in N>1 workspaces spawn requires a registered architect name (no silent fallback to `main`); N=1 fallback unchanged.
- **#6 approach (architect-directed, post-approval)** → **builder-base SHA-pin**, not per-architect worktrees. Capture a fresh integration-branch-tip SHA (fetch + `rev-parse`) at spawn and branch the builder from it; fail-fast on fetch error; `--base` override available. Architects keep sharing the main checkout; "never switch branches" stays for architects. Ships inside the main PR; no migration surface.

## Open Questions

### Resolved at the spec-approval gate (2026-06-04)
- ✅ **#6 approach** — architect chose **builder-base SHA-pin** over per-architect worktree isolation. *Consequence:* **#6 PR-slicing is moot** (SHA-pin is small/low-risk → ships in the main PR), and **pre-existing-architect migration ergonomics is moot** (no worktrees to migrate into; the `migrate-architect` surface is dropped entirely).
- ✅ **Resolved defaults confirmed** — `codev/state/architects/<name>.md` location, `--override-owner` release-and-reinsert semantics, and the re-home-to-`main` retire policy all stand as written (architect: "all other resolved decisions stand").

### Nice-to-Know (Optimization — defer to plan/implementation)
- [ ] Should `afx architects` ship a `--board` text digest (#2 in the terminal) in this spec, or defer to dashboard-only?
- [ ] Should the dedup check **warn-but-not-block** on a *closed/merged* prior-owned issue (vs. block the same as an open one)?
- [ ] Exact name/source of the integration branch for SHA-pin per workspace (config key vs. forge default) — a plan-level detail; the constraint (read it, don't hardcode `main`) is fixed.

## Performance Requirements
- `afx architects` and the overview/board endpoint must remain interactive (well under ~1s for a realistic fleet of ≤ ~10 architects / ~20 builders); they are read joins over local SQLite + cached forge data, so no heavy queries.
- State-file rotation operates on small markdown files; it must be fast enough to run inline on a lifecycle event without a perceptible stall.
- Builder-base SHA-pin adds one `git fetch` of the integration ref to the spawn path (small, bounded latency); it is correctness-critical and acceptable. No new background or per-architect disk cost.

## Security Considerations
- **No new auth surface.** All new commands/endpoints are workspace-local, consistent with existing afx/Tower scope. The ownership ledger and roster expose only data already visible within the workspace.
- **Spoofing**: ownership recording relies on `CODEV_ARCHITECT_NAME`, the same trust basis as existing affinity routing; the dedup override must not become a way to silently reassign ownership without it being visible in the ledger (record overrides via `override_of`).
- **N>1 attribution integrity**: in a multi-architect workspace, an unset/unknown `CODEV_ARCHITECT_NAME` must NOT silently default ownership to `main` (a misconfigured terminal would otherwise claim ownership it didn't earn); spawn refuses until a registered name resolves. N=1 keeps the existing `main` default.
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
10. **Builder-base SHA-pin**: with the shared checkout deliberately left on a stale commit (or a different branch), spawning a builder branches it from the freshly-fetched integration-branch-tip SHA — **not** the stale local HEAD. The resulting builder branch's merge-base with `origin/main` is `origin/main`'s tip.
11. **Backward compat**: single-`main` workspace — dashboard Work view renders byte-identically; SHA-pin resolves to a fresh `origin/main`; no new directories/config; all commands behave as before.
12. **Concurrent-spawn race**: two architects spawn on the same unowned issue near-simultaneously → exactly one wins the ledger (partial unique index), the other gets the dedup warning; no double live-owner.
13. **Env-var validation (N>1)**: spawn with `CODEV_ARCHITECT_NAME` unset/unknown in a >1-architect workspace → refused (no silent `main` ownership). At N=1, unchanged fallback to `main`.
14. **SHA-pin fail-fast**: with the integration ref unreachable (fetch fails), spawn **errors loudly** and does not silently branch from a stale local HEAD. A `--base <sha>` override branches from the explicit SHA instead.
15. **Rotation boundary safety**: a state file whose history region contains a fenced code block → rotation moves only whole entries below `<!-- ARCHIVE BOUNDARY -->`, never splitting the code block; head untouched.
16. **Override is auditable**: `--override-owner` releases the prior entry and inserts a new one with `override_of` set; the ledger shows the transfer history.

### Non-Functional Tests
1. **Performance**: roster/board endpoints return within budget for a ≤10-architect/≤20-builder fleet, including when forge data is stale (must not shell out per issue).
2. **SHA-pin isolation from shared-checkout state**: the captured base SHA is independent of the shared checkout's current branch/HEAD, so a builder's base is correct no matter what state any architect left the shared checkout in.
3. **No-daemon check**: rotation runs only on triggers/commands; no new always-on process is introduced.
4. **Loss-free rotation invariant**: archive file + live file concatenated reconstructs the original pre-rotation content.

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
| #6 SHA-pin reads the wrong base (hardcoded `main`) or silently falls back to stale HEAD on fetch failure | Med | High | Read the workspace's real default branch from config/forge, never hardcode; **fail-fast** on fetch error (no silent fallback); `--base` override; common case = fresh `origin/main` (unchanged expectation) |
| Dashboard N>1 grouping regresses N=1 rendering | Med | Med | Gate all grouping behind `architectCount > 1`; visual-verify N=1 identical (per UI-verification discipline) |
| State rotation loses history | Low | High | Relocate-not-delete; test that concatenation reconstructs the original; never operate in place destructively |
| Ledger semantics confuse same-architect resume / closed issues | Med | Med | Explicit "same-architect never blocks" rule; Open Question on closed-issue behavior resolved before coding |
| Scope creep across six interdependent points in one PR | High | Med | Phase the plan by leverage (#3+#1 → #5 → #4+#2 → #6); each phase independently committable; #6 is now a small SHA-pin change, reducing total risk |
| Source-workspace details leak into the public repo | Low | Med | Generalized fixtures only; scrub names/ids/terminology |

## Expert Consultation

### Consultation Log — Iteration 1 (2026-06-03)
**Models Consulted**: Gemini (REQUEST_CHANGES), Codex (REQUEST_CHANGES), Claude (COMMENT). All HIGH confidence; codebase claims verified accurate by Claude.

**Convergent themes and how they were addressed:**
- **Resolve acceptance-critical Open Questions now** (Gemini + Codex) → added the **Resolved Design Decisions** section; promoted state-file location, override flag, rotation mechanism, last-activity source, and retire policy from open to fixed.
- **#5 markdown-truncation safety** (Gemini) → rotation now uses a parseable `<!-- ARCHIVE BOUNDARY -->` delimiter and only moves whole history entries; never splits code blocks. Added loss-free reconstruction test.
- **#6 data-loss / worktree path / spawn-base resolution** (Gemini + Claude + Codex) → added `.architects/<name>/` (gitignored) location, dirty-worktree abort-unless-`--force` retire guard, and a spawn-base-resolution sketch ("builder branches from the spawning architect's worktree HEAD").
- **#6 scope contradiction** (Codex) → resolved: `main` = main checkout; new architects isolated by default; pre-existing migrate via explicit command. Success criterion reworded for consistency.
- **Ledger precision + concurrent-spawn race** (Codex + Claude) → added override-is-release-and-reinsert semantics, close/reopen + cleanup rules, and a partial unique index making check-then-insert atomic.
- **Forge query mechanism + degraded behavior** (Claude + Codex) → roster intersects ledger ids against the existing overview cache; renders `unknown` on forge outage; never per-issue shell-out.
- **Who-owes-next edge cases** (Claude + Codex) → made it a total function with explicit cases (gate→architect, mid-phase→builder, awaiting-merge→architect, owned-unspawned→architect, idle→builder-stalled, else→`unknown`).
- **`CODEV_ARCHITECT_NAME` fallback in N>1** (Claude) → spawn now requires a registered name in multi-architect workspaces; added security note + test.
- **No new dashboard deps for #2** (Claude) → confirmed; grouping reuses existing components + `architectCount`/`spawnedByArchitect` from #823.

**Remaining open (deferred to architect at the gate):** #6 PR-slicing, pre-existing-architect migration ergonomics, and two nice-to-knows (`--board` text digest; closed-issue dedup behavior).

> **Post-gate note:** the architect resolved #6 by switching to **builder-base SHA-pin** (see Amendment 1), which dissolved both the PR-slicing and migration-ergonomics questions. The iter-1 consultation analysis above is preserved as the historical record of the *worktree-isolation* design that was considered and then superseded.

**Date**: 2026-06-03
**Models Consulted**: gemini, codex, claude

## Approval
- [ ] Architect (human) review at `spec-approval` gate
- [ ] Expert AI Consultation Complete (3-way)

## Notes
- This spec shipped recommended defaults with explicitly-flagged Open Questions for the consequential forks; at the spec-approval gate the architect confirmed the defaults and **redirected #6 from per-architect worktree isolation to builder-base SHA-pin** (see the Amendment below).
- "Build all six as one coherent SPIR" is honored: the points share a data foundation (the ledger) and a presentation (roster/board), and lifecycle/state/SHA-pin all hang off the same architect identity. All six ship in one PR.

---

## Amendments

### Amendment 1 — #6 redirected to builder-base SHA-pin (2026-06-04, at spec-approval)

**Summary**: The architect approved the spec at the spec-approval gate with one change: **Point #6 becomes builder-base SHA-pinning (the spec's documented fallback B), replacing per-architect checkout isolation (`.architects/<name>/` worktrees).**

**Why**: The damaging failure mode in practice is the *stale/wrong-base builder* (builders repeatedly branched from a `main` ~145 commits behind), which SHA-pin fixes directly and cheaply. Per-architect worktrees carry a high-risk Tower/spawn refactor whose main benefit — independent architect branch state — is rarely needed, since architects sit on the integration branch. Architects continue sharing the main checkout; the "never switch branches" discipline rule stays for architects (accepted).

**Spec changes** (applied throughout, not deferred): Point #6 section rewritten to SHA-pin (capture a fresh integration-branch-tip SHA via fetch + `rev-parse`, branch the builder from it, fail-fast on fetch error, `--base` override); Desired State point 6, Success Criterion #6, Current State gap, Constraints, Assumptions, Performance, Risks, Test Scenarios 10/11/14 + non-functional #2 all updated to match. The `migrate-architect` surface and the dirty-worktree retire guard are **dropped** (no architect worktrees to migrate or clean). #4's retire steps simplified accordingly.

**Resolved consequences**: #6 PR-slicing → **moot** (ships in the main PR); pre-existing-architect migration ergonomics → **moot** (no worktrees). All #1–#5 resolved decisions stand unchanged.

**Plan impact**: #6 becomes a small, low-risk phase in the spawn base-resolution path; the plan should still order it last but no longer treat it as a sliceable high-blast-radius piece.
