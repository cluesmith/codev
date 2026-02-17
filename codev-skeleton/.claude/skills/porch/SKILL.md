---
name: porch
description: Protocol orchestrator CLI quick reference. Use when running porch commands to check correct syntax for status, run, done, approve, next, and pending.
disable-model-invocation: false
---

# porch - Protocol Orchestrator

## Synopsis

```bash
porch <command> [project-id]
```

Porch drives SPIR, TICK, and BUGFIX protocols via a state machine with phase transitions, gates, and multi-agent consultations.

## Commands

```bash
porch status [id]          # Show project status (auto-detects in worktree)
porch run [id]             # Run the protocol loop (strict mode)
porch next [id]            # Get next tasks for a project
porch done [id]            # Signal current phase work is complete
porch approve <id> <gate>  # Approve a gate (human only)
porch pending              # List all pending gates across projects
```

## Gates

Gates are human approval checkpoints. Builders STOP at gates and wait.

| Gate | Protocol | When |
|------|----------|------|
| `spec-approval` | SPIR | After spec is written |
| `plan-approval` | SPIR | After plan is written |
| `pr` | SPIR, TICK | After PR is created |

```bash
porch approve 42 spec-approval    # Approve spec gate
porch approve 42 plan-approval    # Approve plan gate
porch approve 42 pr               # Approve PR gate
```

## Project State

State is stored in `codev/projects/<id>/status.yaml`, managed automatically by porch. **Never edit status.yaml directly.**

## Common Mistakes

- **Never call `porch approve` as a builder** - Only humans approve gates
- **Never edit status.yaml directly** - Only porch modifies state
- Builders should use `porch done` to signal phase completion, not `porch approve`
- `porch run` is for strict mode only - soft mode builders follow the protocol manually
