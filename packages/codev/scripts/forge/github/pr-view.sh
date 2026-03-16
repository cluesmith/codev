#!/bin/sh
# Forge concept: pr-view (GitHub via gh CLI)
# Input: CODEV_PR_NUMBER, CODEV_INCLUDE_COMMENTS (optional, "1" to include)
# Output: JSON or text (with comments)

if [ "$CODEV_INCLUDE_COMMENTS" = "1" ]; then
  exec gh pr view "$CODEV_PR_NUMBER" --comments
else
  exec gh pr view "$CODEV_PR_NUMBER" \
    --json title,body,state,author,baseRefName,headRefName,additions,deletions
fi
