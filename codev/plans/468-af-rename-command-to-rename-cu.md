# Plan: af rename Command

## Metadata
- **ID**: plan-2026-02-21-af-rename
- **Status**: draft
- **Specification**: codev/specs/468-af-rename-command-to-rename-cu.md
- **Created**: 2026-02-21

## Executive Summary

Implement `af rename "name"` using Environment Variable + Tower API (Approach 1 from spec). The work breaks into three phases: (1) database and environment plumbing, (2) Tower API endpoint + dashboard state fix, (3) CLI command. Each phase builds on the previous and is independently testable.

## Success Metrics
- [ ] `af rename "name"` works inside utility shell sessions
- [ ] Error handling for non-shell sessions, missing env var, stale sessions
- [ ] Duplicate name auto-dedup with `-N` suffix
- [ ] Labels persist across Tower restarts via SQLite
- [ ] Test coverage >90% on new code
- [ ] Dashboard tab titles update after rename

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Database Migration and Environment Variables"},
    {"id": "phase_2", "title": "Tower API Rename Endpoint and Dashboard State"},
    {"id": "phase_3", "title": "CLI Command and Integration"}
  ]
}
```

## Phase Breakdown

### Phase 1: Database Migration and Environment Variables
**Dependencies**: None

#### Objectives
- Add `label` column to `terminal_sessions` table via migration v11
- Inject `SHELLPER_SESSION_ID` and `TOWER_PORT` environment variables into shell sessions at creation time
- Update `saveTerminalSession` to accept and store labels
- Update label loading on startup (reconciliation path)

#### Deliverables
- [ ] Migration v11: `ALTER TABLE terminal_sessions ADD COLUMN label TEXT`
- [ ] `GLOBAL_SCHEMA` updated with `label TEXT` column in `terminal_sessions`
- [ ] `GLOBAL_CURRENT_VERSION` bumped to 11
- [ ] `SHELLPER_SESSION_ID` and `TOWER_PORT` set in shell env during `handleWorkspaceShellCreate`
- [ ] `saveTerminalSession` accepts optional `label` parameter
- [ ] `reconcileTerminalSessions` uses `dbSession.label` when reconnecting (instead of hardcoded default)
- [ ] `handleWorkspaceState` uses `session.label` for shell `name` field (instead of hardcoded `Shell N`)
- [ ] Unit tests for migration and env var injection

#### Implementation Details

**Files to modify:**

1. **`packages/codev/src/agent-farm/db/schema.ts`** (~line 96-107)
   - Add `label TEXT` column to `terminal_sessions` in `GLOBAL_SCHEMA`

2. **`packages/codev/src/agent-farm/db/index.ts`** (~line 362, 617-636)
   - Bump `GLOBAL_CURRENT_VERSION` from 10 to 11
   - Add migration v11: `ALTER TABLE terminal_sessions ADD COLUMN label TEXT`

3. **`packages/codev/src/agent-farm/servers/tower-terminals.ts`**
   - **`saveTerminalSession`** (~line 147): Add optional `label` parameter, include in INSERT/REPLACE
   - **`reconcileTerminalSessions`** (~line 482): Change `const label = dbSession.type === 'architect' ? 'Architect' : (dbSession.role_id || 'unknown')` to prefer `dbSession.label` when present: `const label = dbSession.label || (dbSession.type === 'architect' ? 'Architect' : (dbSession.role_id || 'unknown'))`
   - Add `updateTerminalLabel(terminalId: string, label: string): void` function for Phase 2

4. **`packages/codev/src/agent-farm/servers/tower-routes.ts`**
   - **`handleWorkspaceShellCreate`** (~line 1356-1365): Add `SHELLPER_SESSION_ID` (set to `sessionId` UUID) and `TOWER_PORT` (set to Tower's listen port) to `shellEnv` before passing to `shellperManager.createSession`
   - **Fallback path** (~line 1402-1408): Add same env vars, using `session.id` (PtySession ID) as `SHELLPER_SESSION_ID` since there's no shellper UUID
   - **`saveTerminalSession` calls** (~lines 1383, 1413): Pass label parameter
   - **`handleWorkspaceState`** (~line 1296): Change `name: \`Shell ${shellId.replace('shell-', '')}\`` to `name: session.label` — this is how the dashboard gets the shell name, and it must reflect the current label rather than the hardcoded default

