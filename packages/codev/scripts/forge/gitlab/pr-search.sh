#!/bin/sh
# Forge concept: pr-search (GitLab via glab CLI)
# --all is required so the search includes merged/closed MRs; without it
# `glab mr list` defaults to opened only and post-merge lookups return nothing (#759).
exec glab mr list --all --search "$CODEV_SEARCH_QUERY" --output json
