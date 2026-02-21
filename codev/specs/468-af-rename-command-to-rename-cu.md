# Specification: af rename Command

## Metadata
- **ID**: spec-2026-02-21-af-rename
- **Status**: draft
- **Created**: 2026-02-21

## Clarifying Questions Asked

1. **Q: Should `af rename` only work for utility shells, or also for builder/architect terminals?**
   A: **Utility shells only.** Builder and architect terminals have consistent naming that other functionality depends on. The API endpoint should reject rename requests for non-shell sessions with a clear error.

2. **Q: Should the rename persist across Tower restarts?**
   A: Yes. The label should be stored in SQLite so it survives restarts. Currently labels are only in memory.

3. **Q: Should the command validate the new name (length limits, character restrictions)?**
   A: Non-empty, max 100 characters. Reject (not truncate) names that exceed the limit. Strip control characters (newlines, tabs) to prevent UI rendering issues.

4. **Q: Are duplicate labels allowed?**
   A: No. If a name is already in use by another session, auto-deduplicate by appending a suffix (e.g., `monitoring` → `monitoring-1`, `monitoring-2`). The API returns the actual name used so the user knows what was applied.

## Problem Statement

All shellper-managed shell sessions default to generic names like "Shell 1", "Shell 2". When users have multiple shells open for different purposes (debugging, building, monitoring, testing), it's hard to tell them apart in the dashboard tab bar. There is no way to rename a shell session from within that session.

## Current State

- Shell sessions are created with auto-generated names: `Shell ${shellId.replace('shell-', '')}` (in `tower-routes.ts`)
- The codebase sets **both** `label` and `name` fields when creating shell sessions — the dashboard reads `name` for tab titles
- The PTY session label is set at creation and stored as a readonly property in memory
- The `terminal_sessions` SQLite table has no `label` column — labels exist only in the PtySession object
- There is no API endpoint to update a terminal's label after creation
- There is no `SHELLPER_SESSION_ID` environment variable set inside shell sessions, so a shell cannot identify itself
- The `af shell --name` flag is accepted but the name is ignored — `handleWorkspaceShellCreate` hardcodes `Shell N`
- The only way to know which shell is which is by remembering the order they were opened

## Desired State

- Users can run `af rename "descriptive name"` from inside a utility shell session
- The command detects which session it's running in via `SHELLPER_SESSION_ID` environment variable
- Tower also injects `TOWER_PORT` so the CLI knows which Tower instance to contact
- The name updates in Tower's in-memory state and in SQLite (source of truth)
- Both `label` and `name` fields are updated to keep them in sync
- The dashboard tab title reflects the new name on next poll cycle (~2.5s)
- Running `af rename` outside a shellper session produces a clear error message
- Labels persist across Tower restarts via SQLite storage
- Existing sessions created before the migration work correctly (null label treated as current default)
- Duplicate names are auto-deduplicated (e.g., `monitoring` → `monitoring-1`)
- Renaming is restricted to utility shell sessions; builder/architect terminals are rejected

## Stakeholders
- **Primary Users**: Developers using Agent Farm with multiple shell sessions
- **Secondary Users**: Architects monitoring builder activity in the dashboard
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] `af rename "name"` updates the current shell's name when run inside a utility shell session
- [ ] `af rename` in a builder/architect terminal produces error: "Cannot rename builder/architect terminals"
- [ ] Duplicate names are auto-deduplicated with `-N` suffix and CLI shows the actual name applied
- [ ] Running `af rename` outside a shellper session produces a clear error: "Not running inside a shellper session"
- [ ] `SHELLPER_SESSION_ID` and `TOWER_PORT` environment variables are set in all new shellper sessions
- [ ] The dashboard tab title updates to show the new name
- [ ] Labels persist in SQLite and survive Tower restarts
- [ ] `af rename` with no argument or empty string produces a usage error
- [ ] Names exceeding 100 characters are rejected with an error
- [ ] Control characters in names are stripped
- [ ] Stale/closed session IDs return a clear "Session not found" error
- [ ] >90% test coverage on new code introduced by this feature

## Constraints

