# Rebuttal: Plan 467 — Plan Iteration 1

## Gemini (APPROVE)
No issues raised. Plan approved as-is.

## Codex (REQUEST_CHANGES)

**Issue 1: Relative path derivation underspecified**
- **Action**: Fixed. Specified deterministic algorithm: basename + parent directory (e.g., `components/App.tsx`). Full path as tooltip. No dependency on workspace name string matching.

**Issue 2: Missing Playwright testing requirement**
- **Action**: Fixed. Added explicit Playwright E2E test requirement with reference to `codev/resources/testing-guide.md`.

## Claude (COMMENT)

**Issue 1: Inline type omission at tower-routes.ts:~1341**
- **Action**: Fixed. Added explicit deliverable and acceptance criterion for updating the inline type literal.

**Issue 2: Relative path algorithm underspecified**
- **Action**: Fixed. Same as Codex issue 1 — specified basename + parent directory algorithm.

**Issue 3: New test file not mentioned**
- **Action**: Fixed. Noted that `pty-session.test.ts` must be created, with node-pty mocking requirement.

**Issue 4: Time mocking for idle tests**
- **Action**: Fixed. Specified `vi.useFakeTimers()` for deterministic time control in idle threshold tests.

**Additional observation: Shellper replay bypasses onPtyData**
- **Action**: Documented in plan. This is fine — `lastDataAt` initializes to `Date.now()` so new sessions start as "running" regardless.
