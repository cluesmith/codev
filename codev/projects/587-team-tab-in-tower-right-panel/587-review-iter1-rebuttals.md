# Rebuttal: PR Review — Iteration 1

## Codex (REQUEST_CHANGES)

**Issue 1**: Gate approval false positives — `status.yaml` mtime changes on any update, not just approval, causing re-emission of "Gate approved" events.
**Resolution**: ACKNOWLEDGED as a known limitation, acceptable for v1. The `approved: true` regex is strict — phase transitions that don't set this field won't trigger it. The only false positive scenario is a non-approval edit to `status.yaml` after an approval within the same hour, which is a narrow edge case. Follow-up item added to review doc for future improvement (explicit approval timestamp or last-seen tracking).

**Issue 2**: `detectAuthor()` can return empty string from `git config user.name`.
**Resolution**: FIXED. Added empty-string check after `git config user.name` — falls through to `'unknown'` default when result is empty.

**Issue 3**: E2E tests don't validate member card rendering or message ordering.
**Resolution**: ACKNOWLEDGED. The 4 E2E tests validate the API contract and tab visibility logic, which are the core integration points. Detailed rendering assertions are fragile against CSS/layout changes. The 38 unit tests in `team.test.ts` cover message parsing order, and the `TeamView.tsx` component renders data directly from the API response. Adding rendering assertions is a nice-to-have for future hardening.

## Gemini (APPROVE)
No blocking issues.

## Claude (APPROVE)
No blocking issues. Performance note about `hasTeam()` on every poll acknowledged — lightweight for small teams, follow-up for optimization if needed.
