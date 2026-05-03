#!/bin/sh
# Forge concept: issue-comment (Linear via GraphQL API)
# Input: CODEV_ISSUE_ID, CODEV_COMMENT_BODY
# Output: exit code only
set -e

if [ -z "$LINEAR_API_KEY" ]; then
  echo "LINEAR_API_KEY is not set" >&2
  exit 1
fi

if [ -z "$CODEV_ISSUE_ID" ]; then
  echo "CODEV_ISSUE_ID is not set" >&2
  exit 1
fi

ISSUE_UUID=$(curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(jq -n --arg id "$CODEV_ISSUE_ID" '{
    query: "query($id: String!) { issues(filter: { identifier: { eq: $id } }) { nodes { id } } }",
    variables: { id: $id }
  }')" \
  | jq -r '.data.issues.nodes[0].id')

if [ -z "$ISSUE_UUID" ] || [ "$ISSUE_UUID" = "null" ]; then
  echo "Issue not found: $CODEV_ISSUE_ID" >&2
  exit 1
fi

curl -sf -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "$(jq -n --arg issueId "$ISSUE_UUID" --arg body "$CODEV_COMMENT_BODY" '{
    query: "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
    variables: { issueId: $issueId, body: $body }
  }')" \
  -o /dev/null
