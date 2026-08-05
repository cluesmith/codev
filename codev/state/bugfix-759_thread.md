# bugfix-759 — forge pr-search defaults to open PRs only

## Investigate (complete)

**Bug**: After a PR merges, `consult --type pr` post-merge lookup fails with
`No PR found for branch: ...`. Works pre-merge, breaks post-merge.

**Root cause**: `packages/codev/scripts/forge/github/pr-search.sh` runs
`gh pr list --search "$CODEV_SEARCH_QUERY" ...` with no `--state`. `gh pr list`
defaults to `--state open` (verified: `gh pr list --help` shows
`--state string ... (default "open")`). Merged PRs are excluded.

**Fix shape**: add `--state all` to the `gh pr list` call — mirrors the exact
precedent in `github/pr-exists.sh` (bugfix #568) and its regression test
`bugfix-568-pr-exists-state-all.test.ts`.

**Scope beyond github**: the `pr-search` concept also exists for gitlab
(`gitlab/pr-search.sh`) with the identical latent defect — `glab mr list --search`
defaults to opened. The established gitlab all-states flag is `--all` (see
`gitlab/pr-exists.sh`). Fixing both providers, same as #568 fixed all providers.
No gitea `pr-search.sh` exists. Only two copies of the script in the repo (no
codev-skeleton duplicate — these scripts live under `packages/codev/scripts/`).

**Size**: 2 one-line script edits + 1 regression test. Well within BUGFIX scope.

**Caller**: `packages/codev/src/commands/consult/index.ts` (findPrForBranch /
findPrForIssue) → `executeForgeCommandSync('pr-search', ...)`.
