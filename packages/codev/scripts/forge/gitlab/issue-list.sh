#!/bin/sh
# Forge concept: issue-list (GitLab via glab CLI)
exec glab issue list --per-page 200 --output json
