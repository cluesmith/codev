#!/bin/sh
# Forge concept: issue-search (Linear via GraphQL API)
#
# ⚠️ UNVERIFIED — mirrors linear/issue-list.sh with `description` added to the
#    query (mapped to `body`) and the state filter parameterized. No Linear
#    credentials in the authoring environment (#920); smoke-test before relying
#    on it. Confirm the completed/canceled state-type mapping matches the
#    workspace's workflow.
#
# Input (optional): CODEV_ISSUE_STATE — open|closed|all (default: open)
#                   CODEV_LINEAR_TEAM  — team key (e.g. "ENG")
# Output: JSON [{number, title, url, labels, createdAt, author, assignees, body}]
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

case "${CODEV_ISSUE_STATE:-open}" in
  closed) STATE_FILTER='{ "state": { "type": { "in": ["completed", "canceled"] } } }' ;;
  all)    STATE_FILTER='{}' ;;
  *)      STATE_FILTER='{ "state": { "type": { "nin": ["completed", "canceled"] } } }' ;;
esac

if [ -n "$CODEV_LINEAR_TEAM" ]; then
  FILTER="$(jq -n --arg team "$CODEV_LINEAR_TEAM" --argjson st "$STATE_FILTER" \
    '{ team: { key: { eq: $team } } } + $st')"
else
  FILTER="$STATE_FILTER"
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(jq -n --argjson filter "$FILTER" '{
    query: "query($filter: IssueFilter) { issues(filter: $filter, first: 200) { nodes { identifier title url description labels { nodes { name } } createdAt assignee { displayName } creator { displayName } } } }",
    variables: { filter: $filter }
  }')" \
  | jq '[.data.issues.nodes[] | {
    number: .identifier,
    title: .title,
    url: .url,
    labels: [.labels.nodes[] | { name: .name }],
    createdAt: .createdAt,
    author: (if .creator then { login: .creator.displayName } else null end),
    assignees: (if .assignee then [{ login: .assignee.displayName }] else [] end),
    body: (.description // "")
  }]'
