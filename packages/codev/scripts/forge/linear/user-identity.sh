#!/bin/sh
# Forge concept: user-identity (Linear via GraphQL API)
# Output: plain text display name
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ viewer { displayName } }"}' \
  | jq -r '.data.viewer.displayName'
