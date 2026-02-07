# Specification: TICK as SPIR Amendment

## Metadata
- **ID**: 0040-tick-as-spider-amendment
- **Protocol**: SPIR
- **Status**: draft
- **Created**: 2025-12-08
- **Priority**: high

## Problem Statement

Currently, TICK exists as a separate, standalone protocol alongside SPIR. This creates conceptual overhead and confusion:

1. **Dual Protocol Management**: Developers must choose between two fundamentally different workflows (TICK's single-pass vs SPIR's multi-phase), even when the task is just a small enhancement to an existing feature
2. **Document Fragmentation**: TICK projects create entirely new spec/plan/review files, even when they're just minor modifications to existing SPIR specs
3. **Historical Continuity Lost**: Looking at a spec doesn't show its evolution over time - amendments and refinements are scattered across separate numbered specs
4. **Unnecessary Cognitive Load**: The decision "should I use TICK or SPIR?" becomes a barrier, when the real question is "is this new work or an amendment?"

The core insight: **TICK is not a parallel protocol - it's a lightweight amendment mechanism for existing specs**.

## Current State

TICK protocol (`codev-skeleton/protocols/tick/protocol.md`) operates as a standalone workflow:
- Creates new spec/plan/review files with their own sequential numbers (e.g., 0010, 0011, 0012)
- Uses its own commit format: `TICK Spec/Plan/Impl/Review: [description]`
- Maintains complete separation from SPIR specs, even when work is related
- Protocol selection happens upfront: "Use TICK" vs "Use SPIR"

Example scenario:
- SPIR Spec 0002 implements "User Authentication"
- Later, we need to add "Password reset via email"
- Currently: Create TICK Spec 0015 as a new project
- Problem: The connection between 0002 and 0015 is only documented in dependencies or notes

## Desired State

TICK becomes an **amendment workflow** for existing SPIR specs:
- TICK modifies **both spec and plan together** as a single, atomic unit
- The original spec document gets an **"Amendments" section** at the end, tracking all TICKs chronologically
- Each TICK entry in the amendments section records:
  - Date of amendment
  - Brief summary (one line)
  - What changed in the spec (new sections, updated acceptance criteria, etc.)
  - What changed in the plan (new implementation steps, refactoring tasks, etc.)
- TICKs are **reviewed as a single unit** - the spec changes and plan changes are approved together
- Sequential numbering is preserved: TICKs don't get new numbers, they extend existing specs

Example scenario (improved):
- SPIR Spec 0002 implements "User Authentication"
- Later amendment: Update spec 0002 with new "Password Reset" section
- Spec 0002 now has an "Amendments" section showing the evolution
- Plan 0002 updated with password reset implementation steps
- One review document captures the TICK work: `reviews/0002-user-authentication-tick-001.md`

## Stakeholders

- **Primary Users**: Codev users (AI agents and human developers) who need to enhance existing features
- **Secondary Users**: Project reviewers who need to understand feature evolution over time
- **Technical Team**: Codev maintainers who will implement this protocol change

## Success Criteria

- [ ] TICK protocol document clearly describes the amendment workflow
- [ ] Spec template includes an "Amendments" section at the end
- [ ] TICK review documents follow a clear naming convention that links to the parent spec
- [ ] Migration path documented for existing standalone TICK projects
- [ ] Protocol selection guide updated to reflect "new work vs amendment" framing
- [ ] All examples in documentation demonstrate TICK as amendment
- [ ] CLAUDE.md and AGENTS.md updated with new TICK guidance

## Constraints

### Technical Constraints
- Must maintain backward compatibility with existing TICK projects (0010, 0011, etc.)
- Must not break sequential numbering system
- Must preserve git history and existing commit formats

### Business Constraints
- Should not require renumbering existing specs
- Migration should be optional, not mandatory
- Documentation must be clear enough for AI agents to understand

## Assumptions

- TICK is only used for **existing** SPIR specs (never creates new specs from scratch)
- A single SPIR spec can have multiple TICKs over its lifetime (TICK-001, TICK-002, etc.)
- TICK reviews use a distinct naming pattern: `reviews/####-name-tick-NNN.md`
- The three-file structure (spec/plan/review) is preserved, but spec and plan are **modified in place**

## Solution Approaches

