#!/bin/sh
# Forge concept: pr-view (GitLab via glab CLI)
exec glab mr view "$CODEV_PR_NUMBER" --output json