#### Acceptance Criteria
- [ ] Migration runs without error on existing databases
- [ ] Fresh installs create `terminal_sessions` with `label` column
- [ ] New shell sessions have `SHELLPER_SESSION_ID` and `TOWER_PORT` in their environment
- [ ] `saveTerminalSession` stores label when provided
- [ ] On Tower restart, reconnected sessions use the label from SQLite (not hardcoded default)
- [ ] Dashboard state endpoint returns the session's current label for shell names

#### Test Plan
- **Unit Tests**: Migration v11 adds column; `saveTerminalSession` with label; label loading from DB in reconciliation
- **Manual Testing**: Start Tower, create shell, verify `echo $SHELLPER_SESSION_ID` and `echo $TOWER_PORT` return values; verify dashboard shows session label

#### Rollback Strategy
Migration v11 only adds a nullable column — existing code ignores it. Revert the code changes; column remains harmless.

#### Risks
- **Risk**: Migration on large databases
  - **Mitigation**: `ADD COLUMN` is an O(1) operation in SQLite, no data rewrite needed

---

### Phase 2: Tower API Rename Endpoint and Dashboard State
**Dependencies**: Phase 1

#### Objectives
- Add rename endpoint inside `handleTerminalRoutes` (global terminal API)
- Implement name validation (1-100 chars, strip control chars server-side)
- Implement session type check (only `shell` type allowed)
- Implement duplicate name deduplication across active sessions
- Update both SQLite and in-memory PtySession label
- Make PtySession label mutable

#### Deliverables
- [ ] PtySession `label` made mutable (remove `readonly`)
- [ ] New handler inside `handleTerminalRoutes` for `PATCH /api/terminals/:id/rename`
- [ ] Name validation: 1-100 chars, control chars stripped (server-side)
- [ ] Session type check: reject non-shell sessions with 403
- [ ] Duplicate name dedup across active sessions: append `-1`, `-2`, etc.
- [ ] Both SQLite and in-memory PtySession label updated
- [ ] Unit tests for rename handler

#### Implementation Details

**ID Lookup Strategy**: The CLI sends `SHELLPER_SESSION_ID` (a stable UUID set at creation). The existing `handleTerminalRoutes` receives IDs from the URL pattern `/api/terminals/:id/*`. The rename handler must:
1. First try to find the PtySession directly by ID (handles non-persistent sessions where `SHELLPER_SESSION_ID` = PtySession ID)
2. If not found, iterate PtySession instances looking for `session.shellperSessionId === id` (handles persistent shellper-backed sessions where the UUID differs from PtySession ID)
3. If still not found, return 404

This avoids adding a new route namespace while correctly supporting both ID types.

**Files to modify:**

1. **`packages/codev/src/terminal/pty-session.ts`** (~line 42)
   - Remove `readonly` from `label` property to make it mutable

2. **`packages/codev/src/agent-farm/servers/tower-routes.ts`** (~line 466-530, inside `handleTerminalRoutes`)
   - Add handler for `req.method === 'PATCH' && subpath === '/rename'`
   - Handler logic:
     1. Parse body with `parseJsonBody(req)` for `name` field
     2. Validate name: strip control chars (`/[\x00-\x1f\x7f]/g`), check 1-100 chars, return 400 if invalid
     3. Look up PtySession by ID (direct match, then shellperSessionId match)
     4. Look up `terminal_sessions` row by PtySession's terminal ID to get `type`
     5. Check `type === 'shell'`, return 403 if not
     6. Check for duplicate names across active shell sessions (current workspace only), dedup with `-N` suffix
     7. Update SQLite label via `updateTerminalLabel()`
     8. Update in-memory `session.label = finalName`
     9. Return `200 { id, name: finalName }`

