#!/bin/sh
# Forge concept: pr-exists (GitHub via gh CLI)
# Input: CODEV_BRANCH_NAME
# Output: "true" or "false"
# Returns true for OPEN or MERGED PRs only. CLOSED-not-merged PRs are excluded.
# (bugfix #568: --state all is needed to catch merged PRs; #653: filter out CLOSED)
exec gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number,state --jq '[.[] | select(.state == "OPEN" or .state == "MERGED")] | length > 0'
