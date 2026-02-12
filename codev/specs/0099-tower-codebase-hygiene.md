---
approved: 2026-02-11
validated: [gemini, codex, claude]
---

# Spec 0099: Tower Codebase Hygiene

## Summary

Address non-port codebase inconsistencies identified by a Codex survey. Covers dead code removal, naming drift, state management bypasses, CLI consolidation onto TowerClient, error handling gaps, and duplicate code elimination.

Port-related cleanup is handled by Spec 0098. This spec covers everything else.

## Problem

After the Tower Single Daemon migration (Spec 0090), multiple layers of the codebase still reference deleted architecture, bypass the intended state model, duplicate logic, and swallow errors. This creates a maintenance burden and causes real bugs (broken orphan detection, lost file tabs on restart, misleading error messages).

## Changes

### Phase 1: Dead Code Removal

1. **Delete `utils/orphan-handler.ts`** — No runtime imports anywhere. Its tmux patterns (`af-architect-${architectPort}`) don't match modern session names (`architect-{basename}`). The entire module is dead.

2. **Remove `state.json` deletion from Tower** — `tower-server.ts:1486-1497` still deletes `.agent-farm/state.json` on project launch. SQLite migration is complete; this is vestigial.

3. **Remove `dashboard-server.js` process scanning from `stop.ts`** — `stop.ts:54-102` pattern-matches `dashboard-server.js` which doesn't exist. Remove this dead scanning code. Note: `stop.ts` runs when shutting down the entire stack, so it cannot rely on Tower API calls (Tower may already be stopping). Terminal cleanup during stop should use direct tmux/process cleanup, not Tower API. Tower's own shutdown handler already cleans up its node-pty terminals.

4. **Remove Builder `port`/`pid` fields** — `startBuilderSession` always returns `{ port: 0, pid: 0 }`. Remove `port` and `pid` from the `Builder` and `UtilTerminal` interfaces in `types.ts`. Also update `Annotation` and `ArchitectState` interfaces which carry `port`/`pid`. Update `startBuilderSession` return type. Update all consumers (`cleanup.ts`, `attach.ts`, `status.ts`, `spawn.ts`) to use `terminalId` instead. Remove PID-based kill logic in cleanup/stop — use Tower terminal deletion. Note: the SQLite `builders` table schema may need column adjustments; verify and update as needed.

### Phase 2: Naming & Terminology Fix

1. **Align tmux session naming** — `af architect` (`architect.ts:16`) creates `af-architect`. Tower creates `architect-{basename}`. Standardize on Tower's convention (`architect-{basename}`) everywhere. Migration: existing sessions with the old name won't be found after upgrade. Users must restart their architect session. No backward-compat shim — the old name was only used by the legacy `af architect` path which is being updated.

2. **Update user-facing messages** — Replace all "Start with: af dash start" with "Start with: af tower start" in:
   - `consult.ts:28`
   - `status.ts:73`
   - `commands/adopt.ts:231`
   - `commands/init.ts:197`

3. **Fix stale docstrings** — `server-utils.ts:3` references "dashboard-server.ts". Remove the duplicate "React dashboard dist path" comment in `tower-server.ts:1745-1746`.

### Phase 3: CLI Consolidation onto TowerClient

1. **Fix `consult.ts` Tower dependency** — `consult.ts` currently does a raw fetch to `localhost:${dashboardPort}/api/tabs/shell`. Keep `consult` as a standalone CLI tool that works with or without Tower. Remove the raw fetch to the dashboard port entirely — `consult` should just spawn its process directly without opening a Tower shell tab. If Tower is running, the shell tab is a nice-to-have but not required for consult to function.

2. **Route `shell.ts` and `open.ts` through TowerClient** — Both reimplement `encodeProjectPath` and Tower URL construction. Use `TowerClient`'s existing `encodeProjectPath()` export and `getProjectUrl()` method, which include proper auth headers (`codev-web-key`).

3. **Fix `attach.ts`** — Remove `http://localhost:${builder.port}` URL construction. Use `TowerClient.getProjectUrl()` (already exists) to generate the correct Tower dashboard URL.

4. **Fix `getGateStatusForProject()`** — `tower-server.ts:1051-1056` fetches `localhost:${basePort}/api/status` (dead port). Decision: query Tower's own in-memory state directly. Tower already tracks project terminals and can read porch status files (`codev/projects/<id>/status.yaml`) from the project path. Replace the dead HTTP fetch with a direct file read of the porch status YAML.

