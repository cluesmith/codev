# Specification: Librarian Role

## Metadata
- **ID**: 0028-librarian-role
- **Protocol**: SPIR
- **Status**: abandoned
- **Created**: 2025-12-04
- **Priority**: medium
- **Superseded By**: 0035-maintain-protocol

## Abandonment Reason

After consultation with Gemini and Codex, decided against adding new roles. Documentation maintenance is absorbed into the MAINTAIN protocol (spec 0035), which is executed by Builders like any other protocol. This keeps the role model simple: Architect, Builder, Consultant.

See `codev/specs/0035-maintain-protocol.md` for the replacement approach.

---

## Original Specification (preserved for reference)

## Problem Statement

Documentation stewardship in Codev is currently handled by the `architecture-documenter` agent, which has a narrow focus: updating `codev/resources/arch.md`. This leaves several documentation concerns unaddressed:

1. **Scope gap**: Only architecture is documented; other knowledge artifacts (specs, plans, reviews, resources) drift out of sync
2. **Reactive only**: The agent is invoked on-demand rather than actively monitoring for inconsistencies
3. **Agent vs Role mismatch**: Documentation maintenance is an ongoing concern, not a bounded task - it fits the "role" pattern better than the "agent" pattern
4. **No ownership**: Unlike Architect (owns orchestration) and Builder (owns implementation), nobody "owns" documentation

The result: documentation debt accumulates, files contradict each other, and knowledge gets siloed.

## Current State

### Architecture-Documenter Agent

Location: `.claude/agents/architecture-documenter.md`

```
Responsibilities:
- Updates codev/resources/arch.md
- Triggered manually after milestones
- No persistent state or ongoing monitoring
```

### Documentation Artifacts (Unmanaged)

| Artifact | Location | Current Owner |
|----------|----------|---------------|
| Architecture doc | `codev/resources/arch.md` | architecture-documenter agent |
| Specs | `codev/specs/*.md` | Authors (no steward) |
| Plans | `codev/plans/*.md` | Authors (no steward) |
| Reviews | `codev/reviews/*.md` | Authors (no steward) |
| Project list | `codev/projectlist.md` | Architect (partial) |
| Agent instructions | `CLAUDE.md`, `AGENTS.md` | Manual sync |
| Conceptual model | `codev/resources/conceptual-model.md` | Ad-hoc |
| Reference materials | `codev/resources/*.md` | Ad-hoc |

### Current Role Structure

```
Architect → Orchestrates projects, spawns Builders, reviews PRs
Builder   → Implements specs in isolation
Consultant → Provides second opinions (external CLI wrapper)
```

Documentation responsibility is diffuse - everyone does some, nobody owns it.

## Desired State

### Librarian Role

A new role in `codev/roles/librarian.md` that owns documentation stewardship:

```
Librarian → Maintains knowledge, ensures consistency, curates resources
```

### Responsibilities

