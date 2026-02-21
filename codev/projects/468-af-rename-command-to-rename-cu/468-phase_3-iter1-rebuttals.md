# Phase 3 Rebuttal — Iteration 1

## Codex REQUEST_CHANGES

### 1. Empty-name handling
**Status: FIXED**
Added client-side validation in `rename.ts`: `if (!options.name || options.name.trim().length === 0)` with `fatal('Name is required. Usage: af rename <name>')`. This catches empty strings before hitting the server.

### 2. Error message phrasing
**Status: FIXED**
Changed to use hardcoded spec-matching messages instead of deferring to server `error` strings:
- Missing session: `"Not running inside a shellper session"` (exact spec text)
- 400: `"Name must be 1-100 characters"`
- 403: `"Cannot rename builder/architect terminals"`
- 404: `"Session not found — it may have been closed"` (with em dash)
- 0: `"Tower is not running"`

### 3. Tests don't exercise the actual function
**Status: ACKNOWLEDGED (no change)**
The `rename()` function calls `fatal()` → `process.exit(1)` and reads `process.env`, making direct invocation tests fragile and reliant on process mocking. The contract tests verify the logic pieces (env var parsing, port fallback, status-to-message mapping). Combined with Phase 2's comprehensive server-side handler tests, end-to-end coverage is adequate. Gemini and Claude both approved the test approach. Integration testing requires a running Tower instance and is better suited for manual/E2E tests.
