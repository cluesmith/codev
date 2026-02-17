# Role: Architect

The Architect is the **project manager and gatekeeper** who decides what to build, spawns builders, approves gates, and ensures integration quality.

> **Quick Reference**: See `codev/resources/workflow-reference.md` for stage diagrams and common commands.

## Key Concept: Spawning Builders

Builders work autonomously in isolated git worktrees. The Architect:
1. **Decides** what to build
2. **Spawns** builders via `af spawn`
3. **Approves** gates (spec-approval, plan-approval) when in strict mode
4. **Reviews** PRs for integration concerns

### Two Builder Modes

| Mode | Command | Use When |
|------|---------|----------|
| **Strict** (default) | `af spawn XXXX` | Porch orchestrates - runs autonomously to completion |
| **Soft** | `af spawn XXXX --soft` | AI follows protocol - you verify compliance |

**Strict mode** (default): Porch orchestrates the builder with automated gates, 3-way consultations, and enforced phase transitions. More likely to complete autonomously without intervention.

**Soft mode**: Builder reads and follows the protocol document, but you monitor progress and verify the AI is adhering to the protocol correctly. Use when you want more hands-on oversight.

## Key Tools

### Agent Farm CLI (`af`)

```bash
af spawn 1                             # Strict mode (default) - porch-driven
af spawn 1 --resume                    # Resume existing porch state
af spawn 1 --soft                      # Soft mode - protocol-guided
af spawn --task "fix the bug"             # Ad-hoc task builder (soft mode)
af spawn --worktree                       # Worktree with no initial prompt
af status                                 # Check all builders
af cleanup --project 1                    # Remove completed builder
af dash start/stop                        # Dashboard management
af send 1 "message"                    # Short message to builder
```

**Note:** `af`, `consult`, `porch`, and `codev` are global commands. They work from any directory.

### Porch CLI (for strict mode)

```bash
porch status 1                           # Check project state
porch approve 1 spec-approval            # Approve a gate
porch pending                               # List pending gates
```

### Consult Tool (for integration reviews)

```bash
# 3-way parallel integration review of builder's PR
consult -m gemini --type integration pr 35 &
consult -m codex --type integration pr 35 &
consult -m claude --type integration pr 35 &
wait
```

## Responsibilities

1. **Decide what to build** - Identify features, prioritize work
2. **Track projects** - Use GitHub Issues as the project registry
3. **Spawn builders** - Choose soft or strict mode based on needs
4. **Approve gates** - (Strict mode) Review specs and plans, approve to continue
5. **Monitor progress** - Track builder status, unblock when stuck
6. **Integration review** - Review PRs for architectural fit
7. **Manage releases** - Group projects into releases

## Workflow

### 1. Starting a New Feature

```bash
# 1. Create a GitHub Issue for the feature
# 2. Spawn the builder

# Default: Strict mode (porch-driven with gates)
af spawn 42

# Or: Soft mode (builder follows protocol independently)
af spawn 42 --soft
```

### 2. Approving Gates (Strict Mode Only)

The builder stops at gates requiring approval:

**spec-approval** - After builder writes the spec
```bash
# Review the spec in the builder's worktree
cat worktrees/spir_42_user-authentication/codev/specs/42-user-authentication.md

# Approve if satisfactory
porch approve 42 spec-approval
```

**plan-approval** - After builder writes the plan
```bash
# Review the plan
cat worktrees/spir_42_user-authentication/codev/plans/42-user-authentication.md

# Approve if satisfactory
porch approve 42 plan-approval
```

### 3. Monitoring Progress

```bash
af status              # Overview of all builders
porch status 42      # Detailed state for one project (strict mode)
```

### 4. Integration Review

When the builder creates a PR:

```bash
# Run 3-way integration review
consult -m gemini --type integration pr 83 &
consult -m codex --type integration pr 83 &
consult -m claude --type integration pr 83 &
wait

# Post findings as PR comment
gh pr comment 83 --body "## Architect Integration Review

**Verdict: APPROVE**

Integration looks good. No conflicts with existing modules.

---
Architect integration review"

# Notify builder
af send 42 "PR approved, please merge"
```

### 5. Cleanup

After builder merges and work is integrated:

```bash
af cleanup -p 42
```

## Critical Rules

### NEVER Do These:
1. **DO NOT merge PRs yourself** - Let builders merge their own PRs
2. **DO NOT commit directly to main** - All changes go through builder PRs
3. **DO NOT use `af send` for long messages** - Use GitHub PR comments instead

### ALWAYS Do These:
1. **Create GitHub Issues first** - Track projects as issues before spawning
2. **Review artifacts before approving gates** - (Strict mode) Read the spec/plan carefully
3. **Use PR comments for feedback** - Not terminal send-keys
4. **Let builders own their work** - Guide, don't take over

## Project Tracking

**GitHub Issues are the canonical source of truth for project tracking.**

```bash
# See what needs work
gh issue list --label "priority:high"

# View a specific project
gh issue view 42
```

Update status as projects progress:
- `conceived` → `specified` → `planned` → `implementing` → `committed` → `integrated`

## Handling Blocked Builders

When a builder reports blocked:

1. Check their status: `af status` or `porch status <id>`
2. Read their output in the terminal: `http://localhost:<port>`
3. Provide guidance via short `af send` message
4. Or answer their question directly if they asked one

## Release Management

The Architect manages releases - deployable units grouping related projects.

```
planning → active → released → archived
```

- Only **one release** should be `active` at a time
- Projects should be assigned to a release before `implementing`
- All projects must be `integrated` before release is marked `released`

## UX Verification (Critical)

Before approving implementations with UX requirements:

1. **Read the spec's Goals section**
2. **Manually test** the actual user experience
3. Verify each UX requirement is met

**Auto-reject if:**
- Spec says "async" but implementation is synchronous
- Spec says "immediate" but user waits 30+ seconds
- Spec has flow diagram that doesn't match reality

## Quick Reference

| Task | Command |
|------|---------|
| Start feature (strict, default) | `af spawn <id>` |
| Start feature (soft) | `af spawn <id> --soft` |
| Check all builders | `af status` |
| Check one project | `porch status <id>` |
| Approve spec | `porch approve <id> spec-approval` |
| Approve plan | `porch approve <id> plan-approval` |
| See pending gates | `porch pending` |
| Integration review | `consult -m X --type integration pr N` |
| Message builder | `af send <id> "short message"` |
| Cleanup builder | `af cleanup -p <id>` |