### Approach 1: Amendment Sections with Sub-Numbering

**Description**: Keep existing spec/plan files and add amendment sections. TICKs use sub-numbering (e.g., TICK-001, TICK-002).

**Workflow**:
1. User describes the amendment needed (e.g., "add password reset to the auth system")
2. Agent searches for and identifies the relevant spec to amend (e.g., finds spec 0002)
3. Agent modifies `specs/0002-user-authentication.md` in place:
   - Updates relevant sections (Problem Statement, Success Criteria, etc.)
   - Adds entry to "Amendments" section at bottom with TICK-001
4. Agent modifies `plans/0002-user-authentication.md` in place:
   - Adds new implementation steps or phases
   - Adds entry to "Amendment History" section at bottom
5. Agent creates `reviews/0002-user-authentication-tick-001.md`
6. Commits:
   - `[TICK 0002-001] Spec: Add password reset feature`
   - `[TICK 0002-001] Plan: Add password reset implementation`
   - `[TICK 0002-001] Impl: Add password reset feature`
   - `[TICK 0002-001] Review: Password reset implementation`

**Amendments Section Format**:
```markdown
## Amendments

### TICK-001: Password Reset Feature (2025-12-08)

**Spec Changes**:
- Added "Password Reset Flow" to Problem Statement
- Added email delivery requirements to Success Criteria
- Added security considerations for reset tokens

**Plan Changes**:
- Added Phase 5: Password Reset Email Service
- Added Phase 6: Reset Token Validation
- Updated Phase 1 to include reset token table schema

**Review**: See `reviews/0002-user-authentication-tick-001.md`
```

**Pros**:
- Clear historical record in the spec itself
- Sub-numbering (TICK-001, TICK-002) shows amendment sequence
- Spec remains the canonical source of truth
- Easy to see what changed in each TICK
- Preserves connection to parent spec

**Cons**:
- Specs can grow large over time with many amendments
- Requires discipline to document changes accurately
- Merging conflicts possible if multiple TICKs edit same spec

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 2: Separate Amendment Documents

**Description**: Create separate TICK documents (e.g., `0002-001-amendment.md`) that describe changes, but don't modify original spec/plan.

**Workflow**:
1. User says: "Use TICK to amend spec 0002"
2. Agent creates new files:
   - `specs/0002-001-password-reset-amendment.md` (describes changes)
   - `plans/0002-001-password-reset-amendment.md` (implementation steps)
   - `reviews/0002-001-password-reset-amendment.md` (review)
3. Original `specs/0002-user-authentication.md` gets a reference link at the end

**Pros**:
- No merge conflicts on the original spec
- Amendments are atomic, self-contained documents
- Easier to review individual amendments

**Cons**:
- Loses "single source of truth" - must read multiple files to understand current state
- More files to manage
- Doesn't solve the fragmentation problem (just moves it)
- Harder to see the "current" spec at a glance

**Estimated Complexity**: Low
**Risk Level**: Medium (may not achieve the goal)

### Approach 3: TICK as New Spec with Strong Linking

**Description**: Keep TICK as a separate protocol but enforce stronger linking conventions and metadata.

**Workflow**:
1. TICK creates new spec (e.g., 0015) but MUST specify `amends: 0002` in metadata
2. Both specs show bidirectional links
3. Tools (future work) could aggregate related specs

**Pros**:
- Minimal change to existing protocols
- Clear separation between original and amendment
- No merge conflicts

**Cons**:
- Doesn't solve the core problem - still fragmented
- Relies on tooling that doesn't exist yet
- Still creates cognitive overhead for protocol selection

