# Specification: [Title]

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.

DO NOT include in this spec:
- Implementation phases or steps
- File paths to modify
- Code examples or pseudocode
- "First we will... then we will..."

These belong in codev/plans/XXXX-*.md
-->

## Metadata
- **ID**: spec-[YYYY-MM-DD]-[short-name]
- **Status**: draft
- **Created**: [YYYY-MM-DD]

## Clarifying Questions Asked
<!-- Document the questions you asked the user/stakeholder and their answers -->
[List the questions you asked to understand the problem better and the responses received. This shows the discovery process.]

## Problem Statement
[Clearly articulate the problem being solved. Include context about why this is important, who is affected, and what the current pain points are.]

## Current State
[Describe how things work today. What are the limitations? What workarounds exist? Include specific examples.]

## Desired State
[Describe the ideal solution. How should things work after implementation? What specific improvements will users see?]

## Stakeholders
- **Primary Users**: [Who will directly use this feature?]
- **Secondary Users**: [Who else is affected?]
- **Technical Team**: [Who will implement and maintain this?]
- **Business Owners**: [Who has decision authority?]

## Success Criteria
- [ ] [Specific, measurable criterion 1]
- [ ] [Specific, measurable criterion 2]
- [ ] [Specific, measurable criterion 3]
- [ ] All tests pass with >90% coverage
- [ ] Performance benchmarks met (specify below)
- [ ] Documentation updated

## Constraints
### Technical Constraints
- [Existing system limitations]
- [Technology stack requirements]
- [Integration points]

### Business Constraints
- [Timeline requirements]
- [Budget considerations]
- [Compliance requirements]

## Assumptions
- [List assumptions being made]
- [Include dependencies on other work]
- [Note any prerequisites]

## Solution Approaches

### Approach 1: [Name]
**Description**: [Brief overview of this approach]

**Pros**:
- [Advantage 1]
- [Advantage 2]

**Cons**:
- [Disadvantage 1]
- [Disadvantage 2]

**Estimated Complexity**: [Low/Medium/High]
**Risk Level**: [Low/Medium/High]

### Approach 2: [Name]
[Repeat structure for additional approaches]

[Add as many approaches as appropriate for the problem]

## Open Questions

### Critical (Blocks Progress)
- [ ] [Question that must be answered before proceeding]

### Important (Affects Design)
- [ ] [Question that influences technical decisions]

### Nice-to-Know (Optimization)
- [ ] [Question that could improve the solution]

## Performance Requirements
- **Response Time**: [e.g., <200ms p95]
- **Throughput**: [e.g., 1000 requests/second]
- **Resource Usage**: [e.g., <500MB memory]
- **Availability**: [e.g., 99.9% uptime]

## Security Considerations
- [Authentication requirements]
- [Authorization model]
- [Data privacy concerns]
- [Audit requirements]

## Test Scenarios
### Functional Tests
1. [Scenario 1: Happy path]
2. [Scenario 2: Edge case]
3. [Scenario 3: Error condition]

### Non-Functional Tests
1. [Performance test scenario]
2. [Security test scenario]
3. [Load test scenario]

## Dependencies
- **External Services**: [List any external APIs or services]
- **Internal Systems**: [List internal dependencies]
- **Libraries/Frameworks**: [List required libraries]

## References
- [Link to relevant documentation in codev/ref/]
- [Link to related specifications]
- [Link to architectural diagrams]
- [Link to research materials]

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| [Risk 1] | Low/Med/High | Low/Med/High | [How to address] |
| [Risk 2] | Low/Med/High | Low/Med/High | [How to address] |

## Expert Consultation
<!-- Only if user requested multi-agent consultation -->
**Date**: [YYYY-MM-DD]
**Models Consulted**: [e.g., GPT-5 and Gemini Pro]
**Sections Updated**:
- [Section name]: [Brief description of change based on consultation]
- [Section name]: [Brief description of change based on consultation]

Note: All consultation feedback has been incorporated directly into the relevant sections above.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
[Any additional context or considerations not covered above]

---

## Amendments

This section tracks all TICK amendments to this specification. TICKs are lightweight changes that refine an existing spec rather than creating a new one.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->

<!--
### TICK-001: [Amendment Title] (YYYY-MM-DD)

**Summary**: [One-line description of what changed]

**Problem Addressed**:
[Why this amendment was needed - what gap or issue in the original spec]

**Spec Changes**:
- [Section modified]: [What changed and why]
- [New section added]: [Purpose]

**Plan Changes**:
- [Phase added/modified]: [Description]
- [Implementation steps]: [What was updated]

**Review**: See `reviews/####-name-tick-001.md`

---
-->