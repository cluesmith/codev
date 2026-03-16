#!/bin/sh
# Forge concept: pr-search (GitHub via gh CLI)
# Input: CODEV_SEARCH_QUERY
# Output: JSON [{number, headRefName}]
exec gh pr list --search "$CODEV_SEARCH_QUERY" --json number,headRefName
