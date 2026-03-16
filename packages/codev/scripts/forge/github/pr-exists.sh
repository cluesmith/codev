#!/bin/sh
# Forge concept: pr-exists (GitHub via gh CLI)
# Input: CODEV_BRANCH_NAME
# Output: "true" or "false"
exec gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number --jq "length > 0"
