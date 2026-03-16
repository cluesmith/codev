#!/bin/sh
# Forge concept: pr-diff (GitLab via glab CLI)
exec glab mr diff "$CODEV_PR_NUMBER"
