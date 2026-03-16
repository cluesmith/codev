#!/bin/sh
# Forge concept: issue-comment (GitLab via glab CLI)
exec glab issue note "$CODEV_ISSUE_ID" --message "$CODEV_COMMENT_BODY"
