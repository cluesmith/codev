#!/bin/sh
# Forge concept: recently-closed (Linear via GraphQL API)
# Input: CODEV_LINEAR_TEAM, CODEV_SINCE_DATE (optional, ISO date)
# Output: JSON [{number, title, url, labels, createdAt, closedAt}]
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

FILTER='{ state: { type: { in: ["completed", "canceled"] } } }'
if [ -n "$CODEV_LINEAR_TEAM" ] && [ -n "$CODEV_SINCE_DATE" ]; then
  FILTER="$(jq -n --arg team "$CODEV_LINEAR_TEAM" --arg since "$CODEV_SINCE_DATE" '{
    team: { key: { eq: $team } },
    state: { type: { in: ["completed", "canceled"] } },
    completedAt: { gte: $since }
  }')"
elif [ -n "$CODEV_LINEAR_TEAM" ]; then
  FILTER="$(jq -n --arg team "$CODEV_LINEAR_TEAM" '{
    team: { key: { eq: $team } },
    state: { type: { in: ["completed", "canceled"] } }
  }')"
elif [ -n "$CODEV_SINCE_DATE" ]; then
  FILTER="$(jq -n --arg since "$CODEV_SINCE_DATE" '{
    state: { type: { in: ["completed", "canceled"] } },
    completedAt: { gte: $since }
  }')"
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(jq -n --argjson filter "$FILTER" '{
    query: "query($filter: IssueFilter) { issues(filter: $filter, first: 200, orderBy: updatedAt) { nodes { identifier title url labels { nodes { name } } createdAt completedAt } } }",
    variables: { filter: $filter }
  }')" \
  | jq '[.data.issues.nodes[] | {
    number: .identifier,
    title: .title,
    url: .url,
    labels: [.labels.nodes[] | { name: .name }],
    createdAt: .createdAt,
    closedAt: .completedAt
  }]'
