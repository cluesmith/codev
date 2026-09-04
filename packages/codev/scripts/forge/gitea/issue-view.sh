#!/bin/sh
# Forge concept: issue-view (Gitea via tea CLI)
# Sets `url` to the issue's browser page (`html_url`). Gitea's own `url` field is
# the API endpoint (would render raw JSON in a browser), so we prefer `html_url`
# and fall back to the existing `url` only if `html_url` is absent.
#
# Also maps Gitea's fields into the forge-neutral IssueView shape. The mapped
# keys are optional by contract, so a shape mismatch degrades to an omitted line
# rather than a crash (jq returns null for missing keys; the guards tolerate it):
#   user.login       -> author.login
#   created_at       -> createdAt
#   assignees[].login -> assignees[].login
#   labels[].name    -> labels[].name
#   milestone.title  -> milestone.title (null when unset)
# Best-effort preset (Spec 589): fields Gitea doesn't expose stay absent.
exec tea issues view "$CODEV_ISSUE_ID" --output json | jq '. + {
  url: (.html_url // .url),
  author: (if .user then {login: .user.login} else null end),
  createdAt: .created_at,
  assignees: [(.assignees // [])[] | {login: .login}],
  labels: [(.labels // [])[] | {name: .name}],
  milestone: (if .milestone then {title: .milestone.title} else null end)
}'
