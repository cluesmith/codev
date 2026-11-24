# Architect-Builder Workflow Reference

Quick reference for the 7-stage project workflow. For protocol details, see `codev/protocols/spir/protocol.md`.

## Workflow Overview

```
              CONCEPTION                    PLANNING                     EXECUTION
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  → 1. CONCEIVED                                                                     │
│         User describes project concept                                              │
│         Architect creates GitHub Issue, writes spec                                 │
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
│         Architect spawns builder: afx spawn <id> --protocol spir                  │
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
│         Architect assesses PR risk: gh pr diff --stat N                             │
│         Low: Read + merge | Medium: 1-model review | High: 3-way CMAP              │
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
| 6 | committed | Architect + Builder | Risk-based integration review, merge | PR merged |
| 7 | integrated | Human | Validate production | Human confirms |

## Human Gates

There are **two points where only a human can advance the workflow**:

1. **conceived → specified**: Human must approve the specification
2. **committed → integrated**: Human must validate production deployment

AI agents must stop and wait for human action at these gates.

## Common Commands

### Architect Commands

```bash
# Start the workspace
afx workspace start

# Spawn a builder for a project
afx spawn 44 --protocol spir

# Check all builder statuses
afx status

# Send message to builder
afx send 44 "Check PR comments and address feedback"

# Open a file for review
afx open codev/specs/44-name.md

# Clean up after merge
afx cleanup -p 44

# Stop everything
afx workspace stop
```

### Builder Commands

```bash
# Check your own status
afx status

# Send message to architect
afx send architect "Question about the spec..."

# Open a file in the annotation viewer
afx open src/path/to/file.ts
```

### Protocol Import

```bash
# Import protocol improvements from another project
codev import /path/to/other-project

# Import from GitHub
codev import github:cluesmith/codev

# Preview without running Claude
codev import github:owner/repo --dry-run
```

### Consultation Commands

In strict mode porch hands the builder the exact `consult` commands after each `porch done` —
three reviewers by default, or the lanes in `.codev/config.json` `porch.consultation`. Run each
as its own background task (in Claude Code, `run_in_background: true`, not a trailing `&`).
For reference, the shapes are:

```bash
# Builder reviews (porch emits these, with --output and --project-id added)
consult -m gemini --protocol spir --type spec      # Stage 1
consult -m codex  --protocol spir --type plan      # Stage 2
consult -m claude --protocol spir --type impl      # Stage 4, after each plan phase
consult -m gemini --protocol spir --type pr        # Stage 5, on the open PR

# Integration review (Stage 6 — depth depends on risk; see risk-triage.md)
# Low risk: no consult needed, the architect reads it
# Medium risk: one model
consult -m claude --type integration --issue <N>
# High risk: all three, each as a background task
consult -m gemini --type integration --issue <N>
consult -m codex  --type integration --issue <N>
consult -m claude --type integration --issue <N>
```

## Review Types

| Type | When Used | Focus |
|------|-----------|-------|
| `spec` | Stage 1 | Requirements clarity, completeness, feasibility |
| `plan` | Stage 2 | Implementation approach, phase breakdown, risk assessment |
| `impl` | Stage 4 | Code quality, test coverage, spec adherence |
| `pr` | Stage 5 | Final check of the open PR |
| `integration` | Stage 6 | System fit, architectural consistency, side effects (depth varies by risk — see `codev/resources/risk-triage.md`) |

## Builder Lifecycle

```
spawning → implementing → blocked → implementing → pr → complete
                ↑______________|
```

| Status | Meaning |
|--------|---------|
| `spawning` | Worktree created, builder starting up |
| `implementing` | Actively working on the spec |
| `blocked` | Stuck, needs architect help |
| `pr` | Implementation complete, ready for review |
| `complete` | Merged, worktree can be cleaned up |

## Git Workflow

### Branch Naming
```
builder/<protocol>-<id>        # e.g. builder/spir-42, created by afx spawn
```

### Commit Messages
```
[Spec <id>] Initial specification draft
[Spec <id>][Phase: <plan-phase>] feat: Phase description
[Spec <id>] Review: lessons learned
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
afx cleanup -p <id>          # Clean up builder worktree (plain number, no leading zeros)
```

## Troubleshooting

### Builder Reports Blocked

1. Check builder terminal for blocker message
2. Review any `// REVIEW(@architect):` comments in code
3. Provide guidance via `afx send <builder-id> "guidance here"`
4. Builder will resume work after receiving help

### PR Has Conflicts

1. Architect: `git pull` on main
2. Architect: Resolve conflicts or instruct builder
3. Builder: Rebase or merge main into branch
4. Builder: Force push if needed

### Claude Agent Exits With "Settings file not found"

A Claude builder or architect that exits at once with `Settings file not found` (exit 1),
with its builder loop relaunching every 2 seconds, means the attention-state reporter
files under `~/.agent-farm/hooks/` were deleted. Any Tower launch reinstalls them:

```bash
afx spawn <id> --resume
# or, for a whole workspace
afx workspace recover
```

### Builder Worktree Broken

```bash
# Check worktree status
git worktree list

# Force cleanup (only if work is committed/pushed)
afx cleanup -p <id> --force
```

## Related Documentation

- Full SPIR protocol: `codev/protocols/spir/protocol.md`
- Builder role: `codev/roles/builder.md`
- Architect role: `codev/roles/architect.md`
- Consultant role: `codev/roles/consultant.md`
- Risk triage guide: `codev/resources/risk-triage.md`
