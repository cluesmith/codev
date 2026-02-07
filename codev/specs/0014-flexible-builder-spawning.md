# Specification: Flexible Builder Spawning

## Metadata
- **ID**: 0014-flexible-builder-spawning
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-03
- **Priority**: high

## Problem Statement

Currently, `af spawn` is tightly coupled to project specs. It requires `--project XXXX` and expects a spec file at `codev/specs/XXXX-*.md`. This limits flexibility in several ways:
<!-- REVIEW(@architect): this is a test. -->

1. **Ad-hoc tasks**: Users can't spawn a builder for quick tasks without first creating a spec file
2. **Protocol invocation**: Users can't run a protocol (like CLEANUP) directly via spawn
3. **Exploratory sessions**: Users can't spawn a "blank" Claude session for investigation

The Architect should be able to delegate any work to a Builder, not just spec-defined projects.

## Current State

```bash
# This works (spec-based)
af spawn --project 0009

# These don't work
af spawn "Fix the bug in auth.ts"           # Natural language task
af spawn --protocol cleanup                  # Protocol invocation
af spawn                                     # Blank session
```

The current spawn implementation:
1. Requires `--project` flag
2. Searches for spec file matching project ID
3. Creates branch named `builder/XXXX-spec-name`
4. Creates worktree at `.builders/XXXX`
5. Starts Claude with prompt: "Implement the feature specified in codev/specs/..."

## Desired State

The `af spawn` command becomes flexible, supporting multiple invocation modes with explicit flags (no positional arguments):

```bash
# Mode 1: Spec-based (existing behavior)
af spawn --project 0009                      # Spawn builder for spec
af spawn -p 0009                             # Short form

# Mode 2: Natural language task
af spawn --task "Fix the authentication bug"
af spawn --task "Fix auth bug" --files src/auth.ts,src/login.ts  # With context

# Mode 3: Protocol invocation
af spawn --protocol cleanup                  # Run cleanup protocol

# Mode 4: Shell session (not a builder - just a Claude shell)
af spawn --shell                             # Just a Claude session, no prompt
```

## Stakeholders
- **Primary Users**: Architects using agent-farm to delegate work
- **Secondary Users**: Solo developers using builders for parallel work
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria

- [ ] `af spawn --task "task"` starts a builder with the task as initial prompt
- [ ] `af spawn --task "task" --files a.ts,b.ts` provides file context to the builder
- [ ] `af spawn --protocol NAME` starts a builder with protocol role loaded
- [ ] `af spawn --shell` starts a bare Claude session (not a builder)
- [ ] `af spawn --project XXXX` continues to work as before (backward compatible)
- [ ] All modes create proper worktrees and tmux sessions
- [ ] IDs are short (4-char alphanumeric) and unique
- [ ] Builder state includes `type` field for UI grouping
- [ ] Dashboard correctly displays and groups all builder types
- [ ] `af spawn --help` documents all modes with examples
- [ ] Tests pass for all spawn modes
- [ ] CLI validates mutually exclusive flags and provides clear error messages

## Constraints

### Technical Constraints
- Must maintain backward compatibility with `--project` flag
- Must work with existing worktree and tmux infrastructure
- Builder IDs must be unique and filesystem-safe
- Must integrate with existing dashboard API

### Business Constraints
- Should be intuitive for Architect users
- Should not require changes to the Builder role definition

## Assumptions

- Protocols are defined in `codev/protocols/*/protocol.md`
- A "blank" session is useful for exploration/debugging
- Natural language tasks don't need spec files
- Branch naming can follow different conventions per mode

## Solution Approaches

### Approach 1: Mode-based Spawning

**Description**: Detect spawn mode from arguments and execute mode-specific logic.

```typescript
interface SpawnOptions {
  // Existing
  project?: string;
  noRole?: boolean;

  // New - mutually exclusive modes
  task?: string;           // Natural language task (--task)
  protocol?: string;       // Protocol to invoke (--protocol)
  shell?: boolean;         // Bare session (--shell)

  // Task mode options
  files?: string[];        // Context files for task mode (--files)
}
```

**Mode detection logic**:
1. If `--project`, use spec-based mode
2. If `--task`, use task mode
3. If `--protocol`, use protocol mode
4. If `--shell`, use shell mode
5. If nothing, error with available modes

