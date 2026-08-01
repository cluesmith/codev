#!/bin/sh
# Forge concept: pr-search (GitHub via gh CLI)
# Input: CODEV_SEARCH_QUERY
# Output: JSON [{number, headRefName, baseRefName}]
# --state all is required so the search includes merged/closed PRs; without it
# `gh pr list` defaults to --state open and post-merge lookups return nothing (#759).
exec gh pr list --state all --search "$CODEV_SEARCH_QUERY" --json number,headRefName,baseRefName
