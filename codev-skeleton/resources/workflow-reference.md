# Architect-Builder Workflow Reference

Quick reference for the 7-stage project workflow. For protocol details, see `codev/protocols/spir/protocol.md`.

## Workflow Overview

```
              CONCEPTION                    PLANNING                     EXECUTION
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  → 1. CONCEIVED                                                                     │
│         User describes project concept                                              │
│         Architect adds to projectlist, writes spec                                  │
│         Architect does 3-way spec review                                            │
│         ⏸️  HUMAN GATE: Approve spec                                                │
│                                                                                     │
│  → 2. SPECIFIED                                                                     │
│         Human approves spec                                                         │
│         Architect writes plan                                                       │
│         Architect does 3-way plan review                                            │
│         Human reviews and approves plan                                             │
│                                                                                     │
│  → 3. PLANNED                                                                       │
│         Architect commits spec + plan to main                                       │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                               IMPLEMENTATION                                        │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  → 4. IMPLEMENTING                                                                  │
│         Architect spawns builder: af spawn -p XXXX                                  │
│         Builder reads spec and plan                                                 │
│         For each phase: Implement → Defend → Evaluate                               │
│         Builder commits after each phase                                            │
│                                                                                     │
│  → 5. IMPLEMENTED                                                                   │
│         Builder writes review doc                                                   │
│         Builder creates PR, notifies architect                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                        HANDOFF / INTEGRATION                                        │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  → 6. COMMITTED                                                                     │
│         Architect does 3-way integration review                                     │
│         Architect iterates with builder via PR comments                             │
│         Architect tells builder to merge                                            │
│         Builder merges PR (NO --delete-branch flag)                                 │
│         Architect cleans up builder                                                 │
│                                                                                     │
│         ⏸️  HUMAN GATE: Validate in production                                      │
│  → 7. INTEGRATED                                                                    │
│         Human validates and marks as integrated                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Stage Quick Reference

| Stage | Status | Actor | Key Action | Exit Condition |
|-------|--------|-------|------------|----------------|
| 1 | conceived | Architect | Write spec, 3-way review | Human approves spec |
| 2 | specified | Human + Architect | Write plan, 3-way review | Human approves plan |
| 3 | planned | Architect | Commit spec + plan | Committed to main |
| 4 | implementing | Builder | IDE loop per phase | All phases complete |
| 5 | implemented | Builder | Write review, create PR | PR created |
| 6 | committed | Architect + Builder | Integration review, merge | PR merged |
| 7 | integrated | Human | Validate production | Human confirms |

## Human Gates

There are **two points where only a human can advance the workflow**:

1. **conceived → specified**: Human must approve the specification
2. **committed → integrated**: Human must validate production deployment

AI agents must stop and wait for human action at these gates.

## Common Commands

### Architect Commands

```bash
# Start the dashboard
af dash start

# Spawn a builder for a project
af spawn -p 0044

# Check all builder statuses
af status

# Send message to builder
af send 0044 "Check PR comments and address feedback"

# Open a file for review
af open codev/specs/0044-name.md

# Clean up after merge
af cleanup -p 0044

# Stop everything
af dash stop
```

### Builder Commands

```bash
# Check your own status
af status

# Send message to architect
af send architect "Question about the spec..."

# Open a file in the annotation viewer
af open src/path/to/file.ts
```

### Protocol Import

```bash
# Import protocol improvements from another project
codev import /path/to/other-project

# Import from GitHub
codev import github:cluesmith/ansari-project

# Preview without running Claude
codev import github:owner/repo --dry-run
```

### Consultation Commands

```bash
# Spec review (during Stage 1)
consult --model gemini --type spec-review spec 0044
consult --model codex --type spec-review spec 0044

# Plan review (during Stage 2)
consult --model gemini --type plan-review plan 0044
consult --model codex --type plan-review plan 0044

# Implementation review (during Stage 4, after each phase)
consult --model gemini --type impl-review spec 0044
consult --model codex --type impl-review spec 0044

# PR ready review (during Stage 5)
consult --model gemini --type pr-ready pr 88
consult --model codex --type pr-ready pr 88

# Integration review (during Stage 6)
consult --model gemini --type integration-review pr 88
consult --model codex --type integration-review pr 88

# Parallel 3-way reviews (run all three concurrently)
consult --model gemini --type spec-review spec 0044 &
consult --model codex --type spec-review spec 0044 &
consult --model claude --type spec-review spec 0044 &
wait
```

## Review Types

| Type | When Used | Focus |
|------|-----------|-------|
| `spec-review` | Stage 1 | Requirements clarity, completeness, feasibility |
| `plan-review` | Stage 2 | Implementation approach, phase breakdown, risk assessment |
| `impl-review` | Stage 4 | Code quality, test coverage, spec adherence |
| `pr-ready` | Stage 5 | Final self-check before PR creation |
| `integration-review` | Stage 6 | System fit, architectural consistency, side effects |

## Builder Lifecycle

```
spawning → implementing → blocked → implementing → pr-ready → complete
                ↑______________|
```

| Status | Meaning |
|--------|---------|
| `spawning` | Worktree created, builder starting up |
| `implementing` | Actively working on the spec |
| `blocked` | Stuck, needs architect help |
| `pr-ready` | Implementation complete, ready for review |
| `complete` | Merged, worktree can be cleaned up |

## Git Workflow

### Branch Naming
```
builder/XXXX-spec-name
```

### Commit Messages
```
[Spec XXXX][Implement] Phase description
[Spec XXXX][Defend] Add tests for phase
[Spec XXXX][Review] Add lessons learned
```

### PR Merge (Builder)
```bash
# CORRECT - preserves branch for worktree
gh pr merge N --merge

# WRONG - breaks worktree
gh pr merge N --merge --delete-branch
```

### Post-Merge Cleanup (Architect)
```bash
git pull                    # Get merged changes
af cleanup -p XXXX          # Clean up builder worktree
```

## Troubleshooting

### Builder Reports Blocked

1. Check builder terminal for blocker message
2. Review any `// REVIEW(@architect):` comments in code
3. Provide guidance via `af send XXXX "guidance here"`
4. Builder will resume work after receiving help

### PR Has Conflicts

1. Architect: `git pull` on main
2. Architect: Resolve conflicts or instruct builder
3. Builder: Rebase or merge main into branch
4. Builder: Force push if needed

### Builder Worktree Broken

```bash
# Check worktree status
git worktree list

# Force cleanup (only if work is committed/pushed)
af cleanup -p XXXX --force
```

## Related Documentation

- Full SPIR protocol: `codev/protocols/spir/protocol.md`
- Builder role: `codev/roles/builder.md`
- Architect role: `codev/roles/architect.md`
- Consultant role: `codev/roles/consultant.md`
