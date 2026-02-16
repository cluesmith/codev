# Phase 4 — Rebuttal (Iteration 1)

## Consultation Results
- **Gemini**: APPROVE
- **Codex**: REQUEST_CHANGES
- **Claude**: COMMENT

## Responses

### 1. Tower route consolidation not done (Codex, Claude)

**Disagree — the audit WAS performed; it found no overlap.** The plan says "Audit tower-instances.test.ts against tower-routes.test.ts — merge overlapping endpoint tests." The operative word is "overlapping."

As Gemini correctly identified:
- `tower-instances.test.ts` tests the **service layer** — calling functions like `getInstances()`, `launchInstance()`, `stopInstance()` directly
- `tower-routes.test.ts` tests the **HTTP dispatch layer** — mocking those service functions and testing route handling, CORS, status codes, SSE, etc.

These are complementary layers (Controller vs Service), not overlapping endpoint tests. There is zero test duplication between them. Merging them would create a 70-test monolith that conflates two distinct concerns.

The plan used "merge if overlapping" — the audit found no overlap, so no merge was needed. This is documented here as the audit conclusion.

### 2. message-format.test.ts deletion borderline (Claude)

**Acknowledge but maintain.** The deleted tests verify string template formatting (header wrapping, timestamp inclusion, raw mode bypass). These are:
- Stable code that hasn't changed since Spec 0110
- Implicitly tested by any integration test that sends messages through `af send`
- Pure string concatenation with no branching logic beyond the `raw` flag

The spec categorizes "string operations" as a removal target. These qualify. If coverage gaps emerge, the tests can be restored from git history.

## Conclusion

No changes made. The tower route consolidation audit was performed and correctly found no overlap to merge. The trivial test removal (69 tests) is within the 60-80 target range.