3. **`packages/codev/src/agent-farm/servers/tower-terminals.ts`**
   - Add `getTerminalSessionByTerminalId(terminalId: string): DbTerminalSession | null` — query `terminal_sessions` by primary key
   - Add `getActiveShellLabels(workspacePath: string): string[]` — query labels of active shell sessions for dedup check
   - Ensure `updateTerminalLabel(terminalId, label)` is present (may already be from Phase 1)

#### Acceptance Criteria
- [ ] `PATCH /api/terminals/:id/rename` with valid name returns 200
- [ ] Non-shell sessions return 403
- [ ] Unknown session IDs return 404
- [ ] Names > 100 chars return 400
- [ ] Empty names return 400
- [ ] Control characters are stripped before storage
- [ ] Duplicate names get `-N` suffix (dedup scoped to active sessions in same workspace)
- [ ] In-memory PtySession label updated
- [ ] SQLite label updated
- [ ] Dashboard state endpoint returns the new name (already fixed in Phase 1)

#### Test Plan
- **Unit Tests**: Name validation logic, control char stripping, dedup suffix logic, type checking, ID lookup (direct vs shellperSessionId)
- **Integration Tests**: Full PATCH request → response → DB verification → dashboard state check
- **Manual Testing**: Rename via curl, verify in dashboard tabs

#### Rollback Strategy
Remove the route handler. No data changes needed — labels in DB are additive.

#### Risks
- **Risk**: Dedup race condition if two renames happen simultaneously
  - **Mitigation**: Last write wins; dedup is checked within the handler synchronously (single-threaded Node.js)

---

### Phase 3: CLI Command and Integration
**Dependencies**: Phase 2

#### Objectives
- Add `af rename <name>` CLI command
- Read `SHELLPER_SESSION_ID` and `TOWER_PORT` from environment
- Call Tower API rename endpoint
- Display result (actual name applied, including dedup info)

#### Deliverables
- [ ] New command file `packages/codev/src/agent-farm/commands/rename.ts`
- [ ] Command registration in `cli.ts`
- [ ] Export from `commands/index.ts`
- [ ] TowerClient `renameTerminal()` method
- [ ] Clear error messages for all failure cases
- [ ] Unit tests for CLI command

#### Implementation Details

**Files to create:**

1. **`packages/codev/src/agent-farm/commands/rename.ts`** (NEW)
   - Read `SHELLPER_SESSION_ID` from env, fail with "Not running inside a shellper session" if missing
   - Read `TOWER_PORT` from env (fall back to default Tower port if missing)
   - Create `TowerClient` with port
   - Call `client.renameTerminal(sessionId, name)`
   - Handle responses:
     - 200: Print `Renamed to: <actual-name>` (shows dedup suffix if applied)
     - 400: Print validation error
     - 403: Print "Cannot rename builder/architect terminals"
     - 404: Print "Session not found — it may have been closed"
     - Connection error: Print "Tower is not running"

**Files to modify:**

2. **`packages/codev/src/agent-farm/cli.ts`** (~line 248, after `open` command)
   - Register `rename` command:
     ```
     program.command('rename <name>')
       .description('Rename the current shell session')
       .action(async (name) => { ... })
     ```

3. **`packages/codev/src/agent-farm/commands/index.ts`**
   - Add `export { rename } from './rename.js'`

4. **`packages/codev/src/agent-farm/lib/tower-client.ts`** (~line 335, after `resizeTerminal`)
   - Add `renameTerminal(sessionId: string, name: string)` method
   - PATCH to `/api/terminals/${sessionId}/rename` with `{ name }` body
   - Return `{ ok: boolean; status: number; data?: { id: string; name: string }; error?: string }`

