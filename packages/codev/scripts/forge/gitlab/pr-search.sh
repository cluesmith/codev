#!/bin/sh
# Forge concept: pr-search (GitLab via glab CLI)
exec glab mr list --search "$CODEV_SEARCH_QUERY" --output json