**Estimated Complexity**: Low
**Risk Level**: High (doesn't achieve goals)

## Recommended Approach

**Approach 1: Amendment Sections with Sub-Numbering**

This approach best solves the core problems:
- Maintains single source of truth (the spec file itself)
- Shows historical evolution in context
- Clear amendment tracking with TICK-NNN sub-numbers
- Preserves three-file structure that Codev relies on

## Open Questions

### Resolved

| Question | Decision |
|----------|----------|
| What happens if a TICK needs to be reverted? | Yes, support reverting - TICK-002 can undo TICK-001 |
| Should TICKs be allowed on specs not yet "integrated"? | No - only integrated specs can be amended via TICK |
| Should "Amendments" section show diffs or summaries? | Just summaries - git history has full details if needed |
| Multi-agent consultation for TICKs? | Review-only (same as current TICK), unless user requests more |
| Maximum TICKs per spec? | No hard limit - not worth the complexity |
| Auto-generate amendment summary? | Yes, part of the TICK building process |
| `codev tick list 0002` command? | Yes, add this to show all TICKs for a spec |

## Technical Design

*Note: Detailed technical design (workflow phases, template changes, file naming) will be documented in the implementation plan.*

### Modified TICK Protocol Workflow

**Phase 1: Identify Target Spec**
```
Input: User says "Use TICK to amend spec 0002 - add password reset"
Agent Actions:
  1. Parse spec number from instruction (0002)
  2. Verify spec exists: codev/specs/0002-*.md
  3. Load current spec and plan documents
  4. Determine next TICK number (count existing TICK entries + 1)
```

**Phase 2: Specification Amendment (Autonomous)**
```
Agent Actions:
  1. Analyze the amendment requirements
  2. Update relevant sections of spec/0002-*.md:
     - Problem Statement (if scope expands)
     - Success Criteria (if new criteria added)
     - Solution Approaches (if design changes)
     - Any other section that needs updating
  3. Add entry to "Amendments" section at bottom:
     ### TICK-NNN: [Title] (YYYY-MM-DD)
     **Spec Changes**: ...
     **Plan Changes**: ...
  4. COMMIT: "[TICK 0002-NNN] Spec: [description]"
```

**Phase 3: Planning Amendment (Autonomous)**
```
Agent Actions:
  1. Update plans/0002-*.md with new implementation steps
  2. Add/modify phases as needed
  3. Add entry to "Amendment History" section at bottom
  4. COMMIT: "[TICK 0002-NNN] Plan: [description]"
```

**Phase 4: Implementation (Autonomous)**
```
Agent Actions:
  1. Execute implementation steps from plan
  2. Test functionality
  3. COMMIT: "[TICK 0002-NNN] Impl: [description]"
```

**Phase 5: Review (User Checkpoint)**
```
Agent Actions:
  1. Create reviews/0002-*-tick-NNN.md with:
     - What was amended and why
     - Changes made to spec and plan
     - Implementation challenges
     - Lessons learned
  2. Multi-agent consultation (GPT-5 + Gemini Pro)
  3. Update architecture documentation (arch.md)
  4. COMMIT: "[TICK 0002-NNN] Review: [description]"
  5. Present to user for approval
```

### Spec Template Changes

Add to end of `spec.md` template:

```markdown
## Amendments

This section tracks all TICK amendments to this specification.

### TICK-001: [Amendment Title] (YYYY-MM-DD)

**Summary**: [One-line description of what changed]

**Spec Changes**:
- [List of sections modified and why]

**Plan Changes**:
- [List of plan modifications]

**Review**: See `reviews/####-name-tick-001.md`

---

*Additional TICK entries appear above this line in reverse chronological order*
```

### Plan Template Changes

Add to end of `plan.md` template:

```markdown
## Amendment History

This section tracks all TICK amendments to this plan.

### TICK-001: [Amendment Title] (YYYY-MM-DD)

**Changes**:
- [List of phases added/modified/removed]
- [List of implementation steps updated]

**Review**: See `reviews/####-name-tick-001.md`

---

*Additional TICK entries appear above this line in reverse chronological order*
```

### Review File Naming Convention

- **Original SPIR review**: `reviews/0002-user-authentication.md`
- **TICK amendments**: `reviews/0002-user-authentication-tick-001.md`, `reviews/0002-user-authentication-tick-002.md`, etc.

## When to Use TICK vs Full SPIR

**Updated Decision Framework**:

Use **TICK** when:
- Making small amendments to an existing design (existing SPIR spec)
- < 300 lines of new/changed code
- No fundamental architecture changes
- Requirements are clear and well-defined
- Examples: bug fixes, small feature additions, configuration changes, minor refactoring

Use **SPIR** when:
- Creating a **new feature from scratch** (no existing spec to amend)
- Major architecture changes to an existing feature (scope is too large for amendment)
- Unclear requirements needing extensive exploration
- > 300 lines of code
- Multiple stakeholders need alignment

**Key Mental Model**: TICK is for *refining* existing specs. SPIR is for *creating* new specs.

## Migration Path

### For Existing Standalone TICK Projects

Existing TICK projects (e.g., 0010, 0011, 0012) can remain as-is. They are grandfathered in. No forced migration.

**Optional Migration** (if desired):
1. Identify the "parent spec" the TICK logically extends
2. Move TICK content into an amendment entry in the parent spec
3. Archive the standalone TICK files with a note: "Content migrated to spec NNNN as TICK-NNN"
4. Update projectlist.md to reflect the change

### For Future Work

All future TICKs MUST use the amendment workflow. The standalone TICK protocol will be deprecated but documented for historical reference.

## Impact on Existing Documentation

### Files to Update

1. **codev-skeleton/protocols/tick/protocol.md**
   - Rewrite to describe amendment workflow
   - Add examples of amending existing specs
   - Document commit message format
   - Update protocol comparison table

2. **codev-skeleton/protocols/spir/templates/spec.md**
   - Add "Amendments" section template at end

3. **codev-skeleton/protocols/spir/templates/plan.md**
   - Add "Amendment History" section template at end

4. **codev/CLAUDE.md and codev/AGENTS.md**
   - Update "Protocol Selection Guide" section
   - Clarify TICK as amendment mechanism
   - Update examples

5. **codev/projectlist.md**
   - Update status tracking to show TICK sub-numbers (e.g., 0002 has TICK-001, TICK-002)
   - Add `ticks: [001, 002]` field to project entries (small list per project)

## Performance Requirements

- No specific performance requirements - this is a process/documentation change

## Security Considerations

- No security implications - this is a methodology change

## Test Scenarios

### Functional Tests
1. **Happy Path**: Use TICK to amend an existing spec, verify amendments section is populated correctly
2. **Multiple TICKs**: Apply TICK-001 and TICK-002 to same spec, verify both appear in amendments section
3. **Review Linking**: Verify review files use correct naming convention and link back to parent spec

### Edge Cases
1. **Spec Discovery**: When user describes an amendment without specifying a spec number, the AI should search and identify the relevant spec/plan to amend
2. **Spec Doesn't Exist**: Agent should fail gracefully if the target spec cannot be found
3. **Concurrent TICKs**: What happens if two TICKs are in progress on the same spec? (Git merge conflict resolution)
4. **TICK on Old TICK**: Can a standalone TICK (from before this change) be amended? (Answer: treat it as a new SPIR spec)

## Dependencies

- **SPIR Protocol**: TICK is built on top of SPIR's spec/plan/review structure
- **Git Workflow**: Relies on Codev's existing git commit conventions

## References

- Current TICK Protocol: `codev-skeleton/protocols/tick/protocol.md`
- Current SPIR Protocol: `codev-skeleton/protocols/spir/protocol.md`
- Spec Template: `codev-skeleton/protocols/spir/templates/spec.md`
- Plan Template: `codev-skeleton/protocols/spir/templates/plan.md`

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Specs become too large with many TICKs | Medium | Medium | Document guideline: >5 TICKs suggests need for new spec |
| Merge conflicts on popular specs | Medium | High | Use clear commit messages, encourage small atomic TICKs |
| Confusion about when to use TICK vs SPIR | Low | High | Clear decision framework in docs, examples in protocol |
| Loss of historical standalone TICKs | Low | Low | Grandfather existing TICKs, migration is optional |

## Notes

### CLI Changes Required

- **`codev tick list <spec-id>`**: New command to list all TICKs for a spec
- Other CLI tools (consult, af) may need minor updates - to be determined in planning phase

### Design Rationale

The key insight driving this spec: **TICKs are not small SPIRs - they're amendments to existing SPIRs**.

This reframing simplifies the mental model:
- SPIR = Create new feature
- TICK = Refine existing feature

It also aligns with how developers naturally think: "This spec needs a small update" is different from "I need to write a new spec."

### Resolved Design Questions

- **Multi-agent consultation during spec/plan phases?** Keep at review-only, unless user explicitly requests more
- **TICK budget per spec?** No - unnecessary complexity
- **Collapsible amendment sections?** Not relevant to this spec
