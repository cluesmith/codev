# Codev Identity & Porch Design Direction

*Captured: 2026-01-24*

## The Identity Question

Compared codev (200 stars) to "Get Shit Done" (6k stars). Both solve the same core problem: context degradation via phased AI-assisted development.

**Why GSD resonates:**
- Memorable name, viral positioning
- Anti-"enterprise theater" messaging
- Solo dev focused

**Codev's actual target:** Solo devs shipping serious projects.

**What's valuable in codev:**
- Agent Farm (parallel Claude workers in isolated worktrees)
- The methodology (specs → plans → phased implementation → reviews)
- 3-way reviews (Codex catches real bugs)

## The Core Problem

The methodology works. Claude just won't follow it reliably.

- Claude is good at *reasoning* but bad at *discipline*
- Porch provides discipline but can't reason
- Need both, but combining them is awkward

**The porch oscillation:**
1. Started: porch wraps Claude (deterministic but context loss)
2. Switched: Claude wraps porch (full context but Claude drifts)
3. Current: back to porch wraps Claude

Neither fully works because of the fundamental tension.

## The Simpler Model

**Key insight:** The problem is too many transitions. SPIR has ~6 phases with sub-states. Each transition is a failure point.

**What the user actually wants:**
1. Gate at spec-ready (human approval)
2. Gate at plan-ready (human approval)
3. Execute implementation phases with **automated 3-way code review after each phase**

**The new flow:**

```
SPECIFY (Claude freeform)
    ↓
[spec-approval] ← human
    ↓
PLAN (Claude freeform)
    ↓
[plan-approval] ← human
    ↓
FOR EACH PHASE:
    → Claude implements + tests
    → 3-way review (automated)
    → PASS: next phase
    → FAIL: re-spawn Claude with feedback
    ↓
[create PR]
```

**What this simplifies:**
- 2 human gates only (spec, plan)
- N automated review loops (one per phase)
- Claude can't skip phases (porch controls iteration)
- Claude can drift within a phase (review catches it)
- No complex sub-state tracking

**Porch's job:**
1. Spawn Claude for specify → wait for signal → human gate
2. Spawn Claude for plan → wait for signal → human gate
3. For each phase: spawn → review → loop if needed → next
4. Create PR

**Pre-approved artifact skip:** Porch always runs the full protocol from phase 1. But if a `build_verify` phase's artifact (spec or plan) already exists with YAML frontmatter marking it as `approved` and `validated`, porch skips that phase as a no-op and auto-approves the gate. This lets the architect prepare specs/plans before spawning a builder without porch re-doing that work.

Frontmatter format:
```yaml
---
approved: 2026-01-29
validated: [gemini, codex, claude]
---
```

**Claude's job (per spawn):**
- Freeform work within the defined scope
- Emit one signal when done
- No protocol memory required

## Next Steps

Implement this simplified porch model. The build-verify loop from Spec 0075 is the foundation, but with explicit phase iteration controlled by porch.
