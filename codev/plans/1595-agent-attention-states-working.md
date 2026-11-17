# Plan: Agent attention states from harness lifecycle signals

**Specification**: [codev/specs/1595-agent-attention-states-working.md](../specs/1595-agent-attention-states-working.md)

## Executive Summary

The plan implements the spec's recommended combination: an async command-hook **reporter** (Approach 1) installed through the `--settings` launch flag by a new optional `HarnessProvider` capability (Approach A), posting harness-neutral `AgentLifecycleEvent`s to one Tower ingestion route. Tower holds reported activity **in memory only** (Constraint 10), computes **liveness** itself in one module, and serves a projected `agentState` on the existing overview, announced with `overview-changed`. The sdk's one predicate (`isIdleWaiting`) and `deriveAttention` read the served state, apply the `working` staleness rule, and fall back to today's PTY-silence rule when the state is `null`.

Work is ordered from the contract outward, so every phase is testable on its own:

1. the wire contract and the pure projection;
2. the sdk predicate and summary, which only need the contract;
3. Tower ingestion and the in-memory store;
4. Tower liveness;
5. serving `agentState` on the overview;
6. the Claude reporter and its launch injection;
7. the surfaces;
8. real-session verification and docs.

Phases 1 to 5 change no visible behavior: with no reporter installed, every served state is `null` or `dead`, and the predicate's `null` path is today's rule. Phase 6 turns reporting on, and Phase 7 renders it.

**Where each piece lives** (Constraints 12 and 14):

| Concern | Home |
|---|---|
| Types | `packages/types/src/agent-state.ts` (new) |
| Projection, a pure function | `packages/core/src/agent-state.ts` (new `./agent-state` export of `@cluesmith/codev-core`) |
| Ingestion, store, identity resolution | `packages/codev/src/agent-farm/servers/agent-state/` (new) |
| Liveness, the one place | `packages/codev/src/agent-farm/servers/agent-state/liveness.ts` |
| Staleness rule and predicate | `packages/sdk/src/builder-helpers.ts` |
| Reporter script content and capability | the Claude provider in `packages/codev/src/agent-farm/utils/` |

**Plan-level choices the spec left open:**

- **Reporter location.** The reporter script and its settings file are written to `~/.agent-farm/hooks/` (`AGENT_FARM_DIR`), not the installed package folder:
  - It is stable across package upgrades, so a running session's `--settings` path never dangles after an upgrade.
  - It is outside every builder worktree and the main checkout. The write-guard already denies builder writes outside the worktree.
  - It is rewritten at each launch only when its content differs (atomic write), so the current version always matches the code that launched the agent.
  - **Compatibility invariant.** The directory is shared by every codev install on the machine, so a newer install can rewrite the script under an older install's running sessions. The script is stateless: it reads only stdin and the launch environment and posts one contract event. A newer script talking to an older Tower can only be rejected by strict validation, which fails open to today's rule. It can never produce a wrong state.
