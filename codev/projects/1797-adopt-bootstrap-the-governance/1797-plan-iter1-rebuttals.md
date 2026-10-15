# Plan iter1 rebuttals / dispositions

Gemini: APPROVE. Codex: REQUEST_CHANGES. Claude: REQUEST_CHANGES. Every claim was checked against the code before acting.

## Codex
1. Missing files eligible: ACCEPTED. Missing is now its own class and is not eligible; the command tells the user to run `codev update`, then re-run. (Claude had praised the opposite choice; the spec's predicate decides it.)
2. Non-git source changes undetected: ACCEPTED. `lib/tree-snapshot.ts` adds a filesystem-walk snapshot for non-git dirs, with its own test.
3. Four-copy parity not enforced: ACCEPTED (verified: `TOUCHED_SKILLS = ['runnable-worktrees', 'codev']`). Add `update-arch-docs`.
4. Classifier too broad: ACCEPTED. Lines must match verbatim (CRLF→LF only), all from a single starter version. Tests added for both.

## Claude
1. Map rule fails our own lessons fixture: ACCEPTED (verified: `## Critical (Prevent Major Failures)` vs `- Critical — …`). Rule is now name part vs full heading or short name (truncated at ` (`, `: `, ` — `), and must resolve to exactly one section.
2. change-snapshot duplicates tree-tripwire: ACCEPTED (verified exports). Generic core moves to `lib/tree-snapshot.ts`; consult re-exports; no separate index fingerprint.
3. Parity: same as Codex 3.
4. Fallback unreachable due to the Claude default: ACCEPTED. `resolveInteractiveTaskLauncher` requires positive identification (explicit built-in harness or detected built-in).
5. adopt test mocks: ACCEPTED. Both mock changes are named in the adopt/update phase.
6. `.claude/settings.local.json` false positive: ACCEPTED as an informational exemption list (named constant), not exit-bearing.
- Minor: `codev/templates/` is not a full mirror. Template is now skeleton-only, with the reason given. framework-ref check is marked as manual. Phase 4 is split: the consult step is its own phase (5).

## Gemini (advisory)
- No-commit `git log`: handled with a `rev-parse --verify HEAD` guard.
- Bare `- Section` map entry: valid under the new rule, with a test.
- Command tokenisation: reuses the architect.ts split / array form.
- Next-steps ordering: moved to the end of adopt.
