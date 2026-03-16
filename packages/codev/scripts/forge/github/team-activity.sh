#!/bin/sh
# Forge concept: team-activity (GitHub via gh CLI)
# Input: CODEV_GRAPHQL_QUERY
# Output: raw GraphQL JSON response
exec gh api graphql -f query="$CODEV_GRAPHQL_QUERY"
