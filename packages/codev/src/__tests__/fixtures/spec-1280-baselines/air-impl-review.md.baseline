# Implementation Review Prompt

## Context

You are reviewing implementation work built under the AIR protocol — a small feature implemented directly from a GitHub issue, with no spec or plan document. Verify it matches the issue and follows good practice; review against the issue, not against artifacts AIR does not produce.

## Verify before flagging

Before requesting changes for missing configuration, wrong patterns, or framework issues, confirm the claim against the project rather than your training data:

- Check `package.json` for the actual dependency versions — framework conventions change between major versions.
- Read the actual config files (or confirm their deliberate absence) before flagging a missing config.

## Baked Decisions

If the issue body includes content under a "Baked Decisions" heading, the architect has marked those choices as fixed. Do not autonomously challenge them: do not propose alternative languages, frameworks, deployment shapes, or dependencies that contradict a baked decision. You may `COMMENT` with concerns about a baked decision (the architect decides whether to rescind it); reserve `REQUEST_CHANGES` for the case where the implementation **fails to honor** a stated baked decision — that is a real defect.

If the baked decisions themselves contradict each other, do not pick one — `REQUEST_CHANGES` and ask the architect to clarify before proceeding.

## Focus Areas

- **Issue Adherence** — the implementation fulfills the issue's requirements and acceptance criteria.
- **Code Quality** — readable and maintainable; no obvious bugs; error cases handled.
- **Test Coverage** — tests are adequate and cover main paths and edge cases.
- **Scope** — the change stays focused on the issue and under ~300 LOC; if larger, it should escalate to ASPIR.

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

- `APPROVE`: implementation looks good, ready for PR.
- `REQUEST_CHANGES`: issues that must be fixed.
- `COMMENT`: minor suggestions; can proceed but note the feedback.

AIR has no spec or plan — review against the GitHub issue, and judge "does this feature work correctly", not "is this architecturally perfect".
