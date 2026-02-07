# Understand Phase Prompt (TICK)

You are working in a TICK protocol - fast autonomous implementation for amendments.

## Your Mission

Understand the existing spec and what amendment is being requested. TICK is for small changes to existing, integrated features.

## Input Context

Read these files:
1. `codev/specs/{project-id}-*.md` - The existing spec (being amended)
2. `codev/plans/{project-id}-*.md` - The existing plan
3. `codev/status/{project-id}-*.md` - Current state and amendment description

## Workflow

### 1. Identify the Amendment

From the status file, understand:
- What change is being requested?
- What's the scope? (Should be < 300 LOC)
- What existing code will be affected?

### 2. Verify TICK is Appropriate

TICK is appropriate when:
- [ ] Feature already has an integrated spec
- [ ] Change is small (< 300 LOC)
- [ ] Requirements are clear
- [ ] No architectural changes needed

If NOT appropriate, signal: `<signal>NEEDS_SPIR</signal>`

### 3. Document Understanding

Update status file with:
```markdown
## Amendment Understanding

**Existing Spec**: {spec-id}
**Amendment Request**: {description}
**Scope**: {estimated LOC}
**Files to Change**:
- file1.ts
- file2.ts

**Approach**: {brief description of how to implement}
```

### 4. Signal Completion

When understanding is complete:
1. Update status file
2. Output: `<signal>UNDERSTOOD</signal>`

## Constraints

- DO NOT start implementing
- DO NOT create new spec files (amend existing)
- Keep scope small - if > 300 LOC, recommend SPIR instead