5. **Remove `af start --remote`** — `start.ts:200-268` implements remote orchestration over SSH. Remove the `--remote` flag and all associated code. Users who want remote access should run a Tower server on the remote host directly. This eliminates a complex, under-tested code path.

### Phase 4: State Management Fixes

1. **Persist file tabs to SQLite** — `POST /api/tabs/file` currently stores tabs only in the in-memory `fileTabs` Map. Add a `file_tabs` table to SQLite so they survive Tower restarts. Schema: `file_tabs(id TEXT PRIMARY KEY, project_path TEXT NOT NULL, file_path TEXT NOT NULL, created_at INTEGER NOT NULL)`. On Tower startup, load persisted tabs into the in-memory `fileTabs` Map for each known project. On tab create/delete, write through to SQLite. No migration needed — this is a new table added via `CREATE TABLE IF NOT EXISTS`.

2. **Document the tmux/SQLite relationship** — `reconcileTerminalSessions()` uses tmux as source of truth for *existence* and SQLite for *metadata*. This is intentional (tmux processes survive Tower restarts, SQLite rows don't track process liveness). Add a clear comment block explaining this dual-source strategy rather than claiming "SQLite is authoritative" when it isn't for liveness.

### Phase 5: Error Handling & Dedup

1. **Add error logging to `notifications.ts`** — `notifications.ts:82-101` silently swallows all `/api/notify` errors. Log non-200 responses at warn level.

2. **Improve `shell.ts` error handling** — Currently all errors become "Tower is not running". Log the actual error and differentiate connection failures from server errors.

3. **Deduplicate `architect.ts`** — Extract shared logic from `createAndAttach` and `createLayoutAndAttach` into a private helper within `architect.ts` itself. The two functions are ~80 lines each with only the tmux pane layout differing.

4. **Deduplicate `getSessionName`** — Exists in both `spawn.ts:189` and `cleanup.ts:42`. Extract to `utils/session.ts` (new file) and import from both locations.

5. **Improve Tower error handling and logging** — Tower server (`tower-server.ts`) has inconsistent error handling: some routes swallow errors silently, others return bare strings. Standardize error responses to include structured JSON (`{ error: string }`) and add `console.error` logging for unexpected failures in route handlers. Focus on the activation, terminal creation, and file tab API routes.

## Out of Scope

- Port registry removal (Spec 0098)
- Cloud Tower (Spec 0097)
- Adding new features to TowerClient
- Spec 0098 merge conflict resolution (0098 should land first if possible; otherwise resolve conflicts at merge time)

## Acceptance Criteria

1. `orphan-handler.ts` deleted
2. All user-facing messages reference Tower, not dashboard-server
3. `shell.ts`, `open.ts` use TowerClient (with auth headers); `consult.ts` works standalone without Tower dependency
4. `attach.ts` generates correct Tower URLs
5. File tabs survive Tower restart (persisted to SQLite via `file_tabs` table)
6. No duplicate `getSessionName` or `encodeProjectPath` implementations
7. All existing tests pass (updated as needed); new tests for file tab persistence
8. Builder/UtilTerminal types no longer carry `port`/`pid` fields
9. `getGateStatusForProject()` reads porch status from filesystem, not dead HTTP port
10. `--remote` flag removed from `af start`
11. Tower error responses are structured JSON with `console.error` logging

## Consultation Log

### Iteration 1 (Gemini, Codex, Claude)

**Key feedback addressed:**

- **Gemini**: Resolve `getGateStatusForProject()` either/or → decided: query Tower's own state via porch YAML files. Add tests for file tab persistence. Note tmux naming transition.
- **Codex**: Add SQLite schema for file tabs (`file_tabs` table). Clarify TowerClient method availability. Resolve gate status ambiguity. Clarify `af start --remote` approach (SSH + command fix). Specify dedup destination modules.
- **Claude**: Clarify `stop.ts` ordering (can't call Tower API during shutdown). Note `startBuilderSession` return type needs updating. Note potential Spec 0098 conflicts. Acknowledge file tab persistence is a small feature within hygiene scope.

All feedback incorporated into spec body above.
