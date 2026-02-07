# TICK Protocol
**T**ask **I**dentification, **C**oding, **K**ickout

## Overview

TICK is an **amendment workflow** for existing SPIR specifications. Rather than creating new standalone specs, TICK modifies existing spec and plan documents in-place, tracking changes in an "Amendments" section.

**Core Principle**: TICK is for *refining* existing specs. SPIR is for *creating* new specs.

**Key Insight**: TICKs are not small SPIRs - they're amendments to existing SPIRs. This eliminates the "TICK vs SPIR" decision problem and keeps related work together.

## When to Use TICK

### Use TICK when:
- Making **amendments to an existing SPIR spec** that is already `integrated`
- Small scope (< 300 lines of new/changed code)
- Requirements are clear and well-defined
- No fundamental architecture changes
- Examples:
  - Adding a feature to an existing system (e.g., "add password reset to user auth")
  - Bug fixes that extend existing functionality
  - Configuration changes with logic
  - Utility function additions to existing modules
  - Refactoring within an existing feature

### Use SPIR instead when:
- Creating a **new feature from scratch** (no existing spec to amend)
- Major architecture changes (scope too large for amendment)
- Unclear requirements needing exploration
- > 300 lines of code
- Multiple stakeholders need alignment

### Cannot Use TICK when:
- No relevant SPIR spec exists (create a new SPIR spec instead)
- Target spec is not yet `integrated` (complete the SPIR cycle first)

## Amendment Workflow

### Phase 1: Identify Target Spec

**Input**: User describes the amendment needed

**Agent Actions**:
1. Analyze the amendment requirements
2. Search for the relevant existing spec to amend
3. Verify the spec exists and is `integrated`
4. Load current spec and plan documents
5. Determine next TICK number (count existing TICK entries + 1)

**Example**:
```
User: "Use TICK to add password reset to the auth system"
Agent finds: specs/0002-user-authentication.md (status: integrated)
Agent determines: Next TICK is TICK-001 (first amendment)
```

### Phase 2: Specification Amendment (Autonomous)

**Agent Actions**:
1. Analyze what needs to change in the spec
2. Update relevant sections of `specs/####-name.md`:
   - Problem Statement (if scope expands)
   - Success Criteria (if new criteria added)
   - Solution Approaches (if design changes)
   - Any other section that needs updating
