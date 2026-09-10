#!/bin/sh
# Forge concept: pr-search (GitLab via glab CLI)
# --all is required so the search includes merged/closed MRs; without it
# `glab mr list` defaults to opened only and post-merge lookups return nothing (#759).
# glab reports state lowercase (opened/merged/closed/locked); normalize to the
# GitHub convention (OPEN/MERGED/CLOSED) so consumers filter with one comparison.
# The spawn collision guard keys off state === "OPEN" to ignore merged MRs (#1637).
glab mr list --all --search "$CODEV_SEARCH_QUERY" --output json \
  | jq 'map(. + {state: (if ((.state // "") | ascii_downcase) == "opened" then "OPEN" else ((.state // "") | ascii_upcase) end)})'
