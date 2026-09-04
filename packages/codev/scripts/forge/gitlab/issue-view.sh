#!/bin/sh
# Forge concept: issue-view (GitLab via glab CLI)
# Maps GitLab's fields into the forge-neutral IssueView shape. `. + {…}` is
# non-destructive for keys we don't touch; the mapped keys are optional by
# contract, so a shape mismatch degrades to an omitted line rather than a crash
# (jq returns null for missing keys, and the guards below tolerate null):
#   web_url            -> url
#   author.username    -> author.login
#   created_at         -> createdAt
#   assignees[].username -> assignees[].login
#   labels[]           -> labels[].name  (newer glab emits label objects; older emits strings)
#   milestone.title    -> milestone.title (null when unset)
# Best-effort preset (Spec 589): fields GitLab doesn't expose stay absent.
exec glab issue view "$CODEV_ISSUE_ID" --output json | jq '. + {
  url: .web_url,
  author: (if .author then {login: .author.username} else null end),
  createdAt: .created_at,
  assignees: [(.assignees // [])[] | {login: .username}],
  labels: [(.labels // [])[] | if type == "string" then {name: .} else {name: .name} end],
  milestone: (if .milestone then {title: .milestone.title} else null end)
}'
