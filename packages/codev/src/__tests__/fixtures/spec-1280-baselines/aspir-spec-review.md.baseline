# Specification Review Prompt

## Context

You are reviewing a feature specification during the Specify phase, before it goes to human approval. Judge whether the spec is complete, correct, feasible, and clear enough for a builder to plan from.

## Baked Decisions

If the issue body or the spec's Constraints section includes content under a "Baked Decisions" heading, the architect has marked those choices as fixed. Do not autonomously challenge them: do not propose alternative languages, frameworks, deployment shapes, or dependencies that contradict a baked decision. You may `COMMENT` with concerns about a baked decision (the architect decides whether to rescind it); reserve `REQUEST_CHANGES` for the case where the spec **fails to honor** a stated baked decision — that is a real defect.

If the baked decisions themselves contradict each other (e.g., two different language choices), do not pick one — `REQUEST_CHANGES` and ask the architect to clarify before proceeding.

## Focus Areas

- **Completeness** — requirements, success criteria, and edge cases are stated; scope is bounded, not vague.
- **Correctness** — the requirements are technically sound and internally consistent; the problem statement is accurate.
- **Feasibility** — implementable within the stated tools and constraints, with no obvious blockers.
- **Clarity** — a builder would know what to build; acceptance criteria are testable; terminology is consistent.
- **Structure** — the spec follows the delivered template (`protocols/spir/templates/spec.md`), which the specify prompt inlines. A spec that ignores the template's headings — usually because the builder pattern-matched an older spec in `codev/specs/` — is a defect: `REQUEST_CHANGES` for a wholesale departure (most headings missing or renamed). A single genuinely-inapplicable section reduced to a one-line "N/A — [reason]" with its heading kept is fine, not grounds for `REQUEST_CHANGES`.

You are reviewing the specification (WHAT is built), not code or implementation (HOW) — that is the plan and implementation reviews. Be constructive: name the issue and suggest a fix.

## Verdict Format

Provide your verdict in exactly this format — `consult` parses it:

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

- `APPROVE`: spec is ready for human review.
- `REQUEST_CHANGES`: significant issues must be fixed first.
- `COMMENT`: minor suggestions; can proceed but consider the feedback.
