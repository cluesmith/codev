#!/bin/sh
# Forge concept: issue-view (Jira Cloud via acli)
# forge-executable: acli
# Input: CODEV_ISSUE_ID (e.g. "ENG-123"); CODEV_JIRA_SITE (optional)
# Output: JSON {title, body, state, url, author, createdAt, assignees, labels, milestone, comments[]}  (IssueViewResult)
#
# One `workitem view` call carries everything, comments included. Description
# and comment bodies are Atlassian Document Format, flattened to plain text.
# `state` is the status *name* (display only); open/closed decisions elsewhere
# use the status category. Jira has no milestones; the first fix version stands
# in (optional by contract). `url` is the browser page on the site, never the
# REST `self` link (which names an infrastructure host).
set -e
. "$(dirname "$0")/_lib.sh"

jira_require_issue_id || exit 1
SITE="$(jira_site)" || exit 1

RAW="$(acli jira workitem view "$CODEV_ISSUE_ID" \
  --fields summary,description,status,creator,reporter,assignee,labels,created,comment,fixVersions \
  --json)"

printf '%s' "$RAW" | jq --arg site "$SITE" "$JIRA_JQ_DEFS"'
  if (.key | type) != "string" then
    error("issue not found: \(env.CODEV_ISSUE_ID)")
  else {
    title: (.fields.summary // ""),
    body: (.fields.description | adf_text),
    state: (.fields.status.name // ""),
    url: "\($site)/browse/\(.key)",
    author: ((.fields.creator // .fields.reporter) | person),
    createdAt: .fields.created,
    assignees: assignees_of,
    labels: labels_of,
    milestone: (if ((.fields.fixVersions // []) | length) > 0 then { title: .fields.fixVersions[0].name } else null end),
    comments: [(.fields.comment.comments // [])[] | {
      body: (.body | adf_text),
      createdAt: .created,
      author: ((.author | person) // { login: "" })
    }]
  } end'
