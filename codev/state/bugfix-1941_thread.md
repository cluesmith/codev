# bugfix-1941 thread

## Investigate (2026-11-20)

All five points from #1941 located and reproduced against the source (and, for point 1, the real `claude` 2.1.330):

1. **api-key logged-out advice.** `assertLoggedIn` (`lib/claude-cli.ts`) always says ``Run `claude auth login` `` whatever the mode. Probed the real CLI: with a key set, `auth status --json` reports `loggedIn: true` (even for a bogus key), so the preflight branch is defensive today; a print-mode run with no login ends with result `"Not logged in · Please run /login"` (`is_error: true`, subtype `success`), and `classifyClaudeRun` quotes that CLI text with no mode-aware remedy. A bogus key ends with `"Invalid API key · Fix external API key"` (401). Fix: one `claudeLoginRemedy(mode, source)` used by both the preflight and the review-result path, when the result says logged out.
2. **Tool-guard duplicates.** `startClaudeReview`'s init guard also checks `tools.length !== CLAUDE_REVIEW_TOOLS.length`, so `['Glob','Grep','Read','Read']` aborts. An existing test codifies this. Fix: compare as sets; extra and missing still abort.
3. **Install hint.** `CLAUDE_INSTALL_HINT` is curl only. Fix: a fragment naming both routes, like `CLAUDE_UPDATE_HINT`.
4. **Caps.** `CLAUDE_MAX_TURNS`/`CLAUDE_MAX_BUDGET_USD` are module constants. Fix: `consult.claudeMaxTurns` (positive integer) and `consult.claudeMaxBudgetUsd` (positive number), validated at config load like `claudeAuth`, defaults 200 / 25, cap messages name the key.
5. **Docs.** README/INSTALL lack the 2.1.141 floor; consult.md (both twins) and the consult SKILL.md copies describe withholding the key without saying it is a billing guarantee, not secrecy.

Scope: small, fits BUGFIX.

## Fix (2026-11-20)

Two commits: Fix (0555ab16d) and Test (5f2249cac).

- `claudeLoginRemedy(mode, source)` in `lib/claude-cli.ts`: login → ``Run `claude auth login`.``; api-key → names `consult.claudeAuth` and its file, says to check the key or remove the setting. Used by `assertLoggedIn` (now takes `{ mode, modeSource, withheld }`; preflight and doctor pass the mode) and by `classifyClaudeRun` when an error result matches `not logged in|run /login`. `ClaudePreflight` gained `modeSource`.
- Tool guard: dropped the length check, so the comparison is set-based. Extra and missing still abort. The old test that codified the duplicate abort became "duplicate + extra aborts on the extra", plus a success test for the duplicate alone.
- `CLAUDE_INSTALL_HINT` is now a fragment naming curl and npm, like `CLAUDE_UPDATE_HINT`.
- `consult.claudeMaxTurns` (positive integer) / `consult.claudeMaxBudgetUsd` (positive number): validated at config load in `consult-lanes.ts`; `resolveClaudeReviewCaps` feeds `buildClaudeReviewArgs` and the cap-reached messages, which name the value and the key. `null` is the config system's "delete this key", so it means default and is not asserted as an error.
- Docs: README/INSTALL got the 2.1.141 floor; consult.md (both twins), consult SKILL.md (all four copies) and the arch.md lane row say withholding is a billing guarantee, not secrecy; consult.md documents the new keys.

Regression check: with the five source files reverted to pre-fix, 25 of the new/updated tests fail across all four code points; with the fix, the three targeted files pass (209 passed, 1 skipped).

Noted, not changed: a lane-level bad config throws in `resolveLaneModelChoice` before the lane's try block, so a direct `runClaudeConsultation` call leaves a stale `--output` file. The same is true for a bad `claudeAuth` today; real `consult` loads config before any lane runs.

## Blocked on porch `tests` under machine load (2026-11-20)

First full run: `skill-refresh` failed for a real reason (my SKILL.md edit needs `generate-skill-hashes`), fixed in 4877866f5. After that, three porch `tests` runs at load average 35–54 (the load is from other workspaces, chiefly a `shannon` builder's python process) each failed a different, unrelated test, and each passes alone:

- `src/__tests__/windows-console-spawn-guard.test.ts` (static spawn scan; 3.4s alone)
- `src/agent-farm/__tests__/ide-command.test.ts` (11.6s in the full run; 21/21 alone)
- `src/agent-farm/__tests__/bugfix-1267-launch-loop.test.ts` (21.1s in the full run; 7/7 alone)

The build check passes. Asked the architect whether to retry once load drops.

Architect ruling: retry once when the 1-minute load average is below 18, run the three failed tests alone as evidence, and stop on another unrelated failure.
- Alone, once each (load 29–31): windows-console-spawn-guard 7/7, ide-command 21/21, bugfix-1267-launch-loop 7/7.
- One porch run at 18:15, load 14.02 at start and 38.61 at end (the suite raises it): build ✓, tests ✗ on `src/commands/consult/__tests__/agy-auth-cache.test.ts` (27.2s). It references nothing this change touched and passes alone (27/27). Stopped and reported, per the ruling.

CI on draft PR #1942: 8/8 checks green; the Unit Tests job ran the full codev suite (403 files passed, 12 skipped), all four locally failing tests included. Phase not advanced; waiting for the owner's decision on whether CI stands in for the local check.

## Owner ruling main-28 (2026-11-23): CI stands in for the local tests check

For this phase of this project only: GitHub's green run on draft PR #1942 at head 30be01278 replaces porch's local `tests` check. Applied as instructed: `porch.checks.tests.skip = true` added to this worktree's gitignored `.codev/config.local.json`, `porch done` run once (load 10.09; build ✓, tests skipped, advanced to `pr`), and the file restored byte-for-byte straight after. Nothing under `.codev` is staged or committed. The shared `.codev/config.json` was not touched.

## PR phase: CMAP iteration 1 (2026-11-23)

- **codex: REQUEST_CHANGES**, branch hygiene only; it found no code defects.
  - "39 commits behind main": rebutted. Branch protection is not strict (`strict: false`), GitHub reports the PR `MERGEABLE`, and the `pull_request` CI tests the merge with current `main`.
  - "`chore(porch):` commits off-format": rebutted. They are porch's own state commits, the standard form on `main` (28 of the last 60 commits).
- **claude: REQUEST_CHANGES**, one real finding, **fixed** in 23767926f: `consult-readonly-review.e2e.test.ts:214` called `buildClaudeReviewArgs` without the now-required `caps`. `tsconfig` excludes `__tests__` and vitest excludes `*.e2e.test.ts`, so neither the build nor CI could see it. Verified with an ad-hoc tsc over the touched test files: the pre-fix line gives TS2345 and the fixed file is clean. The three `doctor.test.ts` errors that check reports are pre-existing spawnSync mock types, present both ways.
  - Declined as cosmetic: naming the config file in the cap message (it stays `.codev/config.json`), and naming the specific key in the api-key remedy (the auth line printed just above already names the credential in use).
  - Declined as out of scope: the floor in `INSTALL.md:390` (the `codev import` requirement), `arch.md:1691` and `DEPENDENCIES.md` (whose consult-lane row already states 2.1.141).
- Not re-running CMAP: the only change is a one-line test fix.