- **Settings form.** `--settings <file>`, never inline JSON.
- **Tower port.** Tower sets `CODEV_TOWER_PORT` to its own listening port in the environment of every agent session it creates (builders and architects, at session creation). The reporter reads it and defaults to `DEFAULT_TOWER_PORT` when it is absent. The hook command stays byte-identical for every agent and port (the #1796 hash-trust goal). An inherited stale value cannot survive, because Tower always overwrites it with its own port.
- **One builder key.** The in-memory store, liveness and the overview all key a builder by its **role id**, lowercased: the value `discoverBuilders` computes, and the same key as `entry.builders`. That value is `storedRoleId(row)` (the stored `builders.id` only when it has the `builder-`/`worktree-` shape `buildAgentName` produces) or else the id derived from the worktree directory name. Legacy rows (for example `bugfix-42`) take the derived id. The resolver **does not** return `detectCurrentBuilderId`'s raw `row.id`. It finds the row with the shared matcher, then derives the key with the same `storedRoleId`/`worktreeNameToRoleId` pair `discoverBuilders` uses, which is extracted to one shared function so the two cannot diverge. Architects are keyed by name.
- **Null role ids.** A builder whose `roleId` is `null` (no derivable id) is skipped by the store, liveness and projection, never bucketed under a shared key; it keeps today's behavior.
- **Scope of "dropped".** A builder still registered in `entry.builders` whose PTY session is missing or exited is served `dead`. An architect is served `dead` while its session is in restart wait. An agent that Tower has removed from its registry entirely (an architect's permanent exit, `afx cleanup`) leaves the overview as it does today. This matches the spec's iteration-1 disposition: listing unregistered agents is out of scope.
- **Liveness cadence.** A Tower sweep every 5 s takes **one** process snapshot for all sessions through the existing `listProcessCensus()` (#1227), rather than a `pgrep` per pid. Dead is declared after two consecutive not-alive sweeps, at most about 10 s after exit, inside SC7's 15 s.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Agent-state wire contract and projection"},
    {"id": "phase_2", "title": "Shared attention predicate and summary"},
    {"id": "phase_3", "title": "Tower lifecycle ingestion and in-memory state"},
    {"id": "phase_4", "title": "Tower agent liveness"},
    {"id": "phase_5", "title": "Agent state served on the overview"},
    {"id": "phase_6", "title": "Claude lifecycle reporter and launch injection"},
    {"id": "phase_7", "title": "Attention surfaces render agent state"},
    {"id": "phase_8", "title": "Real-session verification and documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Agent-state wire contract and projection

**Dependencies**: None

#### Objective

Land the contract every later phase codes against, plus the single projection policy. These are pure code with no runtime wiring.

#### Files to Create / Modify

- `packages/types/src/agent-state.ts` (new). Doc-commented shapes only, exactly as the spec's Contract Surface:
  - `AgentState`, `AgentActivity`, `NeedsInputDetail`
  - `ServedAgentState`, the served row
  - `AgentLaunchIdentity`, `AgentLifecycleEvent`, and the `AgentLifecycleEventName` union
  - the limits as documented constants in comments only. No values or helpers ship in types (Constraint 12).
- `packages/types/src/api.ts`:
  - `agentState?: ServedAgentState | null` on `OverviewBuilder` and `ArchitectState`
  - `lastDataAt?: string | null` on `ArchitectState`
  - nothing else on those types changes (Constraint 13).
- `packages/types/src/index.ts`: re-export.
- `packages/core/src/agent-state.ts` (new): `projectAgentState(input)`.
  - Input: blocked (already computed by the caller with `detectBlocked`), the blocked-since time, the builder's `phase` (the field `isIdleWaiting` reads), liveness (`boolean | null`, with since), and reported activity (or none).
  - Output: `ServedAgentState | null`.
  - Precedence: blocked, then dead (never for `complete`/`verified`), then reported activity, then `null`.
  - It sets `source`, `since` and the raw inputs. It never parses `status.yaml` and holds no gate list.
- `packages/core/package.json`: `./agent-state` export. It imports only `@cluesmith/codev-types`, never `codev-sdk` (#1189; the core boundary test `no-sdk-import.test.ts` covers it). `packages/core/src/__tests__/agent-state.test.ts` (new).

#### Deliverables

- [ ] Types compiled and exported from `@cluesmith/codev-types`.
- [ ] `projectAgentState` with full precedence table tests.
- [ ] Boundary tests still pass: core imports only types (`no-sdk-import.test.ts`).

#### Acceptance Criteria

- [ ] Test 1: every combination of blocked × alive × reported activity × completion phase yields the documented state. `complete`/`verified` never projects `dead`.
- [ ] Existing consumers compile unchanged: the fields are optional.
- [ ] `pnpm build` and `check-types` pass for types, core, sdk, codev and apps.

#### Test Plan

- Unit: table-driven projection tests in core.
- Type-level: a compile test in sdk that an `OverviewBuilder` without `agentState` and one with `agentState: null` are both accepted.

### Phase 2: Shared attention predicate and summary

**Dependencies**: Phase 1

#### Objective

Make the one sdk predicate and `deriveAttention` read the served state, so every consumer switches over with no per-surface logic (SC10). With no state served, behavior is exactly today's.

#### Files to Create / Modify

- `packages/sdk/src/builder-helpers.ts`:
  - **`agentAttentionState(b, now)`** (new), the single classifier. For an agent that is not complete or verified, it returns `'blocked' | 'needs-input' | 'idle' | 'dead' | 'working' | null`:
    - A served `blocked` returns `'blocked'`. Surfaces keep their existing gate path for it, so it is never counted twice.
    - A served `needs-input`, `idle` or `dead` is returned as is.
    - A served `working` is `'working'` while `lastDataAt` is fresher than `IDLE_WAITING_THRESHOLD_MS`. With `backgroundWork`, it holds instead for `BACKGROUND_WORK_STALE_MS` (30 min) since `activityAt`.
    - A stale `working` returns `'idle'`.
    - A `null` or absent state returns `null`.
  - **`isIdleWaiting(b, now)`** keeps its name and signature. It is true when the classifier returns `needs-input`, `idle` or `dead`. On `null` it applies today's rule unchanged.
  - `WaitingItem.state?`. `WaitingItem.since` becomes `agentState.since` when the item comes from a served state (needs-input, idle, dead), else `lastDataAt` as today. This keeps ages right, including dead agents with no `lastDataAt`.
  - **Gated builders.** `atGate` is `blocked !== null || prReady` (`builder-helpers.ts:140`). Two cases:
    - **Porch gate.** It projects `blocked` (spec precedence), so a prompt on such a builder shows under the gate: the human's move either way.
    - **`prReady` alone.** It never projects `blocked`. A served `needs-input` or `dead` on a `prReady` builder is a different ask from the PR review, so it is listed in `waiting` even when `prReady` (SC1, SC7).
    - `idle`, and today's PTY-silence path, stay suppressed for `prReady` as now: an idle agent with its PR waiting on a reviewer is expected. The #1787 dedupe is unchanged.
  - **Completion.** The complete/verified check uses `b.phase`, the same field `isIdleWaiting` reads today. Phase 1's projection receives that same value.
  - `AttentionSummary.architects`, a list of `{ architect, state: 'needs-input' | 'dead', since }` built from `ArchitectState.agentState` with the same staleness rule over `ArchitectState.lastDataAt`. Architect `idle` is excluded (owner default 1).
  - `isEmpty` and `compareAttention` count architect items in the waiting bucket (Constraint 18): the waiting bucket applies when builders or architects are waiting, and its tiebreak uses the oldest `since` across both.
- `packages/sdk/src/__tests__/builder-helpers.test.ts`: extended.

#### Deliverables

- [ ] The classifier, the extended predicate, and summary changes, with tests.
- [ ] The sdk import-boundary test passes: no node or vscode imports.

#### Acceptance Criteria

- [ ] Test 3 (all its cases), including the regression fixtures: a `null` or absent state reproduces today's 5-minute results bit for bit.
- [ ] Test 4: architect needs-input and dead items listed and sorted in the waiting bucket; architect idle absent.
- [ ] SC14: complete and verified builders never count, whatever the state.
- [ ] SC6: a reported `working` stops suppressing once PTY silence passes 5 min.

#### Test Plan

- Unit: table-driven over state × `lastDataAt` age × `backgroundWork` × `activityAt` age × phase, with an injected `now`.
- Existing `deriveAttention`/`compareAttention` tests stay green, including the #1787 dedupe cases.

### Phase 3: Tower lifecycle ingestion and in-memory state

**Dependencies**: Phase 1

#### Objective

Give Tower the one write-only route and the in-memory store, with identity resolution and ordering, so a correctly shaped report changes state and nothing else does.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/agent-state/store.ts` (new), the in-memory store:
  - a `Map` keyed by `(normalized workspace path, canonical agent id)`
  - per entry: session id, activity, activity since, latest accepted hook time, `backgroundWork`, and needs-input detail held only while `needs-input`
  - ordering rules (SC17):
    - ignore a hook time older than the stored one;
    - a different session supersedes only with a newer hook time;
    - reject a hook time more than 60 s in the future;
    - a tool-less `needs-input` keeps the stored detail.
  - `drop(workspace, id)`
  - an `EventEmitter` raising `agent-state-changed` on every accepted report that changes any served field (activity, `activityAt`, `backgroundWork`, needs-input detail), not only the activity (Constraint 8). Nothing subscribes except the broadcaster.
  - Never touches `global.db` (SC11).
- `packages/codev/src/agent-farm/servers/agent-state/identity.ts` (new): `resolveAgentIdentity(identity)`.
  - It runs `normalizeWorkspacePath` on **both sides** of every comparison: the reported path, and each stored `builders.worktree` and workspace path it is matched against (Constraint 15, main's condition). Normalizing only the incoming path would leave the #1809 case half fixed.
  - Builder: worktree path, then the workspace from the last `/.builders/` segment, then the `builders` row by canonical worktree, with the existing tail-segment fallback. Returns the builder's canonical id.
  - Architect: name plus workspace, matched against the workspace's registered architects.
  - Returns the store key (the builder's lowercased role id, derived as above, or the architect's name) or `null`. It never throws: `detectCurrentBuilderId` throws by design (#1094), but the resolver uses only the shared row matcher, and the route maps `null` to a rejection.
  - **Cost.** Ingestion fires per tool call. Lookups use Tower's own `getGlobalDb()` handle, never a new readonly connection per call, behind a small memo keyed by the normalized path. The memo is invalidated when the builders or architects registry changes and bounded by a short TTL, so a newly spawned agent resolves on its first report.
  - `detectCurrentBuilderId` in `commands/send.ts` is refactored to call the same row-matching helper, so builder identity has one lookup (main confirmed this as the single-source-of-truth fix). Its identity precedence stays env-first then cwd (owner ruling on #1783, "keep as is"). The #1783 tests (`bugfix-1783-builder-identity-env.test.ts` and the send/whoami tests) must pass **unchanged**.
- `packages/codev/src/agent-farm/servers/agent-state/route.ts` (new): `handleAgentLifecycle`.
  - `readBody(req, 8192)`.
  - Strict validation against the contract and its limits: unknown keys rejected, the event-name allowlist, lengths, a finite `at`.
  - Resolve identity and reject unknown agents.
  - Apply the event to the store and return an empty 204.
  - On error, a 4xx with no body detail beyond a code.
  - Auth is the existing `isRequestAllowed` choke point; the route is **not** added to the public allowlist.
- `packages/codev/src/agent-farm/servers/tower-routes.ts`: a `'POST /api/agent-lifecycle'` entry in `ROUTES`.
- `packages/codev/src/agent-farm/servers/tower-server.ts`: wire the store's change event to `broadcastNotification({ type: 'overview-changed', ... })`.
- `packages/codev/src/lib/agent-env.ts`: export `ARCHITECT_WORKSPACE_ENV = 'CODEV_ARCHITECT_WORKSPACE'` and strip it in `sanitizeAgentEnv`.
- Tower session creation (`tower-routes.ts` terminal creation and the architect launch env in `tower-instances.ts`/`tower-terminals.ts`): set `CODEV_TOWER_PORT` to Tower's listening port on every agent session. Main's conditions (2026-10-21):
  - It is set on the **final composed** env in **every** session-creation path (both `tower-routes.ts` branches, plus the `tower-instances.ts` and `tower-terminals.ts` architect launches), after `sanitizeAgentEnv` and after any client env merge, so Tower always overwrites an inherited value. At `tower-routes.ts:897`, sanitization runs only when the client supplies an env, which is why both branches need it.
  - It is **not** added to `sanitizeAgentEnv`'s strip list: a nested `afx spawn` still goes through Tower, which overwrites it.
  - The only default is `DEFAULT_TOWER_PORT` from `@cluesmith/codev-sdk/constants`, with no second constant. The generated reporter script embeds that value at generation time.
  - The reporter connects to `127.0.0.1` only.
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (main and add-architect launch) and `tower-terminals.ts` (restart and reconnect): set `CODEV_ARCHITECT_WORKSPACE` beside `CODEV_ARCHITECT_NAME` at all four sites.
- Tests (new): `agent-state/__tests__/store.test.ts`, `identity.test.ts`, `route.test.ts`, plus the `agent-env` test extension.

#### Deliverables

- [ ] Store, identity resolver, route, broadcast wiring, and the env variable at four sites plus the strip.
- [ ] `send.ts` uses the shared builder lookup, and its existing tests stay green.

#### Acceptance Criteria

- [ ] Test 2:
  - a valid event updates state;
  - rejected: unauthenticated, malformed, unknown event, over-limit field, over-limit body, unknown agent;
  - older hook time and older session ignored; far-future rejected.
- [ ] Test 5 (identity half):
  - a builder worktree and an architect name-in-workspace resolve to the canonical id;
  - a path spelled differently (trailing slash, symlink, relative segment) resolves to the same agent;
  - the key used is the canonical id, never the raw path;
  - `sanitizeAgentEnv` strips `CODEV_ARCHITECT_WORKSPACE`.
- [ ] Test 6 (persistence half): ingestion writes nothing to `global.db`. A fresh store holds no state.
- [ ] Every architect launch site sets the variable. A test asserts the four sites' env.
- [ ] `CODEV_TOWER_PORT` is present on the final env of every session-creation path, overriding an inherited value, and is not stripped by `sanitizeAgentEnv`.
- [ ] The #1783 identity tests pass unchanged. A new ingestion-side test resolves a differently spelled path to the same builder.

#### Test Plan

- Unit: store ordering and supersession with injected clocks; resolver against a temp `global.db` and temp symlinked directories; route via the existing Tower route test harness with and without the key.

### Phase 4: Tower agent liveness

**Dependencies**: Phase 3 (the store's drop and broadcast hooks)

#### Objective

Compute agent liveness in exactly one place, for every harness, with no false `dead` on relaunch pauses or context resets (SC7, Constraint 14).

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/agent-state/liveness.ts` (new): a 5 s sweep over every registered builder and architect, keeping per-agent `{ alive: boolean | null, since }`.
  - **Process shapes.** For a shellper-backed session (the production case), `session.pid` is the **shellper**, so the tree is shellper → launch loop → agent for builders and shellper → agent for architects. For a direct PTY session, `session.pid` is the PTY child itself. Liveness walks from `session.pid` by the session's shape, using one snapshot per sweep from the existing `listProcessCensus()` (`process-census.ts`, #1227: one shared `ps` caller, not a new bespoke one). The childless test follows the existing `shellper-husk-sweep.ts` predicate (`parentPids.has(pid)`) and its `census` test seam. Its `[]`-on-failure return (`census.length === 0`) is treated as **unknown** for the whole sweep (`alive: null`, no confirmation counted), never as "every agent childless", so a failed `ps` cannot mark the fleet dead.
  - **Builders.** The agent is alive when the launch loop (the shellper's child, or `session.pid` for a direct PTY) has at least one child process. The relaunch pause's `sleep 2` counts as alive by design. The `read -r` relaunch prompt has no child, so it reads as not alive, even though the loop itself, and so the shellper's child, is still running.
  - **Architects.** Not alive while the session is in restart wait (`awaitingRestart`), or when a shellper-backed session's shellper has no child process.
  - **Any agent.** A registered agent with no session is not alive.
  - **Confirmation.** A transition to not alive is published only after two consecutive not-alive sweeps.
  - **Unknown.** `alive: null` when the snapshot fails or the process shape is unrecognized.
  - The sweep **drops** store entries for agents no longer registered (SC11: a removed agent's state goes with it).
  - It emits a change, and so `overview-changed`, when a published liveness value flips.
- `packages/codev/src/terminal/pty-session.ts`: a public read-only `awaitingRestart` getter, true while the restart-wait timer is armed. This is the existing `_restartCleanupTimeout`; restart logic is unchanged.
- `packages/codev/src/agent-farm/servers/tower-server.ts`: start the sweep at boot and stop it on shutdown.
- `agent-state/__tests__/liveness.test.ts` (new).

#### Deliverables

- [ ] Liveness module with an injectable process-snapshot and session source, the sweep lifecycle, and the restart-wait getter.

#### Acceptance Criteria

- [ ] Test 8:
  - not alive for: a launch loop with no agent child, in both shellper-backed and direct shapes; an architect in restart wait; a shellper with no child; a registered builder with no session (architects with no session are not listed by `liveArchitects`, per the dropped-scope note);
  - alive for: shellper → loop → agent; shellper → architect agent;
  - a single not-alive sweep (shorter than the confirmation) publishes nothing;
  - `sleep` during the relaunch pause stays alive.
- [ ] Entries of removed agents are dropped on the next sweep.
- [ ] Sweep cost: one census call per sweep regardless of fleet size (asserted with the injected census).
- [ ] A failed census (`[]`) publishes `alive: null` for every agent and advances no confirmation counter.

#### Test Plan

- Unit: synthetic `ps` snapshots (shellper → loop → agent, loop with no child, loop with only `sleep`, missing pids); fake timers for the confirmation.
- Manual smoke (recorded in Phase 8): exit a real builder's agent, then dead within 15 s.

### Phase 5: Agent state served on the overview

**Dependencies**: Phases 1, 3, 4

#### Objective

Serve the projected `agentState` per builder and architect on the overview, so the contract is live end to end for any reporter.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/servers/tower-routes.ts`, in `handleOverview` and `liveArchitects`:
  - Project over **every** builder in `data.builders`, not inside the existing `entry.builders` loop, which `continue`s on a missing session (exactly the dropped case). Call `projectAgentState` with the builder's existing `blocked`/`blockedSince` (already computed by `detectBlocked` in `overview.ts`, Constraint 14), its `phase`, liveness, and store activity, matched by the lowercased role id. A builder registered with no session gets `alive: false`.
  - `liveArchitects` gains the workspace path so it can read the store and liveness by `(workspace, name)`. Both callers (`/api/state` and `/api/overview`) are updated.
  - For each live architect, the same, plus `lastDataAt` from its PTY session.
  - The overview cache is untouched: agent rows stay per request.
- `packages/codev/src/agent-farm/servers/__tests__/overview-agent-state.test.ts` (new).

#### Deliverables

- [ ] `agentState` on `OverviewBuilder` and `ArchitectState`, and `ArchitectState.lastDataAt`.

#### Acceptance Criteria

- [ ] SC8: blocked builders keep the same `blocked`, `blockedGate` and `blockedSince`, and their `agentState.state` is `blocked`.
- [ ] SC14: a complete or verified builder whose agent is gone is never `dead`.
- [ ] SC7: a registered builder with no PTY session is served `dead`.
- [ ] A posted event changes the next overview response and fires one `overview-changed`.
- [ ] Test 6: after a Tower restart (a fresh process), no reported state is served; liveness still serves `dead`.

#### Test Plan

- Integration: the Tower test harness with a registered fake builder and architect. Post events, read `/api/overview`, assert the rows and the SSE notification.

### Phase 6: Claude lifecycle reporter and launch injection

**Dependencies**: Phases 3 and 5 (a real endpoint to post to and an overview to observe)

#### Objective

Make every Claude agent Codev launches report its lifecycle, through one role-named optional `HarnessProvider` capability, without touching the write-guard and never slowing the session.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/utils/lifecycle-reporter.ts` (new). The Claude provider's reporter: generated content, in the shape of `worktree-write-guard.ts`.
  - **`LIFECYCLE_REPORTER_SCRIPT`**, a dependency-free Node CJS script:
    - reads the stdin payload;
    - maps Claude hooks to neutral events per the spec's mapping table, with the question tool's kind taken from the tool name;
    - builds the bounded single-line plain-text summary from the tool's primary argument (command or path; control characters stripped; at most 200 characters; tool name at most 64);
    - reads identity only from `CODEV_BUILDER_WORKTREE`, or from `CODEV_ARCHITECT_WORKSPACE` with `CODEV_ARCHITECT_NAME`, and with neither set exits silently;
    - reads `~/.agent-farm/local-key` and POSTs once to `127.0.0.1:<tower port>` with a sub-second deadline and no retry;
    - always exits 0 with empty stdout.
  - **`buildLifecycleReporterSettings(scriptPath)`**: the settings JSON for the hook set.
    - `SessionStart`, `UserPromptSubmit`, `PostToolUse` (all tools), `PreToolUse` matched to the question tool only, `PermissionRequest`, `Notification`, `Stop`. `SessionEnd` is not wired.
    - Every hook is `async: true` with a short `timeout`, and runs one identical command.
    - **The command fails silently even when the script is missing** (SC15). It is a shell wrapper, not a bare `node <path>`: `[ -f '<script>' ] && node '<script>' >/dev/null 2>&1; exit 0`. A deleted or never-written script, a missing `node`, or a crash produces no output and exit 0. The wrapper text is the same for every agent.
    - **Path quoting is safe under bash on Windows** (main's condition, from #1658). On Windows the launch script runs under Git Bash and Claude Code runs hooks through Git Bash, so the hook command string and the `--settings` argument are parsed by bash. Every path in them (the script path inside the wrapper, and the settings path in `args` and `scriptFragment`) is converted to forward slashes and single-quoted with the existing single-quote escaper. A backslash path can then never be eaten by bash.
  - **`ensureLifecycleReporterInstalled()`**: writes both files to the hooks directory (main's conditions, 2026-10-21):
    - The directory derives from `AGENT_FARM_DIR` (`@cluesmith/codev-core/constants`), so it resolves under `USERPROFILE` on Windows (#1658).
    - Each write is a temp file plus rename, done only when the content differs.
    - Modes are set explicitly, not left to umask: directory `0700`, files `0600`.
    - The `--settings` path handed to the harness is absolute.
    - Neither file embeds a secret. The local key is read at hook time from its own file, never baked into the script or the settings.
- `packages/codev/src/agent-farm/utils/harness.ts`:
  - The optional capability `buildLifecycleReporterInjection(settingsPath): { args: string[]; scriptFragment: string; env: Record<string, string> }`. It covers both launch shapes in one call (Constraint 17), following `buildResume`'s single-method dual-form precedent (`args` plus `scriptFragment`). The role injection's two-method pair is the other documented form; one method keeps the capability a single optional member whose absence means unsupported.
  - `CLAUDE_HARNESS` implements it as `--settings '<path>'`. Codex and OpenCode do not. Main reads Constraint 17 the same way. Absence means unsupported: there is no default in the interface, and the per-provider knowledge stays inside the provider, with no exported provider tables (the #1797 precedent).
- `packages/codev/src/agent-farm/commands/spawn-worktree.ts`: both launch scripts (lines ~1164 and ~1255) append the fragment to the **base command**, before `withRole`, `initial` and `resume` are built, and merge its env into the exported block unconditionally (also when there is no role). Every loop form then carries the reporter: initial, resume, pinned fresh, unpinned fresh and crash resume. This covers `afx spawn`, `afx spawn --resume` and `afx workspace recover`, which regenerate or rerun these scripts.
- `packages/codev/src/agent-farm/servers/tower-utils.ts`: the injection is applied in exactly two places, so no launch gets it twice:
  - **inside `buildArchitectArgs`**, on both its role and no-role branches. Every `resolveArchitectLaunch` return except the resume primary already spreads `buildArchitectArgs` (`tower-utils.ts:400`, `:423` fallback, `:438`), as do the crash-loop fallback, fresh launch and reconnect-restart builders;
  - **on the resume primary return** (`:427-433`), which deliberately bypasses `buildArchitectArgs` and today returns `env: {}`.

  Because `buildArchitectArgs` is the funnel, the injection also reaches the no-Tower `afx architect` (`commands/architect.ts`). That is harmless: no site sets `CODEV_ARCHITECT_NAME`/`CODEV_ARCHITECT_WORKSPACE` on that path, so the reporter finds no identity and sends nothing.
- Tests (new): `utils/__tests__/lifecycle-reporter.test.ts` and harness/launch tests.

#### Deliverables

- [ ] Reporter script and settings generation, the installer, the provider capability, and injection at both builder scripts and the architect funnel.

#### Acceptance Criteria

- [ ] Test 5 (translation half):
  - every Claude hook fixture maps to the expected neutral event with limits applied: `Stop` with and without background tasks, every Notification type, `PermissionRequest` for Bash, Write and the question tool, `PreToolUse` for the question tool, and each `SessionStart` source;
  - exit 0 and empty stdout when Tower is down, slow, or erroring, on malformed input, and with no identity;
  - the **exact generated hook command** (wrapper included), run through a shell after the script file is deleted: no stdout, no stderr, exit 0;
  - the installer sets modes `0700`/`0600` regardless of umask, rewrites only on a content change, and leaves no secret in either file;
  - **backslash-path test:** with a Windows-style hooks directory (for example `C:\Users\a b\.agent-farm\hooks`), the generated wrapper command and the injection's `args` and `scriptFragment` contain only forward-slash, single-quoted paths. Running the wrapper and the fragment through `bash -c` yields the original path intact (spaces included);
  - no request is made without identity.
- [ ] Test 7: the injection is present in each of these forms. Codex, OpenCode and custom providers include none.
  - Claude builder: fresh, resume, and every loop branch.
  - Architect: fresh with and without a role, **resume**, resume fallback, crash-loop fallback, reconnect restart.
  - Recover.
- [ ] The launch-script byte-identity tests are updated deliberately for the Claude script (it gains the fragment). Session-less harness scripts (Codex, Gemini, OpenCode, custom) stay byte-identical, since those providers do not implement the capability.
- [ ] The write-guard's `settings.local.json` output is byte-identical to before (Constraint 5).
- [ ] SC15, measured with a real script run against a hung listener: the hook returns within its timeout, the parent turn is not held (it is async), and nothing is printed.

#### Test Plan

- Unit: run the generated script as a child process with fixture stdin against a local stub server (accepting, hanging, refusing, 500), asserting the request body and the exit behavior.
- Launch-form snapshot tests for each provider.

### Phase 7: Attention surfaces render agent state

**Dependencies**: Phases 2 and 5

#### Objective

Show needs-input, idle and dead distinctly on every listed surface through the one predicate (SC10), count architects (SC13), and render the summary as plain text (SC19).

#### Files to Create / Modify

- VS Code:
  - `apps/vscode/src/extension.ts`: the status bar and activity badge count `isIdleWaiting` builders plus `deriveAttention(...).architects`.
  - `apps/vscode/src/views/builder-row.ts`: icon, label and tooltip per `agentAttentionState`. Needs-input shows "at a permission prompt: <tool> <summary>" or "asking a question". Idle shows "turn ended". Dead shows a distinct icon. The text is set as a plain string, never `MarkdownString`.
  - `apps/vscode/src/views/builders.ts`: sort and group buckets use the classifier.
  - `apps/vscode/src/views/tower-cache.ts` and the Tower view: architect items in the waiting bucket.
  - `apps/vscode/src/contextual-panel/panel-provider.ts` and its webview `apps/vscode/src/contextual-panel/webview/main.ts`: architect items and distinct states.
- Web:
  - `apps/web/src/components/BuilderCard.tsx` shows "Needs input: …", "Idle" and "Agent exited" distinctly, with the summary as a text node.
  - `apps/web/src/components/NeedsAttentionList.tsx`, the dashboard's "Needs Attention" list, derives today from gates and PRs only. It gains rows for needs-input and dead agents (builders and architects) from `deriveAttention`, so an agent at a prompt appears there as well as on its card. `apps/web/src/components/WorkView.tsx` passes the overview's architects into it.
- The `[elapsed]` badge on the row uses `agentState.since` when present, else `lastDataAt`.
- Stream Deck (`apps/streamdeck/src/face.ts`) is unchanged: it does not consume waiting today and is not a listed surface.
- Tests: `apps/vscode/src/test/builders.test.ts` and siblings, the web component tests, and the Playwright dashboard check.

#### Deliverables

- [ ] All listed surfaces migrated. A grep shows no **agent-attention** `lastDataAt` threshold logic outside the sdk. `apps/web/src/components/OpenFilesShellsSection.tsx`'s separate utility-terminal threshold is intentionally out of scope.

#### Acceptance Criteria

- [ ] SC10: every listed consumer reads the classifier, predicate or summary.
- [ ] SC13: an architect at needs-input or dead is counted under its name; an idle architect is not.
- [ ] SC19: a summary containing Markdown and command-link syntax renders literally on the row tooltip and the card.
- [ ] SC7: dead renders distinctly on the builder row and the dashboard card.
- [ ] The dashboard is verified in a browser with Playwright against a Tower serving fixture states (testing guide).

#### Test Plan

- Unit: row and card rendering per state.
- Playwright: the dashboard card for needs-input, idle, dead and blocked fixtures.

### Phase 8: Real-session verification and documentation

**Dependencies**: Phases 1 to 7

#### Objective

Verify the spec against real spawned sessions, derived from the operator's actions rather than the code. Fix anything found, and document the system.

#### Files to Create / Modify

- Any fixes the runs surface, in the owning phase's files.
- `codev/resources/arch.md`, Agent Farm Internals: agent state (reporter, ingestion, in-memory store, liveness, projection, predicate).
- `codev/resources/arch-critical.md`: considered at review-time routing. A hot fact would displace a weaker one only if the routing calls for it.
- The reporter's operator-facing note in the afx skill or docs, if the review deems it user-facing.

#### Deliverables

- [ ] A run log in the review covering scenarios 9 to 20 against a real local Tower and real `afx spawn` builders and architects, on the current Claude Code release.
- [ ] **Launch command for the permission scenarios.** The workspace's default builder and architect commands carry `--dangerously-skip-permissions`, under which `PermissionRequest` never fires, so scenarios 9 and 20 would pass falsely. Those runs use a launch command without that flag (set in `.codev/config.json` for the test spawn, or with `--builder-cmd`/`--architect-cmd`). The log records the exact command used.
- [ ] Docs updated.

#### Acceptance Criteria

- [ ] Scenarios 9 to 20 pass. In particular, SC1's 5 s needs-input with tool and summary, SC4's immediate idle, SC5's silent tool staying working, SC7's dead within 15 s and never on `/clear`, SC9's Codex fallback plus dead, SC12's write-guard still denying, and SC15's no TUI delay or noise with Tower stopped.
- [ ] The full build, `check-types`, unit tests and the e2e suites pass on the final head.

#### Test Plan

- Manual-real per the spec's integration scenarios, with the observed served states and timings recorded.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A Claude Code release stops concatenating `--settings` hooks with the worktree settings | Low | High | Scenario 19 in Phase 8; Approach B remains the documented fallback channel |
| The `ps` snapshot is slow under load | Low | Medium | One call per 5 s sweep with its own timeout; a failed snapshot publishes `alive: null`, never `dead` |
| Process-shape assumptions break for a session form not covered (non-shellper PTY, custom harness command) | Medium | Medium | Liveness handles both pid shapes; an unrecognized shape yields `alive: null`, and the predicate's fallback applies |
| Identity lookup diverges from `afx whoami` | Low | Medium | `send.ts` and the ingestion route call one shared builder-row helper (Phase 3) |
| Reporter version skew: an old session runs the updated script | Low | Low | The script is backward compatible with its own events, and the contract is versionless and additive |
| Surface migration misses a consumer | Low | Medium | Phase 7 grep gate for `lastDataAt` thresholds outside the sdk |
| Count flicker from immediate idle | Medium | Low | Owner default 2; idle renders distinctly from needs-input |

## Documentation Updates

- `codev/resources/arch.md`: the agent-state subsystem (Phase 8).
- `codev/resources/arch-critical.md`: only if review routing promotes a fact, by displacement.
- Release notes and the VS Code changelog: handled per the project's changelog workflow when the PR merges. User-facing wording: "needs input", "idle" and "agent exited" states replace the 5-minute "waiting" guess for Claude agents.
- No `codev-skeleton/` change: nothing here is a framework file that adopters receive by copy. The reporter is generated at launch by the installed package.