1. **Maintain arch.md**: Update architecture documentation (current agent scope)
2. **Sync instruction files**: Keep CLAUDE.md and AGENTS.md synchronized
3. **Track documentation debt**: Identify specs without reviews, outdated plans, stale resources
4. **Curate resources**: Organize `codev/resources/`, ensure conceptual model stays current
5. **Validate consistency**: Ensure specs, plans, and reviews don't contradict each other
6. **Index knowledge**: Maintain searchable references (what's where, how things connect)

### Integration with Other Roles

| Role | Relationship to Librarian |
|------|---------------------------|
| Architect | Consults Librarian for documentation questions; triggers Librarian after integration |
| Builder | Librarian reviews Builder documentation artifacts in PRs |
| Consultant | Independent (no direct interaction) |

### Invocation Model

The Librarian can be:
1. **Spawned by Architect**: Like a Builder, for documentation-focused work
2. **Consulted ad-hoc**: "Ask the Librarian where X is documented"
3. **Triggered automatically**: Post-integration hook to update documentation

## Stakeholders
- **Primary Users**: Architect agents, Builders seeking documentation
- **Secondary Users**: Human developers onboarding or exploring the codebase
- **Technical Team**: Codev maintainers
- **Business Owners**: Project owner (Waleed)

## Success Criteria

- [ ] `codev/roles/librarian.md` defines the Librarian role
- [ ] Librarian responsibilities are clearly delineated from Architect/Builder
- [ ] Architecture-documenter agent can be deprecated (superseded by Librarian)
- [ ] CLAUDE.md updated with Librarian role and when to use it
- [ ] Librarian can be spawned via `af spawn` (if applicable) or invoked in main conversation
- [ ] Documentation of "documentation debt" tracking approach
- [ ] At least one successful Librarian invocation demonstrated

## Constraints

### Technical Constraints
- Must work within existing agent-farm infrastructure
- Cannot modify external CLIs (gemini, codex)
- Role definition must be portable (not Claude-specific instructions)

### Design Constraints
- Librarian is a steward, not a gatekeeper - enables rather than blocks
- Should be lightweight to invoke (no heavy startup)
- Must coexist with existing architecture-documenter during transition

### Business Constraints
- Should not require significant infrastructure changes
- Must be optional (projects can function without a Librarian)

## Assumptions

- The role pattern (codev/roles/) is the right abstraction for ongoing responsibilities
- Documentation stewardship is valuable enough to warrant a dedicated role
- The Architect-Builder pattern can accommodate a third active role
- Spawning Librarian like a Builder (in worktree) may not be needed - main conversation may suffice

## Solution Approaches

### Approach 1: Pure Role Definition (Recommended)

**Description**: Create `codev/roles/librarian.md` as a role definition, similar to architect.md and builder.md. The Librarian operates in the main conversation when documentation work is needed.

```
codev/roles/
├── architect.md    # Existing
├── builder.md      # Existing
├── consultant.md   # Existing
└── librarian.md    # NEW
```

**When invoked**:
- By Architect after integration: "Invoke the Librarian to update documentation"
- Ad-hoc by user: "What does the Librarian know about X?"
- End of SPIR protocol: Review phase includes Librarian pass

**Pros**:
- Minimal infrastructure change (just a new role file)
- Consistent with existing role pattern
- Can be adopted incrementally
- Deprecates architecture-documenter agent cleanly

**Cons**:
- No isolation (unlike Builder in worktree)
- Relies on Architect to invoke appropriately

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Spawnable Librarian (Like Builder)

**Description**: Librarian can be spawned in a worktree via `af spawn --librarian` for large documentation efforts.

**Pros**:
- Isolation for major documentation overhauls
- Parallel documentation work while development continues
- PR-based review of documentation changes

**Cons**:
- Overkill for most documentation updates
- Additional infrastructure complexity
- May not fit the Librarian's "always available" nature

**Estimated Complexity**: Medium
**Risk Level**: Medium

### Approach 3: Claude Code Agent (Current Pattern)

**Description**: Keep as a Claude Code subagent (like architecture-documenter), but expand scope.

**Pros**:
- No change to role structure
- Familiar pattern

**Cons**:
- Doesn't match the conceptual model (roles vs agents)
- Subagents are for bounded tasks, not ongoing stewardship
- Harder to invoke from Architect context

**Estimated Complexity**: Low
**Risk Level**: Medium (wrong abstraction)

### Recommended Approach

**Approach 1** (Pure Role Definition). The Librarian is fundamentally about ongoing stewardship, which aligns with the "role" abstraction. Spawning in worktrees (Approach 2) can be added later if large documentation efforts warrant it.

## Technical Design

### Role Definition Structure

```markdown
# Role: Librarian

The Librarian is the documentation steward who maintains knowledge consistency
and ensures the codebase remains well-documented and navigable.

## Responsibilities

1. **Architecture Documentation**: Maintain codev/resources/arch.md
2. **Instruction Sync**: Keep CLAUDE.md and AGENTS.md synchronized
3. **Documentation Debt**: Track specs without reviews, outdated plans
4. **Resource Curation**: Organize codev/resources/
5. **Consistency Validation**: Ensure artifacts don't contradict
6. **Knowledge Indexing**: Maintain "what's where" references

## You Are

- A steward and enabler, not a gatekeeper
- Detail-oriented and thorough
- Focused on accuracy and consistency

## You Are NOT

- A code reviewer (that's Architect/Builder)
- A decision maker (you document decisions, not make them)
- A blocker (you flag issues, not reject work)

## When to Invoke the Librarian

- After a project reaches "integrated" status
- When documentation seems stale or inconsistent
- Before major releases (documentation audit)
- When onboarding new team members (knowledge tour)

## Relationship to Other Roles

| Role | Librarian Interaction |
|------|----------------------|
| Architect | Triggers Librarian after integration; consults for documentation questions |
| Builder | Librarian may review documentation in PRs |
| Consultant | No direct interaction |

## Documentation Debt Tracking

The Librarian maintains awareness of:
- Specs without corresponding reviews (incomplete lifecycle)
- Plans that don't match implemented code
- Resources that reference deleted files
- CLAUDE.md sections that don't match AGENTS.md

## Artifacts Owned

| Artifact | Librarian Responsibility |
|----------|-------------------------|
| arch.md | Full ownership (update, validate, maintain) |
| CLAUDE.md / AGENTS.md | Sync responsibility |
| codev/resources/*.md | Curation and organization |
| Specs/Plans/Reviews | Consistency checking (not ownership) |
```

### Deprecation of architecture-documenter

After Librarian role is established:
1. Update CLAUDE.md to reference Librarian instead of architecture-documenter agent
2. Remove `.claude/agents/architecture-documenter.md`
3. Update any automation that invokes the agent

### CLAUDE.md Updates

Add to "## Roles" or similar section:

```markdown
## Librarian Role

The Librarian owns documentation stewardship. Invoke when:
- A project reaches integrated status (post-merge documentation update)
- Documentation seems inconsistent or stale
- Preparing for a release (documentation audit)
- Someone needs to find where something is documented

See `codev/roles/librarian.md` for full role definition.
```

## Open Questions

### Critical (Blocks Progress)
- [x] Role vs Agent: Which abstraction fits? **Answer: Role (per discussion)**
- [ ] Should Librarian be spawnable in worktree? **Defer to later if needed**

### Important (Affects Design)
- [ ] How does Librarian integrate with SPIR Review phase?
- [ ] Should there be a "documentation audit" command/protocol?
- [ ] How to handle CLAUDE.md/AGENTS.md sync mechanically?

### Nice-to-Know (Optimization)
- [ ] Could Librarian maintain a searchable index (like a knowledge graph)?
- [ ] Should Librarian have access to git history for change detection?

## Performance Requirements
- Not applicable (documentation work is inherently slow/thoughtful)

## Security Considerations
- Librarian has read access to all documentation
- No special security concerns beyond normal file access

## Test Scenarios

### Functional Tests
1. Librarian role file exists and is well-formed
2. CLAUDE.md references Librarian role
3. Librarian can identify documentation debt (spec without review)
4. Librarian can update arch.md (replaces architecture-documenter)
5. Librarian can identify CLAUDE.md/AGENTS.md drift

### Integration Tests
1. Architect invokes Librarian after project integration
2. Librarian updates arch.md with new component
3. Librarian flags documentation inconsistency

## Dependencies
- **Internal**: Existing role infrastructure (codev/roles/)
- **Supersedes**: architecture-documenter agent

## References
- `codev/roles/architect.md` - Role definition pattern
- `codev/roles/builder.md` - Role definition pattern
- `.claude/agents/architecture-documenter.md` - Current approach (to be deprecated)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Role underutilized | Medium | Low | Clear invocation triggers in CLAUDE.md |
| Overlap with Architect | Low | Medium | Clear responsibility boundaries |
| Documentation still drifts | Medium | Medium | Periodic "audit" protocol invocation |
| Too heavyweight for small projects | Low | Low | Role is optional, not required |

## Relationship to Project 0027

Project 0027 proposed making architecture-documenter a protocol instead of an agent. This project (0028) supersedes that idea:
- A role is a better fit than either agent or protocol
- The scope expands beyond just arch.md
- Deprecating 0027 in favor of 0028 simplifies the roadmap

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Expert AI Consultation Complete

## Notes

This is a conceptual evolution: from a task-specific agent (architecture-documenter) to a role with ongoing stewardship responsibility (Librarian). The Librarian doesn't block work or make decisions - they ensure knowledge is captured, organized, and accessible.

The name "Librarian" evokes the right mental model: someone who organizes, catalogs, and helps people find information. Not a gatekeeper, but a guide.
