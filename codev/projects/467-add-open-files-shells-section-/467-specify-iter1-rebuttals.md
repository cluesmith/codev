# Rebuttal: Spec 467 — Specify Iteration 1

## Gemini (APPROVE)

**Feedback**: Missing `relativePath` in API, initial `lastDataAt` state, `status` field redundancy.

**Response**: All three points accepted and incorporated into the updated spec:
- Relative path: Noted that `Annotation.file` provides absolute paths; relative path to be computed from workspace root (Constraints section).
- Initial `lastDataAt`: Specified `Date.now()` at session creation so new shells default to "running" (Assumptions section).
- `status` field removed: Frontend computes status from `lastDataAt` — no redundant backend field (Approach 1 description + Open Questions).

## Codex (REQUEST_CHANGES)

**Feedback**: Missing definitions for relative path base, idle time display format, status indicator specifics, fallback behavior for absent `lastDataAt`.

**Response**: All points addressed in updated spec:
- **Relative path base**: Defined as workspace root (Constraints section: "Annotation.file provides absolute paths; relative path must be computed from workspace root").
- **Idle time display format**: Defined as compact relative ("2m", "1h") without "ago" suffix (Open Questions section, resolved).
- **Status indicator specifics**: Green dot for running, gray dot for idle (Success Criteria section).
- **Fallback for absent `lastDataAt`**: Treats as idle gracefully (Test Scenarios item 8, Risks table).
- **Unit vs E2E split**: Functional tests are unit-level; non-functional tests include E2E (Test Scenarios section).

## Claude (COMMENT)

**Feedback**: Polling interval error (2.5s → 1s), `lastInputAt` already exists, tab ID mapping ambiguity, section render pattern ambiguity.

**Response**: All four findings accepted and corrected:
- **Polling interval**: Fixed to 1s (`POLL_INTERVAL_MS = 1000`) throughout spec.
- **`lastInputAt` acknowledged**: Added to Current State, Constraints, and Open Questions with explicit rationale for output-based (`lastDataAt`) vs input-based tracking.
- **Tab ID mapping**: Specified `util.id` for shells and `annotation.id` for files (verified from `useTabs.ts`).
- **Section render pattern**: Explicitly stated "Recently Closed" pattern (hidden when empty).
