#!/bin/sh
# Forge concept: pr-exists (Gitea via tea CLI)
# forge-executable: tea
# Input: CODEV_BRANCH_NAME
# Output: "true" or "false"
#
# Returns true for OPEN or MERGED pulls only; closed-not-merged pulls are
# excluded. `tea pulls list` emits `.head` as a string (not `{ref}`) and reports
# merged PRs as state "merged" with no `.merged` boolean, so its output can't
# satisfy the `.head.ref` / `.merged` predicate below. Route through the raw
# REST passthrough, whose PR objects carry nested `.head.ref` and a `.merged`
# bool. `tea api` needs an explicit owner/repo in the path (unlike `tea pulls`,
# which auto-detects it from the local git remote), so resolve it here: honor
# CODEV_REPO when set, else derive owner/repo from origin's URL (handles https,
# ssh, and scp-style remotes, with or without a .git suffix).
#
# Caveat (Gitea behavior, not a codev bug): for a merged PR whose source branch
# was deleted, Gitea returns `.head.ref == "refs/pull/N/head"` instead of the
# original branch name, so a branch-name match won't hit a merged+deleted
# branch. That doesn't affect the "does an open/merged PR exist for the branch
# I'm about to push" use case.
#
# `state=all` is paginated (Gitea caps a page at max_response_items, default 50)
# so a branch whose PR isn't in the most recent ~50 would false-negative and
# block a porch pr_exists gate — tea_api_paged walks every page (see _lib.sh).
. "$(dirname "$0")/_lib.sh"
REPO="$(gitea_repo)" || exit 1
# Capture the paginator's output before piping to jq: in POSIX sh (no
# pipefail), a `cmd | jq` pipeline reports jq's exit status (0) even when
# `cmd` failed mid-walk, which would surface a real error as a false-negative
# "no PR exists" and silently pass a porch pr_exists gate.
PULLS="$(tea_api_paged "repos/${REPO}/pulls" "state=all")" || exit 1
printf '%s' "$PULLS" | jq --arg branch "$CODEV_BRANCH_NAME" \
    '[.[] | select(.head.ref == $branch and (.state == "open" or .merged == true))] | length > 0'
