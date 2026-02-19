# ASPIR Protocol

> **ASPIR** = **A**utonomous **S**pecify → **P**lan → **I**mplement → **R**eview
>
> Identical to SPIR but without human approval gates on spec and plan phases.
> Each phase has one build-verify cycle with 3-way consultation.

## What is ASPIR?

ASPIR is an autonomous variant of the SPIR protocol. It follows the exact same phases (Specify → Plan → Implement → Review) with the same 3-way consultations, checks, and PR flow — but removes the `spec-approval` and `plan-approval` human gates.

This means the builder proceeds automatically from Specify → Plan → Implement without waiting for human approval at each gate. The `pr` gate in the Review phase is preserved — a human still reviews all code before merge.

### Differences from SPIR

| Aspect | SPIR | ASPIR |
|--------|------|-------|
| Spec gate (`spec-approval`) | Human must approve | Auto-approved |
| Plan gate (`plan-approval`) | Human must approve | Auto-approved |
| PR gate (`pr`) | Human must approve | Human must approve |
| Phases | Specify → Plan → Implement → Review | Same |
| 3-way consultations | Yes, every phase | Same |
| Checks (build, tests, PR) | Yes | Same |
| Prompts / templates | Full set | Same (copied from SPIR) |

### When to Use ASPIR

Use ASPIR instead of SPIR when:

- The work is **trusted and low-risk** — internal tooling, protocol additions, well-understood features
- The architect has **pre-written and approved** the spec before spawning
- The scope is **self-contained** with low blast radius
- You want **full SPIR discipline** (consultations, phased implementation, review) without waiting at gates

### When NOT to Use ASPIR

Use SPIR instead when:

- The feature involves **novel architecture** or unclear requirements
- The spec needs **iterative human feedback** during drafting
- The work is **high-risk** — security-sensitive, user-facing, or broadly impactful
- You want to **review and adjust** the plan before implementation starts

## Protocol Phases

ASPIR follows the same four phases as SPIR. For full phase documentation, see the [SPIR protocol](../spir/protocol.md).

### S - Specify
Write specification with 3-way review (Gemini, Codex, Claude). **No human gate** — proceeds directly to Plan after verification.

### P - Plan
Write implementation plan with 3-way review. **No human gate** — proceeds directly to Implement after verification and checks pass.

### I - Implement
Execute each plan phase with build-verify cycle. Same as SPIR — no gate between phases (SPIR also has no gate here).

### R - Review
Final review, PR preparation, and 3-way review. **PR gate preserved** — builder stops and waits for human approval before merge.

## Usage

```bash
# Spawn a builder using ASPIR
af spawn 42 --protocol aspir

# The builder runs autonomously through Specify → Plan → Implement
# and stops only at the PR gate in the Review phase
```

## File Structure

```
codev/protocols/aspir/
├── protocol.json          # Protocol definition (SPIR minus gates)
├── protocol.md            # This file
├── builder-prompt.md      # Builder instructions (same as SPIR)
├── prompts/
│   ├── specify.md         # Specify phase prompt (same as SPIR)
│   ├── plan.md            # Plan phase prompt (same as SPIR)
│   ├── implement.md       # Implement phase prompt (same as SPIR)
│   └── review.md          # Review phase prompt (same as SPIR)
├── consult-types/
│   ├── spec-review.md     # Spec consultation guide (same as SPIR)
│   ├── plan-review.md     # Plan consultation guide (same as SPIR)
│   ├── impl-review.md     # Impl consultation guide (same as SPIR)
│   ├── phase-review.md    # Phase consultation guide (same as SPIR)
│   └── pr-review.md       # PR consultation guide (same as SPIR)
└── templates/
    ├── spec.md            # Spec template (same as SPIR)
    ├── plan.md            # Plan template (same as SPIR)
    └── review.md          # Review template (same as SPIR)
```

All files except `protocol.json` and `protocol.md` are identical to their SPIR counterparts.
