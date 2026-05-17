# Specification: Builder-to-Architect Message Routing (Multi-Architect Support v1)

## Metadata
- **ID**: 755-multi-architect-support-per-ar
- **Status**: draft
- **Created**: 2026-05-17
- **Protocol**: SPIR
- **GitHub Issue**: #755

## Problem Statement

Some Codev users run **multiple architect agents** in the same workspace simultaneously — a pattern we call **sibling-architect**. Each architect owns an orthogonal slice of work (different feature areas, different builder pools, different decision authority) but they share the same git repo, builder farm, and Tower instance.

Today, the architect side of Codev is a **singleton per workspace**:

- `WorkspaceTerminals.architect` is `string | undefined` — a single terminal ID (`packages/codev/src/agent-farm/servers/tower-types.ts:35`).
- The SQLite `architect` table is constrained to one row: `id INTEGER PRIMARY KEY CHECK (id = 1)` (`packages/codev/src/agent-farm/db/schema.ts:18`).
- `afx send architect "..."` resolves to that single terminal (`packages/codev/src/agent-farm/servers/tower-messages.ts:191-200`).

When a builder runs `afx send architect "PR ready"`, the message lands in this shared destination. If two human architects are using the workspace at once, **both** see the message and have to manually look up "is this MY builder?" by checking thread-state files, memory, or guessing. This is error-prone under cognitive load and is currently being worked around with informal `codev/<thread>-thread.md` files.

This spec scopes a v1 fix focused on the single load-bearing pain point: **routing a builder's `afx send architect` message back to the specific architect that spawned that builder**.

## Current State

### Architect singleton

`WorkspaceTerminals` only holds room for one architect terminal per workspace:

```ts
// packages/codev/src/agent-farm/servers/tower-types.ts:33-39
export interface WorkspaceTerminals {
  architect?: string;
  builders: Map<string, string>;
  shells: Map<string, string>;
  fileTabs: Map<string, FileTab>;
}
```

The SQLite mirror enforces the same singleton at the data layer:

```sql
-- packages/codev/src/agent-farm/db/schema.ts:18-26
CREATE TABLE IF NOT EXISTS architect (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL, ...
  terminal_id TEXT
);
```

### Builder spawn metadata

`Builder` records what kind of work the builder is doing, but **no field captures who spawned it**:

```ts
// packages/codev/src/agent-farm/types.ts:7-19
export interface Builder {
  id: string;
  name: string;
  status: 'spawning' | 'implementing' | 'blocked' | 'pr' | 'complete';
  phase: string;
  worktree: string;
  branch: string;
  type: BuilderType;
  taskText?: string;
  protocolName?: string;
  issueNumber?: number | string;
  terminalId?: string;
}
```

`afx spawn` (`packages/codev/src/agent-farm/commands/spawn.ts:439`) calls `upsertBuilder()` without any spawning-architect identifier.

### Message resolution

`afx send architect "..."` flows through:

1. `commands/send.ts:183` — sender identity is detected from worktree path; defaults to `'architect'` when run from the main workspace.
2. `TowerClient.sendMessage()` POSTs to `/api/send` (`packages/core/src/tower-client.ts:310-346`).
3. `handleSend()` (`packages/codev/src/agent-farm/servers/tower-routes.ts:819-949`) calls `resolveTarget('architect', workspace)`.
4. `resolveAgentInWorkspace` matches `'architect'` or `'arch'` and returns the single `entry.architect` terminal ID (`tower-messages.ts:191-200`).
5. Message is written directly to that terminal's PTY (with idle-aware buffering).

There is **no fan-in stage** that could distinguish multiple architects, because there is only one architect terminal to deliver to.

### How users work around it today

- Per-thread markdown files at `codev/<thread-name>-thread.md` with active builder rosters, PR lists, pending decisions, and pickup checklists.
- Cross-architect coordination conventions enforced by discipline ("this thread does NOT approve sibling-thread's gates").
- Mental triage on every `architect` ping ("is this mine?").

These conventions work but are brittle and require discipline that doesn't scale.

## Desired State

A builder that was spawned by architect **A** should, when running `afx send architect "..."`, deliver the message **only to architect A's terminal**, not to any sibling architects sharing the workspace.

Concretely:

- A workspace can host **multiple architect terminals** simultaneously.
- Each architect terminal has a stable **architect identity** (an `architectId` string).
- Every builder spawned during architect A's session records `spawnedByArchitectId: A` in its persisted state.
- `afx send architect "..."` from within a builder worktree resolves the destination using the builder's recorded `spawnedByArchitectId` — message goes to architect A's terminal, not to any sibling.
- An explicit broadcast address (e.g., `architects` or `architect:all`) is available for the rare case where a builder genuinely needs to fan out to every architect.
- Existing single-architect workspaces continue to work with **zero behavior change** — the new identity scheme has a backward-compatible default so unflagged spawns route the same way they always have.

## Scope

### In scope (v1)

1. **Architect identity** — a stable `architectId` string per architect terminal, defaulting to `"main"` so the singleton case keeps working. Identity is set when the architect terminal is registered with Tower.
2. **Multiple architect terminals per workspace** — relax the `WorkspaceTerminals.architect` singleton (and the `architect` SQLite table singleton) to allow N architect terminals indexed by `architectId`.
3. **Spawn-time capture** — `afx spawn` records `spawnedByArchitectId` on the persisted `Builder` row. When `afx spawn` is run from inside a Tower-managed architect terminal, the architect's identity is detected automatically; when run outside, it defaults to `"main"`.
4. **Routed `architect` resolution** — `resolveTarget('architect', ...)` invoked from a builder context looks up the builder's `spawnedByArchitectId` and resolves to that specific architect terminal.
5. **Broadcast address** — a reserved address (`architects` plural, or `architect:all`) that fans the message out to all registered architect terminals in the workspace.
6. **Backward compatibility** — workspaces with one architect (no opt-in needed) behave identically to today. Builders persisted before this feature lands route to the default `"main"` architect.

### Out of scope (deferred to follow-up issues)

The full GitHub issue lists five feature asks. **Only #1 (builder-to-architect message routing) is in scope for v1.** The remaining four are tracked as separate follow-up issues to be filed after this lands:

- **Per-architect identity in spawn + status CLI flags** (#2 in issue): explicit `--architect <name>` on `afx spawn`, `--architect` filter on `afx status`. v1 ships the underlying identity field but does not add CLI flags; identity is detected from execution context only.
- **First-class `THREAD.md` template + lifecycle** (#3 in issue): `codev thread new|list|archive` commands. Pure convention layer, independent of routing.
- **Cross-thread visibility** (#4 in issue): `codev thread show <name>` to read sibling state. Independent of routing.
- **Thread-aware `consult`** (#5 in issue): `consult --thread <name>` or auto-detection from a `.thread` file. Independent of routing.

These five items compose cleanly once #1 lands. Each will be filed as its own follow-up issue with its own protocol after this PR merges.

## Stakeholders

- **Primary**: External Codev consumers running the sibling-architect pattern on large projects (the reporter of #755 plus any future users adopting the pattern).
- **Secondary**: Solo-architect users — must see **zero behavior change**.
- **Technical Team**: Codev maintainers (Tower routing, agent-farm commands, state schema).
- **Business Owners**: M Waleed Kadous (architect role for Codev).

## Success Criteria

- [ ] Two architect terminals can run simultaneously in one workspace (Tower accepts multiple architect registrations with distinct `architectId` values).
- [ ] A builder spawned from architect A's terminal records `spawnedByArchitectId: "A"` (or the equivalent default `"main"` when run from the workspace root with one architect).
- [ ] `afx send architect "..."` from inside a builder's worktree routes to **only** the architect that spawned that builder; sibling architects do not receive the message.
- [ ] An explicit broadcast address fans the message out to all architects in the workspace.
- [ ] Existing single-architect workspaces show **no behavior change**: `afx send architect` routes to the lone architect just as it does today.
- [ ] Builders persisted **before** this feature (no `spawnedByArchitectId` field) continue to route correctly to the default architect.
- [ ] All existing tests pass; new tests cover the multi-architect routing matrix (single, multi-with-match, multi-broadcast, legacy-builder-fallback).
- [ ] No performance regression in message delivery (single-architect workspaces should see identical latency).

## Constraints

### Technical constraints

- **Backward compatibility is non-negotiable.** Single-architect workspaces and pre-existing builder state rows must behave exactly as before. This is the single largest design constraint.
- The architect singleton is enforced in **three places** that must all be relaxed in lockstep: `WorkspaceTerminals.architect` (in-memory), the `architect` SQLite table (`CHECK (id = 1)`), and `resolveAgentInWorkspace` (string match on `'architect' | 'arch'`).
- Tower's in-memory `WorkspaceTerminals` is the source of truth for live routing; the SQLite schema must be a faithful mirror for crash recovery.
- A migration is required for the `architect` table — the singleton check has to be dropped and replaced with a `(workspace_path, architect_id)` uniqueness constraint.
- The new `architectId` must be a stable string (suitable as a primary key component and as an `afx send` address segment in the future). ASCII-safe, lowercase, dash-separated is the natural choice.

### Business constraints

- This is upstream work for an external Codev consumer with the sibling-architect pattern in daily production use. **Time-to-merge matters** — keep scope tight.
- Solo-architect users must never have to know this feature exists. No new mandatory CLI flags, no new mandatory config keys.

## Assumptions

- The reporter's workflow uses **two** architect terminals; the design must not collapse on N=2 but does not need to optimize for N=20.
- Architects are launched as Tower terminals (via `afx workspace start` or equivalent); we are not adding a way to register a "remote" or "headless" architect.
- The architect's `architectId` can be supplied by the Tower terminal-creation path (e.g., from a flag, config, or sensible default). Bikeshedding the *mechanism* for setting it is out of scope for the spec — see Open Questions.
- Builders communicate to architects only via `afx send architect`. There is no other code path that uses the literal string `architect` as a resolution target that we'd need to update simultaneously.

## Solution Approach

The mechanism splits naturally into three layers, mirroring the singleton's three current homes:

1. **Identity at registration.** Tower learns each architect terminal's `architectId` at registration time. The default is `"main"` so workspaces that never opt in see the same single-architect behavior.
2. **Identity at spawn.** When `afx spawn` creates a builder, it detects the spawning architect's identity from execution context (e.g., environment variable injected by Tower into the architect terminal) and persists it on the builder row as `spawnedByArchitectId`. When run outside any architect terminal, the default `"main"` is used.
3. **Identity at send.** When a builder runs `afx send architect`, the resolution step consults the calling builder's `spawnedByArchitectId` and resolves to **that** architect's terminal — not the generic singleton.

The plan phase will pin down exactly *where* each of these touches lives. Out of scope for the spec.

## Open Questions

### Critical (blocks progress)

- [ ] **How does an architect terminal declare its identity?** Three plausible answers: (a) a Tower API parameter when the architect terminal is created, (b) an env var read at terminal start, (c) a config-driven default with optional override. Plan phase will pick one — but the spec needs to commit to *some* mechanism existing.

### Important (affects design)

- [ ] **Should `architectId` be visible in `afx status`?** Filtering is out of scope for v1, but operators will still want to see "which architect owns which builder." Decision: probably yes, as a non-filterable display column. Plan phase to confirm.
- [ ] **What is the broadcast address syntax?** Options: `architects` (plural), `architect:all`, `*:architect`. Existing address parser uses `[project:]agent` colon syntax — `architect:all` aligns with that grammar but reads weirdly. Plan phase to pick.
- [ ] **Where in the Tower request flow is broadcast fan-out implemented?** Option A: at `resolveTarget` (return list of terminal IDs). Option B: at `handleSend` (special-case broadcast names). Plan phase to decide based on call-site count.

### Nice-to-know (optimization)

- [ ] **Should sibling architects see metadata about other architects' builders (read-only)?** Adjacent to issue #4 (cross-thread visibility) which is explicitly deferred. Out of scope for v1.

## Performance Requirements

- **Routing overhead**: a single-architect `afx send architect` must add no measurable latency vs. today (single map lookup → single PTY write).
- **Storage**: per-builder `spawnedByArchitectId` is a short string, persisted once at spawn. Negligible.
- **No new background processes, polling loops, or watchers.** All routing is on-demand at message-send time.

## Security Considerations

- **Cross-architect leakage**: a misrouted message could expose builder activity to a sibling architect who shouldn't see it. The default-to-singleton fallback must be considered for this — if a legacy builder has no `spawnedByArchitectId` in a multi-architect workspace, where does its message go? Design decision: route to the **architect named `"main"`** if present; otherwise error with a clear message. Plan phase to confirm and write the relevant tests.
- **Address spoofing**: builders can pass arbitrary strings to `afx send`. Builders should not be able to send to an architect that didn't spawn them by guessing IDs. Mitigation: builders can only send to `architect` (which resolves to their own spawning architect) or `architects` (broadcast). Direct `architect:<other-id>` addressing from a builder is forbidden. Plan phase to write the relevant authorization tests.
- No new auth surfaces, no new credentials, no new tokens.

## Test Scenarios

### Functional

1. **Single-architect baseline (regression).** One architect (`main`) + one builder. `afx send architect "hi"` from builder reaches `main`. Identical to current behavior.
2. **Two architects, scoped routing.** Architects `main` and `sibling`. Builder spawned from `main`. `afx send architect "hi"` reaches only `main`'s terminal, never `sibling`'s.
3. **Two architects, broadcast.** Builder uses the broadcast address. Both architects receive the message.
4. **Legacy builder fallback.** Builder row in DB has no `spawnedByArchitectId` (simulating pre-feature data). `afx send architect` from that builder routes to the architect named `"main"` if present, errors otherwise.
5. **Spawning-architect detection.** `afx spawn` run from inside `main`'s architect terminal records `spawnedByArchitectId: "main"`. Run from `sibling`'s architect terminal records `spawnedByArchitectId: "sibling"`. Run outside any architect terminal defaults to `"main"`.
6. **Address-spoofing rejection.** A builder trying to address `architect:other-architect` (with `other-architect` not being its spawner) is rejected with a clear error.

### Non-functional

1. **Latency parity.** Microbenchmark `afx send architect` in a single-architect workspace before and after the change. No statistically significant difference.
2. **Migration safety.** SQLite migration that drops the `architect.id = 1` constraint preserves the existing row and its terminal_id binding.

## Dependencies

- **Internal systems**: Tower instance manager, agent-farm CLI (`afx send`, `afx spawn`), SQLite state schema, `resolveTarget` logic, builder state model.
- **External services**: none.
- **Libraries / frameworks**: none new.

## References

- GitHub issue #755 (full multi-architect ask, all 5 features).
- `packages/codev/src/agent-farm/servers/tower-types.ts:33-39` — `WorkspaceTerminals` interface (singleton home #1).
- `packages/codev/src/agent-farm/db/schema.ts:18-26` — architect table (singleton home #2).
- `packages/codev/src/agent-farm/servers/tower-messages.ts:177-200` — `resolveAgentInWorkspace` (singleton home #3).
- `packages/codev/src/agent-farm/types.ts:7-19` — `Builder` interface (where `spawnedByArchitectId` will live).
- `packages/codev/src/agent-farm/commands/send.ts:142-223` — afx send flow.
- `packages/codev/src/agent-farm/commands/spawn.ts` — afx spawn flow.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Backward compat break for solo-architect users | Medium | High | Default `architectId` of `"main"`; legacy builder rows route to `main`; comprehensive regression test on the single-architect path. |
| Migration drops the singleton row on schema upgrade | Low | High | Migration test: pre-migration state with one architect row, post-migration state, assert row survives with terminal_id intact. |
| Routing leaks across architects under race conditions (two architects spawning builders at the same instant) | Low | Medium | Spawn-time identity is captured synchronously from the spawning architect's environment, persisted to SQLite in the same transaction as `upsertBuilder()`. No race window. |
| Plan phase discovers the architect-identity mechanism (Open Q #1) is much harder than expected | Medium | Medium | Plan phase can defer to a config-driven default-only approach if the Tower-injection path proves messy; v1 still ships routing correctness, just with a less ergonomic identity assignment. |
| Scope creep — pressure to include thread.md (#3) or `--architect` CLI flags (#2) | High | Medium | Explicit Out of Scope section above; architect already gated this in the spawn instruction. Any pressure during PR review → defer to follow-up issue. |

## Expert Consultation

To be added after the 3-way consultation (Gemini, Codex, Claude) per SPIR protocol.

## Approval

- [ ] Architect review (M Waleed Kadous)
- [ ] Multi-agent consultation complete (Gemini, Codex, Claude)
- [ ] Spec-approval gate (porch)

## Notes

The architect's spawn-time directive was unambiguous: scope to feature #1 only. Items #2-5 are intentionally left as follow-up issues, even though some (especially #2, per-architect identity in spawn CLI flags) compose so directly with #1 that they'd be a small additional lift. The discipline of keeping v1 tight matters more than the incremental polish, and the spec keeps that line firmly.