### Technical Constraints
- Must work within the existing Commander.js CLI pattern used by all af commands
- Must use the Tower HTTP API for communication (CLI → Tower)
- PTY session label is currently readonly — must be made mutable or use a separate storage mechanism
- Environment variables must be set during session creation in shellper/Tower code
- SQLite migration needed to add label storage to `terminal_sessions` table
- The `SHELLPER_SESSION_ID` is a stable UUID from session creation; PtySession IDs (`term-xxxx`) are ephemeral and recreated on Tower restart — the API must look up terminals by session ID from the `terminal_sessions` table, not by PtySession ID

### Business Constraints
- Small feature — should not require changes to the dashboard frontend beyond what the existing polling/state mechanism provides

## Assumptions
- The `SHELLPER_SESSION_ID` environment variable can be reliably injected into the shell environment at session creation time
- The Tower API is accessible from within shellper sessions (localhost HTTP)
- Dashboard already re-renders tab titles when terminal data changes from the API

## Solution Approaches

### Approach 1: Environment Variable + Tower API (Approved)

**Description**: Set `SHELLPER_SESSION_ID` and `TOWER_PORT` in the shell environment at session creation. The `af rename` command reads these variables, calls a new Tower API endpoint (`PATCH /api/terminals/:id/rename`), which updates both in-memory state and SQLite.

**API Contract**:
- **Request**: `PATCH /api/terminals/:sessionId/rename`
  - Header: `codev-web-key: <local-key>` (existing auth)
  - Body: `{ "name": "new display name" }`
  - `:sessionId` is the `SHELLPER_SESSION_ID` (stable UUID from `terminal_sessions.id`)
- **Response (success)**: `200 { "id": "session-uuid", "name": "new display name" }` — name may differ from request if deduplicated
- **Response (not found)**: `404 { "error": "Session not found" }` — session ID doesn't exist or was closed
- **Response (forbidden)**: `403 { "error": "Cannot rename builder/architect terminals" }` — only shell-type sessions can be renamed
- **Response (validation)**: `400 { "error": "Name must be 1-100 characters" }`

**Source of Truth**: SQLite `terminal_sessions.label` column is the persistent source of truth. On Tower startup, labels are loaded from SQLite. In-memory PtySession labels are synced from SQLite. The rename operation writes to both SQLite and in-memory state atomically.

**Concurrency**: Last write wins. No locking needed — label updates are idempotent display-only changes.

**Pros**:
- Clean, simple detection mechanism
- Follows existing af command patterns (CLI → Tower API)
- Label stored in SQLite for persistence
- Dashboard gets updated data via existing polling
- `TOWER_PORT` handles custom port configurations

**Cons**:
- Requires adding env vars to session creation (minor change)
- Requires SQLite migration for label column

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: TTY/PID Matching

**Description**: Instead of an environment variable, detect which session the command is running in by matching the current terminal's TTY or PID against known sessions in Tower.

**Pros**:
- No environment variable needed
- Works retroactively for existing sessions

**Cons**:
- TTY matching is unreliable across platforms (macOS vs Linux)
- PID matching is complex with nested shell processes
- More fragile than a simple environment variable
- Harder to test

**Estimated Complexity**: Medium
**Risk Level**: Medium

## Open Questions

### Critical (Blocks Progress)
- [x] Detection mechanism: Environment variable vs TTY matching → **Resolved: Environment variable (Approach 1)**

### Important (Affects Design)
- [x] Should label storage be in `terminal_sessions` (global.db) or `utils` table (state.db)? → **Resolved: `terminal_sessions` in global.db — it's the canonical terminal registry**
- [x] `label` vs `name` — which field does the dashboard render? → **Resolved: Dashboard reads `name`. Rename updates both `label` and `name` to keep them in sync.**
- [x] Truncate or reject long names? → **Resolved: Reject with error message. Silent truncation is surprising.**
- [x] Authorization scope? → **Resolved: Any authenticated caller can rename any session. Tower auth is local-only (codev-web-key) and not scoped per-session.**

### Nice-to-Know (Optimization)
- [ ] Should we also support renaming from the dashboard UI? → Out of scope for this spec; can be added later
- [ ] Should `af shell --name` bug be fixed? → Related but separate; note it as a bonus fix if trivial