**Pros**:
- Clear separation of modes
- Easy to extend with new modes
- Backward compatible

**Cons**:
- More complex argument parsing
- Need to validate mutual exclusivity

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Unified Task Model

**Description**: Treat everything as a "task" with different sources.

```typescript
interface Task {
  type: 'spec' | 'adhoc' | 'protocol' | 'shell';
  source?: string;        // Spec file, protocol name, or task text
  options?: Record<string, string>;
}
```

All modes resolve to a Task, then a single spawn path executes it.

**Pros**:
- Simpler mental model
- Single code path for spawning

**Cons**:
- Task abstraction may be overfit
- May conflate different concerns

**Estimated Complexity**: Medium
**Risk Level**: Medium

### Recommended Approach

**Approach 1** (Mode-based Spawning) is recommended because:
- Clearer separation of concerns
- Easier to maintain and extend
- More explicit about what each mode does

## Technical Design

### Architecture: Mode-based CLI, Unified Internal Model

The CLI uses mode-based parsing (clearer UX), but internally normalizes to a unified `BuilderConfig` that the spawn logic consumes. This avoids duplicating git/tmux/ttyd logic across modes.

```typescript
interface BuilderConfig {
  type: 'spec' | 'task' | 'protocol' | 'shell';
  id: string;           // Unique builder ID
  branch?: string;      // Git branch name (null for shell)
  worktree?: string;    // Worktree path (null for shell)
  prompt?: string;      // Initial prompt (null for shell mode)
  role?: string;        // Role file path
  contextFiles?: string[]; // Files to mention in prompt (task mode)
}
```

### ID Generation (Short, Collision-Safe)

All IDs use 4-character alphanumeric suffixes for brevity and uniqueness:

| Mode | ID Format | Branch Name | Example |
|------|-----------|-------------|---------|
| Spec | Project ID | `builder/{id}-{spec-name}` | `builder/0009-terminal-click` |
| Task | `task-{rand4}` | `builder/task-{rand4}` | `builder/task-x9k2` |
| Protocol | `{name}-{rand4}` | `builder/{name}-{rand4}` | `builder/cleanup-b4c1` |
| Shell | `shell-{rand4}` | n/a (no worktree) | `shell-5gt3` |

**Notes:**
- `{rand4}` = 4-char random alphanumeric (a-z, 0-9)
- Spec mode retains existing behavior (project ID is already unique)
- Shell sessions don't create worktrees or branches - just tmux sessions

### Prompt Construction

| Mode | Initial Prompt |
|------|---------------|
| Spec | "Implement the feature specified in {spec}. Follow the plan in {plan}." |
| Task | "{user's task text}\n\nRelevant files: {contextFiles}" (if provided) |
| Protocol | "You are running the {protocol} protocol. Start by reading codev/protocols/{name}/protocol.md" |
| Shell | (no prompt - interactive session) |

### Role Loading Strategy

Protocol roles take precedence when available:

| Mode | Role Resolution |
|------|----------------|
| Spec | `codev/roles/builder.md` |
| Task | `codev/roles/builder.md` |
| Protocol | `codev/protocols/{name}/role.md` → fallback to `codev/roles/builder.md` |
| Shell | None (unless `--role` specified) |

### Builder State Extension

Add `type` field to `Builder` interface for observability:

```typescript
interface Builder {
  // ... existing fields
  type: 'spec' | 'task' | 'protocol' | 'shell';
  taskText?: string;      // For task mode (for display in dashboard)
  protocolName?: string;  // For protocol mode
}
```

### CLI Validation Matrix

| Flag Combination | Result |
|-----------------|--------|
| `--project` alone | OK (spec mode) |
| `--task` alone | OK (task mode) |
| `--protocol` alone | OK (protocol mode) |
| `--shell` alone | OK (shell mode) |
| `--project` + `--task` | ERROR: "Flags are mutually exclusive" |
| `--project` + `--shell` | ERROR: "Flags are mutually exclusive" |
| `--protocol` + `--shell` | ERROR: "Flags are mutually exclusive" |
| `--task` + `--protocol` | ERROR: "Flags are mutually exclusive" |
| `--files` without `--task` | ERROR: "--files requires --task" |
| No mode flag | ERROR: "Must specify one of: --project, --task, --protocol, --shell" |

## Open Questions

