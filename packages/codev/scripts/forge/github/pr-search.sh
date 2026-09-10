#!/bin/sh
# Forge concept: pr-search (GitHub via gh CLI)
# Input: CODEV_SEARCH_QUERY
# Output: JSON [{number, headRefName, baseRefName, state}]
# --state all is required so the search includes merged/closed PRs; without it
# `gh pr list` defaults to --state open and post-merge lookups return nothing (#759).
# `state` (OPEN/MERGED/CLOSED) lets consumers that only want open PRs filter
# client-side — the spawn collision guard must ignore merged/closed ones (#1637).
exec gh pr list --state all --search "$CODEV_SEARCH_QUERY" --json number,headRefName,baseRefName,state
