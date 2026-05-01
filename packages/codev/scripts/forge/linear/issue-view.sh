#!/bin/sh
# Forge concept: issue-view (Linear via GraphQL API)
# Input: CODEV_ISSUE_ID (e.g. "ENG-123")
# Output: JSON {title, body, state, comments[]}
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

if [ -z "$CODEV_ISSUE_ID" ]; then
  echo "CODEV_ISSUE_ID is not set" >&2
  exit 1
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(jq -n --arg id "$CODEV_ISSUE_ID" '{
    query: "query($id: String!) { issueVcsByFilter: issues(filter: { identifier: { eq: $id } }) { nodes { title description state { name } comments { nodes { body createdAt user { displayName } } } } } }",
    variables: { id: $id }
  }')" \
  | jq '{
    title: .data.issueVcsByFilter.nodes[0].title,
    body: (.data.issueVcsByFilter.nodes[0].description // ""),
    state: .data.issueVcsByFilter.nodes[0].state.name,
    comments: [.data.issueVcsByFilter.nodes[0].comments.nodes[] | {
      body: .body,
      createdAt: .createdAt,
      author: { login: .user.displayName }
    }]
  }'