3. Add entry to "Amendments" section at bottom:
   ```markdown
   ### TICK-001: [Title] (YYYY-MM-DD)

   **Summary**: [One-line description]

   **Problem Addressed**:
   [Why this amendment was needed]

   **Spec Changes**:
   - [Section]: [What changed]

   **Plan Changes**:
   - [Phase/steps]: [What was added/modified]

   **Review**: See `reviews/####-name-tick-001.md`
   ```
4. **COMMIT**: `[TICK ####-NNN] Spec: [description]`

### Phase 3: Planning Amendment (Autonomous)

**Agent Actions**:
1. Update `plans/####-name.md` with new implementation steps
2. Add/modify phases as needed
3. Add entry to "Amendment History" section at bottom:
   ```markdown
   ### TICK-001: [Title] (YYYY-MM-DD)

   **Changes**:
   - [Phase added]: [Description]
   - [Implementation steps]: [What was updated]

   **Review**: See `reviews/####-name-tick-001.md`
   ```
4. **COMMIT**: `[TICK ####-NNN] Plan: [description]`

### Phase 4: Implementation (Autonomous)

**Agent Actions**:
1. Execute implementation steps from the plan
2. Write code following fail-fast principles
3. Test functionality
4. **COMMIT**: `[TICK ####-NNN] Impl: [description]`

### Phase 5: Review (User Checkpoint)

**Agent Actions**:
1. Create review document: `reviews/####-name-tick-NNN.md`
   - What was amended and why
   - Changes made to spec and plan
   - Implementation challenges
   - Lessons learned
2. **Multi-Agent Consultation** (MANDATORY):
   - Consult GPT-5 AND Gemini Pro
   - Focus: Code quality, missed issues, improvements
   - Update review with consultation feedback
3. **Update Architecture Documentation** (if applicable)
4. **COMMIT**: `[TICK ####-NNN] Review: [description]`
5. **PRESENT TO USER**: Show summary with consultation insights

**User Actions**:
- Review completed work
- Provide feedback
- Request changes OR approve

**If Changes Requested**:
- Agent makes changes
- Commits: `[TICK ####-NNN] Fixes: [description]`
- Updates review document
- Repeats until user approval

## File Naming Convention

TICK amendments modify existing files and create new review files:

| File Type | Pattern | Example |
|-----------|---------|---------|
| Spec (modified) | `specs/####-name.md` | `specs/0002-user-authentication.md` |
| Plan (modified) | `plans/####-name.md` | `plans/0002-user-authentication.md` |
| Review (new) | `reviews/####-name-tick-NNN.md` | `reviews/0002-user-authentication-tick-001.md` |

**Note**: Spec and plan files are modified in-place. Only the review file is new.

## Git Commit Strategy

**TICK commits reference the parent spec and TICK number**:

```
[TICK 0002-001] Spec: Add password reset feature
[TICK 0002-001] Plan: Add password reset implementation
[TICK 0002-001] Impl: Add password reset feature
[TICK 0002-001] Review: Password reset implementation
[TICK 0002-001] Fixes: Address review feedback
```

The format `[TICK ####-NNN]` identifies:
- `####`: Parent spec number (e.g., 0002)
- `NNN`: TICK amendment number (e.g., 001, 002, 003)

## Key Differences from SPIR

| Aspect | SPIR | TICK |
|--------|--------|------|
| Purpose | Create new features | Amend existing features |
| File creation | Creates new spec/plan/review | Modifies spec/plan, creates review |
| Sequential numbering | Gets new number (0001, 0002) | Uses parent's number (0002-001) |
| Scope | Any size | < 300 lines typically |
| Prerequisites | None | Existing integrated spec required |
| User checkpoints | Multiple (spec, plan, phases) | Two (start, end) |
| Multi-agent consultation | Throughout | End only (review) |

## Protocol Selection Guide

```
Is there an existing spec to amend?
├── NO → Use SPIR (create new spec)
└── YES → Is it integrated?
    ├── NO → Complete SPIR cycle first
    └── YES → Is the change small (<300 LOC)?
        ├── YES → Use TICK (amend existing spec)
        └── NO → Use SPIR (scope too large)
```

**Mental Model**:
- SPIR = Create new feature from scratch
- TICK = Refine/extend existing feature

## Example TICK Workflow

**User**: "Add password reset to the user authentication system"

**Agent**:
1. **Identify**: Finds `specs/0002-user-authentication.md` (integrated)
2. **Amend Spec** (30 seconds):
   - Updates Success Criteria with password reset requirements
   - Adds TICK-001 entry to Amendments section
   - Commit: `[TICK 0002-001] Spec: Add password reset feature`
3. **Amend Plan** (30 seconds):
   - Adds Phase 4: Password Reset Email Service
   - Adds TICK-001 entry to Amendment History
   - Commit: `[TICK 0002-001] Plan: Add password reset implementation`
4. **Implement** (2 minutes):
   - Creates password reset endpoint
   - Implements email service
   - Tests functionality
   - Commit: `[TICK 0002-001] Impl: Add password reset feature`
5. **Review** (1 minute):
   - Creates `reviews/0002-user-authentication-tick-001.md`
   - Runs 3-way consultation (Gemini, Codex, Claude)
   - Commit: `[TICK 0002-001] Review: Password reset implementation`
   - Shows user the completed work

**Total Time**: ~4 minutes for simple amendment

## Multiple TICKs per Spec

A single spec can have multiple TICK amendments over its lifetime:

```markdown
## Amendments

### TICK-003: Add MFA support (2025-03-15)
...

### TICK-002: Add session timeout (2025-02-01)
...

### TICK-001: Add password reset (2025-01-15)
...
```

TICKs are listed in reverse chronological order (newest first). Each TICK builds on the previous state of the spec.

## Migration from Standalone TICK

Existing standalone TICK projects (created before this protocol change) are grandfathered in. No migration required.

**Optional Migration** (if desired):
1. Identify the "parent spec" the TICK logically extends
2. Move TICK content into an amendment entry in the parent spec
3. Archive the standalone files with a note: "Migrated to spec #### as TICK-NNN"
4. Update projectlist.md to reflect the change

## Benefits

1. **Single source of truth**: Spec file shows complete feature evolution
2. **Clear history**: Amendments section documents all changes chronologically
3. **Reduced fragmentation**: Related work stays together
4. **Simpler mental model**: "New vs amendment" is clearer than "SPIR vs TICK"
5. **Preserved context**: Looking at a spec shows all refinements

## Limitations

1. **Requires existing spec**: Cannot use TICK for greenfield work
2. **Spec can grow large**: Many TICKs add content (consider: >5 TICKs suggests need for new spec)
3. **Merge conflicts**: Multiple TICKs on same spec may conflict
4. **No course correction**: Can't adjust mid-implementation

## Best Practices

1. **Verify spec is integrated**: Never TICK a spec that isn't complete
2. **Keep TICKs small**: If scope grows, consider new SPIR spec
3. **Clear summaries**: Amendment entries should be self-explanatory
4. **Test before review**: Always test functionality before presenting
5. **Honest documentation**: Document all deviations in review

## Templates

TICK uses the standard SPIR templates with amendments sections:
- Spec template: `codev/protocols/spir/templates/spec.md` (includes Amendments section)
- Plan template: `codev/protocols/spir/templates/plan.md` (includes Amendment History section)
- Review template: `codev/protocols/tick/templates/review.md` (TICK-specific)
