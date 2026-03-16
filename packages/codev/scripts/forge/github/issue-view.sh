#!/bin/sh
# Forge concept: issue-view (GitHub via gh CLI)
# Input: CODEV_ISSUE_ID
# Output: JSON {title, body, state, comments[]}
exec gh issue view "$CODEV_ISSUE_ID" --json title,body,state,comments
