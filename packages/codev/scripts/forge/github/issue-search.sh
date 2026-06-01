#!/bin/sh
# Forge concept: issue-search (GitHub via gh CLI)
#
# Like issue-list, but purpose-built for the backlog-search webview (#920):
# always includes `body` (so search can match descriptions) and honors a
# requested state. issue-list stays lean for the always-on sidebar / overview.
#
# Input (optional): CODEV_ISSUE_STATE — open|closed|all (default: open)
# Output: JSON [{number, title, url, labels, createdAt, author, assignees, body}]
exec gh issue list \
  --limit 200 \
  --state "${CODEV_ISSUE_STATE:-open}" \
  --json number,title,url,labels,createdAt,author,assignees,body
