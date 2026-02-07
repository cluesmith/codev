# Spike: Should Codev Migrate to Claude Code Skills?

**Date**: 2026-01-10
**Duration**: 1 hour
**Outcome**: PASS - Clear recommendation

## Executive Summary

**Should you migrate Codev to Skills?** No, not as a replacement.

**Should you wrap Codev with Skills?** Yes, but strategically.

**One skill or many?** Multiple skills, organized by user intent (not by internal role).

## The Core Problem

Skills and Codev solve different problems:

| Codev | Skills |
|-------|--------|
| Multi-agent orchestration | Single-agent guidance |
| Spawns parallel processes | Serial execution |
| Persistent state (SQLite) | Stateless |
| External CLI calls | Cannot call CLIs directly |

You cannot represent the Architect-Builder pattern in Skills because Skills cannot spawn independent agents.

## Recommendation: Skill-Wrapped Codev

Keep Codev as the engine. Add Skills as a natural language interface.

```
┌─────────────────────────────────────────────┐
│           User talks to Claude              │
│         "Implement spec 0064"               │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│         Skills Layer (UX)                   │
│  Translates intent → Codev commands         │
│  /implement, /status, /review, /consult     │
└─────────────────┬───────────────────────────┘
                  │ Bash: af spawn -p 0064
                  ▼
┌─────────────────────────────────────────────┐
│         Codev (Engine)                      │
│  Worktrees, tmux, SQLite, dashboard         │
└─────────────────────────────────────────────┘
```

## Skill Organization: By User Intent

**Wrong approach**: One skill per internal role (architect.md, builder.md)
- Users don't think in terms of "I want to be an architect"
- Internal roles are implementation details

**Right approach**: One skill per user intent
- "I want to implement something" → `/implement`
- "I want to check progress" → `/status`
- "I want to review a PR" → `/review`

### Proposed Skills

```
.claude/skills/
├── implement/
│   └── SKILL.md       # Spawn builder, track progress
├── status/
│   └── SKILL.md       # Check builders, show dashboard
├── review/
│   └── SKILL.md       # Run 3-way consultation
├── plan/
│   └── SKILL.md       # Create spec and plan (SPIR S+P)
└── maintain/
│   └── SKILL.md       # Run MAINTAIN protocol
```

## How to Represent SPIR in Skills

SPIR has 6 phases: Specify → Plan → Implement → Defend → Evaluate → Review

**You cannot represent the full SPIR loop in Skills** because:
- Implement/Defend/Evaluate run in a builder (separate process)
- Skills cannot spawn builders
- Skills cannot wait for async completion

**What you CAN do**: Create skills for the phases the Architect controls:

| SPIR Phase | Who Does It | Skill? |
|--------------|-------------|--------|
| **Specify** | Architect | ✅ `/plan` skill guides spec creation |
| **Plan** | Architect | ✅ `/plan` skill guides plan creation |
| **Implement** | Builder | ❌ Skill spawns builder, doesn't do the work |
| **Defend** | Builder | ❌ Builder does this |
| **Evaluate** | Builder | ❌ Builder does this |
| **Review** | Architect | ✅ `/review` skill runs 3-way consultation |

### The `/plan` Skill (SPIR S+P)

```yaml
---
name: plan
description: Create a new feature spec and plan following SPIR protocol. Use when starting new work.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Plan Skill - SPIR Specify + Plan

## When to Use
User wants to start new work: "Let's implement X", "I need to build Y"

## Workflow

1. **Check projectlist.md** for next available spec number
2. **Create spec** using template from codev/protocols/spir/templates/spec.md
3. **Consult** (remind user to run: consult --model gemini spec XXXX)
4. **Create plan** using template from codev/protocols/spir/templates/plan.md
5. **Consult** (remind user to run: consult --model codex plan XXXX)
6. **Commit** spec and plan
7. **Ready to spawn**: Tell user to run `af spawn -p XXXX`

## Templates
- Spec: [codev/protocols/spir/templates/spec.md](../../protocols/spir/templates/spec.md)
- Plan: [codev/protocols/spir/templates/plan.md](../../protocols/spir/templates/plan.md)
```

### The `/implement` Skill

```yaml
---
name: implement
description: Spawn a builder to implement a spec. Use when spec and plan are ready.
allowed-tools: Bash, Read
---

# Implement Skill - Spawn Builder

## When to Use
User says: "Implement spec 0064", "Start working on 0064", "Spawn a builder for 0064"

## Workflow

1. **Verify** spec and plan exist:
   - codev/specs/XXXX-*.md
   - codev/plans/XXXX-*.md

2. **Check** projectlist.md status is 'planned'

3. **Spawn builder**:
   ```bash
   af spawn -p XXXX
   ```

4. **Update** projectlist.md status to 'implementing'

5. **Tell user** where to find the builder:
   - Dashboard: http://localhost:4200
   - Builder tab will appear

## Note
The builder works autonomously. You don't control it.
Check status with: af status
```

### The `/review` Skill

```yaml
---
name: review
description: Run 3-way consultation review on a PR. Use when builder is pr-ready.
allowed-tools: Bash, Read
---

# Review Skill - 3-Way Consultation

## When to Use
User says: "Review PR 42", "Check the builder's work", "Run consultation on 0064"

## Workflow

1. **Find PR number** from builder or user

2. **Run parallel consultations**:
   ```bash
   consult --model gemini pr N &
   consult --model codex pr N &
   consult --model claude pr N &
   wait
   ```

3. **Synthesize** findings into actionable feedback

4. **Post** review comment to PR:
   ```bash
   gh pr comment N --body "..."
   ```

5. **Notify** builder:
   ```bash
   af send XXXX "Check PR comments"
   ```
```

### The `/status` Skill

```yaml
---
name: status
description: Check status of all builders and projects. Use when asking about progress.
allowed-tools: Bash, Read
---

# Status Skill

## When to Use
User asks: "What's the status?", "How's the builder doing?", "Show me progress"

## Commands

### Quick status
```bash
af status
```

### Detailed builder info
```bash
sqlite3 -header -column .agent-farm/state.db "SELECT * FROM builders"
```

### Project status
```bash
cat codev/projectlist.md
```

### Open dashboard
Tell user: http://localhost:4200
```

## What You Should NOT Do

### Don't: Create a "builder" skill
Skills cannot BE a builder. A builder is a separate Claude instance in a worktree.

### Don't: Try to run SPIR entirely in Skills
The I-D-E phases require an autonomous agent. Skills can't do that.

### Don't: Put Codev's internal logic in Skills
Skills should CALL Codev (`af`, `consult`), not REPLACE it.

## Migration Path

### Phase 1: Proof of Concept (Now)
Create `/status` skill only. Test if Skills can call `af status`.

### Phase 2: Core Skills (If Phase 1 works)
Add `/implement`, `/review`, `/plan`.

### Phase 3: Full Integration (Future)
Add auto-discovery so Claude suggests skills at right moments.

## Open Questions

1. **Can Skills call Bash reliably?** Need to test `af` commands work from Skills.
2. **Context pollution?** Does switching between skill contexts confuse Claude?
3. **User expectations?** Will users expect Skills to DO the work vs DELEGATE it?

## Conclusion

| Question | Answer |
|----------|--------|
| Replace Codev with Skills? | **No** |
| Wrap Codev with Skills? | **Yes**, for UX improvement |
| One skill or many? | **Many**, organized by user intent |
| Represent SPIR in Skills? | **Partially** - only Architect phases |

Skills are a **UI layer**, not a replacement for the **orchestration engine**.
