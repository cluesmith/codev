# PIR Plan: Shellper Husk Sweep + Fleet Memory Observability

## Scope note

Per architect instruction, this PIR covers proposal items **1** (husk sweep) and **3**
(observability) from issue #1227. Item **2** (idle-architect hibernation / stop-on-idle
memory policy) is design-level and explicitly excluded — flagged below as a follow-up
spec, not implemented here.

## Understanding

Issue #1227 documents two related findings from a live memory-pressure census:

1. **Stranded shellper husks accumulate monotonically.** `killOrphanedShellpers()`
   (`packages/codev/src/terminal/session-manager.ts:717-761`) runs once, at Tower
   startup only (called from `packages/codev/src/agent-farm/servers/tower-server.ts:487`,
   right after `reconcileTerminalSessions()` at `:481`). Its predicate: find
   `shellper-main.js` processes scoped to this instance's `socketDir`
   (`findShellperProcesses`, `session-manager.ts:773-798`) that aren't in the in-memory
   `sessions` map, then **skip the kill unconditionally if the shellper's Unix socket
   responds** (`:733-738`) — the reasoning being "a responsive socket means a live
   session Tower lost track of." A husk (PTY child exited, shellper still listening —
   this is deliberate lingering behavior from #905/#1198 so a reconnect can replay
   history) still answers its socket, so this check protects it **permanently**. Every
   Tower restart that fails to re-adopt a shellper (crash, `remove-architect` outside
   #1225's coverage, adoption races, etc.) stamps a husk that then survives forever —
   confirmed by the issue's census showing two age-cohorts of childless husks dating to
   two known restart events (2026-07-16, 2026-07-19), each never cleaned up since.

2. **No visibility into fleet memory cost.** `afx status`'s `Memory` field
   (`packages/codev/src/agent-farm/commands/status.ts:203`) reports Tower's own process
   heap (`process.memoryUsage().heapUsed`, sourced from `GET /health` at
   `packages/codev/src/agent-farm/servers/tower-routes.ts:311`) — not the RSS of the
   shellper/claude fleet Tower manages, which is the actual multi-GB load driving OS
   memory pressure. There is no `ps`-based RSS accounting anywhere in the codebase
   today, and no signal that flags unregistered (husk) shellpers short of a manual `ps`
   diff against the DB.

Root cause for (1): `killOrphanedShellpers`'s policy conflates "responsive socket" with
"legitimate," when a childless-but-responsive shellper is exactly the failure mode to
catch. The fix (per the issue's own framing, confirmed correct) is to add a second,
stricter reap pass whose predicate is **unregistered AND childless AND aged past a grace
period** — the aged condition is what makes it race-safe (a shellper mid-adoption, or
momentarily childless between PTY respawns, cannot be both unregistered *and* childless
*and* old, since a legitimately-tracked shellper is either registered or freshly
orphaned, not both stale and invisible to the DB for hours).

## Proposed Change

### 1. A shared process-census helper

New file `packages/codev/src/agent-farm/servers/process-census.ts`:

```ts
export interface ProcessCensusEntry { pid: number; ppid: number; rssKb: number; cmdline: string; }
export function listProcessCensus(): ProcessCensusEntry[]
```

One `execFileSync('ps', ['-A', '-ww', '-eo', 'pid=,ppid=,rss=,args='], { timeout, maxBuffer })`
call, following the exact convention already used by `listProcessEntries` in
`packages/codev/src/agent-farm/servers/architect-session-holder.ts:113-129` (`-ww` to
avoid argv truncation, `execFileSync` never a shell string, try/catch-degrade at the
call site rather than inside). This single scan backs both the husk-sweep predicate and
the RSS observability feature, so we don't grow a fourth bespoke `ps` caller (there are
already three: `session-manager.ts`, `architect-session-holder.ts`,
`agent-farm/commands/cleanup.ts`).

### 2. A stricter husk-sweep predicate + reap

New file `packages/codev/src/agent-farm/servers/shellper-husk-sweep.ts`:

```ts
export function findHuskShellpers(opts: {
  socketDir: string;
  registeredShellperPids: Set<number>;
  graceMs: number;
  census?: () => ProcessCensusEntry[];       // seam, defaults to listProcessCensus
  now?: number;                               // seam, defaults to Date.now()
  getStartTime?: (pid: number) => Promise<number | null>; // seam, defaults to getProcessStartTime
}): Promise<number[]>

export async function sweepShellperHusks(opts: {
  socketDir: string;
  db: Database.Database;                      // for the registered-pid lookup
  graceMs: number;
  log?: (msg: string) => void;
}): Promise<{ swept: number; pids: number[] }>
```

Predicate, applied to each `shellper-main.js` process scoped to `socketDir` (same
scope-marker technique as `findShellperProcesses`, `session-manager.ts:782-793` — match
`socketDir + '/'` in the argv to prevent prefix collisions and to never touch another
Tower instance's or another user's shellpers):

- **unregistered** — pid not in `registeredShellperPids`, computed from
  `SELECT shellper_pid, shellper_start_time FROM terminal_sessions WHERE shellper_pid IS NOT NULL`
  (`packages/codev/src/agent-farm/db/schema.ts:118-131`) with each row's `shellper_pid`
  validated against `getProcessStartTime(pid)` (already exists,
  `session-manager.ts:1242` and exported) matching `shellper_start_time` — the same
  PID-reuse defense `_reconcileTerminalSessionsInner()` already applies
  (`packages/codev/src/agent-farm/servers/tower-terminals.ts:604`). A stale DB row whose
  PID was reused by an unrelated process does not count as "registered."
- **childless** — no other census entry has `ppid === pid` (the OS-level signal; no
  wire-protocol "has-child" frame exists in `shellper-protocol.ts`, so this must come
  from the process table, cross-referenced within the same census snapshot used for the
  scope match).
- **aged** — `now - startTime >= graceMs`, using `getProcessStartTime` (existing helper,
  reused rather than reimplemented) with a default `graceMs` of 1 hour (env-overridable
  `SHELLPER_HUSK_GRACE_MS`, same override convention as
  `SHELLPER_CLEANUP_INTERVAL_MS`). One hour is far beyond any respawn/adoption window
  (seconds), so this only ever protects a transient, not a real husk — per the issue's
  own analysis, "unregistered and childless" is a *terminal* state (a shellper that lost
  its registration can never receive another SPAWN), so the grace period's only job is
  race-safety, not "might still be needed."

Reap itself reuses `reapShellpers` from
`packages/codev/src/agent-farm/servers/architect-session-holder.ts:239-278` (SIGTERM →
poll-for-death → SIGKILL → confirm-death) — already tested, already correct about
process-group semantics and the SIGKILL-confirmation race fixed during #1224's review.
No new kill logic; `shellper-husk-sweep.ts` only computes candidate PIDs and delegates
the reap.

**Why a new function instead of extending `killOrphanedShellpers` in place:** that
function's existing tests (`session-manager.test.ts:383-620`) pin today's "responsive
socket always protects" behavior, and it's called from a single startup-only site. A
separate, stricter sweep is safer to add, test, and roll back independently, while still
functionally "extending its policy" at the product level (per the issue's own framing) —
the two coexist as a permissive first pass (`killOrphanedShellpers`) and a stricter
second pass (`sweepShellperHusks`) covering exactly the gap the first one leaves open.

### 3. Three triggers, one sweep function

- **(a) Startup** — call `sweepShellperHusks()` in `tower-server.ts` immediately after
  the existing `killOrphanedShellpers()` call (`tower-server.ts:487-490`), same ordering
  requirement (must run after `reconcileTerminalSessions()`).
- **(b) Hourly periodic** — new `setInterval` in `tower-server.ts`, following the
  existing `shellperCleanupInterval` pattern exactly (module-level handle declared
  alongside it near `:67`, env-overridable period via `SHELLPER_HUSK_SWEEP_INTERVAL_MS`
  defaulting to 3,600,000ms and floored the same way `SHELLPER_CLEANUP_INTERVAL_MS` is
  at `:412`, started next to the existing interval at `:411-422`, and added to
  `gracefulShutdown`'s clear-list at `:167` alongside `shellperCleanupInterval`). Tests
  can shorten the interval via the env var the same way
  `shellper-cleanup.e2e.test.ts:20` does for the existing cleanup timer.
- **(c) On-demand** — new Tower API endpoint `POST /api/shellpers/sweep-husks`, added to
  the exact-match `ROUTES` table in `packages/codev/src/agent-farm/servers/tower-routes.ts:161-185`.
  Exposed via a new `afx tower sweep-husks` CLI command
  (`packages/codev/src/agent-farm/cli.ts`, added to the existing `towerCmd` group
  alongside `start`/`stop`/`log` at `:729-783`), implemented in a new
  `packages/codev/src/agent-farm/commands/tower-sweep-husks.ts` via a new
  `TowerClient.findHuskCandidates()` / `TowerClient.sweepHusks()` pair
  (`packages/core/src/tower-client.ts`, next to `getHealth()` at `:197-200`).
  **Chose `afx tower` over `codev doctor`**: `doctor.ts` today is a pure
  environment/dependency checker (Node/git/CLI versions, AI-model auth) with zero Tower
  or process coupling (`packages/codev/src/commands/doctor.ts`) — wiring a Tower-client
  dependency into it is a bigger shift than adding one command to `afx tower`, which
  already speaks Tower's HTTP API for every other subcommand.

  **Dry-run by default, mirroring `afx workspace recover`**
  (`packages/codev/src/agent-farm/commands/workspace-recover.ts`) exactly — same UX
  precedent already established for a destructive, irreversible fleet-wide operation:
  - No flags → **preview only**. The endpoint splits into two:
    `POST /api/shellpers/sweep-husks/preview` (or a `?dryRun=1`-style single endpoint —
    finalize the exact shape in implement) runs `findHuskShellpers()` and returns
    candidates (pid, socketPath/cwd if resolvable, age, rss) **without killing
    anything**. The CLI renders them in a table (same `logger.row`/`printPreview` idiom
    as `workspace-recover.ts:255-276`) and prints
    `"Run with --apply to reap N husk shellper(s)."` (mirrors `workspace-recover.ts:406`).
  - `--apply` — actually reaps the previewed candidates via `sweepShellperHusks()`
    (SIGTERM→poll→SIGKILL through the existing `reapShellpers`).
  - `-y, --yes` — skip the confirmation prompt when `--apply` is set (mirrors
    `workspace-recover.ts:410-416`'s `--apply` + `!options.yes` + `confirm(...)` gate,
    reusing the same `confirm()` helper from `packages/codev/src/lib/cli-prompts.ts`).
  - Without `--yes`, `--apply` still prompts
    `"Proceed to reap N husk shellper(s)?"` before killing, defaulting to **no**
    (`confirm(question, false)`, same default-false the recover command uses for a
    destructive default).
  - The **startup and hourly triggers are unaffected** by this — they have no interactive
    operator to prompt, so they call `sweepShellperHusks()` directly (apply-equivalent,
    log-only, as designed above). The dry-run/`--apply` gate is specific to the one
    trigger a human actually invokes.

### 4. Observability: fleet RSS + unregistered-shellper count

- Extend the `/health` handler (`tower-routes.ts:297-315`) to add two fields, computed
  from one `listProcessCensus()` call scoped to this instance's `socketDir`:
  - `fleetRssKb` — sum of RSS for every in-scope `shellper-main.js` process plus its
    direct children (`ppid` membership within the same census snapshot) — i.e. the full
    process-group tree Tower manages, **regardless of DB-registration state**, so a husk
    that hasn't been swept yet still counts toward the visible cost (the whole point is
    surfacing the true load before or independent of reaping it).
  - `unregisteredShellperCount` — count of in-scope shellper PIDs not in the registered
    set (the same lookup `sweepShellperHusks` uses), **without** the childless/aged
    gating — a lighter, purely informational signal ("N shellpers Tower doesn't
    currently track"), distinct from the stricter reap predicate.
- Add both fields to the `TowerHealth` interface (`packages/core/src/tower-client.ts:73-88`).
- Surface in `afx status`: two new `logger.kv` lines next to the existing `Memory` line
  (`packages/codev/src/agent-farm/commands/status.ts:203`), and in the `--json` output
  via `emitStatusJson` (`status.ts:117-151`).

### Out of scope (follow-up)

Idle-architect hibernation (issue's proposal item 2) is a separate, design-level change
(kill an idle architect's `claude` child after N hours, keep the shellper + persisted
session id for instant resume) — not implemented here. Recommend filing it as its own
spec once this observability lands, since `fleetRssKb`/`unregisteredShellperCount` will
make the cost/benefit of a hibernation policy measurable.

## Files to Change

- `packages/codev/src/agent-farm/servers/process-census.ts` — new. `listProcessCensus()`.
- `packages/codev/src/agent-farm/servers/shellper-husk-sweep.ts` — new.
  `findHuskShellpers()`, `sweepShellperHusks()`.
- `packages/codev/src/agent-farm/__tests__/process-census.test.ts` — new.
- `packages/codev/src/agent-farm/__tests__/shellper-husk-sweep.test.ts` — new.
- `packages/codev/src/agent-farm/servers/tower-server.ts` — startup sweep call
  (near `:487-490`), new periodic-timer handle + `setInterval` (near `:67`, `:411-422`),
  add to `gracefulShutdown` clear-list (`:167`).
- `packages/codev/src/agent-farm/servers/tower-routes.ts` — new husk-preview/sweep
  route(s) (`:161-185`) + handler(s); extend `handleHealthCheck` (`:297-315`) with
  `fleetRssKb`/`unregisteredShellperCount`.
- `packages/core/src/tower-client.ts` — extend `TowerHealth` (`:73-88`); add
  `findHuskCandidates()` (preview) and `sweepHusks()` (apply) methods (near `:197-200`).
- `packages/codev/src/agent-farm/cli.ts` — new `afx tower sweep-husks` command
  (near `:729-783`), with `--apply` / `-y, --yes` options matching
  `workspace recover`'s (`:137-159`).
- `packages/codev/src/agent-farm/commands/tower-sweep-husks.ts` — new. CLI
  implementation: preview table by default, `--apply` to reap, `confirm()` gate unless
  `--yes` — structured like `workspace-recover.ts:316-438`.
- `packages/codev/src/agent-farm/commands/status.ts` — surface new fields in human
  output (`:203`) and JSON (`:117-151`).
- `packages/codev/src/terminal/session-manager.ts:1098` — the existing comment there
  already claims "the periodic orphan sweep SIGKILLs any survivor"; once the real
  periodic sweep lands this becomes true — reconcile the wording if it drifts from what
  actually ships.

## Risks & Alternatives Considered

- **Risk: reaping a shellper that's legitimately mid-respawn or mid-adoption.**
  Mitigation: the aged condition (default 1 hour, env-overridable) is far beyond any
  respawn/adoption window (seconds); reuse of the already-tested `reapShellpers`
  SIGTERM→poll→SIGKILL sequence rather than a raw `process.kill`.
- **Risk: multi-Tower-instance / multi-user safety.** A naive `ps` match on
  `shellper-main.js` alone would sweep another Tower instance's (or another user's)
  legitimate shellpers. Mitigation: reuse the exact `socketDir`-scope-marker technique
  already proven in `findShellperProcesses` (`session-manager.ts:782-793`) — same
  trailing-`/` prefix-collision guard.
- **Risk: DB registry race at the exact moment a new shellper is spawned but not yet
  written to `terminal_sessions`.** Mitigation: absorbed by the aged condition — a
  freshly-spawned shellper cannot be both unregistered and old.
- **Risk: `fleetRssKb` double-counts or under-scopes "fleet."** Mitigation: explicitly
  defined and documented as "in-scope shellpers + their direct children," computed from
  a single census snapshot; the field is advisory/observational only, not a gate on any
  behavior.
- **Alternative: extend `killOrphanedShellpers` in place** rather than adding a sibling
  function. Rejected — see "Why a new function" above; changing the well-tested existing
  reap in place risks regressing its current (and still-needed) "responsive socket
  protects a genuinely-live session" behavior.
- **Alternative: put the on-demand trigger in `codev doctor`.** Rejected — `doctor.ts`
  has no Tower/process coupling today; `afx tower` already does, for every other
  subcommand.

## Test Plan

- **Unit — `process-census.ts`**: mock `execFileSync`; verify pid/ppid/rss/args parsing,
  malformed-line skipping, and empty-output handling (mirrors the pattern in
  `cleanup-shellper-kill.test.ts`, which mocks `node:child_process` directly).
- **Unit — `findHuskShellpers`**: independently test each predicate leg —
  registered-but-childless-and-aged → not swept; unregistered-but-has-a-child → not
  swept; unregistered-and-childless-but-young → not swept; unregistered AND childless
  AND aged → swept. Also test `socketDir` scope isolation (a matching process from a
  different instance's `socketDir` is never a candidate). Follow the injectable-seam
  style already used in `architect-session-holder.test.ts` (`list`/`census` seam) rather
  than mocking `execFileSync` directly.
- **Unit — `sweepShellperHusks`**: DB-registry lookup + PID-reuse defense (a stale row
  whose PID was reused by an unrelated process must not count as registered).
- **Integration — periodic timer**: adapt the `shellper-cleanup.e2e.test.ts` pattern —
  set `SHELLPER_HUSK_SWEEP_INTERVAL_MS` to a short value via env, start a real Tower,
  assert the sweep runs on the shortened interval.
- **Integration — `/health` + `afx status`**: assert `fleetRssKb` and
  `unregisteredShellperCount` appear in both the raw `/health` JSON and `afx status
  --json` output.
- **Unit — `afx tower sweep-husks` CLI**: no flags → preview table printed, nothing
  killed (assert `sweepHusks`/reap seam not invoked); `--apply --yes` → reaps without
  prompting; `--apply` alone → prompts via `confirm()`, declining aborts with nothing
  killed (mirrors the equivalent `workspace-recover` test coverage pattern).
- **Manual**: spin up Tower locally; deliberately orphan a shellper (kill its PTY child
  without killing the shellper, and deregister its DB row); confirm `afx status` reports
  it under `unregisteredShellperCount`; run `afx tower sweep-husks` with no flags and
  confirm it only previews (process still alive); run again with `--apply` and confirm
  the prompt, decline it, confirm it's still alive; run `--apply --yes` and confirm it's
  reaped and the count drops; confirm the startup and hourly paths independently exercise
  the same reap via their own tests (no dry-run gate on those two).
- **Regression**: existing `killOrphanedShellpers` tests
  (`session-manager.test.ts:383-620`) and `shellper-cleanup.e2e.test.ts` continue to pass
  unmodified — the new sweep is additive, not a replacement.
