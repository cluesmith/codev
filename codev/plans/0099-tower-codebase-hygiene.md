# Plan: Tower Codebase Hygiene

## Metadata
- **Specification**: codev/specs/0099-tower-codebase-hygiene.md
- **Created**: 2026-02-11

## Executive Summary

Systematic cleanup of post-migration debt across the Tower codebase. Five phases ordered by increasing risk: dead code removal, naming fixes, CLI consolidation, state management, then error handling and deduplication. Each phase is independently committable and testable.

## Success Metrics
- [ ] All 11 acceptance criteria from spec met
- [ ] All existing tests pass (updated as needed)
- [ ] New tests for file tab SQLite persistence
- [ ] No regressions in Tower startup/shutdown flow
- [ ] Build succeeds (`npm run build`)

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Dead Code Removal"},
    {"id": "phase_2", "title": "Naming and Terminology Fix"},
    {"id": "phase_3", "title": "CLI Consolidation"},
    {"id": "phase_4", "title": "State Management Fixes"},
    {"id": "phase_5", "title": "Error Handling and Dedup"}
  ]
}
```

## Phase Breakdown

### Phase 1: Dead Code Removal
**Dependencies**: None

#### Objectives
- Remove dead code paths that reference deleted architecture
- Clean up `Builder`/`UtilTerminal`/`Annotation`/`ArchitectState` types to remove vestigial `port`/`pid` fields

#### Files to Modify
- **DELETE** `packages/codev/src/agent-farm/utils/orphan-handler.ts`
- `packages/codev/src/agent-farm/servers/tower-server.ts` — remove `state.json` deletion block (~lines 1486-1497)
- `packages/codev/src/agent-farm/commands/stop.ts` — remove `findOrphanProcesses` function and `dashboard-server.js` scanning (~lines 54-102), remove PID-based kill logic in legacy cleanup
- `packages/codev/src/agent-farm/types.ts` — remove `port`/`pid` from `Builder`, `UtilTerminal`, `Annotation`, `ArchitectState`
- `packages/codev/src/agent-farm/commands/cleanup.ts` — remove PID-based kill logic, use `terminalId`
- `packages/codev/src/agent-farm/commands/attach.ts` — remove `builder.port` references, remove PID-based status checks
- `packages/codev/src/agent-farm/commands/status.ts` — remove port display column, use `terminalId` for status
- `packages/codev/src/agent-farm/commands/spawn.ts` — update `startBuilderSession` return type, remove `port: 0, pid: 0` returns
- `packages/codev/src/agent-farm/state.ts` — update serialization if it reads/writes port/pid
- `packages/codev/src/agent-farm/db/index.ts` — SQLite migration: the `builders` table likely has `port`/`pid` columns. Strategy: SQLite doesn't support `DROP COLUMN` in older versions. Instead, keep columns in the schema but stop writing them (set to 0/null). Update queries to not select them. This is safe because `port` and `pid` are always 0 for Tower-backed terminals anyway. No data migration needed — existing rows already have `port=0, pid=0`

#### Acceptance Criteria
- [ ] `orphan-handler.ts` no longer exists on disk
- [ ] `state.json` deletion code removed from tower-server
- [ ] `findOrphanProcesses` removed from stop.ts
- [ ] `port`/`pid` fields removed from all four interfaces in types.ts
- [ ] All consumers compile without `port`/`pid` references
- [ ] `npm run build` succeeds
- [ ] All existing tests pass (updated as needed)

#### Test Plan
- **Unit Tests**: Update existing type tests if any reference port/pid
- **Build Test**: `npm run build` must succeed — TypeScript compiler catches any missed port/pid references
- **Manual Test**: `af stop` still works correctly without orphan scanning

---

### Phase 2: Naming and Terminology Fix
**Dependencies**: Phase 1

#### Objectives
- Standardize tmux session naming to Tower convention (`architect-{basename}`)
- Update all user-facing messages from "dashboard" to "Tower" references
- Fix stale docstrings

#### Files to Modify
- `packages/codev/src/agent-farm/commands/architect.ts` — change `SESSION_NAME` from `af-architect` to `architect-{basename}`, change `LAYOUT_SESSION_NAME` similarly
- `packages/codev/src/agent-farm/commands/consult.ts` — line 28: "af dash start" → "af tower start"
- `packages/codev/src/agent-farm/commands/status.ts` — line 73: update dashboard reference
- `packages/codev/src/commands/adopt.ts` — line 231: update message
- `packages/codev/src/commands/init.ts` — line 197: update message
- `packages/codev/src/agent-farm/utils/server-utils.ts` — line 3: fix "dashboard-server.ts" reference
- `packages/codev/src/agent-farm/servers/tower-server.ts` — remove duplicate comment (~line 1745-1746)

#### Acceptance Criteria
- [ ] `architect.ts` uses `architect-{basename}` naming pattern
- [ ] All four files reference "af tower start" not "af dash start"
- [ ] No docstrings reference "dashboard-server.ts"
- [ ] `npm run build` succeeds

#### Test Plan
- **Grep verification**: `grep -r "af dash start" packages/codev/src/` returns no results
- **Grep verification**: `grep -r "dashboard-server.ts" packages/codev/src/` returns no results (except git history)
- **Build Test**: TypeScript compilation succeeds

---

### Phase 3: CLI Consolidation
**Dependencies**: Phase 2

#### Objectives
- Make `consult.ts` work standalone without Tower dependency
- Route `shell.ts` and `open.ts` through TowerClient (remove duplicate `encodeProjectPath`, add auth headers)
- Fix `attach.ts` URL construction
- Fix `getGateStatusForProject()` to read porch YAML instead of dead HTTP fetch
- Remove `af start --remote` and all associated code

#### Files to Modify
- `packages/codev/src/agent-farm/commands/consult.ts` — rewrite: remove dashboard shell tab creation entirely. Use `child_process.spawn` with `{ stdio: 'inherit' }` to run the consult command directly as a subprocess. This makes `consult` work with or without Tower
- `packages/codev/src/agent-farm/commands/open.ts` — import `encodeProjectPath` from `tower-client.ts` instead of local duplicate; use TowerClient for API calls (gets auth header automatically)
- `packages/codev/src/agent-farm/utils/shell.ts` — replace local `encodeProjectPath` (if present) with import from `tower-client.ts`; route Tower API calls through TowerClient for auth headers. Note: the spec's "shell.ts" refers to the `af shell` command behavior, which may live in a different file — verify and update the correct file
- `packages/codev/src/agent-farm/commands/attach.ts` — remove `builder.port` URL construction; use `TowerClient.getProjectUrl()` for browser mode
- `packages/codev/src/agent-farm/servers/tower-server.ts` — rewrite `getGateStatusForProject()` to read porch YAML files from the project path. Use `fs.readFileSync` and simple YAML key extraction (porch status files are simple enough to parse without a YAML library — look for `gate:` and `status:` lines)
- `packages/codev/src/agent-farm/commands/start.ts` — remove `startRemote()`, `parseRemote()`, `checkPasswordlessSSH()`, `checkRemoteVersions()`, `--remote` option from `StartOptions`
- `packages/codev/src/agent-farm/types.ts` — remove `remote` and `allowInsecureRemote` from `StartOptions`

#### Acceptance Criteria
- [ ] `consult.ts` works without Tower running (spawns process via `child_process.spawn`)
- [ ] `open.ts` imports `encodeProjectPath` from `tower-client.ts`, no local duplicate
- [ ] `open.ts` sends auth header (`codev-web-key`) via TowerClient
- [ ] `shell.ts` / `af shell` uses TowerClient, no duplicate `encodeProjectPath`
- [ ] `attach.ts --browser` generates Tower dashboard URL via `TowerClient.getProjectUrl()`
- [ ] `getGateStatusForProject()` reads porch YAML, no HTTP fetch
- [ ] `--remote` flag and all SSH code removed from start.ts
- [ ] `npm run build` succeeds

#### Test Plan
- **Unit Tests**: Test that `consult.ts` spawns process correctly without Tower
- **Unit Tests**: Test `getGateStatusForProject()` reads YAML from filesystem
- **Build Test**: TypeScript compilation succeeds
- **Grep verification**: No duplicate `encodeProjectPath` definitions outside `tower-client.ts`
- **Grep verification**: No references to `localhost:${dashboardPort}` in consult.ts

---

### Phase 4: State Management Fixes
**Dependencies**: Phase 3

#### Objectives
- Persist file tabs to SQLite so they survive Tower restarts
- Document tmux/SQLite dual-source strategy

#### Files to Modify
- `packages/codev/src/agent-farm/servers/tower-server.ts` — add `file_tabs` table creation, load tabs on startup, write-through on create/delete
- `packages/codev/src/agent-farm/db/index.ts` — add `file_tabs` table to schema initialization (if centralized) or handle in tower-server directly

#### Implementation Details

**SQLite Schema:**
```sql
CREATE TABLE IF NOT EXISTS file_tabs (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_tabs_project ON file_tabs(project_path);
```

**Write-through pattern:**
- On `POST /api/tabs/file` (create): insert row into `file_tabs`, then add to in-memory Map
- On `DELETE /api/tabs/file/:id` (delete): delete row from `file_tabs`, then remove from in-memory Map
- On Tower startup / project activation: `SELECT * FROM file_tabs WHERE project_path = ?` → populate in-memory `fileTabs` Map

**Documentation:**
- Add comment block at `reconcileTerminalSessions()` explaining tmux=liveness, SQLite=metadata

#### Acceptance Criteria
- [ ] `file_tabs` table created on first Tower startup
- [ ] Creating a file tab persists to SQLite
- [ ] Deleting a file tab removes from SQLite
- [ ] After Tower restart, file tabs are restored from SQLite
- [ ] Reconciliation comment block explains dual-source strategy
- [ ] `npm run build` succeeds

#### Test Plan
- **Unit Tests**: Test file tab persistence round-trip (create → restart → load)
- **Unit Tests**: Test tab deletion removes from SQLite
- **Integration Test**: Verify `file_tabs` table is created on startup
- **E2E/Playwright**: Run existing Tower baseline tests to verify no regressions in tab API behavior

---

### Phase 5: Error Handling and Dedup
**Dependencies**: Phase 4

#### Objectives
- Add error logging to notification failures
- Improve shell.ts error differentiation
- Deduplicate architect.ts functions
- Extract shared `getSessionName` utility
- Improve Tower error handling and logging

#### Files to Modify
- `packages/codev/src/agent-farm/utils/notifications.ts` — log non-200 responses at warn level
- `packages/codev/src/agent-farm/utils/shell.ts` — differentiate connection errors vs server errors (if shell.ts is utils/shell.ts; spec says "shell.ts error handling" which refers to `af shell` behavior)
- `packages/codev/src/agent-farm/commands/architect.ts` — extract shared setup logic into private `createSession()` helper
- **CREATE** `packages/codev/src/agent-farm/utils/session.ts` — shared `getSessionName(config, builderId)` function
- `packages/codev/src/agent-farm/commands/spawn.ts` — import `getSessionName` from utils/session.ts
- `packages/codev/src/agent-farm/commands/cleanup.ts` — import `getSessionName` from utils/session.ts
- `packages/codev/src/agent-farm/servers/tower-server.ts` — standardize error responses to JSON, add `console.error` for unexpected failures in activation/terminal/file-tab routes

#### Acceptance Criteria
- [ ] `notifications.ts` logs non-200 responses with `console.warn`
- [ ] Error messages in shell.ts differentiate connection refused from server errors
- [ ] `architect.ts` has single `createSession()` helper, no duplicate code blocks
- [ ] `getSessionName` exists only in `utils/session.ts`, imported by spawn.ts and cleanup.ts
- [ ] Tower error responses are `{ error: string }` JSON
- [ ] Tower logs unexpected errors with `console.error`
- [ ] `npm run build` succeeds
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: Test `getSessionName` utility
- **Build Test**: TypeScript compilation succeeds
- **Grep verification**: No duplicate `getSessionName` definitions

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Removing port/pid from TypeScript types | Medium | Medium | Keep SQLite columns but stop writing them; existing rows already have 0 values. TypeScript compiler catches all missed references |
| Spec 0098 merge conflicts on shared files | Medium | Low | 0098 should land first; resolve at merge time |
| File tab persistence edge cases | Low | Low | Simple write-through pattern, no complex sync |
| Tower route changes break dashboard UI | Low | Medium | Test with Playwright if UI changes are affected |

## Validation Checkpoints
1. **After Phase 1**: `npm run build` succeeds, `af stop` works without orphan scanning
2. **After Phase 3**: `consult` works standalone, `af open` uses TowerClient auth
3. **After Phase 4**: File tabs survive Tower restart
4. **After Phase 5**: Full test suite passes, no duplicate code

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
