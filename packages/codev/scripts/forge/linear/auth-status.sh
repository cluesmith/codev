#!/bin/sh
# Forge concept: auth-status (Linear via GraphQL API)
# Output: exit code (0 = authenticated)
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ viewer { id } }"}' \
  -o /dev/null