#### Acceptance Criteria
- [ ] `af rename "test"` works inside a shellper session
- [ ] `af rename "test"` outside shellper prints "Not running inside a shellper session" and exits 1
- [ ] `af rename ""` prints usage error
- [ ] `af rename` with no args prints usage
- [ ] CLI displays actual name (including dedup suffix if applied)
- [ ] Error messages match spec phrasing

#### Test Plan
- **Unit Tests**: Env var detection, TowerClient method, error message formatting
- **Integration Tests**: Full CLI → Tower API → DB round-trip
- **Manual Testing**: Open shell in dashboard, run `af rename "monitoring"`, verify tab updates within ~2.5s

#### Rollback Strategy
Remove command file and registration. No data impact.

#### Risks
- **Risk**: `TOWER_PORT` not set in legacy sessions created before this feature
  - **Mitigation**: Fall back to default Tower port if env var is missing

---

## Dependency Map
```
Phase 1 (DB + Env Vars + State Fix) ──→ Phase 2 (API Endpoint) ──→ Phase 3 (CLI Command)
```

## Integration Points
### Internal Systems
- **Tower API**: New PATCH endpoint inside `handleTerminalRoutes`
- **SQLite**: Migration v11, label storage/queries/reconciliation
- **PtySession**: Label mutation, shellperSessionId lookup
- **TowerClient**: New `renameTerminal()` method
- **Dashboard**: Existing polling reads from `handleWorkspaceState` which now returns session labels

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| PtySession ID mismatch | Low | Medium | Two-step lookup: direct ID then shellperSessionId |
| Migration failure on existing DB | Low | Low | Simple ADD COLUMN is safe in SQLite |
| Dashboard not reflecting changes | Low | Medium | Phase 1 fixes `handleWorkspaceState` to read session.label |
| Labels lost on restart | Low | Medium | Phase 1 fixes reconciliation to use `dbSession.label` |

## Validation Checkpoints
1. **After Phase 1**: Run migration, verify column; create shell, verify env vars; restart Tower, verify labels persist; verify dashboard state uses session.label
2. **After Phase 2**: curl PATCH endpoint, verify DB + in-memory update + dashboard tab name
3. **After Phase 3**: Full `af rename` flow from inside a shell session, end-to-end

## Documentation Updates Required
- [ ] CLI command reference (`codev/resources/commands/agent-farm.md`)

## Expert Consultation

**Date**: 2026-02-21
**Models Consulted**: Gemini Pro, GPT-5.2 Codex, Claude
**Key Feedback**:
- **CRITICAL**: `handleWorkspaceState` hardcodes shell names — must read from `session.label` (Gemini, Claude)
- **CRITICAL**: Route should be inside `handleTerminalRoutes` (line 466), not workspace-scoped (Claude)
- **CRITICAL**: `reconcileTerminalSessions` hardcodes label on reconnection — must use `dbSession.label` (Gemini, Codex)
- **IMPORTANT**: ID lookup needs two-step strategy: PtySession ID direct match, then shellperSessionId match (Gemini, Claude)
- **IMPORTANT**: Dedup scope: active sessions only (Codex)
- **IMPORTANT**: Control char stripping: server-side only (Codex)
- **MINOR**: Fallback path should set `SHELLPER_SESSION_ID` to PtySession ID (Gemini)

**Plan Adjustments**:
- Phase 1 now includes `handleWorkspaceState` fix and reconciliation label loading
- Phase 2 route registration corrected to `handleTerminalRoutes`
- Phase 2 includes two-step ID lookup strategy
- Dedup scoped to active sessions in same workspace
- Validation (control chars) explicitly server-side only
- Non-persistent fallback uses session.id for SHELLPER_SESSION_ID

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete

## Notes

The `af shell --name` bug (name parameter ignored during creation) is a related issue but out of scope for this plan. It can be fixed as a trivial bonus during Phase 1 since `handleWorkspaceShellCreate` is being modified there anyway, but is not a requirement.
