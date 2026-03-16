#!/bin/sh
# Forge concept: on-it-timestamps (GitHub via gh CLI)
# Input: CODEV_GRAPHQL_QUERY, CODEV_REPO_OWNER, CODEV_REPO_NAME
# Output: raw GraphQL JSON response
exec gh api graphql \
  -f query="$CODEV_GRAPHQL_QUERY" \
  -f owner="$CODEV_REPO_OWNER" \
  -f name="$CODEV_REPO_NAME"
