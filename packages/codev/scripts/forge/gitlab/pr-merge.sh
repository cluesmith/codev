#!/bin/sh
# Forge concept: pr-merge (GitLab via glab CLI)
exec glab mr merge "$CODEV_PR_NUMBER" --yes
