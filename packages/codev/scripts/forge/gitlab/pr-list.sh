#!/bin/sh
# Forge concept: pr-list (GitLab via glab CLI — merge requests)
exec glab mr list --output json
