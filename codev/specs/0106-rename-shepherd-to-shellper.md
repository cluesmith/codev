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
5. Update documentation (arch.md, CLAUDE.md, AGENTS.md, comments)
6. Zero behavior change — pure rename refactoring

## Non-Goals

- Changing any Shellper functionality or architecture
- Modifying the wire protocol or frame types
- Changing the replay buffer or session manager logic
- Adding new features

## Scope

### File Renames

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

### Variable/Column Renames

| Current | New |
|---------|-----|
| `shepherdManager` | `shellperManager` |
| `shepherdClient` | `shellperClient` |
| `shepherdBacked` | `shellperBacked` |
| `shepherdSessionId` | `shellperSessionId` |
| `shepherdPid` | `shellperPid` |
| `shepherd_socket` (SQLite) | `shellper_socket` |
| `shepherd_pid` (SQLite) | `shellper_pid` |
| `shepherd_start_time` (SQLite) | `shellper_start_time` |
| `shepherdScript` (config) | `shellperScript` |
| `shepherdInfo` | `shellperInfo` |

### Socket Path Rename

| Current | New |
|---------|-----|
| `~/.codev/run/shepherd-*.sock` | `~/.codev/run/shellper-*.sock` |

### SQLite Migration

A new migration (v8) must rename the columns:
- `shepherd_socket` → `shellper_socket`
- `shepherd_pid` → `shellper_pid`
- `shepherd_start_time` → `shellper_start_time`

### Documentation Updates

- `codev/resources/arch.md` — all Shepherd references
- `CLAUDE.md` / `AGENTS.md` — glossary, debugging commands
- Memory files in `.claude/` — update references
- Code comments throughout

## Acceptance Criteria

1. `grep -ri shepherd packages/codev/src/` returns zero hits (excluding migration code which references old column names)
2. All existing tests pass with new names
3. `npm run build` succeeds
4. Socket files are created with `shellper-*` prefix
5. SQLite migration handles column rename cleanly
6. Existing sessions survive the rename (migration + socket rename)
