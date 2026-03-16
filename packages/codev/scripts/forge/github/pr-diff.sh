#!/bin/sh
# Forge concept: pr-diff (GitHub via gh CLI)
# Input: CODEV_PR_NUMBER, CODEV_DIFF_NAME_ONLY (optional, "1" for name-only)
# Output: raw diff text

if [ "$CODEV_DIFF_NAME_ONLY" = "1" ]; then
  exec gh pr diff "$CODEV_PR_NUMBER" --name-only
else
  exec gh pr diff "$CODEV_PR_NUMBER"
fi
