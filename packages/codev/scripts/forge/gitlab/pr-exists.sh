#!/bin/sh
# Forge concept: pr-exists (GitLab via glab CLI)
glab mr list --source-branch "$CODEV_BRANCH_NAME" --output json | jq "length > 0"
