---
approved: 2026-02-14
validated: [architect]
---

# Spec 0106: Rename Shepherd to Shellper

## Problem

The "Shepherd" name for the detached PTY session manager (Spec 0104) is generic and doesn't convey what it does. "Shellper" (shell + helper) is a pun that immediately communicates its purpose: it helps manage shell sessions.

## Goals

1. Rename all references from "Shepherd" to "Shellper" across the codebase
2. Rename all source files from `shepherd-*` to `shellper-*`
3. Rename classes, interfaces, types, and variables accordingly
4. Rename socket files from `shepherd-*.sock` to `shellper-*.sock`
5. Update living documentation (arch.md, skeleton docs, README, code comments)
6. Zero behavior change — pure rename refactoring

## Non-Goals

- Changing any Shellper functionality or architecture
- Modifying the wire protocol or frame types
- Changing the replay buffer or session manager logic
- Adding new features
- Updating historical project documents (0104 specs/plans/reviews/rebuttals are historical records)

## Scope

**Note**: The tables below are illustrative of the key renames. The grep-based acceptance criterion (#1) is the authoritative source of truth — any shepherd reference in source code that is not migration-related must be renamed, even if not explicitly listed here.

### File Renames (source)

All files under `packages/codev/src/terminal/`:

| Current | New |
|---------|-----|
| `shepherd-protocol.ts` | `shellper-protocol.ts` |
| `shepherd-process.ts` | `shellper-process.ts` |
| `shepherd-client.ts` | `shellper-client.ts` |
| `shepherd-main.ts` | `shellper-main.ts` |
| `shepherd-replay-buffer.ts` | `shellper-replay-buffer.ts` |

### Test File Renames

| Current | New |
|---------|-----|
| `__tests__/shepherd-protocol.test.ts` | `__tests__/shellper-protocol.test.ts` |
| `__tests__/shepherd-process.test.ts` | `__tests__/shellper-process.test.ts` |
| `__tests__/shepherd-client.test.ts` | `__tests__/shellper-client.test.ts` |
| `__tests__/session-manager.test.ts` | `__tests__/session-manager.test.ts` (unchanged) |
| `__tests__/tower-shepherd-integration.test.ts` | `__tests__/tower-shellper-integration.test.ts` |

### Class/Interface Renames

| Current | New |
|---------|-----|
| `ShepherdProcess` | `ShellperProcess` |
| `ShepherdClient` | `ShellperClient` |
| `ShepherdReplayBuffer` | `ShellperReplayBuffer` |
| `IShepherdClient` | `IShellperClient` |
| `IShepherdPty` | `IShellperPty` |
| `SessionManager` | `SessionManager` (unchanged — generic enough) |

### Method Renames

| Current | New |
|---------|-----|
| `attachShepherd()` | `attachShellper()` |
| `detachShepherd()` | `detachShellper()` |
| `cleanupShepherd()` | `cleanupShellper()` |

### Variable/Property Renames

| Current | New |
|---------|-----|
| `shepherdManager` | `shellperManager` |
| `shepherdClient` | `shellperClient` |
| `shepherdBacked` | `shellperBacked` |
| `_shepherdBacked` | `_shellperBacked` |
| `shepherdSessionId` | `shellperSessionId` |
| `_shepherdSessionId` | `_shellperSessionId` |
| `shepherdPid` | `shellperPid` |
| `shepherdSocket` | `shellperSocket` |
| `shepherdStartTime` | `shellperStartTime` |
| `shepherdSession` | `shellperSession` |
| `shepherdCreated` | `shellperCreated` |
| `shepherdErr` | `shellperErr` |
| `shepherdInfo` | `shellperInfo` |
| `shepherdScript` | `shellperScript` |
| `shepherd_socket` (SQLite column) | `shellper_socket` |
| `shepherd_pid` (SQLite column) | `shellper_pid` |
| `shepherd_start_time` (SQLite column) | `shellper_start_time` |

### Import Path Updates

Every file importing from `shepherd-*.ts` modules must update its import path:

```typescript
// Old
import { ShepherdClient } from './shepherd-client.js';
import { ShepherdProcess } from './shepherd-process.js';
// New
import { ShellperClient } from './shellper-client.js';
import { ShellperProcess } from './shellper-process.js';
```

Key files requiring import updates:
- `session-manager.ts`
- `pty-session.ts`
- `pty-manager.ts`
- `tower-server.ts`
- All test files that import shepherd modules

### Files with Shepherd References (not renamed, but content updated)

These files are NOT renamed but contain shepherd references that must be updated:

| File | Approx. Refs | Notes |
|------|-------------|-------|
| `terminal/pty-session.ts` | ~49 | Methods, variables, comments, imports |
| `terminal/session-manager.ts` | ~28 | Variable names, imports, socket path pattern |
| `terminal/pty-manager.ts` | ~3 | Method call, comments |
| `agent-farm/servers/tower-server.ts` | ~114 | Variables, DB column refs, comments |
| `agent-farm/db/schema.ts` | ~3 | Column definitions in schema string |
| `agent-farm/db/index.ts` | ~8 | Migration refs (old migrations keep old names) |
| `agent-farm/commands/spawn.ts` | ~1 | Comment |
| `agent-farm/utils/shell.ts` | ~1 | Comment |
| `agent-farm/__tests__/terminal-sessions.test.ts` | ~28 | Schema, test data, assertions |
| `terminal/__tests__/session-manager.test.ts` | ~115 | Variables, mock names, assertions |
| Dashboard components (`App.tsx`, `Terminal.tsx`) | ~3 | Comments referencing Spec 0104 |

### Socket Path Rename

| Current | New |
|---------|-----|
| `~/.codev/run/shepherd-*.sock` | `~/.codev/run/shellper-*.sock` |

### SQLite Migration

A new migration (v8) must use the **table-rebuild pattern** (consistent with v7) to rename columns:

1. **Rebuild the `terminal_sessions` table** with new column names:
   - Create `terminal_sessions_new` with `shellper_socket`, `shellper_pid`, `shellper_start_time`
   - INSERT from old table, mapping `shepherd_*` → `shellper_*` columns
   - DROP old table, RENAME new table
   - Recreate indexes

2. **Update stored socket path values** in the same migration:
   ```sql
   UPDATE terminal_sessions SET shellper_socket = REPLACE(shellper_socket, 'shepherd-', 'shellper-');
   ```

3. **Rename physical socket files on disk** in the same migration function (after DB changes):
   - Scan `~/.codev/run/` for `shepherd-*.sock` files
   - Rename each to `shellper-*.sock`
   - Skip any file that cannot be renamed (file missing, permissions, etc.)

**Fresh install handling**: The migration system marks all migrations as done on fresh installs (they get current schema from GLOBAL_SCHEMA). Migration v8 is a no-op for fresh installs — they already have `shellper_*` columns from the updated GLOBAL_SCHEMA.

**Old migration code** (v6/v7) that references `shepherd_*` column names must remain as-is — those migrations ran against the old schema and are historically correct. The grep exclusion in AC #1 covers this.

### Session Continuity

**Clean break is acceptable.** This is a development tool where sessions are ephemeral. The migration:
- Rebuilds the table with new column names and updates stored path values
- Renames socket files on disk where they exist
- Silently skips any socket files that cannot be renamed

No dual-path fallback logic or backward-compatibility shims are needed. Sessions connected to old sockets will naturally disconnect on upgrade; users restart them.

### Documentation Updates

**Living docs to update:**
- `codev/resources/arch.md` — glossary, architecture sections, debugging commands
- `codev-skeleton/resources/commands/agent-farm.md` — command references
- `codev-skeleton/protocols/maintain/protocol.md` — protocol references
- `README.md`, `INSTALL.md`, `MIGRATION-1.0.md` — brief references
- Code comments throughout source and test files

**Historical docs to leave unchanged:**
- `codev/specs/0104-custom-session-manager.md` — historical spec
- `codev/plans/0104-custom-session-manager.md` — historical plan
- `codev/reviews/0104-custom-session-manager.md` — historical review
- `codev/projects/0104-*/` — all project work artifacts (rebuttals, context files)
- `codev/projectlist.md` — project 0104 entry uses Shepherd as historical name

These are historical records that document what was built at the time. Renaming them would obscure the project history.

### Schema Definition

The `GLOBAL_SCHEMA` string in `agent-farm/db/schema.ts` must be updated to use the new column names (`shellper_socket`, `shellper_pid`, `shellper_start_time`). This is NOT migration code — it's the current schema definition and must reflect the new names.

## Acceptance Criteria

1. `grep -ri shepherd packages/codev/src/` returns zero hits, excluding:
   - Old migration code in `db/index.ts` that references previous column names
   - The `dist/` directory (regenerated by build)
2. All existing tests pass with new names
3. `npm run build` succeeds
4. Socket files are created with `shellper-*` prefix
5. SQLite migration (v8) handles column rename and stored value update cleanly
6. Living documentation is updated (arch.md, skeleton docs, README)
