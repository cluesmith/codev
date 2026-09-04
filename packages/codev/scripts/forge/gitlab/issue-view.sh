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
# Best-effort preset (Spec 589): fields GitLab doesn't expose stay absent. The
# contract's optional fields are added only when present (via `+ {…}` merges) so
# an absent field is OMITTED, not emitted as null — `author?`/`createdAt?` are not
# nullable (only `milestone` is). `exec` is dropped: with a pipe it would replace
# only the glab subshell, not the whole pipeline, so it's misleading here.
glab issue view "$CODEV_ISSUE_ID" --output json | jq '
  .
  + {url: .web_url}
  + {assignees: [(.assignees // [])[] | {login: .username}]}
  + {labels: [(.labels // [])[] | if type == "string" then {name: .} else {name: .name} end]}
  + (if .author.username then {author: {login: .author.username}} else {} end)
  + (if .created_at then {createdAt: .created_at} else {} end)
  + (if .milestone then {milestone: {title: .milestone.title}} else {} end)
'
