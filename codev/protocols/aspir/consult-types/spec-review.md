# Specification Review Prompt

## Context
You are reviewing a feature specification during the Specify phase. Your role is to ensure the spec is complete, correct, and feasible before it moves to human approval.

## Baked Decisions

If the issue body or the spec's Constraints section includes content under a "Baked Decisions" heading, the architect has marked those choices as fixed. Do not autonomously challenge them: do not propose alternative languages, frameworks, deployment shapes, or dependencies that contradict a baked decision. You may `COMMENT` with concerns about a baked decision (the architect decides whether to rescind it); reserve `REQUEST_CHANGES` for the case where the spec **fails to honor** a stated baked decision — that is a real defect.

If the baked decisions themselves contain contradictions (e.g., two different language choices), do not pick one — `REQUEST_CHANGES` and ask the architect to clarify before proceeding.

## Focus Areas

1. **Completeness**
   - Are all requirements clearly stated?
   - Are success criteria defined?
   - Are edge cases considered?
   - Is scope well-bounded (not too broad or vague)?

2. **Correctness**
   - Do requirements make sense technically?
   - Are there contradictions?
   - Is the problem statement accurate?

3. **Feasibility**
   - Can this be implemented with available tools/constraints?
   - Are there obvious technical blockers?
   - Is the scope realistic for a single spec?

4. **Clarity**
   - Would a builder understand what to build?
   - Are acceptance criteria testable?
   - Is terminology consistent?

5. **Structure**
   - The specify prompt delivers a canonical spec template (`protocols/spir/templates/spec.md`) inline. Does the spec actually follow it?
   - Required headings, in order: `## Metadata`, `## Clarifying Questions Asked`, `## Problem Statement`, `## Current State`, `## Desired State`, `## Stakeholders`, `## Success Criteria`, `## Constraints`, `## Assumptions`, `## Solution Approaches`, `## Open Questions`, `## Performance Requirements`, `## Security Considerations`, `## Test Scenarios`, `## Dependencies`, `## References`, `## Risks and Mitigation`, `## Expert Consultation`, `## Approval`, `## Notes`.
   - A free-form spec that reads well but ignores the template is a **defect**, not a style preference — it usually means the builder pattern-matched an older spec in `codev/specs/` instead of the delivered template. `REQUEST_CHANGES` for a wholesale departure (most headings missing or renamed).
   - A section that genuinely does not apply may be reduced to a one-line "N/A — [reason]", but the heading should remain. Do not `REQUEST_CHANGES` over one such section.

## Verdict Format

After your review, provide your verdict in exactly this format:

```
---
VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary of your assessment]
CONFIDENCE: [HIGH | MEDIUM | LOW]
---
KEY_ISSUES:
- [Issue 1 or "None"]
- [Issue 2]
...
```

**Verdict meanings:**
- `APPROVE`: Spec is ready for human review
- `REQUEST_CHANGES`: Significant issues must be fixed before proceeding
- `COMMENT`: Minor suggestions, can proceed but consider feedback

## Notes

- You are NOT reviewing code - you are reviewing the specification document
- Focus on WHAT is being built, not HOW it will be implemented (that's for plan review)
- Be constructive - identify issues AND suggest solutions
- If the spec references other specs, note if context seems missing