## Performance Requirements
- **Response Time**: < 500ms for the rename command round-trip
- **Dashboard Update**: Label visible within one poll cycle (~2.5s)

## Security Considerations
- The Tower API endpoint must require the existing `codev-web-key` authentication header
- The `af rename` command uses the existing TowerClient which handles auth automatically
- No new attack surface — reuses existing authenticated API pattern
- Input validation strips control characters (newlines, tabs, etc.) to prevent UI rendering issues

## Test Scenarios

### Functional Tests
1. **Happy path**: Run `af rename "build testing"` inside a shellper session → name updates in Tower and SQLite
2. **Not in shellper**: Run `af rename "test"` outside shellper → error message "Not running inside a shellper session", exit code 1
3. **Empty name**: Run `af rename ""` → usage error
4. **No argument**: Run `af rename` → usage error
5. **Long name**: Run `af rename` with 101+ char name → rejected with error "Name must be 1-100 characters"
6. **Special characters**: Run `af rename "debug (prod) — monitoring"` → works correctly
7. **Control characters**: Run `af rename "test\ninjection"` → control chars stripped, name stored as "testinjection"
8. **Stale session**: Rename with a `SHELLPER_SESSION_ID` that doesn't exist in Tower → "Session not found" error
9. **Multiple renames**: Rename same session twice → second name overwrites first
10. **Builder/architect terminal**: Run `af rename "test"` in builder terminal → error "Cannot rename builder/architect terminals"
11. **Duplicate name**: Rename to a name already used by another session → auto-dedup to `name-1`, CLI shows "Renamed to: name-1"

### Non-Functional Tests
1. **Persistence**: Rename, restart Tower, verify label persists from SQLite
2. **API auth**: Verify PATCH endpoint rejects unauthenticated requests
3. **Migration**: Existing sessions without label column → function correctly with null label (default behavior preserved)

## Dependencies
- **Internal Systems**: Tower API, shellper session management, SQLite database, TowerClient
- **Libraries/Frameworks**: Commander.js (existing), better-sqlite3 (existing)

## References
- GitHub Issue #468
- Spec 0112 (Workspace Rename) — similar rename pattern for workspace names
- Spec 0104 (Custom Session Manager) — session management architecture

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Env var not inherited in nested shells | Low | Medium | Test with common shell configurations (bash, zsh) |
| Dashboard doesn't reflect rename | Low | Medium | Verify existing polling picks up label changes; add WebSocket broadcast if needed |
| Migration breaks existing sessions | Low | Low | Migration adds nullable column; null treated as "use default name" |
| Session ID mismatch after Tower restart | Low | Medium | Look up terminals via `terminal_sessions.id` (stable), not ephemeral PtySession ID |

## Expert Consultation

**Date**: 2026-02-21
**Models Consulted**: Gemini Pro, GPT-5.2 Codex, Claude
**Sections Updated**:
- **Current State**: Added `label` vs `name` dual-field issue and `af shell --name` bug (Claude, Gemini)
- **Desired State**: Added `TOWER_PORT` env var, `label`/`name` sync, migration handling (Gemini, Claude)
- **Solution Approaches**: Added full API contract, source of truth clarification, concurrency policy (Codex)
- **Constraints**: Added ID mapping clarification — stable UUID vs ephemeral PtySession ID (Gemini)
- **Open Questions**: Resolved `label` vs `name`, truncate vs reject, authorization scope (Claude, Codex)
- **Security**: Added control character stripping for input validation (Codex)
- **Test Scenarios**: Added control characters, stale session, multiple renames, migration tests (Codex, Claude)
- **Performance**: Fixed dashboard update timing from 2s to ~2.5s (Claude)
- **Success Criteria**: Scoped coverage to new code, added validation criteria (Claude, Codex)

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete

## Notes

The `SHELLPER_SESSION_ID` environment variable is also useful for other future features (e.g., session-aware logging, session context in prompts). Setting it is a small investment with broad utility.

The `TOWER_PORT` environment variable similarly enables future CLI commands that need to communicate with Tower from within a shell session.
