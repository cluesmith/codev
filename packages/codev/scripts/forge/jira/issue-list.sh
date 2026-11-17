#!/bin/sh
# Forge concept: issue-list (Jira Cloud via acli)
# forge-executable: acli
# Input (optional): CODEV_JIRA_PROJECT (project key), CODEV_JIRA_SITE
# Output: JSON [{number, title, url, labels, author, assignees}]
#
# Open = status category not Done (never status names, which are per-site).
# `acli jira workitem search` only returns an allow-listed set of fields, none
# of them dates, so `createdAt` is omitted: consumers treat it as unknown, and
# the JQL orders items newest first. The limit stays at 100 because a search
# takes ~5s per 100 items and forge commands time out at 30s.
set -e
. "$(dirname "$0")/_lib.sh"

SCOPE="$(jira_scope)" || exit 1
SITE="$(jira_site)" || exit 1

RAW="$(acli jira workitem search \
  --jql "${SCOPE}statusCategory != Done ORDER BY created DESC" \
  --fields summary,status,labels,creator,assignee \
  --limit 100 \
  --json)"

printf '%s' "$RAW" | jq --arg site "$SITE" "$JIRA_JQ_DEFS"'
  [.[] | select(. != null and (.key | type) == "string") | {
    number: .key,
    title: (.fields.summary // ""),
    url: "\($site)/browse/\(.key)",
    labels: labels_of,
    author: (.fields.creator | person),
    assignees: assignees_of
  }]'
