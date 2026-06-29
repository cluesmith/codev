# PIR Plan: Multi-architect conversation resume via persisted per-architect session ID

> **Approach summary:** persist a generated, agent-neutral `session_id` on each
> architect row at spawn; resume from it at every revive surface. For legacy rows
> with no stored id, `main`'s cold-spawn path keeps #830's jsonl-discovery fallback
> **gated to the sole-architect case** (where the shared cwd is unambiguous); the
> resolved id is persisted on that same revival, so it self-migrates into the
> stored-UUID path. No separate backfill step.

> **Revision note (post-plan-approval, per dev-gate feedback).** An earlier revision
> derived the session ID statelessly by hashing `(workspacePath, name)`. That proved
> fragile: Claude *requires* a valid UUID (verified — a plain string is rejected with
> `Invalid session ID. Must be a valid UUID.`), so the scheme had to hand-fabricate a
> valid UUID, was sensitive to the workspace path string, and had to prune jsonl files
> to honour architect removal. This revision returns to **persisting the actual
> session ID** in the architect DB row — robust, genuinely deterministic, no guessing.
> The persisted column is **agent-neutral** (`session_id`, not `claude_session_id`)
> because architects can run other agents (Codex, Gemini); the agent-specific resume
> mechanics route through the existing harness abstraction.

