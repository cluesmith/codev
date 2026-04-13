# Rebuttal — Phase pr_exists_fix iter1

## Codex (REQUEST_CHANGES)

1. **GitLab missing `--all`** — Fixed. Added `--all` flag to `glab mr list`.
2. **Gitea `--fields index` missing fields** — The `--fields` flag controls column display, not JSON output; `--output json` returns full objects regardless. But Gitea's `tea pulls list` defaults to open-only, so added `--state all` to fetch all states.
3. **Tests too shallow** — Accepted partially. Added assertions for GitLab (`--all`) and Gitea (`--state all`) state-fetching flags. Full behavioral tests (mocking CLI output) would require jq in CI and are disproportionate for 3-line shell scripts. The static tests guard against regressions.

## Gemini (REQUEST_CHANGES)

1. **GitLab `--all`** — Fixed. Same as Codex issue 1.
2. **Gitea `--state all`** — Fixed. Same as Codex issue 2.
3. **Tests should assert all forges fetch all states** — Fixed. Added per-forge assertions.

## Claude (APPROVE)

Noted the GitLab/Gitea gap as pre-existing and non-blocking. Fixed it anyway since 2/3 reviewers flagged it.
