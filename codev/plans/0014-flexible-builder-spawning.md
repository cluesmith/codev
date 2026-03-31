# Plan: Flexible Builder Spawning

## Metadata
- **Spec**: codev/specs/0014-flexible-builder-spawning.md
- **Protocol**: TICK
- **Created**: 2025-12-04

## Summary

Extend `afx spawn` to support four modes: spec, task, protocol, and shell. Each mode uses explicit flags (no positional args). IDs use short 4-char alphanumeric suffixes.

## Implementation Phases

### Phase 1: Core Infrastructure

**Files to modify:**
- `agent-farm/src/commands/spawn.ts` - Add new flags and mode detection
- `agent-farm/src/lib/state.ts` - Add `type` field to Builder interface

**Tasks:**
1. Add CLI flags: `--task`, `--protocol`, `--shell`, `--files`
2. Add mutual exclusivity validation
3. Add `type: 'spec' | 'task' | 'protocol' | 'shell'` to Builder interface
4. Add `generateShortId()` function (4-char alphanumeric)

### Phase 2: Mode Implementations

**Task Mode (`--task`)**
1. Generate ID: `task-{rand4}`
2. Create branch: `builder/task-{rand4}`
3. Create worktree at `.builders/task-{rand4}`
4. Build prompt from task text + optional `--files` context
5. Load `codev/roles/builder.md` as role
6. Spawn ttyd/tmux session

**Protocol Mode (`--protocol`)**
1. Validate protocol exists in `codev/protocols/{name}/`
2. Generate ID: `{name}-{rand4}` (e.g., `cleanup-b4c1`)
3. Create branch: `builder/{name}-{rand4}`
4. Create worktree
5. Build prompt: "You are running the {name} protocol. Start by reading codev/protocols/{name}/protocol.md"
6. Load role: `codev/protocols/{name}/role.md` → fallback to `codev/roles/builder.md`
7. Spawn ttyd/tmux session

**Shell Mode (`--shell`)**
1. Generate ID: `shell-{rand4}`
2. NO worktree, NO branch (just a Claude session)
3. NO initial prompt (interactive)
4. NO role (unless `--role` specified)
5. Spawn ttyd/tmux session only

### Phase 3: Cleanup & Polish

1. Update `afx spawn --help` with all modes and examples
2. Update `afx status` to show builder types
3. Update dashboard to group/display by type
4. Handle error cases with clear messages

## File Changes

| File | Changes |
|------|---------|
| `agent-farm/src/commands/spawn.ts` | Add flags, mode detection, mode implementations |
| `agent-farm/src/lib/state.ts` | Add `type` to Builder interface |
| `agent-farm/src/lib/utils.ts` | Add `generateShortId()` |
| `agent-farm/src/commands/status.ts` | Display builder type |

## ID Generation

```typescript
function generateShortId(): string {
  // Generate random number 0 to 2^24-1, base64 encode to 4 chars
  const num = Math.floor(Math.random() * 0xFFFFFF);
  const bytes = new Uint8Array([num >> 16, (num >> 8) & 0xFF, num & 0xFF]);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 4);
}
```

## CLI Examples

```bash
# Spec mode (existing)
afx spawn -p 0009

# Task mode
afx spawn --task "Fix the login bug"
afx spawn --task "Refactor auth" --files src/auth.ts,src/login.ts

# Protocol mode
afx spawn --protocol cleanup
afx spawn --protocol experiment

# Shell mode
afx spawn --shell
```

## Validation

```typescript
function validateSpawnFlags(opts: SpawnOptions): void {
  const modes = [opts.project, opts.task, opts.protocol, opts.shell].filter(Boolean);
  if (modes.length === 0) {
    throw new Error('Must specify one of: --project, --task, --protocol, --shell');
  }
  if (modes.length > 1) {
    throw new Error('Flags --project, --task, --protocol, --shell are mutually exclusive');
  }
  if (opts.files && !opts.task) {
    throw new Error('--files requires --task');
  }
}
```

## Test Plan

1. `afx spawn -p 0009` - backward compat ✓
2. `afx spawn --task "Fix bug"` - creates task-xxxx builder
3. `afx spawn --task "Fix" --files a.ts` - includes file context
4. `afx spawn --protocol cleanup` - loads cleanup protocol
5. `afx spawn --shell` - bare session, no worktree
6. `afx spawn` - error with available modes
7. `afx spawn -p 0009 --shell` - mutual exclusivity error
8. Same task twice → different IDs

## Dependencies

- Existing spawn infrastructure (git worktrees, tmux, ttyd)
- Commander.js for CLI parsing

## Risks

- Breaking `--project` mode → mitigate with tests
- Shell mode cleanup (no worktree to track) → track in state.json by ID
