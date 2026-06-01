#!/bin/sh
# Forge concept: issue-search (Gitea via tea CLI)
#
# ⚠️ UNVERIFIED — mirrors gitea/issue-list.sh with `body` added to --fields,
#    a --state parameter, and `body` mapped in the jq normalization. `tea` is
#    not available in the authoring environment (#920); smoke-test before
#    relying on it. Confirm: tea's `--state` accepts open|closed|all and the
#    issue body field is named `body`.
#
# Input (optional): CODEV_ISSUE_STATE — open|closed|all (default: open)
# Output: JSON [{number, title, url, labels, createdAt, author, assignees, body}]
exec tea issues list --limit 200 \
  --state "${CODEV_ISSUE_STATE:-open}" \
  --fields index,title,state,author,url,created,labels,assignees,body \
  --output json \
  | jq '[.[] | {
      number: (.index | tonumber),
      title,
      state,
      url,
      createdAt: .created,
      author: {login: .author},
      labels: (if (.labels // "") == "" then []
               else (.labels | split(",") | map({name: ltrimstr(" ")})) end),
      assignees: (if (.assignees // "") == "" then []
                  else (.assignees | split(",") | map({login: ltrimstr(" ")})) end),
      body: (.body // "")
    }]'
