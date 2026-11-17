# Phase 4 iter1 rebuttal

Verdicts: Gemini APPROVE, Codex REQUEST_CHANGES, Claude COMMENT.

## Codex (REQUEST_CHANGES)

1. **Non-git fallback ignores the root `.gitignore`, against the approved plan.** Accepted;
   changed. `snapshotFilesystem` now honours the root `.gitignore` (and still skips `.git/`
   and `node_modules/`), so the non-git scope matches the git scope main ruled for this
   project (gitignored paths are not watched). The ignore compiler moved from
   `governance-bootstrap.ts` into `lib/tree-snapshot.ts`, so both walks share it. Its known
   imprecision (skipped `!` negations, a `**` between path segments can over-match) can only
   ignore more than git would; that is now stated in its doc comment and the module's "what
   it cannot see" note. The summary's scope line names the root `.gitignore`. New test:
   `skips .git/, node_modules/ and root-gitignored paths`.

2. **Permanently skipping an unrelated flaky test.** Kept, by design. The builder role's
   flaky-test rule says to skip a pre-existing, intermittent test that is unrelated to the
   change, annotate it as flaky, and document it under `## Flaky Tests` in the review. That
   is what I did. `session-manager.test.ts` "no stderr tail logged for file-based stderr
   (Bugfix #324)" timed out waiting for `session-exit` in 2 of 4 local full-suite runs, once
   also when run on its own; nothing on this branch touches `src/terminal/`. It was already
   skipped under CI, so CI coverage is unchanged. Leaving it active would make porch's test
   check fail at random for every remaining phase. The fix belongs to its own issue; the
   review doc and the PR will ask the architect to track it.

3. **No 100 KB prompt-size guard.** Accepted; added. `MAX_PROMPT_BYTES = 100_000`. A
   rendered prompt over that size takes the existing manual fallback (prompt file plus
   instructions) with the reason, instead of failing the spawn with E2BIG. New test: a
   skeleton whose template alone exceeds the limit ⇒ `manual`, nothing spawned, prompt file
   written.

## Claude (COMMENT)

1. **Prompt-size guard.** Same as Codex 3; added. A spawn error now also prints where the
   prompt is saved.
2. **`defaultDeps()` resolved the built skeleton even when tests override it.** Fixed:
   `skeletonDir` is resolved only when not overridden
   (`overrides.skeletonDir ?? getTemplatesDir()`), so `bootstrap-docs.test.ts` needs no
   prior build, as its header says.
3. **Non-git mode cannot see a `git init` + commit during the session.** Stated: the scope
   line now says a repository created during the session is not seen, and the module's
   "cannot see" note says why (`.git/` is skipped).
4. **`describePermissions` called restrictive flags a bypass.** Fixed. Only known bypass
   forms (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
   `--yolo`, `--permission-mode=bypassPermissions`, including the split
   `--permission-mode bypassPermissions` form) produce "will NOT ask". Other permission flags
   are listed with "see your agent's documentation for what they allow". New test covers
   `--permission-mode plan`.
5. **A declined run leaves the prompt file unmentioned.** Fixed: both decline paths (non-TTY
   and "no") say where the prompt is saved.
6. **`.gitignore` deviation.** Resolved by following the plan (Codex 1).
