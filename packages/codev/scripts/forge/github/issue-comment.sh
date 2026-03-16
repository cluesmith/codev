#!/bin/sh
# Forge concept: issue-comment (GitHub via gh CLI)
# Input: CODEV_ISSUE_ID, CODEV_COMMENT_BODY
# Output: exit code only
exec gh issue comment "$CODEV_ISSUE_ID" --body "$CODEV_COMMENT_BODY"
