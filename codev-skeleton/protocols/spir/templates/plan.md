# Plan: [Title]

## Metadata
- **ID**: plan-[YYYY-MM-DD]-[short-name]
- **Status**: draft
- **Specification**: [Link to codev/specs/spec-file.md]
- **Created**: [YYYY-MM-DD]

## Executive Summary
[Brief overview of the implementation approach chosen and why. Reference the specification's selected approach.]

## Success Metrics
[Copy from specification and add implementation-specific metrics]
- [ ] All specification criteria met
- [ ] Test coverage >90%
- [ ] Performance benchmarks achieved
- [ ] Zero critical security issues
- [ ] Documentation complete

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "Phase 1 Title Here"},
    {"id": "phase_2", "title": "Phase 2 Title Here"},
    {"id": "phase_3", "title": "Phase 3 Title Here"}
  ]
}
```

## Phase Breakdown

### Phase 1: [Descriptive Name]
**Dependencies**: None

#### Objectives
- [Clear, single objective for this phase]
- [What value does this phase deliver?]

#### Deliverables
- [ ] [Specific deliverable 1]
- [ ] [Specific deliverable 2]
- [ ] [Tests for this phase]
- [ ] [Documentation updates]

#### Implementation Details
[Specific technical approach for this phase. Include:
- Key files/modules to create or modify
- Architectural decisions
- API contracts
- Data models]

#### Acceptance Criteria
- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]
- [ ] All tests pass
- [ ] Code review completed

#### Test Plan
- **Unit Tests**: [What to test]
- **Integration Tests**: [What to test]
- **Manual Testing**: [Scenarios to verify]

#### Rollback Strategy
[How to revert this phase if issues arise]

#### Risks
- **Risk**: [Specific risk for this phase]
  - **Mitigation**: [How to address]

---

### Phase 2: [Descriptive Name]
**Dependencies**: Phase 1

[Repeat structure for each phase]

---

### Phase 3: [Descriptive Name]
**Dependencies**: Phase 2

[Continue for all phases]

## Dependency Map
```
Phase 1 ──→ Phase 2 ──→ Phase 3
             ↓
         Phase 4 (optional)
```

## Resource Requirements
### Development Resources
- **Engineers**: [Expertise needed]
- **Environment**: [Dev/staging requirements]

### Infrastructure
- [Database changes]
- [New services]
- [Configuration updates]
- [Monitoring additions]

## Integration Points
### External Systems
- **System**: [Name]
  - **Integration Type**: [API/Database/Message Queue]
  - **Phase**: [Which phase needs this]
  - **Fallback**: [What if unavailable]

### Internal Systems
[Repeat structure]

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| [Risk 1] | L/M/H | L/M/H | [Strategy] | [Name] |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| [Risk 1] | L/M/H | L/M/H | [Strategy] | [Name] |

## Validation Checkpoints
1. **After Phase 1**: [What to validate]
2. **After Phase 2**: [What to validate]
3. **Before Production**: [Final checks]

## Monitoring and Observability
### Metrics to Track
- [Metric 1: Description and threshold]
- [Metric 2: Description and threshold]

### Logging Requirements
- [What to log and at what level]
- [Retention requirements]

### Alerting
- [Alert condition and severity]
- [Who to notify]

## Documentation Updates Required
- [ ] API documentation
- [ ] Architecture diagrams
- [ ] Runbooks
- [ ] User guides
- [ ] Configuration guides

## Post-Implementation Tasks
- [ ] Performance validation
- [ ] Security audit
- [ ] Load testing
- [ ] User acceptance testing
- [ ] Monitoring validation

## Expert Review
**Date**: [YYYY-MM-DD]
**Model**: [Model consulted]
**Key Feedback**:
- [Feasibility assessment]
- [Missing considerations]
- [Risk identification]
- [Alternative suggestions]

**Plan Adjustments**:
- [How the plan was modified based on feedback]

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| [Date] | [What changed] | [Why] | [Who] |

## Notes
[Additional context, assumptions, or considerations]

---

## Amendment History

This section tracks all TICK amendments to this plan. TICKs modify both the spec and plan together as an atomic unit.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->

<!--
### TICK-001: [Amendment Title] (YYYY-MM-DD)

**Changes**:
- [Phase added]: [Description of new phase]
- [Phase modified]: [What was updated]
- [Implementation steps]: [New steps added]

**Review**: See `reviews/####-name-tick-001.md`

---
-->