> **Revision note 2 (post-plan-approval, at the dev-approval gate).** The originally
> approved plan bridged pre-#832 running architects with a transitional standalone
> **backfill script** (`scripts/backfill-architect-sessions.ts`) + a narrow Tower
> setter route + `TowerClient.setArchitectSessionId` + a live-process capture helper
> (`captureRunningClaudeSession`). During gate review two facts killed that approach:
> (1) **Claude does not hold its session jsonl open** (verified empirically: `lsof`
> against live architects shows no jsonl fd), so the script's process→open-file
> correlation never worked — every capture came from the sole-architect mtime
> fallback, which can't disambiguate siblings; and (2) pre-#832 **siblings are
> unrecoverable** by any robust signal (no `--session-id` arg, no open fd, only the
> jsonl filename with no reliable pid bridge), so the script could only ever rescue
> `main`. Since `main` was **already self-recovering** under #830 via jsonl-discovery
> — which this branch had *removed* — the clean fix is to not remove it: **restore
> the sole-architect jsonl-discovery fallback** in `launchInstance` and **delete the
> entire backfill layer**. Every architect now self-heals in one revival cycle
> (legacy fresh once → id stored → resumes forever); single-architect `main` never
> regresses; the stored-UUID path delivers exact resume for every architect spawned
> under #832, including multi-architect mains and siblings. The `getArchitects() <= 1`
> check is retained, but its role changes: it no longer gates resume wholesale (the
> #830 bug); it gates *only* the legacy jsonl fallback. Stored-UUID resume applies
> regardless of architect count.

## Understanding

Issue #832 asks us to make Tower revive **every** architect into its own prior
conversation after a restart/reboot/crash — not just `main`.

Background: #830 shipped main-architect conversation resume by discovering the
newest `*.jsonl` (by mtime) under `~/.claude/projects/<encoded-cwd>/`. That works
for `main` and builders (#831) because each has a unique cwd. It **cannot**
disambiguate named sibling architects (Spec 755): they share `cwd = workspacePath`,
so every sibling's jsonl lands in the same directory and "newest by mtime" can
attach an architect to the wrong conversation. #830's conservative guard
(`getArchitects(ws).length <= 1`) therefore *disables* main's resume whenever any
sibling exists, and siblings never resume at all. Multi-architect workspaces lose
all architect conversation on reboot — and for specialised siblings that erases the
first-message brief that defines their lane.

## Proposed Change

Persist the architect's real session ID in its existing `architect` state.db row.
We **generate** the ID at spawn (`crypto.randomUUID()`), hand it to the agent so the
agent uses exactly that ID, and store it. At every revive surface we read the stored
ID back and resume. No derivation, no on-disk guessing.

### Agent-neutral by construction

- **Column** is `session_id` (not `claude_session_id`) — it holds whatever opaque
  session identifier the architect's agent uses.
- **Mechanics** (how to start a session pinned to an ID, and how to resume one)
  route through the existing `HarnessProvider`. Claude knows `--session-id` /
  `--resume`; agents without resumable-session support simply don't participate and
  fall back to a normal fresh spawn. No agent-specific flags leak into Tower code.

### Harness capability (the agent-specific knowledge lives here)

Add an **optional** `session` capability to `HarnessProvider`
(`utils/harness.ts`), mirroring how `buildRoleInjection` already abstracts role args:

```ts
session?: {
  /** Args to START a new agent session pinned to `sessionId` (merged with role injection by the caller). */
  newSessionArgs(sessionId: string): string[];
  /** Args to RESUME an existing session by id (caller skips role injection). */
  resumeArgs(sessionId: string): string[];
}
```

The interface carries only the **steady-state** pin/resume contract — no live-process
capture (that path was dropped; see Revision note 2).

- `CLAUDE_HARNESS.session = { newSessionArgs: id => ['--session-id', id], resumeArgs: id => ['--resume', id] }`.
- `CODEX_HARNESS`, `GEMINI_HARNESS`, `OPENCODE_HARNESS`: **omit** `session` →
  treated as "no resumable sessions" → always fresh, nothing persisted. (When/if a
  future agent gains resume support, it implements this capability and gets recovery
  for free.)
- Custom harnesses (`.codev/config.json`): out of scope — they omit `session` and
  behave like Codex/Gemini (fresh spawn).

### One decision helper (agent-neutral)

`resolveArchitectLaunch(...)` in `tower-utils.ts` owns the resume-vs-fresh decision
for all three sites. It asks the resolved harness for the mechanics — it contains **no
agent-specific flags**:

```ts
resolveArchitectLaunch(opts: {
  workspacePath: string;
  name: string;
  baseArgs: string[];
  storedSessionId?: string | null;   // architect row's session_id (the caller supplies
                                      // main's sole-architect jsonl fallback here)
}): { args: string[]; env: Record<string, string>; sessionId: string | null; resumed: boolean }
//   ^ sessionId = the id to write back onto the architect row (null if the agent
//     has no session support — nothing to resume next time)
//     resumed = true when an existing id was resumed (drives the "Resuming…" log line)
```

Decision (single source of truth):

1. **No `harness.session`** (Codex/Gemini today) → plain fresh:
   `buildArchitectArgs(baseArgs)`, `sessionId: null`.
2. **`storedSessionId` present** → resume:
   `[...baseArgs, ...session.resumeArgs(storedSessionId)]`, no role injection,
   `sessionId: storedSessionId` (re-written unchanged).
3. **Else fresh**: `id = crypto.randomUUID()`,
   `buildArchitectArgs([...baseArgs, ...session.newSessionArgs(id)])`,
   `sessionId: id`.

The caller always writes the returned `sessionId` onto the row via its existing
`setArchitect(...)` / `setArchitectByName(...)` call, so the column is populated on
every spawn (fresh → new id; resume → same id; no-session → null). No partial updates
exist (the only other writes are full-row deletes on exit/remove), so `INSERT OR
REPLACE` can't wipe it — no COALESCE needed.

**No jsonl discovery for *new* architects.** Every architect spawned post-#832 (main
or sibling) gets a generated id stored at spawn, so it is restart-safe from birth,
deterministically, with zero on-disk guessing. jsonl-discovery survives only as the
legacy sole-architect bridge below.

### Legacy bridge: sole-architect jsonl-discovery fallback (no script)

Architects spawned under #832 store their id at spawn, so they are restart-safe from
birth. The only rows without a stored id are those **already running under pre-#832
code**. Rather than a standalone backfill (see Revision note 2 for why that was
dropped), `main`'s cold-spawn path bridges them by retaining #830's jsonl-discovery,
**gated to the sole-architect case**:

```ts
// tower-instances.ts launchInstance (main)
storedSessionId = getArchitectByName(resolvedPath, 'main')?.sessionId
  ?? (getArchitects(resolvedPath).length <= 1 ? findLatestSessionId(workspacePath) : null);
```

- **Stored id present** → exact resume, regardless of architect count (so `main`
  resumes in multi-architect workspaces — the headline fix).
- **Legacy row, sole architect** → jsonl-discovery finds the one unambiguous
  conversation (exactly #830's behavior). `resolveArchitectLaunch` then **persists**
  the discovered id back onto the row, so it self-migrates into the stored-UUID path
  on this same revival — no manual step, deterministic from then on.
- **Legacy row, multiple architects** → jsonl-discovery is ambiguous (shared cwd), so
  it is skipped → fresh spawn once → id stored → resumes thereafter. Self-heals.

**Siblings never use jsonl-discovery** (`addArchitect` passes `storedSessionId
?? null`): a sibling's cwd is shared, so newest-by-mtime would mis-attach. A pre-#832
sibling therefore self-heals (fresh once, then stored). This is the irreducible
limit: a sibling's pre-#832 conversation id lives only as a jsonl filename with no
robust pid bridge (Claude holds no fd open), so it cannot be recovered — only the
go-forward stored-UUID path fixes siblings, which it does completely.

The **shellper auto-restart** sites resume from the stored id but do **not** add the
jsonl fallback (matching #830, which never resumed there) — a legacy architect that
only ever restarts self-heals on its next cold revival.

Spec 786's intentional-stop logic preserves architect rows across `afx workspace
stop`, so a stored `session_id` survives to the next `afx workspace start`.

### Spawn / revive sites

All three sites follow the same shape: read the stored id → `resolveArchitectLaunch`
→ persist the returned id.

- `tower-instances.ts launchInstance` (main): read
  `getArchitectByName(resolvedPath, 'main')?.sessionId`, **falling back to
  `findLatestSessionId(workspacePath)` only when `getArchitects(resolvedPath).length
  <= 1`** (the legacy sole-architect bridge); call `resolveArchitectLaunch`, pass the
  returned `sessionId` into the two existing `setArchitect(...)` calls (so a
  discovered id is persisted and self-migrates).
- `tower-instances.ts addArchitect` (siblings): read
  `getArchitectByName(resolvedPath, name)?.sessionId`, call `resolveArchitectLaunch`,
  pass the returned `sessionId` into the existing `setArchitectByName(...)` calls.
  Serves both `add-architect` (no row → mint) and the launchInstance reconcile loop
  (row has id → resume).
- `tower-terminals.ts reconcileTerminalSessions` — **both** restart-bake sites
  (startup reconcile + on-the-fly reconnect): read
  `getArchitectByName(workspace, role_id||'main')?.sessionId`, call
  `resolveArchitectLaunch`, use the returned `args`/`env` for `restartOptions`. Keep
  the existing `CODEV_ARCHITECT_NAME` injection. The stored id is what makes an
  in-process crash resume the *same* conversation (the silent-context-loss path).

### `removeArchitect` — simplified

No jsonl pruning. The exit/remove path already deletes the architect row
(`setArchitectByName(..., null)`), which clears `session_id` with it — so a
removed-then-re-added sibling naturally starts fresh (branch 3). This is the DB
approach's clean win over the derived scheme, which needed an explicit file prune.

### Data layer

- `db/schema.ts` — add `session_id TEXT` to the `architect` `CREATE TABLE`.
- `db/index.ts` — migration **v12**: `ALTER TABLE architect ADD COLUMN session_id TEXT`
  in try/catch (idempotent; fresh installs already have it via LOCAL_SCHEMA, same idiom
  as v2). Runs after v11's rebuild, lands on the final shape.
- `db/types.ts` — `session_id: string | null` on `DbArchitect`; map to `sessionId` in
  `dbArchitectToArchitectState`.
- `types.ts` — `sessionId?: string` on `ArchitectState`.
- `state.ts` — `setArchitect` / `setArchitectByName` add `session_id` to the column
  list and params. Getters already `SELECT *` — no query change.

## Files to Change

- `packages/codev/src/agent-farm/utils/harness.ts` — add optional `session` capability
  (`newSessionArgs`/`resumeArgs` only) to `HarnessProvider`; implement on `CLAUDE_HARNESS`;
  others omit.
- `packages/codev/src/agent-farm/utils/claude-session-discovery.ts` — **revert** the
  derived-id additions (`architectSessionId`, `sessionFileExists`,
  `deleteArchitectSessionFile`, `ARCHITECT_SESSION_NAMESPACE`). Keep `findLatestSessionId`
  (builders + the sole-architect legacy fallback). No live-process capture helper.
- `packages/codev/src/agent-farm/servers/tower-utils.ts` — rewrite
  `resolveArchitectLaunch` to the stored-id + harness-capability model above (no
  agent-specific flags here); drop the `isLoneMainArchitect`/discovery wiring.
- `packages/codev/src/agent-farm/servers/tower-instances.ts` — read stored `sessionId`
  (main: with the sole-architect `findLatestSessionId` fallback) + persist the returned
  id at `launchInstance` and `addArchitect`; drop the jsonl prune from `removeArchitect`.
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` — both restart-bake sites
  read stored id + resume via the helper.
- DB layer: `db/schema.ts`, `db/index.ts` (v12), `db/types.ts`, `types.ts`, `state.ts`
  (setters write `session_id`).
- Tests — `__tests__/state.test.ts` (round-trip + removal-clears), a migration test,
  `__tests__/tower-utils.test.ts` (harness-routed resume/fresh decision), the harness
  unit test, and `claude-session-discovery.test.ts` (`findLatestSessionId`).

**Not touched**: `codev-skeleton/`; builders / `spawn.ts`; `global.db`; Tower
messaging / SSE; porch / gates; the wire `ArchitectState` in `@cluesmith/codev-types`.
No new Tower routes or client methods.

## Blast Radius & Rollout Control

- **Migration v12** — every Tower DB open. One idempotent additive `ALTER ADD COLUMN`
  (same idiom as v2/v9). Old binaries ignore the column; nullable and additive →
  forward/backward compatible.
- **state.ts setters** — every architect spawn (4 sites) now writes `session_id`. No
  partial-update path exists, so no COALESCE needed; deletes are unaffected.
- **harness.ts** — additive optional capability; non-Claude providers unchanged.
- **resolveArchitectLaunch** — agent-neutral; the only behavior change is that
  architects now resume from their stored id.
- **Legacy fallback** — `main`'s sole-architect `findLatestSessionId` path is exactly
  #830's behavior, gated identically (`getArchitects() <= 1`). No new surface.
- **Soft-fail** — no stored id (legacy multi-architect row, first spawn, or no-session
  agent) → fresh spawn. Worst case "loses context once," never "fails to start."
- **Size** — ~120–180 LOC incl. tests, all within `packages/codev`, no new deps.

## Risks & Alternatives Considered

- **One-time context loss on the upgrade restart.** A single-architect `main`
  self-recovers via the sole-architect jsonl fallback (no loss). A legacy
  *multi-architect* `main` and *all* legacy siblings lose context **once** on their
  first #832 revival (fresh spawn → id stored), then resume deterministically forever.
  This is accepted (issue's backwards-compat section); a transitional backfill script
  was prototyped to spare even that one loss but **dropped** — it could only rescue
  `main` (which the jsonl fallback already covers) and never siblings, because Claude
  holds no jsonl fd open to correlate (see Revision note 2). New architects are never
  affected.
- **`INSERT OR REPLACE` wiping the id.** Ruled out by the caller graph: every non-null
  write is a spawn site that passes the resolved `sessionId`; all other writes delete
  the row. No partial update exists.
- **Non-Claude architects.** They omit the harness `session` capability → fresh spawn,
  `session_id` stays null. No claude flags ever reach them. Graceful, and the column is
  ready when another agent gains resume support.
- **Claude accepts a chosen UUID for `--session-id` and resumes by it.** Verified
  empirically during planning (create at our id → jsonl written at that id; `--resume`
  → same session appended, no fork). A non-UUID is rejected, which is why we generate a
  real `crypto.randomUUID()` rather than a readable string.
- *Rejected — stateless derived id* (prior revision): fragile (must hand-fabricate a
  valid UUID, path-string-sensitive, needs jsonl pruning on removal). The DB row is the
  single source of truth instead.
- *Rejected — per-architect cwd so discovery disambiguates*: changes Spec 755 semantics
  and is far more invasive.

## Test Plan

Unit tests (run from the worktree: `pnpm --filter @cluesmith/codev test`):

- **Harness** (`harness.test.ts` or inline): `CLAUDE_HARNESS.session.newSessionArgs` /
  `resumeArgs` produce `--session-id` / `--resume`; Codex/Gemini have no `session`.
- **Data layer** (`state.test.ts`): set an architect with `sessionId`, read it back via
  `getArchitectByName` / `getArchitects`; `setArchitectByName(..., null)` clears the row
  (removal-clears-id); a spawn write updates the id.
- **Migration**: a pre-v12 architect table gains `session_id`; existing rows read back
  `null` (legacy fallback).
- **resolveArchitectLaunch** (`tower-utils.test.ts`): stored id → `--resume`, no role
  injection, returns the same id; no stored id → fresh `--session-id <newUuid>`,
  returns the new id; no-session harness → plain fresh, returns null; two siblings with
  distinct stored ids resume independently (no cross-attachment).
- **Shellper auto-restart** (`tower-terminals.test.ts`, alongside the Spec 786 Phase 2
  tests): a sibling row with a stored id bakes `restartOptions.args` with `--resume
  <id>` and skips role injection; no stored id → `buildArchitectArgs`;
  `CODEV_ARCHITECT_NAME` still resolved.
- **Discovery helper** (`claude-session-discovery.test.ts`): `findLatestSessionId`
  returns the newest jsonl by mtime, null when the dir is missing/empty, and handles
  the encode/path edge cases (shared with the builder resume path).

Manual (reviewer at `dev-approval`, **post-deploy** — Tower must be on the #832 code):
- **Multi-architect resume (go-forward)**: spawn `main` + a named sibling under the new
  code (ids stored at spawn), `afx workspace stop` + `afx workspace start`; confirm each
  resumes its own conversation and the sibling keeps its brief. Watch for the
  `Resuming architect '<name>' session <id8>…` log line at each site.
- **Legacy sole-architect bridge**: a single-`main` workspace with a pre-#832 row (no
  stored id) → `start` resumes via `findLatestSessionId`, and the row gains a stored id
  (self-migration) so the next restart takes the exact-id path.
- `afx workspace remove-architect reviewer` then re-add; confirm it starts fresh.
