#!/bin/sh
# Forge concept: issue-comment (Gitea via tea CLI)
exec tea issues comment "$CODEV_ISSUE_ID" "$CODEV_COMMENT_BODY"