### Critical (Blocks Progress)
- [x] Should `--task` be required or allow positional arg? **Decision: Require explicit `--task` flag (no positional args)**
- [x] Should protocol mode load a protocol-specific role? **Decision: Yes, look for `protocols/{name}/role.md`, fallback to `builder.md`**

### Important (Affects Design)
- [x] How to prevent builder ID collisions? **Decision: 4-char random alphanumeric suffix**
- [x] Should task mode support `--files` for context? **Decision: Yes, add `--files` flag**

### Nice-to-Know (Deferred)
- [ ] Should we support spawning multiple tasks in parallel? (Deferred to future spec)
- [ ] Should there be a `--ephemeral` flag for auto-cleanup? (Deferred)

## Performance Requirements
- **Spawn time**: < 5 seconds to interactive prompt
- **Resource usage**: Same as current (one ttyd + tmux session per builder)

## Test Scenarios

### Functional Tests
1. `af spawn -p 0009` - Existing spec-based spawn works (backward compat)
2. `af spawn --task "Fix bug"` - Task mode creates builder with prompt
3. `af spawn --task "Fix bug" --files src/auth.ts` - Task mode with file context
4. `af spawn --protocol cleanup` - Protocol mode loads protocol
5. `af spawn --shell` - Shell mode creates bare session (no worktree)
6. Mutual exclusivity: `af spawn -p 0009 --shell` returns error
7. Mutual exclusivity: `af spawn --task "x" --protocol y` returns error
8. ID uniqueness: spawn same task twice, get different IDs (e.g., task-x9k2, task-b4c1)
9. Protocol role loading: creates role file at `protocols/cleanup/role.md`, verify it's loaded
10. Missing protocol: `af spawn --protocol nonexistent` shows helpful error
11. No mode flag: `af spawn` shows error with available modes

### Non-Functional Tests
1. Spawn completes in < 5 seconds
2. Multiple concurrent spawns don't cause port conflicts
3. Dashboard displays all builder types with correct grouping
4. `af spawn --help` shows all modes with examples

## Dependencies
- **Internal Systems**: Existing spawn infrastructure, tmux, ttyd
- **Libraries**: Commander.js for argument parsing

## References
- `codev/resources/conceptual-model.md` - Defines protocols and roles
- `agent-farm/src/commands/spawn.ts` - Current implementation
- `codev/protocols/` - Available protocols

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Breaking existing `--project` mode | Low | High | Comprehensive test coverage |
| Confusing UX with multiple modes | Medium | Medium | Clear help text and examples |
| Branch/worktree proliferation | High | Medium | Document cleanup procedures, consider `af prune` command |
| Port allocation race conditions | Low | Medium | Verify port still free after allocation |
| Dashboard incompatibility with new ID formats | Medium | Medium | Update dashboard UI to handle all builder types |
| Protocol file not found | Medium | Low | Clear error message with available protocols |
| Zombie builders from shell/task mode | High | Medium | Add `type` to state for grouping, easier cleanup |

## Expert Consultation
**Date**: 2025-12-03
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro
**Sections Updated**:
- **Technical Design**: Added unified `BuilderConfig` interface per Gemini recommendation (mode-based CLI, unified internal model)
- **Builder ID Generation**: Added collision-safe IDs with 4-char random suffixes per both models
- **Builder State**: Added `type` field for observability per Gemini
- **Role Loading**: Defined protocol role precedence strategy per Gemini (`protocols/{name}/role.md` → `builder.md`)
- **CLI Validation**: Added validation matrix for mutually exclusive flags per GPT-5
- **Risks**: Added additional risks (branch proliferation, port races, dashboard compat, zombie builders) per both models

**Update 2025-12-04 (Architect Review)**:
- Removed positional args - require explicit `--task` flag
- Simplified IDs to 4-char alphanumeric only (no timestamps/hashes)
- Removed protocol args (not needed for MVP)
- Removed security section (KISS - running on user's machine)
- Shell sessions don't create worktrees (just tmux sessions)

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Expert AI Consultation Complete

## Notes
This spec generalizes the spawn command to support the Architect's need for flexible delegation. It maintains backward compatibility while adding significant new capabilities. The key insight is that "spawning a builder" is fundamentally about delegating work, whether that work is defined in a spec file, as a natural language task, or as a protocol invocation.
