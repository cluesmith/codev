#!/bin/sh
# Forge concept: issue-view (GitLab via glab CLI)
exec glab issue view "$CODEV_ISSUE_ID" --output json
