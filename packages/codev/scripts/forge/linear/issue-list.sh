#!/bin/sh
# Forge concept: issue-list (Linear via GraphQL API)
# Input: CODEV_LINEAR_TEAM (team key, e.g. "ENG")
# Output: JSON [{number, title, url, labels, createdAt, author, assignees}]
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

FILTER='{ state: { type: { nin: ["completed", "canceled"] } } }'
if [ -n "$CODEV_LINEAR_TEAM" ]; then
  FILTER="$(jq -n --arg team "$CODEV_LINEAR_TEAM" '{
    team: { key: { eq: $team } },
    state: { type: { nin: ["completed", "canceled"] } }
  }')"
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(jq -n --argjson filter "$FILTER" '{
    query: "query($filter: IssueFilter) { issues(filter: $filter, first: 200) { nodes { identifier title url labels { nodes { name } } createdAt assignee { displayName } creator { displayName } } } }",
    variables: { filter: $filter }
  }')" \
  | jq '[.data.issues.nodes[] | {
    number: .identifier,
    title: .title,
    url: .url,
    labels: [.labels.nodes[] | { name: .name }],
    createdAt: .createdAt,
    author: (if .creator then { login: .creator.displayName } else null end),
    assignees: (if .assignee then [{ login: .assignee.displayName }] else [] end)
  }]'
