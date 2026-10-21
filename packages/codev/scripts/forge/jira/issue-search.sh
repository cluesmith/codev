#!/bin/sh
# Forge concept: issue-search (Jira Cloud via acli)
# forge-executable: acli
#
# Like issue-list, but for the backlog-search webview: includes `body` (the
# description, flattened from ADF) and honors a requested state, mapped to the
# status category: open = not Done, closed = Done, all = any category (still a
# bounded query, which Jira requires).
#
# Input (optional): CODEV_ISSUE_STATE — open|closed|all (default: open)
#                   CODEV_JIRA_PROJECT, CODEV_JIRA_SITE
# Output: JSON [{number, title, url, labels, author, assignees, body}]
set -e
. "$(dirname "$0")/_lib.sh"

case "${CODEV_ISSUE_STATE:-open}" in
  closed) STATE_CLAUSE='statusCategory = Done' ;;
  all)    STATE_CLAUSE='statusCategory is not EMPTY' ;;
  *)      STATE_CLAUSE='statusCategory != Done' ;;
esac

SCOPE="$(jira_scope)" || exit 1
SITE="$(jira_site)" || exit 1

RAW="$(acli jira workitem search \
  --jql "${SCOPE}${STATE_CLAUSE} ORDER BY created DESC" \
  --fields summary,status,labels,creator,assignee,description \
  --limit 100 \
  --json)"

printf '%s' "$RAW" | jq --arg site "$SITE" "$JIRA_JQ_DEFS"'
  [.[] | select(. != null and (.key | type) == "string") | {
    number: .key,
    title: (.fields.summary // ""),
    url: "\($site)/browse/\(.key)",
    labels: labels_of,
    author: (.fields.creator | person),
    assignees: assignees_of,
    body: (.fields.description | adf_text)
  }]'
